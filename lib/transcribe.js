// Speech-to-text request helpers for audio mode (no browser APIs besides fetch/FormData).

export const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

// Whisper tends to "hear" these stock phrases in silence or music.
const HALLUCINATIONS = [
  /请不吝点赞/, /订阅.*转发/, /明镜.*点点栏目/, /字幕由.*提供/, /字幕志愿者/, /中文字幕/,
  /感谢观看/, /谢谢观看/, /^[\s。，、！？.…]*$/, /Amara\.org/i,
];

export function cleanTranscript(text) {
  const t = (text || '').trim();
  return HALLUCINATIONS.some((re) => re.test(t)) ? '' : t;
}

export function buildRequest(blob, { apiKey, model }) {
  const form = new FormData();
  form.append('file', blob, 'audio.webm');
  form.append('model', model || 'whisper-1');
  form.append('language', 'zh');
  // A simplified-Chinese prompt nudges the model to answer in simplified characters.
  form.append('prompt', '以下是普通话的句子。');
  form.append('response_format', 'json');
  return [TRANSCRIBE_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form }];
}

export async function transcribe(blob, settings, fetchImpl = fetch) {
  const res = await fetchImpl(...buildRequest(blob, settings));
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch {}
    throw new Error(`Transcription failed (${res.status}) ${detail}`.trim());
  }
  return cleanTranscript((await res.json()).text);
}
