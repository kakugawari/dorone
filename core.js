/*!
 * core.js — ドローン練習アプリのロジック。DOM を一切触らない。
 *
 * ブラウザでは <script> で読み込むと window.Core になり、
 * node からは require() できる。だから物理も 3D の計算も node --test で検証できる。
 *
 * 座標系: x = 右, y = 上(高さ), z = 奥(操縦者から見て前)。単位は m / s / rad。
 * 機首方位 yaw = 0 のとき機首は +z (部屋の奥) を向く。yaw を増やすと右に回る。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.Core = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEG = Math.PI / 180;
  const TAU = Math.PI * 2;

  // ------------------------------------------------------------------
  // 基本の道具
  // ------------------------------------------------------------------

  /** 決まった順番で数を出す乱数 (mulberry32)。同じ seed からは必ず同じ並び。 */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** 角度を -π..π に畳む。方位の差を測るときに必ず要る。 */
  function wrapPi(a) {
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
  }

  /**
   * 1 次遅れの追従係数。dt に依らず同じ速さで近づく。
   * 「* rate * dt」で書くと dt が大きいとき行き過ぎて発散するので、こちらを使う。
   */
  function approachK(rate, dt) { return 1 - Math.exp(-rate * dt); }

  function dist2(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); }

  // ------------------------------------------------------------------
  // 機体の性能。手持ちのトイドローン (E88/E99 系) に寄せてある。
  //   - 気圧センサーの高度維持あり → スロットルは「上下の速度」の指示になる
  //   - 自動水平 (アングルモード) → スティックを戻すと機体は水平に戻る。
  //     ただし水平に戻っても**止まらない**。ここが初心者最大の壁。
  //   - GPS も光学センサーもない → 放っておくとじわじわ流れる
  // ------------------------------------------------------------------
  const DEFAULT_CONFIG = {
    gravity: 9.81,
    maxTiltDeg: 20,       // 最大の傾き
    tiltResponse: 7.0,    // 傾きが指示に追いつく速さ (1/s)
    altHold: true,        // 気圧センサーによる高度維持。手持ちの機体はこれが「あり」
    maxThrustG: 2.2,      // 最大推力 / 重力 (高度維持オフのときだけ使う)
    dragV: 0.9,           // 上下の空気抵抗 (同上)
    maxClimb: 1.1,        // 上昇の最大速度 (m/s)
    maxDescent: 0.9,      // 下降の最大速度 (m/s)
    climbResponse: 3.2,
    maxYawRate: 120 * DEG,
    yawResponse: 6.0,
    dragH: 1.6,           // 水平の空気抵抗。1/1.6 = 0.63 秒で減速する感じ
    driftAccel: 0.15,     // 気流によるゆっくりした揺らぎ (m/s^2)
    trim: { x: 0.10, z: -0.06 }, // トリムずれ。**一方向に流れ続ける**。実機で一番効くクセ
    altHoldWobble: 0.35,  // 高度維持のふらつき (m/s^2)
    radius: 0.16,         // 機体を球とみなした半径
    halfHeight: 0.035,
    crashSpeed: 0.95,     // これ以上の速さでぶつかると墜落
    hardLandingSpeed: 1.25,
    // 電池。手持ちの機体はホバリングで 7 分くらい。派手に飛ばすともっと短い。
    battery: true,
    flightSeconds: 420,
    lowBattery: 0.25,     // ここを切ったら警告
    forceLandBattery: 0.07, // ここを切ったら勝手に降りはじめる (実機と同じ)
    // 吊り下げた荷物 (⑨ 荷物を運ぶ)
    payloadLength: 0.32,  // 紐の長さ
    payloadMass: 0.30,    // 機体に対する重さの比
    payloadDamping: 0.9,
    pickupRadius: 0.30,
    pickupHeight: 0.62,
    phase: [0.0, 1.7, 3.4, 5.1]
  };

  function makeConfig(over) {
    return Object.assign({}, DEFAULT_CONFIG, over || {});
  }

  /**
   * seed からドリフトの位相とトリムずれをばらす。
   * 毎回まったく同じ流れ方だと、覚えてしまって練習にならない。
   * difficulty で流れの強さを変える (0.5 = やさしい / 1 = ふつう / 1.6 = 実機なみ)。
   */
  function randomizeDrift(config, seed, difficulty) {
    const rng = mulberry32((seed >>> 0) || 1);
    const d = difficulty == null ? 1 : difficulty;
    config.phase = [rng() * TAU, rng() * TAU, rng() * TAU, rng() * TAU];
    const dir = rng() * TAU;
    const mag = (0.06 + rng() * 0.09) * d;
    config.trim = { x: Math.cos(dir) * mag, z: Math.sin(dir) * mag };
    config.driftAccel = DEFAULT_CONFIG.driftAccel * d;
    config.altHoldWobble = DEFAULT_CONFIG.altHoldWobble * d;
    return config;
  }

  // ------------------------------------------------------------------
  // 部屋
  // ------------------------------------------------------------------
  /** 家具の 1 パーツ。すべて箱。組み合わせて形を作る。 */
  function part(name, x0, y0, z0, x1, y1, z1, color) {
    return { name: name, min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 }, color: color };
  }

  /**
   * 部屋。家具は箱の組み合わせで作る。
   * 1 つの箱で済ませると「ただの直方体」に見えて、何なのか分からない。
   * 座面・背もたれ・肘掛け、天板・脚、棚板・本 のように分けると形が読める。
   * 当たり判定もこのパーツ 1 つずつに対して行う (見た目と当たりを分けない)。
   */
  /**
   * 面に貼る平らな板 (デカール)。当たり判定は持たない。
   * x が一定の面に貼る。本の背表紙のように「模様」を出すのに使う。
   */
  function decalX(x, y0, z0, y1, z1, color) {
    return {
      color: color,
      pts: [
        { x: x, y: y1, z: z0 }, { x: x, y: y1, z: z1 },
        { x: x, y: y0, z: z1 }, { x: x, y: y0, z: z0 }
      ]
    };
  }

  const BOOK_COLORS = [
    '#8a5a52', '#5d6b7d', '#6d7a55', '#4f6a76',
    '#7a6a4a', '#6b4f6b', '#8a6f4a', '#57707a', '#7d5348'
  ];

  /**
   * 棚に並ぶ本の背表紙。棚ごとに、幅と高さと色を変えて並べる。
   * seed から決まるので毎回同じ。前の面から 5mm 手前に置いて、隠れないようにする。
   */
  function bookSpines(faceX, shelves, z0, z1, seed) {
    const rng = mulberry32(seed >>> 0);
    const out = [];
    const x = faceX + 0.005;
    for (const [yBottom, yTop] of shelves) {
      const h = yTop - yBottom;
      let z = z0 + 0.02 + rng() * 0.03;
      while (z < z1 - 0.05) {
        const w = 0.055 + rng() * 0.075;
        if (z + w > z1) break;
        const top = yBottom + h * (0.62 + rng() * 0.34);
        out.push(decalX(x, yBottom, z, top, z + w, BOOK_COLORS[Math.floor(rng() * BOOK_COLORS.length)]));
        z += w + 0.006 + rng() * 0.016;
      }
    }
    return out;
  }

  function createRoom() {
    const furniture = [];
    const decals = [];
    const add = function () { furniture.push(part.apply(null, arguments)); };

    // --- ソファ (左の壁ぎわ。右を向いている) ---
    add('ソファ', -2.52, 0.00, 2.14, -1.72, 0.30, 3.86, '#3a4359');   // 台座
    add('ソファ', -2.56, 0.30, 2.14, -2.32, 0.84, 3.86, '#4a5570');   // 背もたれ
    add('ソファ', -2.52, 0.30, 2.14, -1.70, 0.58, 2.32, '#454f68');   // 肘掛け (手前)
    add('ソファ', -2.52, 0.30, 3.68, -1.70, 0.58, 3.86, '#454f68');   // 肘掛け (奥)
    add('ソファ', -2.44, 0.30, 2.36, -1.76, 0.47, 3.04, '#5a6589');   // 座面 1
    add('ソファ', -2.44, 0.30, 3.10, -1.76, 0.47, 3.64, '#5a6589');   // 座面 2

    // --- ローテーブル (天板 + 脚)。下に 34cm のすき間ができて、くぐれる ---
    add('テーブルの天板', -0.35, 0.34, 2.30, 1.10, 0.42, 3.25, '#6b5842');
    add('テーブルの脚', -0.29, 0, 2.36, -0.21, 0.34, 2.44, '#5a4936');
    add('テーブルの脚', 0.96, 0, 2.36, 1.04, 0.34, 2.44, '#5a4936');
    add('テーブルの脚', -0.29, 0, 3.11, -0.21, 0.34, 3.19, '#5a4936');
    add('テーブルの脚', 0.96, 0, 3.11, 1.04, 0.34, 3.19, '#5a4936');

    // --- テレビ台 + テレビ (奥の壁ぎわ) ---
    add('テレビ台', 1.30, 0.44, 4.30, 2.60, 0.50, 4.96, '#3d4356');   // 天板
    add('テレビ台', 1.30, 0.00, 4.32, 1.42, 0.44, 4.96, '#343a4b');   // 左の側板
    add('テレビ台', 2.48, 0.00, 4.32, 2.60, 0.44, 4.96, '#343a4b');   // 右の側板
    add('テレビ台', 1.42, 0.18, 4.36, 2.48, 0.24, 4.96, '#2f3543');   // 中の棚板
    add('テレビ', 1.90, 0.50, 4.72, 2.02, 0.57, 4.84, '#2a3040');     // スタンド
    add('テレビ', 1.62, 0.57, 4.75, 2.30, 1.01, 4.81, '#1b2029');     // 画面

    // --- 本棚 (左の壁ぎわ、手前) ---
    // 本棚は「蓋をした 1 つの箱」。中身は箱で作らない。
    // 小さい箱を並べると、奥から順に塗るだけの描き方では飛び出して見えるうえ、
    // 面の数も増える。前の面に色を塗って本に見せるほうが、きれいで軽い。
    const SHELF_FRONT = -2.18;
    add('本棚', -2.56, 0.00, 0.10, SHELF_FRONT, 1.30, 1.30, '#5a4a3a');   // 本体 (中は空けない)
    add('本棚', -2.58, 1.30, 0.06, -2.12, 1.37, 1.34, '#6d5b48');         // 天板 (少し張り出す)
    add('本棚', -2.56, 0.42, 0.10, -2.13, 0.47, 1.30, '#6d5b48');         // 棚板 1
    add('本棚', -2.56, 0.84, 0.10, -2.13, 0.89, 1.30, '#6d5b48');         // 棚板 2
    decals.push.apply(decals, bookSpines(SHELF_FRONT, [
      [0.06, 0.41], [0.48, 0.83], [0.90, 1.28]
    ], 0.14, 1.26, 7));

    // --- 観葉植物。葉を高さと向きを変えて散らすと、それらしく見える ---
    add('植木鉢', 2.21, 0.00, 0.39, 2.35, 0.05, 0.57, '#65473a');
    add('植木鉢', 2.16, 0.05, 0.34, 2.40, 0.30, 0.62, '#7d5844');
    // 幹は葉のいちばん上まで通す。途中で切ると、上の葉が宙に浮いて見える。
    add('観葉植物', 2.26, 0.30, 0.46, 2.31, 0.92, 0.51, '#4a3d2e');   // 幹
    // 葉は上にいくほど小さく。輪郭がすぼまって、木らしく見える。
    add('観葉植物', 2.03, 0.54, 0.37, 2.34, 0.59, 0.59, '#35624a');
    add('観葉植物', 2.24, 0.62, 0.39, 2.53, 0.67, 0.58, '#3f6e54');
    add('観葉植物', 2.17, 0.70, 0.25, 2.39, 0.75, 0.51, '#35624a');
    add('観葉植物', 2.18, 0.78, 0.47, 2.38, 0.83, 0.71, '#3f6e54');
    add('観葉植物', 2.21, 0.86, 0.41, 2.36, 0.91, 0.57, '#457a5c');
    add('観葉植物', 2.24, 0.91, 0.44, 2.33, 0.99, 0.53, '#4b8263');   // 先端

    return {
      minX: -2.6, maxX: 2.6,
      minZ: -1.0, maxZ: 5.0,
      height: 2.4,
      // 操縦者 (= カメラ) の立ち位置と目の高さ
      pilot: { x: 0, y: 1.55, z: -0.75 },
      furniture: furniture,
      // 面に貼るだけの板。描くが、当たり判定は持たない。
      decals: decals
    };
  }

  /**
   * 広場。壁も天井もない、開けた練習場。
   * 部屋 (createRoom) と同じ形の入れ物を返すが、open: true が付く。
   * open のときは、端と上に当たっても墜落せず、そっと止まるだけ。
   *
   * 見た目の重さは部屋より軽い。壁 3 枚・天井・家具 30 パーツを描かなくなり、
   * 代わりに地面 1 枚とパイロン (三角コーン) だけになる。
   */
  function createField() {
    const furniture = [];
    const add = function () { furniture.push(part.apply(null, arguments)); };

    // 三角コーン。距離をつかむ手がかりと、スラロームの目印を兼ねる。
    // 「どのくらい離れているか」が分からないと、広い所では練習にならない。
    // 千鳥に置く。一直線に並べると、操縦者から見て重なって
    // 「トーテムポール」に見えてしまう。ジグザグに抜ける練習にもなる。
    const cones = [
      [-1.7, -2.0], [1.7, 0.4], [-1.7, 2.8], [1.7, 5.2],
      [-4.6, 1.6], [4.6, 1.6], [0, 7.2]
    ];
    for (const [cx, cz] of cones) {
      add('コーン', cx - 0.17, 0, cz - 0.17, cx + 0.17, 0.05, cz + 0.17, '#8a4a2a');   // 台
      add('コーン', cx - 0.11, 0.05, cz - 0.11, cx + 0.11, 0.34, cz + 0.11, '#c25a2a'); // 下
      add('コーン', cx - 0.06, 0.34, cz - 0.06, cx + 0.06, 0.58, cz + 0.06, '#e07a3a'); // 上
    }

    return {
      open: true,
      minX: -8, maxX: 8,
      minZ: -8, maxZ: 8,
      // 上限 6m。これ以上あげると機体が数画素になって、何をしているか読めない。
      // (部屋は 2.4m なので、それでも 2.5 倍の高さがある)
      height: 6,
      pilot: { x: 0, y: 1.55, z: -6.5 },
      furniture: furniture,
      decals: []
    };
  }

  /**
   * 立ち位置を、その場所の中で家具にめり込まない所に丸める。
   * 人は上から見た円 (半径 0.32m) として扱う。
   * 低いもの (コーンなど) はまたげるので、通り抜けられる。
   */
  function clampPilot(room, x, z, radius) {
    const r = radius == null ? 0.32 : radius;
    const inBounds = function () {
      x = clamp(x, room.minX + r, room.maxX - r);
      z = clamp(z, room.minZ + r, room.maxZ - r);
    };
    inBounds();
    // 角で挟まれることがあるので、数回まわして押し出す
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const f of room.furniture) {
        if (f.max.y < 0.60) continue;              // 低いものはまたげる
        const cx = clamp(x, f.min.x, f.max.x);
        const cz = clamp(z, f.min.z, f.max.z);
        let dx = x - cx, dz = z - cz;
        let d = Math.hypot(dx, dz);
        if (d >= r) continue;
        if (d < 1e-6) {
          // 中に入ってしまった。いちばん近い面へ出す。
          const outs = [
            [f.min.x - r - x, -1, 0], [f.max.x + r - x, 1, 0],
            [f.min.z - r - z, 0, -1], [f.max.z + r - z, 0, 1]
          ];
          outs.sort(function (a, b) { return Math.abs(a[0]) - Math.abs(b[0]); });
          x += outs[0][1] ? outs[0][0] : 0;
          z += outs[0][2] ? outs[0][0] : 0;
        } else {
          x = cx + dx / d * r;
          z = cz + dz / d * r;
        }
        moved = true;
      }
      inBounds();
      if (!moved) break;
    }
    return { x: x, z: z };
  }

  // ------------------------------------------------------------------
  // 機体の状態
  // ------------------------------------------------------------------
  function createState(opts) {
    const o = opts || {};
    const start = o.start || { x: 0, y: 0, z: 1.6 };
    return {
      t: 0,
      pos: { x: start.x, y: start.y, z: start.z },
      vel: { x: 0, y: 0, z: 0 },
      yaw: o.yaw || 0,
      yawRate: 0,
      pitch: 0,          // 前後の傾き。+ で機首下げ = 前進
      roll: 0,           // 左右の傾き。+ で右下げ = 右へ
      spin: 0,           // プロペラの回転位相 (描画用)
      throttleVis: 0,    // プロペラの見た目の勢い
      flying: false,
      airborne: false,          // 一度でもしっかり浮いたか。着地判定に使う
      atLimit: false,           // 広場の端や上限に当たっている
      crashed: false,
      crashReason: '',
      landed: false,
      touchedDown: false,       // このフレームで接地したか
      touchdownSpeed: 0,
      auto: null,               // 'takeoff' | 'land' | null
      battery: o.battery != null ? o.battery : 1,
      batteryWarned: false,
      payload: null,            // 荷物を運ぶ課題でだけ入る
      prevVel: { x: 0, z: 0 }
    };
  }

  /**
   * 吊り下げる荷物。床に置いてある状態から始める。
   * ox, oz は「機体の真下」からのずれ。振り子として揺れる。
   */
  function createPayload(x, z) {
    return { home: { x: x, z: z }, x: x, y: 0.055, z: z, ox: 0, oz: 0, vox: 0, voz: 0,
             attached: false, dropSpeed: 0, justDropped: false, everCarried: false,
             rearmed: true };   // 一度上に戻らないと拾い直せない
  }

  /**
   * 電池の減り。ホバリングを 1 とし、スロットルを上げたり傾けたりすると速く減る。
   * 実機でも、上げ下げを繰り返すと目に見えて短くなる。
   */
  function batteryLoad(inp, state, config) {
    const tilt = Math.hypot(state.pitch, state.roll) / (config.maxTiltDeg * DEG);
    return 0.80 + 0.55 * Math.max(0, inp.throttle) + 0.45 * Math.min(1, tilt);
  }

  /** 残りの飛行時間 (秒)。HUD に出す。 */
  function batterySeconds(state, config) {
    return Math.max(0, state.battery) * config.flightSeconds;
  }

  /**
   * スロットル (-1..1) を推力の加速度 (m/s^2) に。高度維持オフのときだけ使う。
   * ホバリングは maxThrustG=2.2 のとき throttle = -0.09 あたり。ほぼ中央。
   */
  function throttleToThrust(throttle, config) {
    const t01 = clamp((throttle + 1) / 2, 0, 1);
    return t01 * config.maxThrustG * config.gravity;
  }

  /** 気流と重心ずれによる、ゆっくりした流れ。時刻から決まるので再現できる。 */
  function driftAt(t, config) {
    const p = config.phase, a = config.driftAccel;
    const tr = config.trim || { x: 0, z: 0 };
    return {
      x: tr.x + a * (0.70 * Math.sin(t * 0.41 + p[0]) + 0.30 * Math.sin(t * 0.17 + p[2])),
      z: tr.z + a * (0.70 * Math.sin(t * 0.33 + p[1]) + 0.30 * Math.sin(t * 0.13 + p[3]))
    };
  }

  function crash(state, reason) {
    state.crashed = true;
    state.crashReason = reason;
    state.flying = false;
    state.vel.x = state.vel.y = state.vel.z = 0;
  }

  /** 機首方向 (前) と右方向の単位ベクトル。 */
  function headingVectors(yaw) {
    const s = Math.sin(yaw), c = Math.cos(yaw);
    return { fwd: { x: s, z: c }, right: { x: c, z: -s } };
  }

  /**
   * 物理を dt 秒すすめる。state を書き換えて返す。
   * input は -1..1 の 4 本 (throttle / yaw / pitch / roll)。
   */
  function step(state, input, dt, env) {
    if (state.crashed) { state.t += dt; return state; }
    const config = env.config, room = env.room;

    let inp = {
      throttle: clamp(input.throttle || 0, -1, 1),
      yaw: clamp(input.yaw || 0, -1, 1),
      pitch: clamp(input.pitch || 0, -1, 1),
      roll: clamp(input.roll || 0, -1, 1)
    };

    // ワンキー離陸 / 着陸。実機と同じで、途中でスティックを触れば手動に戻る。
    if (state.auto === 'takeoff') {
      // 0.75m で切る。惰性で 1.0m あたりに落ち着く (実機のワンキー離陸と同じ挙動)
      inp = { throttle: state.pos.y < 0.75 ? 1 : 0, yaw: 0, pitch: 0, roll: 0 };
      state.flying = true;
      if (state.pos.y >= 0.75) state.auto = null;
    } else if (state.auto === 'land') {
      inp = { throttle: -0.45, yaw: 0, pitch: 0, roll: 0 };
      if (!state.flying) state.auto = null;
    }

    // 電池が尽きかけたら、実機と同じで勝手に降りはじめる。操作では止められない。
    // 地上にいるときも効かせないと、降りた直後にまた浮いてしまう。
    if (config.battery && state.battery <= config.forceLandBattery) {
      inp = { throttle: state.battery <= 0 ? -1 : -0.42, yaw: 0, pitch: 0, roll: 0 };
      if (state.flying) state.auto = 'land';
    }

    state.lastInput = inp;

    if (!state.flying) {
      // 地上。高度維持ありならスロットルを少し上げれば浮く。
      // オフなら、推力が重力を超えないと浮かない (実機のマニュアル操作と同じ)。
      const liftOff = config.altHold
        ? inp.throttle > 0.22
        : throttleToThrust(inp.throttle, config) > config.gravity * 1.02;
      if (liftOff) {
        state.flying = true;
        state.landed = false;
      } else {
        const k = approachK(6, dt);
        state.pitch -= state.pitch * k;
        state.roll -= state.roll * k;
        state.vel.x = state.vel.y = state.vel.z = 0;
        state.prevVel.x = state.prevVel.z = 0;
        state.throttleVis += (Math.max(0, inp.throttle) - state.throttleVis) * approachK(6, dt);
        state.spin = (state.spin + state.throttleVis * 40 * dt) % TAU;
        state.t += dt;
        return state;
      }
    }

    // --- 姿勢 (アングルモード: 指示した角度に向かって傾く) ---
    const maxTilt = config.maxTiltDeg * DEG;
    const kA = approachK(config.tiltResponse, dt);
    state.pitch += (inp.pitch * maxTilt - state.pitch) * kA;
    state.roll += (inp.roll * maxTilt - state.roll) * kA;

    // --- 方位 ---
    const kY = approachK(config.yawResponse, dt);
    state.yawRate += (inp.yaw * config.maxYawRate - state.yawRate) * kY;
    state.yaw = wrapPi(state.yaw + state.yawRate * dt);

    // --- 水平方向: 傾き = 加速度。ここが操縦の本質 ---
    const h = headingVectors(state.yaw);
    const aF = config.gravity * Math.tan(state.pitch);
    const aR = config.gravity * Math.tan(state.roll);
    let ax = h.fwd.x * aF + h.right.x * aR;
    let az = h.fwd.z * aF + h.right.z * aR;

    const d = driftAt(state.t, config);
    ax += d.x; az += d.z;
    if (env.wind) { ax += env.wind.x; az += env.wind.z; }

    ax -= config.dragH * state.vel.x;
    az -= config.dragH * state.vel.z;

    state.vel.x += ax * dt;
    state.vel.z += az * dt;

    // --- 上下 ---
    if (config.altHold) {
      // 高度維持あり: スロットルは「上下の速度」の指示。戻せばその高さで止まる。
      const target = inp.throttle >= 0
        ? inp.throttle * config.maxClimb
        : inp.throttle * config.maxDescent;
      state.vel.y += (target - state.vel.y) * approachK(config.climbResponse, dt);
      if (Math.abs(inp.throttle) < 0.06) {
        // 気圧センサーは完璧ではない。じわっと上下する。
        state.vel.y += config.altHoldWobble * Math.sin(state.t * 2.7 + config.phase[2]) * dt;
      }
    } else {
      // 高度維持なし: スロットルは「推力」そのもの。中央あたりでつり合う。
      // 傾けると上向きの成分が減るので**沈む**。これは実機で必ず起きる。
      const thrust = throttleToThrust(inp.throttle, config)
        * Math.cos(state.pitch) * Math.cos(state.roll);
      state.vel.y += (thrust - config.gravity - config.dragV * state.vel.y) * dt;
    }

    // 吊った荷物は振り子。機体が動くと遅れてついてきて、そのぶん機体を引っぱり返す。
    // 「急に動かすと荷物が暴れて、こんどは機体が振られる」を再現する。
    if (state.payload) {
      const p = state.payload;
      if (p.attached) {
        const L = config.payloadLength, r = config.payloadMass;
        const tension = config.gravity / L;
        // 機体の加速度 (この 1 歩ぶん)。荷物から見ると逆向きの力になる。
        const adx = (state.vel.x - state.prevVel.x) / dt;
        const adz = (state.vel.z - state.prevVel.z) / dt;
        p.vox += (-tension * p.ox - config.payloadDamping * p.vox - adx) * dt;
        p.voz += (-tension * p.oz - config.payloadDamping * p.voz - adz) * dt;
        p.ox += p.vox * dt;
        p.oz += p.voz * dt;
        // 紐の長さを超えないよう丸める
        const off = Math.hypot(p.ox, p.oz);
        if (off > L * 0.92) { const k = L * 0.92 / off; p.ox *= k; p.oz *= k; p.vox *= k; p.voz *= k; }
        // 紐の張力の横向き成分が、機体を引っぱる
        state.vel.x += r * config.gravity * (p.ox / L) * dt;
        state.vel.z += r * config.gravity * (p.oz / L) * dt;
      }
    }
    state.prevVel.x = state.vel.x;
    state.prevVel.z = state.vel.z;

    state.pos.x += state.vel.x * dt;
    state.pos.y += state.vel.y * dt;
    state.pos.z += state.vel.z * dt;

    if (state.payload) updatePayload(state, env, dt);
    if (env.cat) updateCat(env.cat, state, env, dt);

    if (state.pos.y > 0.25) state.airborne = true;
    state.touchedDown = false;
    resolveCollisions(state, env);

    if (config.battery) {
      state.battery = Math.max(0, state.battery - dt / config.flightSeconds * batteryLoad(inp, state, config));
    }

    state.throttleVis += (0.55 + 0.45 * inp.throttle - state.throttleVis) * approachK(6, dt);
    state.spin = (state.spin + (18 + state.throttleVis * 45) * dt) % TAU;
    state.t += dt;
    return state;
  }

  /**
   * 荷物の世界での位置を決め、拾う・置くを判定する。
   * 拾う: 荷物の真上あたりまで下りると自動でひっかかる
   * 置く: そのまま下ろして、荷物が床に触れて機体が止まっていれば離れる
   */
  function updatePayload(state, env, dt) {
    const p = state.payload, config = env.config;
    const L = config.payloadLength;

    p.justDropped = false;

    if (!p.attached) {
      // 床に置いてある。真上あたりまで下りると、自動でひっかかる。
      p.x = p.home.x; p.z = p.home.z; p.y = 0.055;
      // 下ろしたあと、そのまま下りていると拾い直してしまう。
      // 一度しっかり上がってからでないと、またひっかからない。
      if (state.pos.y > config.pickupHeight + 0.15) p.rearmed = true;
      const d = Math.hypot(state.pos.x - p.x, state.pos.z - p.z);
      if (p.rearmed && state.flying && d <= config.pickupRadius && state.pos.y <= config.pickupHeight) {
        p.attached = true;
        p.everCarried = true;
        p.ox = p.oz = p.vox = p.voz = 0;
      }
      return;
    }

    // 吊っている。紐の長さぶん下に、揺れたぶんだけずれて下がる。
    const off2 = p.ox * p.ox + p.oz * p.oz;
    const drop = Math.sqrt(Math.max(0, L * L - off2));
    p.x = state.pos.x + p.ox;
    p.z = state.pos.z + p.oz;
    p.y = state.pos.y - drop;

    // 家具に引っかかる
    for (const f of env.room.furniture) {
      const c = closestOnBox(f, { x: p.x, y: p.y, z: p.z });
      if (Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) < 0.06) {
        crash(state, '荷物が「' + f.name + '」に引っかかりました');
        return;
      }
    }

    // 床に触れた。機体が落ちついていれば、そこに置ける。
    if (p.y <= 0.055) {
      const hs = Math.hypot(state.vel.x, state.vel.z);
      const swing = Math.hypot(p.vox, p.voz);
      p.y = 0.055;
      if (hs < 0.40 && swing < 0.45) {
        p.attached = false;
        p.justDropped = true;
        p.rearmed = false;
        p.dropSpeed = Math.max(0, -state.vel.y);
        p.home = { x: p.x, z: p.z };   // 置いた所が新しい定位置。拾い直せる。
      }
    }
  }

  /**
   * 猫。ふだんはうろうろしているが、低いところを飛んでいると寄ってくる。
   * 動きは時刻から決まるので、テストで再現できる。
   */
  function createCat(room, seed) {
    const rng = mulberry32((seed >>> 0) || 1);
    return {
      x: 1.2, z: 3.6, vx: 0, vz: 0,
      mood: 0,                       // 0 = 興味なし, 1 = 完全に狙っている
      phase: [rng() * TAU, rng() * TAU],
      swat: false
    };
  }

  function updateCat(cat, state, env, dt) {
    const room = env.room, config = env.config;
    const footD = Math.hypot(state.pos.x - cat.x, state.pos.z - cat.z);

    // 低いところを飛んでいると、じわじわ興味を持つ
    const tempting = state.flying && state.pos.y < 1.05 && footD < 2.0;
    cat.mood = clamp(cat.mood + (tempting ? 1.1 : -0.5) * dt, 0, 1);

    let tx, tz;
    if (cat.mood > 0.35) {
      tx = state.pos.x; tz = state.pos.z;
    } else {
      // うろうろ
      tx = 0.6 + 1.7 * Math.sin(state.t * 0.21 + cat.phase[0]);
      tz = 3.0 + 1.4 * Math.sin(state.t * 0.15 + cat.phase[1]);
    }
    const speed = 0.32 + cat.mood * 0.75;
    const dx = tx - cat.x, dz = tz - cat.z;
    const d = Math.hypot(dx, dz) || 1;
    const k = approachK(3.0, dt);
    cat.vx += (dx / d * speed - cat.vx) * k;
    cat.vz += (dz / d * speed - cat.vz) * k;
    cat.x = clamp(cat.x + cat.vx * dt, room.minX + 0.3, room.maxX - 0.3);
    cat.z = clamp(cat.z + cat.vz * dt, room.minZ + 0.3, room.maxZ - 0.3);
    cat.facing = Math.atan2(cat.vx, cat.vz);

    // 猫パンチ。低くて近いとやられる。
    if (state.flying && state.pos.y < 0.80 && footD < 0.42) {
      cat.swat = true;
      crash(state, '猫にはたき落とされました');
    }
  }

  /**
   * 音のパラメータ。Web Audio 側はこれをそのまま使う。
   * ここに置いておくと、音の出し方を変えずに値だけテストできる。
   */
  function audioParams(state, config) {
    const spin = clamp(state.throttleVis, 0, 1);
    const on = state.flying || spin > 0.04;
    const speed = Math.hypot(state.vel.x, state.vel.y, state.vel.z);
    const climb = state.vel.y;
    return {
      on: on && !state.crashed,
      // 4 つのモーターの基本の高さ。スロットルで上がる。
      // 実機 (65mm 2 枚羽・コアレス) はホバリングで 2 万回転を超える。
      // 低いと扇風機に聞こえるので、ここは高めに取る。
      motorHz: 175 + spin * 285 + clamp(climb, -1, 1.5) * 20,
      // スマホの小さいスピーカーだと、ここが小さすぎると何も聞こえない
      motorGain: on && !state.crashed ? 0.055 + spin * 0.125 : 0,
      // 動くほど風切り音が乗る
      windGain: clamp(speed * 0.028, 0, 0.075),
      lowBattery: !!config.battery && state.battery <= config.lowBattery && state.flying
    };
  }

  /** 点 p を AABB に押し込んだ最近点。 */
  function closestOnBox(box, p) {
    return {
      x: clamp(p.x, box.min.x, box.max.x),
      y: clamp(p.y, box.min.y, box.max.y),
      z: clamp(p.z, box.min.z, box.max.z)
    };
  }

  function resolveCollisions(state, env) {
    const config = env.config, room = env.room;
    const r = config.radius, hh = config.halfHeight;

    // --- 床 ---
    if (state.pos.y - hh <= 0) {
      const vy = state.vel.y;
      const hs = Math.hypot(state.vel.x, state.vel.z);
      state.pos.y = hh;
      if (vy < -config.hardLandingSpeed) {
        crash(state, '落下の勢いが強すぎました (' + (-vy).toFixed(1) + ' m/s)');
        return;
      }
      if (hs > config.crashSpeed) {
        crash(state, '横に流れたまま接地しました (' + hs.toFixed(1) + ' m/s)');
        return;
      }
      // 浮いたことのある機体だけが「着地」する。
      // これが無いと、地上から離陸した最初の 1 フレームで着地したことになる。
      if (state.flying && state.airborne) {
        state.touchedDown = true;
        state.touchdownSpeed = -vy;
      }
      state.airborne = false;
      state.flying = false;
      state.landed = true;
      state.vel.y = 0;
      state.vel.x *= 0.15;
      state.vel.z *= 0.15;
    }

    // --- 天井 (広場では「これ以上は上がれない高さ」。当たっても落ちない) ---
    const soft = !!room.open;
    if (state.pos.y + hh >= room.height) {
      const vy = state.vel.y;
      state.pos.y = room.height - hh;
      if (!soft && vy > config.crashSpeed) { crash(state, '天井にぶつかりました'); return; }
      state.vel.y = Math.min(0, state.vel.y);
      state.atLimit = true;
    }

    // --- 壁 ---
    state.atLimit = false;
    const walls = [
      { hit: state.pos.x - r <= room.minX, set: () => { state.pos.x = room.minX + r; }, v: () => state.vel.x, zero: () => { state.vel.x = Math.max(0, state.vel.x); }, sign: -1, name: '左の壁' },
      { hit: state.pos.x + r >= room.maxX, set: () => { state.pos.x = room.maxX - r; }, v: () => state.vel.x, zero: () => { state.vel.x = Math.min(0, state.vel.x); }, sign: 1, name: '右の壁' },
      { hit: state.pos.z - r <= room.minZ, set: () => { state.pos.z = room.minZ + r; }, v: () => state.vel.z, zero: () => { state.vel.z = Math.max(0, state.vel.z); }, sign: -1, name: '手前の壁' },
      { hit: state.pos.z + r >= room.maxZ, set: () => { state.pos.z = room.maxZ - r; }, v: () => state.vel.z, zero: () => { state.vel.z = Math.min(0, state.vel.z); }, sign: 1, name: '奥の壁' }
    ];
    for (const w of walls) {
      if (!w.hit) continue;
      const approach = w.v() * w.sign;
      w.set();
      if (!soft && approach > config.crashSpeed) { crash(state, w.name + 'にぶつかりました'); return; }
      w.zero();
      state.atLimit = true;
    }

    // --- 家具 (球 vs AABB) ---
    for (const f of room.furniture) {
      const c = closestOnBox(f, state.pos);
      let nx = state.pos.x - c.x, ny = state.pos.y - c.y, nz = state.pos.z - c.z;
      let len = Math.hypot(nx, ny, nz);
      if (len >= r) continue;
      if (len < 1e-6) { nx = 0; ny = 1; nz = 0; len = 1; }
      nx /= len; ny /= len; nz /= len;
      const approach = -(state.vel.x * nx + state.vel.y * ny + state.vel.z * nz);
      const push = r - len;
      state.pos.x += nx * push;
      state.pos.y += ny * push;
      state.pos.z += nz * push;
      if (approach > config.crashSpeed) { crash(state, f.name + 'にぶつかりました'); return; }
      // 面に沿わせる
      const dot = state.vel.x * nx + state.vel.y * ny + state.vel.z * nz;
      if (dot < 0) {
        state.vel.x -= dot * nx;
        state.vel.y -= dot * ny;
        state.vel.z -= dot * nz;
      }
      // 上面に降りたら着地扱い
      if (ny > 0.7 && state.flying && state.vel.y <= 0.02) {
        if (state.airborne) {
          state.touchedDown = true;
          state.touchdownSpeed = -state.vel.y;
        }
        state.airborne = false;
        state.flying = false;
        state.landed = true;
        state.vel.y = 0;
      }
    }
  }

  // ------------------------------------------------------------------
  // カメラと 3D → 2D の投影
  // 描画そのものは app.js。ここは計算だけなので node でテストできる。
  // ------------------------------------------------------------------
  const NEAR = 0.10;

  function makeCamera(opts) {
    const o = opts || {};
    return {
      pos: o.pos ? { x: o.pos.x, y: o.pos.y, z: o.pos.z } : { x: 0, y: 1.55, z: -0.75 },
      yaw: o.yaw || 0,
      pitch: o.pitch || 0,
      fovY: o.fovY || 52 * DEG,
      width: o.width || 800,
      height: o.height || 400,
      // 画面上の消失点。スマホでは下にスティックが乗るので、少し上にずらす。
      cx: o.cx != null ? o.cx : (o.width || 800) / 2,
      cy: o.cy != null ? o.cy : (o.height || 400) / 2
    };
  }

  /** 世界の点をカメラから見た座標に。z が正なら前方。 */
  function worldToView(cam, p) {
    const dx = p.x - cam.pos.x, dy = p.y - cam.pos.y, dz = p.z - cam.pos.z;
    const c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
    const x1 = c * dx - s * dz;
    const z1 = s * dx + c * dz;
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const y2 = cp * dy - sp * z1;
    const z2 = sp * dy + cp * z1;
    return { x: x1, y: y2, z: z2 };
  }

  function focalLength(cam) { return (cam.height / 2) / Math.tan(cam.fovY / 2); }

  /** カメラ座標を画面座標に。手前すぎる点は null。 */
  function projectView(cam, v) {
    if (v.z < NEAR) return null;
    const f = focalLength(cam);
    const cx = cam.cx != null ? cam.cx : cam.width / 2;
    const cy = cam.cy != null ? cam.cy : cam.height / 2;
    return { x: cx + f * v.x / v.z, y: cy - f * v.y / v.z, z: v.z };
  }

  function projectPoint(cam, p) { return projectView(cam, worldToView(cam, p)); }

  /**
   * 手前の面 (z = NEAR) で多角形を切る。
   * これをやらないと、カメラの後ろに回った頂点が画面の反対側に飛んで壁がめくれる。
   */
  function clipNear(pts) {
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const ain = a.z >= NEAR, bin = b.z >= NEAR;
      if (ain) out.push(a);
      if (ain !== bin) {
        const t = (NEAR - a.z) / (b.z - a.z);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: NEAR });
      }
    }
    return out;
  }

  /** 世界座標の多角形を、画面上の点の並びに。見えないときは null。 */
  function projectPolygon(cam, worldPts) {
    const view = worldPts.map(p => worldToView(cam, p));
    const clipped = clipNear(view);
    if (clipped.length < 3) return null;
    let depth = 0;
    const screen = new Array(clipped.length);
    for (let i = 0; i < clipped.length; i++) {
      const s = projectView(cam, clipped[i]);
      if (!s) return null;
      screen[i] = s;
      depth += clipped[i].z;
    }
    return { pts: screen, depth: depth / clipped.length };
  }

  /** 水平な円 (床の輪など) を多角形にする。 */
  function circlePoints(cx, cy, cz, r, segments) {
    const n = segments || 28, out = [];
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU;
      out.push({ x: cx + Math.cos(a) * r, y: cy, z: cz + Math.sin(a) * r });
    }
    return out;
  }

  /** 垂直な輪 (ゲート)。法線が (nx, nz) の向きを向く。 */
  function ringPoints(cx, cy, cz, r, nx, nz, segments) {
    const n = segments || 24, out = [];
    const len = Math.hypot(nx, nz) || 1;
    const ux = -nz / len, uz = nx / len;   // 輪の面内の水平軸
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU;
      out.push({ x: cx + ux * Math.cos(a) * r, y: cy + Math.sin(a) * r, z: cz + uz * Math.cos(a) * r });
    }
    return out;
  }

  /**
   * 機体を基準にした点 (右 +x / 上 +y / 機首 +z) を世界座標に。
   * ロール → ピッチ → ヨー の順に回す。機体の絵を描くのに使う。
   */
  function bodyToWorld(state, local, out) {
    const cr = Math.cos(state.roll), sr = Math.sin(state.roll);
    const cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);
    const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw);

    // ロール (機首まわり)。+ で右側が下がる。
    const x1 = local.x * cr + local.y * sr;
    const y1 = -local.x * sr + local.y * cr;
    const z1 = local.z;

    // ピッチ (機体の右軸まわり)。+ で機首が下がる。
    const y2 = y1 * cp - z1 * sp;
    const z2 = y1 * sp + z1 * cp;

    // ヨー (鉛直軸まわり)。
    const x3 = x1 * cy + z2 * sy;
    const z3 = -x1 * sy + z2 * cy;

    const r = out || {};
    r.x = state.pos.x + x3;
    r.y = state.pos.y + y2;
    r.z = state.pos.z + z3;
    return r;
  }

  /**
   * 2 本のスティックの傾き (それぞれ x, y が -1..1。y は上が +) を、
   * 4 つの舵に割りふる。
   *   モード2 … 左: 上下 / 旋回、右: 前後 / 左右 (海外製トイドローンの標準)
   *   モード1 … 左: 前後 / 旋回、右: 上下 / 左右 (日本の古い送信機に多い)
   */
  function mapSticks(mode, left, right) {
    if (mode === 1) {
      return { throttle: right.y, yaw: left.x, pitch: left.y, roll: right.x };
    }
    return { throttle: left.y, yaw: left.x, pitch: right.y, roll: right.x };
  }

  /** そのモードで、スロットルはどちらのスティックの縦か。 */
  function throttleSide(mode) { return mode === 1 ? 'right' : 'left'; }

  /**
   * カメラを機体の方へゆっくり向ける。
   * 人が首を回すのと同じで、画面の端に寄るまでは動かさない (デッドゾーン)。
   */
  function updateCamera(cam, targetPos, dt, opts) {
    const o = opts || {};
    const deadYaw = (o.deadYaw != null ? o.deadYaw : 16) * DEG;
    const deadPitch = (o.deadPitch != null ? o.deadPitch : 11) * DEG;
    const rate = o.rate != null ? o.rate : 2.6;

    const dx = targetPos.x - cam.pos.x, dy = targetPos.y - cam.pos.y, dz = targetPos.z - cam.pos.z;
    const wantYaw = Math.atan2(dx, dz);
    const wantPitch = Math.atan2(dy, Math.hypot(dx, dz));

    const dYaw = wrapPi(wantYaw - cam.yaw);
    const dPitch = wantPitch - cam.pitch;
    const k = approachK(rate, dt);
    if (Math.abs(dYaw) > deadYaw) {
      const excess = dYaw - Math.sign(dYaw) * deadYaw;
      cam.yaw = wrapPi(cam.yaw + excess * k);
    }
    if (Math.abs(dPitch) > deadPitch) {
      const excess = dPitch - Math.sign(dPitch) * deadPitch;
      cam.pitch = clamp(cam.pitch + excess * k, -55 * DEG, 55 * DEG);
    }

    // ここまでは「ゆっくり追う」だけ。速く動かれると追いつけず、
    // 機体が画面から出てしまう。出さないための固い上限を最後にかける。
    if (o.maxYaw != null) {
      const d = wrapPi(wantYaw - cam.yaw);
      if (Math.abs(d) > o.maxYaw) cam.yaw = wrapPi(wantYaw - Math.sign(d) * o.maxYaw);
    }
    if (o.maxPitch != null) {
      const d = wantPitch - cam.pitch;
      if (Math.abs(d) > o.maxPitch) cam.pitch = clamp(wantPitch - Math.sign(d) * o.maxPitch, -75 * DEG, 75 * DEG);
    }
    return cam;
  }

  return {
    DEG, TAU, NEAR,
    mulberry32, clamp, wrapPi, approachK, dist2,
    DEFAULT_CONFIG, makeConfig, randomizeDrift,
    part, decalX, bookSpines, createRoom, createField, clampPilot, createState, step, driftAt, throttleToThrust, headingVectors, closestOnBox,
    createPayload, updatePayload, createCat, updateCat,
    batteryLoad, batterySeconds, audioParams,
    makeCamera, worldToView, projectView, projectPoint, projectPolygon,
    clipNear, focalLength, circlePoints, ringPoints, updateCamera,
    bodyToWorld, mapSticks, throttleSide,
    // 課題まわりは下で継ぎ足す
    __tasks: null
  };
});
