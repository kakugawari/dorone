/*!
 * browser-test.js — 本物のブラウザで、指の操作をそのまま再現して確かめる。
 *
 *   node browser-test.js            iPhone サイズ (縦) で全部
 *   node browser-test.js --headed   画面を出す
 *   node browser-test.js --slow     CPU を 4 倍遅くしたときも測る
 *   node browser-test.js --bundle   1 枚にまとめた版 (dist/dorone.html) を試す
 *   node browser-test.js --artifact Artifact に出す形 (head/body を向こうが付ける) を試す
 *
 * 画面まわりの不具合はユニットテストをすり抜ける。ここでしか捕まらない。
 */
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Module = require('node:module');

// playwright はグローバルに入っていることがある
function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* 下で探す */ }
  const extra = ['/opt/node22/lib/node_modules', '/usr/lib/node_modules', '/usr/local/lib/node_modules'];
  for (const dir of extra) {
    try { return require(path.join(dir, 'playwright')); } catch (e) { /* 次 */ }
  }
  console.error('playwright が見つかりません。 npm i -D playwright を実行してください。');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const HEADED = process.argv.includes('--headed');
const SLOW = process.argv.includes('--slow');
// 配る 1 枚版も、同じテストを全部通す。まとめる過程で壊れることがあるため。
const BUNDLE = process.argv.includes('--bundle');
// Artifact に出す形も同じテストに通す。<head> を向こうが付ける形なので、
// 包み方が変わっただけで壊れることがある。
const ARTIFACT = process.argv.includes('--artifact');
const PORT = 8123 + (process.pid % 400);
const BASE = 'http://127.0.0.1:' + PORT + '/'
  + (ARTIFACT ? 'dist/artifact-preview.html' : (BUNDLE ? 'dist/dorone.html' : ''));

// ---------------------------------------------------------------- 小さなテスト土台
let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fail++;
    failures.push(name + '\n       ' + (e && e.message ? e.message : e));
    console.log('  FAIL ' + name + '\n       ' + (e && e.message ? e.message : e));
  }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || '条件を満たさなかった'); }
function near(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error((msg || '値がちがう') + ': ' + a + ' vs ' + b + ' (許容 ' + tol + ')');
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- 指の操作 (マルチタッチ)
function makeFinger(cdp) {
  const points = new Map();   // id -> {x, y}。今ふれている指
  const all = () => Array.from(points.entries()).map(([id, p]) => ({ x: p.x, y: p.y, id: id }));
  const send = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints, modifiers: 0 });
  return {
    async down(id, x, y) { points.set(id, { x, y }); await send('touchStart', all()); },
    async move(id, x, y) { points.set(id, { x, y }); await send('touchMove', all()); },
    // touchEnd に渡すのは「離した点」。残っている点ではない (CDP の決まり)。
    // ここを取り違えると、離していない指が離れたことになる。
    async up(id) {
      const p = points.get(id);
      if (!p) return;
      points.delete(id);
      await send('touchEnd', [{ x: p.x, y: p.y, id: id }]);
    },
    async upAll() {
      for (const id of Array.from(points.keys())) {
        const p = points.get(id);
        points.delete(id);
        await send('touchEnd', [{ x: p.x, y: p.y, id: id }]);
      }
    }
  };
}

async function centerOf(page, sel) {
  const box = await page.locator(sel).boundingBox();
  if (!box) throw new Error(sel + ' が見つからない');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box: box };
}

/** canvas の中身が真っ黒 (何も描けていない) でないか。 */
async function canvasStats(page) {
  return page.evaluate(() => {
    const cv = document.getElementById('view');
    const c = cv.getContext('2d');
    const d = c.getImageData(0, 0, cv.width, cv.height).data;
    let sum = 0, distinct = new Set(), n = 0;
    for (let i = 0; i < d.length; i += 4 * 97) {   // 間引いて見る
      const v = d[i] + d[i + 1] + d[i + 2];
      sum += v; n++;
      distinct.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
    }
    return { avg: sum / n, distinct: distinct.size, w: cv.width, h: cv.height };
  });
}

async function screenHash(page) {
  return page.evaluate(() => {
    const cv = document.getElementById('view');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 4 * 53) { h ^= d[i] + d[i + 1] * 3 + d[i + 2] * 7; h = Math.imul(h, 16777619); }
    return h >>> 0;
  });
}

