// Procedural audio (WebAudio): card sound effects + endless soft ambient music. No audio files needed.
const Sfx = (() => {
  const store = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch (e) { /* ignore */ } };
  let ctx = null, sfxBus, musicBus, musicIn, noiseBuf;
  let musicOn = store('shelem_music', true), sfxOn = store('shelem_sfx', true);
  let chordTimer = null, pluckTimer = null, chordIdx = 0, running = false;
  const rnd = (a, b) => a + Math.random() * (b - a);

  function build(c) {
    ctx = c;
    const master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
    sfxBus = ctx.createGain(); sfxBus.gain.value = sfxOn ? 1 : 0; sfxBus.connect(master);
    musicBus = ctx.createGain(); musicBus.gain.value = musicOn ? 1 : 0; musicBus.connect(master);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1700; lp.connect(musicBus);
    musicIn = ctx.createGain(); musicIn.gain.value = 0.085; musicIn.connect(lp);
    const len = Math.floor(ctx.sampleRate * 3.2);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
    const conv = ctx.createConvolver(); conv.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = 0.9;
    musicIn.connect(conv); conv.connect(wet); wet.connect(lp);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  }

  function noise(t, { freq, q = 1, dur, gain, type = 'bandpass', to }) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q; f.frequency.setValueAtTime(freq, t);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(sfxBus);
    src.start(t, Math.random() * 0.6); src.stop(t + dur + 0.05);
  }
  function tone(t, { freq, dur, gain, type = 'sine', to, bus }) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus || sfxBus); o.start(t); o.stop(t + dur + 0.05);
  }
  const flick = (t, v = 1) => {
    noise(t, { freq: rnd(2800, 3800), q: 0.9, dur: 0.07, gain: 0.5 * v });
    noise(t, { freq: 1000, q: 0.7, dur: 0.05, gain: 0.3 * v });
    tone(t, { freq: rnd(150, 190), to: 100, dur: 0.06, gain: 0.22 * v });
  };
  const SFX = {
    flick: (t) => flick(t),
    deal: (t) => { for (let i = 0; i < 9; i++) flick(t + i * 0.08, rnd(0.4, 0.65)); },
    swish: (t) => noise(t, { freq: 2600, q: 1.2, dur: 0.3, gain: 0.32, to: 700 }),
    cut: (t) => { tone(t, { freq: 260, to: 85, dur: 0.24, gain: 0.5, type: 'triangle' }); noise(t, { freq: 600, q: 0.6, dur: 0.12, gain: 0.45 }); tone(t + 0.06, { freq: 1318, dur: 0.4, gain: 0.1 }); },
    turn: (t) => { tone(t, { freq: 880, dur: 0.22, gain: 0.15 }); tone(t + 0.11, { freq: 1175, dur: 0.32, gain: 0.13 }); },
    tick: (t) => { noise(t, { freq: 4200, q: 1.5, dur: 0.03, gain: 0.25 }); tone(t, { freq: 1300, dur: 0.04, gain: 0.06 }); },
    chime: (t) => { tone(t, { freq: 659, dur: 0.6, gain: 0.12 }); tone(t + 0.12, { freq: 784, dur: 0.7, gain: 0.1 }); },
    pop: (t) => { tone(t, { freq: 700, to: 1000, dur: 0.08, gain: 0.1 }); },
    bid: (t) => { tone(t, { freq: 988, dur: 0.18, gain: 0.13 }); tone(t + 0.07, { freq: 1319, dur: 0.3, gain: 0.11 }); noise(t, { freq: 5000, q: 2, dur: 0.03, gain: 0.12 }); },
    pass: (t) => { tone(t, { freq: 330, to: 250, dur: 0.22, gain: 0.14, type: 'triangle' }); },
    hakem: (t) => { [392, 523, 659].forEach((f, i) => tone(t + i * 0.09, { freq: f, dur: 0.55, gain: 0.12, type: 'triangle' })); },
    reveal: (t) => { noise(t, { freq: 2200, q: 1, dur: 0.18, gain: 0.3, to: 5000 }); tone(t + 0.1, { freq: 1046, dur: 0.35, gain: 0.08 }); },
    trump: (t) => { tone(t, { freq: 440, dur: 0.5, gain: 0.1 }); tone(t, { freq: 554, dur: 0.5, gain: 0.08 }); tone(t, { freq: 659, dur: 0.5, gain: 0.07 }); },
    good: (t) => { tone(t, { freq: 784, dur: 0.25, gain: 0.12 }); tone(t + 0.08, { freq: 1047, dur: 0.4, gain: 0.11 }); },
    sad: (t) => { tone(t, { freq: 392, dur: 0.4, gain: 0.12, type: 'triangle' }); tone(t + 0.16, { freq: 311, dur: 0.6, gain: 0.12, type: 'triangle' }); },
    lose: (t) => { [392, 349, 311, 261].forEach((f, i) => tone(t + i * 0.2, { freq: f, dur: 0.7, gain: 0.12, type: 'triangle' })); },
    warn: (t) => { tone(t, { freq: 240, dur: 0.18, gain: 0.16, type: 'square' }); tone(t + 0.2, { freq: 200, dur: 0.22, gain: 0.16, type: 'square' }); },
    deny: (t) => { tone(t, { freq: 160, to: 120, dur: 0.12, gain: 0.18, type: 'square' }); },
    join: (t) => { tone(t, { freq: 587, dur: 0.15, gain: 0.1 }); tone(t + 0.1, { freq: 880, dur: 0.25, gain: 0.1 }); },
    win: (t) => { [523, 659, 784, 1047].forEach((f, i) => tone(t + i * 0.14, { freq: f, dur: 0.9, gain: 0.13 })); },
  };

  const CHORDS = [[110, 164.81, 220, 261.63], [87.31, 130.81, 174.61, 220], [130.81, 196, 261.63, 329.63], [98, 146.83, 196, 246.94], [146.83, 220, 293.66, 349.23], [164.81, 246.94, 329.63, 392]];
  const PENT = [440, 523.25, 587.33, 659.25, 783.99, 880];
  function chord() {
    const t = ctx.currentTime, dur = 12;
    CHORDS[chordIdx].forEach((f, i) => [-5, 5].forEach((dt) => {
      const o = ctx.createOscillator(); o.type = i < 2 ? 'triangle' : 'sine'; o.frequency.value = f; o.detune.value = dt;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.22, t + 3.5); g.gain.setValueAtTime(0.22, t + 7); g.gain.linearRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(musicIn); o.start(t); o.stop(t + dur + 0.1);
    }));
    chordIdx = (chordIdx + 1 + Math.floor(Math.random() * 3)) % CHORDS.length;
  }
  function pluck() {
    tone(ctx.currentTime, { freq: PENT[Math.floor(Math.random() * PENT.length)], dur: 2.8, gain: 0.35, bus: musicIn });
  }
  function startMusic() {
    if (running || !ctx) return;
    running = true;
    const loopChord = () => { if (!running) return; chord(); chordTimer = setTimeout(loopChord, 8000); };
    const loopPluck = () => { if (!running) return; if (Math.random() < 0.75) pluck(); pluckTimer = setTimeout(loopPluck, rnd(2500, 6000)); };
    loopChord(); pluckTimer = setTimeout(loopPluck, 3000);
  }
  function stopMusic() { running = false; clearTimeout(chordTimer); clearTimeout(pluckTimer); }

  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { build(new AC()); } catch (e) { return; }
    }
    if (ctx.state === 'suspended') ctx.resume();
    if (musicOn) startMusic();
  }
  ['pointerdown', 'keydown', 'touchend'].forEach((ev) => document.addEventListener(ev, unlock, { passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.visibilityState === 'hidden') ctx.suspend(); else ctx.resume();
  });

  return {
    get music() { return musicOn; },
    get sfx() { return sfxOn; },
    play(name) {
      if (!ctx || !sfxOn || !SFX[name]) return;
      if (ctx.state === 'suspended') ctx.resume();
      try { SFX[name](ctx.currentTime + 0.005); } catch (e) { /* ignore */ }
    },
    duck(on) {
      if (!ctx || !musicOn) return;
      musicBus.gain.cancelScheduledValues(ctx.currentTime);
      musicBus.gain.linearRampToValueAtTime(on ? 0.2 : 1, ctx.currentTime + 0.3);
    },
    toggleMusic() {
      unlock();
      musicOn = !musicOn; save('shelem_music', musicOn);
      if (ctx) {
        musicBus.gain.cancelScheduledValues(ctx.currentTime);
        musicBus.gain.linearRampToValueAtTime(musicOn ? 1 : 0, ctx.currentTime + 0.5);
        if (musicOn) startMusic(); else setTimeout(() => { if (!musicOn) stopMusic(); }, 600);
      }
      return musicOn;
    },
    toggleSfx() {
      unlock();
      sfxOn = !sfxOn; save('shelem_sfx', sfxOn);
      if (ctx) sfxBus.gain.value = sfxOn ? 1 : 0;
      if (sfxOn) this.play('tick');
      return sfxOn;
    },
    _test: { build, SFX, chord, pluck },
  };
})();
