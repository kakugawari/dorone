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

// ---------------------------------------------------------------- 電池

test('飛んでいる間だけ電池が減る。地上では減らない', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 0, z: 2 } });
  fly(s, stick(), 5, e);
  assert.strictEqual(s.battery, 1, '地上で減った');
  fly(s, stick({ throttle: 0.4 }), 5, e);
  assert.ok(s.battery < 1, '飛んでも減っていない');
});

test('ホバリングなら 7 分ほどもつ', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 0, z: 2 } });
  fly(s, stick({ throttle: 0.5 }), 1.5, e);
  const b0 = s.battery, t0 = s.t;
  fly(s, stick(), 60, e);
  const perSec = (b0 - s.battery) / (s.t - t0);
  const total = 1 / perSec;
  assert.ok(total > 380 && total < 560, 'ホバリングで ' + total.toFixed(0) + ' 秒しかもたない');
});

test('派手に飛ばすほど電池が早く減る', () => {
  const cfg = C.makeConfig();
  const level = { pitch: 0, roll: 0 };
  const tilted = { pitch: cfg.maxTiltDeg * C.DEG, roll: 0 };
  const calm = C.batteryLoad({ throttle: 0 }, level, cfg);
  const climbing = C.batteryLoad({ throttle: 1 }, level, cfg);
  const wild = C.batteryLoad({ throttle: 1 }, tilted, cfg);
  assert.ok(climbing > calm * 1.3, '上げても変わらない ' + calm.toFixed(2) + ' -> ' + climbing.toFixed(2));
  assert.ok(wild > climbing, '傾けても変わらない');

  // 実際に飛ばしても、そのぶん早く減る (壁に当たらない短い時間で見る)
  function used(input) {
    const e = env();
    const s = C.createState({ start: { x: 0, y: 1.0, z: 1.5 } });
    s.flying = true;
    fly(s, input, 2.5, e);
    assert.ok(!s.crashed, s.crashReason);
    return 1 - s.battery;
  }
  assert.ok(used(stick({ throttle: 0.8 })) > used(stick()) * 1.2, '飛ばし方で差が出ない');
});

test('電池が尽きると、操作にかかわらず勝手に降りて着地する', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 1.5, z: 2 }, battery: 0.06 });
  s.flying = true;
  fly(s, stick({ throttle: 1 }), 12, e);   // 上げ続けても止められない
  assert.ok(!s.flying, 'まだ飛んでいる (高度 ' + s.pos.y.toFixed(2) + ')');
  assert.ok(!s.crashed, '墜落してはいけない: ' + s.crashReason);
});

test('電池を切れば減らない', () => {
  const e = env({ config: { battery: false } });
  const s = C.createState({ start: { x: 0, y: 1.2, z: 2 } });
  s.flying = true;
  fly(s, stick({ throttle: 1 }), 30, e);
  assert.strictEqual(s.battery, 1);
});

// ---------------------------------------------------------------- 平たい機体の当たり判定

test('テーブルの下をくぐれる (球ではなく平たい円柱として当たる)', () => {
  const e = env();
  const top = e.room.furniture.find(f => f.name === 'テーブルの天板');
  const s = C.createState({ start: { x: 0.375, y: 0.20, z: 1.2 } });
  s.flying = true;
  fly(s, stick({ pitch: 0.25 }), 7, e);
  assert.ok(!s.crashed, '当たった: ' + s.crashReason);
  assert.ok(s.pos.z > top.max.z, 'くぐり抜けられていない (z=' + s.pos.z.toFixed(2) + ')');
  assert.ok(s.pos.y < top.min.y, '上を越えてしまった');
});

test('天板の高さで突っこめば当たる', () => {
  const e = env();
  const s = C.createState({ start: { x: 0.375, y: 0.38, z: 1.2 } });
  s.flying = true;
  fly(s, stick({ pitch: 1 }), 4, e);
  assert.ok(s.crashed && /天板/.test(s.crashReason), s.crashReason || '当たらなかった');
});

test('テーブルの脚には当たる', () => {
  const e = env();
  const s = C.createState({ start: { x: -0.25, y: 0.20, z: 1.2 } });
  s.flying = true;
  fly(s, stick({ pitch: 1 }), 4, e);
  assert.ok(s.crashed && /脚/.test(s.crashReason), s.crashReason || '脚をすり抜けた');
});

// ---------------------------------------------------------------- 吊り荷物

function payloadEnv() {
  const e = env();
  return e;
}

