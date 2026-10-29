// Captures the tab's audio, cuts it into phrase-sized chunks at pauses in
// speech, and sends each chunk to the speech-to-text API. Transcripts are
// delivered to the background in the order the audio was recorded.
import { transcribe } from './lib/transcribe.js';

const TICK_MS = 100;
const SILENCE_RMS = 0.012;   // below this a 100 ms frame counts as silence
const PAUSE_MS = 400;        // a pause this long ends a phrase
const MIN_VOICED_FRAMES = 4; // skip chunks with less than ~0.4 s of sound

let session = null;

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
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  session = { stream, ctx, analyser, tabId, settings, stopped: false, chain: Promise.resolve() };
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

function rms(buf) {
  let sum = 0;
  for (const v of buf) sum += v * v;
  return Math.sqrt(sum / buf.length);
}

function recordChunk(s) {
  if (s.stopped) return;
  const recorder = new MediaRecorder(s.stream, { mimeType: 'audio/webm;codecs=opus' });
  const parts = [];
  const frame = new Float32Array(s.analyser.fftSize);
  const started = performance.now();
  let voiced = 0;
  let silentMs = 0;

  recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
  recorder.onstop = () => {
    if (voiced < MIN_VOICED_FRAMES) return;
    const pending = transcribe(new Blob(parts, { type: 'audio/webm' }), s.settings);
    s.chain = s.chain.then(() =>
      pending.then(
        (text) => text && chrome.runtime.sendMessage({ type: 'transcript', tabId: s.tabId, text }),
        (err) => report(s.tabId, err),
      ),
    );
  };
  recorder.start();

  const timer = setInterval(() => {
    s.analyser.getFloatTimeDomainData(frame);
    if (rms(frame) > SILENCE_RMS) {
      voiced++;
      silentMs = 0;
    } else {
      silentMs += TICK_MS;
    }
    const elapsed = (performance.now() - started) / 1000;
    const phraseDone = voiced >= MIN_VOICED_FRAMES && silentMs >= PAUSE_MS && elapsed >= s.settings.minChunk;
    // Leading silence is dropped by restarting the chunk.
    const onlySilence = voiced === 0 && elapsed >= s.settings.minChunk;
    if (s.stopped || phraseDone || onlySilence || elapsed >= s.settings.maxChunk) {
      clearInterval(timer);
      recorder.stop();
      recordChunk(s);
    }
  }, TICK_MS);
}
