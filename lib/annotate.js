// Word segmentation, dictionary lookup and pinyin formatting.
// Shared by the service worker and the node tests; has no browser dependencies.

const HAN = /\p{Script=Han}/u;
const HAN_RUN = /[\p{Script=Han}〇]+/gu;
const MAX_WORD = 8;

export const hasHan = (text) => HAN.test(text);

// --- pinyin -----------------------------------------------------------------

const MARKS = {
  a: 'āáǎà', e: 'ēéěè', i: 'īíǐì', o: 'ōóǒò', u: 'ūúǔù', 'ü': 'ǖǘǚǜ',
};

// "hao3" -> "hǎo"; "lu:4"/"lü4" -> "lǜ"; "r5"/"ma5" -> "r"/"ma".
export function syllableToMarked(syl) {
  const m = /^([a-zü:]+)([1-5])$/i.exec(syl);
  if (!m) return syl.replace(/u:/gi, 'ü');
  let [, base, tone] = m;
  base = base.replace(/u:/gi, 'ü');
  const t = Number(tone);
  if (t === 5) return base;
  const lower = base.toLowerCase();
  let idx = lower.search(/[ae]/);
  if (idx < 0) idx = lower.indexOf('ou');
  if (idx < 0) {
    for (let i = lower.length - 1; i >= 0; i--) {
      if ('iouü'.includes(lower[i])) { idx = i; break; }
    }
  }
  if (idx < 0) return base; // e.g. "m2", "ng4"
  const ch = lower[idx];
  let marked = MARKS[ch][t - 1];
  if (base[idx] !== ch) marked = marked.toUpperCase();
  return base.slice(0, idx) + marked + base.slice(idx + 1);
}

export const toMarked = (numbered) => numbered.split(' ').map(syllableToMarked).join(' ');

export const tonesOf = (numbered) =>
  numbered.split(' ').map((s) => {
    const m = /([1-5])$/.exec(s);
    return m ? Number(m[1]) : 0;
  });

// --- dictionary -----------------------------------------------------------

// Everyday readings of frequent characters that CC-CEDICT lists with a rarer
// reading first (e.g. 看 kān "to look after" before kàn "to see").
const PREFERRED = Object.fromEntries(
  ('看kan4 吧ba5 了le5 的de5 得de5 着zhe5 过guo4 和he2 还hai2 都dou1 行xing2 长chang2 只zhi3 ' +
   '为wei4 要yao4 没mei2 发fa1 种zhong3 重zhong4 好hao3 少shao3 啊a5 呢ne5 吗ma5 么me5 哪na3 ' +
   '那na4 乐le4 觉jue2 干gan4 场chang3 差cha4 教jiao1 空kong1 当dang1 数shu4 相xiang1 正zheng4 ' +
   '分fen1 一yi1 不bu4 大da4 会hui4 啦la5 便bian4 应ying1 难nan2 传chuan2 朝chao2 中zhong1 ' +
   '上shang4 们men5 个ge4 谁shei2 给gei3 说shuo1 处chu4 几ji3 把ba3 号hao4 将jiang1 调diao4 ' +
   '落luo4 系xi4 待dai4 兴xing1 别bie2 喝he1 点dian3 地di4 咱zan2 嘛ma5 哥ge1 姐jie3 ' +
   '妈ma1 爸ba4 东dong1 西xi1 什shen2 呀ya5 哈ha1 啥sha2 怎zen3 弄nong4 似si4 血xue4')
    .split(/\s+/)
    .map((pair) => [pair[0], pair.slice(1)]),
);

export class Dictionary {
  constructor(data) {
    this.data = data;
    this.trad = data._t || {};
  }

  // Raw entries for a word written in simplified or traditional characters.
  raw(word) {
    if (word === '_t') return null;
    return this.data[word] || (this.trad[word] && this.data[this.trad[word]]) || null;
  }

  has(word) {
    return this.raw(word) !== null;
  }

  // Entries sorted so the most useful reading comes first: the everyday
  // reading of common polyphonic characters, then common words (lowercase
  // pinyin) before proper names, real meanings before "surname X" / "variant of X".
  lookup(word) {
    const entries = this.raw(word);
    if (!entries) return [];
    const preferred = PREFERRED[word];
    const score = ([, pinyin, defs]) =>
      (pinyin === preferred ? -10 : 0) +
      (/^[A-Z]/.test(pinyin) ? 2 : 0) +
      (/^(surname|(old |archaic )?variant of|see )/i.test(defs) ? 1 : 0);
    return entries
      .map((e, i) => ({ e, i, s: score(e) }))
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .map(({ e: [trad, pinyin, defs] }) => ({
        trad: trad || word,
        pinyin: toMarked(pinyin),
        tones: tonesOf(pinyin),
        defs: defs.split(' / '),
      }));
  }
}

// --- segmentation -----------------------------------------------------------

// Greedy longest match over a run of Han characters.
function maxMatch(run, dict) {
  const out = [];
  let i = 0;
  while (i < run.length) {
    let len = Math.min(MAX_WORD, run.length - i);
    while (len > 1 && !dict.has(run.slice(i, i + len))) len--;
    out.push(run.slice(i, i + len));
    i += len;
  }
  return out;
}

let segmenter = null;
function segmentRun(run, dict) {
  // Intl.Segmenter gives context-aware word boundaries; anything it
  // produces that the dictionary doesn't know is split by longest match.
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    segmenter ||= new Intl.Segmenter('zh', { granularity: 'word' });
    const words = [];
    for (const { segment } of segmenter.segment(run)) {
      if (segment.length === 1 || dict.has(segment)) words.push(segment);
      else words.push(...maxMatch(segment, dict));
    }
    return words;
  }
  return maxMatch(run, dict);
}

// Returns [{ text, entries? }]. Tokens without entries are punctuation,
// Latin text or unknown characters and are shown as-is.
export function annotate(text, dict) {
  const tokens = [];
  let last = 0;
  for (const m of text.matchAll(HAN_RUN)) {
    if (m.index > last) tokens.push({ text: text.slice(last, m.index) });
    for (const word of segmentRun(m[0], dict)) {
      const entries = dict.lookup(word);
      tokens.push(entries.length ? { text: word, entries } : { text: word });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last) });
  return tokens;
}
