/* 課題・採点・原因診断のテスト。
   自動操縦(下の autopilot)で「上手な飛び方」を再現して、
   課題がちゃんとクリアできること・下手な飛び方をちゃんと指摘することを確かめる。 */
const test = require('node:test');
const assert = require('node:assert');
const C = require('./core.js');
const T = require('./tasks.js');

const DT = 1 / 60;

function makeEnv(task, seed, difficulty) {
  const config = C.randomizeDrift(C.makeConfig(), seed || 1, difficulty == null ? 1 : difficulty);
  return { room: C.createRoom(), config: config, wind: task && task.wind ? task.wind : null };
}

function startState(task) {
  return C.createState({ start: task.start, yaw: task.startYaw || 0 });
}

/**
 * 素直な自動操縦。目標へ向かう PD 制御。
 * 「速度も見て当て舵を入れる」ので、うまい人の操作に近い。
 */
function autopilot(state, target, opts) {
  const o = opts || {};
  const kp = o.kp == null ? 0.9 : o.kp;
  const kd = o.kd == null ? 1.5 : o.kd;      // 0 にすると当て舵なし = 下手な人
  const ex = target.x - state.pos.x, ez = target.z - state.pos.z;
  // 世界座標での希望加速度
  const ax = kp * ex - kd * state.vel.x;
  const az = kp * ez - kd * state.vel.z;
  // 機体の向きに直す
  const h = C.headingVectors(state.yaw);
  const pitch = C.clamp(ax * h.fwd.x + az * h.fwd.z, -1, 1);
  const roll = C.clamp(ax * h.right.x + az * h.right.z, -1, 1);
  const throttle = C.clamp((target.y - state.pos.y) * 1.6 - state.vel.y * 0.5, -1, 1);
  let yaw = 0;
  if (o.yawTarget != null) yaw = C.clamp(C.wrapPi(o.yawTarget - state.yaw) * 1.4, -1, 1);
  return { throttle: throttle, yaw: yaw, pitch: pitch, roll: roll };
}

/** 課題を自動操縦で最後まで飛ばす。 */
function playTask(taskId, opts) {
  const o = opts || {};
  const task = T.findTask(taskId);
  const env = makeEnv(task, o.seed || 1, o.difficulty);
  const state = startState(task);
  const run = T.createRun(taskId, o.seed || 1);
  const maxSteps = Math.round((task.limit + 3) / DT);

  for (let i = 0; i < maxSteps && !run.finished; i++) {
    const target = o.aim ? o.aim(state, run, task) : defaultAim(state, run, task);
    const input = o.pilot
      ? o.pilot(state, run, task, target)
      : autopilot(state, target, { kd: o.kd, kp: o.kp, yawTarget: yawTargetFor(task, state, env) });
    C.step(state, input, DT, env);
    T.stepRun(run, state, input, DT, env);
  }
  return { run: run, state: state, env: env, task: task };
}

function yawTargetFor(task, state, env) {
  if (task.faceCamera) return Math.atan2(env.room.pilot.x - state.pos.x, env.room.pilot.z - state.pos.z);
  return 0;
}

function defaultAim(state, run, task) {
  if (task.kind === 'hover') return task.target;
  if (task.kind === 'altitude') return { x: state.pos.x, y: task.targetY, z: state.pos.z };
  if (task.kind === 'gates') {
    const g = task.gates[Math.min(run.gateIndex, task.gates.length - 1)];
    return { x: g.x, y: g.y, z: g.z };
  }
  if (task.kind === 'land') {
    const d = Math.hypot(state.pos.x - task.pad.x, state.pos.z - task.pad.z);
    // 真上まで来て、水平が止まってから、ゆっくり降ろす。
    // 一気に下げると接地が速すぎて失敗する (実機と同じ)
    const settled = d < 0.18 && Math.hypot(state.vel.x, state.vel.z) < 0.15;
    return { x: task.pad.x, y: settled ? state.pos.y - 0.3 : 1.1, z: task.pad.z };
  }
  return task.start;
}

// ---------------------------------------------------------------- 課題の定義

test('課題は 7 つ。id が重複していない', () => {
  const ids = T.TASKS.map(t => t.id);
  assert.strictEqual(ids.length, 7);
  assert.strictEqual(new Set(ids).size, 7);
});

