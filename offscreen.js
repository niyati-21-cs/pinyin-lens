// Captures the tab's audio, cuts it into phrase-sized chunks at pauses in
// speech, and transcribes each chunk, either on-device (Whisper in a worker)
// or with an OpenAI-compatible API. Transcripts are delivered to the
// background in the order the audio was recorded.
import { cleanTranscript, transcribe } from './lib/transcribe.js';

const BLOCK_MS = 50;         // level-worklet.js reports one level per 50 ms
const SILENCE_RMS = 0.012;   // quieter than this counts as silence
const PAUSE_MS = 400;        // a pause this long ends a phrase
const MIN_VOICED_MS = 400;   // skip chunks with less than ~0.4 s of sound
const MAX_BACKLOG = 2;       // on-device: drop new chunks while this many are waiting

let session = null;

// --- on-device engine ---------------------------------------------------------

let worker = null;
let nextId = 0;
const pendingJobs = new Map();
const downloads = new Map();
let decodeCtx = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker('local-asr-worker.js', { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      downloads.set(data.file, data);
      let loaded = 0;
      let total = 0;
      for (const d of downloads.values()) {
        loaded += d.loaded || 0;
        total += d.total || 0;
      }
      const pct = total ? Math.floor((loaded / total) * 100) : 0;
      status(`⬇ Downloading speech model ${pct}% (first time only, ${Math.round(total / 1e6)} MB)`);
    } else if (data.type === 'ready') {
      status('');
    } else if (data.type === 'result') {
      const job = pendingJobs.get(data.id);
      pendingJobs.delete(data.id);
      if (data.error) job?.reject(new Error(data.error));
      else job?.resolve(data.text);
    }
  };
  worker.onerror = (e) => {
    for (const job of pendingJobs.values()) job.reject(new Error(e.message || 'Speech model crashed'));
    pendingJobs.clear();
    worker = null;
  };
  return worker;
}

// Whisper expects 16 kHz mono samples; decodeAudioData resamples to the context rate.
async function toPcm16k(blob) {
  decodeCtx ||= new AudioContext({ sampleRate: 16000 });
  const buf = await decodeCtx.decodeAudioData(await blob.arrayBuffer());
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < data.length; i++) out[i] += data[i] / buf.numberOfChannels;
  }
  return out;
}

async function transcribeLocal(blob, settings) {
  const audio = await toPcm16k(blob);
  const id = ++nextId;
  const text = await new Promise((resolve, reject) => {
    pendingJobs.set(id, { resolve, reject });
    getWorker().postMessage({ id, audio, model: settings.localModel, host: settings.modelHost }, [audio.buffer]);
  });
  return cleanTranscript(text);
}

function status(info) {
  if (session) chrome.runtime.sendMessage({ type: 'engine-status', tabId: session.tabId, info });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'start') start(msg).catch((err) => report(msg.tabId, err));
  if (msg.type === 'stop') stop();
});

function report(tabId, err) {
  chrome.runtime.sendMessage({ type: 'transcribe-error', tabId, error: err.message || String(err) });
}

async function start({ streamId, tabId, settings }) {
  stop();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  });
  // Capturing a tab mutes it, so play the audio back to the user.
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  source.connect(ctx.destination);
  // Loudness is measured on the audio thread so pause detection keeps
  // working when the browser throttles this hidden page's timers.
  await ctx.audioWorklet.addModule('level-worklet.js');
  const meter = new AudioWorkletNode(ctx, 'pl-level', { numberOfOutputs: 0 });
  source.connect(meter);

  session = { stream, ctx, tabId, settings, stopped: false, chain: Promise.resolve(), onLevel: null };
  meter.port.onmessage = ({ data }) => session?.onLevel?.(data);
  stream.getAudioTracks()[0].addEventListener('ended', () => {
    stop();
    chrome.runtime.sendMessage({ type: 'capture-ended', tabId });
  });
  recordChunk(session);
}

function stop() {
  if (!session) return;
  session.stopped = true;
  session.stream.getTracks().forEach((t) => t.stop());
  session.ctx.close();
  session = null;
}

function recordChunk(s) {
  if (s.stopped) return;
  const recorder = new MediaRecorder(s.stream, { mimeType: 'audio/webm;codecs=opus' });
  const parts = [];
  let elapsedMs = 0;
  let voicedMs = 0;
  let silentMs = 0;

  recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
  recorder.onstop = () => {
    if (voicedMs < MIN_VOICED_MS || s.stopped) return;
    const blob = new Blob(parts, { type: 'audio/webm' });
    const local = s.settings.engine !== 'api';
    // A slow computer can't keep up with real time; skip audio rather than fall further behind.
    if (local && pendingJobs.size >= MAX_BACKLOG) return;
    const pending = local ? transcribeLocal(blob, s.settings) : transcribe(blob, s.settings);
    s.chain = s.chain.then(() =>
      pending.then(
        (text) => text && chrome.runtime.sendMessage({ type: 'transcript', tabId: s.tabId, text }),
        (err) => report(s.tabId, err),
      ),
    );
  };
  recorder.start();

  s.onLevel = (level) => {
    elapsedMs += BLOCK_MS;
    if (level > SILENCE_RMS) {
      voicedMs += BLOCK_MS;
      silentMs = 0;
    } else {
      silentMs += BLOCK_MS;
    }
    const elapsed = elapsedMs / 1000;
    const phraseDone = voicedMs >= MIN_VOICED_MS && silentMs >= PAUSE_MS && elapsed >= s.settings.minChunk;
    // Leading silence is dropped by restarting the chunk.
    const onlySilence = voicedMs === 0 && elapsed >= s.settings.minChunk;
    if (s.stopped || phraseDone || onlySilence || elapsed >= s.settings.maxChunk) {
      s.onLevel = null;
      recorder.stop();
      recordChunk(s);
    }
  };
}

// Tell the background the message listener is registered; messages sent
// before this point would be lost.
chrome.runtime.sendMessage({ type: 'offscreen-ready' });
