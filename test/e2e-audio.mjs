// End-to-end check of audio mode: real tab capture, pause detection and
// chunking in the offscreen document, then
//  1. the on-device engine (no API key): loads transformers.js + the ONNX
//     runtime in the worker and requests the Whisper model from a mock
//     model server (which has no model, so a clear error must appear), and
//  2. the cloud API engine against a mock speech-to-text server.
// Usage: node test/e2e-audio.mjs [screenshot-dir]
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { launch, startServer, extensionId, shadow, barText } from './helpers.mjs';

const shots = process.argv[2] || path.dirname(new URL(import.meta.url).pathname);
const LINES = ['你好，我们走吧。', '今天天气很好。', '我想喝茶。'];
const requests = [];
const modelRequests = [];
let failWith = 0;
const clipDir = mkdtempSync(path.join(tmpdir(), 'pl-clips-'));

// Duration in seconds of the audio file inside a multipart upload.
function clipSeconds(body, n) {
  const start = body.indexOf('\r\n\r\n', body.indexOf('filename="audio.webm"')) + 4;
  const end = body.indexOf('\r\n--', start);
  const file = path.join(clipDir, `clip${n}.webm`);
  writeFileSync(file, Buffer.from(body.slice(start, end), 'latin1'));
  // MediaRecorder webm has no duration header and its timestamps may not start
  // at 0, so decode it and count samples (16 kHz mono, 2 bytes each).
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 1 << 26 });
  return pcm.length / 32000;
}

const { server, base } = startServer({
  'POST /v1/audio/transcriptions': (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      requests.push({ auth: req.headers.authorization, body, seconds: clipSeconds(body, requests.length) });
      res.setHeader('access-control-allow-origin', '*');
      if (failWith) {
        res.writeHead(failWith, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: LINES[(requests.length - 1) % LINES.length] }));
    });
  },
  'GET /hf/*': (req, res) => {
    modelRequests.push(req.url);
    res.writeHead(404, { 'access-control-allow-origin': '*' }).end('not found');
  },
  'OPTIONS /v1/audio/transcriptions': (req, res) => {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization',
      'access-control-allow-methods': 'POST',
    });
    res.end();
  },
});

// Lets tabCapture run without a toolbar click.
const { ctx, sw, extId } = await launch([`--allowlisted-extension-id=${extensionId}`]);
assert.equal(extId, extensionId, 'computed extension id matches the loaded one');

const offscreenOpen = () => sw.evaluate(async () =>
  (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0);

try {
  const page = await ctx.newPage();
  await page.goto(`${base}/audio.html`);
  await page.evaluate(() => document.getElementById('v').play());

  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/popup.html`);
  const send = (type) => ext.evaluate(async ([type, url]) => {
    const [tab] = await chrome.tabs.query({ url });
    return chrome.runtime.sendMessage({ type, tabId: tab.id });
  }, [type, `${base}/audio.html`]);
  const setSettings = (patch) => ext.evaluate(async (patch) => {
    const settings = (await chrome.storage.local.get('settings')).settings || {};
    await chrome.storage.local.set({ settings: { ...settings, ...patch } });
  }, patch);

  // --- 1. on-device engine, no API key (the default) ----------------------
  await setSettings({ modelHost: `${base}/hf/` });
  const localStart = await send('start-listening');
  assert.ok(localStart.ok, `on-device start failed: ${localStart.error}`);
  await page.bringToFront();
  await shadow(page, '.badge').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForFunction(() =>
    /Couldn't load the speech model/.test(document.querySelector('pinyin-lens').shadowRoot.querySelector('.badge').textContent),
  null, { timeout: 20000 });
  console.log('model requests:', modelRequests.slice(0, 3).join(', '));
  assert.ok(modelRequests.some((u) => u.startsWith('/hf/onnx-community/whisper-base/resolve/main/')),
    'worker asked the model server for whisper-base');
  console.log('on-device error badge:', await shadow(page, '.badge').textContent());
  assert.equal(requests.length, 0, 'on-device mode never calls the cloud API');
  assert.ok((await send('stop-listening')).ok);
  assert.equal(await offscreenOpen(), false);

  // --- 2. cloud API engine --------------------------------------------------
  // Choosing the API without a key explains what to do.
  await setSettings({ engine: 'api' });
  assert.match((await send('start-listening')).error, /API key/);
  await setSettings({ apiKey: 'sk-test', apiBase: `${base}/v1` });

  const started = await send('start-listening');
  assert.ok(started.ok, `start-listening failed: ${started.error}`);
  await page.bringToFront();
  await shadow(page, '.badge').waitFor({ state: 'visible', timeout: 5000 });
  assert.match(await shadow(page, '.badge').textContent(), /Listening/);

  // Each 1.5 s burst followed by a pause should become one request and one line.
  await page.waitForFunction(() =>
    document.querySelector('pinyin-lens').shadowRoot.querySelector('.bar').textContent.includes('今天'),
  null, { timeout: 15000 });
  console.log('audio line:', (await shadow(page, '.w .py').allTextContents()).join(' | '));
  await page.screenshot({ path: path.join(shots, 'overlay-audio.png') });

  assert.ok(requests.length >= 2, `expected ≥2 requests, got ${requests.length}`);
  const first = requests[0];
  assert.equal(first.auth, 'Bearer sk-test');
  assert.match(first.body, /name="language"\r\n\r\nzh/);
  assert.match(first.body, /name="model"\r\n\r\nwhisper-1/);
  assert.match(first.body, /filename="audio\.webm"/);
  const secs = requests.map((r) => r.seconds);
  console.log('clip lengths (s):', secs.map((s) => s.toFixed(2)).join(', '));
  // Bursts are 1.5 s with 0.7 s pauses; with a 2.5 s minimum a clip ends at
  // the first pause after 2.5 s (at most ~4.5 s), well before the 8 s maximum.
  assert.ok(secs.every((s) => s >= 1 && s < 5), `clips are cut at pauses: ${secs.join(', ')}`);

  // Silence alone sends nothing.
  await page.evaluate(() => { document.getElementById('v').muted = true; });
  // A clip that was recording when the sound stopped still finishes and is sent.
  await page.waitForTimeout(5000);
  const before = requests.length;
  await page.waitForTimeout(4000);
  assert.equal(requests.length, before, 'no requests while silent');
  await page.evaluate(() => { document.getElementById('v').muted = false; });

  // API errors show up on the overlay.
  failWith = 401;
  await page.waitForFunction(() =>
    /Incorrect API key/.test(document.querySelector('pinyin-lens').shadowRoot.querySelector('.badge').textContent),
  null, { timeout: 15000 });
  console.log('error badge:', await shadow(page, '.badge').textContent());
  await page.screenshot({ path: path.join(shots, 'overlay-audio-error.png') });
  failWith = 0;

  // Stopping removes the badge and the offscreen document.
  assert.ok((await send('stop-listening')).ok);
  await page.waitForFunction(() =>
    document.querySelector('pinyin-lens').shadowRoot.querySelector('.badge').hidden, null, { timeout: 5000 });
  assert.equal(await offscreenOpen(), false);
  const afterStop = requests.length;
  await page.waitForTimeout(3000);
  assert.equal(requests.length, afterStop, 'no requests after stopping');
  assert.equal(await barText(page), '', 'audio line is cleared after stopping');

  console.log(`requests total: ${requests.length}`);
  console.log('AUDIO E2E PASSED');
} finally {
  await ctx.close();
  server.close();
}
