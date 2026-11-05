import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as ort from '../vendor/ort.webgpu.min.mjs';
import { SubtitleOCR } from '../lib/ocr.js';

const vendor = new URL('../vendor/', import.meta.url);
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = vendor.pathname;
const model = (name) => new Uint8Array(readFileSync(new URL(`ocr/${name}`, vendor)));
const ocr = await SubtitleOCR.create(ort,
  { det: model('ch_PP-OCRv4_det_infer.onnx'), rec: model('ch_PP-OCRv4_rec_infer.onnx') },
  readFileSync(new URL('ocr/ppocr_keys_v1.txt', vendor), 'utf8'));

// Bottom quarter of a video frame as RGBA, the way the content script crops it.
function stripAt(file, seconds) {
  const path = new URL(`fixtures/${file}`, import.meta.url).pathname;
  const data = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', path, '-frames:v', '1',
    '-vf', 'crop=iw:ih/4:0:ih*3/4,scale=960:135', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 24 });
  return { data: new Uint8Array(data), width: 960, height: 135 };
}

// Punctuation is sometimes dropped; every character must be right.
const han = (s) => s.replace(/[^\p{Script=Han}]/gu, '');

test('reads burned-in subtitle lines exactly', async () => {
  assert.equal(han(await ocr.recognize(stripAt('burned.webm', 1))), '我今天很高兴你呢');
  assert.equal(han(await ocr.recognize(stripAt('burned.webm', 5))), '我们一起去看电影吧');
});

test('returns nothing when there is no subtitle', async () => {
  assert.equal(await ocr.recognize(stripAt('clip.webm', 1)), '');
});

// The content script finds subtitle lines itself (lib/subtitle-lines.js) so
// the model can skip its detection step.
await import('../lib/subtitle-lines.js');
const THUMB_W = 320;
const THUMB_H = 48;
function thumbMask(file, seconds) {
  const path = new URL(`fixtures/${file}`, import.meta.url).pathname;
  const rgba = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', path, '-frames:v', '1',
    '-vf', `crop=iw:ih/4:0:ih*3/4,scale=${THUMB_W}:${THUMB_H}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  const mask = plSubtitleMask(new Uint8Array(rgba), THUMB_W, THUMB_H);
  return { mask, lines: plFindLines(mask, THUMB_W, THUMB_H) };
}

test('finds the subtitle line in a busy picture, and none without subtitles', () => {
  const { lines } = thumbMask('burned.webm', 1);
  assert.equal(lines.length, 1);
  // The subtitle is centred, roughly a third of the frame wide.
  assert.ok(lines[0].x0 < 110 && lines[0].x1 > 210, JSON.stringify(lines[0]));
  assert.deepEqual(thumbMask('clip.webm', 1).lines, []);
});

test('reading only the found line gives the same text as full detection', async () => {
  const strip = { ...stripAt('burned.webm', 1) };
  const { lines } = thumbMask('burned.webm', 1);
  const k = strip.width / THUMB_W;
  const ky = strip.height / THUMB_H;
  const boxes = lines.map((b) => ({ x: Math.round(b.x0 * k), y: Math.round(b.y0 * ky),
    w: Math.round((b.x1 - b.x0 + 1) * k), h: Math.round((b.y1 - b.y0 + 1) * ky) }));
  assert.equal(han(await ocr.recognize(strip, boxes)), '我今天很高兴你呢');
});

test('a subtitle change is noticed; the same subtitle a moment later is not', () => {
  const a = thumbMask('burned.webm', 0.5);
  assert.equal(plSubtitleChanged(a, thumbMask('burned.webm', 0.7), THUMB_W), false);
  assert.equal(plSubtitleChanged(a, thumbMask('burned.webm', 4.5), THUMB_W), true);
  assert.equal(plSubtitleChanged(a, thumbMask('clip.webm', 1), THUMB_W), true);
});
