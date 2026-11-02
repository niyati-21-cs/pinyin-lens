// Reads Chinese subtitle text from an image with PaddleOCR PP-OCRv4:
// a detection model finds text lines, a recognition model reads each one.
// Pure JS around ONNX Runtime (passed in), so it runs in a worker or in node.

const DET_MAX_SIDE = 960;
const DET_THRESHOLD = 0.3;    // pixel probability that counts as text
const DET_BOX_SCORE = 0.6;    // mean probability a text region must reach
const DET_UNCLIP = 1.5;       // DB post-processing: grow boxes back to full glyph size
const REC_HEIGHT = 48;
const REC_MIN_SCORE = 0.6;

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];
const REC_MEAN = [0.5, 0.5, 0.5];
const REC_STD = [0.5, 0.5, 0.5];

// Bilinear resample of a region of an RGBA image into a normalised CHW float tensor.
function toTensorData(img, x0, y0, w, h, tw, th, mean, std) {
  const out = new Float32Array(3 * tw * th);
  const plane = tw * th;
  const sx = w / tw;
  const sy = h / th;
  for (let ty = 0; ty < th; ty++) {
    const fy = Math.min(h - 1, Math.max(0, (ty + 0.5) * sy - 0.5));
    const y1 = Math.floor(fy);
    const y2 = Math.min(h - 1, y1 + 1);
    const dy = fy - y1;
    for (let tx = 0; tx < tw; tx++) {
      const fx = Math.min(w - 1, Math.max(0, (tx + 0.5) * sx - 0.5));
      const x1 = Math.floor(fx);
      const x2 = Math.min(w - 1, x1 + 1);
      const dx = fx - x1;
      const i11 = ((y0 + y1) * img.width + x0 + x1) * 4;
      const i12 = ((y0 + y1) * img.width + x0 + x2) * 4;
      const i21 = ((y0 + y2) * img.width + x0 + x1) * 4;
      const i22 = ((y0 + y2) * img.width + x0 + x2) * 4;
      const o = ty * tw + tx;
      for (let c = 0; c < 3; c++) {
        const top = img.data[i11 + c] * (1 - dx) + img.data[i12 + c] * dx;
        const bottom = img.data[i21 + c] * (1 - dx) + img.data[i22 + c] * dx;
        const v = (top * (1 - dy) + bottom * dy) / 255;
        out[c * plane + o] = (v - mean[c]) / std[c];
      }
    }
  }
  return out;
}

// Connected regions of the probability map above the threshold, as boxes in
// map coordinates with their mean probability.
function findRegions(prob, w, h) {
  const labels = new Int32Array(w * h);
  const regions = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (labels[start] || prob[start] < DET_THRESHOLD) continue;
    const id = regions.length + 1;
    let minX = w, minY = h, maxX = 0, maxY = 0, sum = 0, count = 0;
    labels[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop();
      const x = p % w;
      const y = (p - x) / w;
      sum += prob[p];
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= w * h) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
        if (!labels[q] && prob[q] >= DET_THRESHOLD) {
          labels[q] = id;
          stack.push(q);
        }
      }
    }
    regions.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, score: sum / count });
  }
  return regions;
}

// Characters of one subtitle line can come out as separate regions; join
// regions that share a row and sit close together.
function mergeRows(boxes) {
  boxes.sort((a, b) => a.y - b.y || a.x - b.x);
  const merged = [];
  for (const b of boxes) {
    const row = merged.find((m) => {
      const overlap = Math.min(m.y + m.h, b.y + b.h) - Math.max(m.y, b.y);
      const gap = Math.max(b.x - (m.x + m.w), m.x - (b.x + b.w));
      return overlap > 0.5 * Math.min(m.h, b.h) && gap < 1.5 * Math.max(m.h, b.h);
    });
    if (!row) {
      merged.push({ ...b });
      continue;
    }
    const x2 = Math.max(row.x + row.w, b.x + b.w);
    const y2 = Math.max(row.y + row.h, b.y + b.h);
    row.x = Math.min(row.x, b.x);
    row.y = Math.min(row.y, b.y);
    row.w = x2 - row.x;
    row.h = y2 - row.y;
  }
  return merged.sort((a, b) => a.y - b.y || a.x - b.x);
}