test('荷物の真上まで下りると、自動でひっかかる', () => {
  const e = payloadEnv();
  const s = C.createState({ start: { x: -1.4, y: 0, z: 1.0 } });
  s.payload = C.createPayload(-1.4, 1.5);
  s.auto = 'takeoff';
  fly(s, stick(), 4, e);
  assert.ok(!s.payload.attached, 'まだ拾ってはいけない (1.1m の高さ)');
  // 荷物の上まで行って下りる
  for (let i = 0; i < 60 * 12; i++) {
    const dz = 1.5 - s.pos.z, dx = -1.4 - s.pos.x;
    C.step(s, stick({
      throttle: C.clamp((0.45 - s.pos.y) * 1.6 - s.vel.y * 0.5, -1, 1),
      pitch: C.clamp(dz * 0.9 - s.vel.z * 1.5, -1, 1),
      roll: C.clamp(dx * 0.9 - s.vel.x * 1.5, -1, 1)
    }), DT, e);
    if (s.payload.attached) break;
  }
  assert.ok(s.payload.attached, '拾えなかった');
});

test('吊った荷物は振り子として揺れ、機体を引っぱり返す', () => {
  const e = payloadEnv();
  const s = C.createState({ start: { x: 0, y: 1.2, z: 1.0 } });
  s.flying = true;
  s.payload = C.createPayload(0, 1.0);
  s.payload.attached = true;
  // 急に前へ。振れの「いちばん大きかったところ」を見る (1 秒後には戻りかけている)
  let swing = 0;
  for (let i = 0; i < 90; i++) {
    C.step(s, stick({ pitch: 1 }), DT, e);
    swing = Math.max(swing, Math.hypot(s.payload.ox, s.payload.oz));
  }
  assert.ok(swing > 0.06, '揺れていない (' + swing.toFixed(3) + 'm)');
  // 紐の長さは超えない
  assert.ok(swing <= e.config.payloadLength, '紐より外に出た');
  // 手を止めると、揺れは収まっていく
  fly(s, stick(), 6, e);
  assert.ok(Math.hypot(s.payload.ox, s.payload.oz) < swing, '揺れが収まらない');
});

test('荷物を吊ると、同じ操作でも動きが鈍る', () => {
  function run(withPayload) {
    const e = payloadEnv();
    const s = C.createState({ start: { x: 0, y: 1.4, z: -0.5 } });
    s.flying = true;
    if (withPayload) { s.payload = C.createPayload(0, -0.5); s.payload.attached = true; }
    fly(s, stick({ pitch: 1 }), 1.0, e);
    return s.vel.z;
  }
  assert.ok(run(true) < run(false), '荷物があっても同じ加速では困る');
});

test('落ちついて下ろせば、その場に置ける', () => {
  const e = payloadEnv();
  const s = C.createState({ start: { x: 0.0, y: 0.9, z: 1.0 } });
  s.flying = true;
  s.payload = C.createPayload(0, 1.0);
  s.payload.attached = true;
  fly(s, stick(), 3, e);                      // 揺れを止める
  fly(s, stick({ throttle: -0.35 }), 2.5, e); // そっと下ろす
  assert.ok(!s.payload.attached, 'まだ吊ったまま');
  // 下ろしたあと、そのまま下りても拾い直さない
  fly(s, stick({ throttle: -0.35 }), 3, e);
  assert.ok(!s.payload.attached, '置いた荷物をまた拾ってしまった');
  assert.ok(s.payload.justDropped || Math.hypot(s.payload.home.x - 0, s.payload.home.z - 1.0) < 0.5, '置いた所が記録されていない');
  assert.ok(!s.crashed, s.crashReason);
});

test('荷物が家具に引っかかると分かる', () => {
  const e = payloadEnv();
  const top = e.room.furniture.find(f => f.name === 'テーブルの天板');
  // 天板の高さ + 紐の長さ で飛ぶと、荷物が天板にぶつかる
  const s = C.createState({ start: { x: 0.375, y: top.max.y + 0.30, z: 1.6 } });
  s.flying = true;
  s.payload = C.createPayload(0.375, 1.6);
  s.payload.attached = true;
  fly(s, stick({ pitch: 0.5 }), 4, e);
  assert.ok(s.crashed && /引っかかり/.test(s.crashReason), s.crashReason || '引っかからなかった');
});

// ---------------------------------------------------------------- 猫

test('高いところを飛んでいれば、猫は寄ってこない', () => {
  const e = env();
  e.cat = C.createCat(e.room, 3);
  const s = C.createState({ start: { x: 0, y: 1.6, z: 2.0 } });
  s.flying = true;
  fly(s, stick(), 30, e);
  assert.ok(!s.crashed, '落とされた: ' + s.crashReason);
  assert.ok(e.cat.mood < 0.35, '猫が狙っている (mood ' + e.cat.mood.toFixed(2) + ')');
});

