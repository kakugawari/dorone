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
  function createRoom() {
    return {
      minX: -2.6, maxX: 2.6,
      minZ: -1.0, maxZ: 5.0,
      height: 2.4,
      // 操縦者 (= カメラ) の立ち位置と目の高さ
      pilot: { x: 0, y: 1.55, z: -0.75 },
      furniture: [
        { name: 'ソファ',     min: { x: -2.55, y: 0, z: 2.55 }, max: { x: -0.95, y: 0.78, z: 3.60 }, color: '#4a5570' },
        { name: 'ローテーブル', min: { x: -0.35, y: 0, z: 2.30 }, max: { x: 1.10, y: 0.40, z: 3.25 }, color: '#6b5842' },
        { name: 'テレビ台',   min: { x: 1.35, y: 0, z: 4.30 }, max: { x: 2.55, y: 0.52, z: 4.95 }, color: '#3d4356' },
        { name: '本棚',       min: { x: -2.55, y: 0, z: 0.10 }, max: { x: -2.10, y: 1.30, z: 1.30 }, color: '#5a4a3a' },
        { name: '観葉植物',   min: { x: 2.05, y: 0, z: 0.20 }, max: { x: 2.50, y: 1.15, z: 0.75 }, color: '#3f6b4a' }
      ]
    };
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
      crashed: false,
      crashReason: '',
      landed: false,
      touchedDown: false,       // このフレームで接地したか
      touchdownSpeed: 0,
      auto: null                // 'takeoff' | 'land' | null
    };
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

    state.pos.x += state.vel.x * dt;
    state.pos.y += state.vel.y * dt;
    state.pos.z += state.vel.z * dt;

    if (state.pos.y > 0.25) state.airborne = true;
    state.touchedDown = false;
    resolveCollisions(state, env);

    state.throttleVis += (0.55 + 0.45 * inp.throttle - state.throttleVis) * approachK(6, dt);
    state.spin = (state.spin + (18 + state.throttleVis * 45) * dt) % TAU;
    state.t += dt;
    return state;
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

    // --- 天井 ---
    if (state.pos.y + hh >= room.height) {
      const vy = state.vel.y;
      state.pos.y = room.height - hh;
      if (vy > config.crashSpeed) { crash(state, '天井にぶつかりました'); return; }
      state.vel.y = Math.min(0, state.vel.y);
    }

    // --- 壁 ---
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
      if (approach > config.crashSpeed) { crash(state, w.name + 'にぶつかりました'); return; }
      w.zero();
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
    createRoom, createState, step, driftAt, throttleToThrust, headingVectors, closestOnBox,
    makeCamera, worldToView, projectView, projectPoint, projectPolygon,
    clipNear, focalLength, circlePoints, ringPoints, updateCamera,
    bodyToWorld, mapSticks, throttleSide,
    // 課題まわりは下で継ぎ足す
    __tasks: null
  };
});
