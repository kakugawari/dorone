/* 物理と 3D の計算のテスト。node --test で走る。 */
const test = require('node:test');
const assert = require('node:assert');
const C = require('./core.js');

const DT = 1 / 60;

function env(over) {
  const o = over || {};
  const config = C.makeConfig(Object.assign({ driftAccel: 0, altHoldWobble: 0, trim: { x: 0, z: 0 } }, o.config));
  // config は最後に入れる。over で上書きされないように。
  return Object.assign({ room: C.createRoom() }, o, { config: config });
}
function stick(o) {
  return Object.assign({ throttle: 0, yaw: 0, pitch: 0, roll: 0 }, o || {});
}
function fly(state, input, seconds, e) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) C.step(state, input, DT, e);
  return state;
}

// ---------------------------------------------------------------- 基本の道具

test('wrapPi は角度を -π..π に畳む', () => {
  for (const a of [Math.PI * 3, -Math.PI * 3, 7.5, -7.5, 100]) {
    const w = C.wrapPi(a);
    assert.ok(w >= -Math.PI - 1e-9 && w <= Math.PI + 1e-9, a + ' -> ' + w);
    // 同じ向きを指しているか (2π の整数倍だけ違う)
    assert.ok(Math.abs(Math.sin(w) - Math.sin(a)) < 1e-9 && Math.abs(Math.cos(w) - Math.cos(a)) < 1e-9);
  }
  assert.ok(Math.abs(C.wrapPi(0.5) - 0.5) < 1e-12);
});

test('approachK は dt が大きくても 1 を超えない (発散しない)', () => {
  for (const dt of [1 / 240, 1 / 60, 0.25, 1, 5]) {
    const k = C.approachK(8, dt);
    assert.ok(k > 0 && k <= 1, 'dt=' + dt + ' k=' + k);
  }
});

test('同じ seed からは同じドリフトになる', () => {
  const a = C.randomizeDrift(C.makeConfig(), 42, 1);
  const b = C.randomizeDrift(C.makeConfig(), 42, 1);
  assert.deepStrictEqual(a.phase, b.phase);
  assert.deepStrictEqual(a.trim, b.trim);
  const c = C.randomizeDrift(C.makeConfig(), 43, 1);
  assert.notDeepStrictEqual(a.trim, c.trim);
});

test('難易度を上げるとドリフトが強くなる', () => {
  const easy = C.randomizeDrift(C.makeConfig(), 7, 0.5);
  const hard = C.randomizeDrift(C.makeConfig(), 7, 1.6);
  assert.ok(Math.hypot(hard.trim.x, hard.trim.z) > Math.hypot(easy.trim.x, easy.trim.z));
  assert.ok(hard.driftAccel > easy.driftAccel);
});

// ---------------------------------------------------------------- 機首方向

test('yaw=0 で機首は +z (部屋の奥) を向く', () => {
  const h = C.headingVectors(0);
  assert.ok(Math.abs(h.fwd.x) < 1e-9 && Math.abs(h.fwd.z - 1) < 1e-9);
  assert.ok(Math.abs(h.right.x - 1) < 1e-9 && Math.abs(h.right.z) < 1e-9);
});

test('yaw を増やすと機首は右 (+x) に回る', () => {
  const h = C.headingVectors(Math.PI / 2);
  assert.ok(h.fwd.x > 0.99, '機首が +x を向くはず');
});

// ---------------------------------------------------------------- 上下

test('高度維持: スティックを戻すと高度をほぼ保つ', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 0, z: 2 } });
  fly(s, stick({ throttle: 1 }), 1.2, e);
  const h1 = s.pos.y;
  fly(s, stick(), 8, e);
  assert.ok(Math.abs(s.pos.y - h1) < 0.45, '8 秒放置で ' + (s.pos.y - h1).toFixed(2) + 'm 変化した');
  assert.ok(s.pos.y > 0.5, '落ちてはいけない');
});

