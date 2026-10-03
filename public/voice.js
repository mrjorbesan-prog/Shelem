// Voice chat over the game's own socket. Opus (WebCodecs, 32 kbps wideband) when every peer supports it, else 8-bit mu-law @12 kHz.
// The mic is NEVER opened automatically. It closes on: user action, tab hidden, disconnect, leaving the room, admin mute, track end.
const Voice = (() => {
  const RATE = 12000, FRAME = 720, HEAD = 3, PACKET = HEAD + FRAME;       // mu-law: [type=0, seq16, 720 bytes]
  const ORATE = 48000, OFRAME = 2880, OTS = 60000;                          // opus: [type=1, seq16, opus bytes], 60 ms frames
  const ENC_CFG = { codec: 'opus', sampleRate: ORATE, numberOfChannels: 1, bitrate: 32000, opus: { application: 'voip', signal: 'voice', frameDuration: OTS, complexity: 6 } };
  const DEC_CFG = { codec: 'opus', sampleRate: ORATE, numberOfChannels: 1 };
  const BIAS = 0x84;
  function lin2ulaw(s) {
    const sign = (s >> 8) & 0x80;
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
    out[1] = seq & 255; out[2] = (seq >> 8) & 255;
    for (let n = 0; n < FRAME; n++) out[HEAD + n] = lin2ulaw(pcm[n]);
    return out;
  }
  function decodeFrame(buf) {
    if (!buf || buf.length !== PACKET || buf[0] !== 0) return null;
    const pcm = new Float32Array(FRAME);
    for (let n = 0; n < FRAME; n++) pcm[n] = ULAW[buf[HEAD + n]];
    return { seq: buf[1] | (buf[2] << 8), pcm };
  }

  let socket = null, toast = () => {}, onChange = () => {}, getMySeat = () => -1;
  let vctx = null, stream = null, srcNode = null, procNode = null, silentGain = null, wake = null, lp1 = null, lp2 = null;
  let deaf = false, open = false, opening = false, forced = false, loop = false, sending = false, gen = 0, workletReady = false, duckOn = false;
  const speakers = new Map(), decs = new Map(), muted = new Set();
  let names = {}, capsFor = null;
  let headset = false;
  try { headset = localStorage.getItem('shelem_headset') === '1'; } catch (e) { /* ignore */ }
  let seq = 0, noise = null, hang = 0, prev = [], lvl = 0;
  let acc = new Float32Array(FRAME), accN = 0, nextOut = 0, prevX = 0;      // mu-law capture path
  let opusSupport = false, peersOpus = false, opusMode = false, enc = null, tsN = 0, rawN = 0;
  const raw = new Float32Array(OFRAME), pendingTs = new Map();               // opus capture path

  async function detectOpus() {
    try {
      if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined' || typeof AudioData === 'undefined' || typeof EncodedAudioChunk === 'undefined') return;
      const e = await AudioEncoder.isConfigSupported(ENC_CFG), d = await AudioDecoder.isConfigSupported(DEC_CFG);
      opusSupport = Boolean(e.supported && d.supported);
    } catch (err) { opusSupport = false; }
  }
  function announce() { if (socket && socket.connected && capsFor !== socket.id) { capsFor = socket.id; socket.emit('voiceCaps', { opus: opusSupport }); } }

  function ensureCtx() {
    if (!vctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { vctx = new AC({ latencyHint: 'interactive', sampleRate: ORATE }); } catch (e) { vctx = new AC({ latencyHint: 'interactive' }); }
    }
    if (vctx.state === 'suspended') vctx.resume().catch(() => {});
    return vctx;
  }
  ['pointerdown', 'touchend', 'keydown'].forEach((ev) => document.addEventListener(ev, ensureCtx, { passive: true }));

  function anyRemote() { const t = performance.now(); let a = false; speakers.forEach((s) => { if (t - s.last < 350) a = true; }); return a; }
  function updateDuck() {
    const want = open || opening || anyRemote();
    if (want !== duckOn) { duckOn = want; if (typeof Sfx !== 'undefined') Sfx.duck(want); }
  }
  function sendPkt(p) {
    const eng = socket.io && socket.io.engine;
    if (eng && eng.writeBuffer && eng.writeBuffer.length > 15) return;      // network backed up: skip instead of building latency
    socket.emit('voice', p);
  }
  function setSending(v) { if (sending !== v) { sending = v; onChange(); } }
  function dispatch(pkt, speech) {
    if (!open || forced) return;
    if (speech) {
      if (!sending) { prev.forEach(sendPkt); setSending(true); }
      sendPkt(pkt); prev = [];
    } else {
      prev.push(pkt); if (prev.length > 3) prev.shift();
      setSending(false);                                                    // silence is never transmitted
    }
  }
  function vadStep(rms) {
    lvl = rms;
    if (noise === null) noise = 0.005;
    if (rms < noise) noise = noise * 0.8 + rms * 0.2;
    else if (hang === 0) noise = Math.min(0.03, noise * 1.003 + 1e-5);
    const thr = hang > 0 ? Math.max(0.006, noise * 1.5) : Math.max(0.009, noise * 2.2);   // hysteresis: easy to start, easy to stay
    if (rms > thr) hang = 9; else if (hang > 0) hang--;
    return hang > 0;
  }

  // ---- capture ----
  function makeEncoder() {
    try {
      enc = new AudioEncoder({
        output: (chunk) => {
          const flag = pendingTs.get(chunk.timestamp);
          if (flag === undefined) return;
          pendingTs.delete(chunk.timestamp);
          const body = new Uint8Array(chunk.byteLength); chunk.copyTo(body);
          const sq = Math.round(chunk.timestamp / OTS) & 0xffff;
          const pkt = new Uint8Array(3 + body.length);
          pkt[0] = 1; pkt[1] = sq & 255; pkt[2] = (sq >> 8) & 255; pkt.set(body, 3);
          dispatch(pkt, flag);
        },
        error: () => { enc = null; opusSupport = false; opusMode = false; },
      });
      enc.configure(ENC_CFG);
    } catch (e) { enc = null; opusSupport = false; opusMode = false; }
  }
  function dropEncoder() { if (enc) { try { enc.close(); } catch (e) { /* ignore */ } enc = null; } pendingTs.clear(); }
  function switchMode(v) {
    opusMode = v; rawN = 0; accN = 0; nextOut = 0; prevX = 0; prev = [];
    const f = v ? 20000 : 5200;
    if (lp1) { lp1.frequency.value = f; lp2.frequency.value = f; }
    if (v && !enc) makeEncoder();
    if (!v) dropEncoder();
    if (v && !enc) opusMode = false;
  }
  function opusFrame() {
    let e = 0;
    for (let n = 0; n < OFRAME; n++) e += raw[n] * raw[n];
    const flag = vadStep(Math.sqrt(e / OFRAME));
    if (!enc || enc.state !== 'configured') return;
    tsN++;
    const ts = tsN * OTS;
    pendingTs.set(ts, flag);
    if (pendingTs.size > 40) pendingTs.delete(pendingTs.keys().next().value);
    try {
      const ad = new AudioData({ format: 'f32-planar', sampleRate: ORATE, numberOfFrames: OFRAME, numberOfChannels: 1, timestamp: ts, data: raw });
      enc.encode(ad); ad.close();
    } catch (err) { /* ignore */ }
  }
  function frame(f) {
    let e = 0;
    const pcm = new Int16Array(FRAME);
    for (let n = 0; n < FRAME; n++) { const v = f[n] < -1 ? -1 : f[n] > 1 ? 1 : f[n]; e += v * v; pcm[n] = Math.round(v * 32767); }
    const flag = vadStep(Math.sqrt(e / FRAME));
    seq = (seq + 1) & 0xffff;
    dispatch(encodeFrame(pcm, seq), flag);
  }
  function feed(chunk, sr) {
    const wantO = opusSupport && peersOpus && sr === ORATE;
    if (wantO !== opusMode) switchMode(wantO);
    if (opusMode) {
      for (let k = 0; k < chunk.length; k++) { raw[rawN++] = chunk[k]; if (rawN === OFRAME) { rawN = 0; opusFrame(); } }
      return;
    }
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
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: !headset, noiseSuppression: !headset, autoGainControl: false, channelCount: 1 } });
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
      noise = null; hang = 0; prev = []; accN = 0; nextOut = 0; prevX = 0; rawN = 0; opusMode = false;
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
    try { if (silentGain) silentGain.disconnect(); } catch (e) { /* ignore */ }
    lp1 = lp2 = null; procNode = srcNode = silentGain = null;
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (wake) { wake.release().catch(() => {}); wake = null; }
    dropEncoder(); opusMode = false; rawN = 0;
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

  // ---- playback ----
  function schedule(sp, pcm, rate) {
    const sr = vctx.sampleRate, ratio = sr / rate, n = pcm.length, outLen = Math.round(n * ratio);
    const now = vctx.currentTime, t = performance.now();
    if (sp.next < now + 0.02) {
      if (t - sp.lastSched < 400) { sp.target = Math.min(0.6, sp.target + 0.08); sp.lastUnder = t; }   // underrun mid-speech: grow the jitter buffer
      sp.next = now + sp.target; sp.tail = pcm[0];
    } else if (sp.next - now > 0.8) return;                                                            // big backlog: drop to keep latency bounded
    else if (sp.target > 0.2 && t - sp.lastUnder > 15000) { sp.target = Math.max(0.2, sp.target - 0.03); sp.lastUnder = t; }
    sp.lastSched = t;
    let out = pcm;
    if (Math.abs(ratio - 1) > 1e-6) {
      out = new Float32Array(outLen);
      let p0 = sp.tail;
      for (let k = 0; k < outLen; k++) {
        const tt = k / ratio, i = tt | 0, f = tt - i;
        const a = i === 0 ? p0 : pcm[i - 1];
        out[k] = a + (pcm[i] - a) * f;
      }
      sp.tail = pcm[n - 1];
    }
    const fc = rate >= 24000 ? 20000 : 5600;
    if (sp.fc !== fc) { sp.fc = fc; sp.lp.frequency.value = fc; }
    const buf = vctx.createBuffer(1, outLen, sr);
    buf.copyToChannel(out, 0);
    const src = vctx.createBufferSource();
    src.buffer = buf; src.connect(sp.gain); src.start(sp.next);
    sp.next += outLen / sr;
  }
  function decodeOpus(seat, sp, data) {
    let ad = decs.get(seat);
    if (!ad || ad.state === 'closed') {
      ad = new AudioDecoder({
        output: (a) => {
          try {
            const f = new Float32Array(a.numberOfFrames), rate = a.sampleRate || ORATE;
            a.copyTo(f, { planeIndex: 0, format: 'f32-planar' }); a.close();
            const s2 = speakers.get(seat);
            if (s2 && vctx) schedule(s2, f, rate);
          } catch (e) { /* ignore */ }
        },
        error: () => { decs.delete(seat); },
      });
      ad.configure(DEC_CFG); decs.set(seat, ad);
    }
    sp.dts = (sp.dts || 0) + OTS;
    try { ad.decode(new EncodedAudioChunk({ type: 'key', timestamp: sp.dts, data })); } catch (e) { decs.delete(seat); }
  }
  function play(seat, d) {
    if (!vctx || vctx.state === 'closed' || deaf) return;
    if (seat === getMySeat() && !loop) return;
    const name = names[seat];
    if (name && muted.has(name)) return;
    if (vctx.state === 'suspended') vctx.resume().catch(() => {});
    const buf = d instanceof Uint8Array ? d : new Uint8Array(d);
    if (buf.length < 4) return;
    let sp = speakers.get(seat);
    if (!sp) {
      const gain = vctx.createGain(), lp = vctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 5600; lp.Q.value = 0.707;
      gain.connect(lp); lp.connect(vctx.destination);
      sp = { next: 0, seq: -1, last: 0, lastSched: 0, gain, lp, fc: 5600, tail: 0, target: 0.2, lastUnder: performance.now() };
      speakers.set(seat, sp);
    }
    const sq = buf[1] | (buf[2] << 8);
    if (sp.seq >= 0) { const diff = (sq - sp.seq) & 0xffff; if (diff === 0 || diff > 32768) return; }
    sp.seq = sq; sp.last = performance.now();
    if (buf[0] === 0) { const dec = decodeFrame(buf); if (dec) schedule(sp, dec.pcm, RATE); }
    else if (buf[0] === 1 && opusSupport) decodeOpus(seat, sp, buf.subarray(3));
  }

  return {
    init(opts) {
      socket = opts.socket; toast = opts.toast; onChange = opts.onChange; getMySeat = opts.getMySeat;
      detectOpus().then(() => { capsFor = null; announce(); });
      socket.on('voice', (m) => { try { play(m.seat, m.d); } catch (e) { /* ignore */ } });
      socket.on('disconnect', () => { capsFor = null; closeMic(); });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && (open || opening)) { closeMic(); toast('میکروفون بسته شد چون صفحه در پس‌زمینه رفت'); } });
      window.addEventListener('pagehide', () => closeMic());
      setInterval(() => { updateDuck(); onChange('tick'); }, 150);
    },
    open: openMic,
    close: closeMic,
    status: () => ({ headset, deaf, open, opening, sending, forced, loop, level: lvl, opus: opusMode }),
    isTalking: (seat) => { const s = speakers.get(seat); return Boolean(s) && performance.now() - s.last < 350; },
    setNames(list) {
      names = {}; list.forEach((p) => { names[p.seat] = p.name; });
      const me = getMySeat(), others = list.filter((p) => p.seat !== me && p.connected !== false);
      peersOpus = others.length > 0 && others.every((p) => p.opus);
      announce();
    },
    setForced(v) { if (v && !forced) closeMic(); forced = v; onChange(); },
    toggleMute(name) { if (muted.has(name)) muted.delete(name); else muted.add(name); return muted.has(name); },
    isMuted: (name) => muted.has(name),
    setHeadset(v) { headset = Boolean(v); try { localStorage.setItem('shelem_headset', headset ? '1' : '0'); } catch (e) { /* ignore */ } onChange(); },
    setDeaf(v) { deaf = Boolean(v); onChange(); },
    setLoop(v) { loop = Boolean(v) && open; if (socket && socket.connected) socket.emit('voiceLoop', { on: loop }); onChange(); },
    _codec: { encodeFrame, decodeFrame, FRAME, PACKET },
  };
})();
