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

  // ---------------------------------------------------------------- 自己ベストのゴースト
  const GHOST_KEY = 'dorone.ghost.v1.';
  const GHOST_STEP = 0.20;     // この間隔で間引いて残す (localStorage を食いつぶさないため)

  /**
   * 軌跡を「0.2 秒ごとの x, y, z, yaw」だけにして、小数 2 桁の整数で持つ。
   * 150 秒の走行でも 15KB ほどに収まる。
   */
  function packGhost(samples) {
    const out = [];
    let next = 0;
    for (const s of samples) {
      if (s.t < next) continue;
      next = s.t + GHOST_STEP;
      out.push(Math.round(s.x * 100), Math.round(s.y * 100), Math.round(s.z * 100), Math.round(s.yaw * 100));
    }
    return out;
  }

  function saveGhost(taskId, run) {
    if (!run.success) return;
    try {
      const prev = JSON.parse(localStorage.getItem(GHOST_KEY + taskId) || 'null');
      // 速いほうを残す
      if (prev && prev.elapsed <= run.elapsed) return;
      localStorage.setItem(GHOST_KEY + taskId, JSON.stringify({
        elapsed: run.elapsed, stars: run.stars, step: GHOST_STEP, d: packGhost(run.samples)
      }));
    } catch (e) { /* 保存できなくても動作には影響しない */ }
  }

  function loadGhost(taskId) {
    try {
      const g = JSON.parse(localStorage.getItem(GHOST_KEY + taskId) || 'null');
      return g && g.d && g.d.length >= 8 ? g : null;
    } catch (e) { return null; }
  }

  /** ゴーストの、その時刻の位置。間を補間する。終わっていたら null。 */
  function ghostAt(g, t) {
    const n = g.d.length / 4;
    const f = t / g.step;
    if (f >= n - 1) return null;
    const i = Math.floor(f), a = f - i, b = i * 4, c = b + 4;
    const mix = function (o) { return (g.d[b + o] * (1 - a) + g.d[c + o] * a) / 100; };
    // 方位は -π..π をまたぐので、そのまま混ぜない
    const y0 = g.d[b + 3] / 100, y1 = g.d[c + 3] / 100;
    return { x: mix(0), y: mix(1), z: mix(2), yaw: y0 + C.wrapPi(y1 - y0) * a };
  }

  // ---------------------------------------------------------------- 状態
  const app = {
    screen: 'menu',
    settings: loadJSON(SETTINGS_KEY, { mode: 2, difficulty: 1, altHold: 1, assist: 1, battery: 1, sound: 1, night: 0 }),
    progress: loadJSON(PROGRESS_KEY, {}),
    battery: 1,
    ghost: null,
    night: false,
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
    'hdArrow', 'gaugeFps', 'hudToast', 'hudGauges', 'taskList', 'stickL', 'stickR', 'hudProgressBar',
    'gaugeBattery', 'batteryPct', 'batteryLeft', 'batteryFill', 'btnBattery', 'setBattery', 'btnNight',
    'setSound', 'setNight', 'nightNote', 'btnReplay', 'replay', 'replaySeek', 'replayPlay', 'replayTime',
    'replayClose', 'replayStickL', 'replayStickR', 'replayNote', 'batteryNote',
    'knobL', 'knobR', 'labelL', 'labelR', 'resVerdict', 'resStars', 'resMsg',
    'resScores', 'resNotes', 'chartTop', 'chartAlt', 'btnResRetry', 'btnResNext',
    'btnResMenu', 'setMode', 'setDifficulty', 'setAltHold', 'setAssist', 'modeNote', 'altHoldNote'
  ].forEach(function (id) { els[id] = document.getElementById(id); });

  const ctx = els.view.getContext('2d');
  const S = window.Sound;

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
    config.battery = !!app.settings.battery;

    app.env = { room: C.createRoom(), config: config, wind: null };
    // 電池は走行をまたいで持ちこす。実機と同じで、1 本で何回か飛ばす。
    app.state = C.createState({ start: task.start, yaw: task.startYaw || 0, battery: app.battery });
    T.prepare(task, app.state, app.env, seed);
    app.run = T.createRun(task.id, seed);
    app.ghost = loadGhost(task.id);
    applyNight();
    lastCrashed = false;

    // 高度維持オフのときは、スロットルのスティックは戻らない (実機の送信機と同じ)
    const side = C.throttleSide(app.settings.mode);
    sticks.left.stickyY = sticks.right.stickyY = false;
    sticks[side].stickyY = !app.settings.altHold;
    sticks.left.x = sticks.left.y = sticks.right.x = sticks.right.y = 0;
    resetSoundMemory();
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
    if (app.ghost) {
      // 遅らせて出すあいだに別の課題へ移ることがある。
      // どの走行に向けたものかを覚えておいて、入れかわっていたら出さない。
      const forRun = app.run, gh = app.ghost;
      setTimeout(function () {
        if (app.run !== forRun || app.ghost !== gh || app.screen !== 'flight') return;
        if (app.run.elapsed < 6) toast('金色は自己ベスト (' + gh.elapsed.toFixed(1) + '秒) のゴーストです', 3400);
      }, 4400);
    }
  }

  /**
   * カメラを機体の方へ向ける。
   * 目で追うように、デッドゾーンの中は動かさない (動いている感じを残すため)。
   * ただし速く動かれると追いつけないので、最後に固い上限をかけて画面から出さない。
   * デッドゾーンも上限も「画面上の距離」で決める。角度で決め打ちにすると、
   * 横向きのときに上下がはみ出す。
   */
  function cameraOpts() {
    const f = C.focalLength(app.cam);
    const usableH = app.usableH || app.cam.height;
    return {
      deadYaw: Math.atan((app.cam.width / 2) * 0.26 / f) / DEG,
      deadPitch: Math.atan((usableH / 2) * 0.26 / f) / DEG,
      rate: 2.6,
      // 画面の端から 22% 内側より外には、絶対に出さない
      maxYaw: Math.atan((app.cam.width / 2) * 0.78 / f),
      maxPitch: Math.atan((usableH / 2) * 0.78 / f)
    };
  }

  function updateCam(dt) {
    C.updateCamera(app.cam, app.state.pos, dt, cameraOpts());
  }

  /**
   * 灯りを消すかどうか。設定で決める。
   * 課題側で night: true を付ければ、その課題だけ夜にもできる。
   */
  function applyNight() {
    const task = app.run ? app.run.task : T.findTask(app.taskId);
    app.night = !!((task && task.night) || app.settings.night);
    els.btnNight.textContent = app.night ? '☀' : '🌙';
    els.btnNight.setAttribute('aria-pressed', app.night ? 'true' : 'false');
    return app.night;
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
    saveGhost(run.task.id, run);
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
    els.replay.hidden = name !== 'replay';
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
      btn.dataset.task = task.id;
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
    if (task.pad) { c.beginPath(); c.arc(X(task.pad.x), Z(task.pad.z), task.pad.r * s, 0, Math.PI * 2); c.stroke(); }
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
  // 1 倍より下も試したが、測ったら速くならなかった (ここではラスタライズが
  // 律速ではない)。ぼやけるだけなので入れない。
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

  /**
   * 昼と夜の色。夜は「部屋の灯りを消した」状態。
   * 実機でも暗いところでは LED の色でしか向きが分からない。そこを練習する。
   */
  const PALETTE = {
    day: {
      floor: '#20283f', ceiling: '#171d31', wallBack: '#1c2338', wallSide: '#1a2134',
      gridMinor: 'rgba(150,175,230,.07)', gridMajor: 'rgba(150,175,230,.16)',
      skirting: 'rgba(255,255,255,.10)',
      furniture: 1, furnitureEdge: 'rgba(0,0,0,.32)',
      shadow: 1, glow: 0,
      ring: '255,255,255', ringOn: '126,227,164',
      bgTop: '#131a2e', bgBottom: '#0b0e18',
      skyTop: '#1d2b4d', skyHorizon: '#3b4d75', ground: '#26324a', edge: 'rgba(150,180,240,.35)'
    },
    night: {
      floor: '#0a0d17', ceiling: '#070911', wallBack: '#0b0e19', wallSide: '#090b15',
      gridMinor: 'rgba(120,150,215,.025)', gridMajor: 'rgba(120,150,215,.055)',
      skirting: 'rgba(255,255,255,.035)',
      furniture: 0.26, furnitureEdge: 'rgba(150,175,235,.10)',
      shadow: 0.25, glow: 1,
      ring: '190,215,255', ringOn: '126,227,164',
      bgTop: '#070911', bgBottom: '#04060c',
      skyTop: '#04060e', skyHorizon: '#0a1020', ground: '#0b1019', edge: 'rgba(150,180,240,.14)'
    }
  };

  function pal() { return app.night ? PALETTE.night : PALETTE.day; }

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

  /** 投影ずみの点を、いまのパスに足す。 */
  function tracePts(pts) {
    ctx.moveTo(pts[0].x * dpr, pts[0].y * dpr);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * dpr, pts[i].y * dpr);
    ctx.closePath();
  }

  /**
   * ゲートを「帯のある輪っか」として描く。
   * 細い線 1 本だと、どこが穴でどこが枠なのか分からない。
   * 外周と内周の 2 つの輪を作り、そのあいだだけを塗る (evenodd)。
   */
  function drawHoop(cam, g, style) {
    // 帯を塗るのは高くつく (遅い端末で 6 つ塗ると 1 フレームに 2.6ms)。
    // いま狙う輪と次の輪だけ塗って、その先は細い線 1 本にする。
    if (style.mode === 'line') {
      const mid = C.ringPoints(g.x, g.y, g.z, g.r, g.nx, g.nz, 16);
      strokeLoop(cam, mid, style.edge, style.lw || 1);
      return C.projectPolygon(cam, mid);
    }
    const seg = style.mode === 'full' ? 30 : 20;
    const outer = C.ringPoints(g.x, g.y, g.z, g.r * 1.16, g.nx, g.nz, seg);
    const inner = C.ringPoints(g.x, g.y, g.z, g.r * 0.88, g.nx, g.nz, seg);
    const po = C.projectPolygon(cam, outer);
    if (!po) return null;
    const pi = C.projectPolygon(cam, inner);
    ctx.beginPath();
    tracePts(po.pts);
    if (pi) tracePts(pi.pts);
    ctx.fillStyle = style.fill;
    ctx.fill('evenodd');
    if (style.edge) {
      ctx.strokeStyle = style.edge;
      ctx.lineWidth = (style.lw || 1.5) * dpr;
      ctx.beginPath(); tracePts(po.pts); ctx.stroke();
      // 内側のふちは、いま狙う輪だけ。数を減らすほど軽い。
      if (pi && style.mode === 'full') { ctx.beginPath(); tracePts(pi.pts); ctx.stroke(); }
    }
    return po;
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

  function drawScene(override) {
    const cam = app.cam, room = app.env.room;
    const state = override || app.state;
    const task = (app.screen === 'replay' ? replay.task : app.run.task) || app.run.task;
    const W = els.view.width, H = els.view.height;

    // 背景 (奥の壁より遠くは見えないので、暗い下地だけ)
    const P = pal();
    const g = ctx.createLinearGradient(0, 0, 0, H);
    if (room.open) {
      // 空。地面の向こう側は空になる。
      g.addColorStop(0, P.skyTop);
      g.addColorStop(1, P.skyHorizon);
    } else {
      g.addColorStop(0, P.bgTop);
      g.addColorStop(1, P.bgBottom);
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // ---- 部屋の外殻。中にいるので、これを先に描けば必ず正しい順になる ----
    const shell = [];
    const y0 = 0, y1 = room.height;
    const x0 = room.minX, x1 = room.maxX, z0 = room.minZ, z1 = room.maxZ;

    if (room.open) {
      // 広場。壁も天井もない。地面 1 枚とグリッドだけなので、部屋より軽い。
      drawFloor(cam, room, state, task);
      drawInterior(cam, room, state, task, override);
      return;
    }

    shell.push({ depth: 1e6, draw: function () { drawFloor(cam, room, state, task); } });
    // 天井。照明を描いてみたが、画面の上端は遠近が強くかかるので、
    // 四角い光がゆがんで「描画の失敗」に見えた。素のままにしておく。
    shell.push({ depth: 9e5, draw: function () { poly(cam, [{ x: x0, y: y1, z: z0 }, { x: x1, y: y1, z: z0 }, { x: x1, y: y1, z: z1 }, { x: x0, y: y1, z: z1 }], P.ceiling); } });
    // 壁。奥ほど暗くして奥行きを出す。
    shell.push({ depth: 8e5, draw: function () { drawWall(cam, [{ x: x0, y: y0, z: z1 }, { x: x1, y: y0, z: z1 }, { x: x1, y: y1, z: z1 }, { x: x0, y: y1, z: z1 }], P.wallBack); } });
    shell.push({ depth: 7e5, draw: function () { drawWall(cam, [{ x: x0, y: y0, z: z0 }, { x: x0, y: y0, z: z1 }, { x: x0, y: y1, z: z1 }, { x: x0, y: y1, z: z0 }], P.wallSide); } });
    shell.push({ depth: 6e5, draw: function () { drawWall(cam, [{ x: x1, y: y0, z: z1 }, { x: x1, y: y0, z: z0 }, { x: x1, y: y1, z: z0 }, { x: x1, y: y1, z: z1 }], P.wallSide); } });
    shell.forEach(function (s) { s.draw(); });

    drawInterior(cam, room, state, task, override);
  }

  /**
   * 中にあるもの (家具・輪・機体) を、奥から順に描く。
   * override はリプレイ中の機体の状態。live でないときはゴーストを出さない。
   */
  function drawInterior(cam, room, state, task, override) {
    const items = [];
    room.furniture.forEach(function (f) { collectBox(cam, f, items); });
    if (room.decals) room.decals.forEach(function (d) { collectDecal(cam, d, items); });
    collectTargets(cam, task, app.run, items);
    if (state.payload) {
      const p = state.payload;
      items.push({ depth: C.worldToView(cam, { x: p.x, y: p.y, z: p.z }).z, draw: function () { drawPayload(cam, state); } });
    }
    if (app.env.cat) {
      const c = app.env.cat;
      items.push({ depth: C.worldToView(cam, { x: c.x, y: 0.2, z: c.z }).z, draw: function () { drawCat(cam, c); } });
    }
    if (app.ghost && !override) {
      const g = ghostAt(app.ghost, app.run.elapsed);
      if (g) items.push({ depth: C.worldToView(cam, g).z, draw: function () { drawGhost(cam, g); } });
    }
    const footZ = C.worldToView(cam, { x: state.pos.x, y: 0, z: state.pos.z }).z;
    items.push({ depth: footZ + 0.001, draw: function () { drawFootMarks(cam, state); } });
    items.push({ depth: C.worldToView(cam, state.pos).z, draw: function () { drawDrone(cam, state); } });
    items.sort(function (a, b) { return b.depth - a.depth; });
    items.forEach(function (it) { it.draw(); });

    // 次にくぐる輪が画面の外にあるなら、端に矢印を出す。
    // 「どっちを向けばいいのか」が分からないのが、いちばん困る。
    if (task.kind === 'gates' && app.run.gateIndex < task.gates.length) {
      drawOffscreenCue(cam, task.gates[app.run.gateIndex], app.run.gateIndex + 1);
    }
  }

  function drawOffscreenCue(cam, g, label) {
    const w = cam.width, h = app.usableH || cam.height;
    const m = 34;                     // 矢印を置く位置 (端からの余白)
    const v = C.worldToView(cam, { x: g.x, y: g.y, z: g.z });
    const s = v.z >= C.NEAR ? C.projectView(cam, v) : null;
    // 「見えているか」は余白なしで判定する。余白ぶんで判定すると、
    // 輪が画面に映っているのに矢印も出て、番号が二重になる。
    if (s && s.x > 0 && s.x < w && s.y > 0 && s.y < h) return;

    let x, y;
    if (s) {
      x = clamp(s.x, m, w - m);
      y = clamp(s.y, m, h - m);
    } else {
      // カメラの後ろ。左右は方位の差で決める。
      const dYaw = C.wrapPi(Math.atan2(g.x - cam.pos.x, g.z - cam.pos.z) - cam.yaw);
      const dPitch = Math.atan2(g.y - cam.pos.y, Math.hypot(g.x - cam.pos.x, g.z - cam.pos.z)) - cam.pitch;
      x = dYaw > 0 ? w - m : m;
      y = clamp(cam.cy - C.focalLength(cam) * Math.tan(clamp(dPitch, -1.2, 1.2)), m, h - m);
    }
    const ang = Math.atan2(y - cam.cy, x - cam.cx);

    ctx.save();
    ctx.translate(x * dpr, y * dpr);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(16 * dpr, 0);
    ctx.lineTo(-9 * dpr, 11 * dpr);
    ctx.lineTo(-4 * dpr, 0);
    ctx.lineTo(-9 * dpr, -11 * dpr);
    ctx.closePath();
    ctx.fillStyle = 'rgba(126,227,164,.92)';
    ctx.fill();
    ctx.restore();

    ctx.font = '700 ' + (12 * dpr) + 'px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3.5 * dpr;
    ctx.strokeStyle = 'rgba(8,11,20,.85)';
    ctx.strokeText(String(label), x * dpr - Math.cos(ang) * 22 * dpr, y * dpr - Math.sin(ang) * 22 * dpr + 4 * dpr);
    ctx.fillStyle = 'rgba(180,255,210,.98)';
    ctx.fillText(String(label), x * dpr - Math.cos(ang) * 22 * dpr, y * dpr - Math.sin(ang) * 22 * dpr + 4 * dpr);
  }

  function drawWall(cam, pts, base) {
    poly(cam, pts, base);
    // 巾木で床との境目を出す。境目が見えないと高さが読めない。
    line3(cam, pts[0], pts[1], pal().skirting, 1.5);
  }

  function drawFloor(cam, room, state, task) {
    const s = state;
    const x0 = room.minX, x1 = room.maxX, z0 = room.minZ, z1 = room.maxZ;
    const P = pal();
    const corners = [{ x: x0, y: 0, z: z0 }, { x: x1, y: 0, z: z0 }, { x: x1, y: 0, z: z1 }, { x: x0, y: 0, z: z1 }];
    poly(cam, corners, room.open ? P.ground : P.floor);
    // 広場の端。ここから先へは行けない、と分かるように線を引く。
    if (room.open) strokeLoop(cam, corners, P.edge, 2);

    // 家具の足もとを暗くする。置いてある感じが出て、床との境目が読める。
    room.furniture.forEach(function (f) {
      if (f.min.y > 0.02) return;                      // 浮いているもの (天板) は除く
      const m = 0.07;
      poly(cam, [
        { x: f.min.x - m, y: 0.002, z: f.min.z - m }, { x: f.max.x + m, y: 0.002, z: f.min.z - m },
        { x: f.max.x + m, y: 0.002, z: f.max.z + m }, { x: f.min.x - m, y: 0.002, z: f.max.z + m }
      ], 'rgba(0,0,0,' + (0.30 * P.shadow + 0.05).toFixed(3) + ')');
    });

    // グリッド。距離感の手がかりになる。
    // 細い線と太い線で、色ごとに 1 回ずつ塗る (数十回 → 2 回)。
    // 広場は部屋より広いので、間隔を倍にして線の数を同じくらいに保つ。
    const step = room.open ? 1 : 0.5;
    const bigEvery = step * 2;
    for (const major of [false, true]) {
      beginLines();
      for (let x = Math.ceil(x0 / step) * step; x <= x1 + 1e-6; x += step) {
        if ((Math.abs(x % bigEvery) < 0.01) !== major) continue;
        addLine(cam, { x: x, y: 0.001, z: z0 }, { x: x, y: 0.001, z: z1 });
      }
      for (let z = Math.ceil(z0 / step) * step; z <= z1 + 1e-6; z += step) {
        if ((Math.abs(z % bigEvery) < 0.01) !== major) continue;
        addLine(cam, { x: x0, y: 0.001, z: z }, { x: x1, y: 0.001, z: z });
      }
      strokeLines(major ? P.gridMajor : P.gridMinor, 1);
    }

    // 着陸マット / 荷物を置く台
    if (task.pad) {
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
    // リプレイ中は「いまの時刻まで」しか出さない。先が見えていては見る意味がない。
    let samples = app.run.samples;
    if (app.screen === 'replay' && replay.samples) {
      samples = replay.samples;
      let n = samples.length;
      while (n > 1 && samples[n - 1].t > replay.t) n--;
      samples = samples.slice(0, n);
    }
    app.drawnTrail = Math.max(0, samples.length - 1);
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
    const P = pal();
    const h = Math.max(0, state.pos.y);

    // 夜は、機体の LED が足もとの床をぼんやり照らす。
    // 暗いと影が見えないので、これが高さを読む手がかりになる。
    if (P.glow) {
      const lr = 0.42 + h * 0.42;
      for (let i = 3; i >= 1; i--) {
        const k = i / 3;
        poly(cam, C.circlePoints(state.pos.x, 0.004, state.pos.z, lr * k, 18),
          'rgba(150,190,255,' + (0.055 / k * Math.max(0.15, 1 - h * 0.32)).toFixed(3) + ')');
      }
    }

    // 影。**高さを読む唯一の手がかり**なので必ず描く。
    // 高いほど大きく、ぼやける。1 枚のべた塗りだと切り抜きに見える。
    const r = 0.20 + h * 0.075;
    const base = Math.max(0.06, 0.42 - h * 0.13) * P.shadow;
    for (let i = 0; i < 3; i++) {
      const k = 1 + i * 0.36 * Math.min(1, 0.3 + h * 0.5);   // 高いほど外へ広がる
      poly(cam, C.circlePoints(state.pos.x, 0.008, state.pos.z, r * k, 18),
        'rgba(0,0,0,' + (base * 0.42).toFixed(3) + ')');
    }

    if (!app.settings.assist) return;
    // 機首がどちらを向いているかを床に出す。
    // 対面で左右が分からなくなるのが最大の壁なので、ここを見れば分かるようにする。
    const c = Math.cos(state.yaw), sn = Math.sin(state.yaw);
    const fx = sn, fz = c, rx = c, rz = -sn;          // 前と右
    const L = 0.26, Wd = 0.10;
    const tip = { x: state.pos.x + fx * L, y: 0.012, z: state.pos.z + fz * L };
    const bl = { x: state.pos.x - fx * L * 0.35 - rx * Wd, y: 0.012, z: state.pos.z - fz * L * 0.35 - rz * Wd };
    const br = { x: state.pos.x - fx * L * 0.35 + rx * Wd, y: 0.012, z: state.pos.z - fz * L * 0.35 + rz * Wd };
    poly(cam, [tip, br, bl], 'rgba(79,195,255,.42)', 'rgba(140,220,255,.65)', 1.2);
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
      // 画面で数画素にしかならない面は描かない。
      // 家具を細かい箱で作ると面の数が増えるので、ここで効いてくる。
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const q of pr.pts) {
        if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
        if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
      }
      const area = (x1 - x0) * (y1 - y0);
      if (area < 8) return;
      // 小さい面のふち取りは見えないわりに高い。大きい面だけ描く。
      const edged = area > 900;
      out.push({
        depth: pr.depth,
        draw: function () {
          const P = pal();
          poly(cam, pts, shadeColor(box.color, f.shade * P.furniture), edged ? P.furnitureEdge : null, 1);
        }
      });
    });
  }

  /**
   * 面に貼るだけの板 (本の背表紙など)。1 枚の塗りだけ。ふちは描かない。
   * 小さい箱を並べるより軽く、飛び出して見えることもない。
   */
  function collectDecal(cam, d, out) {
    const pr = C.projectPolygon(cam, d.pts);
    if (!pr) return;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const q of pr.pts) {
      if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
      if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
    }
    if ((x1 - x0) * (y1 - y0) < 4) return;
    out.push({
      depth: pr.depth,
      draw: function () { poly(cam, d.pts, shadeColor(d.color, pal().furniture)); }
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
      const P = pal();
      const col = 'rgba(' + (inZone ? P.ringOn : P.ring) + ',';
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
        const P = pal();
        const col = 'rgba(' + (run.inZone ? P.ringOn : P.ring) + ',';
        out.push({ depth: pr.depth, draw: function () { strokeLoop(cam, pts, col + lv[1] + ')', lv[1] > 0.5 ? 2 : 1); } });
      });
    } else if (task.kind === 'gates') {
      // 「いま狙う輪」だけがはっきり分かるように、はっきり差をつける。
      //   くぐった輪 … 消えかけ
      //   いまの輪   … 濃い帯 + 太いふち + ゆっくり明滅 + 大きい番号
      //   次の輪     … 中くらい
      //   その先     … 細いふちだけ (コース全体は見えるように残す)
      const pulse = 0.84 + 0.16 * Math.sin(performance.now() * 0.0042);
      task.gates.forEach(function (g, i) {
        const step = i - run.gateIndex;
        if (step < 0 && step > -1.5) { /* 直前にくぐった輪も薄く残す */ }
        const style = step < 0
          ? { mode: 'line', edge: 'rgba(110,125,165,.24)', lw: 1, num: 0 }
          : step === 0
            ? { mode: 'full', fill: 'rgba(126,227,164,' + (0.30 * pulse).toFixed(3) + ')',
                edge: 'rgba(150,255,190,' + pulse.toFixed(3) + ')', lw: 3, num: 1 }
            : step === 1
              ? { mode: 'band', fill: 'rgba(200,225,255,.10)', edge: 'rgba(200,225,255,.48)', lw: 1.8, num: 0.55 }
              : { mode: 'line', edge: 'rgba(200,225,255,.30)', lw: 1.3, num: 0.34 };

        const probe = C.projectPolygon(cam, C.ringPoints(g.x, g.y, g.z, g.r, g.nx, g.nz, 10));
        if (!probe) return;
        out.push({
          depth: probe.depth + (step === 0 ? -0.002 : 0),   // いまの輪はいちばん手前に
          draw: function () {
            drawHoop(cam, g, style);
            if (!style.num) return;
            const s = C.projectPoint(cam, { x: g.x, y: g.y, z: g.z });
            // 画面の上のほうは HUD の文字が乗っている。そこには番号を出さない。
            if (!s || s.y < 118) return;
            const size = (step === 0 ? 24 : 14) * dpr;
            ctx.font = '700 ' + size + 'px -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.lineWidth = 4 * dpr;
            ctx.strokeStyle = 'rgba(8,11,20,.85)';
            ctx.strokeText(String(i + 1), s.x * dpr, s.y * dpr + size * 0.35);
            ctx.fillStyle = step === 0 ? 'rgba(180,255,210,.98)' : 'rgba(210,230,255,' + style.num + ')';
            ctx.fillText(String(i + 1), s.x * dpr, s.y * dpr + size * 0.35);
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
    const armDark = pal().glow ? 0.4 : 1;
    for (const pass of [[shadeColor('#20242e', armDark), 5], [shadeColor('#3a4152', armDark), 2.5]]) {
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
    const nightK = pal().glow ? 0.42 : 1;
    bodyFaces.forEach(function (f) {
      poly(cam, f.i.map(function (i) { return corners[i]; }), shadeColor(f.c, nightK), 'rgba(0,0,0,.4)', 1);
    });

    // 航法灯。**前が白、後ろが赤。** 実機と同じ決まりで、暗いところでは
    // これだけが向きの手がかりになる。
    //
    // 灯りは機体の前面と後面に付いている。裏側のものまで描くと、
    // どちらを向いていても赤と白が両方見えてしまい、向きが読めなくなる。
    // カメラに向いている側だけを光らせる。
    const noseW = bw(state, 0, 0, 1);
    const nx = noseW.x - state.pos.x, ny = noseW.y - state.pos.y, nz = noseW.z - state.pos.z;
    let cx = cam.pos.x - state.pos.x, cy2 = cam.pos.y - state.pos.y, cz = cam.pos.z - state.pos.z;
    const cl = Math.hypot(cx, cy2, cz) || 1;
    cx /= cl; cy2 /= cl; cz /= cl;
    const toward = nx * cx + ny * cy2 + nz * cz;        // +1 = 機首がこちら
    const frontVis = clamp((toward + 0.30) / 0.85, 0, 1);
    const rearVis = clamp((-toward + 0.30) / 0.85, 0, 1);

    function ledStrip(zSign, rgb, vis) {
      if (vis < 0.03) return;
      const z = bodyL * 1.02 * zSign;
      const pts = [
        bw(state, -bodyW * 0.8, bodyH * 0.15, z),
        bw(state, bodyW * 0.8, bodyH * 0.15, z),
        bw(state, bodyW * 0.8, -bodyH * 0.5, z),
        bw(state, -bodyW * 0.8, -bodyH * 0.5, z)
      ].map(function (p) { return { x: p.x, y: p.y, z: p.z }; });
      poly(cam, pts, 'rgba(' + rgb + ',' + vis.toFixed(3) + ')');
    }
    ledStrip(1, '223,242,255', frontVis);
    ledStrip(-1, '255,77,85', rearVis);

    // モーターの根もとにも小さな灯り (前 2 つが白、後ろ 2 つが赤)
    const lamps = motors.map(function (m) {
      return {
        p: bw(state, m.x, 0.016, m.z),
        rgb: m.front ? '223,242,255' : '255,77,85',
        vis: m.front ? frontVis : rearVis
      };
    });
    lamps.forEach(function (l) {
      if (l.vis < 0.05) return;
      const s = C.projectPoint(cam, l.p);
      if (!s) return;
      const f = C.focalLength(cam) / s.z;
      ctx.fillStyle = 'rgba(' + l.rgb + ',' + l.vis.toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(s.x * dpr, s.y * dpr, Math.max(1, 0.013 * f) * dpr, 0, Math.PI * 2); ctx.fill();
    });

    // 暗いところでは、灯りのまわりがにじむ
    if (pal().glow) {
      const halos = lamps.concat([
        { p: bw(state, 0, 0, bodyL * 1.02), rgb: '190,225,255', vis: frontVis },
        { p: bw(state, 0, 0, -bodyL * 1.02), rgb: '255,90,100', vis: rearVis }
      ]);
      halos.forEach(function (l) {
        if (l.vis < 0.05) return;
        const s = C.projectPoint(cam, l.p);
        if (!s) return;
        const f = C.focalLength(cam) / s.z;
        // 外は薄く広く、中は濃く小さく。これをやらないと霧のように見える。
        const core = Math.max(1.5, 0.028 * f);
        for (let i = 3; i >= 1; i--) {
          ctx.fillStyle = 'rgba(' + l.rgb + ',' + ([0.15, 0.07, 0.035][i - 1] * l.vis).toFixed(3) + ')';
          ctx.beginPath();
          ctx.arc(s.x * dpr, s.y * dpr, core * (0.55 + i * 0.62) * dpr, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    }
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
      const dk = pal().glow ? 0.22 : 1;
      poly(cam, disc, 'rgba(180,205,255,' + ((spinning ? 0.13 : 0.05) * dk).toFixed(3) + ')',
        'rgba(190,215,255,' + ((spinning ? 0.30 : 0.22) * dk).toFixed(3) + ')', 1);
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
      strokeLines('rgba(215,230,255,' + (pal().glow ? 0.22 : 0.5) + ')', 2);
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

  /** 吊り下げた荷物と、そこまでの紐。 */
  function drawPayload(cam, state) {
    const p = state.payload;
    if (p.attached) {
      line3(cam, { x: state.pos.x, y: state.pos.y - 0.03, z: state.pos.z },
        { x: p.x, y: p.y + 0.05, z: p.z }, 'rgba(210,200,170,.75)', 1.5);
    }
    const w = 0.055, h = 0.05;
    const c = [
      [-w, h, w], [w, h, w], [w, h, -w], [-w, h, -w],
      [-w, -h, w], [w, -h, w], [w, -h, -w], [-w, -h, -w]
    ].map(function (v) { return { x: p.x + v[0], y: p.y + v[1] + h, z: p.z + v[2] }; });
    const faces = [
      { i: [4, 5, 6, 7], c: '#6b5230' },
      { i: [0, 1, 5, 4], c: '#c39a5c' },
      { i: [3, 2, 6, 7], c: '#8f6f42' },
      { i: [1, 2, 6, 5], c: '#a8834e' },
      { i: [0, 3, 7, 4], c: '#a8834e' },
      { i: [0, 1, 2, 3], c: '#d8ae6c' }
    ];
    faces.forEach(function (f) {
      poly(cam, f.i.map(function (i) { return c[i]; }), f.c, 'rgba(0,0,0,.35)', 1);
    });
  }

  /** 猫。体・頭・耳・しっぽ。狙っているときは目が光る。 */
  function drawCat(cam, cat) {
    const yaw = cat.facing || 0;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    // 猫を基準にした点 (前 = +z, 右 = +x) を世界座標に
    function cw(lx, ly, lz) {
      return { x: cat.x + lx * cy + lz * sy, y: ly, z: cat.z - lx * sy + lz * cy };
    }
    function box(x0, x1, y0, y1, z0, z1, top, side, front) {
      const v = [
        [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0],
        [x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]
      ].map(function (p) { return cw(p[0], p[1], p[2]); });
      [{ i: [4, 5, 6, 7], c: side }, { i: [0, 1, 5, 4], c: front },
       { i: [3, 2, 6, 7], c: side }, { i: [1, 2, 6, 5], c: side },
       { i: [0, 3, 7, 4], c: side }, { i: [0, 1, 2, 3], c: top }]
        .forEach(function (f) { poly(cam, f.i.map(function (k) { return v[k]; }), f.c, 'rgba(0,0,0,.28)', 1); });
    }
    const fur = '#8a8f9c', furTop = '#a3a8b6', furFront = '#979dab';
    box(-0.10, 0.10, 0.10, 0.28, -0.22, 0.16, furTop, fur, furFront);   // 体
    box(-0.075, 0.075, 0.24, 0.39, 0.14, 0.29, furTop, fur, furFront);  // 頭
    // 耳
    [[-0.055], [0.055]].forEach(function (e) {
      poly(cam, [cw(e[0] - 0.035, 0.38, 0.20), cw(e[0] + 0.035, 0.38, 0.20), cw(e[0], 0.47, 0.22)],
        '#7d8290', 'rgba(0,0,0,.3)', 1);
    });
    // 目。狙っているときだけ光る。
    const glow = cat.mood > 0.35;
    [[-0.04], [0.04]].forEach(function (e) {
      const s = C.projectPoint(cam, cw(e[0], 0.33, 0.295));
      if (!s) return;
      const f = C.focalLength(cam) / s.z;
      ctx.fillStyle = glow ? '#ffd45e' : '#3b4152';
      ctx.beginPath(); ctx.arc(s.x * dpr, s.y * dpr, Math.max(1, 0.016 * f) * dpr, 0, Math.PI * 2); ctx.fill();
    });
    // しっぽ
    beginLines();
    let prev = cw(0, 0.20, -0.22);
    for (let i = 1; i <= 4; i++) {
      const t = i / 4;
      const cur = cw(Math.sin(t * 3 + (cat.mood > 0.35 ? 6 : 0)) * 0.06, 0.20 + t * 0.22, -0.22 - t * 0.14);
      addLine(cam, prev, cur);
      prev = cur;
    }
    strokeLines('#8a8f9c', 4);
    // 足もとの影
    poly(cam, C.circlePoints(cat.x, 0.006, cat.z, 0.19, 14), 'rgba(0,0,0,.30)');
  }

  /** 自己ベストのゴースト。半透明で並走する。 */
  function drawGhost(cam, g) {
    const fake = { pos: g, yaw: g.yaw, pitch: 0, roll: 0 };
    const r = 0.135;
    beginLines();
    [[r, r], [-r, r], [r, -r], [-r, -r]].forEach(function (m) {
      const a = C.bodyToWorld(fake, { x: m[0] * 0.2, y: 0, z: m[1] * 0.2 });
      const b = C.bodyToWorld(fake, { x: m[0], y: 0, z: m[1] });
      addLine(cam, a, b);
    });
    strokeLines('rgba(255,196,84,.55)', 3);
    [[r, r], [-r, r], [r, -r], [-r, -r]].forEach(function (m) {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const a = i / 10 * Math.PI * 2;
        pts.push(C.bodyToWorld(fake, { x: m[0] + Math.cos(a) * 0.075, y: 0.012, z: m[1] + Math.sin(a) * 0.075 }));
      }
      poly(cam, pts, 'rgba(255,196,84,.10)', 'rgba(255,196,84,.35)', 1);
    });
    poly(cam, C.circlePoints(g.x, 0.004, g.z, 0.18, 14), 'rgba(255,196,84,.10)');
  }

  // ================================================================
  // HUD
  // ================================================================
  function updateHUD() {
    const run = app.run, state = app.state, task = run.task;
    els.hudTaskName.textContent = task.name;
    els.hudTaskGoal.textContent = task.kind === 'gates'
      ? task.goal + '  (' + Math.min(run.gateIndex + 1, task.gates.length) + ' / ' + task.gates.length + ')'
      : task.goal;
    els.hudTime.innerHTML = run.elapsed.toFixed(1) + '<span>s</span>';

    // 枠ごと隠す。中身だけ隠すと、空の枠が残る。
    const free = task.kind === 'free';
    els.hudProgressBar.hidden = free;
    els.hudProgress.style.width = Math.round(clamp(T.progressOf(run, state), 0, 1) * 100) + '%';
    // 残り時間が少なくなったら色を変える
    const left = 1 - run.elapsed / task.limit;
    els.hudProgress.classList.toggle('warn', !free && left < 0.25);

    els.hudGauges.hidden = !app.settings.assist;
    if (app.settings.assist) {
      els.gaugeAlt.textContent = state.pos.y.toFixed(2);
      els.gaugeSpd.textContent = Math.hypot(state.vel.x, state.vel.z).toFixed(2);
      els.gaugeFps.textContent = app.fps
        ? Math.round(app.fps) + (app.renderScale < maxScale() ? '·' + app.renderScale + 'x' : '')
        : '–';
      els.hdArrow.setAttribute('transform', 'rotate(' + (state.yaw / DEG).toFixed(1) + ')');
    }

    // 電池
    const cfg = app.env.config;
    els.gaugeBattery.hidden = !app.settings.battery;
    if (app.settings.battery) {
      const pct = Math.max(0, Math.round(state.battery * 100));
      els.batteryPct.textContent = pct;
      els.batteryLeft.textContent = Math.round(C.batterySeconds(state, cfg)) + 's';
      els.batteryFill.style.width = pct + '%';
      els.gaugeBattery.classList.toggle('low', state.battery <= cfg.lowBattery);
      els.gaugeBattery.classList.toggle('empty', state.battery <= cfg.forceLandBattery);
    }
    els.btnBattery.hidden = !(app.settings.battery && state.battery <= cfg.lowBattery);

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
    if (app.screen !== 'flight' && app.screen !== 'replay') { app.lastFrame = 0; return; }

    let dt = app.lastFrame ? (now - app.lastFrame) / 1000 : PHYS_DT;
    app.lastFrame = now;
    dt = Math.min(dt, 0.25);

    if (app.screen === 'replay') { stepReplay(dt); return; }

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

      app.battery = app.state.battery;
      if (app.settings.battery && !app.state.batteryWarned
          && app.state.battery <= app.env.config.lowBattery && app.state.flying) {
        app.state.batteryWarned = true;
        toastBad('電池が残り ' + Math.round(app.state.battery * 100) + '%。そろそろ降ろしてください');
      }

      if (app.state.crashed && !lastCrashed) {
        lastCrashed = true;
        toastBad(app.state.crashReason);
        if (app.run.task.kind === 'free') {
          // 広場では止めない。少し待って置きなおす。
          // どの走行に向けた予約かを覚えておき、入れかわっていたら何もしない。
          const forRun = app.run;
          setTimeout(function () {
            if (app.run === forRun && app.screen === 'flight') startTask('free');
          }, 1800);
        }
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

    updateSound();
    adaptScale(dt);
    renderKnobs(dt);
    drawScene();
    updateHUD();
  }

  // ================================================================
  // 音
  // 何を鳴らすかは core.audioParams() が決める。ここは変わり目を拾うだけ。
  // ================================================================
  const heard = { gate: 0, crashed: false, carrying: false, touched: false };

  function updateSound() {
    if (!S || !S.isRunning() || app.settings.sound === 0) return;
    const state = app.state, run = app.run;
    if (!state || !run) return;

    S.update(C.audioParams(state, app.env.config));

    if (run.gateIndex > heard.gate) { heard.gate = run.gateIndex; S.cue('gate'); }
    if (state.crashed && !heard.crashed) { heard.crashed = true; S.thud(1); S.cue('fail'); }
    if (state.touchedDown && !heard.touched) { heard.touched = true; S.thud(0.3); }
    if (!state.touchedDown) heard.touched = false;
    const carrying = !!(state.payload && state.payload.attached);
    if (carrying !== heard.carrying) { heard.carrying = carrying; S.cue(carrying ? 'pickup' : 'drop'); }
  }

  function resetSoundMemory() {
    heard.gate = 0; heard.crashed = false; heard.touched = false;
    heard.carrying = false;
  }

  // ================================================================
  // リプレイ (飛んだあとを、もう一度見る)
  // ================================================================
  const replay = { samples: null, t: 0, playing: false, dur: 0, task: null, last: 0 };

  function openReplay(run) {
    if (!run.samples || run.samples.length < 4) return;
    replay.samples = run.samples;
    replay.task = run.task;
    replay.dur = run.samples[run.samples.length - 1].t;
    replay.t = 0;
    replay.playing = true;
    replay.last = 0;
    replay.baseNote = run.notes && run.notes.length && !/きれいに飛べています/.test(run.notes[0])
      ? run.notes[0]
      : 'スティックの動きも一緒に出ています。どこで戻していないかを見てください。';
    els.replayNote.textContent = replay.baseNote;
    els.replayNote.classList.remove('warn');
    els.replaySeek.max = String(Math.round(replay.dur * 100));
    els.replaySeek.value = '0';
    setScreen('replay');
    resize();
    // 最初の 1 枚を出す
    const f = sampleAt(replay.t);
    if (f) aimCameraAt(f.pos);
  }

  /** その時刻の記録。間を補間する。 */
  function sampleAt(t) {
    const a = replay.samples;
    if (!a || !a.length) return null;
    let lo = 0, hi = a.length - 1;
    if (t <= a[0].t) return frameOf(a[0], a[0], 0);
    if (t >= a[hi].t) return frameOf(a[hi], a[hi], 0);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid].t <= t) lo = mid; else hi = mid;
    }
    const span = a[hi].t - a[lo].t || 1;
    return frameOf(a[lo], a[hi], (t - a[lo].t) / span);
  }

  function frameOf(a, b, k) {
    const mix = function (p, q) { return p + (q - p) * k; };
    return {
      pos: { x: mix(a.x, b.x), y: mix(a.y, b.y), z: mix(a.z, b.z) },
      vel: { x: 0, y: 0, z: 0 },
      yaw: a.yaw + C.wrapPi(b.yaw - a.yaw) * k,
      pitch: mix(a.pitch, b.pitch),
      roll: mix(a.roll, b.roll),
      spin: a.t * 30,
      throttleVis: 0.7,
      flying: a.y > 0.06,
      crashed: false,
      airborne: true,
      payload: a.px == null ? null : { x: mix(a.px, b.px), y: mix(a.py, b.py), z: mix(a.pz, b.pz), attached: !!a.pa },
      input: { throttle: a.it, yaw: a.iy, pitch: a.ip, roll: a.ir }
    };
  }

  function drawReplayStick(el, x, y) {
    el.style.left = (50 + x * 34) + '%';
    el.style.top = (50 - y * 34) + '%';
  }

  /**
   * その時刻に「何をしているか」を、記録した操作から読み取って言葉にする。
   * 結果画面の指摘と同じ見かたを、起きている瞬間に重ねて出す。
   */
  function replayHintAt(t) {
    const a = replay.samples;
    if (!a || !a.length) return '';
    // 直前 1.8 秒を見る
    let i = a.length - 1;
    while (i > 0 && a[i].t > t) i--;
    let j = i;
    while (j > 0 && a[i].t - a[j].t < 1.8) j--;
    const n = i - j + 1;
    if (n < 8) return '';

    let thr = 0, stick = 0, held = 0, fast = 0, counter = 0;
    for (let k = j; k <= i; k++) {
      const s = a[k];
      thr += s.it;
      const mag = Math.hypot(s.ip, s.ir);
      stick += mag;
      if (mag > 0.4) held++;
      // 速さと、それを止める向きに入れているか
      const nx = k > 0 ? (s.x - a[k - 1].x) : 0, nz = k > 0 ? (s.z - a[k - 1].z) : 0;
      const sp = Math.hypot(nx, nz) / 0.06;
      if (sp > 0.7) {
        fast++;
        const h = C.headingVectors(s.yaw);
        const cx = h.fwd.x * s.ip + h.right.x * s.ir;
        const cz = h.fwd.z * s.ip + h.right.z * s.ir;
        if (cx * nx + cz * nz < 0) counter++;
      }
    }
    if (thr / n > 0.45) return 'スロットルを入れっぱなし → 上がり続けています';
    if (thr / n < -0.45) return 'スロットルを下げっぱなし → 下がり続けています';
    if (held / n > 0.7) return '右スティックを倒しっぱなし → 加速し続けています';
    if (fast > n * 0.6 && counter < fast * 0.2) return '速く動いているのに、止める舵が入っていません';
    if (stick / n < 0.08 && fast > n * 0.5) return '手を離したまま流れています';
    return '';
  }

  function stepReplay(dt) {
    if (replay.playing) {
      replay.t += dt;
      if (replay.t >= replay.dur) { replay.t = replay.dur; replay.playing = false; updateReplayButton(); }
      els.replaySeek.value = String(Math.round(replay.t * 100));
    }
    const f = sampleAt(replay.t);
    if (!f) return;
    C.updateCamera(app.cam, f.pos, dt, cameraOpts());
    drawScene(f);
    els.replayTime.textContent = replay.t.toFixed(1) + ' / ' + replay.dur.toFixed(1) + 's';
    // そのときのスティック
    const m = app.settings.mode;
    const l = m === 1 ? { x: f.input.yaw, y: f.input.pitch } : { x: f.input.yaw, y: f.input.throttle };
    const r = m === 1 ? { x: f.input.roll, y: f.input.throttle } : { x: f.input.roll, y: f.input.pitch };
    drawReplayStick(els.replayStickL, l.x || 0, l.y || 0);
    drawReplayStick(els.replayStickR, r.x || 0, r.y || 0);

    const hint = replayHintAt(replay.t);
    els.replayNote.textContent = hint || replay.baseNote;
    els.replayNote.classList.toggle('warn', !!hint);
  }

  function updateReplayButton() {
    els.replayPlay.textContent = replay.playing ? '❚❚' : '▶';
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
    [['setMode', 'mode'], ['setDifficulty', 'difficulty'], ['setAltHold', 'altHold'],
     ['setAssist', 'assist'], ['setBattery', 'battery'], ['setSound', 'sound'], ['setNight', 'night']]
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
    els.nightNote.textContent = app.settings.night
      ? '灯りを消しています。前が白、後ろが赤。補助表示も切ると、実機の夜間飛行と同じになります。'
      : '灯りを消すと、機体の LED だけが見えます。前が白、後ろが赤。向きを読む練習に。';
    if (els.btnNight) {
      els.btnNight.textContent = app.settings.night ? '☀' : '🌙';
      els.btnNight.setAttribute('aria-pressed', app.settings.night ? 'true' : 'false');
    }
    els.batteryNote.textContent = app.settings.battery
      ? 'ホバリングで約 7 分。走行をまたいで持ちこします。減ったら「電池を替える」で新品に。'
      : '電池を気にせず練習します。';
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
    bindSeg(els.setBattery, 'battery', syncSettingsUI);
    bindSeg(els.setNight, 'night', function () { syncSettingsUI(); applyNight(); });
    bindSeg(els.setSound, 'sound', function (v) { if (window.Sound) window.Sound.setMuted(!v); });
    syncSettingsUI();

    els.btnMenu.addEventListener('click', function () { app.paused = true; setScreen('menu'); });
    els.btnNight.addEventListener('click', function () {
      app.settings.night = app.settings.night ? 0 : 1;
      saveSoon();
      syncSettingsUI();
      applyNight();
      toast(app.night ? '灯りを消しました。前が白、後ろが赤です' : '灯りを点けました', 2000);
    });
    els.btnTakeoff.addEventListener('click', toggleTakeoff);
    els.btnRetry.addEventListener('click', function () { startTask(app.taskId); });
    els.btnBattery.addEventListener('click', function () {
      app.battery = 1;
      if (app.state) { app.state.battery = 1; app.state.batteryWarned = false; }
      toast('電池を新しいものに替えました');
    });
    els.btnResRetry.addEventListener('click', function () { startTask(app.taskId); });
    els.btnResMenu.addEventListener('click', function () { setScreen('menu'); });
    els.btnReplay.addEventListener('click', function () { if (app.run) openReplay(app.run); });
    els.replayClose.addEventListener('click', function () {
      replay.playing = false;
      setScreen(app.run && app.run.finished ? 'result' : 'menu');
    });
    els.replayPlay.addEventListener('click', function () {
      if (!replay.playing && replay.t >= replay.dur - 0.01) replay.t = 0;
      replay.playing = !replay.playing;
      updateReplayButton();
    });
    els.replaySeek.addEventListener('input', function () {
      replay.t = Number(els.replaySeek.value) / 100;
      replay.playing = false;
      updateReplayButton();
    });

    // iOS は指で触るまで音を出せない。最初の 1 回で始める。
    const wake = function () {
      if (window.Sound) {
        window.Sound.start();
        window.Sound.setMuted(!app.settings.sound);
      }
    };
    document.addEventListener('pointerdown', wake, { once: false });
    document.addEventListener('touchstart', wake, { once: false });
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
      openReplay: openReplay,
      replayHintAt: replayHintAt,
      replay: replay,
      sampleAt: sampleAt,
      ghost: function () { return app.ghost; },
      saveGhost: saveGhost,
      setBattery: function (v) { app.battery = v; if (app.state) app.state.battery = v; },
      isNight: function () { return app.night; },
      applyNight: applyNight,
      resize: resize,
      // 速さの計測用。どこが重いかを部品ごとに測れるようにする。
      bench: { drawScene: drawScene, renderKnobs: renderKnobs, updateHUD: updateHUD, readSticks: readSticks },
      renderScale: function () { return app.renderScale; },
      drawnTrail: function () { return app.drawnTrail; },
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