test('スロットルを上げっぱなしにすると天井に届く', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 0, z: 2 } });
  fly(s, stick({ throttle: 1 }), 6, e);
  assert.ok(s.pos.y > e.room.height - 0.2, '高度 ' + s.pos.y.toFixed(2));
});

test('ワンキー離陸は 1.0m 前後で落ち着く', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 0, z: 1.7 } });
  s.auto = 'takeoff';
  fly(s, stick(), 8, e);
  assert.ok(s.pos.y > 0.85 && s.pos.y < 1.35, '高度 ' + s.pos.y.toFixed(2) + 'm');
  assert.strictEqual(s.auto, null, '離陸が終わったら手動に戻る');
});

test('ワンキー着陸はそっと降りる', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 0, z: 1.7 } });
  s.auto = 'takeoff';
  fly(s, stick(), 4, e);
  s.auto = 'land';
  fly(s, stick(), 8, e);
  assert.ok(!s.crashed, '墜落してはいけない: ' + s.crashReason);
  assert.ok(!s.flying && s.landed, '着地しているはず');
});

// ---------------------------------------------------------------- 水平

test('傾きは速度ではなく加速度として効く (倒し続けると速くなり続ける)', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 1.4, z: -0.5 } });
  s.flying = true;
  fly(s, stick({ pitch: 1 }), 0.5, e);
  const v1 = s.vel.z;
  fly(s, stick({ pitch: 1 }), 0.7, e);
  const v2 = s.vel.z;
  assert.ok(v2 > v1 + 0.3, '倒し続けたら加速するはず: ' + v1.toFixed(2) + ' -> ' + v2.toFixed(2));
});

test('スティックを戻しても止まらない (惰性で 1m 以上進む)', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 1.6, z: -0.5 } });
  s.flying = true;
  fly(s, stick({ pitch: 1 }), 2, e);
  const z0 = s.pos.z;
  fly(s, stick(), 2.5, e);
  const coast = s.pos.z - z0;
  assert.ok(coast > 1.0, '惰性 ' + coast.toFixed(2) + 'm (1m 以上あってほしい)');
  assert.ok(Math.hypot(s.vel.x, s.vel.z) < 0.15, '最後は止まる');
});

test('逆に倒す (当て舵) と早く止まる', () => {
  const e = env();
  function run(counter) {
    const s = C.createState({ start: { x: 0, y: 1.6, z: -0.5 } });
    s.flying = true;
    fly(s, stick({ pitch: 1 }), 2, e);
    const z0 = s.pos.z;
    fly(s, stick({ pitch: counter ? -1 : 0 }), 0.8, e);
    return { moved: s.pos.z - z0, v: s.vel.z };
  }
  const free = run(false), counter = run(true);
  assert.ok(counter.v < free.v - 0.5, '当て舵のほうが減速する');
  assert.ok(counter.moved < free.moved, '当て舵のほうが進まない');
});

test('roll は機首の向きに対して効く (対面だと世界座標では逆になる)', () => {
  const e = env();
  const away = C.createState({ start: { x: 0, y: 1.4, z: 2 } });      // 機首は奥
  away.flying = true;
  fly(away, stick({ roll: 1 }), 1.2, e);

  const toward = C.createState({ start: { x: 0, y: 1.4, z: 2 }, yaw: Math.PI }); // 機首はこちら
  toward.flying = true;
  fly(toward, stick({ roll: 1 }), 1.2, e);

  assert.ok(away.pos.x > 0.05, '機首が奥なら右スティックで +x へ');
  assert.ok(toward.pos.x < -0.05, '対面なら同じ操作で -x へ (これが左右反転)');
});

test('無操作だとトリムずれでじわじわ流れる', () => {
  const config = C.randomizeDrift(C.makeConfig(), 5, 1);
  const e = { room: C.createRoom(), config: config };
  const s = C.createState({ start: { x: 0, y: 1.3, z: 2 } });
  s.flying = true;
  fly(s, stick(), 20, e);
  const moved = Math.hypot(s.pos.x - 0, s.pos.z - 2);
  assert.ok(moved > 0.3, '20 秒で ' + moved.toFixed(2) + 'm しか流れていない');
  assert.ok(moved < 4.0, '流れすぎ: ' + moved.toFixed(2) + 'm');
});

