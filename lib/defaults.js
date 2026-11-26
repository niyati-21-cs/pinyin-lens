// Default settings, shared by the content script, background and extension pages.
// Loaded as a classic script, so it exposes a global instead of exporting.
globalThis.PL_DEFAULTS = Object.freeze({
  enabled: true,
  showPinyin: true,
  showHanzi: true,
  showGloss: true,
  toneColors: true,
  hideNative: true,
  pauseOnHover: true,
  fontSize: 30,
  extraSelectors: '',
  ocrEnabled: false,
  showEnglish: true,
  englishAuto: true,
  englishLang: '',
  overlayPosition: 'bottom',
  pinyinScale: null,   // null = auto (see plWordSizes); otherwise % of the character size
  glossScale: null,
  englishScale: null,
  engine: 'local',
  localModel: 'onnx-community/whisper-base',
  modelHost: 'https://huggingface.co/',
  apiKey: '',
  model: 'whisper-1',
  apiBase: 'https://api.openai.com/v1',
  minChunk: 2.5,
  maxChunk: 8,
});

// Which parts of each word are shown and how big, in em of the character
// size. Parts that are turned off give their space to the others; the
// Advanced size settings override the automatic sizes.
globalThis.plWordSizes = (s) => {
  const show = { py: s.showPinyin, hz: s.showHanzi, gl: s.showGloss };
  if (!show.py && !show.hz && !show.gl) show.hz = true; // never leave words blank
  const parts = show.py + show.hz + show.gl;
  const auto = {
    py: show.hz ? (show.gl ? 0.5 : 0.65) : 1,
    gl: parts === 1 ? 1 : parts === 3 ? 0.36 : 0.5,
  };
  const pick = (scale, fallback) => (scale == null || scale === '' ? fallback : scale / 100);
  return {
    show,
    py: pick(s.pinyinScale, auto.py),
    gl: pick(s.glossScale, auto.gl),
    en: pick(s.englishScale, 0.62),
    auto: { py: auto.py, gl: auto.gl, en: 0.62 },
  };
};

globalThis.plGetSettings = async () => ({
  ...globalThis.PL_DEFAULTS,
  ...(await chrome.storage.local.get('settings')).settings,
});
