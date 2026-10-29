// End-to-end check: loads the unpacked extension in Chromium and verifies the
// overlay on a <track> subtitle page and a YouTube-style caption page.
// Usage: node test/e2e.mjs [screenshot-dir]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(here, '..');
const shots = process.argv[2] || here;
const TYPES = { '.html': 'text/html', '.webm': 'video/webm', '.vtt': 'text/vtt' };

const server = createServer(async (req, res) => {
  try {
    const file = path.join(here, 'fixtures', path.normalize(req.url).replace(/^\/+/, ''));
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
}).listen(0);
const base = `http://localhost:${server.address().port}`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'pl-')), {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 1000, height: 620 },
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;

const shadow = (page, sel) => page.locator(`pinyin-lens >> ${sel}`);

try {
  // 1. <track> subtitles
  const page = await ctx.newPage();
  await page.goto(`${base}/track.html`);
  await page.evaluate(() => document.getElementById('v').play());
  await shadow(page, '.w').first().waitFor({ timeout: 10000 });
  const words = await shadow(page, '.w .hz').allTextContents();
  const pinyin = await shadow(page, '.w .py').allTextContents();
  console.log('track words:', words.join(' | '));
  console.log('track pinyin:', pinyin.join(' | '));
  assert.deepEqual(words.slice(0, 4), ['我', '今天', '很', '高兴']);
  assert.equal(pinyin[3], 'gāo xìng');
  assert.equal(await page.evaluate(() => document.getElementById('v').textTracks[0].mode), 'hidden');

  // Hover shows the card and pauses; clicking saves.
  await shadow(page, '.w').nth(3).hover();
  await shadow(page, '.card').waitFor({ state: 'visible' });
  assert.match(await shadow(page, '.card').textContent(), /happy/);
  assert.equal(await page.evaluate(() => document.getElementById('v').paused), true);
  await page.screenshot({ path: path.join(shots, 'overlay-track.png') });
  await shadow(page, '.card .save').click();
  await shadow(page, '.card .save.on').waitFor();
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => !document.getElementById('v').paused, null, { timeout: 3000 });

  // Next cue (traditional characters) starts at 6 s.
  await page.waitForFunction(() => {
    const host = document.querySelector('pinyin-lens');
    return host?.shadowRoot.querySelector('.bar').textContent.includes('電影');
  }, null, { timeout: 10000 });
  console.log('traditional line:', (await shadow(page, '.w .py').allTextContents()).join(' | '));

  // 2. YouTube-style DOM captions
  const page2 = await ctx.newPage();
  await page2.goto(`${base}/dom.html`);
  await page2.evaluate(() => document.getElementById('v').play());
  await shadow(page2, '.w').first().waitFor({ timeout: 10000 });
  const words2 = await shadow(page2, '.w .hz').allTextContents();
  console.log('dom words:', words2.join(' | '));
  assert.ok(words2.includes('北京'));
  assert.equal(await page2.evaluate(() => getComputedStyle(document.getElementById('cap')).opacity), '0');
  await page2.screenshot({ path: path.join(shots, 'overlay-dom.png') });

  // 3. Word list shows the saved word
  const list = await ctx.newPage();
  await list.goto(`chrome-extension://${extId}/wordlist.html`);
  await list.locator('td.hz').first().waitFor();
  assert.equal(await list.locator('td.hz').first().textContent(), '高兴 (高興)');
  const [download] = await Promise.all([list.waitForEvent('download'), list.click('#export')]);
  const csv = await readFile(await download.path(), 'utf8');
  console.log('csv:', csv.trim().split('\r\n')[1]);
  assert.match(csv, /"高兴","高興","gāo xìng"/);
  await list.screenshot({ path: path.join(shots, 'wordlist.png') });

  // 4. Popup renders
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 300, height: 360 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.locator('#listen').waitFor();
  await popup.screenshot({ path: path.join(shots, 'popup.png') });

  console.log('E2E PASSED');
} finally {
  await ctx.close();
  server.close();
}