// ---------------------------------------------------------------- 衝突

test('壁に速く突っこむと墜落する', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 1.4, z: 0 } });
  s.flying = true;
  fly(s, stick({ pitch: 1 }), 6, e);
  assert.ok(s.crashed, '墜落するはず');
  assert.match(s.crashReason, /壁/);
});

test('壁にそっと触れても墜落しない', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 1.4, z: 4.5 } });
  s.flying = true;
  fly(s, stick({ pitch: 0.1 }), 3, e);
  assert.ok(!s.crashed, s.crashReason);
  assert.ok(s.pos.z <= e.room.maxZ - e.config.radius + 1e-6, '壁は抜けない');
});

test('天井に速くぶつかると墜落する', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 0.2, z: 2 } });
  s.flying = true;
  s.vel.y = 3.0;
  fly(s, stick({ throttle: 1 }), 1.5, e);
  assert.ok(s.crashed && /天井/.test(s.crashReason), s.crashReason || '墜落しなかった');
});

test('高度維持ありなら、落下してもセンサーが止めてくれる', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 2.0, z: 2 } });
  s.flying = true;
  s.vel.y = -3.0;
  fly(s, stick(), 2, e);
  assert.ok(!s.crashed, '高度維持が効くので墜落しないはず: ' + s.crashReason);
  assert.ok(s.pos.y > 0.5, '踏みとどまる: ' + s.pos.y.toFixed(2) + 'm');
});

test('高度維持オフ: スロットルを絞ると落ちて墜落する', () => {
  const e = env({ config: { altHold: false } });
  const s = C.createState({ start: { x: 0, y: 2.2, z: 2 } });
  s.flying = true;
  fly(s, stick({ throttle: -1 }), 3, e);
  assert.ok(s.crashed && /落下/.test(s.crashReason), s.crashReason || '墜落しなかった');
});

test('高度維持オフ: スロットル中央あたりでつり合う', () => {
  const e = env({ config: { altHold: false } });
  const s = C.createState({ start: { x: 0, y: 1.2, z: 2 } });
  s.flying = true;
  // 2.2G の機体なので 1/2.2 の推力でつり合う → スティックは -0.09 あたり
  fly(s, stick({ throttle: -0.09 }), 6, e);
  assert.ok(!s.crashed, s.crashReason);
  assert.ok(Math.abs(s.pos.y - 1.2) < 0.35, '6 秒で ' + (s.pos.y - 1.2).toFixed(2) + 'm 動いた');
});

test('高度維持オフ: 傾けると揚力が減って沈む', () => {
  const e = env({ config: { altHold: false } });
  function run(pitch) {
    const s = C.createState({ start: { x: 0, y: 1.8, z: -0.5 } });
    s.flying = true;
    fly(s, stick({ throttle: -0.09, pitch: pitch }), 2.5, e);
    return s.pos.y;
  }
  assert.ok(run(1) < run(0) - 0.05, '倒したほうが沈むはず');
});

test('家具にぶつかる。すり抜けない', () => {
  const e = env();
  const sofa = e.room.furniture.find(f => f.name === 'ソファ');
  const s = C.createState({ start: { x: -1.7, y: 0.4, z: 1.0 } });
  s.flying = true;
  fly(s, stick({ pitch: 1 }), 3, e);
  const insideSofa = s.pos.x > sofa.min.x && s.pos.x < sofa.max.x
    && s.pos.z > sofa.min.z && s.pos.z < sofa.max.z
    && s.pos.y < sofa.max.y;
  assert.ok(!insideSofa, 'ソファをすり抜けた');
});