test('低いところを飛ぶと猫が寄ってきて、はたき落とされる', () => {
  const e = env();
  e.cat = C.createCat(e.room, 3);
  // テーブルの上ではなく、開けた所で低く飛ぶ
  const s = C.createState({ start: { x: 1.8, y: 0.5, z: 3.2 } });
  s.flying = true;
  fly(s, stick(), 40, e);
  assert.ok(s.crashed && /猫/.test(s.crashReason), s.crashReason || '猫が来なかった (mood ' + e.cat.mood.toFixed(2) + ')');
});

test('猫は部屋から出ない', () => {
  const e = env();
  e.cat = C.createCat(e.room, 11);
  const s = C.createState({ start: { x: 0, y: 1.8, z: 2.0 } });
  s.flying = true;
  for (let i = 0; i < 60 * 60; i++) {
    C.step(s, stick(), DT, e);
    assert.ok(e.cat.x > e.room.minX && e.cat.x < e.room.maxX, '猫が壁を抜けた x=' + e.cat.x);
    assert.ok(e.cat.z > e.room.minZ && e.cat.z < e.room.maxZ, '猫が壁を抜けた z=' + e.cat.z);
  }
});

test('猫の動きは seed から決まる (再現できる)', () => {
  function run(seed) {
    const e = env();
    e.cat = C.createCat(e.room, seed);
    const s = C.createState({ start: { x: 0, y: 1.8, z: 2.0 } });
    s.flying = true;
    fly(s, stick(), 20, e);
    return [e.cat.x.toFixed(4), e.cat.z.toFixed(4)].join(',');
  }
  assert.strictEqual(run(5), run(5));
  assert.notStrictEqual(run(5), run(6));
});

// ---------------------------------------------------------------- 音

test('スロットルを上げると、モーターの音が高く大きくなる', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 0.6, z: 2 } });
  s.flying = true;
  fly(s, stick(), 2, e);
  const idle = C.audioParams(s, e.config);
  fly(s, stick({ throttle: 1 }), 1.0, e);   // 天井に当たらない範囲で
  assert.ok(!s.crashed, s.crashReason);
  const up = C.audioParams(s, e.config);
  assert.ok(up.motorHz > idle.motorHz + 10, '高さが変わらない ' + idle.motorHz.toFixed(0) + ' -> ' + up.motorHz.toFixed(0));
  assert.ok(up.motorGain > idle.motorGain, '大きさが変わらない');
});

test('速く動くほど風切り音が乗る。止まれば消える', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 1.5, z: -0.5 } });
  s.flying = true;
  assert.ok(C.audioParams(s, e.config).windGain < 0.005, '止まっているのに鳴っている');
  fly(s, stick({ pitch: 1 }), 2, e);
  assert.ok(C.audioParams(s, e.config).windGain > 0.02, '動いても鳴らない');
});

test('地上で止まっていれば音は鳴らない。墜落しても止まる', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 0, z: 2 } });
  assert.strictEqual(C.audioParams(s, e.config).on, false);
  s.flying = true; s.throttleVis = 0.8;
  assert.strictEqual(C.audioParams(s, e.config).on, true);
  s.crashed = true;
  assert.strictEqual(C.audioParams(s, e.config).on, false);
  assert.strictEqual(C.audioParams(s, e.config).motorGain, 0);
});

test('電池が減ると音の合図が立つ', () => {
  const e = env();
  const s = C.createState({ start: { x: 0, y: 1.2, z: 2 } });
  s.flying = true;
  assert.strictEqual(C.audioParams(s, e.config).lowBattery, false);
  s.battery = 0.2;
  assert.strictEqual(C.audioParams(s, e.config).lowBattery, true);
});

// ---------------------------------------------------------------- 家具の形

test('家具のパーツは部屋の中に収まっている', () => {
  const room = C.createRoom();
  for (const f of room.furniture) {
    assert.ok(f.min.x >= room.minX - 1e-9 && f.max.x <= room.maxX + 1e-9, f.name + ' が横にはみ出している');
    assert.ok(f.min.z >= room.minZ - 1e-9 && f.max.z <= room.maxZ + 1e-9, f.name + ' が奥行きにはみ出している');
    assert.ok(f.min.y >= -1e-9 && f.max.y <= room.height, f.name + ' が高さにはみ出している');
    assert.ok(f.max.x > f.min.x && f.max.y > f.min.y && f.max.z > f.min.z, f.name + ' の大きさが 0 以下');
  }
});

test('主な家具は箱の組み合わせでできている (1 つの箱だと何か分からない)', () => {
  const room = C.createRoom();
  const count = {};
  room.furniture.forEach(function (f) { count[f.name] = (count[f.name] || 0) + 1; });
  // ソファは座面・背もたれ・肘掛け、本棚は棚板、といった具合に分ける
  for (const name of ['ソファ', 'テレビ台', '本棚', '観葉植物']) {
    assert.ok((count[name] || 0) >= 3, name + ' が ' + (count[name] || 0) + ' パーツしかない');
  }
  assert.ok((count['テーブルの脚'] || 0) === 4, 'テーブルの脚は 4 本');
});