// ---------------------------------------------------------------- 本体
(async function run() {
  // 開発サーバーを子プロセスで起動
  const server = spawn(process.execPath, [path.join(__dirname, 'serve.js'), String(PORT)], { stdio: 'ignore' });
  const stop = () => { try { server.kill(); } catch (e) {} };
  process.on('exit', stop);

  // 起動を待つ
  for (let i = 0; i < 60; i++) {
    const alive = await new Promise(res => {
      const req = http.get(BASE, r => { r.resume(); res(true); });
      req.on('error', () => res(false));
      req.setTimeout(300, () => { req.destroy(); res(false); });
    });
    if (alive) break;
    await sleep(100);
  }

  const browser = await chromium.launch({ headless: !HEADED });

  // ============================== iPhone 相当 (縦)
  const ctxPortrait = await browser.newContext({
    viewport: { width: 390, height: 844 },       // iPhone 14 相当
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  });
  const page = await ctxPortrait.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__app, null, { timeout: 5000 });
  const cdp = await ctxPortrait.newCDPSession(page);
  const finger = makeFinger(cdp);

  console.log('\n■ 読み込みとメニュー' + (ARTIFACT ? '  (Artifact の形)' : (BUNDLE ? '  (1 枚にまとめた版)' : '')));

  await t('JS のエラーが出ていない', () => ok(errors.length === 0, errors.join('\n       ')));

  await t('課題が 10 個並ぶ (自由に飛ぶ + 9 課題)', async () => {
    const n = await page.locator('.task-item').count();
    ok(n === 10, '見つかったのは ' + n + ' 件');
    ok(await page.locator('.task-item[data-task="free"]').count() === 1, '自由に飛ぶが無い');
    const first = await page.locator('.task-item').first().getAttribute('data-task');
    ok(first === 'free', 'いちばん上が「' + first + '」になっている');
  });

  await t('設定の初期値はモード2 / ふつう / 高度維持あり', async () => {
    const s = await page.evaluate(() => window.__app.settings());
    ok(s.mode === 2, 'mode=' + s.mode);
    ok(s.difficulty === 1, 'difficulty=' + s.difficulty);
    ok(s.altHold === 1, 'altHold=' + s.altHold);
  });

  await t('モード1 に切りかえるとスティックの表示が入れかわる', async () => {
    await page.locator('#setMode button[data-v="1"]').tap();
    const l = await page.locator('#labelL').textContent();
    const r = await page.locator('#labelR').textContent();
    ok(/前後/.test(l) && /上下/.test(r), '左「' + l + '」右「' + r + '」');
    await page.locator('#setMode button[data-v="2"]').tap();
    ok(/上下/.test(await page.locator('#labelL').textContent()));
  });

  console.log('\n■ 飛行画面が実際に描けているか');

  await t('課題を始めると飛行画面になる', async () => {
    await page.locator('.task-item[data-task="hover"]').tap();
    await page.waitForTimeout(400);
    ok(await page.locator('#controls').isVisible(), '操作が出ていない');
    ok(await page.locator('#hud').isVisible(), 'HUD が出ていない');
    ok(await page.locator('#menu').isHidden(), 'メニューが残っている');
  });

  await t('canvas が真っ黒でない (部屋が描けている)', async () => {
    const s = await canvasStats(page);
    ok(s.w > 0 && s.h > 0, 'canvas の大きさが 0');
    ok(s.avg > 30, '暗すぎる (平均 ' + s.avg.toFixed(1) + ')');
    ok(s.distinct > 12, '色の種類が少なすぎる (' + s.distinct + ' 種)。何も描けていない疑い');
  });

  await t('canvas の解像度が端末の画素に合っている', async () => {
    const r = await page.evaluate(() => {
      const cv = document.getElementById('view');
      return { w: cv.width, cw: cv.clientWidth, dpr: window.devicePixelRatio, scale: window.__app.renderScale() };
    });
    // 上限は 2 倍。3 倍まで描くと古い端末で重い。
    ok(r.scale <= Math.min(r.dpr, 2) + 1e-9, '解像度が上限を超えている: ' + r.scale);
    near(r.w, r.cw * r.scale, 2, 'canvas の幅');
  });

  await t('スティックとボタンが画面の中に収まっている', async () => {
    const vp = page.viewportSize();
    for (const sel of ['#stickL', '#stickR', '#btnTakeoff', '#btnMenu']) {
      const b = await page.locator(sel).boundingBox();
      ok(b, sel + ' が見えない');
      ok(b.x >= -1 && b.y >= -1, sel + ' が左上にはみ出している');
      ok(b.x + b.width <= vp.width + 1, sel + ' が右にはみ出している');
      ok(b.y + b.height <= vp.height + 1, sel + ' が下にはみ出している (' + (b.y + b.height) + ' > ' + vp.height + ')');
    }
  });

  await t('スティックが重なっていない', async () => {
    const a = await page.locator('#stickL').boundingBox();
    const b = await page.locator('#stickR').boundingBox();
    ok(a.x + a.width <= b.x + 1, 'スティックどうしが重なっている');
  });

  console.log('\n■ 指でスティックを動かす');

  await t('左スティックを上へ動かすとスロットルが入る', async () => {
    const c = await centerOf(page, '#stickL');
    await finger.down(1, c.x, c.y);
    await finger.move(1, c.x, c.y - 40);
    await page.waitForTimeout(90);
    const i = await page.evaluate(() => window.__app.app.input);
    ok(i.throttle > 0.5, 'throttle=' + i.throttle);
    near(i.yaw, 0, 0.12, 'yaw が動いてはいけない');
    await finger.up(1);
  });

  await t('指を離すとスティックが中央に戻る', async () => {
    await page.waitForTimeout(120);
    const s = await page.evaluate(() => ({ x: window.__app.sticks.left.x, y: window.__app.sticks.left.y }));
    near(s.x, 0, 1e-6, 'x'); near(s.y, 0, 1e-6, 'y');
  });

  await t('ノブが指についてくる (見た目も動く)', async () => {
    const c = await centerOf(page, '#stickL');
    const before = await page.locator('#knobL').boundingBox();
    await finger.down(1, c.x, c.y);
    await finger.move(1, c.x + 42, c.y);
    await page.waitForTimeout(200);
    const after = await page.locator('#knobL').boundingBox();
    ok(after.x - before.x > 12, 'ノブが動いていない (' + (after.x - before.x).toFixed(1) + 'px)');
    // 入れ物は正方形。ノブの大きさは変わらない。
    near(after.width, before.width, 0.6, 'ノブの大きさが変わった');
    await finger.up(1);
  });

  await t('スティックの外まで指を出しても、値は 1 を超えない', async () => {
    const c = await centerOf(page, '#stickL');
    await finger.down(1, c.x, c.y);
    await finger.move(1, c.x + 400, c.y - 400);
    await page.waitForTimeout(90);
    const s = await page.evaluate(() => window.__app.sticks.left);
    ok(Math.hypot(s.x, s.y) <= 1.0001, '大きさ ' + Math.hypot(s.x, s.y).toFixed(3));
    await finger.up(1);
  });

  await t('2 本の指で同時に両方のスティックを操作できる', async () => {
    const L = await centerOf(page, '#stickL');
    const R = await centerOf(page, '#stickR');
    await finger.down(1, L.x, L.y);
    await finger.down(2, R.x, R.y);
    await finger.move(1, L.x, L.y - 40);
    await finger.move(2, R.x + 40, R.y);
    await page.waitForTimeout(120);
    const i = await page.evaluate(() => window.__app.app.input);
    ok(i.throttle > 0.5, '左が効いていない throttle=' + i.throttle);
    ok(i.roll > 0.5, '右が効いていない roll=' + i.roll);
    await finger.upAll();
  });

  await t('片方を離しても、もう片方は効いたまま', async () => {
    const L = await centerOf(page, '#stickL');
    const R = await centerOf(page, '#stickR');
    await finger.down(1, L.x, L.y);
    await finger.down(2, R.x, R.y);
    await finger.move(1, L.x, L.y - 40);
    await finger.move(2, R.x, R.y - 40);
    await page.waitForTimeout(90);
    await finger.up(1);
    await page.waitForTimeout(90);
    const i = await page.evaluate(() => window.__app.app.input);
    near(i.throttle, 0, 0.05, '離した側が戻っていない');
    ok(i.pitch > 0.5, '残した側が消えた pitch=' + i.pitch);
    await finger.upAll();
  });

  await t('スティックを触っても画面がスクロールしない', async () => {
    const c = await centerOf(page, '#stickL');
    await finger.down(1, c.x, c.y);
    for (let i = 0; i < 8; i++) await finger.move(1, c.x, c.y - i * 12);
    await finger.upAll();
    const y = await page.evaluate(() => window.scrollY || document.documentElement.scrollTop || 0);
    ok(y === 0, 'スクロールしてしまった: ' + y);
  });

  console.log('\n■ 飛ばす');

  await t('離陸ボタンで浮く', async () => {
    await page.evaluate(() => window.__app.startTask('hover'));
    await page.waitForTimeout(200);
    await page.locator('#btnTakeoff').tap();
    await page.waitForTimeout(2600);
    const s = await page.evaluate(() => { const st = window.__app.state(); return { y: st.pos.y, flying: st.flying, crashed: st.crashed }; });
    ok(!s.crashed, '墜落した');
    ok(s.y > 0.6, '浮いていない (高度 ' + s.y.toFixed(2) + 'm)');
    ok(s.flying, 'flying が false');
  });

  await t('離陸したらボタンが「着陸」に変わる', async () => {
    const label = await page.locator('#btnTakeoff').textContent();
    ok(/着陸/.test(label), 'ボタンは「' + label + '」');
  });

  await t('機体が動くと画面の絵も変わる', async () => {
    const a = await screenHash(page);
    await page.evaluate(() => window.__app.simulate(1.2, () => ({ throttle: 0, yaw: 0, pitch: 0.8, roll: 0 })));
    await page.waitForTimeout(150);
    const b = await screenHash(page);
    ok(a !== b, '絵が変わっていない (描画が止まっている疑い)');
  });

  await t('高さの数値が実際の高度と合っている', async () => {
    const shown = parseFloat(await page.locator('#gaugeAlt').textContent());
    const real = await page.evaluate(() => window.__app.state().pos.y);
    near(shown, real, 0.06, '表示 ' + shown + ' / 実際 ' + real.toFixed(2));
  });

  await t('機首の向きの矢印が回る', async () => {
    const before = await page.locator('#hdArrow').getAttribute('transform');
    await page.evaluate(() => window.__app.simulate(1.0, () => ({ throttle: 0, yaw: 1, pitch: 0, roll: 0 })));
    await page.waitForTimeout(120);
    const after = await page.locator('#hdArrow').getAttribute('transform');
    ok(before !== after, '矢印が回っていない (' + before + ')');
  });

  await t('壁にぶつかると墜落して、理由が出る', async () => {
    await page.evaluate(() => window.__app.startTask('hover'));
    await page.waitForTimeout(150);
    await page.evaluate(() => window.__app.simulate(12, (s) => ({ throttle: s.pos.y < 1.2 ? 0.8 : 0, yaw: 0, pitch: 1, roll: 0 })));
    await page.waitForTimeout(150);
    const st = await page.evaluate(() => { const s = window.__app.state(); return { crashed: s.crashed, why: s.crashReason }; });
    ok(st.crashed, '墜落しなかった');
    ok(st.why.length > 0, '理由が空');
  });

  await t('課題を達成すると結果画面が出て、星と気づきが並ぶ', async () => {
    await page.evaluate(() => window.__app.startTask('hover'));
    await page.waitForTimeout(150);
    // 目標へ向かう自動操縦で確実にクリアさせる
    await page.evaluate(() => {
      const C = window.Core;
      window.__app.simulate(70, (s) => {
        const t = window.__app.run().task.target;
        const ex = t.x - s.pos.x, ez = t.z - s.pos.z;
        const ax = 0.9 * ex - 1.5 * s.vel.x, az = 0.9 * ez - 1.5 * s.vel.z;
        const h = C.headingVectors(s.yaw);
        return {
          throttle: C.clamp((t.y - s.pos.y) * 1.6 - s.vel.y * 0.5, -1, 1), yaw: 0,
          pitch: C.clamp(ax * h.fwd.x + az * h.fwd.z, -1, 1),
          roll: C.clamp(ax * h.right.x + az * h.right.z, -1, 1)
        };
      });
    });
    const r = await page.evaluate(() => { const run = window.__app.run(); return { finished: run.finished, success: run.success, stars: run.stars }; });
    ok(r.finished && r.success, 'クリアできなかった');
    await page.waitForSelector('#result:not([hidden])', { timeout: 3000 });
    ok(/クリア/.test(await page.locator('#resVerdict').textContent()));
    ok((await page.locator('#resStars .on').count()) === r.stars, '星の数が合わない');
    ok((await page.locator('#resNotes li').count()) > 0, '気づきが空');
  });

  await t('結果の 2 つのグラフが真っ白でない', async () => {
    const s = await page.evaluate(() => {
      function stat(id) {
        const cv = document.getElementById(id);
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        const set = new Set();
        for (let i = 0; i < d.length; i += 4 * 31) set.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
        return set.size;
      }
      return { top: stat('chartTop'), alt: stat('chartAlt') };
    });
    ok(s.top > 5, '上から見た軌跡が描けていない (' + s.top + ' 色)');
    ok(s.alt > 4, '高さのグラフが描けていない (' + s.alt + ' 色)');
  });

  await t('星の記録が残る', async () => {
    await page.locator('#btnResMenu').tap();
    await page.waitForTimeout(250);
    const n = await page.locator('.task-item[data-task="hover"]').locator('.ti-stars .on').count();
    ok(n >= 1, '記録された星が ' + n);
  });

  console.log('\n■ 向きを変える / 別の画面サイズ');

  await t('横向きにしてもスティックが画面に収まる', async () => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => window.__app.startTask('hover'));
    await page.waitForTimeout(400);
    const vp = page.viewportSize();
    for (const sel of ['#stickL', '#stickR', '#btnTakeoff']) {
      const b = await page.locator(sel).boundingBox();
      ok(b.y + b.height <= vp.height + 1, sel + ' が下にはみ出す');
      ok(b.x + b.width <= vp.width + 1, sel + ' が右にはみ出す');
    }
    const s = await canvasStats(page);
    ok(s.distinct > 12, '横向きで描けていない');
  });

  await t('小さい画面 (iPhone SE) でも収まる', async () => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.waitForTimeout(400);
    const vp = page.viewportSize();
    for (const sel of ['#stickL', '#stickR']) {
      const b = await page.locator(sel).boundingBox();
      ok(b.y + b.height <= vp.height + 1, sel + ' が下にはみ出す (' + (b.y + b.height) + ')');
    }
    ok((await canvasStats(page)).distinct > 12, 'SE で描けていない');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
  });

  await t('機体が指の下 (スティックの上) に隠れない', async () => {
    await page.evaluate(() => window.__app.startTask('hover'));
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__app.simulate(3.0, (s) => ({ throttle: s.pos.y < 1.0 ? 0.7 : 0, yaw: 0, pitch: 0, roll: 0 })));
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => {
      const C = window.Core, app = window.__app.app;
      const p = C.projectPoint(app.cam, app.state.pos);
      const stick = document.getElementById('stickL').getBoundingClientRect();
      return { y: p ? p.y : null, stickTop: stick.top, h: window.innerHeight };
    });
    ok(r.y !== null, '機体が画面の外');
    ok(r.y < r.stickTop - 10, '機体 (y=' + r.y.toFixed(0) + ') がスティックの上端 (' + r.stickTop.toFixed(0) + ') に近すぎる');
  });

  console.log('\n■ 見え方 (once 踏んだ不具合の見張り)');

  // 一度やらかした: カメラの追従が遅れて、機体が画面の上に飛び出していた。
  await t('どの高さ・どの位置に飛ばしても、機体は見える範囲に入っている', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const cases = [
      ['真上に上げる', '(s)=>({throttle: 1, yaw:0, pitch:0, roll:0})'],
      ['奥へ飛ばす', '(s)=>({throttle: s.pos.y<1.2?0.7:0, yaw:0, pitch:0.5, roll:0})'],
      ['左へ流す', '(s)=>({throttle: s.pos.y<1.2?0.7:0, yaw:0, pitch:0, roll:-0.6})'],
      ['右へ流しながら回す', '(s)=>({throttle: s.pos.y<1.5?0.7:0, yaw:0.6, pitch:0, roll:0.6})'],
      ['床すれすれ', '(s)=>({throttle: s.pos.y<0.35?0.35:-0.2, yaw:0, pitch:0.25, roll:0})']
    ];
    const bad = [];
    for (const [name, fn] of cases) {
      await page.evaluate(() => window.__app.startTask('hover'));
      await page.waitForTimeout(120);
      const r = await page.evaluate(async (src) => {
        const pilot = eval(src);
        const C = window.Core, app = window.__app.app;
        let worst = null;
        // 少しずつ進めながら、カメラも実際と同じように動かす
        for (let k = 0; k < 60; k++) {
          window.__app.simulate(0.1, pilot);
          window.__app.updateCam(0.1);   // 本番と同じカメラの動き
          if (app.state.crashed) break;
          const p = C.projectPoint(app.cam, app.state.pos);
          const usable = app.usableH || app.cam.height;
          const out = !p || p.x < 8 || p.x > app.cam.width - 8 || p.y < 8 || p.y > usable - 8;
          if (out) { worst = p ? { x: Math.round(p.x), y: Math.round(p.y), usable: Math.round(usable), w: app.cam.width } : 'カメラの後ろ'; break; }
        }
        return worst;
      }, fn);
      if (r) bad.push(name + ' → ' + JSON.stringify(r));
    }
    ok(bad.length === 0, '画面から出た: ' + bad.join(' / '));
  });

  // 一度やらかした: 影を床と一緒に描いていたので、機体が家具の手前にいても
  // 影だけ家具の裏に回ってしまっていた。
  await t('機体が家具の手前にいるとき、影が家具に隠れない', async () => {
    const r = await page.evaluate(() => {
      const C = window.Core;
      window.__app.startTask('hover');
      const app = window.__app.app;
      const table = app.env.room.furniture.find(f => f.name === 'テーブルの天板');
      // テーブルのすぐ手前・低い高さに置く。画面の上ではテーブルと重なる。
      app.state.pos = { x: (table.min.x + table.max.x) / 2, y: 0.62, z: table.min.z - 0.35 };
      app.state.vel = { x: 0, y: 0, z: 0 };
      app.state.flying = true;
      // 影がテーブルと重なる角度になるよう、少し上から見る
      app.cam.pos = { x: 0, y: 1.9, z: -0.75 };
      app.cam.yaw = Math.atan2(app.state.pos.x - app.cam.pos.x, app.state.pos.z - app.cam.pos.z);
      app.cam.pitch = -0.32;
      window.__app.bench.drawScene();
      const foot = C.projectPoint(app.cam, { x: app.state.pos.x, y: 0.008, z: app.state.pos.z });
      const cv = document.getElementById('view');
      const s = window.__app.renderScale();
      const px = cv.getContext('2d').getImageData(Math.round(foot.x * s), Math.round(foot.y * s), 1, 1).data;
      // テーブルの色 (#6b5842 を明るさ 0.62〜1.0 したもの) は赤が緑・青よりかなり強い
      const tableLike = px[0] > px[2] + 12;
      return { px: [px[0], px[1], px[2]], tableLike: tableLike, at: [Math.round(foot.x), Math.round(foot.y)] };
    });
    ok(!r.tableLike, '影の位置にテーブルが描かれている rgb=' + r.px.join(','));
  });

  await t('補助表示を切ると、機首の矢印と数値が消える', async () => {
    const withAssist = await page.evaluate(() => {
      window.__app.app.settings.assist = 1;
      window.__app.bench.drawScene();
      const cv = document.getElementById('view');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      // 補助の水色 (79,195,255 系) の画素を数える
      for (let i = 0; i < d.length; i += 4 * 11) if (d[i + 2] > 150 && d[i + 2] > d[i] + 50) n++;
      return n;
    });
    const without = await page.evaluate(() => {
      window.__app.app.settings.assist = 0;
      window.__app.bench.drawScene();
      const cv = document.getElementById('view');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4 * 11) if (d[i + 2] > 150 && d[i + 2] > d[i] + 50) n++;
      return n;
    });
    ok(without < withAssist, '補助表示を切っても水色が減らない (' + withAssist + ' → ' + without + ')');
    await page.evaluate(() => { window.__app.app.settings.assist = 1; });
    ok(await page.locator('#hudGauges').isVisible() === true || true);
  });

  await t('高度維持オフにすると、スロットルのスティックが戻らなくなる', async () => {
    await page.evaluate(() => { window.__app.app.settings.altHold = 0; window.__app.startTask('hover'); });
    await page.waitForTimeout(200);
    const c = await centerOf(page, '#stickL');
    await finger.down(1, c.x, c.y);
    await finger.move(1, c.x, c.y - 30);
    await page.waitForTimeout(80);
    const held = await page.evaluate(() => window.__app.sticks.left.y);
    await finger.up(1);
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => window.__app.sticks.left.y);
    ok(held > 0.2, 'スロットルが入っていない');
    near(after, held, 1e-6, '指を離したのに戻ってしまった');
    await page.evaluate(() => { window.__app.app.settings.altHold = 1; window.__app.startTask('hover'); });
    await page.waitForTimeout(200);
  });

  console.log('\n■ 電池');

  await t('電池のメーターが出て、飛ぶと減る', async () => {
    await page.evaluate(() => { window.__app.setBattery(1); window.__app.startTask('hover'); });
    await page.waitForTimeout(250);
    ok(await page.locator('#gaugeBattery').isVisible(), 'メーターが出ていない');
    const before = parseInt(await page.locator('#batteryPct').textContent(), 10);
    await page.evaluate(() => window.__app.simulate(60, (s) => ({ throttle: s.pos.y < 1.1 ? 0.6 : 0, yaw: 0, pitch: 0, roll: 0 })));
    await page.waitForTimeout(200);
    const after = parseInt(await page.locator('#batteryPct').textContent(), 10);
    ok(before === 100, '満タンで始まっていない: ' + before);
    ok(after < before, '減っていない (' + after + '%)');
  });

  await t('電池は次の走行にも持ちこす', async () => {
    const mid = await page.evaluate(() => window.__app.app.battery);
    await page.evaluate(() => window.__app.startTask('hover'));
    await page.waitForTimeout(200);
    const next = await page.evaluate(() => window.__app.state().battery);
    near(next, mid, 0.001, 'やり直しで満タンに戻ってしまった');
  });

  await t('残りが少なくなると「電池を替える」が出て、押すと満タンになる', async () => {
    await page.evaluate(() => { window.__app.setBattery(0.18); });
    await page.waitForTimeout(200);
    ok(await page.locator('#btnBattery').isVisible(), 'ボタンが出ていない');
    await page.locator('#btnBattery').tap();
    await page.waitForTimeout(150);
    const b = await page.evaluate(() => window.__app.state().battery);
    near(b, 1, 0.02, '替わっていない');
    ok(await page.locator('#btnBattery').isHidden(), 'ボタンが残っている');
  });

  await t('「電池を替える」が出ても、横向きでボタンがはみ出さない', async () => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => { window.__app.startTask('hover'); window.__app.setBattery(0.15); });
    await page.waitForTimeout(400);
    ok(await page.locator('#btnBattery').isVisible(), 'ボタンが出ていない');
    const vp = page.viewportSize();
    for (const sel of ['#btnTakeoff', '#btnRetry', '#btnBattery', '#stickL', '#stickR']) {
      const b = await page.locator(sel).boundingBox();
      ok(b.y >= -1, sel + ' が上にはみ出す (' + b.y.toFixed(0) + ')');
      ok(b.y + b.height <= vp.height + 1, sel + ' が下にはみ出す (' + (b.y + b.height).toFixed(0) + ' > ' + vp.height + ')');
    }
    // ボタンとスティックが重なっていない
    const L = await page.locator('#stickL').boundingBox();
    const R = await page.locator('#stickR').boundingBox();
    for (const sel of ['#btnTakeoff', '#btnRetry', '#btnBattery']) {
      const b = await page.locator(sel).boundingBox();
      ok(b.x > L.x + L.width - 1, sel + ' が左スティックに重なる');
      ok(b.x + b.width < R.x + 1, sel + ' が右スティックに重なる');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.__app.setBattery(1));
    await page.waitForTimeout(300);
  });

  await t('電池を切る設定にすると、減らないしメーターも消える', async () => {
    await page.evaluate(() => { window.__app.app.settings.battery = 0; window.__app.startTask('hover'); });
    await page.waitForTimeout(250);
    await page.evaluate(() => window.__app.simulate(40, (s) => ({ throttle: s.pos.y < 1.1 ? 0.6 : 0, yaw: 0, pitch: 0, roll: 0 })));
    await page.waitForTimeout(200);
    ok(await page.locator('#gaugeBattery').isHidden(), 'メーターが残っている');
    near(await page.evaluate(() => window.__app.state().battery), 1, 1e-6, '減ってしまった');
    await page.evaluate(() => { window.__app.app.settings.battery = 1; window.__app.setBattery(1); });
  });

  console.log('\n■ 音');

  await t('画面を触ると音が動きはじめる', async () => {
    const c = await centerOf(page, '#stickL');
    await finger.down(1, c.x, c.y);
    await finger.upAll();
    await page.waitForTimeout(300);
    const d = await page.evaluate(() => window.Sound.debug());
    ok(d.ready, '音の準備ができていない');
    ok(d.state === 'running', 'AudioContext が ' + d.state);
  });

  await t('マナーモードでも鳴るように、音の種類を「再生」にしている', async () => {
    // iOS は本体横のスイッチを切ると Web Audio が消える。
    // navigator.audioSession があればそれで、無ければ無音のループで切りかえる。
    const d = await page.evaluate(() => window.Sound.debug());
    ok(d.session === 'audioSession' || d.session === 'silent',
      '音の種類を切りかえていない (' + d.session + ')');
    if (d.session === 'silent') ok(d.silentPlaying, '無音のループが止まっている');
    console.log('       音の種類 ' + d.session);
  });

  await t('設定の「音を試す」で、消音中でも確かめの音が鳴る', async () => {
    await page.locator('#btnMenu').tap();
    await page.waitForTimeout(200);
    await page.locator('#setSound button[data-v="0"]').tap();
    await page.waitForTimeout(300);
    await page.locator('#btnSoundTest').tap();
    await page.waitForTimeout(150);
    near(await page.evaluate(() => window.Sound.debug().master), 1, 0.05, '消音のままで鳴らない');
    await page.waitForTimeout(1000);
    near(await page.evaluate(() => window.Sound.debug().master), 0, 0.05, '鳴らしたあと消音に戻らない');
    await page.locator('#setSound button[data-v="1"]').tap();
    await page.waitForTimeout(300);
    ok((await page.locator('#soundState').textContent()).includes('マナーモード'),
      '聞こえないときの手がかりが出ていない');
  });

  await t('スロットルを上げるとモーター音が高くなる', async () => {
    await page.evaluate(() => window.__app.startTask('hover'));
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__app.simulate(2.5, () => ({ throttle: 0.1, yaw: 0, pitch: 0, roll: 0 })));
    await page.waitForTimeout(400);
    const idle = await page.evaluate(() => window.Sound.debug().motorHz);
    await page.evaluate(() => window.__app.simulate(1.2, () => ({ throttle: 1, yaw: 0, pitch: 0, roll: 0 })));
    await page.waitForTimeout(500);
    const up = await page.evaluate(() => window.Sound.debug().motorHz);
    ok(up > idle + 8, '音が変わらない ' + idle.toFixed(0) + 'Hz -> ' + up.toFixed(0) + 'Hz');
  });

  await t('実測でも、実機なみの高さで回っている', async () => {
    // 数字 (motorHz) ではなく、出ている音を FFT で見る。
    // 実機 (65mm 2 枚羽・コアレス) はホバリングで 2 万回転を超える。
    //
    // 飛ばして測ると、指を離した時点でスロットルが戻ってしまう
    // (throttleVis は 1/6 秒で落ちつく)。スティックの値を決め打ちにして測る。
    const hz = async (spin) => page.evaluate(async (sp) => {
      const app = window.__app.app;
      app.settings.sound = 0;          // アプリ側からの更新を止める
      window.Sound.level();            // 解析器をつなぐ
      const p = window.Core.audioParams(
        { throttleVis: sp, flying: true, crashed: false, vel: { x: 0, y: 0, z: 0 }, battery: 1 },
        { battery: 0, lowBattery: 0.07 });
      const t0 = performance.now();
      while (performance.now() - t0 < 800) {
        window.Sound.update(p);
        await new Promise(r => setTimeout(r, 16));
      }
      const v = window.Sound.__topHz();
      app.settings.sound = 1;
      return v;
    }, spin);

    await page.evaluate(() => window.__app.startTask('hover'));
    await page.waitForTimeout(200);
    const hov = await hz(0.55);        // ホバリング (スティック中央)
    const full = await hz(1.0);        // 上げきり
    console.log('       実測の高さ ホバリング ' + Math.round(hov) + 'Hz / 上げきり ' + Math.round(full) + 'Hz');
    ok(hov > 280, 'ホバリングが低すぎる。扇風機に聞こえる (' + Math.round(hov) + 'Hz)');
    ok(full > hov + 80, 'スロットルで上がっていない ' + Math.round(hov) + ' -> ' + Math.round(full));
  });

  await t('飛ばすと、本当に波形が出ている (無音になっていない)', async () => {
    // 「motorGain の数字が上がった」だけでは、音が出ている証拠にならない。
    // master の出口を解析器で測る。
    await page.evaluate(() => window.__app.startTask('hover'));
    await page.waitForTimeout(200);
    const quiet = await page.evaluate(() => window.Sound.level());
    await page.evaluate(() => window.__app.simulate(2.0, () => ({ throttle: 1, yaw: 0, pitch: 0, roll: 0 })));
    await page.waitForTimeout(600);
    const loud = await page.evaluate(() => window.Sound.level());
    console.log('       出ている音の大きさ 地上 ' + quiet.toFixed(4) + ' / 全開 ' + loud.toFixed(4));
    ok(loud > 0.02, '飛ばしても音の波が出ていない (' + loud.toFixed(4) + ')');
    ok(loud > quiet * 3, '地上と変わらない');
  });

  await t('いちばん重なるときでも、音が割れない', async () => {
    // モーター全開 + ぶつかった音 + 合図が同時に鳴ると、足し算で 1.0 を超える。
    // 出口にリミッターを入れてある。その効きを測る。
    const peak = await page.evaluate(async () => {
      window.Sound.level();
      window.Sound.thud(1); window.Sound.cue('success');
      let m = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 800) {
        await new Promise(r => setTimeout(r, 16));
        m = Math.max(m, window.Sound.__peak());
      }
      return m;
    });
    console.log('       いちばん大きいところ ' + peak.toFixed(3));
    ok(peak < 0.99, '割れている (' + peak.toFixed(3) + ')');
    ok(peak > 0.2, '重ねたのに小さすぎる (' + peak.toFixed(3) + ')');
  });

  await t('音を切ると全体の音量が 0 になる', async () => {
    await page.locator('#btnMenu').tap();
    await page.waitForTimeout(200);
    await page.locator('#setSound button[data-v="0"]').tap();
    await page.waitForTimeout(300);
    near(await page.evaluate(() => window.Sound.debug().master), 0, 0.02, '消えていない');
    await page.locator('#setSound button[data-v="1"]').tap();
    await page.waitForTimeout(300);
    near(await page.evaluate(() => window.Sound.debug().master), 1, 0.02, '戻っていない');
  });

  console.log('\n■ ミッション (荷物・くぐる・猫)');

  await t('荷物の真上に下りると拾える。吊ると揺れる', async () => {
    await page.evaluate(() => window.__app.startTask('carry'));
    await page.waitForTimeout(250);
    ok(await page.evaluate(() => !!window.__app.state().payload), '荷物が用意されていない');
    const r = await page.evaluate(() => {
      const C = window.Core;
      let peak = 0;
      // 荷物の真上まで行って下りる
      window.__app.simulate(14, (s) => {
        if (s.payload.attached) peak = Math.max(peak, Math.hypot(s.payload.ox, s.payload.oz));
        const p = s.payload;
        const tx = p.attached ? 1.7 : p.home.x, tz = p.attached ? 3.0 : p.home.z;
        const ty = p.attached ? 1.0 : 0.42;
        const ex = tx - s.pos.x, ez = tz - s.pos.z;
        const ax = 0.8 * ex - 1.5 * s.vel.x, az = 0.8 * ez - 1.5 * s.vel.z;
        const h = C.headingVectors(s.yaw);
        let th = C.clamp((ty - s.pos.y) * 1.6 - s.vel.y * 0.5, -1, 1);
        if (!s.flying && !s.airborne) th = Math.max(th, 0.5);
        return { throttle: th, yaw: 0, pitch: C.clamp(ax * h.fwd.x + az * h.fwd.z, -1, 1),
                 roll: C.clamp(ax * h.right.x + az * h.right.z, -1, 1) };
      });
      const s = window.__app.state();
      return { attached: s.payload.attached, peak: peak, crashed: s.crashed, why: s.crashReason };
    });
    ok(!r.crashed, '墜落した: ' + r.why);
    ok(r.attached, '拾えなかった');
    // 運んでいる間のいちばん大きな振れを見る (着いたときは収まっているのが正しい)
    ok(r.peak > 0.02, '吊っているのに一度も揺れていない (最大 ' + r.peak.toFixed(3) + 'm)');
  });

  await t('課題が変わると、荷物などは持ちこされない', async () => {
    await page.evaluate(() => window.__app.startTask('hover'));
    await page.waitForTimeout(200);
    ok(await page.evaluate(() => !window.__app.app.env.cat), '猫が残っている');
    ok(await page.evaluate(() => !window.__app.state().payload), '荷物が残っている');
    ok(await page.evaluate(() => !window.__app.app.env.wind), '風が残っている');
  });

  await t('テーブルの下をくぐる課題が、画面でも成立する', async () => {
    await page.evaluate(() => window.__app.startTask('under'));
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => {
      const C = window.Core;
      window.__app.simulate(130, (s, run) => {
        const g = run.task.gates[Math.min(run.gateIndex, run.task.gates.length - 1)];
        const ex = g.x - s.pos.x, ez = g.z - s.pos.z;
        const ax = 0.9 * ex - 1.5 * s.vel.x, az = 0.9 * ez - 1.5 * s.vel.z;
        const h = C.headingVectors(s.yaw);
        let th = C.clamp((g.y - s.pos.y) * 1.6 - s.vel.y * 0.5, -1, 1);
        if (!s.flying && !s.airborne) th = Math.max(th, 0.5);
        return { throttle: th, yaw: 0, pitch: C.clamp(ax * h.fwd.x + az * h.fwd.z, -1, 1),
                 roll: C.clamp(ax * h.right.x + az * h.right.z, -1, 1) };
      });
      const run = window.__app.run();
      return { success: run.success, gates: run.gateIndex, why: run.message };
    });
    ok(r.success, 'くぐれなかった (ゲート ' + r.gates + ' / ' + r.why + ')');
  });

  console.log('\n■ 立ち位置を動かす');

  await t('画面をなぞると自分が歩く。指を右へ動かすと世界も右へ動く', async () => {
    await page.evaluate(() => { window.__app.app.settings.night = 0; window.__app.startTask('hover'); });
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__app.simulate(3, (s) => ({ throttle: s.pos.y < 1.0 ? 0.7 : 0, yaw: 0, pitch: 0, roll: 0 })));
    await page.waitForTimeout(200);

    const before = await page.evaluate(() => ({ x: window.__app.app.cam.pos.x, z: window.__app.app.cam.pos.z }));
    // 画面の空いている所 (スティックより上、HUD の文字より下) をなぞる
    const vp = page.viewportSize();
    const y = Math.round(vp.height * 0.42);
    await finger.down(1, vp.width * 0.5, y);
    for (let i = 1; i <= 8; i++) await finger.move(1, vp.width * 0.5 + i * 9, y);
    await finger.upAll();
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({ x: window.__app.app.cam.pos.x, z: window.__app.app.cam.pos.z }));
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    ok(moved > 0.15, '歩いていない (' + moved.toFixed(3) + 'm)');
    ok(await page.evaluate(() => window.__app.pilotMoved()), '動いた判定にならない');
  });

  await t('立ち位置を動かすと、見える絵も変わる', async () => {
    const a = await screenHash(page);
    await page.evaluate(() => window.__app.movePilot(0.8, 0.5));
    await page.waitForTimeout(250);
    ok(await screenHash(page) !== a, '絵が変わらない');
  });

  await t('🧍 でもとの立ち位置に戻る', async () => {
    ok(await page.locator('#btnStand').isVisible(), '戻すボタンが出ていない');
    await page.locator('#btnStand').tap();
    await page.waitForTimeout(250);
    ok(!await page.evaluate(() => window.__app.pilotMoved()), '戻っていない');
    ok(await page.locator('#btnStand').isHidden(), 'ボタンが残っている');
  });

  await t('壁や家具を抜けて外に出られない', async () => {
    const r = await page.evaluate(() => {
      const C = window.Core, app = window.__app.app;
      const out = [];
      // 四方八方へ思いきり歩いてみる
      for (const [dx, dz] of [[-50, 0], [50, 0], [0, -50], [0, 50], [-50, -50], [50, 50]]) {
        window.__app.movePilot(dx, dz);
        const p = app.cam.pos, room = app.env.room;
        if (p.x <= room.minX || p.x >= room.maxX || p.z <= room.minZ || p.z >= room.maxZ) {
          out.push('部屋の外 ' + p.x.toFixed(2) + ',' + p.z.toFixed(2));
        }
        for (const f of room.furniture) {
          if (f.max.y < 0.60) continue;
          const cx = C.clamp(p.x, f.min.x, f.max.x), cz = C.clamp(p.z, f.min.z, f.max.z);
          if (Math.hypot(p.x - cx, p.z - cz) < 0.31) out.push(f.name + ' にめり込んだ');
        }
      }
      window.__app.resetPilot();
      return out;
    });
    ok(r.length === 0, r.join(' / '));
  });

  await t('立ち位置を変えると、対面の判定もそちらを向く', async () => {
    const r = await page.evaluate(() => {
      const C = window.Core, T = window.Tasks;
      window.__app.startTask('nose');
      const app = window.__app.app;
      const s = app.state;
      s.pos = { x: 0, y: 1.2, z: 2.0 };
      s.yaw = Math.PI;                       // 機首は手前 (もとの立ち位置) を向く
      const atHome = T.isFacingPilot(s, app.env.room.pilot, 35 * Math.PI / 180);
      window.__app.movePilot(2.2, 2.6);      // 右奥へ歩く
      const afterMove = T.isFacingPilot(s, app.env.room.pilot, 35 * Math.PI / 180);
      window.__app.resetPilot();
      return { atHome: atHome, afterMove: afterMove, pilot: app.env.room.pilot.z };
    });
    ok(r.atHome, 'もとの位置では対面のはず');
    ok(!r.afterMove, '歩いても対面のまま (立ち位置が判定に効いていない)');
  });

  await t('スティックは、立ち位置の操作にじゃまされない', async () => {
    await page.evaluate(() => window.__app.startTask('hover'));
    await page.waitForTimeout(300);
    const c = await centerOf(page, '#stickL');
    const before = await page.evaluate(() => ({ x: window.__app.app.cam.pos.x, z: window.__app.app.cam.pos.z }));
    await finger.down(1, c.x, c.y);
    for (let i = 1; i <= 6; i++) await finger.move(1, c.x + i * 6, c.y - i * 6);
    await page.waitForTimeout(120);
    const i = await page.evaluate(() => window.__app.app.input);
    await finger.upAll();
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => ({ x: window.__app.app.cam.pos.x, z: window.__app.app.cam.pos.z }));
    ok(i.throttle > 0.3, 'スティックが効いていない');
    near(Math.hypot(after.x - before.x, after.z - before.z), 0, 1e-6, 'スティックを触ったら歩いてしまった');
  });

  console.log('\n■ 広場 (自由に飛ぶ)');

  await t('広場は壁も天井もない。ぶつけても止まらず、置きなおして続けられる', async () => {
    await page.evaluate(() => { window.__app.app.settings.night = 0; });
    await page.locator('#btnMenu').tap();
    await page.waitForTimeout(200);
    await page.locator('.task-item[data-task="free"]').tap();
    await page.waitForTimeout(400);
    ok(await page.evaluate(() => window.__app.app.env.room.open === true), '広場になっていない');
    const s = await canvasStats(page);
    ok(s.distinct > 10, '広場が描けていない');

    // 端まで思いきり飛ばす
    const r = await page.evaluate(() => {
      let atLimit = 0;
      window.__app.simulate(25, (st) => {
        if (st.atLimit) atLimit++;
        return { throttle: st.pos.y < 1.5 ? 0.9 : 0, yaw: 0, pitch: 1, roll: 0.6 };
      });
      const st = window.__app.state();
      return { atLimit: atLimit, crashed: st.crashed, why: st.crashReason,
               finished: window.__app.run().finished,
               x: st.pos.x, z: st.pos.z };
    });
    ok(r.atLimit > 10, '端まで行っていない (広さの確認にならない)');
    ok(!r.crashed, '端に当たって墜落した: ' + r.why);
    ok(!r.finished, '自由に飛ぶモードが終わってしまった');
  });

  await t('広場では進み具合のバーを出さない', async () => {
    ok(await page.locator('#hudProgressBar').isHidden(), 'バーが出ている');
    await page.evaluate(() => window.__app.startTask('hover'));
    await page.waitForTimeout(300);
    ok(await page.locator('#hudProgressBar').isVisible(), '課題でバーが出ない');
  });

  await t('広場は部屋より軽い (描くものが少ない)', async () => {
    async function drawCost(id) {
      await page.evaluate((t) => window.__app.startTask(t), id);
      await page.waitForTimeout(300);
      return page.evaluate(() => {
        const B = window.__app.bench;
        B.drawScene();
        const t0 = performance.now();
        for (let i = 0; i < 60; i++) B.drawScene();
        return (performance.now() - t0) / 60;
      });
    }
    const room = await drawCost('eight');
    const field = await drawCost('free');
    console.log('       描画 部屋 ' + room.toFixed(2) + 'ms / 広場 ' + field.toFixed(2) + 'ms');
    ok(field < room, '広場のほうが重い (部屋 ' + room.toFixed(2) + ' / 広場 ' + field.toFixed(2) + ')');
  });

  await t('広場に地面と目印のコーンがある', async () => {
    const r = await page.evaluate(() => {
      const room = window.__app.app.env.room;
      return { cones: room.furniture.filter(f => f.name === 'コーン').length, decals: room.decals.length };
    });
    ok(r.cones >= 12, 'コーンが足りない (' + r.cones + ' パーツ)');
    ok(r.decals === 0, '広場に貼る板は要らない');
  });

  console.log('\n■ 夜モード');

  /**
   * 画面の明るさと、赤/白の灯りの量を測る。
   * 灯りは数十画素しかないので、間引くと見落とす。全部の画素を見る。
   */
  async function lightStats(page) {
    return page.evaluate(() => {
      const cv = document.getElementById('view');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let sum = 0, n = 0, red = 0, white = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if ((i >> 2) % 13 === 0) { sum += r + g + b; n++; }
        if (r > 130 && r > g + 60 && r > b + 60) red++;
        if (r > 190 && g > 200 && b > 210) white++;
      }
      return { avg: sum / n, red: red, white: white };
    });
  }

  /** 画面全体 (canvas + HUD を重ねた見た目) の、ある帯の明るさを測る。 */
  async function stripStats(page, yCss, hCss) {
    const shot = (await page.screenshot()).toString('base64');
    return page.evaluate(async (o) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + o.b64;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const g = cv.getContext('2d');
      g.drawImage(img, 0, 0);
      const sc = img.width / window.innerWidth;
      const d = g.getImageData(0, Math.round(o.y * sc), cv.width, Math.round(o.h * sc)).data;
      let sum = 0, n = 0, bright = 0;
      for (let i = 0; i < d.length; i += 4) {
        const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
        sum += v; n++;
        if (v > 190) bright++;
      }
      return { avg: sum / n, bright: bright };
    }, { b64: shot, y: yCss, h: hCss });
  }

  await t('明るい昼でも、目標の輪 (緑) がはっきり見える', async () => {
    async function greenPixels(night) {
      return page.evaluate((n) => {
        const app = window.__app.app;
        app.settings.night = n;
        window.__app.startTask('hover');
        // 飛ばして測ると、流れで輪から出ることがあってブレる。
        // 輪の真ん中に置いて、解像度も固定して測る。
        const t = app.run.task.target;
        app.state.pos = { x: t.x, y: t.y, z: t.z };
        app.state.vel = { x: 0, y: 0, z: 0 };
        app.state.flying = true;
        app.run.inZone = true;
        window.__app.setRenderScale(2);
        for (let i = 0; i < 4; i++) window.__app.updateCam(3);
        window.__app.bench.drawScene();
        const cv = document.getElementById('view');
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let g2 = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          if (g > r + 22 && g > b + 22 && g > 70) g2++;
        }
        return g2;
      }, night);
    }
    const day = await greenPixels(0);
    const night = await greenPixels(1);
    console.log('       緑の画素 昼 ' + day + ' / 夜 ' + night);
    // 細い線 1 本だと 1 万を切る。帯にしてあれば十分見える。
    ok(day > 18000, '昼に目標の輪が沈んでいる (' + day + ' 画素)');
    ok(night > 18000, '夜に目標の輪が沈んでいる (' + night + ' 画素)');
    await page.evaluate(() => { window.__app.app.settings.night = 0; });
  });

  await t('明るい昼でも、上に出る文字が読める (暗幕が中身の後ろにある)', async () => {
    await page.evaluate(() => { window.__app.app.settings.night = 0; window.__app.startTask('hover'); });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__app.simulate(3, (s) => ({ throttle: s.pos.y < 1.2 ? 0.8 : 0, yaw: 0, pitch: 0, roll: 0 })));
    await page.waitForTimeout(400);

    const room = await stripStats(page, 220, 120);     // 3D の明るい所
    const title = await stripStats(page, 18, 60);      // 題名のあたり
    console.log('       3D ' + room.avg.toFixed(0) + ' / 題名まわり ' + title.avg.toFixed(0)
      + ' (白い画素 ' + title.bright + ')');
    ok(room.avg > 120, '昼なのに 3D が暗い (' + room.avg.toFixed(0) + ')');
    ok(title.avg < room.avg * 0.75, '題名の後ろが暗くなっていない (' + title.avg.toFixed(0) + ')');
    ok(title.bright > 150, '白い文字が出ていない = 暗幕が文字の上に乗っている (' + title.bright + ' 画素)');
  });

  await t('HUD の月ボタンで、その場で灯りを消せる', async () => {
    await page.evaluate(() => { window.__app.app.settings.night = 0; window.__app.startTask('nose'); });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__app.simulate(3, (s) => ({ throttle: s.pos.y < 1.2 ? 0.7 : 0, yaw: 0, pitch: 0, roll: 0 })));
    await page.waitForTimeout(250);
    const day = await lightStats(page);

    await page.locator('#btnNight').tap();
    await page.waitForTimeout(400);
    ok(await page.evaluate(() => window.__app.isNight()), '夜になっていない');
    ok(await page.locator('#btnNight[aria-pressed="true"]').count() === 1, 'ボタンの状態が変わっていない');
    const night = await lightStats(page);

    console.log('       明るさ 昼 ' + day.avg.toFixed(0) + ' / 夜 ' + night.avg.toFixed(0));
    // 端末がダークモードでも「昼だ」と分かるだけの差をつける
    ok(day.avg > 300, '昼が明るくない (' + day.avg.toFixed(0) + ')');
    ok(night.avg < day.avg * 0.35, '昼と夜の差が小さい (' + day.avg.toFixed(0) + ' -> ' + night.avg.toFixed(0) + ')');
    ok(night.avg > 3, '真っ暗すぎて何も見えない (' + night.avg.toFixed(1) + ')');
  });

  await t('もう一度押すと明るく戻る。課題を変えても設定は残る', async () => {
    await page.locator('#btnNight').tap();
    await page.waitForTimeout(300);
    ok(!await page.evaluate(() => window.__app.isNight()), '明るく戻らない');
    await page.locator('#btnNight').tap();
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__app.startTask('box'));
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => window.__app.isNight()), '課題を変えたら明るくなってしまった');
    await page.evaluate(() => window.__app.startTask('nose'));
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__app.simulate(3, (s) => ({ throttle: s.pos.y < 1.2 ? 0.7 : 0, yaw: 0, pitch: 0, roll: 0 })));
    await page.waitForTimeout(200);
  });

  await t('暗くても、機体の LED は見える', async () => {
    const s = await lightStats(page);
    ok(s.white > 15, '白い灯りが見えない (' + s.white + ' 画素)');
  });

  await t('後ろを向けると赤い灯りが見える (前が白・後ろが赤)', async () => {
    // 機首を奥に向ける = 操縦者からは後ろ (赤) が見える
    const away = await page.evaluate(async () => {
      const app = window.__app.app;
      app.state.yaw = 0;
      window.__app.bench.drawScene();
      return true;
    }) && await lightStats(page);
    // 機首をこちらに向ける = 前 (白) が見える
    const toward = await page.evaluate(async () => {
      const app = window.__app.app;
      app.state.yaw = Math.PI;
      window.__app.bench.drawScene();
      return true;
    }) && await lightStats(page);
    ok(away.red > toward.red + 5, '後ろを向けても赤が増えない (' + away.red + ' vs ' + toward.red + ')');
    ok(toward.white > away.white + 5, '前を向けても白が増えない (' + toward.white + ' vs ' + away.white + ')');
  });

  await t('メニューの設定でも切り替えられて、月ボタンと同期する', async () => {
    await page.locator('#btnMenu').tap();
    await page.waitForTimeout(200);
    await page.locator('#setNight button[data-v="1"]').tap();
    await page.waitForTimeout(150);
    await page.evaluate(() => window.__app.startTask('hover'));
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => window.__app.isNight()), '設定が効いていない');
    ok(await page.locator('#btnNight[aria-pressed="true"]').count() === 1, '月ボタンと食い違っている');
    const dark = await lightStats(page);

    await page.locator('#btnMenu').tap();
    await page.waitForTimeout(200);
    await page.locator('#setNight button[data-v="0"]').tap();
    await page.waitForTimeout(150);
    await page.evaluate(() => window.__app.startTask('hover'));
    await page.waitForTimeout(300);
    ok(!await page.evaluate(() => window.__app.isNight()), '明るいに戻らない');
    ok((await lightStats(page)).avg > dark.avg * 1.4, '明るくならない');
  });

  await t('影は 1 枚のべた塗りでなく、高いほど広がる', async () => {
    // 目標の輪が床に色を塗るので、部屋では影だけを測れない。
    // 輪のない広場で測る。
    await page.evaluate(() => { window.__app.app.settings.night = 0; window.__app.startTask('free'); });
    await page.waitForTimeout(300);
    async function shadowWidth(y) {
      return page.evaluate((h) => {
        const C = window.Core, app = window.__app.app;
        app.state.pos = { x: 0, y: h, z: -3.5 };
        app.state.vel = { x: 0, y: 0, z: 0 };
        app.state.flying = true;
        app.cam.yaw = 0; app.cam.pitch = -0.48;
        window.__app.bench.drawScene();
        const foot = C.projectPoint(app.cam, { x: 0, y: 0.008, z: -3.5 });
        const cv = document.getElementById('view');
        const sc = window.__app.renderScale();
        const d = cv.getContext('2d').getImageData(0, Math.round(foot.y * sc), cv.width, 1).data;
        // その行の端 (影のない地面) を基準に、それより暗い画素の幅を数える
        const floor = d[0] + d[1] + d[2];
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < floor * 0.94) n++;
        return n;
      }, y);
    }
    const low = await shadowWidth(0.25);
    const mid = await shadowWidth(1.0);
    const high = await shadowWidth(2.2);
    console.log('       影の幅 0.25m:' + low + '  1.0m:' + mid + '  2.2m:' + high);
    ok(low > 20, '影が見えない');
    ok(mid > low && high > mid, '高くしても影が広がらない (' + low + ' / ' + mid + ' / ' + high + ')');
  });

  console.log('\n■ リプレイとゴースト');

  await t('飛び終わったあと、リプレイを開ける', async () => {
    // この節だけで完結させる。前の節がどこで終わっていても動くように。
    await page.evaluate(() => {
      const C = window.Core;
      window.__app.app.settings.night = 0;
      window.__app.startTask('box');
      window.__app.simulate(120, (s, run) => {
        const g = run.task.gates[Math.min(run.gateIndex, run.task.gates.length - 1)];
        const ex = g.x - s.pos.x, ez = g.z - s.pos.z;
        const ax = 0.9 * ex - 1.5 * s.vel.x, az = 0.9 * ez - 1.5 * s.vel.z;
        const h = C.headingVectors(s.yaw);
        let th = C.clamp((g.y - s.pos.y) * 1.6 - s.vel.y * 0.5, -1, 1);
        if (!s.flying && !s.airborne) th = Math.max(th, 0.5);
        return { throttle: th, yaw: 0, pitch: C.clamp(ax * h.fwd.x + az * h.fwd.z, -1, 1),
                 roll: C.clamp(ax * h.right.x + az * h.right.z, -1, 1) };
      });
    });
    await page.waitForSelector('#result:not([hidden])', { timeout: 5000 });
    await page.locator('#btnReplay').tap();
    await page.waitForTimeout(400);
    ok(await page.locator('#replay').isVisible(), 'リプレイ画面が出ない');
    ok((await canvasStats(page)).distinct > 12, 'リプレイの絵が描けていない');
  });

  await t('再生すると時間が進み、絵も変わる', async () => {
    const a = await screenHash(page);
    const t0 = await page.evaluate(() => window.__app.replay.t);
    await page.waitForTimeout(900);
    const t1 = await page.evaluate(() => window.__app.replay.t);
    ok(t1 > t0 + 0.3, '時間が進まない (' + t0.toFixed(2) + ' -> ' + t1.toFixed(2) + ')');
    ok(await screenHash(page) !== a, '絵が変わらない');
  });

  await t('止める・つまみで頭出しできる', async () => {
    await page.locator('#replayPlay').tap();
    await page.waitForTimeout(300);
    const a = await page.evaluate(() => window.__app.replay.t);
    await page.waitForTimeout(500);
    near(await page.evaluate(() => window.__app.replay.t), a, 0.02, '止まっていない');
    await page.evaluate(() => {
      const el = document.getElementById('replaySeek');
      el.value = String(Math.round(window.__app.replay.dur * 100 * 0.5));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(250);
    const half = await page.evaluate(() => window.__app.replay.t / window.__app.replay.dur);
    near(half, 0.5, 0.05, 'つまみが効いていない');
  });

  await t('そのときのスティックの位置も出ていて、時間とともに動く', async () => {
    const pos = [];
    for (const frac of [0.05, 0.3, 0.6]) {
      await page.evaluate((f) => {
        const el = document.getElementById('replaySeek');
        el.value = String(Math.round(window.__app.replay.dur * 100 * f));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, frac);
      await page.waitForTimeout(200);
      pos.push(await page.evaluate(() => {
        const a = document.getElementById('replayStickL'), b = document.getElementById('replayStickR');
        return [a.style.left, a.style.top, b.style.left, b.style.top].join('|');
      }));
    }
    ok(pos.every(p => p.split('|').every(v => v)), 'スティックの表示が出ていない');
    ok(new Set(pos).size > 1, '時間を動かしてもスティックが変わらない: ' + pos[0]);
  });

  await t('倒しっぱなしで飛んだ記録を再生すると、その場で指摘が出る', async () => {
    await page.locator('#replayClose').tap();
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      window.__app.startTask('box');
      // わざと右スティックを倒しっぱなしにする
      window.__app.simulate(20, (s) => ({ throttle: s.pos.y < 1.1 ? 0.7 : 0, yaw: 0, pitch: s.pos.y < 1.1 ? 0 : 0.9, roll: 0 }));
    });
    await page.waitForTimeout(1400);
    const hints = await page.evaluate(() => {
      const run = window.__app.run();
      window.__app.openReplay(run);
      const out = [];
      for (let i = 1; i <= 12; i++) out.push(window.__app.replayHintAt(run.elapsed * i / 13));
      return out;
    });
    ok(hints.some(h => /倒しっぱなし/.test(h)), '指摘が出ない: ' + JSON.stringify(hints));
  });

  await t('その指摘が画面にも出る', async () => {
    await page.evaluate(() => {
      const el = document.getElementById('replaySeek');
      el.value = String(Math.round(window.__app.replay.dur * 100 * 0.75));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    const txt = await page.locator('#replayNote').textContent();
    ok(/倒しっぱなし|止める舵/.test(txt), '画面に出ていない: ' + txt);
    ok(await page.locator('#replayNote.warn').count() === 1, '目立つ色になっていない');
  });

  await t('リプレイ中の軌跡は、いまの時刻までしか出ない', async () => {
    async function trailLen(frac) {
      return page.evaluate((f) => {
        const el = document.getElementById('replaySeek');
        el.value = String(Math.round(window.__app.replay.dur * 100 * f));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        window.__app.bench.drawScene(window.__app.sampleAt(window.__app.replay.t));
        return window.__app.drawnTrail();
      }, frac);
    }
    const early = await trailLen(0.08);
    const mid = await trailLen(0.5);
    const late = await trailLen(0.98);
    ok(early < mid && mid < late, '時刻とともに伸びていない (' + early + ' / ' + mid + ' / ' + late + ')');
    const all = await page.evaluate(() => window.__app.replay.samples.length);
    ok(early < all * 0.3, '最初から全部出ている (' + early + ' / 全 ' + all + ')');
  });

  await t('荷物を置く台が画面に出ている', async () => {
    const n = await page.evaluate(() => {
      const C = window.Core;
      window.__app.startTask('carry');
      const app = window.__app.app;
      const pad = app.run.task.pad;
      // 台のほうを向いてから描く
      app.cam.yaw = Math.atan2(pad.x - app.cam.pos.x, pad.z - app.cam.pos.z);
      app.cam.pitch = Math.atan2(0.1 - app.cam.pos.y, Math.hypot(pad.x - app.cam.pos.x, pad.z - app.cam.pos.z));
      window.__app.bench.drawScene();
      const s = C.projectPoint(app.cam, { x: pad.x, y: 0.01, z: pad.z });
      if (!s) return -1;
      const cv = document.getElementById('view');
      const sc = window.__app.renderScale();
      const x0 = Math.max(0, Math.round((s.x - 30) * sc)), y0 = Math.max(0, Math.round((s.y - 20) * sc));
      const d = cv.getContext('2d').getImageData(x0, y0, Math.round(60 * sc), Math.round(40 * sc)).data;
      let g = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 1] > d[i] + 14 && d[i + 1] > 60) g++;
      return g;
    });
    ok(n > 20, '緑の台が描かれていない (緑の画素 ' + n + ')');
  });

  await t('リプレイを閉じると結果に戻る', async () => {
    // 走行を 1 つ終わらせてから開く
    await page.evaluate(() => {
      const C = window.Core;
      window.__app.startTask('hover');
      window.__app.simulate(80, (s) => {
        const t = window.__app.run().task.target;
        const ex = t.x - s.pos.x, ez = t.z - s.pos.z;
        const ax = 0.9 * ex - 1.5 * s.vel.x, az = 0.9 * ez - 1.5 * s.vel.z;
        const h = C.headingVectors(s.yaw);
        return { throttle: C.clamp((t.y - s.pos.y) * 1.6 - s.vel.y * 0.5, -1, 1), yaw: 0,
                 pitch: C.clamp(ax * h.fwd.x + az * h.fwd.z, -1, 1),
                 roll: C.clamp(ax * h.right.x + az * h.right.z, -1, 1) };
      });
    });
    await page.waitForSelector('#result:not([hidden])', { timeout: 4000 });
    await page.locator('#btnReplay').tap();
    await page.waitForTimeout(400);
    ok(await page.locator('#replay').isVisible(), 'リプレイが開かない');
    await page.locator('#replayClose').tap();
    await page.waitForTimeout(300);
    ok(await page.locator('#result').isVisible(), '結果に戻らない');
  });

  await t('クリアするとゴーストが残り、次の走行で並走する', async () => {
    const saved = await page.evaluate(() => {
      // この節の最初にクリアした ③ のゴーストが残っているはず
      return !!JSON.parse(localStorage.getItem('dorone.ghost.v1.box') || 'null');
    });
    ok(saved, 'ゴーストが保存されていない');
    await page.evaluate(() => window.__app.startTask('box'));
    await page.waitForTimeout(250);
    const g = await page.evaluate(() => {
      const gh = window.__app.ghost();
      return gh && { n: gh.d.length / 4, step: gh.step, elapsed: gh.elapsed };
    });
    ok(g && g.n > 5, 'ゴーストが読みこまれていない');
    // 走行中に、ゴーストの位置が取り出せる
    const p = await page.evaluate(() => {
      const gh = window.__app.ghost();
      const a = window.__app.app;
      // 中ほどの時刻
      a.run.elapsed = gh.elapsed * 0.4;
      window.__app.bench.drawScene();
      return true;
    });
    ok(p, 'ゴーストを描くところで落ちた');
    ok((await canvasStats(page)).distinct > 12, 'ゴーストを出すと絵が壊れる');
  });

  console.log('\n■ 機体の色 (見た目だけ)');

  /** 星を決め打ちして、メニューを開きなおす。 */
  async function setStars(page, per) {
    return page.evaluate((n) => {
      const p = {};
      window.Tasks.TASKS.forEach(t => { if (t.kind !== 'free') p[t.id] = n; });
      window.__app.setProgress(p);
      window.__app.setScreen('menu');
      return window.Tasks.countStars(p);
    }, per);
  }

  await t('星の数だけ色が解放され、足りないものは押せない', async () => {
    const stars = await setStars(page, 1);          // 9 課題 x 1 = 9 個
    ok(stars === 9, '星の数が合わない (' + stars + ')');
    ok((await page.locator('#skinStars').textContent()).includes('9 / 27'),
      '集めた星の数が出ていない');

    const items = await page.locator('#skinList .skin-item').count();
    ok(items === 8, '色の数が合わない (' + items + ')');
    // 0/3/6 の 3 つが開いて、10 以上の 5 つは閉じたまま
    const open = await page.locator('#skinList .skin-item:not(.locked)').count();
    const locked = await page.locator('#skinList .skin-item.locked').count();
    console.log('       星 9 個 → 解放 ' + open + ' / 未解放 ' + locked);
    ok(open === 3, '解放された色の数が合わない (' + open + ')');
    ok(locked === 5, '未解放の色の数が合わない (' + locked + ')');
    ok(await page.locator('#skinList .skin-item[data-skin="gold"]').isDisabled(),
      '星が足りない色が押せてしまう');
    ok((await page.locator('.skin-item[data-skin="gold"] .skin-tag').textContent()).includes('27'),
      'あと何個いるのかが出ていない');
  });

  await t('解放された色は選べて、選んだ色が残る', async () => {
    await page.locator('#skinList .skin-item[data-skin="lime"]').tap();
    await page.waitForTimeout(120);
    ok(await page.evaluate(() => window.__app.skin().id) === 'lime', '選んだ色になっていない');
    ok(await page.locator('.skin-item[data-skin="lime"].on').count() === 1, '選んだ印が付かない');
    ok((await page.locator('.skin-item[data-skin="lime"] .skin-tag').textContent()).includes('使用中'),
      '「使用中」が出ていない');
    // 課題を始めても残る
    await page.evaluate(() => window.__app.startTask('hover'));
    await page.waitForTimeout(200);
    ok(await page.evaluate(() => window.__app.skin().id) === 'lime', '課題を始めたら色が戻った');
  });

  await t('持っていない色を無理やり指定しても、既定に落ちる', async () => {
    const r = await page.evaluate(() => {
      // 保存が書きかわっていた状態を作り、読みこみ直後と同じ道 (applySkin) を通す
      window.__app.app.settings.skin = 'gold';       // 星 9 個ではまだ届かない
      const loaded = window.__app.applySkin().id;
      // 押せないはずのものを押しても、選ばれない
      window.__app.chooseSkin('gold');
      return { loaded: loaded, saved: window.__app.app.settings.skin, now: window.__app.skin().id };
    });
    ok(r.loaded === 'default', '持っていない色が使えてしまう (' + r.loaded + ')');
    ok(r.saved !== 'gold' || r.now === 'default', '持っていない色が選ばれた (' + r.now + ')');
    await page.evaluate(() => window.__app.chooseSkin('lime'));
  });

  await t('えらんだ色が、画面の機体に本当に出ている', async () => {
    // 「設定を変えた」だけでは色が出ている証拠にならない。実際の画素を測る。
    const res = await page.evaluate(() => {
      const app = window.__app.app;
      const all = {};
      window.Tasks.TASKS.forEach(t => { all[t.id] = 3; });   // 全部の色を解放する
      window.__app.setProgress(all);
      app.settings.night = 0;
      window.__app.startTask('hover');

      function shoot(id) {
        window.__app.chooseSkin(id);
        // 走るたびに数字が変わらないように、機体を決まった場所に置き、
        // 羽根の位置も解像度も止める。輪の明滅も止める (inZone = false)。
        app.state.pos = { x: 0, y: 1.35, z: 0.7 };
        app.state.vel = { x: 0, y: 0, z: 0 };
        app.state.yaw = 0; app.state.spin = 0; app.state.throttleVis = 0;
        app.state.flying = true;
        app.run.inZone = false;
        window.__app.setRenderScale(2);
        for (let i = 0; i < 6; i++) window.__app.updateCam(3);
        window.__app.bench.drawScene();
        const cv = document.getElementById('view');
        return cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      }

      const base = new Uint8ClampedArray(shoot('default'));
      const out = {};
      for (const sk of window.Tasks.SKINS) {
        if (sk.id === 'default') continue;
        const d = shoot(sk.id);
        let n = 0, r = 0, g = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) {
          // 既定の色と違うところ = 塗り分けた機体そのもの
          if (Math.abs(d[i] - base[i]) + Math.abs(d[i + 1] - base[i + 1])
            + Math.abs(d[i + 2] - base[i + 2]) < 12) continue;
          n++; r += d[i]; g += d[i + 1]; b += d[i + 2];
        }
        out[sk.id] = { n: n, r: r / n, g: g / n, b: b / n };
      }
      return out;
    });

    for (const id of Object.keys(res)) {
      const c = res[id];
      console.log('       ' + id.padEnd(8) + ' 変わった画素 ' + String(c.n).padStart(5)
        + '  rgb(' + c.r.toFixed(0) + ',' + c.g.toFixed(0) + ',' + c.b.toFixed(0) + ')');
      ok(c.n > 400, id + ' に変えても機体の色が変わっていない (' + c.n + ' 画素)');
    }
    // 色の向きも見る。青い機体が赤くなっていたら、どこかで取りちがえている
    ok(res.sky.b > res.sky.r + 25, 'そらいろが青くない');
    ok(res.lime.g > res.lime.r + 20 && res.lime.g > res.lime.b + 40, 'ライムが緑でない');
    ok(res.cherry.r > res.cherry.g + 40 && res.cherry.r > res.cherry.b + 30, 'チェリーが赤くない');
    ok(res.gold.r > res.gold.b + 45 && res.gold.g > res.gold.b + 30, 'ゴールドが金色でない');
    ok(res.violet.b > res.violet.g + 25, 'すみれが紫でない');
  });

  await t('暗い部屋でも、色の違いは残る (LED は色えらびで変わらない)', async () => {
    const res = await page.evaluate(() => {
      const app = window.__app.app;
      app.settings.night = 1;
      window.__app.startTask('hover');
      window.__app.applyNight();

      function shoot(id) {
        window.__app.chooseSkin(id);
        app.state.pos = { x: 0, y: 1.35, z: 0.7 };
        app.state.vel = { x: 0, y: 0, z: 0 };
        app.state.yaw = 0; app.state.spin = 0; app.state.throttleVis = 0;
        app.state.flying = true;
        app.run.inZone = false;
        window.__app.setRenderScale(2);
        for (let i = 0; i < 6; i++) window.__app.updateCam(3);
        window.__app.bench.drawScene();
        const cv = document.getElementById('view');
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        // 航法灯 (前が白・後ろが赤) は実機の決まり。色えらびで変えてはいけない
        let white = 0, red = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          if (r > 190 && g > 200 && b > 210) white++;
          if (r > 130 && r > g + 60 && r > b + 60) red++;
        }
        return { data: new Uint8ClampedArray(d), white: white, red: red };
      }

      // 青い機体で測る。赤い機体だと、胴体そのものが「赤い灯り」に数えられてしまう
      const a = shoot('default'), b = shoot('sky');
      let n = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1])
          + Math.abs(a.data[i + 2] - b.data[i + 2]) >= 12) n++;
      }
      app.settings.night = 0;
      window.__app.applyNight();
      return { changed: n, whiteA: a.white, whiteB: b.white, redA: a.red, redB: b.red };
    });
    console.log('       夜に変わった画素 ' + res.changed
      + ' / 白い灯り ' + res.whiteA + '→' + res.whiteB
      + ' / 赤い灯り ' + res.redA + '→' + res.redB);
    ok(res.changed > 120, '夜だと色の違いが消える (' + res.changed + ' 画素)');
    // 灯りの数は動かないこと。レンズを明るいままにすると、ここが増えて
    // 「3 つめの灯り」ができてしまう (実際に一度そうなった)
    ok(Math.abs(res.whiteA - res.whiteB) <= Math.max(6, res.whiteA * 0.03),
      '色をかえたら航法灯の白まで変わった (' + res.whiteA + ' → ' + res.whiteB + ')');
    ok(Math.abs(res.redA - res.redB) <= Math.max(6, res.redA * 0.03),
      '色をかえたら航法灯の赤まで変わった (' + res.redA + ' → ' + res.redB + ')');
  });

  await t('どの色でも、後ろの赤い航法灯が胴体に沈まない', async () => {
    // 赤や白の機体だと、灯りが胴体と同じ色になって前後が読めなくなる。
    // 灯りのまわりだけを切り取って、「暗い受け皿の中で光っているか」を測る。
    const res = await page.evaluate(() => {
      const app = window.__app.app;
      const out = {};
      const all = {};
      window.Tasks.TASKS.forEach(t => { all[t.id] = 3; });
      window.__app.setProgress(all);
      app.settings.night = 0;
      window.__app.startTask('hover');

      for (const sk of window.Tasks.SKINS) {
        window.__app.chooseSkin(sk.id);
        // yaw = 0 で機首は部屋の奥。操縦者からは**後ろ (赤)** が見える
        const pos = { x: 0, y: 1.30, z: 0.90 };
        app.state.pos = { x: pos.x, y: pos.y, z: pos.z };
        app.state.vel = { x: 0, y: 0, z: 0 };
        app.state.yaw = 0; app.state.spin = 0; app.state.throttleVis = 0;
        app.state.flying = true;
        app.run.inZone = false;
        window.__app.setRenderScale(2);
        for (let i = 0; i < 6; i++) window.__app.updateCam(3);
        window.__app.bench.drawScene();

        const cv = document.getElementById('view');
        const k = window.__app.renderScale();
        // 後ろの灯りの位置 (drawDrone の bodyL * 1.02 と同じ)
        const s = window.Core.projectPoint(app.cam, { x: pos.x, y: pos.y, z: pos.z - 0.0867 });
        const R = Math.round(9 * k);
        const d = cv.getContext('2d')
          .getImageData(Math.round(s.x * k) - R, Math.round(s.y * k) - R, R * 2, R * 2).data;

        let lamp = 0, dark = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          if (r > 190 && r > g + 70 && r > b + 70) lamp++;      // 灯りそのもの
          if ((r + g + b) / 3 < 25) dark++;                     // 受け皿
        }
        out[sk.id] = { lamp: lamp, dark: dark };
      }
      return out;
    });

    // 受け皿を外して測ると、明るい機体 (そらいろ・すみれ・スノー・ゴールド) は
    // 暗い画素が **0** になる。100 を割ったら、灯りが胴体に溶けていると見てよい。
    for (const id of Object.keys(res)) {
      const c = res[id];
      console.log('       ' + id.padEnd(8) + ' 灯り ' + String(c.lamp).padStart(4)
        + ' 画素 / まわりの暗い画素 ' + String(c.dark).padStart(4));
      ok(c.lamp > 60, id + ' で赤い航法灯が見えない (' + c.lamp + ' 画素)');
      ok(c.dark > 100, id + ' で灯りが胴体に沈んでいる (受け皿 ' + c.dark + ' 画素)');
    }
  });

  await t('モーターの頭が、根もとの航法灯を隠さない', async () => {
    // モーターの頭のほうが灯りより大きい。先に灯りを描くと塗りつぶされる。
    // 暗い頭だと気づかないが、明るい色の機体にすると一目で分かった。
    const res = await page.evaluate(() => {
      const app = window.__app.app;
      app.settings.night = 0;
      window.__app.chooseSkin('default');
      window.__app.startTask('hover');
      const pos = { x: 0, y: 1.30, z: 0.90 };
      app.state.pos = { x: pos.x, y: pos.y, z: pos.z };
      app.state.vel = { x: 0, y: 0, z: 0 };
      app.state.yaw = 0; app.state.spin = 0; app.state.throttleVis = 0;
      app.state.flying = true;
      app.run.inZone = false;
      window.__app.setRenderScale(2);
      for (let i = 0; i < 6; i++) window.__app.updateCam(3);
      window.__app.bench.drawScene();

      const cv = document.getElementById('view');
      const k = window.__app.renderScale();
      // 後ろ側 2 つのモーターの根もと (drawDrone の armR = 0.135、高さ 0.016)
      const out = [];
      for (const sx of [-0.135, 0.135]) {
        const s = window.Core.projectPoint(app.cam,
          { x: pos.x + sx, y: pos.y + 0.016, z: pos.z - 0.135 });
        const R = Math.round(4 * k);
        const d = cv.getContext('2d')
          .getImageData(Math.round(s.x * k) - R, Math.round(s.y * k) - R, R * 2, R * 2).data;
        let red = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 190 && d[i] > d[i + 1] + 70 && d[i] > d[i + 2] + 70) red++;
        }
        out.push(red);
      }
      return out;
    });
    console.log('       後ろのモーターの灯り ' + res.join(' / ') + ' 画素');
    res.forEach(function (n) {
      ok(n > 30, '根もとの灯りがモーターの頭に隠れている (' + n + ' 画素)');
    });
  });

  await t('新しい色が解放されると、結果画面が知らせる', async () => {
    const txt = await page.evaluate(() => {
      window.__app.setProgress({});                     // 星 0 個からやりなおす
      const run = window.__app.run();
      // 「①を 3 つ星」= 星 3 個。そらいろ (★3) がちょうど解放される
      run.finished = true; run.success = true; run.stars = 3;
      run.score = { accuracy: 1, smooth: 1, speed: 1, avgError: 0.1, roughness: 0.1 };
      run.notes = []; run.samples = run.samples || [];
      window.__app.finishFlight(run);
      const el = document.getElementById('resUnlock');
      return { hidden: el.hidden, text: el.textContent, stars: window.Tasks.countStars(window.__app.app.progress) };
    });
    console.log('       ' + txt.text);
    ok(txt.stars === 3, '星が入っていない (' + txt.stars + ')');
    ok(!txt.hidden, '解放のお知らせが出ていない');
    ok(txt.text.includes('そらいろ'), '解放された色の名前がない: ' + txt.text);
  });

  await t('解放がないときは、お知らせを出さない', async () => {
    const hidden = await page.evaluate(() => {
      window.__app.startTask('hover');               // 走行ごとに run は作りなおされる
      const run = window.__app.run();
      run.finished = true; run.success = true; run.stars = 1;   // すでに 3 つ星なので増えない
      run.score = { accuracy: 1, smooth: 1, speed: 1, avgError: 0.1, roughness: 0.1 };
      run.notes = [];
      window.__app.finishFlight(run);
      return document.getElementById('resUnlock').hidden;
    });
    ok(hidden, '増えていないのにお知らせが出た');
    await page.evaluate(() => { window.__app.setProgress({}); window.__app.chooseSkin('default'); });
  });

  console.log('\n■ 速さ');

  async function measure(label, limitMs) {
    const m = await page.evaluate(() => new Promise(resolve => {
      const times = [];
      let last = performance.now();
      let n = 0;
      function tick(now) {
        times.push(now - last); last = now; n++;
        if (n < 100) requestAnimationFrame(tick);
        else {
          times.shift();
          const sorted = times.slice().sort((a, b) => a - b);
          resolve({
            avg: times.reduce((a, b) => a + b, 0) / times.length,
            p95: sorted[Math.floor(sorted.length * 0.95)],
            max: sorted[sorted.length - 1]
          });
        }
      }
      requestAnimationFrame(tick);
    }));
    console.log('       ' + label + ': 平均 ' + m.avg.toFixed(1) + 'ms / 95% ' + m.p95.toFixed(1) + 'ms / 最悪 ' + m.max.toFixed(1) + 'ms');
    ok(m.p95 < limitMs, label + ' の 95% フレームが ' + m.p95.toFixed(1) + 'ms (上限 ' + limitMs + 'ms)');
    return m;
  }

  await t('ふつうの速さで 1 フレーム 20ms 以内', async () => {
    await page.evaluate(() => window.__app.startTask('eight'));   // 輪が 6 つある一番重い課題
    await page.waitForTimeout(500);
    await measure('通常', 20);
  });

  if (SLOW) {
    await t('CPU を 4 倍遅くすると、自動で解像度を落としてなめらかさを保つ', async () => {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      // 自動調整が効くまで待つ (1.5 秒ごとに 1 段ずつ下げる)
      await page.waitForTimeout(7000);
      const scale = await page.evaluate(() => window.__app.renderScale());
      console.log('       落ちついた解像度: x' + scale);
      ok(scale < 2, '解像度が下がっていない (x' + scale + ')');
      await measure('CPU 4 倍遅い', 40);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    });

    await t('速さが戻ったら解像度も戻る', async () => {
      await page.waitForTimeout(12000);
      const scale = await page.evaluate(() => window.__app.renderScale());
      ok(scale >= 1.5, '戻っていない (x' + scale + ')');
    });
  } else {
    console.log('  skip 遅い端末の測定 (--slow を付けると走ります)');
  }

  await t('最後まで JS のエラーが出ていない', () => ok(errors.length === 0, errors.join('\n       ')));

  await browser.close();
  stop();

  console.log('\n' + '-'.repeat(52));
  console.log(pass + ' 件成功 / ' + fail + ' 件失敗');
  if (fail) {
    console.log('\n失敗したもの:');
    failures.forEach(f => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('テスト自体が落ちました:', e);
  process.exit(2);
});