test('墜落したらそれ以上動かない', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 1.4, z: 0 } });
  s.flying = true;
  fly(s, stick({ pitch: 1 }), 6, e);
  assert.ok(s.crashed);
  const p = { x: s.pos.x, y: s.pos.y, z: s.pos.z };
  fly(s, stick({ throttle: 1, pitch: 1 }), 2, e);
  assert.deepStrictEqual({ x: s.pos.x, y: s.pos.y, z: s.pos.z }, p);
});

test('dt を変えても結果はだいたい同じ (フレームレートに依存しない)', () => {
  function run(dt) {
    const e = env();
    const s = C.createState({ start: { x: 0, y: 0.5, z: 1.0 } });
    s.flying = true;
    const n = Math.round(3 / dt);
    for (let i = 0; i < n; i++) C.step(s, stick({ pitch: 0.6, throttle: 0.3 }), dt, e);
    return s;
  }
  const a = run(1 / 120), b = run(1 / 30);
  assert.ok(Math.abs(a.pos.z - b.pos.z) < 0.12, 'z が ' + Math.abs(a.pos.z - b.pos.z).toFixed(3) + ' ずれた');
  assert.ok(Math.abs(a.pos.y - b.pos.y) < 0.10, 'y が ' + Math.abs(a.pos.y - b.pos.y).toFixed(3) + ' ずれた');
});

// ---------------------------------------------------------------- カメラと投影

test('正面の点は画面の中央に来る', () => {
  const cam = C.makeCamera({ pos: { x: 0, y: 1.5, z: 0 }, width: 800, height: 400 });
  const p = C.projectPoint(cam, { x: 0, y: 1.5, z: 3 });
  assert.ok(Math.abs(p.x - 400) < 1e-6 && Math.abs(p.y - 200) < 1e-6);
});

test('右にある点は画面の右に、上にある点は画面の上に出る', () => {
  const cam = C.makeCamera({ pos: { x: 0, y: 1.5, z: 0 }, width: 800, height: 400 });
  assert.ok(C.projectPoint(cam, { x: 1, y: 1.5, z: 3 }).x > 400);
  assert.ok(C.projectPoint(cam, { x: 0, y: 2.5, z: 3 }).y < 200);
});

test('遠い点ほど画面の中央に寄る (遠近感がある)', () => {
  const cam = C.makeCamera({ pos: { x: 0, y: 1.5, z: 0 }, width: 800, height: 400 });
  const near = C.projectPoint(cam, { x: 1, y: 1.5, z: 2 });
  const far = C.projectPoint(cam, { x: 1, y: 1.5, z: 6 });
  assert.ok(far.x - 400 < near.x - 400);
});

test('カメラの後ろの点は投影されない', () => {
  const cam = C.makeCamera({ pos: { x: 0, y: 1.5, z: 0 } });
  assert.strictEqual(C.projectPoint(cam, { x: 0, y: 1.5, z: -3 }), null);
});

test('手前の面をまたぐ多角形は切られて、画面の反対側に飛ばない', () => {
  const cam = C.makeCamera({ pos: { x: 0, y: 1.5, z: 0 }, width: 800, height: 400 });
  // 半分がカメラの後ろにある床の四角
  const poly = C.projectPolygon(cam, [
    { x: -3, y: 0, z: -2 }, { x: 3, y: 0, z: -2 },
    { x: 3, y: 0, z: 2 }, { x: -3, y: 0, z: 2 }
  ]);
  assert.ok(poly, '見えるはず');
  for (const p of poly.pts) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'NaN が出た');
    assert.ok(p.y > 200, '床はすべて画面の下半分にあるはず (めくれていない)');
  }
});

test('完全に後ろにある多角形は null', () => {
  const cam = C.makeCamera({ pos: { x: 0, y: 1.5, z: 0 } });
  const poly = C.projectPolygon(cam, [
    { x: -1, y: 0, z: -3 }, { x: 1, y: 0, z: -3 }, { x: 1, y: 0, z: -2 }
  ]);
  assert.strictEqual(poly, null);
});

