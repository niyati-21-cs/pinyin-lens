// On-device speech recognition: runs Whisper with transformers.js inside a
// worker so the offscreen document's audio timing isn't blocked.
// The model is downloaded once from Hugging Face and cached by the browser.
import { pipeline, env } from './vendor/transformers.min.js';

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1; // extension pages aren't cross-origin isolated

let loading = null;
let loadedKey = '';

async function hasWebGPU() {
  try {
    return !!(await navigator.gpu?.requestAdapter());
  } catch {
    return false;
  }
}

function load(model, host) {
  const key = `${host}|${model}`;
  if (loading && loadedKey === key) return loading;
  loadedKey = key;
  env.remoteHost = host;
  const progress_callback = (p) => {
    if (p.status === 'progress') postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
  };
  loading = (async () => {
    if (await hasWebGPU()) {
      try {
        return await pipeline('automatic-speech-recognition', model, {
          device: 'webgpu',
          dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
          progress_callback,
        });
      } catch (err) {
        console.warn('WebGPU unavailable for Whisper, falling back to WASM', err);
      }
    }
    return pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', progress_callback });
  })();
  loading.then(() => postMessage({ type: 'ready' }), () => { loading = null; });
  return loading;
}

onmessage = async ({ data }) => {
  const { id, audio, model, host } = data;
  try {
    let asr;
    try {
      asr = await load(model, host);
    } catch (err) {
      throw new Error(`Couldn't load the speech model (${model}): ${err.message}`);
    }
    const out = await asr(audio, { language: 'chinese', task: 'transcribe' });
    postMessage({ type: 'result', id, text: out.text });
  } catch (err) {
    postMessage({ type: 'result', id, error: err.message || String(err) });
  }
};
