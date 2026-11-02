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

let offscreenReady = null;
let creatingOffscreen = null;

// Audio mode and OCR can both ask at once; only one document may exist.
function ensureOffscreen() {
  return (creatingOffscreen ||= createOffscreen().finally(() => { creatingOffscreen = null; }));
}

async function createOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  // createDocument resolves before the document's module script has
  // registered its listener, so wait for it to say it's ready.
  const ready = new Promise((resolve, reject) => {
    offscreenReady = resolve;
    setTimeout(() => reject(new Error('Audio capture page did not start.')), 10000);
  });
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA', 'WORKERS'],
    justification: 'Capture tab audio and transcribe spoken Chinese; read subtitles from video frames.',
  });
  await ready;
}

const getListeningTab = async () => (await chrome.storage.session.get('listeningTabId')).listeningTabId ?? null;

function notifyTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

async function startListening(tabId) {
  const settings = await plGetSettings();
  if (settings.engine === 'api' && !settings.apiKey) {
    throw new Error('Add your API key in Settings, or switch to the free on-device engine.');
  }
  await stopListening();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  const { engine, localModel, modelHost, apiKey, apiBase, model, minChunk, maxChunk } = settings;
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    streamId,
    tabId,
    settings: { engine, localModel, modelHost, apiKey, apiBase, model, minChunk, maxChunk },
  });
  await chrome.storage.session.set({ listeningTabId: tabId });
  notifyTab(tabId, { type: 'status', listening: true });
}

async function stopListening() {
  const tabId = await getListeningTab();
  if (tabId === null) return;
  await chrome.storage.session.remove('listeningTabId');
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
  await closeOffscreenIfIdle();
  notifyTab(tabId, { type: 'status', listening: false });
}

// --- reading subtitles from the picture (OCR) ---------------------------------

// The offscreen document is shared with audio mode; it closes once neither
// is in use, so the OCR models don't sit in memory.
const OCR_IDLE_MS = 60000;
let lastOcrAt = 0;
let idleTimer = 0;

async function closeOffscreenIfIdle() {
  if (Date.now() - lastOcrAt < OCR_IDLE_MS || (await getListeningTab()) !== null) return;
  if ((await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length) {
    await chrome.offscreen.closeDocument();
  }
}

async function readSubtitle(image) {
  lastOcrAt = Date.now();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(closeOffscreenIfIdle, OCR_IDLE_MS + 1000);
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ocr', image });
  if (!res?.ok) throw new Error(res?.error || 'Subtitle reader did not answer.');
  return { text: res.text };
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
    case 'ocr':
      return reply(readSubtitle(msg.image), sendResponse);
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
    case 'offscreen-ready':
      offscreenReady?.();
      return false;
    case 'engine-status':
      notifyTab(msg.tabId, { type: 'status', listening: true, info: msg.info });
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
