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
      .w { pointer-events: auto; display: inline-flex; flex-direction: column; align-items: center;
        cursor: pointer; padding: 2px 3px; border-radius: 6px; }
      .w:hover, .w.active { background: rgba(255,255,255,.18); }
      .w.saved .hz { text-decoration: underline 2px #ffd34d; text-underline-offset: 5px; }
      .py { font: 500 0.5em/1.2 system-ui, sans-serif; opacity: .95; white-space: nowrap; }
      .hz { line-height: 1.25; white-space: nowrap; }
      .gl { font: 0.36em/1.2 system-ui, sans-serif; opacity: .8; max-width: 9em; white-space: nowrap;
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
    <div class="card" hidden></div>`;
  const wrap = root.querySelector('.wrap');
  const badge = root.querySelector('.badge');
  const bar = root.querySelector('.bar');
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
      w.className = 'w' + (saved[tok.text] ? ' saved' : '');
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
      if (settings.showPinyin) w.appendChild(py);
      w.appendChild(hz);
      if (settings.showGloss) {
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

  function position() {
    if (!video || host.style.display === 'none') return;
    const r = video.getBoundingClientRect();
    // Inside a fullscreen element "fixed" is still relative to the viewport.
    wrap.style.left = `${r.left}px`;
    wrap.style.width = `${r.width}px`;
    wrap.style.top = 'auto';
    wrap.style.bottom = `${Math.max(0, innerHeight - r.bottom) + r.height * 0.1}px`;
  }

  (function loop() {
    if (line.tokens.length || listening || statusError || statusInfo) position();
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
    card.style.top = `${Math.max(8, r.top - cr.height - 10)}px`;
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
    updateCaptionSelector();
    if (track) applyTrackMode();
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
    if (msg.type === 'line' && video) showLine(msg.text, msg.source);
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
