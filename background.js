import './lib/defaults.js';
import { annotate, Dictionary } from './lib/annotate.js';

// --- dictionary -------------------------------------------------------------

let dictPromise = null;
const getDict = () =>
  (dictPromise ||= fetch(chrome.runtime.getURL('data/cedict.json'))
    .then((res) => res.json())
    .then((data) => new Dictionary(data)));

// --- audio mode ---------------------------------------------------------------

const OFFSCREEN_URL = 'offscreen.html';

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio to transcribe spoken Chinese.',
  });
}

const getListeningTab = async () => (await chrome.storage.session.get('listeningTabId')).listeningTabId ?? null;

function notifyTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

async function startListening(tabId) {
  const settings = await plGetSettings();
  if (!settings.apiKey) throw new Error('Add your OpenAI API key in Options first.');
  await stopListening();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  const { apiKey, model, minChunk, maxChunk } = settings;
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    streamId,
    tabId,
    settings: { apiKey, model, minChunk, maxChunk },
  });
  await chrome.storage.session.set({ listeningTabId: tabId });
  notifyTab(tabId, { type: 'status', listening: true });
}

async function stopListening() {
  const tabId = await getListeningTab();
  if (tabId === null) return;
  await chrome.storage.session.remove('listeningTabId');
  if ((await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length) {
    await chrome.offscreen.closeDocument();
  }
  notifyTab(tabId, { type: 'status', listening: false });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === (await getListeningTab())) stopListening();
});

// --- messages -------------------------------------------------------------

const reply = (promise, sendResponse) => {
  promise.then(
    (value) => sendResponse({ ok: true, ...value }),
    (err) => sendResponse({ ok: false, error: err.message || String(err) }),
  );
  return true;
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return false;
  switch (msg.type) {
    case 'annotate':
      return reply(getDict().then((dict) => ({ tokens: annotate(msg.text, dict) })), sendResponse);
    case 'start-listening':
      return reply(startListening(msg.tabId), sendResponse);
    case 'stop-listening':
      return reply(stopListening(), sendResponse);
    case 'get-status':
      return reply(
        getListeningTab().then((tabId) => ({
          listeningTabId: tabId,
          listeningHere: tabId !== null && tabId === sender.tab?.id,
        })),
        sendResponse,
      );
    case 'transcript':
      notifyTab(msg.tabId, { type: 'line', text: msg.text, source: 'audio' });
      return false;
    case 'transcribe-error':
      notifyTab(msg.tabId, { type: 'status', listening: true, error: msg.error });
      return false;
    case 'capture-ended':
      stopListening();
      return false;
  }
  return false;
});
