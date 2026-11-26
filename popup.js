const $ = (id) => document.getElementById(id);
const listenBox = $('listen');
const statusEl = $('status');
let tabId = null;
let listeningHere = false;
let local = true;
let settings = { ...PL_DEFAULTS };

const SWITCHES = ['enabled', 'showPinyin', 'showHanzi', 'showGloss', 'showEnglish', 'englishAuto', 'ocrEnabled'];
const SCALES = ['pinyinScale', 'glossScale', 'englishScale'];

async function save(patch) {
  settings = { ...(await plGetSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  render();
}

// Everything that depends on the settings: switches, preview, sizes.
function render() {
  for (const key of SWITCHES) $(key).checked = settings[key];
  for (const r of document.querySelectorAll('input[name=overlayPosition]')) r.checked = r.value === settings.overlayPosition;
  $('englishOptions').hidden = !settings.showEnglish;
  $('englishLangField').hidden = settings.englishAuto;
  if (document.activeElement !== $('englishLang')) $('englishLang').value = settings.englishLang;

  const sizes = plWordSizes(settings);
  $('fontSize').value = settings.fontSize;
  $('fontSizeOut').textContent = `${settings.fontSize} px`;
  for (const key of SCALES) {
    const autoKey = { pinyinScale: 'py', glossScale: 'gl', englishScale: 'en' }[key];
    const value = settings[key] ?? Math.round(sizes.auto[autoKey] * 100);
    $(key).value = value;
    $(`${key}Out`).textContent = settings[key] == null ? `Auto (${value}%)` : `${value}%`;
  }

  // A sample word drawn with the chosen parts and sizes.
  const preview = $('preview');
  preview.style.fontSize = `${Math.min(settings.fontSize, 34)}px`;
  preview.style.setProperty('--py', `${sizes.py}em`);
  preview.style.setProperty('--gl', `${sizes.gl}em`);
  preview.textContent = '';
  for (const [py, hz, gl] of [['gāo xìng', '高兴', 'happy'], ['ma', '吗', '(question)']]) {
    const w = document.createElement('span');
    w.className = 'w' + (sizes.show.hz ? '' : ' no-hz');
    const part = (cls, text) => Object.assign(document.createElement('span'), { className: cls, textContent: text });
    if (sizes.show.py) w.appendChild(part('py', py));
    if (sizes.show.hz) w.appendChild(part('hz', hz));
    if (sizes.show.gl) w.appendChild(part('gl', gl));
    preview.appendChild(w);
  }
}

async function init() {
  settings = await plGetSettings();
  for (const key of SWITCHES) $(key).addEventListener('change', () => save({ [key]: $(key).checked }));
  for (const r of document.querySelectorAll('input[name=overlayPosition]')) {
    r.addEventListener('change', () => save({ overlayPosition: r.value }));
  }
  $('englishLang').addEventListener('change', () => save({ englishLang: $('englishLang').value.trim() }));
  $('fontSize').addEventListener('input', () => save({ fontSize: Number($('fontSize').value) }));
  for (const key of SCALES) $(key).addEventListener('input', () => save({ [key]: Number($(key).value) }));
  $('resetSizes').addEventListener('click', () =>
    save({ fontSize: PL_DEFAULTS.fontSize, pinyinScale: null, glossScale: null, englishScale: null }));
  render();

  const { words = {} } = await chrome.storage.local.get('words');
  $('count').textContent = Object.keys(words).length;

  [{ id: tabId }] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await chrome.runtime.sendMessage({ type: 'get-status' });
  listeningHere = res?.listeningTabId === tabId;
  if (settings.engine === 'api' && !settings.apiKey) {
    statusEl.innerHTML = 'Cloud API selected but no key set. Add one in <a href="options.html" target="_blank">Settings</a>.';
  }
  local = settings.engine !== 'api';
  renderListen();
}

function renderListen() {
  listenBox.checked = listeningHere;
}

listenBox.addEventListener('change', async () => {
  const start = listenBox.checked;
  listenBox.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: start ? 'start-listening' : 'stop-listening', tabId });
  listenBox.disabled = false;
  if (!res?.ok) {
    statusEl.textContent = res?.error || 'Something went wrong.';
    renderListen();
    return;
  }
  listeningHere = start;
  statusEl.textContent = !listeningHere
    ? ''
    : local
      ? 'Listening on-device. The first time, the speech model downloads (progress shows on the video).'
      : 'Listening. Lines appear 3–8 s after they are spoken.';
  renderListen();
});

init();
