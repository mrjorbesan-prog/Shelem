// Voice chat: mic -> 16 kHz -> IMA-ADPCM frames -> socket.io relay -> jitter-buffered playback.
// The mic is NEVER opened automatically. It closes on: user action, tab hidden, disconnect, leaving the room, admin mute, track end.
const Voice = (() => {
  const RATE = 16000, FRAME = 960, HEAD = 5, PACKET = HEAD + FRAME / 2;
  const STEP = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
  const IDX = [-1, -1, -1, -1, 2, 4, 6, 8];
  const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

  function encodeFrame(pcm, st, seq) {
    const out = new Uint8Array(PACKET);
    out[0] = seq & 255; out[1] = (seq >> 8) & 255;
    out[2] = st.p & 255; out[3] = (st.p >> 8) & 255; out[4] = st.i;
    let p = st.p, i = st.i;
    for (let n = 0; n < FRAME; n++) {
      let step = STEP[i], diff = pcm[n] - p, code = 0;
      if (diff < 0) { code = 8; diff = -diff; }
      let vp = step >> 3;
      if (diff >= step) { code |= 4; diff -= step; vp += step; }
      step >>= 1; if (diff >= step) { code |= 2; diff -= step; vp += step; }
      step >>= 1; if (diff >= step) { code |= 1; vp += step; }
      p = clamp16(code & 8 ? p - vp : p + vp);
      i += IDX[code & 7]; i = i < 0 ? 0 : i > 88 ? 88 : i;
      const k = HEAD + (n >> 1);
      if (n & 1) out[k] |= code << 4; else out[k] = code;
    }
    st.p = p; st.i = i;
    return out;
  }
  function decodeFrame(buf) {
    if (!buf || buf.length !== PACKET) return null;
    let p = (buf[2] | (buf[3] << 8)) << 16 >> 16, i = buf[4];
    if (i > 88) return null;
    const seq = buf[0] | (buf[1] << 8), pcm = new Float32Array(FRAME);
    for (let n = 0; n < FRAME; n++) {
      const b = buf[HEAD + (n >> 1)], code = n & 1 ? b >> 4 : b & 15;
      const step = STEP[i];
      let vp = step >> 3;
      if (code & 4) vp += step; if (code & 2) vp += step >> 1; if (code & 1) vp += step >> 2;
      p = clamp16(code & 8 ? p - vp : p + vp);
      i += IDX[code & 7]; i = i < 0 ? 0 : i > 88 ? 88 : i;
      pcm[n] = p / 32768;
    }
    return { seq, pcm };
  }

  let socket = null, toast = () => {}, onChange = () => {}, getMySeat = () => -1;
  let vctx = null, stream = null, srcNode = null, procNode = null, silentGain = null, wake = null;
  let open = false, opening = false, forced = false, loop = false, sending = false, gen = 0, workletReady = false;
  const speakers = new Map();      // seat -> { next, seq, last, gain }
  const muted = new Set();         // player names muted locally
  let enc = { p: 0, i: 0 }, seq = 0, noise = null, hang = 0, prev = [], lvl = 0;
  let acc = new Float32Array(FRAME), accN = 0, ph = 0, sum = 0, cnt = 0;

  function ensureCtx() {
    if (!vctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; vctx = new AC({ latencyHint: 'interactive' }); }
    if (vctx.state === 'suspended') vctx.resume().catch(() => {});
    return vctx;
  }
  ['pointerdown', 'touchend', 'keydown'].forEach((ev) => document.addEventListener(ev, ensureCtx, { passive: true }));

  function setSending(v) { if (sending !== v) { sending = v; onChange(); } }

  function feed(chunk, sr) {
    const ratio = sr / RATE;
    for (let k = 0; k < chunk.length; k++) {
      sum += chunk[k]; cnt++; ph += 1;
      if (ph >= ratio) {
        acc[accN++] = sum / cnt; sum = 0; cnt = 0; ph -= ratio;
        if (accN === FRAME) { frame(acc); accN = 0; }
      }
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
    if (speech) hang = 7; else if (hang > 0) hang--;
    seq = (seq + 1) & 0xffff;
    const pkt = encodeFrame(pcm, enc, seq);   // always encode so decoder state stays continuous
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
    opening = true; const my = ++gen; onChange();
    try {
      const ctx = ensureCtx();
      if (!ctx) throw new Error('noaudio');
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
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
      srcNode.connect(procNode); procNode.connect(silentGain);
      if (my !== gen) { closeMic(); return; }
      enc = { p: 0, i: 0 }; noise = null; hang = 0; prev = []; accN = 0; ph = 0; sum = 0; cnt = 0;
      open = true;
      socket.emit('voiceState', { on: true });
      try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) { wake = null; }
    } catch (e) {
      stopNodes();
      const n = e && e.name;
      toast(n === 'NotAllowedError' || n === 'SecurityError' ? 'اجازه میکروفون داده نشد؛ از تنظیمات مرورگر فعالش کنید' : n === 'NotFoundError' ? 'میکروفونی پیدا نشد' : 'میکروفون باز نشد');
    } finally {
      opening = false; onChange();
    }
  }
  function stopNodes() {
    try { if (procNode) { procNode.onaudioprocess = null; if (procNode.port) procNode.port.onmessage = null; procNode.disconnect(); } } catch (e) { /* ignore */ }
    try { if (srcNode) srcNode.disconnect(); } catch (e) { /* ignore */ }
    try { if (silentGain) silentGain.disconnect(); } catch (e) { /* ignore */ }
    procNode = srcNode = silentGain = null;
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (wake) { wake.release().catch(() => {}); wake = null; }
  }
  function closeMic() {
    gen++;                                   // cancels any pending open
    const was = open;
    open = false; opening = false; sending = false; loop = false; prev = [];
    stopNodes();
    if (socket && socket.connected && was) socket.emit('voiceState', { on: false });
    if (socket && socket.connected) socket.emit('voiceLoop', { on: false });
    onChange();
  }

  function play(seat, d) {
    if (!vctx || vctx.state === 'closed') return;
    if (seat === getMySeat() && !loop) return;
    const name = names[seat];
    if (name && muted.has(name)) return;
    if (vctx.state === 'suspended') vctx.resume().catch(() => {});
    const dec = decodeFrame(d instanceof Uint8Array ? d : new Uint8Array(d));
    if (!dec) return;
    let sp = speakers.get(seat);
    if (!sp) { sp = { next: 0, seq: -1, last: 0, gain: vctx.createGain() }; sp.gain.connect(vctx.destination); speakers.set(seat, sp); }
    if (sp.seq >= 0) { const diff = (dec.seq - sp.seq) & 0xffff; if (diff === 0 || diff > 32768) return; }
    sp.seq = dec.seq; sp.last = performance.now();
    const now = vctx.currentTime;
    if (sp.next < now + 0.02) sp.next = now + 0.12;       // (re)start talk-spurt with 120 ms jitter buffer
    else if (sp.next - now > 0.45) return;                  // too much backlog: drop to keep latency low
    const buf = vctx.createBuffer(1, FRAME, RATE);
    buf.copyToChannel(dec.pcm, 0);
    const src = vctx.createBufferSource();
    src.buffer = buf; src.connect(sp.gain); src.start(sp.next);
    sp.next += FRAME / RATE;
  }

  let names = {};
  return {
    init(opts) {
      socket = opts.socket; toast = opts.toast; onChange = opts.onChange; getMySeat = opts.getMySeat;
      socket.on('voice', (m) => { try { play(m.seat, m.d); } catch (e) { /* ignore */ } });
      socket.on('disconnect', () => closeMic());
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && (open || opening)) { closeMic(); toast('میکروفون بسته شد چون صفحه در پس‌زمینه رفت'); } });
      window.addEventListener('pagehide', () => closeMic());
      setInterval(() => { const t = performance.now(); let any = false; speakers.forEach((s) => { if (t - s.last < 350) any = true; }); if (any !== this._any) { this._any = any; if (typeof Sfx !== 'undefined') Sfx.duck(any); } onChange('tick'); }, 150);
    },
    open: openMic,
    close: closeMic,
    status: () => ({ open, opening, sending, forced, loop, level: lvl }),
    isTalking: (seat) => { const s = speakers.get(seat); return Boolean(s) && performance.now() - s.last < 350; },
    setNames(list) { names = {}; list.forEach((p) => { names[p.seat] = p.name; }); },
    setForced(v) { if (v && !forced) { closeMic(); } forced = v; onChange(); },
    toggleMute(name) { if (muted.has(name)) muted.delete(name); else muted.add(name); return muted.has(name); },
    isMuted: (name) => muted.has(name),
    setLoop(v) { loop = Boolean(v) && open; if (socket && socket.connected) socket.emit('voiceLoop', { on: loop }); onChange(); },
    _codec: { encodeFrame, decodeFrame, FRAME, PACKET },
  };
})();
