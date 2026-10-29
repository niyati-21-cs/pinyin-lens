#!/usr/bin/env node
// Builds data/cedict.json from CC-CEDICT (CC BY-SA 4.0, https://cc-cedict.org).
//
// Usage:
//   node scripts/build-dict.mjs                 # download the latest release
//   node scripts/build-dict.mjs path/to/cedict_ts.u8
//
// Output shape: { "<simplified>": [[traditional, "pin1 yin1", "def / def"], ...], ... }
// plus "_t": { "<traditional>": "<simplified>" } for traditional-only keys.

import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SOURCES = [
  'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz',
  'https://raw.githubusercontent.com/cschiller/zhongwen/master/data/cedict_ts.u8',
];
const MAX_DEFS = 6;

async function load(arg) {
  if (arg) return readFile(arg, 'utf8');
  for (const url of SOURCES) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return url.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    } catch (err) {
      console.warn(`Could not download ${url}: ${err.message}`);
    }
  }
  throw new Error('No CC-CEDICT source reachable; pass a local file path instead.');
}

const LINE = /^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/;

function build(text) {
  const dict = Object.create(null);
  const trad = Object.create(null);
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const [, t, s, pinyin, rawDefs] = m;
    const defs = rawDefs.split('/').filter(Boolean).slice(0, MAX_DEFS).join(' / ');
    (dict[s] ||= []).push([t === s ? '' : t, pinyin.replace(/u:/g, 'ü'), defs]);
    if (t !== s) trad[t] ||= s;
    count++;
  }
  // Only keep traditional keys that are not also simplified headwords.
  for (const t of Object.keys(trad)) if (dict[t]) delete trad[t];
  dict._t = trad;
  return { dict, count };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'data', 'cedict.json');
const { dict, count } = build(await load(process.argv[2]));
await writeFile(out, JSON.stringify(dict));
console.log(`Wrote ${count} entries to ${out}`);