export class SubtitleOCR {
  constructor(ort, det, rec, keys) {
    this.ort = ort;
    this.det = det;
    this.rec = rec;
    this.keys = keys;
  }

  // models: { det, rec } as Uint8Array or URL string; keys: contents of ppocr_keys_v1.txt
  static async create(ort, models, keysText) {
    const opts = { executionProviders: ['wasm'] };
    const [det, rec] = await Promise.all([
      ort.InferenceSession.create(models.det, opts),
      ort.InferenceSession.create(models.rec, opts),
    ]);
    const keys = keysText.split(/\r?\n/);
    if (keys.at(-1) === '') keys.pop();
    return new SubtitleOCR(ort, det, rec, keys);
  }

  async detect(img) {
    const scale = Math.min(1, DET_MAX_SIDE / Math.max(img.width, img.height));
    const tw = Math.max(32, Math.round((img.width * scale) / 32) * 32);
    const th = Math.max(32, Math.round((img.height * scale) / 32) * 32);
    const input = new this.ort.Tensor('float32',
      toTensorData(img, 0, 0, img.width, img.height, tw, th, DET_MEAN, DET_STD), [1, 3, th, tw]);
    const out = await this.det.run({ [this.det.inputNames[0]]: input });
    const prob = out[this.det.outputNames[0]].data;
    const sx = img.width / tw;
    const sy = img.height / th;
    const boxes = [];
    for (const r of findRegions(prob, tw, th)) {
      if (r.score < DET_BOX_SCORE || r.h < 3 || r.w < 3) continue;
      const grow = (r.w * r.h * DET_UNCLIP) / (2 * (r.w + r.h));
      const x = Math.max(0, Math.floor((r.x - grow) * sx));
      const y = Math.max(0, Math.floor((r.y - grow) * sy));
      const x2 = Math.min(img.width, Math.ceil((r.x + r.w + grow) * sx));
      const y2 = Math.min(img.height, Math.ceil((r.y + r.h + grow) * sy));
      if (y2 - y >= 8 && x2 - x >= 8) boxes.push({ x, y, w: x2 - x, h: y2 - y });
    }
    return mergeRows(boxes);
  }

  async read(img, box) {
    const tw = Math.max(16, Math.round((REC_HEIGHT * box.w) / box.h));
    const input = new this.ort.Tensor('float32',
      toTensorData(img, box.x, box.y, box.w, box.h, tw, REC_HEIGHT, REC_MEAN, REC_STD), [1, 3, REC_HEIGHT, tw]);
    const out = (await this.rec.run({ [this.rec.inputNames[0]]: input }))[this.rec.outputNames[0]];
    const [, steps, classes] = out.dims;
    let text = '';
    let scoreSum = 0;
    let kept = 0;
    let prev = 0;
    for (let t = 0; t < steps; t++) {
      let best = 0;
      let bestP = -1;
      for (let c = 0; c < classes; c++) {
        const p = out.data[t * classes + c];
        if (p > bestP) [best, bestP] = [c, p];
      }
      // CTC: 0 is blank, repeats collapse, the last class is a space.
      if (best !== 0 && best !== prev) {
        text += best === classes - 1 ? ' ' : this.keys[best - 1] ?? '';
        scoreSum += bestP;
        kept++;
      }
      prev = best;
    }
    return { text: text.trim(), score: kept ? scoreSum / kept : 0 };
  }

  // img: { data: RGBA bytes, width, height } → subtitle text ('' when none)
  async recognize(img) {
    const lines = [];
    for (const box of await this.detect(img)) {
      const line = await this.read(img, box);
      if (line.text && line.score >= REC_MIN_SCORE) lines.push(line.text);
    }
    const text = lines.join(' ');
    return (text.match(/\p{Script=Han}/gu) || []).length >= 2 ? text : '';
  }
}
