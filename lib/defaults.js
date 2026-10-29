// Default settings, shared by the content script, background and extension pages.
// Loaded as a classic script, so it exposes a global instead of exporting.
globalThis.PL_DEFAULTS = Object.freeze({
  enabled: true,
  showPinyin: true,
  showGloss: true,
  toneColors: true,
  hideNative: true,
  pauseOnHover: true,
  fontSize: 30,
  extraSelectors: '',
  apiKey: '',
  model: 'whisper-1',
  minChunk: 2.5,
  maxChunk: 8,
});

globalThis.plGetSettings = async () => ({
  ...globalThis.PL_DEFAULTS,
  ...(await chrome.storage.local.get('settings')).settings,
});