test('ほかのパーツに埋まって見えないパーツがない', () => {
  // 奥から順に塗るだけなので、箱の中にすっぽり入れた箱は必ず隠れる。
  // 棚板のように「前だけ出ている」のは正しい (それで棚に見える)。
  // どの面からも出ていないものだけが、置き間違い。
  const f = C.createRoom().furniture;
  const eps = 0.005;
  const inside = function (a, b) {   // a が b にすっぽり入っているか
    return a.min.x >= b.min.x - eps && a.max.x <= b.max.x + eps
      && a.min.y >= b.min.y - eps && a.max.y <= b.max.y + eps
      && a.min.z >= b.min.z - eps && a.max.z <= b.max.z + eps;
  };
  for (let i = 0; i < f.length; i++) {
    for (let j = 0; j < f.length; j++) {
      if (i === j) continue;
      assert.ok(!inside(f[i], f[j]),
        '「' + f[i].name + '」が「' + f[j].name + '」の中に埋まっていて、どこからも見えない');
    }
  }
});

// ---------------------------------------------------------------- 面に貼る板 (デカール)

test('貼る板は当たり判定を持たない (家具ではない)', () => {
  const room = C.createRoom();
  assert.ok(room.decals.length > 8, '貼る板が少なすぎる: ' + room.decals.length);
  // 家具の配列に混ざっていないこと (混ざると当たってしまう)
  for (const d of room.decals) assert.ok(!room.furniture.includes(d));
  // 当たるのは本棚そのもの。板の名前が出ることはない。
  const e = env();
  const s = C.createState({ start: { x: -1.0, y: 0.65, z: 0.7 } });
  s.flying = true;
  fly(s, stick({ roll: -1 }), 4, e);
  assert.ok(s.crashed, '本棚に当たるはず (x=' + s.pos.x.toFixed(2) + ')');
  assert.match(s.crashReason, /本棚/, '当たった相手: ' + s.crashReason);
  // 本棚の前面より奥には入れない
  const shelf = room.furniture.find(f => f.name === '本棚');
  assert.ok(s.pos.x >= shelf.max.x - 0.01, '本棚をすり抜けた');
});

test('貼る板は家具の面より手前にある (埋まって見えなくならない)', () => {
  const room = C.createRoom();
  for (const d of room.decals) {
    // いまはすべて x 一定の面に貼っている
    const x = d.pts[0].x;
    for (const p of d.pts) assert.strictEqual(p.x, x, '板が平らでない');
    let buried = null;
    for (const f of room.furniture) {
      const ys = d.pts.map(p => p.y), zs = d.pts.map(p => p.z);
      const inY = Math.min(...ys) >= f.min.y - 1e-9 && Math.max(...ys) <= f.max.y + 1e-9;
      const inZ = Math.min(...zs) >= f.min.z - 1e-9 && Math.max(...zs) <= f.max.z + 1e-9;
      if (inY && inZ && x > f.min.x - 1e-9 && x < f.max.x - 1e-9) buried = f.name;
    }
    assert.strictEqual(buried, null, '板が「' + buried + '」の中に入っていて見えない');
  }
});

test('本の背表紙は棚の中に収まっていて、幅も高さもばらけている', () => {
  const room = C.createRoom();
  const shelf = room.furniture.find(f => f.name === '本棚');
  const widths = new Set(), tops = new Set();
  for (const d of room.decals) {
    const zs = d.pts.map(p => p.z), ys = d.pts.map(p => p.y);
    assert.ok(Math.min(...zs) >= shelf.min.z && Math.max(...zs) <= shelf.max.z, '本が棚からはみ出している');
    assert.ok(Math.min(...ys) >= 0 && Math.max(...ys) <= shelf.max.y, '本が棚より高い/低い');
    widths.add((Math.max(...zs) - Math.min(...zs)).toFixed(3));
    tops.add(Math.max(...ys).toFixed(3));
  }
  assert.ok(widths.size > 5, '本の幅が同じものばかり (' + widths.size + ' 種)');
  assert.ok(tops.size > 5, '本の高さが同じものばかり (' + tops.size + ' 種)');
});

test('本の並びは seed から決まる (毎回同じ)', () => {
  const a = C.createRoom().decals.map(d => d.color + d.pts[0].z.toFixed(4)).join(',');
  const b = C.createRoom().decals.map(d => d.color + d.pts[0].z.toFixed(4)).join(',');
  assert.strictEqual(a, b);
});