test('カメラは機体をゆっくり追う。デッドゾーンの中では動かない', () => {
  const cam = C.makeCamera({ pos: { x: 0, y: 1.5, z: 0 } });
  const before = cam.yaw;
  C.updateCamera(cam, { x: 0.2, y: 1.5, z: 3 }, 0.5);   // 約 4 度。デッドゾーン内
  assert.strictEqual(cam.yaw, before, 'わずかなズレでは首を振らない');

  C.updateCamera(cam, { x: 3, y: 1.5, z: 1 }, 3);        // 約 72 度。大きく外れた
  assert.ok(cam.yaw > 0.3, 'ちゃんと追う: ' + cam.yaw.toFixed(2));
  assert.ok(cam.yaw < Math.atan2(3, 1), '行き過ぎない');
});

test('ゲートの輪は指定した向きに立つ', () => {
  const pts = C.ringPoints(0, 1, 2, 0.5, 0, 1, 8);   // 法線が +z = z 一定の面
  for (const p of pts) assert.ok(Math.abs(p.z - 2) < 1e-9, '輪は z=2 の面に乗るはず');
  const maxY = Math.max(...pts.map(p => p.y));
  assert.ok(Math.abs(maxY - 1.5) < 1e-9, '縦に立っている');
});

// ---------------------------------------------------------------- 機体の姿勢

test('水平なら、機体の前は世界の +z (yaw=0 のとき)', () => {
  const s = C.createState({ start: { x: 0, y: 1, z: 2 } });
  const p = C.bodyToWorld(s, { x: 0, y: 0, z: 0.2 });
  assert.ok(Math.abs(p.x) < 1e-9 && Math.abs(p.y - 1) < 1e-9 && Math.abs(p.z - 2.2) < 1e-9);
});

test('機首下げにすると、機体の前の点が下がる', () => {
  const s = C.createState({ start: { x: 0, y: 1, z: 2 } });
  s.pitch = 0.3;
  const nose = C.bodyToWorld(s, { x: 0, y: 0, z: 0.2 });
  assert.ok(nose.y < 1, '機首が下がるはず: ' + nose.y.toFixed(3));
  assert.ok(nose.z > 2 && nose.z < 2.2, '前に出たまま');
});

test('右に傾けると、機体の右の点が下がる', () => {
  const s = C.createState({ start: { x: 0, y: 1, z: 2 } });
  s.roll = 0.3;
  const right = C.bodyToWorld(s, { x: 0.2, y: 0, z: 0 });
  assert.ok(right.y < 1, '右が下がるはず: ' + right.y.toFixed(3));
});

test('ヨーで機体ごと回る', () => {
  const s = C.createState({ start: { x: 0, y: 1, z: 2 } });
  s.yaw = Math.PI / 2;
  const nose = C.bodyToWorld(s, { x: 0, y: 0, z: 0.2 });
  assert.ok(Math.abs(nose.x - 0.2) < 1e-9 && Math.abs(nose.z - 2) < 1e-9, '機首が +x を向く');
});

test('機体の各点は、機体の大きさの範囲から出ない', () => {
  const s = C.createState({ start: { x: 1, y: 1.2, z: 2 } });
  s.yaw = 1.1; s.pitch = 0.25; s.roll = -0.2;
  for (const l of [{ x: 0.16, y: 0, z: 0.16 }, { x: -0.16, y: 0.03, z: -0.16 }, { x: 0, y: -0.04, z: 0 }]) {
    const p = C.bodyToWorld(s, l);
    const d = Math.hypot(p.x - 1, p.y - 1.2, p.z - 2);
    const expect = Math.hypot(l.x, l.y, l.z);
    assert.ok(Math.abs(d - expect) < 1e-9, '回転で長さが変わってはいけない');
  }
});

// ---------------------------------------------------------------- スティックの割りふり

