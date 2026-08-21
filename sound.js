/*!
 * sound.js — 音。Web Audio。
 *
 * 何が鳴っているかは core.js の audioParams() が決める (node でテストできる)。
 * ここは「その値をどう音にするか」だけを持つ。
 *
 * iOS は、指で触るまで音を出せない。最初のタップで start() を呼ぶこと。
 */
(function (root) {
  'use strict';

  const AC = root.AudioContext || root.webkitAudioContext;

  let ctx = null;
  let master = null;
  let limiter = null;
  let motors = null;      // 4 つのモーター
  let motorGain = null;
  let motorFilter = null;
  let wind = null;
  let windGain = null;
  let noiseBuf = null;
  let muted = false;
  let started = false;
  let lastBeep = 0;
  let silentEl = null;
  let session = 'none';

  // 4 枚のプロペラは同じ回転数ではない。わずかにずらすと、
  // 実機のあの「うなり」が出る。
  const DETUNE = [0, -3.5, 4.2, -1.8];

  /**
   * 無音の WAV を作る。iOS のマナーモード対策に、これを鳴らしっぱなしにする。
   * (中身は 8bit 無音の 0.25 秒。ファイルを増やしたくないので、その場で作る)
   */
  function silentWavUrl() {
    const rate = 8000, n = 2000;
    const b = new Uint8Array(44 + n);
    const dv = new DataView(b.buffer);
    const put = function (o, t) { for (let i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i); };
    put(0, 'RIFF'); dv.setUint32(4, 36 + n, true); put(8, 'WAVEfmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate, true);
    dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
    put(36, 'data'); dv.setUint32(40, n, true);
    b.fill(128, 44);
    let str = '';
    for (let i = 0; i < b.length; i++) str += String.fromCharCode(b[i]);
    return 'data:audio/wav;base64,' + root.btoa(str);
  }

  /**
   * iOS は本体横のマナーモードのスイッチを切ると、Web Audio の音が消える。
   * Web Audio は「環境音 (ambient)」あつかいで、着信音の音量に乗っているため。
   * 「再生 (playback)」に変えると、動画や音楽と同じあつかいになって鳴る。
   *
   * - Safari 17 以降: navigator.audioSession.type で直に指定できる
   * - それ以前: 無音を 1 本ループで鳴らしておくと、iOS が「再生中」と見なして
   *   playback に切りかわる
   *
   * どちらも「指で触ったとき」に呼ぶこと。
   */
  function usePlaybackSession() {
    try {
      if (root.navigator && root.navigator.audioSession) {
        root.navigator.audioSession.type = 'playback';
        session = 'audioSession';
      }
    } catch (e) { /* 対応していなければ下の手に任せる */ }

    if (!root.document || typeof root.Audio !== 'function') return;
    try {
      if (!silentEl) {
        silentEl = new root.Audio(silentWavUrl());
        silentEl.loop = true;
        silentEl.setAttribute('playsinline', '');
        silentEl.volume = 1;   // 中身が無音なので、音量は上げたままでよい
      }
      if (silentEl.paused) {
        const pr = silentEl.play();
        if (pr && pr.catch) pr.catch(function () { /* 触る前に呼ばれただけ */ });
      }
      if (session === 'none') session = 'silent';
    } catch (e) { /* 鳴らせなくても、本体の音は出る端末が多い */ }
  }

  function makeNoise() {
    const len = Math.floor(ctx.sampleRate * 1.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // 少しなまらせた雑音。素の白色雑音よりも風らしくなる。
      last = (last * 0.72) + (Math.random() * 2 - 1) * 0.28;
      d[i] = last * 3.2;
    }
    return buf;
  }

  /** 指で触ったときに呼ぶ。iOS はこれがないと鳴らない。 */
  function start() {
    if (!AC) return false;
    usePlaybackSession();
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      // スマホのスピーカーで聞こえるように音を大きめにしてあるので、
      // モーター全開 + ぶつかった音 + 合図が重なると 1.0 を超えて割れる。
      // 出口で頭を押さえておく。
      limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 3;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.20;
      master.connect(limiter);
      limiter.connect(ctx.destination);

      motorFilter = ctx.createBiquadFilter();
      motorFilter.type = 'lowpass';
      motorFilter.frequency.value = 1500;
      motorFilter.Q.value = 0.7;
      motorGain = ctx.createGain();
      motorGain.gain.value = 0;
      motorFilter.connect(motorGain);
      motorGain.connect(master);

      motors = DETUNE.map(function (d, i) {
        const o = ctx.createOscillator();
        o.type = i % 2 ? 'sawtooth' : 'square';
        o.frequency.value = 120 + d;
        o.connect(motorFilter);
        o.start();
        return o;
      });

      noiseBuf = makeNoise();
      wind = ctx.createBufferSource();
      wind.buffer = noiseBuf;
      wind.loop = true;
      const wf = ctx.createBiquadFilter();
      wf.type = 'bandpass';
      wf.frequency.value = 700;
      wf.Q.value = 0.6;
      windGain = ctx.createGain();
      windGain.gain.value = 0;
      wind.connect(wf); wf.connect(windGain); windGain.connect(master);
      wind.start();
    }
    if (ctx.state === 'suspended') ctx.resume();
    started = true;
    return true;
  }

  /**
   * 裏に回ると iOS は音を止める。戻ってきたら鳴らしなおす。
   * (電話や他のアプリの音でも止まる)
   */
  function resume() {
    if (!ctx || !started) return false;
    if (ctx.state === 'suspended') ctx.resume();
    if (silentEl && silentEl.paused) {
      const pr = silentEl.play();
      if (pr && pr.catch) pr.catch(function () {});
    }
    return ctx.state !== 'suspended';
  }

  if (typeof root.document !== 'undefined' && root.document.addEventListener) {
    root.document.addEventListener('visibilitychange', function () {
      if (!root.document.hidden) resume();
    });
  }

  function setMuted(m) {
    muted = !!m;
    if (master) master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.02);
  }
  function isMuted() { return muted; }
  function isRunning() { return !!ctx && ctx.state === 'running'; }

  /** 毎フレーム、core.audioParams() の結果をそのまま渡す。 */
  function update(p) {
    if (!ctx || !started) return;
    const now = ctx.currentTime;
    for (let i = 0; i < motors.length; i++) {
      motors[i].frequency.setTargetAtTime(p.motorHz + DETUNE[i], now, 0.04);
    }
    motorGain.gain.setTargetAtTime(p.motorGain, now, 0.05);
    motorFilter.frequency.setTargetAtTime(700 + p.motorHz * 3.2, now, 0.08);
    windGain.gain.setTargetAtTime(p.windGain, now, 0.08);

    if (p.lowBattery && now - lastBeep > 2.2) {
      lastBeep = now;
      beep(1180, 0.08, 0.05);
      beep(1180, 0.08, 0.05, 0.14);
    }
  }

  /** 短い電子音。 */
  function beep(hz, dur, vol, delay) {
    if (!ctx || muted) return;
    const t = ctx.currentTime + (delay || 0);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(hz, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol == null ? 0.06 : vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  /** ぶつかった音。強さ 0..1。 */
  function thud(strength) {
    if (!ctx || muted || !noiseBuf) return;
    const t = ctx.currentTime;
    const s = Math.max(0.15, Math.min(1, strength));
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = 0.5 + s * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(500 + s * 900, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.36 * s, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28 + s * 0.2);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t); src.stop(t + 0.6);
  }

  const CUES = {
    gate: [[880, 0.09], [1320, 0.11, 0.06]],
    pickup: [[520, 0.07], [780, 0.09, 0.05]],
    drop: [[660, 0.08], [440, 0.12, 0.06]],
    success: [[660, 0.10], [880, 0.10, 0.09], [1320, 0.22, 0.18]],
    fail: [[300, 0.16], [200, 0.30, 0.10]]
  };

  /** 合図の音。kind は CUES のどれか。 */
  function cue(kind) {
    const seq = CUES[kind];
    if (!seq) return;
    seq.forEach(function (n) { beep(n[0], n[1], 0.085, n[2] || 0); });
  }

  /**
   * 「音が出ているか」を確かめるための音。設定のボタンから鳴らす。
   * 消音中でも、押したら鳴らす (確かめるための音なので)。
   */
  function testTone() {
    start();
    if (!ctx) return false;
    const wasMuted = muted;
    if (wasMuted) setMuted(false);
    beep(660, 0.16, 0.16, 0.00);
    beep(880, 0.16, 0.16, 0.18);
    beep(1320, 0.30, 0.16, 0.36);
    if (wasMuted) {
      root.setTimeout(function () { setMuted(true); }, 900);
    }
    return true;
  }

  /**
   * いま実際に出ている音の大きさ (RMS)。テストから「本当に鳴っているか」を測る。
   * 呼ばれたときだけ解析器をつなぐので、ふだんは負荷にならない。
   */
  let analyser = null;
  function level() {
    if (!ctx || !master) return 0;
    if (!analyser) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      // 出口 (リミッターのあと) を測る。ここが実際にスピーカーへ行く音。
      (limiter || master).connect(analyser);
    }
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  function peak() {
    if (!analyser) { level(); if (!analyser) return 0; }
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let m = 0;
    for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
    return m;
  }

  /** いちばん強く出ている周波数 (Hz)。テストから「本当にその高さで鳴っているか」を測る。 */
  function topHz() {
    if (!analyser) { level(); if (!analyser) return 0; }
    const bins = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(bins);
    const step = ctx.sampleRate / analyser.fftSize;
    let best = -Infinity, at = 0;
    for (let i = Math.ceil(80 / step); i < bins.length && i * step < 1500; i++) {
      if (bins[i] > best) { best = bins[i]; at = i * step; }
    }
    return at;
  }

  root.Sound = {
    start: start, resume: resume, level: level, __peak: peak, __topHz: topHz, update: update, setMuted: setMuted, isMuted: isMuted,
    isRunning: isRunning, cue: cue, thud: thud, beep: beep, testTone: testTone,
    // テストからのぞく用
    debug: function () {
      return {
        ready: !!ctx,
        state: ctx ? ctx.state : 'none',
        session: session,
        silentPlaying: !!silentEl && !silentEl.paused,
        muted: muted,
        master: master ? master.gain.value : null,
        motorGain: motorGain ? motorGain.gain.value : null,
        motorHz: motors ? motors[0].frequency.value : null,
        windGain: windGain ? windGain.gain.value : null
      };
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
