// Finds the main <video> on the page, reads Chinese subtitles (text tracks or
// the site's caption elements) or audio transcripts, and shows each line with
// pinyin and English in an overlay on top of the video.
(() => {
  if (window.__pinyinLens) return;
  window.__pinyinLens = true;

  const HAN = /\p{Script=Han}/u;
  const ZH_TRACK = /^(zh|cmn|yue)|chinese|中文|汉|漢|普通|国语|國語|粤|粵/i;
  const SITE_CAPTIONS = [
    '.ytp-caption-segment',                  // YouTube
    '.player-timedtext-text-container',      // Netflix
    '.dss-subtitle-renderer-line',           // Disney+
    '.atvwebplayersdk-captions-text',        // Prime Video
  ];
  const TONE_COLORS = ['#ff5d5d', '#52d273', '#5aa9ff', '#c58cff', '#c8c8c8'];

  let settings = { ...globalThis.PL_DEFAULTS };
  let saved = {};
  let video = null;
  let track = null;
  let captionSelector = '';
  let lastCaption = '';
  let line = { text: '', tokens: [], source: null };
  let lineSeq = 0;
  let listening = false;
  let statusError = '';
  let statusInfo = '';
  let errorTimer = 0;
  let hovered = null;
  let pausedByUs = false;
  let hideCardTimer = 0;
  let pendingLine = null;

  // --- overlay DOM --------------------------------------------------------

  const host = document.createElement('pinyin-lens');
  host.style.cssText = 'all:initial;position:fixed;inset:0 auto auto 0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { font-family: "PingFang SC", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif; }
      .wrap { position: fixed; display: flex; flex-direction: column; align-items: center; gap: 6px; }
      .badge { pointer-events: auto; align-self: flex-start; font: 600 12px/1 system-ui, sans-serif;
        color: #fff; background: rgba(220,53,69,.9); padding: 5px 8px; border-radius: 999px; }
      .badge.err { background: rgba(120,0,0,.92); max-width: 100%; line-height: 1.3; }
      .bar { pointer-events: none; display: flex; flex-wrap: wrap; justify-content: center; align-items: flex-end;
        gap: 2px 4px; max-width: 92%; padding: 8px 14px; border-radius: 12px;
        background: rgba(0,0,0,.72); color: #fff; text-shadow: 0 1px 2px #000; }
      .bar:empty { display: none; }
      .en-wrap { position: fixed; display: flex; justify-content: center; }
      .en { pointer-events: none; max-width: 92%; padding: 4px 12px; border-radius: 8px; text-align: center;
        background: rgba(0,0,0,.6); color: #fff; text-shadow: 0 1px 2px #000; white-space: pre-line;
        font: 500 var(--en, 0.62em)/1.35 system-ui, sans-serif; }
      .en:empty { display: none; }
      .w { pointer-events: auto; display: inline-flex; flex-direction: column; align-items: center;
        cursor: pointer; padding: 2px 3px; border-radius: 6px; }
      .w:hover, .w.active { background: rgba(255,255,255,.18); }
      .w.saved .hz, .w.saved.no-hz .py { text-decoration: underline 2px #ffd34d; text-underline-offset: 5px; }
      .py { font: 500 var(--py, 0.5em)/1.2 system-ui, sans-serif; opacity: .95; white-space: nowrap; }
      .w.no-hz .py { font-weight: 600; opacity: 1; }
      .hz { line-height: 1.25; white-space: nowrap; }
      .gl { font: var(--gl, 0.36em)/1.2 system-ui, sans-serif; opacity: .8; max-width: 9em; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }
      .p { align-self: flex-end; line-height: 1.25; white-space: pre; }
      .card { pointer-events: auto; position: fixed; z-index: 1; width: max-content; max-width: min(380px, 90vw);
        max-height: 50vh; overflow: auto; background: #fff; color: #1d1d1f; border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,.35); padding: 14px 16px; font: 14px/1.45 system-ui, sans-serif; }
      .card[hidden] { display: none; }
      .card .head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
      .card .big { font: 600 30px/1.1 "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif; }
      .card .trad { color: #777; font-size: 16px; }
      .card .save { margin-left: auto; border: 0; border-radius: 8px; padding: 6px 10px; cursor: pointer;
        font: 600 13px system-ui, sans-serif; background: #ffd34d; color: #3a2c00; }
      .card .save.on { background: #e9e9ee; color: #555; }
      .card .entry + .entry { margin-top: 8px; padding-top: 8px; border-top: 1px solid #eee; }
      .card .epy { font-weight: 600; color: #c0303f; }
      .card ol { margin: 2px 0 0; padding-left: 20px; }
      .card .hint { margin-top: 8px; color: #888; font-size: 12px; }
    </style>
    <div class="wrap"><div class="badge" hidden></div><div class="bar"></div></div>
    <div class="en-wrap"><div class="en"></div></div>
    <div class="card" hidden></div>`;
  const wrap = root.querySelector('.wrap');
  const badge = root.querySelector('.badge');
  const bar = root.querySelector('.bar');
  const enWrap = root.querySelector('.en-wrap');
  const enLine = root.querySelector('.en');
  const card = root.querySelector('.card');

  const nativeStyle = document.createElement('style');

  function mount() {
    const fs = document.fullscreenElement;
    // When the <video> element itself is fullscreen nothing can be drawn over
    // it; sites with custom players make a wrapper element fullscreen instead.
    const parent = fs && fs !== video && fs.contains(video) ? fs : document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
    if (!nativeStyle.isConnected) document.documentElement.appendChild(nativeStyle);
  }

  // --- video & subtitle sources -------------------------------------------

  function pickVideo() {
    let best = null;
    let bestScore = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < 120 * 70) continue;
      const score = area * (v.paused ? 1 : 4);
      if (score > bestScore) [best, bestScore] = [v, score];
    }
    if (best !== video) attachVideo(best);
  }

  function attachVideo(v) {
    if (video) {
      video.textTracks.removeEventListener('addtrack', chooseTrack);
      video.textTracks.removeEventListener('change', chooseTrack);
    }
    setTrack(null);
    video = v;
    if (!video) return render();
    video.textTracks.addEventListener('addtrack', chooseTrack);
    video.textTracks.addEventListener('change', chooseTrack);
    chooseTrack();
    mount();
    render();
  }

  function trackHasHan(t) {
    return [...(t.cues || [])].slice(0, 20).some((c) => HAN.test(c.text || ''));
  }

  function chooseTrack() {
    if (!video) return;
    const tracks = [...video.textTracks].filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
    const pick =
      tracks.find((t) => t.mode === 'showing' && (ZH_TRACK.test(t.language) || ZH_TRACK.test(t.label))) ||
      tracks.find((t) => ZH_TRACK.test(t.language) || ZH_TRACK.test(t.label)) ||
      tracks.find(trackHasHan) ||
      null;
    if (pick !== track) setTrack(pick);
    else if (track) applyTrackMode();
    // A second, English track (dual-subtitle videos) is shown as its own line:
    // any English one, or the one matching the language typed in settings.
    const wanted = englishWanted();
    const enPick = settings.showEnglish && track
      ? tracks.find((t) => t !== track && (wanted
        ? t.language.toLowerCase().includes(wanted) || t.label.toLowerCase().includes(wanted)
        : /^en/i.test(t.language) || /english/i.test(t.label))) || null
      : null;
    if (wanted && settings.showEnglish && track && !enPick && tracks.length > 1) noEnglishMatch();
    if (enPick !== enTrack) setEnTrack(enPick);
    else if (enTrack) applyEnTrackMode();
  }

  let enTrack = null;

  function applyEnTrackMode() {
    if (!originalModes.has(enTrack)) originalModes.set(enTrack, enTrack.mode);
    // Hidden while we draw it ourselves next to the pinyin overlay.
    const want = settings.enabled ? 'hidden' : originalModes.get(enTrack);
    if (enTrack.mode !== want) enTrack.mode = want;
  }

  function setEnTrack(t) {
    if (enTrack) {
      enTrack.removeEventListener('cuechange', onEnCueChange);
      if (originalModes.has(enTrack)) enTrack.mode = originalModes.get(enTrack);
      setEnglish('');
    }
    enTrack = t;
    if (!enTrack) return;
    applyEnTrackMode();
    enTrack.addEventListener('cuechange', onEnCueChange);
    onEnCueChange();
  }

  function onEnCueChange() {
    setEnglish([...(enTrack.activeCues || [])].map((c) => (c.text || '').replace(/<[^>]+>/g, '')).join('\n'));
  }

  const originalModes = new WeakMap();

  function applyTrackMode() {
    if (!originalModes.has(track)) originalModes.set(track, track.mode);
    // "hidden" still fires cuechange, it just stops the browser drawing them.
    // With the overlay off, the track goes back to how the page had it.
    const want = !settings.enabled ? originalModes.get(track) : settings.hideNative ? 'hidden' : 'showing';
    if (track.mode !== want) track.mode = want;
  }

  function setTrack(t) {
    if (track) {
      track.removeEventListener('cuechange', onCueChange);
      if (originalModes.has(track)) track.mode = originalModes.get(track);
    }
    track = t;
    if (!track) return;
    applyTrackMode();
    track.addEventListener('cuechange', onCueChange);
    onCueChange();
  }

  function onCueChange() {
    const text = [...(track.activeCues || [])]
      .map((c) => (c.text || '').replace(/<[^>]+>/g, ''))
      .join('\n');
    showLine(text, 'subtitles');
  }

  // --- English line on YouTube --------------------------------------------------
  // YouTube shows one caption track at a time. When Chinese captions are on,
  // the player's own caption request (visible in the page's resource timing)
  // is reused with lang=en to fetch the English track: the video's English
  // captions, else auto-generated English, else YouTube's machine
  // translation of the Chinese track.

  const english = { key: '', src: '', events: [], lastZhUrl: '', hinted: '' };

  // A message on the overlay's badge for a few seconds.
  function showHint(text) {
    clearTimeout(errorTimer);
    statusError = text;
    errorTimer = setTimeout(() => { statusError = ''; render(); }, 8000);
    render();
  }

  // The language typed in settings (lower case), or '' for automatic.
  const englishWanted = () => (settings.englishAuto ? '' : settings.englishLang.trim().toLowerCase());

  function noEnglishMatch() {
    const wanted = settings.englishLang.trim();
    if (english.hinted === wanted) return; // say it once per value
    english.hinted = wanted;
    showHint(`⚠ No subtitle track matching "${wanted}"`);
  }

  function setEnglish(text) {
    text = (text || '').trim();
    if (enLine.textContent !== text) {
      enLine.textContent = text;
      position();
    }
  }

  function onResource(url) {
    if (!/\/api\/timedtext\?/.test(url)) return;
    const u = new URL(url, location.href);
    const lang = u.searchParams.get('tlang') || u.searchParams.get('lang') || '';
    if (!/^(zh|cmn)/i.test(lang)) return; // only while Chinese captions are on
    english.lastZhUrl = url; // kept so switching English on later still works
    if (!settings.showEnglish) return;
    const key = `${u.searchParams.get('v')}|${lang}|${englishWanted()}`;
    if (key === english.key) return;
    english.key = key;
    english.events = [];
    loadEnglish(u, key);
  }

  async function loadEnglish(zhUrl, key) {
    const withParams = (base, set, remove = []) => {
      const u = new URL(base);
      u.searchParams.set('fmt', 'json3');
      for (const [k, v] of Object.entries(set)) u.searchParams.set(k, v);
      for (const k of remove) u.searchParams.delete(k);
      return u;
    };
    // Typed in settings: that language code only (e.g. en-GB). Automatic: the
    // usual English variants, auto-generated English, then a translation.
    const wanted = englishWanted();
    // Sent as typed: YouTube's language codes are case-sensitive (en-GB).
    const langs = wanted ? [settings.englishLang.trim()] : ['en', 'en-US', 'en-GB', 'en-CA', 'en-AU', 'en-IN'];
    const candidates = [
      ...langs.map((lang) => withParams(zhUrl, { lang }, ['tlang', 'kind', 'name'])),
      withParams(zhUrl, { lang: langs[0], kind: 'asr' }, ['tlang', 'name']),
      withParams(zhUrl, { tlang: langs[0] }),
    ];
    for (const url of candidates) {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) continue;
        const events = parseJson3(await res.json());
        if (english.key !== key) return;
        if (events.length) {
          english.events = events;
          english.src = video?.currentSrc || '';
          return;
        }
      } catch {
        // empty or non-JSON reply: try the next option
      }
    }
    if (wanted && english.key === key) noEnglishMatch();
  }

  function parseJson3(data) {
    return (data.events || [])
      .filter((e) => e.segs)
      .map((e) => ({
        start: e.tStartMs / 1000,
        end: (e.tStartMs + (e.dDurationMs || 0)) / 1000,
        text: e.segs.map((s) => s.utf8 || '').join('').trim(),
      }))
      .filter((e) => e.text);
  }

  function showEnglishCue() {
    // YouTube swaps the video source when the next video starts.
    if (!settings.showEnglish || !video || video.currentSrc !== english.src) {
      english.events = [];
      english.key = '';
      return setEnglish('');
    }
    const t = video.currentTime;
    setEnglish(english.events.filter((e) => t >= e.start && t < e.end).map((e) => e.text).join('\n'));
  }

  // Started once settings are loaded (buffered, so earlier requests count too).
  function watchCaptionRequests() {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) onResource(entry.name);
      }).observe({ type: 'resource', buffered: true });
    } catch {
      // no resource timing in this frame
    }
  }

  function updateCaptionSelector() {
    const extra = settings.extraSelectors.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    captionSelector = [...SITE_CAPTIONS, ...extra].filter((sel) => {
      try { document.querySelector(sel); return true; } catch { return false; }
    }).join(',');
    nativeStyle.textContent = settings.enabled && settings.hideNative && captionSelector
      ? `${captionSelector} { opacity: 0 !important; }`
      : '';
  }

  function readSiteCaptions() {
    if (!captionSelector) return;
    const els = [...document.querySelectorAll(captionSelector)];
    const top = els.filter((el) => !els.some((other) => other !== el && other.contains(el)));
    const text = top.map((el) => el.textContent).join('\n').trim();
    if (text === lastCaption) return;
    lastCaption = text;
    if (text || line.source === 'captions') showLine(text, 'captions');
  }

  let captionQueued = false;
  new MutationObserver(() => {
    if (captionQueued) return;
    captionQueued = true;
    requestAnimationFrame(() => {
      captionQueued = false;
      readSiteCaptions();
    });
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // --- lines --------------------------------------------------------------

  async function showLine(text, source) {
    text = (text || '').trim();
    if ((source === 'subtitles' || source === 'captions') && HAN.test(text)) lastTextLineAt = Date.now();
    if (text === line.text && source === line.source) return;
    const seq = ++lineSeq;
    if (!text || !HAN.test(text)) {
      line = { text, tokens: [], source };
      return render();
    }
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'annotate', text });
    } catch {
      return; // extension was reloaded; this content script is orphaned
    }
    if (seq !== lineSeq || !res?.ok) return;
    if (hovered) {
      // Don't yank the word card away; show the new line once it closes.
      pendingLine = { text, tokens: res.tokens, source };
      return;
    }
    line = { text, tokens: res.tokens, source };
    render();
  }

  // --- audio-mode pacing ------------------------------------------------------
  // Transcripts arrive unevenly: a long line, then a one-word line a moment
  // later. Each line stays up long enough to read (time counts only while the
  // video plays, so pausing the video pauses the subtitles), and short
  // follow-ups are joined onto the line that's still being read.

  const READ_BASE_MS = 1500;
  const READ_PER_CHAR_MS = 300;
  const READ_MAX_MS = 7000;
  const SHORT_LINE_CHARS = 4; // lines this short are joined onto the previous one
  const JOIN_MAX_CHARS = 24;
  const MAX_QUEUE = 3; // beyond this, skip ahead rather than fall further behind
  const PACE_TICK_MS = 200;

  const hanCount = (text) => (text.match(/\p{Script=Han}/gu) || []).length;
  const readMs = (text) => Math.min(READ_MAX_MS, READ_BASE_MS + hanCount(text) * READ_PER_CHAR_MS);

  const pacer = { text: '', needMs: 0, seenMs: 0, queue: [], timer: 0 };

  function pacerShow(text) {
    pacer.text = text;
    pacer.needMs = readMs(text);
    pacer.seenMs = 0;
    showLine(text, 'audio');
  }

  function pacerStillReading() {
    return pacer.text && (pacer.seenMs < pacer.needMs || video?.paused);
  }

  function pacerPush(text) {
    text = (text || '').trim();
    if (!text) return;
    if (!pacer.timer) pacer.timer = setInterval(pacerTick, PACE_TICK_MS);
    const last = pacer.queue.length ? pacer.queue.at(-1) : pacer.text;
    const short = hanCount(text) <= SHORT_LINE_CHARS;
    if (short && last && pacerStillReading() && hanCount(last) + hanCount(text) <= JOIN_MAX_CHARS) {
      // Join a short follow-up onto the line that's waiting or on screen.
      const joined = `${last} ${text}`;
      if (pacer.queue.length) {
        pacer.queue[pacer.queue.length - 1] = joined;
      } else {
        pacer.text = joined;
        pacer.needMs = readMs(joined);
        showLine(joined, 'audio');
      }
    } else if (pacerStillReading()) {
      pacer.queue.push(text);
      if (pacer.queue.length > MAX_QUEUE) pacer.queue.splice(0, pacer.queue.length - MAX_QUEUE);
    } else {
      pacerShow(text);
    }
  }

  function pacerTick() {
    // Reading time only counts while the video plays and no word card is open.
    if (video && !video.paused && !hovered) pacer.seenMs += PACE_TICK_MS;
    if (pacer.queue.length && !pacerStillReading()) pacerShow(pacer.queue.shift());
  }

  function pacerReset() {
    clearInterval(pacer.timer);
    Object.assign(pacer, { text: '', needMs: 0, seenMs: 0, queue: [], timer: 0 });
  }

  // --- reading subtitles from the picture (OCR) ------------------------------
  // Many dramas have Chinese subtitles drawn into the video. Several times a
  // second, look at the bottom of the picture; when the bright text there
  // changes, crop the subtitle band and send it to the OCR model.
  //
  // Look-ahead: when the page plays a plain video file, a hidden muted copy
  // runs 1 s ahead. Its frames are read early and each line is shown when the
  // real video reaches it, so subtitles appear on time. Streamed videos (blob:
  // URLs) can't be copied; those are read live, as fast as possible.

  const OCR_TICK_MS = 150;
  const OCR_STRIP = 0.25;          // subtitles sit in the bottom quarter
  const OCR_MAX_WIDTH = 1280;
  const THUMB_W = 320;
  const THUMB_H = 48;
  const TEXT_PRIORITY_MS = 10000;  // real subtitle text wins over OCR
  const BLACK_TICKS = 67;          // ~10 s of a pure black picture → probably copy-protected
  const LOOKAHEAD_S = 1.0;
  const LOOKAHEAD_MIN_S = 0.3;     // the copy must be at least this far ahead to be used
  const LOOKAHEAD_DRIFT_S = 0.3;

  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = THUMB_W;
  thumbCanvas.height = THUMB_H;
  const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });
  const stripCanvas = document.createElement('canvas');
  const stripCtx = stripCanvas.getContext('2d');
  let lastTextLineAt = 0;
  let ocrPrevMask = { live: null, ahead: null };
  let ocrConfirm = { live: false, ahead: false }; // re-read next tick to confirm a candidate
  let ocrCandidate = null;
  let ocrBusy = false;
  let ocrQueued = [];
  let ocrBlockedVideo = null;
  let ocrWarmedUp = false;
  let blackTicks = 0;
  // coveredFrom: the real-video time from which the copy has been read; before
  // it (just after starting or a jump) the live video is read instead.
  const ahead = { video: null, clone: null, failed: false, timeline: [], coveredFrom: null };

  function ocrBlock(reason, { stop = true } = {}) {
    if (stop) ocrBlockedVideo = video;
    showHint(`⚠ Can't read subtitles from this video's picture: ${reason}`);
  }

  // --- look-ahead copy ---

  function dropClone() {
    ahead.clone?.remove();
    ahead.clone = null;
    ahead.timeline = [];
    ahead.coveredFrom = null;
  }

  function onRealSeek() {
    ahead.timeline = [];
    ahead.coveredFrom = null;
    ocrPrevMask = { live: null, ahead: null };
    ocrCandidate = null;
  }

  // The live video still needs reading until it reaches the part the copy covers.
  const aheadCovers = () => ahead.coveredFrom !== null && video.currentTime >= ahead.coveredFrom;

  function syncLookahead() {
    if (ahead.video !== video) {
      ahead.video?.removeEventListener('seeking', onRealSeek);
      dropClone();
      ahead.video = video;
      ahead.failed = false;
      video?.addEventListener('seeking', onRealSeek);
    }
    const src = video?.currentSrc || '';
    if (ahead.failed || !/^https?:/.test(src)) return dropClone();
    if (!ahead.clone || ahead.clone.dataset.src !== src) {
      dropClone();
      const c = document.createElement('video');
      Object.assign(c, { muted: true, playsInline: true, preload: 'auto', crossOrigin: 'anonymous' });
      c.dataset.src = src;
      // Kept on screen (but invisible) so the browser doesn't stop decoding it.
      c.style.cssText = 'all:initial;position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;';
      c.addEventListener('error', () => { ahead.failed = true; dropClone(); });
      c.src = src;
      document.documentElement.appendChild(c);
      ahead.clone = c;
    }
    const c = ahead.clone;
    if (video.paused) {
      if (!c.paused) c.pause();
      return;
    }
    if (c.playbackRate !== video.playbackRate) c.playbackRate = video.playbackRate;
    const target = video.currentTime + LOOKAHEAD_S * video.playbackRate;
    if (c.readyState >= 1 && !c.seeking && Math.abs(c.currentTime - target) > LOOKAHEAD_DRIFT_S
        && target < (c.duration || Infinity)) {
      c.currentTime = target;
      ahead.coveredFrom = null;
      ocrPrevMask.ahead = null;
    }
    if (c.paused) c.play().catch(() => { ahead.failed = true; dropClone(); });
  }

  function lookaheadReady() {
    const c = ahead.clone;
    return !!c && c.readyState >= 2 && !c.paused && !c.seeking
      && c.currentTime - video.currentTime >= LOOKAHEAD_MIN_S;
  }

  // --- frames ---

  // Subtitle-like pixels in the bottom strip of `src` (lib/subtitle-lines.js):
  // plain bright background mostly doesn't count, so it doesn't trigger reads.
  function readThumb(src, sy) {
    thumbCtx.drawImage(src, 0, sy, src.videoWidth, src.videoHeight - sy, 0, 0, THUMB_W, THUMB_H);
    return plSubtitleMask(thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H).data, THUMB_W, THUMB_H);
  }

  function isBlack(src) {
    thumbCtx.drawImage(src, 0, 0, src.videoWidth, src.videoHeight, 0, 0, 8, 8);
    const px = thumbCtx.getImageData(0, 0, 8, 8).data;
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2]) return false;
    return true;
  }

  // Crops the found lines out of the frame. Returns the image (dataURL) and
  // the line boxes in its pixels, so the model can read them directly.
  function cropLines(src, sy, lines) {
    const kx = src.videoWidth / THUMB_W;
    const ky = (src.videoHeight - sy) / THUMB_H;
    const x0 = Math.min(...lines.map((b) => b.x0)) * kx;
    const x1 = (Math.max(...lines.map((b) => b.x1)) + 1) * kx;
    const y0 = sy + Math.min(...lines.map((b) => b.y0)) * ky;
    const y1 = sy + (Math.max(...lines.map((b) => b.y1)) + 1) * ky;
    const scale = Math.min(1, OCR_MAX_WIDTH / src.videoWidth);
    stripCanvas.width = Math.max(16, Math.round((x1 - x0) * scale));
    stripCanvas.height = Math.max(16, Math.round((y1 - y0) * scale));
    stripCtx.drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, stripCanvas.width, stripCanvas.height);
    const boxes = lines.map((b) => {
      const x = Math.round((b.x0 * kx - x0) * scale);
      const y = Math.round((sy + b.y0 * ky - y0) * scale);
      return {
        x, y,
        w: Math.min(stripCanvas.width - x, Math.round((b.x1 - b.x0 + 1) * kx * scale)),
        h: Math.min(stripCanvas.height - y, Math.round((b.y1 - b.y0 + 1) * ky * scale)),
      };
    });
    return { image: stripCanvas.toDataURL('image/jpeg', 0.92), boxes };
  }

  function ocrTick() {
    if (!settings.ocrEnabled || !settings.enabled || !video) return;
    if (video.readyState < 2 || !video.videoWidth || ocrBlockedVideo === video) return;
    if (Date.now() - lastTextLineAt < TEXT_PRIORITY_MS) return;
    if (!ocrWarmedUp) {
      // Load the models now so the first subtitle doesn't wait for them.
      ocrWarmedUp = true;
      chrome.runtime.sendMessage({ type: 'ocr-warmup' }).catch(() => {});
    }
    syncLookahead();
    showDueLines();
    if (video.paused) return;

    if (lookaheadReady()) {
      if (ahead.coveredFrom === null) ahead.coveredFrom = ahead.clone.currentTime;
      scanFrame('ahead', ahead.clone);
    }
    if (!aheadCovers()) scanFrame('live', video);
  }

  function scanFrame(mode, src) {
    const sy = Math.round(src.videoHeight * (1 - OCR_STRIP));
    let mask;
    try {
      mask = readThumb(src, sy);
      if (mode === 'ahead' && isBlack(src) && !isBlack(video)) throw new Error('copy reads black');
    } catch {
      if (mode === 'ahead') {
        ahead.failed = true;
        dropClone();
        return;
      }
      return ocrBlock('it comes from another site and the browser blocks reading it.');
    }

    if (mode === 'live') {
      // A copy-protected video reads back as pure black, top to bottom.
      // Keep checking afterwards: a long dark scene looks the same for a while.
      blackTicks = isBlack(video) ? blackTicks + 1 : 0;
      if (blackTicks === BLACK_TICKS) ocrBlock('it looks copy-protected (the picture reads as black).', { stop: false });
      if (blackTicks) return;
    }

    const frame = { mask, lines: plFindLines(mask, THUMB_W, THUMB_H) };
    const changed = plSubtitleChanged(ocrPrevMask[mode], frame, THUMB_W) || ocrConfirm[mode];
    ocrPrevMask[mode] = frame;
    ocrConfirm[mode] = false;
    if (!changed) return;

    const job = { mode, at: src.currentTime, video };
    const { lines } = frame;
    if (!lines.length) {
      ocrResult(job, ''); // the subtitle went away: no need to ask the model
      return;
    }
    Object.assign(job, cropLines(src, sy, lines));
    // Only the newest change per source matters; an older queued one is replaced.
    if (ocrBusy) ocrQueued = [...ocrQueued.filter((j) => j.mode !== mode), job];
    else runOcr(job);
  }

  async function runOcr(job) {
    ocrBusy = true;
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'ocr', image: job.image, boxes: job.boxes });
    } catch {
      ocrBusy = false;
      return; // extension was reloaded; this content script is orphaned
    }
    ocrBusy = false;
    if (!res?.ok) ocrBlock(res?.error || 'the subtitle reader failed.', { stop: false });
    else ocrResult(job, res.text);
    if (ocrQueued.length) runOcr(ocrQueued.shift());
  }

  function ocrResult(job, text) {
    if (job.video !== video || !settings.ocrEnabled || Date.now() - lastTextLineAt < TEXT_PRIORITY_MS) return;
    // The model read nothing although text is there: keep what's shown.
    if (!text && job.image) return;
    if (job.mode === 'ahead') {
      // Show it when the real video reaches the frame it was read from.
      ahead.timeline.push({ at: job.at, text, job });
      ahead.timeline.sort((x, y) => x.at - y.at);
      showDueLines();
    } else if (!aheadCovers()) {
      applyOcrText(text, job);
    }
  }

  function showDueLines() {
    const now = video?.currentTime ?? 0;
    // Entries far ahead of the real video are left over from a jump back.
    ahead.timeline = ahead.timeline.filter((e) => e.at - now <= LOOKAHEAD_S + 1);
    let due = null;
    while (ahead.timeline.length && ahead.timeline[0].at <= now) due = ahead.timeline.shift();
    if (due) applyOcrText(due.text, due.job);
  }

  // A new reading replaces the line at once when the text is almost entirely
  // different (a new subtitle). A reading that is only partly different is
  // often the same subtitle misread while busy background passes behind it,
  // so two reads in a row must agree first.
  function applyOcrText(text, job) {
    if (!text) {
      ocrCandidate = null;
      if (line.source === 'ocr') showLine('', 'ocr');
      return;
    }
    const current = line.source === 'ocr' ? line.text : '';
    if (current && nearlySame(text, current)) {
      ocrCandidate = null;
    } else if (!current || mostlyDifferent(text, current) || (ocrCandidate && nearlySame(text, ocrCandidate))) {
      ocrCandidate = null;
      showLine(text, 'ocr');
    } else {
      ocrCandidate = text;
      ocrConfirm[job.mode] = true;
    }
  }

  function editDistance(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // OCR can misread a few characters of the same subtitle between frames
  // (up to 30%); those reads keep the line already shown.
  function nearlySame(a, b) {
    return editDistance(a, b) <= Math.max(2, Math.floor(0.3 * Math.max(a.length, b.length)));
  }

  const mostlyDifferent = (a, b) => editDistance(a, b) >= 0.65 * Math.max(a.length, b.length);

  setInterval(ocrTick, OCR_TICK_MS);

  function gloss(def) {
    return def.replace(/\([^)]*\)|\[[^\]]*\]|CL:.*$/g, '').split(/[;,]/)[0].trim();
  }

  let renderedTokens = null;

  function render() {
    // Keep the word card open across re-renders of the same line (e.g. after saving).
    const active = root.querySelector('.w.active');
    const reopen = !card.hidden && active && line.tokens === renderedTokens ? active.dataset.i : null;
    renderedTokens = line.tokens;
    hideCard(true);
    bar.textContent = '';
    const visible = settings.enabled && video;
    host.style.display = visible ? '' : 'none';
    if (!visible) return;
    bar.style.fontSize = `${settings.fontSize}px`;
    enLine.style.fontSize = `${settings.fontSize}px`;
    const sizes = plWordSizes(settings);
    bar.style.setProperty('--py', `${sizes.py}em`);
    bar.style.setProperty('--gl', `${sizes.gl}em`);
    enLine.style.setProperty('--en', `${sizes.en}em`);

    line.tokens.forEach((tok, i) => {
      if (!tok.entries) {
        const span = document.createElement('span');
        span.className = 'p';
        span.textContent = tok.text;
        bar.appendChild(span);
        return;
      }
      const [first] = tok.entries;
      const w = document.createElement('span');
      w.className = 'w' + (saved[tok.text] ? ' saved' : '') + (sizes.show.hz ? '' : ' no-hz');
      w.dataset.i = i;

      const py = document.createElement('span');
      py.className = 'py';
      const hz = document.createElement('span');
      hz.className = 'hz';
      const syllables = first.pinyin.split(' ');
      const chars = [...tok.text];
      const colorBy = settings.toneColors && syllables.length === chars.length;
      syllables.forEach((syl, k) => {
        const s = document.createElement('span');
        s.textContent = syl;
        if (settings.toneColors) s.style.color = TONE_COLORS[(first.tones[k] || 5) - 1];
        py.append(s, k < syllables.length - 1 ? ' ' : '');
      });
      chars.forEach((ch, k) => {
        const s = document.createElement('span');
        s.textContent = ch;
        if (colorBy) s.style.color = TONE_COLORS[(first.tones[k] || 5) - 1];
        hz.appendChild(s);
      });
      if (sizes.show.py) w.appendChild(py);
      if (sizes.show.hz) w.appendChild(hz);
      if (sizes.show.gl) {
        const gl = document.createElement('span');
        gl.className = 'gl';
        gl.textContent = gloss(first.defs[0]);
        w.appendChild(gl);
      }
      w.addEventListener('mouseenter', () => openCard(w, tok));
      w.addEventListener('mouseleave', scheduleHideCard);
      w.addEventListener('click', () => toggleSave(tok));
      bar.appendChild(w);
    });

    if (reopen !== null) {
      const el = bar.querySelector(`.w[data-i="${reopen}"]`);
      if (el) openCard(el, line.tokens[reopen]);
    }

    badge.hidden = !(listening || statusError || statusInfo);
    badge.className = 'badge' + (statusError ? ' err' : '');
    badge.textContent = statusError || statusInfo || '🎧 Listening… (lines appear a few seconds late)';
    position();
  }

  // The pinyin overlay sits at the bottom or top of the video (setting). The
  // English line goes right under it at the bottom, or stays at the bottom,
  // where subtitles usually are, when the overlay is at the top.
  function position() {
    if (!video || host.style.display === 'none') return;
    const r = video.getBoundingClientRect();
    const top = settings.overlayPosition === 'top';
    // Inside a fullscreen element "fixed" is still relative to the viewport.
    const fromBottom = `${Math.max(0, innerHeight - r.bottom) + r.height * 0.1}px`;
    wrap.style.left = `${r.left}px`;
    wrap.style.width = `${r.width}px`;
    wrap.style.top = top ? `${Math.max(0, r.top) + r.height * 0.05}px` : 'auto';
    wrap.style.bottom = top ? 'auto' : fromBottom;
    if (top && enLine.parentNode !== enWrap) enWrap.appendChild(enLine);
    if (!top && enLine.parentNode !== wrap) wrap.appendChild(enLine);
    enWrap.style.left = `${r.left}px`;
    enWrap.style.width = `${r.width}px`;
    enWrap.style.bottom = fromBottom;
  }

  (function loop() {
    if (english.events.length) showEnglishCue();
    if (line.tokens.length || enLine.textContent || listening || statusError || statusInfo) position();
    // Look-ahead OCR lines are timed to the frame; check every animation frame.
    if (ahead.timeline.length) showDueLines();
    requestAnimationFrame(loop);
  })();

  // --- word card -------------------------------------------------------------

  function openCard(el, tok) {
    clearTimeout(hideCardTimer);
    root.querySelectorAll('.w.active').forEach((n) => n.classList.remove('active'));
    el.classList.add('active');
    hovered = tok;
    if (settings.pauseOnHover && video && !video.paused) {
      video.pause();
      pausedByUs = true;
    }

    const isSaved = !!saved[tok.text];
    card.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'head';
    const big = document.createElement('span');
    big.className = 'big';
    big.textContent = tok.text;
    head.appendChild(big);
    const trad = tok.entries[0].trad;
    if (trad && trad !== tok.text) {
      const t = document.createElement('span');
      t.className = 'trad';
      t.textContent = trad;
      head.appendChild(t);
    }
    const btn = document.createElement('button');
    btn.className = 'save' + (isSaved ? ' on' : '');
    btn.textContent = isSaved ? '✓ Saved' : '★ Save';
    btn.addEventListener('click', () => toggleSave(tok));
    head.appendChild(btn);
    card.appendChild(head);

    for (const entry of tok.entries.slice(0, 4)) {
      const div = document.createElement('div');
      div.className = 'entry';
      const p = document.createElement('div');
      p.className = 'epy';
      p.textContent = entry.pinyin;
      const ol = document.createElement('ol');
      for (const d of entry.defs) {
        const li = document.createElement('li');
        li.textContent = d;
        ol.appendChild(li);
      }
      div.append(p, ol);
      card.appendChild(div);
    }
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Click the word or press S to save · Alt+P hides the overlay';
    card.appendChild(hint);

    card.hidden = false;
    const r = el.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    card.style.left = `${Math.min(Math.max(8, r.left + r.width / 2 - cr.width / 2), innerWidth - cr.width - 8)}px`;
    // With the overlay at the top of the video, open the card below the word.
    card.style.top = settings.overlayPosition === 'top'
      ? `${Math.min(innerHeight - cr.height - 8, r.bottom + 10)}px`
      : `${Math.max(8, r.top - cr.height - 10)}px`;
  }

  function scheduleHideCard() {
    clearTimeout(hideCardTimer);
    hideCardTimer = setTimeout(() => hideCard(), 250);
  }

  function hideCard(silent) {
    clearTimeout(hideCardTimer);
    card.hidden = true;
    hovered = null;
    root.querySelectorAll('.w.active').forEach((n) => n.classList.remove('active'));
    if (pausedByUs && !silent) {
      pausedByUs = false;
      video?.play().catch(() => {});
    }
    if (pendingLine && !silent) {
      line = pendingLine;
      pendingLine = null;
      render();
    }
  }

  card.addEventListener('mouseenter', () => clearTimeout(hideCardTimer));
  card.addEventListener('mouseleave', scheduleHideCard);

  async function toggleSave(tok) {
    const { words = {} } = await chrome.storage.local.get('words');
    if (words[tok.text]) {
      delete words[tok.text];
    } else {
      const e = tok.entries[0];
      words[tok.text] = {
        word: tok.text,
        trad: e.trad,
        pinyin: e.pinyin,
        defs: e.defs,
        sentence: line.text,
        title: document.title,
        url: location.href,
        time: Date.now(),
      };
    }
    await chrome.storage.local.set({ words });
    // storage.onChanged re-renders, which reopens the card with the new state.
  }

  // --- settings, messages, keys --------------------------------------------

  function applySettings() {
    if (!settings.ocrEnabled && line.source === 'ocr') line = { text: '', tokens: [], source: null };
    if (!settings.ocrEnabled) {
      ocrPrevMask = { live: null, ahead: null };
      dropClone();
    }
    updateCaptionSelector();
    const enChoice = `${settings.englishAuto}|${settings.englishLang}`;
    if (enChoice !== english.choice) {
      // A different English choice: fetch again.
      english.choice = enChoice;
      english.events = [];
      english.key = '';
      setEnglish('');
    }
    chooseTrack();
    if (enTrack) onEnCueChange(); // the chosen track's current line, right away
    if (!settings.showEnglish) {
      english.events = [];
      english.key = '';
      setEnglish('');
    } else if (english.lastZhUrl && !english.events.length) {
      onResource(english.lastZhUrl);
    }
    readSiteCaptions();
    render();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) settings = { ...globalThis.PL_DEFAULTS, ...changes.settings.newValue };
    if (changes.words) saved = changes.words.newValue || {};
    applySettings();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'line' && video) {
      if (msg.source === 'audio') pacerPush(msg.text);
      else showLine(msg.text, msg.source);
    }
    if (msg.type === 'status') {
      listening = msg.listening;
      if ('info' in msg) statusInfo = msg.info || '';
      if (msg.error) {
        clearTimeout(errorTimer);
        statusError = `⚠ ${msg.error}`;
        errorTimer = setTimeout(() => { statusError = ''; render(); }, 8000);
      }
      if (!listening) {
        statusInfo = '';
        statusError = '';
        pacerReset();
        if (line.source === 'audio') line = { text: '', tokens: [], source: null };
      }
      render();
    }
  });

  addEventListener('keydown', (e) => {
    const t = e.composedPath()[0];
    if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName)) return;
    if (e.altKey && e.code === 'KeyP') {
      e.preventDefault();
      chrome.storage.local.set({ settings: { ...settings, enabled: !settings.enabled } });
    } else if (hovered && e.code === 'KeyS' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      toggleSave(hovered);
    }
  }, true);

  document.addEventListener('fullscreenchange', () => { mount(); render(); });

  (async () => {
    const stored = await chrome.storage.local.get(['settings', 'words']);
    settings = { ...globalThis.PL_DEFAULTS, ...stored.settings };
    english.choice = `${settings.englishAuto}|${settings.englishLang}`;
    watchCaptionRequests();
    saved = stored.words || {};
    updateCaptionSelector();
    pickVideo();
    setInterval(pickVideo, 1000);
    chrome.runtime.sendMessage({ type: 'get-status' }).then((res) => {
      listening = !!res?.listeningHere;
      render();
    }).catch(() => {});
  })();
})();
