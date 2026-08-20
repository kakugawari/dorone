/*!
 * app.js — 画面・操作・描画。ロジックは core.js / tasks.js。
 *
 * 描画は Canvas 2D だけ。3D は「点を回して透視投影 → 奥から順に塗る」で作る。
 * ライブラリもビルドも要らないので、1 ファイルずつ差し替えられる。
 */
(function () {
  'use strict';

  const C = window.Core;
  const T = window.Tasks;
  const DEG = C.DEG;

  const PHYS_DT = 1 / 60;      // 物理は固定の刻みで進める。フレームレートに影響されない
  const MAX_STEPS = 5;         // 1 フレームで追いつく上限。重い端末で暴走させない

  // ---------------------------------------------------------------- 保存
  const SETTINGS_KEY = 'dorone.settings.v1';
  const PROGRESS_KEY = 'dorone.progress.v1';

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? Object.assign({}, fallback, JSON.parse(raw)) : Object.assign({}, fallback);
    } catch (e) { return Object.assign({}, fallback); }
  }
  // 書き込みはまとめる。操作のたびに同期で書くと一瞬止まる。
  let saveTimer = null;
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(app.settings));
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(app.progress));
      } catch (e) { /* プライベートモードなどでは保存できない。動作には影響しない */ }
    }, 250);
  }

  // ---------------------------------------------------------------- 状態
  const app = {
    screen: 'menu',
    settings: loadJSON(SETTINGS_KEY, { mode: 2, difficulty: 1, altHold: 1, assist: 1 }),
    progress: loadJSON(PROGRESS_KEY, {}),
    taskId: 'hover',
    run: null,
    state: null,
    env: null,
    cam: null,
    input: { throttle: 0, yaw: 0, pitch: 0, roll: 0 },
    paused: true,
    acc: 0,
    lastFrame: 0,
    fps: 0,
    fpsAcc: 0,
    fpsCount: 0,
    renderScale: 2,      // canvas をどれだけ細かく描くか (端末の画素の何倍か)
    scaleAcc: 0,
    goodStreak: 0,
    toastUntil: 0
  };

  const els = {};
  ['view', 'hud', 'controls', 'menu', 'result', 'btnMenu', 'btnTakeoff', 'btnRetry',
    'hudTaskName', 'hudTaskGoal', 'hudTime', 'hudProgress', 'gaugeAlt', 'gaugeSpd',
    'hdArrow', 'gaugeFps', 'hudToast', 'hudGauges', 'taskList', 'stickL', 'stickR',
    'knobL', 'knobR', 'labelL', 'labelR', 'resVerdict', 'resStars', 'resMsg',
    'resScores', 'resNotes', 'chartTop', 'chartAlt', 'btnResRetry', 'btnResNext',
    'btnResMenu', 'setMode', 'setDifficulty', 'setAltHold', 'setAssist', 'modeNote', 'altHoldNote'
  ].forEach(function (id) { els[id] = document.getElementById(id); });

  const ctx = els.view.getContext('2d');

  // ================================================================
  // スティック
  // ================================================================
  function createStick(padEl, knobEl) {
    return {
      pad: padEl, knob: knobEl,
      x: 0, y: 0,            // -1..1 (y は上が +)
      pointerId: null,
      originX: 0, originY: 0,
      stickyY: false,        // 高度維持オフのときスロットルは戻らない
      radius: 40,
      knobX: 0, knobY: 0     // 見た目 (-1..1)
    };
  }
  const sticks = {
    left: createStick(els.stickL, els.knobL),
    right: createStick(els.stickR, els.knobR)
  };

  function stickRadius(s) {
    const r = s.pad.getBoundingClientRect();
    return Math.max(24, r.width / 2 - s.knob.offsetWidth / 2 - 2);
  }

  function bindStick(s) {
    s.pad.addEventListener('pointerdown', function (e) {
      if (s.pointerId !== null) return;
      e.preventDefault();
      s.pointerId = e.pointerId;
      s.pad.setPointerCapture(e.pointerId);
      s.pad.classList.add('active');
      s.radius = stickRadius(s);
      // 触った所を原点にする。指の下でノブが飛ばないように。
      const rect = s.pad.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      s.originX = e.clientX - s.x * s.radius;
      s.originY = e.clientY + s.y * s.radius;
      // 原点が外に出すぎないよう、パッドの中に収める
      s.originX = clamp(s.originX, cx - s.radius * 0.6, cx + s.radius * 0.6);
      s.originY = clamp(s.originY, cy - s.radius * 0.6, cy + s.radius * 0.6);
      moveStick(s, e.clientX, e.clientY);
    }, { passive: false });

    s.pad.addEventListener('pointermove', function (e) {
      if (e.pointerId !== s.pointerId) return;
      e.preventDefault();
      moveStick(s, e.clientX, e.clientY);
    }, { passive: false });

    function release(e) {
      if (e.pointerId !== s.pointerId) return;
      s.pointerId = null;
      s.pad.classList.remove('active');
      s.x = 0;
      if (!s.stickyY) s.y = 0;   // バネで中央に戻る
    }
    s.pad.addEventListener('pointerup', release);
    s.pad.addEventListener('pointercancel', release);
    // iOS Safari は指を離しても pointerup を落とすことがある。保険。
    s.pad.addEventListener('lostpointercapture', release);
  }

  function moveStick(s, clientX, clientY) {
    let dx = (clientX - s.originX) / s.radius;
    let dy = -(clientY - s.originY) / s.radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    s.x = dx;
    s.y = dy;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** ノブの見た目を追従させる。位置は left/top で決める (transform を使わない)。 */
  function renderKnobs(dt) {
    const k = 1 - Math.exp(-26 * dt);
    for (const key of ['left', 'right']) {
      const s = sticks[key];
      s.knobX += (s.x - s.knobX) * k;
      s.knobY += (s.y - s.knobY) * k;
      const r = stickRadius(s);
      const half = s.knob.offsetWidth / 2;
      const c = s.pad.offsetWidth / 2;
      s.knob.style.left = (c + s.knobX * r - half) + 'px';
      s.knob.style.top = (c - s.knobY * r - half) + 'px';
    }
  }

  // ---------------------------------------------------------------- キーボード (PC 確認用)
  const keys = Object.create(null);
  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey) return;
    keys[e.key.toLowerCase()] = true;
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].indexOf(e.key.toLowerCase()) >= 0) e.preventDefault();
    if (e.key === ' ' && app.screen === 'flight') toggleTakeoff();
  });
  window.addEventListener('keyup', function (e) { keys[e.key.toLowerCase()] = false; });

  function keyAxis(neg, pos) { return (keys[pos] ? 1 : 0) - (keys[neg] ? 1 : 0); }

  function readSticks() {
    const l = { x: sticks.left.x, y: sticks.left.y };
    const r = { x: sticks.right.x, y: sticks.right.y };
    // キーボード: W/S=左縦 A/D=左横 ↑↓=右縦 ←→=右横
    const kl = { x: keyAxis('a', 'd'), y: keyAxis('s', 'w') };
    const kr = { x: keyAxis('arrowleft', 'arrowright'), y: keyAxis('arrowdown', 'arrowup') };
    if (kl.x || kl.y) { l.x = kl.x; l.y = kl.y; }
    if (kr.x || kr.y) { r.x = kr.x; r.y = kr.y; }
    return C.mapSticks(app.settings.mode, l, r);
  }

  // ================================================================
  // 飛行の開始 / 終了
  // ================================================================
  function startTask(taskId) {
    const task = T.findTask(taskId);
    app.taskId = task.id;

    const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    const config = C.randomizeDrift(C.makeConfig(), seed, app.settings.difficulty);
    config.altHold = !!app.settings.altHold;

    app.env = { room: C.createRoom(), config: config, wind: task.wind || null };
    app.state = C.createState({ start: task.start, yaw: task.startYaw || 0 });
    app.run = T.createRun(task.id, seed);

    // 高度維持オフのときは、スロットルのスティックは戻らない (実機の送信機と同じ)
    const side = C.throttleSide(app.settings.mode);
    sticks.left.stickyY = sticks.right.stickyY = false;
    sticks[side].stickyY = !app.settings.altHold;
    sticks.left.x = sticks.left.y = sticks.right.x = sticks.right.y = 0;
    if (!app.settings.altHold) { sticks[side].y = -1; sticks[side].knobY = -1; }

    app.cam = C.makeCamera({ pos: app.env.room.pilot, yaw: 0, pitch: 0 });
    // いきなり床のドローンを見おろすと、浮いたときに機体が画面の上に飛ぶ。
    // 最初から「これから浮く高さ」あたりを見ておく。
    aimCameraAt({ x: task.start.x, y: 0.9, z: task.start.z });
    resize();

    app.paused = false;
    app.acc = 0;
    app.lastFrame = 0;
    setScreen('flight');
    updateStickLabels();
    toast(task.hint, 4200);
  }

  /**
   * カメラを機体の方へ向ける。
   * 目で追うように、デッドゾーンの中は動かさない (動いている感じを残すため)。
   * ただし速く動かれると追いつけないので、最後に固い上限をかけて画面から出さない。
   * デッドゾーンも上限も「画面上の距離」で決める。角度で決め打ちにすると、
   * 横向きのときに上下がはみ出す。
   */
  function updateCam(dt) {
    const f = C.focalLength(app.cam);
    const usableH = app.usableH || app.cam.height;
    C.updateCamera(app.cam, app.state.pos, dt, {
      deadYaw: Math.atan((app.cam.width / 2) * 0.26 / f) / DEG,
      deadPitch: Math.atan((usableH / 2) * 0.26 / f) / DEG,
      rate: 2.6,
      // 画面の端から 22% 内側より外には、絶対に出さない
      maxYaw: Math.atan((app.cam.width / 2) * 0.78 / f),
      maxPitch: Math.atan((usableH / 2) * 0.78 / f)
    });
  }

  function aimCameraAt(p) {
    const cam = app.cam;
    cam.yaw = Math.atan2(p.x - cam.pos.x, p.z - cam.pos.z);
    cam.pitch = Math.atan2(p.y - cam.pos.y, Math.hypot(p.x - cam.pos.x, p.z - cam.pos.z));
  }

  function finishFlight(run) {
    if (run !== app.run || !run.finished || !run.score) return;   // すでに次の走行が始まっている
    app.paused = true;
    const best = app.progress[run.task.id] || 0;
    if (run.stars > best) { app.progress[run.task.id] = run.stars; saveSoon(); }
    showResult(run);
  }

  function toggleTakeoff() {
    const s = app.state;
    if (!s || s.crashed) return;
    if (!s.flying && !s.airborne) { s.auto = 'takeoff'; }
    else if (s.auto === 'land') { s.auto = null; }
    else if (s.flying) { s.auto = 'land'; }
    else { s.auto = 'takeoff'; }
    updateTakeoffButton();
  }

  function updateTakeoffButton() {
    const s = app.state;
    if (!s) return;
    const landing = s.auto === 'land';
    els.btnTakeoff.textContent = landing ? '着陸中…' : (s.flying ? '着陸' : '離陸');
    els.btnTakeoff.classList.toggle('landing', landing);
  }

  function updateStickLabels() {
    const m = app.settings.mode;
    els.labelL.textContent = m === 1 ? '前後 / 旋回' : '上下 / 旋回';
    els.labelR.textContent = m === 1 ? '上下 / 左右' : '前後 / 左右';
  }

  function toast(text, ms) {
    els.hudToast.textContent = text;
    els.hudToast.hidden = false;
    els.hudToast.classList.remove('bad');
    app.toastUntil = performance.now() + (ms || 2200);
  }
  function toastBad(text, ms) {
    toast(text, ms);
    els.hudToast.classList.add('bad');
  }

  // ================================================================
  // 画面の切りかえ
  // ================================================================
  function setScreen(name) {
    app.screen = name;
    els.menu.hidden = name !== 'menu';
    els.result.hidden = name !== 'result';
    els.hud.hidden = name !== 'flight';
    els.controls.hidden = name !== 'flight';
    if (name === 'menu') renderTaskList();
  }

  function starsHTML(n, total) {
    let s = '';
    for (let i = 0; i < (total || 3); i++) s += '<span class="' + (i < n ? 'on' : 'off') + '">★</span>';
    return s;
  }

  function renderTaskList() {
    els.taskList.innerHTML = '';
    T.TASKS.forEach(function (task) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'task-item';
      btn.innerHTML =
        '<div class="ti-body"><div class="ti-name"></div><div class="ti-goal"></div></div>' +
        '<div class="ti-stars">' + starsHTML(app.progress[task.id] || 0) + '</div>';
      btn.querySelector('.ti-name').textContent = task.name;
      btn.querySelector('.ti-goal').textContent = task.goal;
      btn.addEventListener('click', function () { startTask(task.id); });
      li.appendChild(btn);
      els.taskList.appendChild(li);
    });
  }

  // ================================================================
  // 結果
  // ================================================================
  function showResult(run) {
    els.resVerdict.textContent = run.success ? 'クリア' : '失敗';
    els.resVerdict.className = 'result-verdict ' + (run.success ? 'pass' : 'fail');
    els.resStars.innerHTML = starsHTML(run.stars);
    els.resMsg.textContent = run.success
      ? run.task.name + ' を ' + run.elapsed.toFixed(1) + ' 秒で'
      : (run.message || '');

    const rows = [
      ['正確さ', run.score.accuracy, '平均のズレ ' + run.score.avgError.toFixed(2) + ' m'],
      ['なめらかさ', run.score.smooth, '1 秒あたり ' + run.score.roughness.toFixed(2)],
      ['速さ', run.score.speed, run.elapsed.toFixed(1) + ' 秒']
    ];
    els.resScores.innerHTML = rows.map(function (r) {
      return '<div class="score-row"><span class="sr-label">' + r[0] + '</span>' +
        '<span class="sr-bar"><span class="sr-fill" style="width:' + Math.round(r[1] * 100) + '%"></span></span>' +
        '<span class="sr-num">' + r[2] + '</span></div>';
    }).join('');

    els.resNotes.innerHTML = '';
    run.notes.forEach(function (n) {
      const li = document.createElement('li');
      li.textContent = n;
      if (/きれいに飛べています/.test(n)) li.className = 'good';
      els.resNotes.appendChild(li);
    });

    drawTopChart(run);
    drawAltChart(run);
    setScreen('result');
  }

  /** グラフの canvas を、画面に出る大きさ x 端末の画素にそろえる。ぼやけを防ぐ。 */
  function fitChart(cv, ratio) {
    const w = cv.clientWidth || 320;
    const s = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(w * s);
    cv.height = Math.round(w * ratio * s);
    return s;
  }

  /** 上から見た軌跡。どこでふらついたかが一目で分かる。 */
  function drawTopChart(run) {
    const cv = els.chartTop;
    fitChart(cv, 1);
    const c = cv.getContext('2d');
    const room = C.createRoom();
    const W = cv.width, H = cv.height;
    const pad = Math.round(W * 0.05);
    const padB = Math.round(W * 0.09);   // 「あなた」の字が入るぶん、下は広く
    const s = Math.min((W - pad * 2) / (room.maxX - room.minX), (H - pad - padB) / (room.maxZ - room.minZ));
    const ox = pad + ((W - pad * 2) - (room.maxX - room.minX) * s) / 2;
    const oy = pad + ((H - pad - padB) - (room.maxZ - room.minZ) * s) / 2;
    const X = function (x) { return ox + (x - room.minX) * s; };
    // 奥 (maxZ) を上に描く。操縦者から見た向きに合わせる。
    const Z = function (z) { return oy + (room.maxZ - z) * s; };

    c.clearRect(0, 0, W, H);
    c.fillStyle = '#131a2e'; c.fillRect(0, 0, W, H);
    c.strokeStyle = '#2c3550'; c.lineWidth = 1;
    c.strokeRect(X(room.minX), Z(room.maxZ), (room.maxX - room.minX) * s, (room.maxZ - room.minZ) * s);

    c.fillStyle = 'rgba(120,140,190,.20)';
    room.furniture.forEach(function (f) {
      c.fillRect(X(f.min.x), Z(f.max.z), (f.max.x - f.min.x) * s, (f.max.z - f.min.z) * s);
    });

    // 目標
    const task = run.task;
    c.strokeStyle = 'rgba(126,227,164,.75)'; c.lineWidth = 1.5;
    if (task.kind === 'hover') { c.beginPath(); c.arc(X(task.target.x), Z(task.target.z), task.radius * s, 0, Math.PI * 2); c.stroke(); }
    if (task.kind === 'land') { c.beginPath(); c.arc(X(task.pad.x), Z(task.pad.z), task.pad.r * s, 0, Math.PI * 2); c.stroke(); }
    if (task.kind === 'gates') {
      task.gates.forEach(function (g, i) {
        c.beginPath(); c.arc(X(g.x), Z(g.z), g.r * s * 0.5, 0, Math.PI * 2); c.stroke();
        c.fillStyle = 'rgba(126,227,164,.9)'; c.font = Math.round(W * 0.035) + 'px sans-serif'; c.textAlign = 'center';
        c.fillText(String(i + 1), X(g.x), Z(g.z) + W * 0.013);
      });
    }

    // 操縦者の位置
    c.fillStyle = '#4fc3ff';
    c.beginPath(); c.arc(X(room.pilot.x), Z(room.pilot.z), 4, 0, Math.PI * 2); c.fill();
    c.font = Math.round(W * 0.035) + 'px sans-serif'; c.textAlign = 'center'; c.fillStyle = '#97a2c4';
    c.fillText('あなた', X(room.pilot.x), Z(room.pilot.z) + W * 0.055);

    // 軌跡。高いほど明るく。
    if (run.samples.length > 1) {
      c.lineWidth = Math.max(2, W * 0.008); c.lineCap = 'round';
      for (let i = 1; i < run.samples.length; i++) {
        const a = run.samples[i - 1], b = run.samples[i];
        const h = clamp(b.y / 2.0, 0, 1);
        c.strokeStyle = 'hsla(' + Math.round(200 - h * 130) + ', 85%, ' + Math.round(45 + h * 22) + '%, .9)';
        c.beginPath(); c.moveTo(X(a.x), Z(a.z)); c.lineTo(X(b.x), Z(b.z)); c.stroke();
      }
      const last = run.samples[run.samples.length - 1];
      c.fillStyle = run.success ? '#7ee3a4' : '#ff6b6b';
      c.beginPath(); c.arc(X(last.x), Z(last.z), W * 0.016, 0, Math.PI * 2); c.fill();
    }
  }

  /** 高さの記録。上下に暴れているかが分かる。 */
  function drawAltChart(run) {
    const cv = els.chartAlt;
    fitChart(cv, 0.56);
    const c = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const padL = Math.round(W * 0.10), padR = Math.round(W * 0.03);
    const padT = Math.round(W * 0.035), padB = Math.round(W * 0.065);
    const room = C.createRoom();
    const dur = Math.max(1, run.elapsed);
    const X = function (t) { return padL + (t / dur) * (W - padL - padR); };
    const Y = function (y) { return H - padB - (y / room.height) * (H - padT - padB); };

    c.clearRect(0, 0, W, H);
    c.fillStyle = '#131a2e'; c.fillRect(0, 0, W, H);

    c.strokeStyle = '#252d47'; c.lineWidth = 1;
    c.fillStyle = '#6b769a'; c.font = Math.round(W * 0.033) + 'px sans-serif'; c.textAlign = 'right';
    for (let y = 0; y <= room.height; y += 0.6) {
      c.beginPath(); c.moveTo(padL, Y(y)); c.lineTo(W - padR, Y(y)); c.stroke();
      c.fillText(y.toFixed(1), padL - W * 0.012, Y(y) + W * 0.012);
    }

    // 目標の高さ帯
    const task = run.task;
    let ty = null, band = 0;
    if (task.kind === 'hover') { ty = task.target.y; band = task.band; }
    if (task.kind === 'altitude') { ty = task.targetY; band = task.band; }
    if (ty !== null) {
      c.fillStyle = 'rgba(126,227,164,.16)';
      c.fillRect(padL, Y(ty + band), W - padL - padR, Y(ty - band) - Y(ty + band));
      c.strokeStyle = 'rgba(126,227,164,.6)';
      c.beginPath(); c.moveTo(padL, Y(ty)); c.lineTo(W - padR, Y(ty)); c.stroke();
    }

    if (run.samples.length > 1) {
      c.strokeStyle = '#4fc3ff'; c.lineWidth = Math.max(1.5, W * 0.006); c.beginPath();
      run.samples.forEach(function (s, i) {
        const x = X(s.t), y = Y(s.y);
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      });
      c.stroke();
    }
    c.fillStyle = '#6b769a'; c.textAlign = 'left';
    c.fillText('0s', padL, H - W * 0.016);
    c.textAlign = 'right';
    c.fillText(run.elapsed.toFixed(0) + 's', W - padR, H - W * 0.016);
  }

  // ================================================================
  // 描画
  // ================================================================
  let dpr = 1;

  /**
   * 描く細かさの段階。
   * 実測: CPU を 4 倍遅くすると 2 倍で 47ms/フレーム、1 倍なら 24ms。
   * 遅い端末では、きれいさより「なめらかさ」を取る。操作の練習では
   * 引っかかるほうが致命的なので。
   */
  const SCALE_STEPS = [2, 1.5, 1];

  function maxScale() { return Math.min(window.devicePixelRatio || 1, 2); }

  /** fps を見て、描く細かさを上げ下げする。 */
  function adaptScale(dt) {
    app.scaleAcc += dt;
    if (app.scaleAcc < 1.5 || !app.fps) return;
    app.scaleAcc = 0;
    const i = SCALE_STEPS.indexOf(app.renderScale);
    if (app.fps < 45 && i < SCALE_STEPS.length - 1) {
      app.renderScale = SCALE_STEPS[i + 1];
      app.goodStreak = 0;
      resize();
    } else if (app.fps > 56) {
      app.goodStreak++;
      // すぐ戻すと行ったり来たりするので、しばらく安定してから上げる
      if (app.goodStreak >= 2 && i > 0 && SCALE_STEPS[i - 1] <= maxScale()) {
        app.renderScale = SCALE_STEPS[i - 1];
        app.goodStreak = 0;
        resize();
      }
    } else {
      app.goodStreak = 0;
    }
  }

  function resize() {
    const w = els.view.clientWidth || window.innerWidth;
    const h = els.view.clientHeight || window.innerHeight;
    app.renderScale = Math.min(app.renderScale, maxScale());
    dpr = app.renderScale;
    els.view.width = Math.round(w * dpr);
    els.view.height = Math.round(h * dpr);
    if (!app.cam) return;
    app.cam.width = w;
    app.cam.height = h;

    // 実際に見える範囲 = スティックより上。ここの真ん中を消失点にする。
    // 横向きのときはスティックが左右の隅にあるだけなので、削るのは少しでいい。
    const stickH = els.stickL.offsetHeight || 130;
    const portrait = w / h < 1;
    const bottom = Math.min(h * 0.45, portrait ? stickH + 46 : stickH * 0.5);
    const usableH = Math.max(120, h - bottom);
    app.usableH = usableH;
    app.cam.cx = w / 2;
    app.cam.cy = usableH / 2 + 4;

    // 画角は「見える範囲の対角」で決める。縦横どちらでも自然な広さになる。
    // 縦だけ・横だけで決めると、縦長の画面で極端な望遠になってしまう。
    const diag = Math.hypot(w, usableH);
    const f = (diag / 2) / Math.tan(74 * DEG / 2);
    app.cam.fovY = 2 * Math.atan((h / 2) / f);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 220); });

  const P = { room: null };

  /** 世界の多角形を塗る。手前の面で切ってから描く。 */
  function poly(cam, pts, fill, stroke, lw) {
    const p = C.projectPolygon(cam, pts);
    if (!p) return null;
    ctx.beginPath();
    ctx.moveTo(p.pts[0].x * dpr, p.pts[0].y * dpr);
    for (let i = 1; i < p.pts.length; i++) ctx.lineTo(p.pts[i].x * dpr, p.pts[i].y * dpr);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = (lw || 1) * dpr; ctx.stroke(); }
    return p;
  }

  /** 世界の線分。両端がカメラの前にあるときだけ描く。 */
  function line3(cam, a, b, color, lw) {
    const va = C.worldToView(cam, a), vb = C.worldToView(cam, b);
    if (va.z < C.NEAR && vb.z < C.NEAR) return;
    let A = va, B = vb;
    if (va.z < C.NEAR || vb.z < C.NEAR) {
      const [n, f] = va.z < C.NEAR ? [va, vb] : [vb, va];
      const t = (C.NEAR - n.z) / (f.z - n.z);
      const cut = { x: n.x + (f.x - n.x) * t, y: n.y + (f.y - n.y) * t, z: C.NEAR };
      A = cut; B = f;
    }
    const sa = C.projectView(cam, A), sb = C.projectView(cam, B);
    if (!sa || !sb) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = (lw || 1) * dpr;
    ctx.beginPath();
    ctx.moveTo(sa.x * dpr, sa.y * dpr);
    ctx.lineTo(sb.x * dpr, sb.y * dpr);
    ctx.stroke();
  }

  /**
   * 線をまとめて描くための入れ物。
   * 1 本ずつ stroke() を呼ぶと、線の数だけ描画命令が飛んで遅くなる。
   * 同じ色の線は 1 つの path にまとめて 1 回で塗る。
   */
  function beginLines() { ctx.beginPath(); }
  function addLine(cam, a, b) {
    const va = C.worldToView(cam, a), vb = C.worldToView(cam, b);
    if (va.z < C.NEAR && vb.z < C.NEAR) return;
    let A = va, B = vb;
    if (va.z < C.NEAR || vb.z < C.NEAR) {
      const n = va.z < C.NEAR ? va : vb;
      const f = va.z < C.NEAR ? vb : va;
      const t = (C.NEAR - n.z) / (f.z - n.z);
      A = { x: n.x + (f.x - n.x) * t, y: n.y + (f.y - n.y) * t, z: C.NEAR };
      B = f;
    }
    const sa = C.projectView(cam, A), sb = C.projectView(cam, B);
    if (!sa || !sb) return;
    ctx.moveTo(sa.x * dpr, sa.y * dpr);
    ctx.lineTo(sb.x * dpr, sb.y * dpr);
  }
  function strokeLines(color, lw) {
    ctx.strokeStyle = color;
    ctx.lineWidth = (lw || 1) * dpr;
    ctx.stroke();
  }

  function strokeLoop(cam, pts, color, lw) {
    const p = C.projectPolygon(cam, pts);
    if (!p) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = (lw || 1) * dpr;
    ctx.beginPath();
    ctx.moveTo(p.pts[0].x * dpr, p.pts[0].y * dpr);
    for (let i = 1; i < p.pts.length; i++) ctx.lineTo(p.pts[i].x * dpr, p.pts[i].y * dpr);
    ctx.closePath();
    ctx.stroke();
  }

  function drawScene() {
    const cam = app.cam, room = app.env.room, state = app.state, task = app.run.task;
    const W = els.view.width, H = els.view.height;

    // 背景 (奥の壁より遠くは見えないので、暗い下地だけ)
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#131a2e');
    g.addColorStop(1, '#0b0e18');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // ---- 部屋の外殻。中にいるので、これを先に描けば必ず正しい順になる ----
    const shell = [];
    const y0 = 0, y1 = room.height;
    const x0 = room.minX, x1 = room.maxX, z0 = room.minZ, z1 = room.maxZ;

    shell.push({ depth: 1e6, draw: function () { drawFloor(cam, room, state, task); } });
    // 天井。照明を描いてみたが、画面の上端は遠近が強くかかるので、
    // 四角い光がゆがんで「描画の失敗」に見えた。素のままにしておく。
    shell.push({ depth: 9e5, draw: function () { poly(cam, [{ x: x0, y: y1, z: z0 }, { x: x1, y: y1, z: z0 }, { x: x1, y: y1, z: z1 }, { x: x0, y: y1, z: z1 }], '#171d31'); } });
    // 壁。奥ほど暗くして奥行きを出す。
    shell.push({ depth: 8e5, draw: function () { drawWall(cam, [{ x: x0, y: y0, z: z1 }, { x: x1, y: y0, z: z1 }, { x: x1, y: y1, z: z1 }, { x: x0, y: y1, z: z1 }], '#1c2338', 'z', z1); } });
    shell.push({ depth: 7e5, draw: function () { drawWall(cam, [{ x: x0, y: y0, z: z0 }, { x: x0, y: y0, z: z1 }, { x: x0, y: y1, z: z1 }, { x: x0, y: y1, z: z0 }], '#1a2134', 'x', x0); } });
    shell.push({ depth: 6e5, draw: function () { drawWall(cam, [{ x: x1, y: y0, z: z1 }, { x: x1, y: y0, z: z0 }, { x: x1, y: y1, z: z0 }, { x: x1, y: y1, z: z1 }], '#1a2134', 'x', x1); } });
    shell.forEach(function (s) { s.draw(); });

    // ---- 中にあるもの。奥から順に ----
    const items = [];
    room.furniture.forEach(function (f) { collectBox(cam, f, items); });
    collectTargets(cam, task, app.run, items);
    const footZ = C.worldToView(cam, { x: state.pos.x, y: 0, z: state.pos.z }).z;
    items.push({ depth: footZ + 0.001, draw: function () { drawFootMarks(cam, state); } });
    items.push({ depth: C.worldToView(cam, state.pos).z, draw: function () { drawDrone(cam, state); } });
    items.sort(function (a, b) { return b.depth - a.depth; });
    items.forEach(function (it) { it.draw(); });
  }

  function drawWall(cam, pts, base, axis, v) {
    poly(cam, pts, base);
    // 巾木で床との境目を出す。境目が見えないと高さが読めない。
    const lo = pts.slice(0, 2);
    line3(cam, lo[0], lo[1], 'rgba(255,255,255,.10)', 1.5);
  }

  function drawFloor(cam, room, state, task) {
    const x0 = room.minX, x1 = room.maxX, z0 = room.minZ, z1 = room.maxZ;
    poly(cam, [{ x: x0, y: 0, z: z0 }, { x: x1, y: 0, z: z0 }, { x: x1, y: 0, z: z1 }, { x: x0, y: 0, z: z1 }], '#20283f');

    // 50cm ごとのグリッド。距離感の手がかりになる。
    // 1m ごとの線と 50cm の線で、色ごとに 1 回ずつ塗る (34 回 → 2 回)。
    for (const major of [false, true]) {
      beginLines();
      for (let x = Math.ceil(x0 * 2) / 2; x <= x1 + 1e-6; x += 0.5) {
        if ((Math.abs(x % 1) < 0.01) !== major) continue;
        addLine(cam, { x: x, y: 0.001, z: z0 }, { x: x, y: 0.001, z: z1 });
      }
      for (let z = Math.ceil(z0 * 2) / 2; z <= z1 + 1e-6; z += 0.5) {
        if ((Math.abs(z % 1) < 0.01) !== major) continue;
        addLine(cam, { x: x0, y: 0.001, z: z }, { x: x1, y: 0.001, z: z });
      }
      strokeLines(major ? 'rgba(150,175,230,.16)' : 'rgba(150,175,230,.07)', 1);
    }

    // 着陸マット
    if (task.kind === 'land') {
      const pts = C.circlePoints(task.pad.x, 0.004, task.pad.z, task.pad.r, 32);
      poly(cam, pts, 'rgba(126,227,164,.16)', 'rgba(126,227,164,.85)', 2);
      strokeLoop(cam, C.circlePoints(task.pad.x, 0.005, task.pad.z, task.pad.r * 0.45, 24), 'rgba(126,227,164,.5)', 1.5);
    }

    // 目標の真下 (どこを狙うかを床に出す)
    const tp = task.kind === 'hover' ? task.target : null;
    if (tp) {
      strokeLoop(cam, C.circlePoints(tp.x, 0.003, tp.z, task.radius, 32), 'rgba(126,227,164,.35)', 1.5);
    }

    // 飛んだ跡。濃さを 5 段階に丸めて、段ごとに 1 回で塗る (260 回 → 5 回)。
    const samples = app.run.samples;
    if (samples.length > 1) {
      const from = Math.max(1, samples.length - 260);
      const span = Math.max(1, samples.length - from);
      const BANDS = 5;
      for (let band = 0; band < BANDS; band++) {
        beginLines();
        let any = false;
        for (let i = from; i < samples.length; i++) {
          if (Math.min(BANDS - 1, Math.floor((i - from) / span * BANDS)) !== band) continue;
          const a = samples[i - 1], b = samples[i];
          addLine(cam, { x: a.x, y: 0.006, z: a.z }, { x: b.x, y: 0.006, z: b.z });
          any = true;
        }
        if (any) strokeLines('rgba(79,195,255,' + (0.06 + band / (BANDS - 1) * 0.28).toFixed(3) + ')', 2);
      }
    }

  }

  /**
   * 影と、機首の向きを示す矢印。どちらも床の上にある。
   * 家具と同じ列に入れて奥行き順に描く。床と一緒に描くと、
   * 機体が家具の手前にいるのに影だけ家具の裏に回ってしまう。
   */
  function drawFootMarks(cam, state) {
    // 影。**高さを読む唯一の手がかり**なので必ず描く。
    const h = Math.max(0, state.pos.y);
    const r = 0.20 + h * 0.075;
    const alpha = Math.max(0.06, 0.42 - h * 0.13);
    poly(cam, C.circlePoints(state.pos.x, 0.008, state.pos.z, r, 20), 'rgba(0,0,0,' + alpha.toFixed(3) + ')');

    if (!app.settings.assist) return;
    // 機首がどちらを向いているかを床に出す。
    // 対面で左右が分からなくなるのが最大の壁なので、ここを見れば分かるようにする。
    const c = Math.cos(state.yaw), sn = Math.sin(state.yaw);
    const fx = sn, fz = c, rx = c, rz = -sn;          // 前と右
    const L = 0.34, Wd = 0.13;
    const tip = { x: state.pos.x + fx * L, y: 0.012, z: state.pos.z + fz * L };
    const bl = { x: state.pos.x - fx * L * 0.35 - rx * Wd, y: 0.012, z: state.pos.z - fz * L * 0.35 - rz * Wd };
    const br = { x: state.pos.x - fx * L * 0.35 + rx * Wd, y: 0.012, z: state.pos.z - fz * L * 0.35 + rz * Wd };
    poly(cam, [tip, br, bl], 'rgba(79,195,255,.55)', 'rgba(140,220,255,.8)', 1.2);
  }

  function collectBox(cam, box, out) {
    const p = cam.pos;
    const faces = [
      { n: [0, 0, -1], v: [[box.min.x, box.min.y, box.min.z], [box.min.x, box.max.y, box.min.z], [box.max.x, box.max.y, box.min.z], [box.max.x, box.min.y, box.min.z]], shade: 0.80 },
      { n: [0, 0, 1], v: [[box.max.x, box.min.y, box.max.z], [box.max.x, box.max.y, box.max.z], [box.min.x, box.max.y, box.max.z], [box.min.x, box.min.y, box.max.z]], shade: 0.62 },
      { n: [-1, 0, 0], v: [[box.min.x, box.min.y, box.max.z], [box.min.x, box.max.y, box.max.z], [box.min.x, box.max.y, box.min.z], [box.min.x, box.min.y, box.min.z]], shade: 0.70 },
      { n: [1, 0, 0], v: [[box.max.x, box.min.y, box.min.z], [box.max.x, box.max.y, box.min.z], [box.max.x, box.max.y, box.max.z], [box.max.x, box.min.y, box.max.z]], shade: 0.70 },
      { n: [0, 1, 0], v: [[box.min.x, box.max.y, box.min.z], [box.min.x, box.max.y, box.max.z], [box.max.x, box.max.y, box.max.z], [box.max.x, box.max.y, box.min.z]], shade: 1.0 }
    ];
    const c = { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2 };
    faces.forEach(function (f) {
      // 裏を向いている面は描かない
      const fc = { x: 0, y: 0, z: 0 };
      f.v.forEach(function (v) { fc.x += v[0] / 4; fc.y += v[1] / 4; fc.z += v[2] / 4; });
      const toCam = [p.x - fc.x, p.y - fc.y, p.z - fc.z];
      if (f.n[0] * toCam[0] + f.n[1] * toCam[1] + f.n[2] * toCam[2] <= 0) return;
      const pts = f.v.map(function (v) { return { x: v[0], y: v[1], z: v[2] }; });
      const pr = C.projectPolygon(cam, pts);
      if (!pr) return;
      out.push({
        depth: pr.depth,
        draw: function () { poly(cam, pts, shadeColor(box.color, f.shade), 'rgba(0,0,0,.32)', 1); }
      });
    });
  }

  function shadeColor(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.round(((n >> 16) & 255) * k);
    const g = Math.round(((n >> 8) & 255) * k);
    const b = Math.round((n & 255) * k);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function collectTargets(cam, task, run, out) {
    if (task.kind === 'hover') {
      const t = task.target;
      const inZone = run.inZone;
      const col = inZone ? 'rgba(126,227,164,' : 'rgba(255,255,255,';
      // 上下の帯を 3 本の輪で示す = 「この筒の中にいろ」
      [[t.y - task.band, 0.30], [t.y, 0.85], [t.y + task.band, 0.30]].forEach(function (lv) {
        const pts = C.circlePoints(t.x, lv[0], t.z, task.radius, 30);
        const pr = C.projectPolygon(cam, pts);
        if (!pr) return;
        out.push({ depth: pr.depth, draw: function () { strokeLoop(cam, pts, col + lv[1] + ')', lv[1] > 0.5 ? 2.5 : 1.4); } });
      });
      // 筒の縦の柱
      for (let i = 0; i < 4; i++) {
        const a = i / 4 * Math.PI * 2;
        const px = t.x + Math.cos(a) * task.radius, pz = t.z + Math.sin(a) * task.radius;
        const A = { x: px, y: t.y - task.band, z: pz }, B = { x: px, y: t.y + task.band, z: pz };
        out.push({ depth: C.worldToView(cam, A).z, draw: function () { line3(cam, A, B, col + '0.30)', 1.2); } });
      }
    } else if (task.kind === 'altitude') {
      // 高さの帯を、部屋いっぱいの面で示す
      const room = app.env.room;
      [[task.targetY - task.band, 0.22], [task.targetY, 0.7], [task.targetY + task.band, 0.22]].forEach(function (lv) {
        const y = lv[0];
        const pts = [{ x: room.minX, y: y, z: room.minZ }, { x: room.maxX, y: y, z: room.minZ },
                     { x: room.maxX, y: y, z: room.maxZ }, { x: room.minX, y: y, z: room.maxZ }];
        const pr = C.projectPolygon(cam, pts);
        if (!pr) return;
        const col = run.inZone ? 'rgba(126,227,164,' : 'rgba(255,255,255,';
        out.push({ depth: pr.depth, draw: function () { strokeLoop(cam, pts, col + lv[1] + ')', lv[1] > 0.5 ? 2 : 1); } });
      });
    } else if (task.kind === 'gates') {
      task.gates.forEach(function (g, i) {
        const done = i < run.gateIndex;
        const now = i === run.gateIndex;
        const pts = C.ringPoints(g.x, g.y, g.z, g.r, g.nx, g.nz, 26);
        const pr = C.projectPolygon(cam, pts);
        if (!pr) return;
        out.push({
          depth: pr.depth,
          draw: function () {
            strokeLoop(cam, pts, done ? 'rgba(110,125,165,.35)' : (now ? 'rgba(126,227,164,.95)' : 'rgba(255,255,255,.28)'), now ? 3 : 1.5);
            if (now) strokeLoop(cam, C.ringPoints(g.x, g.y, g.z, g.r * 0.55, g.nx, g.nz, 20), 'rgba(126,227,164,.35)', 1.2);
            const s = C.projectPoint(cam, { x: g.x, y: g.y, z: g.z });
            if (s && !done) {
              ctx.fillStyle = now ? 'rgba(126,227,164,.95)' : 'rgba(255,255,255,.4)';
              ctx.font = (13 * dpr) + 'px -apple-system, sans-serif';
              ctx.textAlign = 'center';
              ctx.fillText(String(i + 1), s.x * dpr, (s.y + 5) * dpr);
            }
          }
        });
      });
    }
  }

  // ---------------------------------------------------------------- 機体
  const B = { x: 0, y: 0, z: 0 };
  function bw(state, x, y, z) { return C.bodyToWorld(state, { x: x, y: y, z: z }); }

  function drawDrone(cam, state) {
    const armR = 0.135;    // 機体中心からモーターまで
    const rotR = 0.075;    // プロペラ半径
    const bodyW = 0.052, bodyH = 0.024, bodyL = 0.085;

    const motors = [
      { x: armR, z: armR, front: true }, { x: -armR, z: armR, front: true },
      { x: armR, z: -armR, front: false }, { x: -armR, z: -armR, front: false }
    ];

    // 腕 (太めの線で描く。ポリゴンにするほどの大きさではない)
    const arms = motors.map(function (m) {
      const a = bw(state, m.x * 0.18, 0, m.z * 0.18);
      const b = bw(state, m.x, -0.004, m.z);
      return [{ x: a.x, y: a.y, z: a.z }, { x: b.x, y: b.y, z: b.z }];
    });
    for (const pass of [['#20242e', 5], ['#3a4152', 2.5]]) {
      beginLines();
      arms.forEach(function (a) { addLine(cam, a[0], a[1]); });
      strokeLines(pass[0], pass[1]);
    }

    // 胴体 (箱)
    const corners = [
      [-bodyW, bodyH, bodyL], [bodyW, bodyH, bodyL], [bodyW, bodyH, -bodyL], [-bodyW, bodyH, -bodyL],
      [-bodyW, -bodyH, bodyL], [bodyW, -bodyH, bodyL], [bodyW, -bodyH, -bodyL], [-bodyW, -bodyH, -bodyL]
    ].map(function (c) { const p = bw(state, c[0], c[1], c[2]); return { x: p.x, y: p.y, z: p.z }; });

    const bodyFaces = [
      { i: [4, 5, 6, 7], c: '#14171f' },  // 下
      { i: [0, 1, 5, 4], c: '#2b3140' },  // 前
      { i: [3, 2, 6, 7], c: '#1c2029' },  // 後
      { i: [1, 2, 6, 5], c: '#232833' },  // 右
      { i: [0, 3, 7, 4], c: '#232833' },  // 左
      { i: [0, 1, 2, 3], c: '#39404f' }   // 上
    ];
    bodyFaces.forEach(function (f) {
      poly(cam, f.i.map(function (i) { return corners[i]; }), f.c, 'rgba(0,0,0,.4)', 1);
    });

    // 前を向いている印。青い LED。これが無いと機首が分からない。
    const led = [
      bw(state, -bodyW * 0.8, bodyH * 0.15, bodyL * 1.02),
      bw(state, bodyW * 0.8, bodyH * 0.15, bodyL * 1.02),
      bw(state, bodyW * 0.8, -bodyH * 0.5, bodyL * 1.02),
      bw(state, -bodyW * 0.8, -bodyH * 0.5, bodyL * 1.02)
    ].map(function (p) { return { x: p.x, y: p.y, z: p.z }; });
    poly(cam, led, '#4fc3ff');
    // カメラの出っぱり
    const cm = bw(state, 0, -bodyH * 0.9, bodyL * 0.75);
    const cs = C.projectPoint(cam, cm);
    if (cs) {
      const f = C.focalLength(cam) / cs.z;
      ctx.fillStyle = '#0c0e14';
      ctx.beginPath(); ctx.arc(cs.x * dpr, cs.y * dpr, Math.max(1.4, 0.022 * f) * dpr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#5b7fa8';
      ctx.beginPath(); ctx.arc(cs.x * dpr, cs.y * dpr, Math.max(0.7, 0.011 * f) * dpr, 0, Math.PI * 2); ctx.fill();
    }

    // プロペラ。回っている勢いが分かるように、円盤 + 羽根 2 枚。
    motors.forEach(function (m, idx) {
      const hub = bw(state, m.x, 0.012, m.z);
      const disc = [];
      for (let i = 0; i < 10; i++) {
        const a = i / 10 * Math.PI * 2;
        const p = bw(state, m.x + Math.cos(a) * rotR, 0.012, m.z + Math.sin(a) * rotR);
        disc.push({ x: p.x, y: p.y, z: p.z });
      }
      const spinning = state.flying || state.throttleVis > 0.05;
      poly(cam, disc, spinning ? 'rgba(180,205,255,.13)' : 'rgba(150,165,195,.05)',
        spinning ? 'rgba(190,215,255,.30)' : 'rgba(150,165,195,.22)', 1);
      // 羽根
      const dir = (idx === 0 || idx === 3) ? 1 : -1;
      const phase = state.spin * dir + idx * 0.8;
      beginLines();
      for (let b = 0; b < 2; b++) {
        const a = phase + b * Math.PI;
        const p1 = bw(state, m.x + Math.cos(a) * rotR * 0.95, 0.013, m.z + Math.sin(a) * rotR * 0.95);
        const p2 = bw(state, m.x - Math.cos(a) * rotR * 0.1, 0.013, m.z - Math.sin(a) * rotR * 0.1);
        addLine(cam, { x: p1.x, y: p1.y, z: p1.z }, { x: p2.x, y: p2.y, z: p2.z });
      }
      strokeLines('rgba(215,230,255,.5)', 2);
      // モーター
      const hs = C.projectPoint(cam, { x: hub.x, y: hub.y, z: hub.z });
      if (hs) {
        const f = C.focalLength(cam) / hs.z;
        ctx.fillStyle = '#2a3040';
        ctx.beginPath(); ctx.arc(hs.x * dpr, hs.y * dpr, Math.max(1.2, 0.016 * f) * dpr, 0, Math.PI * 2); ctx.fill();
      }
    });

    // 高さの補助線。実機では影で読むが、画面では見えにくいので線も出す。
    if (app.settings.assist) {
      const foot = { x: state.pos.x, y: 0.01, z: state.pos.z };
      ctx.save();
      ctx.setLineDash([5 * dpr, 5 * dpr]);
      line3(cam, foot, { x: state.pos.x, y: state.pos.y - 0.02, z: state.pos.z }, 'rgba(79,195,255,.45)', 1.5);
      ctx.restore();
    }

    if (state.crashed) {
      const s = C.projectPoint(cam, state.pos);
      if (s) {
        ctx.fillStyle = 'rgba(255,107,107,.9)';
        ctx.font = (13 * dpr) + 'px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('✕', s.x * dpr, (s.y - 16) * dpr);
      }
    }
  }

  // ================================================================
  // HUD
  // ================================================================
  function updateHUD() {
    const run = app.run, state = app.state, task = run.task;
    els.hudTaskName.textContent = task.name;
    els.hudTaskGoal.textContent = task.goal;
    els.hudTime.innerHTML = run.elapsed.toFixed(1) + '<span>s</span>';

    let frac = 0;
    if (task.kind === 'hover' || task.kind === 'altitude') frac = run.hold / task.hold;
    else if (task.kind === 'gates') frac = run.gateIndex / task.gates.length;
    else if (task.kind === 'land') {
      const d = Math.hypot(state.pos.x - task.pad.x, state.pos.z - task.pad.z);
      frac = clamp(1 - d / 3.8, 0, 1);
    }
    els.hudProgress.style.width = Math.round(clamp(frac, 0, 1) * 100) + '%';
    // 残り時間が少なくなったら色を変える
    const left = 1 - run.elapsed / task.limit;
    els.hudProgress.classList.toggle('warn', left < 0.25);

    els.hudGauges.hidden = !app.settings.assist;
    if (app.settings.assist) {
      els.gaugeAlt.textContent = state.pos.y.toFixed(2);
      els.gaugeSpd.textContent = Math.hypot(state.vel.x, state.vel.z).toFixed(2);
      els.gaugeFps.textContent = app.fps
        ? Math.round(app.fps) + (app.renderScale < maxScale() ? '·' + app.renderScale + 'x' : '')
        : '–';
      els.hdArrow.setAttribute('transform', 'rotate(' + (state.yaw / DEG).toFixed(1) + ')');
    }

    if (app.toastUntil && performance.now() > app.toastUntil) {
      els.hudToast.hidden = true;
      app.toastUntil = 0;
    }
  }

  // ================================================================
  // ループ
  // ================================================================
  let lastCrashed = false;

  function frame(now) {
    requestAnimationFrame(frame);
    if (app.screen !== 'flight') { app.lastFrame = 0; return; }

    let dt = app.lastFrame ? (now - app.lastFrame) / 1000 : PHYS_DT;
    app.lastFrame = now;
    dt = Math.min(dt, 0.25);

    // fps は 0.5 秒ならしで
    app.fpsAcc += dt; app.fpsCount++;
    if (app.fpsAcc >= 0.5) { app.fps = app.fpsCount / app.fpsAcc; app.fpsAcc = 0; app.fpsCount = 0; }

    if (!app.paused) {
      app.acc += dt;
      let steps = 0;
      while (app.acc >= PHYS_DT && steps < MAX_STEPS) {
        const input = readSticks();
        app.input = input;
        C.step(app.state, input, PHYS_DT, app.env);
        T.stepRun(app.run, app.state, input, PHYS_DT, app.env);
        app.acc -= PHYS_DT;
        steps++;
        if (app.run.finished) break;
      }
      if (steps >= MAX_STEPS) app.acc = 0;   // 追いつけないぶんは捨てる

      updateCam(dt);

      if (app.state.crashed && !lastCrashed) {
        lastCrashed = true;
        toastBad(app.state.crashReason);
      }
      if (app.run.finished) {
        app.paused = true;
        // 少し余韻を置いてから結果を出す。その間に「やり直す」を押されることがあるので、
        // どの走行の結果かを覚えておいて、入れかわっていたら出さない。
        const finished = app.run;
        setTimeout(function () { finishFlight(finished); }, app.state.crashed ? 900 : 500);
      }
      updateTakeoffButton();
    }

    adaptScale(dt);
    renderKnobs(dt);
    drawScene();
    updateHUD();
  }

  // ================================================================
  // 設定 UI
  // ================================================================
  function bindSeg(el, key, onChange) {
    el.addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-v]');
      if (!btn) return;
      const v = Number(btn.dataset.v);
      app.settings[key] = v;
      Array.prototype.forEach.call(el.querySelectorAll('button'), function (b) {
        b.classList.toggle('on', Number(b.dataset.v) === v);
      });
      saveSoon();
      if (onChange) onChange(v);
    });
  }

  function syncSettingsUI() {
    [['setMode', 'mode'], ['setDifficulty', 'difficulty'], ['setAltHold', 'altHold'], ['setAssist', 'assist']]
      .forEach(function (pair) {
        const el = els[pair[0]], v = app.settings[pair[1]];
        Array.prototype.forEach.call(el.querySelectorAll('button'), function (b) {
          b.classList.toggle('on', Number(b.dataset.v) === v);
        });
      });
    els.modeNote.textContent = app.settings.mode === 1
      ? '左=前後/旋回、右=上下/左右。日本の古い送信機に多い並び。'
      : '左=上下/旋回、右=前後/左右。海外製トイドローンの標準。';
    els.altHoldNote.textContent = app.settings.altHold
      ? '気圧センサーつき。スロットルを戻すとその高さで止まります。'
      : 'スロットル = 推力そのもの。中央あたりでつり合い、戻すと落ちます。スティックは戻りません。';
    updateStickLabels();
  }

  // ================================================================
  // 起動
  // ================================================================
  function main() {
    bindStick(sticks.left);
    bindStick(sticks.right);

    bindSeg(els.setMode, 'mode', syncSettingsUI);
    bindSeg(els.setDifficulty, 'difficulty');
    bindSeg(els.setAltHold, 'altHold', syncSettingsUI);
    bindSeg(els.setAssist, 'assist');
    syncSettingsUI();

    els.btnMenu.addEventListener('click', function () { app.paused = true; setScreen('menu'); });
    els.btnTakeoff.addEventListener('click', toggleTakeoff);
    els.btnRetry.addEventListener('click', function () { startTask(app.taskId); });
    els.btnResRetry.addEventListener('click', function () { startTask(app.taskId); });
    els.btnResMenu.addEventListener('click', function () { setScreen('menu'); });
    els.btnResNext.addEventListener('click', function () {
      const i = T.TASKS.findIndex(function (t) { return t.id === app.taskId; });
      startTask(T.TASKS[Math.min(i + 1, T.TASKS.length - 1)].id);
    });

    // 画面のスクロールとピンチを止める (iOS)
    document.addEventListener('touchmove', function (e) {
      if (app.screen === 'flight') e.preventDefault();
    }, { passive: false });
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
    document.addEventListener('dblclick', function (e) { e.preventDefault(); }, { passive: false });

    resize();
    setScreen('menu');
    requestAnimationFrame(frame);

    // 自動テストから中身をのぞくための入口
    window.__app = {
      app: app,
      sticks: sticks,
      startTask: startTask,
      setScreen: setScreen,
      state: function () { return app.state; },
      run: function () { return app.run; },
      settings: function () { return app.settings; },
      setStick: function (side, x, y) { sticks[side].x = x; sticks[side].y = y; },
      input: function () { return app.input; },
      toggleTakeoff: toggleTakeoff,
      updateCam: updateCam,
      resize: resize,
      // 速さの計測用。どこが重いかを部品ごとに測れるようにする。
      bench: { drawScene: drawScene, renderKnobs: renderKnobs, updateHUD: updateHUD, readSticks: readSticks },
      renderScale: function () { return app.renderScale; },
      setRenderScale: function (v) { app.renderScale = v; resize(); },
      // テストで時間を早送りする
      simulate: function (seconds, inputFn) {
        const n = Math.round(seconds / PHYS_DT);
        for (let i = 0; i < n && !app.run.finished; i++) {
          const input = inputFn ? inputFn(app.state, app.run, i * PHYS_DT) : readSticks();
          app.input = input;
          C.step(app.state, input, PHYS_DT, app.env);
          T.stepRun(app.run, app.state, input, PHYS_DT, app.env);
        }
        return app.run;
      }
    };
  }

  main();
})();
