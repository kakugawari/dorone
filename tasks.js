/*!
 * tasks.js — 練習課題・採点・失敗原因の診断。DOM を触らない。
 *
 * core.js の物理を 1 ステップ進めたあとに stepRun() を呼ぶ。
 * 「飛べた / 飛べなかった」だけでなく、**なぜ失敗したか**を言葉にして返すのが目的。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory(require('./core.js'));
  } else {
    root.Tasks = factory(root.Core);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  const DEG = Core.DEG;
  const clamp = Core.clamp;
  const wrapPi = Core.wrapPi;

  // ------------------------------------------------------------------
  // 課題。上から順にやると、実機でつまずく順番どおりになる。
  // ------------------------------------------------------------------
  const TASKS = [
    {
      id: 'hover',
      name: '① 離陸してホバリング',
      goal: '高さ 1.0m の輪の中に 10 秒とどまる',
      hint: 'スロットルは「当てて、戻す」。上げっぱなしにすると天井まで行きます。',
      kind: 'hover',
      start: { x: 0, y: 0, z: 1.7 }, startYaw: 0,
      target: { x: 0, y: 1.0, z: 1.7 },
      radius: 0.60, band: 0.30, hold: 10, limit: 75
    },
    {
      id: 'altitude',
      name: '② 高さだけを保つ',
      goal: '高さ 1.4m ±0.2m を 15 秒キープ',
      hint: '左右は気にしなくていい。上下の当て舵だけに集中する。',
      kind: 'altitude',
      start: { x: 0, y: 0, z: 1.9 }, startYaw: 0,
      targetY: 1.4, band: 0.22, hold: 15, limit: 80
    },
    {
      id: 'box',
      name: '③ 四角く飛ぶ',
      goal: '4 つの輪を順番にくぐる',
      hint: '傾けると「加速」します。止めたい所の手前で逆に倒す。',
      kind: 'gates',
      start: { x: 0, y: 0, z: 0.6 }, startYaw: 0,
      gates: [
        { x: -1.5, y: 1.1, z: 1.3, r: 0.55, nx: 0, nz: 1 },
        { x: -1.5, y: 1.1, z: 3.9, r: 0.55, nx: 1, nz: 0 },
        { x: 1.5, y: 1.1, z: 3.9, r: 0.55, nx: 0, nz: -1 },
        { x: 1.5, y: 1.1, z: 1.3, r: 0.55, nx: -1, nz: 0 }
      ],
      limit: 120
    },
    {
      id: 'nose',
      name: '④ 対面ホバリング',
      goal: '機首をこちらに向けたまま、輪の中に 15 秒',
      hint: '最大の壁。対面だと左右が逆。「機体から見て左」に倒すこと。',
      kind: 'hover',
      start: { x: 0, y: 0, z: 2.0 }, startYaw: Math.PI,
      target: { x: 0, y: 1.2, z: 2.0 },
      radius: 0.65, band: 0.32, hold: 15, limit: 100,
      faceCamera: true, faceTolDeg: 35
    },
    {
      id: 'land',
      name: '⑤ 狭いところに着陸',
      goal: 'マットの上に、そっと降りる (0.5 m/s 以下)',
      hint: '真上まで来て、水平を止めてから下ろす。降ろしながら寄せない。',
      kind: 'land',
      start: { x: -1.6, y: 0, z: 1.0 }, startYaw: 0,
      pad: { x: 1.4, z: 3.0, r: 0.45 },
      maxTouchdownSpeed: 0.50, limit: 100,
      takeoffFirst: true
    },
    {
      id: 'wind',
      name: '⑥ 風の中でホバリング',
      goal: '風に流されながら 15 秒キープ',
      hint: '当て舵を「入れっぱなし」にする。戻すと流されます。',
      kind: 'hover',
      start: { x: 0, y: 0, z: 2.0 }, startYaw: 0,
      target: { x: 0, y: 1.2, z: 2.0 },
      radius: 0.70, band: 0.35, hold: 15, limit: 100,
      wind: { x: 0.55, z: -0.18 }
    },
    {
      id: 'eight',
      name: '⑦ 8 の字',
      goal: '6 つの輪を順にくぐって 8 の字を描く',
      hint: '仕上げ。旋回中も高さが変わらないように。',
      kind: 'gates',
      start: { x: 0, y: 0, z: 0.6 }, startYaw: 0,
      gates: [
        { x: -1.3, y: 1.2, z: 1.6, r: 0.55, nx: 0, nz: 1 },
        { x: -1.3, y: 1.2, z: 3.4, r: 0.55, nx: 1, nz: 0 },
        { x: 0.0, y: 1.2, z: 2.5, r: 0.55, nx: 1, nz: -1 },
        { x: 1.3, y: 1.2, z: 1.6, r: 0.55, nx: 0, nz: 1 },
        { x: 1.3, y: 1.2, z: 3.4, r: 0.55, nx: -1, nz: 0 },
        { x: 0.0, y: 1.2, z: 2.5, r: 0.55, nx: -1, nz: -1 }
      ],
      limit: 150
    },
    {
      id: 'under',
      name: '⑧ テーブルの下をくぐる',
      goal: '低いところを抜けて、上から戻ってくる',
      hint: 'まず離陸して、20cm まで下げてから進む。床すれすれは意外と難しい。',
      kind: 'gates',
      start: { x: 0.4, y: 0, z: 0.5 }, startYaw: 0,
      gates: [
        { x: 0.375, y: 0.20, z: 2.775, r: 0.26, nx: 0, nz: 1 },   // 天板の下
        { x: 0.375, y: 1.20, z: 4.20, r: 0.50, nx: 0, nz: 1 },
        { x: 0.375, y: 1.20, z: 1.75, r: 0.45, nx: 0, nz: -1 }
      ],
      limit: 130
    },
    {
      id: 'carry',
      name: '⑨ 荷物を運ぶ',
      goal: '箱を吊って、緑の台にそっと置く',
      hint: '荷物は 32cm 下がります。テーブルの上は高めに。振り子なので、急に動かすと振り回されます。',
      kind: 'carry',
      start: { x: -1.75, y: 0, z: 0.5 }, startYaw: 0,
      payload: { x: -1.4, z: 1.5 },
      pad: { x: 1.7, z: 3.0, r: 0.42 },
      maxDropSpeed: 0.55,
      limit: 150
    },
    {
      id: 'cat',
      name: '⑩ 猫がいる部屋で',
      goal: '猫に落とされずに 15 秒ホバリング',
      hint: '低いところを飛ぶと猫が寄ってきます。高さを保てば手は出せません。',
      kind: 'hover',
      start: { x: -0.6, y: 0, z: 1.4 }, startYaw: 0,
      target: { x: -0.6, y: 1.35, z: 1.4 },
      radius: 0.70, band: 0.32, hold: 15, limit: 110,
      cat: true
    }
  ];

  function findTask(id) {
    return TASKS.find(t => t.id === id) || TASKS[0];
  }

  /**
   * その課題に必要なものを用意する (荷物・猫・風)。
   * アプリとテストで同じものを使うために、ここに置く。
   */
  function prepare(task, state, env, seed) {
    state.payload = task.payload ? Core.createPayload(task.payload.x, task.payload.z) : null;
    env.cat = task.cat ? Core.createCat(env.room, seed) : null;
    env.wind = task.wind || null;
    return env;
  }

  // ------------------------------------------------------------------
  // 走行 (1 回の挑戦)
  // ------------------------------------------------------------------
  function createRun(taskId, seed) {
    const task = findTask(taskId);
    return {
      task: task,
      seed: (seed >>> 0) || 1,
      elapsed: 0,
      hold: 0,
      bestHold: 0,
      gateIndex: 0,
      gateTimes: [],
      inZone: false,
      enterCount: 0,
      errorSum: 0,       // 誤差の積分 (m·s)
      errorTime: 0,
      roughness: 0,      // スティックの乱暴さ (Σ|Δ入力|)
      prevInput: null,
      samples: [],       // 軌跡 { t, x, y, z, yaw }
      sampleAcc: 0,
      stats: {
        throttleUpRun: 0, maxThrottleUpRun: 0,
        stickHoldRun: 0, maxStickHoldRun: 0,
        fastTime: 0, counterSteerTime: 0,
        wrongWayTime: 0, facingWrongWayTime: 0,
        ceilingTime: 0, maxAlt: 0,
        swingPeak: 0, dropOffCount: 0, tempTime: 0,
        batteryStart: 1, batteryUsed: 0,
        neverLeftGround: true
      },
      finished: false,
      success: false,
      message: '',
      stars: 0,
      score: null,
      notes: []
    };
  }

  /** その課題の「目標地点」。無い課題では null。 */
  function targetPoint(task, state) {
    if (task.kind === 'hover') return task.target;
    if (task.kind === 'altitude') return { x: state.pos.x, y: task.targetY, z: state.pos.z };
    if (task.kind === 'land') return { x: task.pad.x, y: 0, z: task.pad.z };
    if (task.kind === 'carry') {
      // 荷物を持つ前は荷物へ、持ったら台へ
      const p = state.payload;
      if (p && p.attached) return { x: task.pad.x, y: 0.55, z: task.pad.z };
      return p ? { x: p.home.x, y: 0.45, z: p.home.z } : null;
    }
    if (task.kind === 'gates') {
      return null; // ゲートは stepRun 側で扱う
    }
    return null;
  }

  /** 機首がおおむね操縦者を向いているか。 */
  function isFacingPilot(state, pilot, tolRad) {
    const toPilot = Math.atan2(pilot.x - state.pos.x, pilot.z - state.pos.z);
    return Math.abs(wrapPi(state.yaw - toPilot)) <= tolRad;
  }

  /** 入力から生まれる水平加速度の向き (単位ベクトル)。入力が無ければ null。 */
  function commandDirection(state, input) {
    const mag = Math.hypot(input.pitch, input.roll);
    if (mag < 0.2) return null;
    const h = Core.headingVectors(state.yaw);
    const x = h.fwd.x * input.pitch + h.right.x * input.roll;
    const z = h.fwd.z * input.pitch + h.right.z * input.roll;
    const len = Math.hypot(x, z) || 1;
    return { x: x / len, z: z / len };
  }

  /**
   * 課題の判定を dt 秒すすめる。Core.step() の直後に呼ぶ。
   * env は { room, config, wind } (Core.step に渡したものと同じ)。
   */
  function stepRun(run, state, input, dt, env) {
    if (run.finished) return run;
    const task = run.task, st = run.stats, room = env.room;

    run.elapsed += dt;
    if (run.elapsed <= dt * 1.5) st.batteryStart = state.battery;
    st.batteryUsed = Math.max(0, st.batteryStart - state.battery);
    if (state.pos.y > 0.15) st.neverLeftGround = false;
    st.maxAlt = Math.max(st.maxAlt, state.pos.y);
    if (state.payload && state.payload.attached) {
      st.swingPeak = Math.max(st.swingPeak, Math.hypot(state.payload.ox, state.payload.oz));
    }
    // 猫に手が届く高さにいた時間
    if (env.cat && state.flying && state.pos.y < 1.05) st.tempTime += dt;

    // --- スティックの乱暴さ ---
    if (run.prevInput) {
      run.roughness += Math.abs(input.throttle - run.prevInput.throttle)
        + Math.abs(input.yaw - run.prevInput.yaw)
        + Math.abs(input.pitch - run.prevInput.pitch)
        + Math.abs(input.roll - run.prevInput.roll);
    }
    run.prevInput = { throttle: input.throttle, yaw: input.yaw, pitch: input.pitch, roll: input.roll };

    // --- 「戻す癖」があるか ---
    if (input.throttle > 0.4) { st.throttleUpRun += dt; st.maxThrottleUpRun = Math.max(st.maxThrottleUpRun, st.throttleUpRun); }
    else st.throttleUpRun = 0;

    const stickMag = Math.hypot(input.pitch, input.roll);
    if (stickMag > 0.4) { st.stickHoldRun += dt; st.maxStickHoldRun = Math.max(st.maxStickHoldRun, st.stickHoldRun); }
    else st.stickHoldRun = 0;

    if (state.pos.y > room.height - 0.35) st.ceilingTime += dt;

    // --- 当て舵をしているか ---
    const speed = Math.hypot(state.vel.x, state.vel.z);
    const cmd = commandDirection(state, input);
    if (speed > 0.7) {
      st.fastTime += dt;
      if (cmd && (cmd.x * state.vel.x + cmd.z * state.vel.z) < -0.25 * speed) st.counterSteerTime += dt;
    }

    // --- 目標から遠ざかる向きに舵を入れていないか ---
    const tp = targetPoint(task, state);
    if (tp && cmd) {
      const ex = tp.x - state.pos.x, ez = tp.z - state.pos.z;
      const err = Math.hypot(ex, ez);
      if (err > 0.35 && (cmd.x * ex + cmd.z * ez) < -0.25 * err) {
        st.wrongWayTime += dt;
        if (isFacingPilot(state, room.pilot, 50 * DEG)) st.facingWrongWayTime += dt;
      }
    }

    // --- 軌跡の記録 (0.06 秒ごと) ---
    // 位置だけでなく姿勢とスティックも残す。あとで「どこで何をしたか」を再生するため。
    run.sampleAcc += dt;
    if (run.sampleAcc >= 0.06) {
      run.sampleAcc = 0;
      const smp = {
        t: run.elapsed,
        x: state.pos.x, y: state.pos.y, z: state.pos.z,
        yaw: state.yaw, pitch: state.pitch, roll: state.roll,
        it: input.throttle, iy: input.yaw, ip: input.pitch, ir: input.roll
      };
      if (state.payload) {
        smp.px = state.payload.x; smp.py = state.payload.y; smp.pz = state.payload.z;
        smp.pa = state.payload.attached ? 1 : 0;
      }
      run.samples.push(smp);
      if (run.samples.length > 3000) run.samples.shift();
    }

    // --- 墜落 ---
    if (state.crashed) {
      return finish(run, false, state.crashReason, env);
    }

    // --- 課題ごとの判定 ---
    if (task.kind === 'hover') {
      const d = Math.hypot(state.pos.x - task.target.x, state.pos.z - task.target.z);
      const dy = Math.abs(state.pos.y - task.target.y);
      const err = Math.hypot(d, dy);
      run.errorSum += err * dt;
      run.errorTime += dt;
      let ok = state.flying && d <= task.radius && dy <= task.band;
      if (ok && task.faceCamera) ok = isFacingPilot(state, room.pilot, (task.faceTolDeg || 35) * DEG);
      if (ok) {
        if (!run.inZone) { run.inZone = true; run.enterCount++; }
        run.hold += dt;
        run.bestHold = Math.max(run.bestHold, run.hold);
      } else {
        run.inZone = false;
        run.hold = 0;
      }
      if (run.hold >= task.hold) return finish(run, true, '', env);

    } else if (task.kind === 'altitude') {
      const dy = Math.abs(state.pos.y - task.targetY);
      run.errorSum += dy * dt;
      run.errorTime += dt;
      if (state.flying && dy <= task.band) {
        if (!run.inZone) { run.inZone = true; run.enterCount++; }
        run.hold += dt;
        run.bestHold = Math.max(run.bestHold, run.hold);
      } else { run.inZone = false; run.hold = 0; }
      if (run.hold >= task.hold) return finish(run, true, '', env);

    } else if (task.kind === 'gates') {
      const g = task.gates[run.gateIndex];
      const d = Math.hypot(state.pos.x - g.x, state.pos.y - g.y, state.pos.z - g.z);
      run.errorSum += d * dt;
      run.errorTime += dt;
      if (d <= g.r) {
        run.gateIndex++;
        run.gateTimes.push(run.elapsed);
        if (run.gateIndex >= task.gates.length) return finish(run, true, '', env);
      }

    } else if (task.kind === 'carry') {
      const p = state.payload;
      const tp2 = targetPoint(task, state);
      if (tp2) {
        run.errorSum += Math.hypot(state.pos.x - tp2.x, state.pos.z - tp2.z) * dt;
        run.errorTime += dt;
      }
      if (p && p.justDropped) {
        const d = Math.hypot(p.x - task.pad.x, p.z - task.pad.z);
        if (d <= task.pad.r) {
          if (p.dropSpeed > task.maxDropSpeed) {
            return finish(run, false, '荷物を落とす勢いが強すぎました (' + p.dropSpeed.toFixed(2) + ' m/s)', env);
          }
          return finish(run, true, '', env);
        }
        // 台の外に置いた。拾い直せばよい。
        run.events.push({ t: run.elapsed, kind: 'dropOff', d: d });
        st.dropOffCount++;
      }

    } else if (task.kind === 'land') {
      const d = Math.hypot(state.pos.x - task.pad.x, state.pos.z - task.pad.z);
      run.errorSum += d * dt;
      run.errorTime += dt;
      if (state.touchedDown) {
        if (d > task.pad.r) {
          return finish(run, false, 'マットから ' + d.toFixed(2) + 'm ずれた所に降りました', env);
        }
        if (state.touchdownSpeed > task.maxTouchdownSpeed) {
          return finish(run, false, '降りる勢いが強すぎました (' + state.touchdownSpeed.toFixed(2) + ' m/s)', env);
        }
        return finish(run, true, '', env);
      }
    }

    // --- 時間切れ ---
    if (run.elapsed >= task.limit) {
      return finish(run, false, '時間切れ', env);
    }
    return run;
  }

  function finish(run, success, message, env) {
    run.finished = true;
    run.success = success;
    run.message = message;
    run.score = scoreRun(run);
    run.stars = run.score.stars;
    run.notes = diagnose(run, env);
    return run;
  }

  // ------------------------------------------------------------------
  // 採点
  // ------------------------------------------------------------------
  function scoreRun(run) {
    const task = run.task;
    const avgError = run.errorTime > 0 ? run.errorSum / run.errorTime : 0;
    const rough = run.elapsed > 0 ? run.roughness / run.elapsed : 0;   // 1 秒あたりの入力変化量

    // 課題ごとの「これくらいならふつう」の基準
    const errRef = task.kind === 'gates' ? 1.6 : (task.band || 0.3) * 2.2;
    const timeRef = task.limit;
    const roughRef = 2.4;

    const accuracy = clamp(1 - avgError / errRef, 0, 1);
    const smooth = clamp(1 - rough / roughRef, 0, 1);
    const speed = clamp(1 - run.elapsed / timeRef, 0, 1);

    const total = run.success ? (accuracy * 0.45 + smooth * 0.30 + speed * 0.25) : 0;
    let stars = 0;
    if (run.success) stars = total >= 0.68 ? 3 : (total >= 0.44 ? 2 : 1);

    return {
      avgError: avgError, roughness: rough, elapsed: run.elapsed,
      accuracy: accuracy, smooth: smooth, speed: speed,
      total: total, stars: stars
    };
  }

  // ------------------------------------------------------------------
  // 失敗の原因を言葉にする。ここがこのアプリの本体。
  // 「落ちた」ではなく「なぜ落ちたか」を返す。
  // ------------------------------------------------------------------
  function diagnose(run, env) {
    const st = run.stats, task = run.task, notes = [];
    const room = env.room;

    if (st.neverLeftGround) {
      notes.push('一度も浮いていません。左スティックを上に。「離陸」ボタンでも浮きます。');
      return notes;
    }

    // 1. スロットル入れっぱなし
    if (st.maxThrottleUpRun > 2.2) {
      notes.push('スロットルを ' + st.maxThrottleUpRun.toFixed(1) + ' 秒入れっぱなしにしています。'
        + '高度維持機は「上げたら戻す」。戻した所で止まります。');
    } else if (st.ceilingTime > 1.0) {
      notes.push('天井ぎわに ' + st.ceilingTime.toFixed(1) + ' 秒いました。上げすぎたら早めに下げ舵を。');
    }

    // 2. 傾けっぱなし = 加速し続けている
    if (st.maxStickHoldRun > 1.8) {
      notes.push('右スティックを ' + st.maxStickHoldRun.toFixed(1) + ' 秒倒しっぱなしです。'
        + '傾き = 加速。倒している間ずっと速くなります。');
    }

    // 3. 当て舵をしていない
    if (st.fastTime > 1.5) {
      const ratio = st.counterSteerTime / st.fastTime;
      if (ratio < 0.28) {
        notes.push('速く動いているのに、逆に倒して止める操作がほとんどありません ('
          + Math.round(ratio * 100) + '%)。止めたい所の手前で逆に倒す。');
      }
    }

    // 4. 対面での左右反転
    if (st.facingWrongWayTime > 1.0) {
      notes.push('機体がこちらを向いているとき、' + st.facingWrongWayTime.toFixed(1)
        + ' 秒ぶん逆方向に倒しています。対面では左右が入れかわります。'
        + '「自分から見て」ではなく「機体から見て」どちらかで考える。');
    } else if (st.wrongWayTime > 1.5) {
      notes.push('目標から遠ざかる向きに ' + st.wrongWayTime.toFixed(1) + ' 秒倒していました。');
    }

    // 5. 舵が大きすぎる
    const rough = run.score ? run.score.roughness : 0;
    if (rough > 2.6) {
      notes.push('スティックの動きが大きすぎます (1 秒あたり ' + rough.toFixed(1)
        + ')。トイドローンは小さく当てて、すぐ戻すのが基本。');
    }

    // 6. 出たり入ったり
    if ((task.kind === 'hover' || task.kind === 'altitude') && run.enterCount >= 4) {
      notes.push('輪に ' + run.enterCount + ' 回出入りしています。行き過ぎては戻す、を繰り返している状態。'
        + '止まってから寄せると収まります。');
    }

    // 荷物: 振り回されていないか
    if (task.kind === 'carry' && run.stats.swingPeak > 0.20) {
      notes.push('荷物が大きく振れています (最大 ' + (run.stats.swingPeak * 100).toFixed(0)
        + 'cm)。吊り荷は振り子なので、動かす前と止める前に「ためる」のが要ります。');
    }
    if (task.kind === 'carry' && run.stats.dropOffCount > 0) {
      notes.push('台の外に ' + run.stats.dropOffCount + ' 回落としています。'
        + '真上まで来て、水平が止まってから下ろす。');
    }
    // 猫: 低く飛びすぎていないか
    if (run.stats.tempTime > 2.5) {
      notes.push('高さ 1.05m より下を ' + run.stats.tempTime.toFixed(1)
        + ' 秒飛んでいました。猫はそこまで手が届きます。上で待つほうが安全です。');
    }
    // 電池
    if (run.stats.batteryUsed > 0.06) {
      notes.push('この 1 回で電池を ' + Math.round(run.stats.batteryUsed * 100)
        + '% 使いました。上げ下げを繰り返すほど早く減ります。');
    }

    if (notes.length === 0) {
      notes.push(run.success
        ? 'きれいに飛べています。次の課題へどうぞ。'
        : '大きなクセは見当たりません。もう一度やってみましょう。');
    }
    return notes;
  }

  /** HUD の進み具合 (0..1)。課題ごとに意味が違う。 */
  function progressOf(run, state) {
    const task = run.task;
    if (task.kind === 'hover' || task.kind === 'altitude') return run.hold / task.hold;
    if (task.kind === 'gates') return run.gateIndex / task.gates.length;
    if (task.kind === 'land') {
      return clamp(1 - Math.hypot(state.pos.x - task.pad.x, state.pos.z - task.pad.z) / 3.8, 0, 1);
    }
    if (task.kind === 'carry') {
      const p = state.payload;
      if (!p) return 0;
      if (!p.attached) return p.everCarried ? 0.5 : 0;
      const d = Math.hypot(p.x - task.pad.x, p.z - task.pad.z);
      return 0.5 + clamp(1 - d / 4.2, 0, 1) * 0.5;
    }
    return 0;
  }

  return {
    TASKS: TASKS,
    progressOf: progressOf,
    findTask: findTask,
    prepare: prepare,
    createRun: createRun,
    stepRun: stepRun,
    scoreRun: scoreRun,
    diagnose: diagnose,
    targetPoint: targetPoint,
    isFacingPilot: isFacingPilot,
    commandDirection: commandDirection
  };
});
