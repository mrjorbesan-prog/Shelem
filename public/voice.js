// Voice chat (no external deps): mic -> 16kHz mono -> IMA-ADPCM (~65kbps) -> socket.io relay -> jitter-buffered WebAudio playback.
// Silence is never sent (VAD with pre-roll/hangover). Mic button: hold = push-to-talk, quick click = latch open/closed.
const Voice = (() => {
  'use strict';
  const RATE = 16000, FRAME = 640 /* 40ms */, PRE = 4, HANG = 10, JIT = 0.12, HOLD_MS = 350, IDLE_RELEASE_MS = 12000, SILENT_CLOSE_MS = 120000;
  const $ = (id) => document.getElementById(id);
  const say = (m) => { try { if (typeof toast === 'function') toast(m); } catch (e) { /* ignore */ } };
  const store = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch (e) { return d; } };

  /* ---------- IMA ADPCM ---------- */
  const IDX = [-1, -1, -1, -1, 2, 4, 6, 8];
  const STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
  const enc = { pred: 0, idx: 0 };
  function encode(f, flags) {
    const out = new Uint8Array(4 + (f.length >> 1));
    out[0] = flags; out[1] = enc.pred & 255; out[2] = (enc.pred >> 8) & 255; out[3] = enc.idx;
    let pred = enc.pred, idx = enc.idx;
    for (let i = 0; i < f.length; i++) {
      let v = Math.round(f[i] * 32767); if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      let step = STEP[idx], diff = v - pred, code = 0;
      if (diff < 0) { code = 8; diff = -diff; }
      let dq = step >> 3;
      if (diff >= step) { code |= 4; diff -= step; dq += step; }
      step >>= 1;
      if (diff >= step) { code |= 2; diff -= step; dq += step; }
      step >>= 1;
      if (diff >= step) { code |= 1; dq += step; }
      pred += (code & 8) ? -dq : dq; if (pred > 32767) pred = 32767; else if (pred < -32768) pred = -32768;
      idx += IDX[code & 7]; if (idx < 0) idx = 0; else if (idx > 88) idx = 88;
      if (i & 1) out[4 + (i >> 1)] |= code << 4; else out[4 + (i >> 1)] = code;
    }
    enc.pred = pred; enc.idx = idx;
    return out;
  }
  function decode(u8) {
    const n = (u8.length - 4) * 2, out = new Float32Array(n);
    let pred = ((u8[1] | (u8[2] << 8)) << 16) >> 16, idx = u8[3] > 88 ? 88 : u8[3];
    for (let i = 0; i < n; i++) {
      const b = u8[4 + (i >> 1)], code = (i & 1) ? (b >> 4) : (b & 15), step = STEP[idx];
      let dq = step >> 3;
      if (code & 4) dq += step; if (code & 2) dq += step >> 1; if (code & 1) dq += step >> 2;
      pred += (code & 8) ? -dq : dq; if (pred > 32767) pred = 32767; else if (pred < -32768) pred = -32768;
      idx += IDX[code & 7]; if (idx < 0) idx = 0; else if (idx > 88) idx = 88;
      out[i] = pred / 32768;
    }
    return out;
  }

  /* ---------- Downsampler (shared by worklet and fallback) ---------- */
  const DOWN_SRC = 'function Down(rate, frame) { this.step = rate / 16000; this.pos = 0; this.prev = 0; this.frame = frame; this.n = 0; this.buf = new Float32Array(frame); }'
    + 'Down.prototype.push = function (inp, emit) { var len = inp.length; if (!len) return; var p = this.pos, prev = this.prev;'
    + ' while (p < len - 1) { var i = Math.floor(p), f = p - i, a = i < 0 ? prev : inp[i], b = inp[i + 1]; this.buf[this.n++] = a + (b - a) * f;'
    + ' if (this.n === this.frame) { var out = this.buf; this.buf = new Float32Array(this.frame); this.n = 0; emit(out); } p += this.step; }'
    + ' this.pos = p - len; this.prev = inp[len - 1]; };';
  const Down = new Function(DOWN_SRC + '; return Down;')();
  const WORKLET_SRC = DOWN_SRC + 'class MicProc extends AudioWorkletProcessor { constructor() { super(); this.d = new Down(sampleRate, ' + FRAME + '); this.e = (f) => this.port.postMessage(f, [f.buffer]); }'
    + ' process(i) { var c = i[0] && i[0][0]; if (c) this.d.push(c, this.e); return true; } } registerProcessor("shelem-mic", MicProc);';

  /* ---------- state ---------- */
  let ctx = null, outGain = null, workletCtx = null, workletBad = false;
  let inRoom = false, mySeat = -1, names = {};
  let deaf = !store('shelem_voice_out', true);
  const spk = {}; // seat -> {gain, next, until}
  // mic
  let gen = 0, hinted = false, heldBy = '', want = false, held = false, latched = false, wasLatched = false, pressT = 0, acquiring = false;
  let stream = null, nodes = [], ready = false, idleT = null, framesIn = 0;
  // vad / sender
  let floor = 0.004, hot = 0, hang = 0, sending = false, ring = [], pending = null, firstFlag = false, lastVoiceAt = 0;
  let timer = null, lastDuck = false, lastActive = 0, pillKey = '';

  const micBtn = $('micBtn'), spkBtn = $('spkBtn'), pills = $('voiceSpeak');

  /* ---------- audio context ---------- */
  function ensureCtx() {
    if (!inRoom) return null;
    if (ctx && ctx.state === 'closed') { ctx = null; outGain = null; }
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { return null; }
      const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 4; comp.knee.value = 12;
      outGain = ctx.createGain(); outGain.gain.value = 0.95;
      outGain.connect(comp); comp.connect(ctx.destination);
      for (const k of Object.keys(spk)) delete spk[k];
    }
    if (ctx.state !== 'running') { try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ } }
    return ctx;
  }
  ['pointerdown', 'keydown', 'touchend'].forEach((ev) => document.addEventListener(ev, () => { if (inRoom) ensureCtx(); }, { passive: true }));

  /* ---------- playback ---------- */
  function speaker(seat) {
    let s = spk[seat];
    if (!s) { const g = ctx.createGain(); g.connect(outGain); s = spk[seat] = { gain: g, next: 0, until: 0 }; }
    return s;
  }
  function onVoice(seat, raw) {
    if (!inRoom || deaf || !ctx || !outGain || ctx.state !== 'running') return;
    if (!(seat >= 0 && seat <= 3) || seat === mySeat) return;
    const u8 = raw instanceof ArrayBuffer ? new Uint8Array(raw) : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : null;
    if (!u8 || u8.length < 5 || u8.length > 1200) return;
    const pcm = decode(u8);
    const sp = speaker(seat), now = ctx.currentTime;
    if (sp.next < now + 0.02) sp.next = now + ((u8[0] & 1) ? JIT : 0.07); // new burst / underrun: rebuild jitter buffer
    else if (sp.next - now > 0.6) return; // backlog (network burst): drop instead of overlapping
    try {
      const ab = ctx.createBuffer(1, pcm.length, RATE);
      if (ab.copyToChannel) ab.copyToChannel(pcm, 0); else ab.getChannelData(0).set(pcm);
      const src = ctx.createBufferSource(); src.buffer = ab; src.connect(sp.gain);
      src.start(sp.next); sp.next += pcm.length / RATE; sp.until = sp.next;
    } catch (e) { return; }
    kick();
  }

  /* ---------- sender ---------- */
  function sendPkt(f, flags) {
    if (!socket.connected) return;
    try { socket.volatile.emit('voice', encode(f, flags)); } catch (e) { /* ignore */ }
  }
  function emitFrame(f) {
    if (pending) { sendPkt(pending, firstFlag ? 1 : 0); firstFlag = false; } else { firstFlag = true; for (let i = 0; i < 96 && i < f.length; i++) f[i] *= i / 96; }
    pending = f;
  }
  function endBurst() {
    if (pending) {
      const n = pending.length; for (let i = 0; i < 96; i++) pending[n - 1 - i] *= i / 96;
      sendPkt(pending, (firstFlag ? 1 : 0) | 2);
    }
    pending = null; firstFlag = false; sending = false; hot = 0; hang = 0; ring = [];
  }
  function onFrame(f) {
    if (!want || !ready) return;
    if (++framesIn <= 1) return; // device warm-up / button-click transient
    let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i];
    const rms = Math.sqrt(s / f.length), now = performance.now();
    const thr = Math.max(0.012, floor * 3);
    if (!sending) {
      floor = Math.max(0.002, rms < floor ? floor * 0.9 + rms * 0.1 : floor * 0.995 + rms * 0.005);
      ring.push(f); if (ring.length > PRE) ring.shift();
      hot = rms > thr ? hot + 1 : 0;
      if (hot >= 2) {
        sending = true; hang = 0; enc.pred = 0; enc.idx = 0; pending = null; lastVoiceAt = now;
        const r = ring; ring = []; for (const x of r) emitFrame(x);
        kick(); paint();
      }
    } else {
      emitFrame(f);
      if (rms > thr) { hang = 0; lastVoiceAt = now; } else if (++hang >= HANG) { endBurst(); paint(); }
    }
  }

  /* ---------- microphone lifecycle ---------- */
  function teardownMic() {
    clearTimeout(idleT); idleT = null;
    for (const n of nodes) { try { n.disconnect(); } catch (e) { /* ignore */ } if (n.port) n.port.onmessage = null; if ('onaudioprocess' in n) n.onaudioprocess = null; }
    nodes = [];
    if (stream) { stream.getTracks().forEach((t) => { t.onended = null; try { t.stop(); } catch (e) { /* ignore */ } }); stream = null; }
    ready = false;
  }
  function fail(msg) { want = false; held = false; latched = false; acquiring = false; teardownMic(); say(msg); paint(); }
  async function buildGraph(c, st) {
    const src = c.createMediaStreamSource(st);
    const lp1 = c.createBiquadFilter(), lp2 = c.createBiquadFilter();
    lp1.type = lp2.type = 'lowpass'; lp1.frequency.value = lp2.frequency.value = 6800; lp1.Q.value = lp2.Q.value = 0.707;
    const sink = c.createGain(); sink.gain.value = 0; sink.connect(c.destination);
    let proc = null;
    if (c.audioWorklet && typeof AudioWorkletNode === 'function' && !workletBad) {
      try {
        if (workletCtx !== c) { const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' })); try { await c.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); } workletCtx = c; }
        proc = new AudioWorkletNode(c, 'shelem-mic', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        proc.port.onmessage = (e) => onFrame(e.data);
      } catch (e) { workletBad = true; proc = null; }
    }
    if (!proc) {
      proc = c.createScriptProcessor(2048, 1, 1);
      const d = new Down(c.sampleRate, FRAME);
      proc.onaudioprocess = (e) => d.push(e.inputBuffer.getChannelData(0), onFrame);
    }
    src.connect(lp1); lp1.connect(lp2); lp2.connect(proc); proc.connect(sink);
    nodes = [src, lp1, lp2, proc, sink];
  }
  async function acquire() {
    if (acquiring) return;
    acquiring = true; paint();
    const my = gen;
    try {
      if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return fail('میکروفون فقط روی آدرس HTTPS کار می‌کند');
      const c = ensureCtx();
      if (!c) return fail('مرورگر شما از ویس چت پشتیبانی نمی‌کند');
      let st;
      try { st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false }); } catch (e) {
        return fail(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'دسترسی میکروفون داده نشد' : e && e.name === 'NotFoundError' ? 'میکروفونی پیدا نشد' : 'میکروفون در دسترس نیست');
      }
      if (my !== gen || !inRoom || !ctx) { st.getTracks().forEach((t) => t.stop()); acquiring = false; paint(); return; }
      stream = st;
      const tr = st.getAudioTracks()[0];
      if (tr) tr.onended = () => { if (stream === st) { teardownMic(); if (want) { closeGate(); held = false; latched = false; say('میکروفون قطع شد'); } paint(); } };
      await buildGraph(ctx, st);
      if (my !== gen || stream !== st) { if (stream === st) teardownMic(); return; } // stopped while building
      acquiring = false; ready = true; framesIn = 0; lastVoiceAt = performance.now();
      if (want) { if (typeof Sfx !== 'undefined') Sfx.play('pop'); } else scheduleIdle();
      paint(); kick();
    } catch (e) { fail('خطا در راه‌اندازی میکروفون'); } finally { acquiring = false; }
  }
  function scheduleIdle() { clearTimeout(idleT); idleT = setTimeout(() => { if (!want) { teardownMic(); paint(); } }, IDLE_RELEASE_MS); }
  function setWant(v) {
    if (v === want) return;
    const was = want;
    want = v;
    if (v) { clearTimeout(idleT); framesIn = 0; lastVoiceAt = performance.now(); if (ready) { if (typeof Sfx !== 'undefined') Sfx.play('pop'); kick(); } else acquire(); }
    else closeGate(was);
    paint();
  }
  function closeGate(was = want) {
    want = false;
    if (sending) endBurst();
    ring = []; hot = 0; hang = 0; pending = null; sending = false;
    if (ready) scheduleIdle();
    if (was && typeof Sfx !== 'undefined') Sfx.play('tick');
    paint();
  }
  // full stop: used for leaving the room, disconnects, hidden tab, etc.
  function stopAll(msg) {
    const was = want;
    gen++; held = false; latched = false; want = false; acquiring = false;
    if (sending) endBurst();
    ring = []; hot = 0; hang = 0; pending = null; sending = false;
    teardownMic();
    if (was && msg) say(msg);
    paint();
  }

  /* ---------- button logic: hold = push-to-talk, quick click = latch ---------- */
  function press(by) {
    if (held || !inRoom) return;
    held = true; heldBy = by; pressT = performance.now(); wasLatched = latched;
    if (!latched) setWant(true);
    paint();
  }
  function release() {
    if (!held) return;
    held = false;
    const dur = performance.now() - pressT;
    if (wasLatched) { latched = false; setWant(false); }
    else if (dur < HOLD_MS && want) latched = true;
    else { latched = false; setWant(false); }
    paint();
  }
  micBtn.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    try { micBtn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    press('ptr');
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => micBtn.addEventListener(ev, (e) => { e.preventDefault(); if (heldBy === 'ptr') release(); }));
  micBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  micBtn.addEventListener('click', (e) => e.preventDefault());
  const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  document.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const onBtn = e.target === micBtn && (e.code === 'Space' || e.code === 'Enter');
    if (!onBtn && !(e.code === 'KeyV' && !typing(e.target))) return;
    e.preventDefault(); press('key');
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'KeyV' || e.code === 'Space' || e.code === 'Enter') { if (held && heldBy === 'key') { e.preventDefault(); release(); } }
  });
  window.addEventListener('blur', () => { if (held && !latched && !wasLatched) release(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') stopAll(want ? 'میکروفون بسته شد' : ''); });
  window.addEventListener('pagehide', () => stopAll(''));

  spkBtn.addEventListener('click', () => {
    deaf = !deaf;
    try { localStorage.setItem('shelem_voice_out', deaf ? '0' : '1'); } catch (e) { /* ignore */ }
    if (socket.connected) socket.emit('voiceDeaf', deaf);
    if (deaf) for (const k of Object.keys(spk)) { spk[k].until = 0; try { spk[k].gain.disconnect(); } catch (e) { /* ignore */ } delete spk[k]; }
    paint();
  });

  /* ---------- UI / ducking tick ---------- */
  function paint() {
    micBtn.classList.toggle('hidden', !inRoom); spkBtn.classList.toggle('hidden', !inRoom);
    const open = want && ready;
    micBtn.classList.toggle('live', open && !sending);
    micBtn.classList.toggle('talking', open && sending);
    micBtn.classList.toggle('pending', want && !ready);
    micBtn.classList.toggle('warm', ready && !want);
    micBtn.setAttribute('aria-pressed', want ? 'true' : 'false');
    spkBtn.classList.toggle('off', deaf);
    spkBtn.setAttribute('aria-pressed', deaf ? 'false' : 'true');
  }
  function tick() {
    const now = ctx ? ctx.currentTime : 0, active = [];
    for (const k of Object.keys(spk)) if (spk[k].until > now) active.push(Number(k));
    const t = performance.now();
    if (active.length) lastActive = t;
    const duckOn = active.length > 0 || sending || t - lastActive < 350;
    if (duckOn !== lastDuck) { lastDuck = duckOn; if (typeof Sfx !== 'undefined') Sfx.duck(duckOn); }
    const list = active.map((s) => ({ k: 's' + s, n: names[s] || 'بازیکن', me: false }));
    if (sending) list.push({ k: 'me', n: 'شما', me: true });
    const key = list.map((x) => x.k).join(',');
    if (key !== pillKey) {
      pillKey = key; pills.textContent = '';
      for (const x of list) { const el = document.createElement('span'); if (x.me) el.className = 'me'; el.textContent = (x.me ? '🔴 ' : '🎙 ') + x.n; pills.appendChild(el); }
    }
    if (want && latched && !held && t - lastVoiceAt > SILENT_CLOSE_MS) { latched = false; setWant(false); say('میکروفون به‌دلیل سکوت طولانی بسته شد'); }
    if (!active.length && !sending && !want && !duckOn && !pillKey) { clearInterval(timer); timer = null; }
  }
  function kick() { if (!timer) timer = setInterval(tick, 100); }

  /* ---------- socket wiring ---------- */
  socket.on('voice', onVoice);
  socket.on('state', (st) => {
    names = {}; for (const p of st.players || []) names[p.seat] = p.name;
    mySeat = st.mySeat;
    const was = inRoom; inRoom = st.mySeat >= 0;
    if (!inRoom) { reset(); return; }
    if (!was) { if (socket.connected) socket.emit('voiceDeaf', deaf); if (!hinted) { hinted = true; say('برای صحبت، دکمه 🎤 را نگه دارید یا روی آن کلیک کنید'); } }
    paint();
  });
  function reset() {
    inRoom = false; mySeat = -1; stopAll('');
    for (const k of Object.keys(spk)) { try { spk[k].gain.disconnect(); } catch (e) { /* ignore */ } delete spk[k]; }
    pills.textContent = ''; pillKey = ''; lastDuck = false;
    if (typeof Sfx !== 'undefined') Sfx.duck(false);
    paint();
  }
  socket.on('leftRoom', reset);
  socket.on('kicked', reset);
  socket.on('disconnect', () => { stopAll(want ? 'اتصال قطع شد؛ میکروفون بسته شد' : ''); });
  socket.on('connect', () => { if (inRoom) socket.emit('voiceDeaf', deaf); });
  paint();

  return { _t: { encode, decode, Down, enc } };
})();
