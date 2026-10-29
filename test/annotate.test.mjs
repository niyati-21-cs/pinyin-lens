import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { annotate, Dictionary, toMarked } from '../lib/annotate.js';

const dict = new Dictionary(JSON.parse(await readFile(new URL('../data/cedict.json', import.meta.url), 'utf8')));
const words = (text) => annotate(text, dict).map((t) => t.text);
const pinyin = (text) => annotate(text, dict).filter((t) => t.entries).map((t) => t.entries[0].pinyin);

test('numbered pinyin becomes tone marks', () => {
  assert.equal(toMarked('ni3 hao3'), 'nǐ hǎo');
  assert.equal(toMarked('lü4 se4'), 'lǜ sè');
  assert.equal(toMarked('xiu1 gou3'), 'xiū gǒu');
  assert.equal(toMarked('liu2'), 'liú');
  assert.equal(toMarked('Bei3 jing1'), 'Běi jīng');
  assert.equal(toMarked('ma5'), 'ma');
});

test('simplified sentence', () => {
  assert.deepEqual(words('我今天很高兴'), ['我', '今天', '很', '高兴']);
  assert.deepEqual(pinyin('我今天很高兴'), ['wǒ', 'jīn tiān', 'hěn', 'gāo xìng']);
});

test('traditional characters', () => {
  assert.deepEqual(words('我們'), ['我們']);
  assert.deepEqual(pinyin('我們'), ['wǒ men']);
});

test('mixed Latin, punctuation and Chinese', () => {
  assert.deepEqual(words('OK吧，走！'), ['OK', '吧', '，', '走', '！']);
});

test('common reading comes before surname / proper-name readings', () => {
  const [first] = annotate('好', dict)[0].entries;
  assert.equal(first.pinyin, 'hǎo');
  assert.match(annotate('谢谢', dict)[0].entries[0].defs[0], /thank/i);
});

test('everyday readings of polyphonic characters', () => {
  assert.deepEqual(pinyin('我们一起去看电影吧'), ['wǒ men', 'yī qǐ', 'qù', 'kàn', 'diàn yǐng', 'ba']);
});
