// Shared setup for the end-to-end tests: a static fixture server and a
// Chromium instance with the unpacked extension loaded.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
export const extDir = realpathSync(path.join(here, '..'));
const TYPES = { '.html': 'text/html', '.webm': 'video/webm', '.vtt': 'text/vtt' };

// Chromium derives an unpacked extension's id from its absolute path.
export const extensionId = createHash('sha256')
  .update(extDir)
  .digest('hex')
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

// Serves test/fixtures; `routes` maps "METHOD /path" (or "METHOD /prefix/*")
// to extra handlers.
export function startServer(routes = {}) {
  const server = createServer(async (req, res) => {
    const key = `${req.method} ${req.url.split('?')[0]}`;
    const route = routes[key] ||
      Object.entries(routes).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    if (route) return route(req, res);
    try {
      const file = path.join(here, 'fixtures', path.normalize(req.url.split('?')[0]).replace(/^\/+/, ''));
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  }).listen(0);
  return { server, base: `http://localhost:${server.address().port}` };
}

export async function launch(extraArgs = []) {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'pl-')), {
    headless: true,
    channel: 'chromium',
    // Playwright mutes audio by default; audio mode needs to hear the tab.
    ignoreDefaultArgs: ['--mute-audio'],
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--autoplay-policy=no-user-gesture-required',
      ...extraArgs,
    ],
    viewport: { width: 1000, height: 620 },
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  return { ctx, sw, extId: new URL(sw.url()).host };
}

export const shadow = (page, sel) => page.locator(`pinyin-lens >> ${sel}`);

export const barText = (page) =>
  page.evaluate(() => document.querySelector('pinyin-lens')?.shadowRoot.querySelector('.bar').textContent || '');
