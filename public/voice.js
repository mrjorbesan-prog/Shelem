// Voice chat: mic -> 16 kHz -> IMA-ADPCM frames -> socket.io relay -> jitter-buffered playback.
// The mic is NEVER opened automatically. It closes on: user action, tab hidden, disconnect, leaving the room, admin mute, track end.
const Voice = (() => {
  const RATE = 12000, FRAME = 720, HEAD = 2, PACKET = HEAD + FRAME;
  const BIAS = 0x84;
  function lin2ulaw(s) {
    let sign = (s >> 8) & 0x80;
    if (sign) s = -s;
    if (s > 32635) s = 32635;
    s += BIAS;
    let exp = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1);
    return ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff;
  }
  const ULAW = new Float32Array(256);
  for (let k = 0; k < 256; k++) {
    const u = ~k & 0xff, exp = (u >> 4) & 7, t = (((u & 15) << 3) + BIAS) << exp;
    ULAW[k] = (u & 0x80 ? BIAS - t : t - BIAS) / 32768;
  }
  function encodeFrame(pcm, seq) {
    const out = new Uint8Array(PACKET);
    out[0] = seq & 255; out[1] = (seq >> 8) & 255;
    for (let n = 0; n < FRAME; n++) out[HEAD + n] = lin2ulaw(pcm[n]);
    return out;
  }
  function decodeFrame(buf) {
    if (!buf || buf.length !== PACKET) return null;
    const pcm = new Float32Array(FRAME);
    for (let n = 0; n < FRAME; n++) pcm[n] = ULAW[buf[HEAD + n]];
    return { seq: buf[0] | (buf[1] << 8), pcm };
  }

  let socket = null, toast = () => {}, onChange = () => {}, getMySeat = () => -1;
  let vctx = null, stream = null, srcNode = null, procNode = null, silentGain = null, wake = null;
  let deaf = false, open = false, opening = false, forced = false, loop = false, sending = false, gen = 0, workletReady = false;
  const speakers = new Map();      // seat -> { next, seq, last, gain }
  const muted = new Set();         // player names muted locally
  let seq = 0, noise = null, hang = 0, prev = [], lvl = 0;
  let acc = new Float32Array(FRAME), accN = 0, nextOut = 0, prevX = 0, lp1 = null, lp2 = null;
  let duckOn = false;

  function ensureCtx() {
    if (!vctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; vctx = new AC({ latencyHint: 'interactive' }); }
    if (vctx.state === 'suspended') vctx.resume().catch(() => {});
    return vctx;
  }
  ['pointerdown', 'touchend', 'keydown'].forEach((ev) => document.addEventListener(ev, ensureCtx, { passive: true }));

  function anyRemote() { const t = performance.now(); let a = false; speakers.forEach((s) => { if (t - s.last < 350) a = true; }); return a; }
  function updateDuck() {
    const want = open || opening || anyRemote();
    if (want !== duckOn) { duckOn = want; if (typeof Sfx !== 'undefined') Sfx.duck(want); }
  }
  function setSending(v) { if (sending !== v) { sending = v; onChange(); } }

  function feed(chunk, sr) {
    const ratio = sr / RATE;
    for (let k = 0; k < chunk.length; k++) {
      const x = chunk[k];
      while (nextOut <= 0) {
        acc[accN++] = prevX + (x - prevX) * (nextOut + 1);
        nextOut += ratio;
        if (accN === FRAME) { frame(acc); accN = 0; }
      }
      nextOut -= 1; prevX = x;
    }
  }
  function frame(f) {
    let e = 0;
    const pcm = new Int16Array(FRAME);
    for (let n = 0; n < FRAME; n++) { const v = f[n] < -1 ? -1 : f[n] > 1 ? 1 : f[n]; e += v * v; pcm[n] = Math.round(v * 32767); }
    const rms = Math.sqrt(e / FRAME);
    lvl = rms;
    noise = noise === null ? rms : rms < noise ? rms : Math.min(0.05, noise * 1.0015 + 1e-5);
    const speech = rms > Math.max(0.015, noise * 2.8);
    if (speech) hang = 6; else if (hang > 0) hang--;
    seq = (seq + 1) & 0xffff;
    const pkt = encodeFrame(pcm, seq);
    if (!open || forced) return;
    if (hang > 0) {
      if (!sending) { prev.forEach((q) => socket.volatile.emit('voice', q)); setSending(true); }
      socket.volatile.emit('voice', pkt);
      prev = [];
    } else {
      prev.push(pkt); if (prev.length > 2) prev.shift();
      setSending(false);                       // silence is never transmitted
    }
  }

  async function openMic() {
    if (open || opening) return;
    if (forced) { toast('مدیر میکروفون شما را بسته است'); return; }
    if (!socket || !socket.connected) { toast('اتصال برقرار نیست'); return; }
    if (/Telegram|Instagram|FBAN|FBAV|Line\//i.test(navigator.userAgent)) { toast('برای میکروفون، لینک را با Chrome یا Safari باز کنید'); return; }
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('این مرورگر یا آدرس از میکروفون پشتیبانی نمی‌کند'); return; }
    opening = true; const my = ++gen; updateDuck(); onChange();
    try {
      const ctx = ensureCtx();
      if (!ctx) throw new Error('noaudio');
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 } });
      if (my !== gen) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      s.getAudioTracks()[0].addEventListener('ended', () => { if (stream === s) { closeMic(); toast('میکروفون قطع شد'); } });
      if (ctx.state === 'suspended') await ctx.resume();
      srcNode = ctx.createMediaStreamSource(s);
      silentGain = ctx.createGain(); silentGain.gain.value = 0; silentGain.connect(ctx.destination);
      let ok = false;
      if (ctx.audioWorklet && window.AudioWorkletNode) {
        try {
          if (!workletReady) {
            const code = "class P extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(1024);this.n=0}process(i){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];if(this.n===1024){this.port.postMessage(this.b.slice(0));this.n=0}}}return true}}registerProcessor('shelem-mic',P)";
            await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
            workletReady = true;
          }
          procNode = new AudioWorkletNode(ctx, 'shelem-mic');
          procNode.port.onmessage = (ev) => { if (stream === s) feed(ev.data, ctx.sampleRate); };
          ok = true;
        } catch (e) { procNode = null; }
      }
      if (!ok) {
        procNode = ctx.createScriptProcessor(2048, 1, 1);
        procNode.onaudioprocess = (ev) => { if (stream === s) feed(new Float32Array(ev.inputBuffer.getChannelData(0)), ctx.sampleRate); };
      }
      lp1 = ctx.createBiquadFilter(); lp1.type = 'lowpass'; lp1.frequency.value = 5200; lp1.Q.value = 0.707;
      lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 5200; lp2.Q.value = 0.707;
      srcNode.connect(lp1); lp1.connect(lp2); lp2.connect(procNode); procNode.connect(silentGain);
      if (my !== gen) { closeMic(); return; }
      noise = null; hang = 0; prev = []; accN = 0; nextOut = 0; prevX = 0;
      open = true;
      socket.emit('voiceState', { on: true });
      try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) { wake = null; }
    } catch (e) {
      stopNodes();
      const n = e && e.name;
      if (n === 'NotAllowedError' || n === 'SecurityError') {
        let st = 'denied';
        try { if (navigator.permissions) st = (await navigator.permissions.query({ name: 'microphone' })).state; } catch (err) { /* unsupported */ }
        if (st === 'prompt') toast('برای استفاده از ویس چت، در پنجره مرورگر «اجازه» را بزنید و دوباره روی میکروفون بزنید');
        else toast('میکروفون برای این سایت مسدود است. روی 🔒 کنار آدرس بزنید ← دسترسی‌ها (Permissions) ← میکروفون را «اجازه» کنید و دوباره امتحان کنید', 9000);
      } else toast(n === 'NotFoundError' ? 'میکروفونی پیدا نشد' : 'میکروفون باز نشد');
    } finally {
      opening = false; onChange();
    }
  }
  function stopNodes() {
    try { if (procNode) { procNode.onaudioprocess = null; if (procNode.port) procNode.port.onmessage = null; procNode.disconnect(); } } catch (e) { /* ignore */ }
    try { if (srcNode) srcNode.disconnect(); if (lp1) lp1.disconnect(); if (lp2) lp2.disconnect(); } catch (e) { /* ignore */ }
    lp1 = lp2 = null;
    try { if (silentGain) silentGain.disconnect(); } catch (e) { /* ignore */ }
    procNode = srcNode = silentGain = null;
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (wake) { wake.release().catch(() => {}); wake = null; }
  }
  function closeMic() {
    gen++;                                   // cancels any pending open
    const was = open;
    open = false; opening = false; sending = false; loop = false; prev = [];
    stopNodes(); updateDuck();
    if (socket && socket.connected && was) socket.emit('voiceState', { on: false });
    if (socket && socket.connected) socket.emit('voiceLoop', { on: false });
    onChange();
  }

  function play(seat, d) {
    if (!vctx || vctx.state === 'closed') return;
    if (deaf) return;
    if (seat === getMySeat() && !loop) return;
    const name = names[seat];
    if (name && muted.has(name)) return;
    if (vctx.state === 'suspended') vctx.resume().catch(() => {});
    const dec = decodeFrame(d instanceof Uint8Array ? d : new Uint8Array(d));
    if (!dec) return;
    let sp = speakers.get(seat);
    if (!sp) {
      const gain = vctx.createGain(), lp = vctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 5600; lp.Q.value = 0.707;
      gain.connect(lp); lp.connect(vctx.destination);
      sp = { next: 0, seq: -1, last: 0, gain, tail: 0 };
      speakers.set(seat, sp);
    }
    if (sp.seq >= 0) { const diff = (dec.seq - sp.seq) & 0xffff; if (diff === 0 || diff > 32768) return; }
    sp.seq = dec.seq; sp.last = performance.now();
    const sr = vctx.sampleRate, ratio = sr / RATE, outLen = Math.round(FRAME * ratio);
    const now = vctx.currentTime;
    if (sp.next < now + 0.02) { sp.next = now + 0.15; sp.tail = dec.pcm[0]; }   // new talk-spurt: 150 ms jitter buffer
    else if (sp.next - now > 0.5) return;                                         // backlog: drop to keep latency low
    const out = new Float32Array(outLen), x = dec.pcm;
    let prev = sp.tail;
    for (let k = 0; k < outLen; k++) {
      const t = k / ratio, i = t | 0, f = t - i;
      const a = i === 0 ? prev : x[i - 1];
      out[k] = a + (x[i] - a) * f;
    }
    sp.tail = x[FRAME - 1];
    const buf = vctx.createBuffer(1, outLen, sr);
    buf.copyToChannel(out, 0);
    const src = vctx.createBufferSource();
    src.buffer = buf; src.connect(sp.gain); src.start(sp.next);
    sp.next += outLen / sr;
  }

  let names = {};
  return {
    init(opts) {
      socket = opts.socket; toast = opts.toast; onChange = opts.onChange; getMySeat = opts.getMySeat;
      socket.on('voice', (m) => { try { play(m.seat, m.d); } catch (e) { /* ignore */ } });
      socket.on('disconnect', () => closeMic());
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && (open || opening)) { closeMic(); toast('میکروفون بسته شد چون صفحه در پس‌زمینه رفت'); } });
      window.addEventListener('pagehide', () => closeMic());
      setInterval(() => { updateDuck(); onChange('tick'); }, 150);
    },
    open: openMic,
    close: closeMic,
    status: () => ({ deaf, open, opening, sending, forced, loop, level: lvl }),
    isTalking: (seat) => { const s = speakers.get(seat); return Boolean(s) && performance.now() - s.last < 350; },
    setNames(list) { names = {}; list.forEach((p) => { names[p.seat] = p.name; }); },
    setForced(v) { if (v && !forced) { closeMic(); } forced = v; onChange(); },
    toggleMute(name) { if (muted.has(name)) muted.delete(name); else muted.add(name); return muted.has(name); },
    isMuted: (name) => muted.has(name),
    setDeaf(v) { deaf = Boolean(v); onChange(); },
    setLoop(v) { loop = Boolean(v) && open; if (socket && socket.connected) socket.emit('voiceLoop', { on: loop }); onChange(); },
    _codec: { encodeFrame, decodeFrame, FRAME, PACKET },
  };
})();
