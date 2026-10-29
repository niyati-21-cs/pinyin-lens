const KEYS = Object.keys(PL_DEFAULTS);
const el = (key) => document.getElementById(key);

async function load() {
  const settings = await plGetSettings();
  for (const key of KEYS) {
    const input = el(key);
    if (input.type === 'checkbox') input.checked = settings[key];
    else input.value = settings[key];
  }
}

el('save').addEventListener('click', async () => {
  const settings = {};
  for (const key of KEYS) {
    const input = el(key);
    if (input.type === 'checkbox') settings[key] = input.checked;
    else if (input.type === 'number') settings[key] = Number(input.value) || PL_DEFAULTS[key];
    else settings[key] = input.value.trim();
  }
  settings.maxChunk = Math.max(settings.maxChunk, settings.minChunk + 1);
  await chrome.storage.local.set({ settings });
  el('saved').textContent = 'Saved ✓';
  setTimeout(() => (el('saved').textContent = ''), 2000);
});

function showEngineFields() {
  const api = el('engine').value === 'api';
  el('api-fields').hidden = !api;
  el('local-fields').hidden = api;
}
el('engine').addEventListener('change', showEngineFields);

load().then(showEngineFields);
