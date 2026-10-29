const rows = document.getElementById('rows');
const filter = document.getElementById('filter');
let words = {};

const td = (text, cls) => {
  const cell = document.createElement('td');
  if (cls) cell.className = cls;
  cell.textContent = text;
  return cell;
};

function render() {
  const q = filter.value.trim().toLowerCase();
  const list = Object.values(words)
    .sort((a, b) => b.time - a.time)
    .filter((w) => !q || [w.word, w.trad, w.pinyin, ...w.defs].join(' ').toLowerCase().includes(q));
  rows.textContent = '';
  if (!list.length) {
    const tr = document.createElement('tr');
    const cell = td(Object.keys(words).length ? 'No matches.' : 'No saved words yet.', 'empty');
    cell.colSpan = 5;
    tr.appendChild(cell);
    rows.appendChild(tr);
    return;
  }
  for (const w of list) {
    const tr = document.createElement('tr');
    tr.appendChild(td(w.trad && w.trad !== w.word ? `${w.word} (${w.trad})` : w.word, 'hz'));
    tr.appendChild(td(w.pinyin, 'py'));
    tr.appendChild(td(w.defs.join('; ')));
    const from = td('', 'sent sent-col');
    from.appendChild(document.createTextNode(w.sentence || ''));
    if (w.url) {
      from.appendChild(document.createElement('br'));
      const a = document.createElement('a');
      a.href = w.url;
      a.target = '_blank';
      a.textContent = w.title || 'source';
      from.appendChild(a);
    }
    tr.appendChild(from);
    const actions = document.createElement('td');
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      delete words[w.word];
      await chrome.storage.local.set({ words });
    });
    actions.appendChild(del);
    tr.appendChild(actions);
    rows.appendChild(tr);
  }
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

document.getElementById('export').addEventListener('click', () => {
  const header = ['Simplified', 'Traditional', 'Pinyin', 'Meaning', 'Sentence', 'Source'];
  const lines = Object.values(words)
    .sort((a, b) => a.time - b.time)
    .map((w) => [w.word, w.trad, w.pinyin, w.defs.join('; '), w.sentence, w.url].map(csvCell).join(','));
  // BOM so Excel opens the Chinese characters correctly.
  const blob = new Blob(['﻿' + [header.join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pinyin-lens-words-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById('clear').addEventListener('click', async () => {
  if (confirm('Delete all saved words?')) await chrome.storage.local.set({ words: {} });
});

filter.addEventListener('input', render);
chrome.storage.onChanged.addListener((changes) => {
  if (changes.words) {
    words = changes.words.newValue || {};
    render();
  }
});
chrome.storage.local.get('words').then((res) => {
  words = res.words || {};
  render();
});
