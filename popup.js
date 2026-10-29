const $ = (id) => document.getElementById(id);
const listenBtn = $('listen');
const statusEl = $('status');
let tabId = null;
let listeningHere = false;

async function init() {
  const settings = await plGetSettings();
  for (const key of ['enabled', 'showPinyin', 'showGloss']) {
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
  if (!settings.apiKey) statusEl.innerHTML = 'Add an OpenAI API key in <a href="options.html" target="_blank">Settings</a> to use this.';
  renderListen();
}

function renderListen() {
  listenBtn.textContent = listeningHere ? '■ Stop listening' : '🎧 Listen to this tab';
  listenBtn.classList.toggle('primary', !listeningHere);
}

listenBtn.addEventListener('click', async () => {
  listenBtn.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: listeningHere ? 'stop-listening' : 'start-listening', tabId });
  listenBtn.disabled = false;
  if (!res?.ok) {
    statusEl.textContent = res?.error || 'Something went wrong.';
    return;
  }
  listeningHere = !listeningHere;
  statusEl.textContent = listeningHere ? 'Listening. Lines appear 3–8 s after they are spoken.' : '';
  renderListen();
});

init();
