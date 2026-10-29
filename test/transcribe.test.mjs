import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, cleanTranscript, transcribe, DEFAULT_API_BASE } from '../lib/transcribe.js';

const blob = new Blob(['fake audio'], { type: 'audio/webm' });

test('request carries key, model, language and the audio file', async () => {
  const [url, init] = buildRequest(blob, { apiKey: 'sk-test', model: 'gpt-4o-mini-transcribe' });
  assert.equal(url, `${DEFAULT_API_BASE}/audio/transcriptions`);
  assert.equal(init.headers.Authorization, 'Bearer sk-test');
  assert.equal(init.body.get('model'), 'gpt-4o-mini-transcribe');
  assert.equal(init.body.get('language'), 'zh');
  assert.equal(await init.body.get('file').text(), 'fake audio');
});

test('custom OpenAI-compatible base URL', () => {
  const [url] = buildRequest(blob, { apiKey: 'k', apiBase: 'https://api.groq.com/openai/v1/' });
  assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
});

test('returns cleaned text and drops known hallucinations', async () => {
  const ok = async () => new Response(JSON.stringify({ text: ' 你好，世界 ' }));
  assert.equal(await transcribe(blob, { apiKey: 'k' }, ok), '你好，世界');
  assert.equal(cleanTranscript('请不吝点赞 订阅 转发 打赏支持明镜与点点栏目'), '');
  assert.equal(cleanTranscript('。。。'), '');
});

test('API errors surface the message', async () => {
  const bad = async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 });
  await assert.rejects(transcribe(blob, { apiKey: 'k' }, bad), /401.*Incorrect API key/);
});