test('どの課題も、開始地点が部屋の中で、家具に埋まっていない', () => {
  const room = C.createRoom(), config = C.makeConfig();
  for (const task of T.TASKS) {
    const p = { x: task.start.x, y: config.radius, z: task.start.z };
    assert.ok(p.x > room.minX && p.x < room.maxX, task.id + ' の開始 x が部屋の外');
    assert.ok(p.z > room.minZ && p.z < room.maxZ, task.id + ' の開始 z が部屋の外');
    for (const f of room.furniture) {
      const c = C.closestOnBox(f, p);
      const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
      assert.ok(d >= config.radius, task.id + ' の開始地点が「' + f.name + '」と重なっている');
    }
  }
});

test('ゲートと目標の輪も、家具に埋まっていない', () => {
  const room = C.createRoom();
  const spots = [];
  for (const task of T.TASKS) {
    if (task.kind === 'gates') for (const g of task.gates) spots.push([task.id, g]);
    if (task.kind === 'hover') spots.push([task.id, task.target]);
    if (task.kind === 'land') spots.push([task.id, { x: task.pad.x, y: 0.2, z: task.pad.z }]);
  }
  for (const [id, g] of spots) {
    for (const f of room.furniture) {
      const c = C.closestOnBox(f, g);
      const d = Math.hypot(g.x - c.x, g.y - c.y, g.z - c.z);
      assert.ok(d > 0.25, id + ' の目標が「' + f.name + '」と近すぎる (' + d.toFixed(2) + 'm)');
    }
    assert.ok(g.y < room.height - 0.3, id + ' の目標が天井に近すぎる');
  }
});

// ---------------------------------------------------------------- クリアできるか

for (const id of ['hover', 'altitude', 'box', 'nose', 'land', 'wind', 'eight']) {
  test('「' + T.findTask(id).name + '」は上手に飛べばクリアできる', () => {
    const failures = [];
    for (const seed of [1, 2, 3]) {
      const r = playTask(id, { seed: seed });
      if (!r.run.success) failures.push('seed' + seed + ': ' + (r.run.message || r.state.crashReason || '?'));
    }
    assert.deepStrictEqual(failures, [], id + ' が失敗した');
  });
}

test('全部の課題を通しで飛ばしても、どこかで固まったりしない', () => {
  for (const task of T.TASKS) {
    const r = playTask(task.id, { seed: 9 });
    assert.ok(r.run.finished, task.id + ' が終わらなかった');
    assert.ok(Number.isFinite(r.state.pos.x + r.state.pos.y + r.state.pos.z), task.id + ' で NaN が出た');
  }
});

// ---------------------------------------------------------------- 採点

test('上手に飛ぶほど星が多い', () => {
  const good = playTask('hover', { seed: 1 }).run;
  const sloppy = playTask('hover', {
    seed: 1,
    // わざとガタガタ操作する
    pilot: (state, run, task) => {
      const base = autopilot(state, task.target, { kd: 1.5 });
      const j = Math.sin(run.elapsed * 40) * 0.85;
      return { throttle: C.clamp(base.throttle + j, -1, 1), yaw: 0,
               pitch: C.clamp(base.pitch + j, -1, 1), roll: C.clamp(base.roll - j, -1, 1) };
    }
  }).run;
  assert.ok(good.success, '上手なほうはクリアするはず');
  assert.ok(good.score.roughness < sloppy.score.roughness, 'ガタガタのほうが乱暴と判定されるはず');
  if (sloppy.success) assert.ok(good.stars >= sloppy.stars, '上手なほうが星が多い');
});

test('星は 1〜3。失敗したら 0', () => {
  const ok = playTask('hover', { seed: 2 }).run;
  assert.ok(ok.stars >= 1 && ok.stars <= 3, '星 ' + ok.stars);
  const fail = playTask('hover', { seed: 2, pilot: () => ({ throttle: 1, yaw: 0, pitch: 1, roll: 0 }) }).run;
  assert.ok(!fail.success && fail.stars === 0);
});

test('採点の内訳は 0〜1 に収まる', () => {
  const r = playTask('box', { seed: 4 }).run;
  for (const k of ['accuracy', 'smooth', 'speed', 'total']) {
    assert.ok(r.score[k] >= 0 && r.score[k] <= 1, k + ' = ' + r.score[k]);
  }
});