test('モード2: 左が上下/旋回、右が前後/左右', () => {
  const i = C.mapSticks(2, { x: 0.3, y: 0.7 }, { x: -0.4, y: 0.5 });
  assert.deepStrictEqual(i, { throttle: 0.7, yaw: 0.3, pitch: 0.5, roll: -0.4 });
  assert.strictEqual(C.throttleSide(2), 'left');
});

test('モード1: スロットルと前後が入れかわる', () => {
  const i = C.mapSticks(1, { x: 0.3, y: 0.7 }, { x: -0.4, y: 0.5 });
  assert.deepStrictEqual(i, { throttle: 0.5, yaw: 0.3, pitch: 0.7, roll: -0.4 });
  assert.strictEqual(C.throttleSide(1), 'right');
});

test('どちらのモードでも、旋回と左右の割りふりは同じ', () => {
  const l = { x: 0.25, y: 0.6 }, r = { x: -0.8, y: -0.1 };
  const m1 = C.mapSticks(1, l, r), m2 = C.mapSticks(2, l, r);
  assert.strictEqual(m1.yaw, m2.yaw);
  assert.strictEqual(m1.roll, m2.roll);
});

// ---------------------------------------------------------------- 消失点のずらし

test('消失点をずらすと、正面の点もそこに来る', () => {
  const cam = C.makeCamera({ pos: { x: 0, y: 1.5, z: 0 }, width: 800, height: 600, cy: 220 });
  const p = C.projectPoint(cam, { x: 0, y: 1.5, z: 3 });
  assert.ok(Math.abs(p.y - 220) < 1e-6, 'y = ' + p.y);
  assert.ok(Math.abs(p.x - 400) < 1e-6, 'cx を指定しなければ中央のまま');
});

test('カメラは、速く動かれても機体を決めた角度より外に出さない', () => {
  const cam = C.makeCamera({ pos: { x: 0, y: 1.5, z: 0 } });
  const maxYaw = 20 * C.DEG;
  // 目の前を横切っていく (追いつけないほど速い動き)
  for (let i = 0; i < 40; i++) {
    const p = { x: -2 + i * 0.12, y: 1.5, z: 1.2 };
    C.updateCamera(cam, p, 1 / 60, { deadYaw: 6, deadPitch: 5, rate: 2.6, maxYaw: maxYaw, maxPitch: 15 * C.DEG });
    const want = Math.atan2(p.x - cam.pos.x, p.z - cam.pos.z);
    assert.ok(Math.abs(C.wrapPi(want - cam.yaw)) <= maxYaw + 1e-9,
      'i=' + i + ' で ' + (C.wrapPi(want - cam.yaw) / C.DEG).toFixed(1) + '度ずれた');
  }
});

test('上下にも上限がかかる', () => {
  const cam = C.makeCamera({ pos: { x: 0, y: 1.5, z: 0 } });
  const maxPitch = 12 * C.DEG;
  for (let i = 0; i < 40; i++) {
    const p = { x: 0, y: 0.05 + i * 0.06, z: 1.2 };
    C.updateCamera(cam, p, 1 / 60, { deadYaw: 6, deadPitch: 5, rate: 2.6, maxYaw: 20 * C.DEG, maxPitch: maxPitch });
    const want = Math.atan2(p.y - cam.pos.y, Math.hypot(p.x - cam.pos.x, p.z - cam.pos.z));
    assert.ok(Math.abs(want - cam.pitch) <= maxPitch + 1e-9,
      'i=' + i + ' で ' + ((want - cam.pitch) / C.DEG).toFixed(1) + '度ずれた');
  }
});

test('上限をかけても、デッドゾーンの中では動かない (動いている感じが残る)', () => {
  const cam = C.makeCamera({ pos: { x: 0, y: 1.5, z: 0 } });
  cam.yaw = 0; cam.pitch = 0;
  const before = cam.yaw;
  C.updateCamera(cam, { x: 0.15, y: 1.5, z: 3 }, 0.5, { deadYaw: 10, deadPitch: 8, maxYaw: 30 * C.DEG, maxPitch: 25 * C.DEG });
  assert.strictEqual(cam.yaw, before);
});
