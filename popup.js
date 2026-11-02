const $ = (id) => document.getElementById(id);
const listenBox = $('listen');
const statusEl = $('status');
let tabId = null;
let listeningHere = false;
let local = true;

async function init() {
  const settings = await plGetSettings();
  for (const key of ['enabled', 'showPinyin', 'showGloss', 'ocrEnabled']) {
    $(key).checked = settings[key];
    $(key).addEventListener('change', async () => {
      const current = await plGetSettings();
      chrome.storage.local.set({ settings: { ...current, [key]: $(key).checked } });
    });
  }
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