// ---------------------------------------------------------------- 原因の診断

test('一度も浮かなければ、そう言う', () => {
  const r = playTask('hover', { seed: 1, pilot: () => ({ throttle: 0, yaw: 0, pitch: 0, roll: 0 }) }).run;
  assert.ok(!r.success);
  assert.match(r.notes.join('\n'), /一度も浮いていません/);
});

test('スロットル入れっぱなしを指摘する', () => {
  const r = playTask('hover', { seed: 1, pilot: () => ({ throttle: 1, yaw: 0, pitch: 0, roll: 0 }) }).run;
  assert.match(r.notes.join('\n'), /スロットルを.*入れっぱなし|天井/);
});

test('傾けっぱなしを指摘する', () => {
  // 助走のとれる③で、浮いたあと右スティックを前に倒したまま放置する
  const r = playTask('box', { seed: 1, pilot: (s) => ({ throttle: s.pos.y < 1.1 ? 0.7 : 0, yaw: 0, pitch: s.pos.y < 1.1 ? 0 : 0.9, roll: 0 }) }).run;
  assert.ok(!r.success);
  assert.match(r.notes.join('\n'), /倒しっぱなし/, '実際の指摘: ' + r.notes.join(' / '));
});

test('当て舵をしない飛び方を指摘する', () => {
  // kd = 0 : 位置だけ見て速度を見ない = 行き過ぎては戻すを繰り返す下手な操作。
  // ①は最初から目標の真下にいて移動しないので、動きのある③で試す
  const r = playTask('box', { seed: 1, kd: 0, kp: 1.2 }).run;
  const text = r.notes.join('\n');
  assert.match(text, /当て舵|逆に倒|遠ざかる/, '実際の指摘: ' + text);
});

test('対面での左右反転を指摘する', () => {
  // 対面課題を「自分から見た左右」で操作してしまう = roll の符号が逆
  const r = playTask('nose', {
    seed: 1,
    pilot: (state, run, task, target) => {
      const env = { room: C.createRoom() };
      const good = autopilot(state, target, { yawTarget: yawTargetFor(task, state, env) });
      return { throttle: good.throttle, yaw: good.yaw, pitch: -good.pitch, roll: -good.roll };
    }
  }).run;
  assert.ok(!r.success, '逆に操作したら失敗するはず');
  assert.match(r.notes.join('\n'), /左右が入れかわ|遠ざかる向き/, '実際の指摘: ' + r.notes.join('\n'));
});

test('うまく飛べたときは、ダメ出しをしない', () => {
  const r = playTask('hover', { seed: 3 }).run;
  assert.ok(r.success);
  assert.match(r.notes.join('\n'), /きれいに飛べています/);
});

// ---------------------------------------------------------------- 記録

test('軌跡が記録され、上限で頭から捨てられる', () => {
  const r = playTask('altitude', { seed: 1 }).run;
  assert.ok(r.samples.length > 30, '軌跡が短すぎる: ' + r.samples.length);
  assert.ok(r.samples.length <= 1200, '上限を超えている');
  for (const s of r.samples) assert.ok(Number.isFinite(s.x + s.y + s.z));
});

test('時間切れで必ず終わる', () => {
  const task = T.findTask('hover');
  const r = playTask('hover', { seed: 1, pilot: (s) => ({ throttle: s.pos.y < 1.0 ? 0.5 : 0, yaw: 0, pitch: 0, roll: 0 }) });
  // 何もしなければドリフトで輪から出て、時間切れか墜落で終わる
  assert.ok(r.run.finished);
  assert.ok(r.run.elapsed <= task.limit + 0.5, '制限時間を超えて走り続けた: ' + r.run.elapsed);
});

test('墜落したら、その理由がそのまま結果に出る', () => {
  const r = playTask('hover', { seed: 1, pilot: () => ({ throttle: 0.5, yaw: 0, pitch: 1, roll: 0 }) });
  assert.ok(!r.run.success);
  assert.ok(r.run.message.length > 0, '理由が空');
  assert.strictEqual(r.run.message, r.state.crashReason);
});
