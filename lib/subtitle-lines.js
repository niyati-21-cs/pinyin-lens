// Finds subtitle lines in a small RGBA thumbnail of the bottom of a video
// frame. Loaded as a classic script (content script) and in node tests, so it
// exposes globals instead of exporting.
(() => {
  const BRIGHT_LUMA = 190;    // subtitle text is light...
  const EDGE_CONTRAST = 100;  // ...with a much darker outline or shadow right next to it
  const ROW_SHARE = 0.15;     // a text row has at least this share of the busiest row's pixels
  const ROW_MIN = 4;
  const LINE_MIN_PIXELS = 12;
  const ROW_GAP = 2;          // glyphs leave short empty runs of rows inside one line
  const COLUMN_GAP_SHARE = 0.08; // wider gaps (× width) split text from stray marks (commas leave wide gaps)

  // 1 where a pixel looks like subtitle text: bright, with a darker pixel
  // within 2 px. Flat bright background mostly doesn't qualify.
  function subtitleMask(rgba, w, h) {
    const luma = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < luma.length; i += 4, j++) {
      luma[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const j = y * w + x;
        if (luma[j] <= BRIGHT_LUMA) continue;
        const dark = luma[j] - EDGE_CONTRAST;
        for (let d = 1; d <= 2 && !mask[j]; d++) {
          if ((x >= d && luma[j - d] < dark) || (x + d < w && luma[j + d] < dark)
              || (y >= d && luma[j - d * w] < dark) || (y + d < h && luma[j + d * w] < dark)) {
            mask[j] = 1;
          }
        }
      }
    }
    return mask;
  }

  // Bands of rows dense with text pixels, each narrowed to its main run of
  // columns and padded. Boxes are inclusive pixel ranges { x0, x1, y0, y1 }.
  function findLines(mask, w, h) {
    const rows = new Uint16Array(h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows[y] += mask[y * w + x];
    const rowMin = Math.max(ROW_MIN, ROW_SHARE * Math.max(...rows));
    const bands = [];
    let start = -1;
    let gap = 0;
    for (let y = 0; y <= h; y++) {
      if (y < h && rows[y] >= rowMin) {
        if (start < 0) start = y;
        gap = 0;
      } else if (start >= 0 && (++gap > ROW_GAP || y === h)) {
        bands.push([start, y - gap]);
        start = -1;
        gap = 0;
      }
    }
    const maxGap = Math.max(4, Math.round(w * COLUMN_GAP_SHARE));
    const boxes = [];
    for (const [y0, y1] of bands) {
      if (y1 - y0 + 1 < 3) continue;
      const cols = new Uint16Array(w);
      for (let y = y0; y <= y1; y++) for (let x = 0; x < w; x++) cols[x] += mask[y * w + x];
      let best = null;
      let run = null;
      for (let x = 0; x <= w; x++) {
        if (x < w && cols[x]) {
          if (run && x - run.x1 <= maxGap) {
            run.x1 = x;
            run.n += cols[x];
            continue;
          }
          if (run && (!best || run.n > best.n)) best = run;
          run = { x0: x, x1: x, n: cols[x] };
        }
      }
      if (run && (!best || run.n > best.n)) best = run;
      if (!best || best.n < LINE_MIN_PIXELS) continue;
      const lh = y1 - y0 + 1;
      const padY = Math.max(1, Math.round(lh * 0.35));
      const padX = Math.max(2, Math.round(lh * 0.6));
      boxes.push({
        x0: Math.max(0, best.x0 - padX), x1: Math.min(w - 1, best.x1 + padX),
        y0: Math.max(0, y0 - padY), y1: Math.min(h - 1, y1 + padY),
      });
    }
    return boxes;
  }

  // Whether the subtitle changed between two thumbnails ({ mask, lines }):
  // lines appeared, went away or moved up/down, or their text pixels changed a
  // lot. Background motion away from the text is ignored. Line ends aren't
  // compared: marks near the text make them jitter.
  const SHIFT_Y = 3;
  const PIXEL_CHANGE_SHARE = 0.35;

  function subtitleChanged(a, b, w) {
    if (!a || a.lines.length !== b.lines.length) return true;
    let diff = 0;
    let total = 0;
    for (let i = 0; i < b.lines.length; i++) {
      const p = a.lines[i];
      const q = b.lines[i];
      if (Math.abs(p.y0 - q.y0) > SHIFT_Y || Math.abs(p.y1 - q.y1) > SHIFT_Y) return true;
      for (let y = Math.min(p.y0, q.y0); y <= Math.max(p.y1, q.y1); y++) {
        for (let x = Math.min(p.x0, q.x0); x <= Math.max(p.x1, q.x1); x++) {
          const j = y * w + x;
          if (a.mask[j] || b.mask[j]) total++;
          if (a.mask[j] !== b.mask[j]) diff++;
        }
      }
    }
    return total > 0 && diff / total > PIXEL_CHANGE_SHARE;
  }

  globalThis.plSubtitleChanged = subtitleChanged;
  globalThis.plSubtitleMask = subtitleMask;
  globalThis.plFindLines = findLines;
})();
