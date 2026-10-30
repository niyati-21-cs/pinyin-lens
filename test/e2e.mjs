// End-to-end check: loads the unpacked extension in Chromium and verifies the
// overlay on <track> subtitles and YouTube-style captions, word saving and
// export, settings, keyboard shortcut, fullscreen, iframes, multiple videos.
// Usage: node test/e2e.mjs [screenshot-dir]
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { launch, startServer, shadow, barText } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = process.argv[2] || here;
const { server, base } = startServer();
const { ctx, extId } = await launch();

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

  // 4. Hovering a word while the caption changes keeps the card; the new line
  //    shows once the card closes.
  await page2.bringToFront();
  const lineBefore = await barText(page2);
  await shadow(page2, '.w').first().hover();
  await shadow(page2, '.card').waitFor({ state: 'visible' });
  await page2.waitForTimeout(4500); // dom.html changes the caption every 4 s
  assert.equal(await barText(page2), lineBefore, 'line stays while the card is open');
  assert.ok(await shadow(page2, '.card').isVisible());
  await page2.mouse.move(5, 5);
  await page2.waitForFunction((before) =>
    document.querySelector('pinyin-lens').shadowRoot.querySelector('.bar').textContent !== before, lineBefore, { timeout: 3000 });
  console.log('deferred line shown after card closed');

  // 5. Settings apply live
  const setSettings = (patch) => list.evaluate(async (patch) => {
    const settings = (await chrome.storage.local.get('settings')).settings || {};
    await chrome.storage.local.set({ settings: { ...settings, ...patch } });
  }, patch);
  await setSettings({ showPinyin: false, showGloss: false });
  await page2.waitForFunction(() => !document.querySelector('pinyin-lens').shadowRoot.querySelector('.py'));
  assert.equal(await shadow(page2, '.gl').count(), 0);
  await setSettings({ showPinyin: true, showGloss: true, hideNative: false });
  await shadow(page2, '.py').first().waitFor();
  assert.equal(await page2.evaluate(() => getComputedStyle(document.getElementById('cap')).opacity), '1');
  await page.bringToFront();
  await page.waitForFunction(() => document.getElementById('v').textTracks[0].mode === 'showing');
  await setSettings({ hideNative: true });
  await page.waitForFunction(() => document.getElementById('v').textTracks[0].mode === 'hidden');
  console.log('settings: pinyin/gloss toggles and native subtitle hiding work');

  // 6. Alt+P toggles the overlay (and restores the track when off)
  await page.keyboard.press('Alt+KeyP');
  await page.waitForFunction(() => document.querySelector('pinyin-lens').style.display === 'none');
  assert.equal(await page.evaluate(() => document.getElementById('v').textTracks[0].mode), 'showing',
    'track goes back to how the page had it (default → showing)');
  await page.keyboard.press('Alt+KeyP');
  await page.waitForFunction(() => document.querySelector('pinyin-lens').style.display !== 'none');
  console.log('Alt+P toggles the overlay');

  // 7. Fullscreen wrapper: the overlay moves inside the fullscreen element
  const fs = await ctx.newPage();
  await fs.goto(`${base}/fullscreen.html`);
  await fs.evaluate(() => document.getElementById('v').play());
  await shadow(fs, '.w').first().waitFor({ timeout: 10000 });
  await fs.click('#fs');
  await fs.waitForFunction(() => document.fullscreenElement?.id === 'player');
  await fs.waitForFunction(() => document.querySelector('pinyin-lens').parentElement.id === 'player');
  assert.ok(await shadow(fs, '.w').first().isVisible());
  await fs.screenshot({ path: path.join(shots, 'overlay-fullscreen.png') });
  await fs.evaluate(() => document.exitFullscreen());
  await fs.waitForFunction(() => document.querySelector('pinyin-lens').parentElement === document.documentElement);
  console.log('fullscreen: overlay follows the fullscreen wrapper');

  // 8. Video inside an iframe gets its own overlay
  const fr = await ctx.newPage();
  await fr.goto(`${base}/iframe.html`);
  const frame = fr.frameLocator('#f');
  await fr.frames()[1].evaluate(() => document.getElementById('v').play());
  await frame.locator('pinyin-lens >> .w').first().waitFor({ timeout: 10000 });
  console.log('iframe words:', (await frame.locator('pinyin-lens >> .w .hz').allTextContents()).join(' | '));

  // 9. Multiple videos / video added later: the overlay follows the bigger one
  const mv = await ctx.newPage();
  await mv.goto(`${base}/multi.html`);
  await mv.waitForFunction(() => document.querySelector('pinyin-lens')?.shadowRoot.querySelector('.bar').textContent.includes('视频'), null, { timeout: 10000 });
  await mv.waitForFunction(() => document.querySelector('pinyin-lens')?.shadowRoot.querySelector('.bar').textContent.includes('电视'), null, { timeout: 10000 });
  const box = await shadow(mv, '.bar').boundingBox();
  assert.ok(box.y > 200, 'overlay sits over the big video, not the small one');
  assert.equal(await mv.evaluate(() => document.getElementById('small').textTracks[0].mode), 'showing',
    'the small video gets its own subtitles back');
  console.log('multi: switched to the larger, later-added video');

  // 10. Audio-mode pacing: lines stay up long enough to read, short follow-ups
  //     are joined on, and pausing the video pauses the subtitles.
  const au = await ctx.newPage();
  await au.goto(`${base}/audio.html`);
  await au.evaluate(() => { const v = document.getElementById('v'); v.muted = true; return v.play(); });
  const sendLine = (text) => list.evaluate(async ([text, url]) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.tabs.sendMessage(tab.id, { type: 'line', text, source: 'audio' });
  }, [text, `${base}/audio.html`]);
  const auBar = () => barText(au);
  const auHan = async () => (await auBar()).replace(/[^\p{Script=Han}]/gu, '');
  await au.bringToFront();
  await au.waitForFunction(() => document.querySelector('pinyin-lens'));

  await sendLine('今天天气很好。');
  await au.waitForFunction(() => document.querySelector('pinyin-lens').shadowRoot.querySelector('.bar').textContent.includes('天气'));
  await sendLine('对');
  await au.waitForTimeout(300);
  assert.equal(await auHan(), '今天天气很好对', 'one-word follow-up is joined onto the current line');

  // A long line arriving right away waits until the current one has been read
  // (1.5 s + 0.3 s per character ≈ 3.6 s for 7 characters).
  await sendLine('我们明天一起去公园散步吧。');
  await au.waitForTimeout(1500);
  assert.equal(await auHan(), '今天天气很好对', 'next line waits while the current one is read');

  // Pausing the video holds the queued line.
  await au.evaluate(() => document.getElementById('v').pause());
  await au.waitForTimeout(3500);
  assert.equal(await auHan(), '今天天气很好对', 'subtitles pause with the video');
  await au.evaluate(() => document.getElementById('v').play());
  await au.waitForFunction(() => document.querySelector('pinyin-lens').shadowRoot.querySelector('.bar').textContent.includes('公园'), null, { timeout: 5000 });
  console.log('pacing: join, read-time hold and pause-hold work');

  // 11. Popup renders
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 300, height: 360 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.locator('#listen').waitFor();
  await popup.screenshot({ path: path.join(shots, 'popup.png') });

  // 12. Options page: engine choice shows the matching fields; on-device is the default
  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  await opts.locator('#engine').waitFor();
  assert.equal(await opts.locator('#engine').inputValue(), 'local');
  assert.ok(await opts.locator('#localModel').isVisible());
  assert.ok(!(await opts.locator('#apiKey').isVisible()));
  await opts.screenshot({ path: path.join(shots, 'options.png'), fullPage: true });
  await opts.selectOption('#engine', 'api');
  assert.ok(await opts.locator('#apiKey').isVisible());
  await opts.fill('#apiKey', 'sk-x');
  await opts.click('#save');
  assert.equal(await opts.evaluate(async () => (await chrome.storage.local.get('settings')).settings.engine), 'api');

  console.log('E2E PASSED');
} finally {
  await ctx.close();
  server.close();
}
