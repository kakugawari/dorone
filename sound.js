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
  let motors = null;      // 4 つのモーター
  let motorGain = null;
  let motorFilter = null;
  let wind = null;
  let windGain = null;
  let noiseBuf = null;
  let muted = false;
  let started = false;
  let lastBeep = 0;

  // 4 枚のプロペラは同じ回転数ではない。わずかにずらすと、
  // 実機のあの「うなり」が出る。
  const DETUNE = [0, -3.5, 4.2, -1.8];

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
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(ctx.destination);

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
    g.gain.setValueAtTime(0.28 * s, t);
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
    seq.forEach(function (n) { beep(n[0], n[1], 0.055, n[2] || 0); });
  }

  root.Sound = {
    start: start, update: update, setMuted: setMuted, isMuted: isMuted,
    isRunning: isRunning, cue: cue, thud: thud, beep: beep,
    // テストからのぞく用
    debug: function () {
      return {
        ready: !!ctx,
        state: ctx ? ctx.state : 'none',
        muted: muted,
        master: master ? master.gain.value : null,
        motorGain: motorGain ? motorGain.gain.value : null,
        motorHz: motors ? motors[0].frequency.value : null,
        windGain: windGain ? windGain.gain.value : null
      };
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
