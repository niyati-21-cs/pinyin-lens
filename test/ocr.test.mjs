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
function strip(file, seconds) {
  const path = new URL(`fixtures/${file}`, import.meta.url).pathname;
  const data = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', path, '-frames:v', '1',
    '-vf', 'crop=iw:ih/4:0:ih*3/4,scale=960:135', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 24 });
  return { data: new Uint8Array(data), width: 960, height: 135 };
}

// Punctuation is sometimes dropped; every character must be right.
const han = (s) => s.replace(/[^\p{Script=Han}]/gu, '');

test('reads burned-in subtitle lines exactly', async () => {
  assert.equal(han(await ocr.recognize(strip('burned.webm', 1))), '我今天很高兴你呢');
  assert.equal(han(await ocr.recognize(strip('burned.webm', 5))), '我们一起去看电影吧');
});

test('returns nothing when there is no subtitle', async () => {
  assert.equal(await ocr.recognize(strip('clip.webm', 1)), '');
});
