// Runs PaddleOCR (bundled in vendor/ocr) on subtitle images sent by the
// offscreen document. Models load once, on the first request.
import * as ort from './vendor/ort.webgpu.min.mjs';
import { SubtitleOCR } from './lib/ocr.js';

ort.env.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
ort.env.wasm.numThreads = 1; // extension pages aren't cross-origin isolated

let loading = null;
let queue = Promise.resolve(); // a model session can only run one image at a time

function load() {
  const file = (name) => fetch(new URL(`./vendor/ocr/${name}`, import.meta.url));
  return (loading ||= (async () => {
    const [det, rec, keys] = await Promise.all([
      file('ch_PP-OCRv4_det_infer.onnx').then((r) => r.arrayBuffer()),
      file('ch_PP-OCRv4_rec_infer.onnx').then((r) => r.arrayBuffer()),
      file('ppocr_keys_v1.txt').then((r) => r.text()),
    ]);
    return SubtitleOCR.create(ort, { det: new Uint8Array(det), rec: new Uint8Array(rec) }, keys);
  })());
}

onmessage = ({ data: { id, image, boxes, warmup } }) => {
  if (warmup) {
    load().catch(() => { loading = null; });
    return;
  }
  queue = queue.then(async () => {
    try {
      const ocr = await load();
      postMessage({ id, text: await ocr.recognize(image, boxes) });
    } catch (err) {
      loading = null;
      postMessage({ id, error: err.message || String(err) });
    }
  });
};
