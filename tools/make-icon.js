/* apple-touch-icon.png を作る。
   iOS はホーム画面のアイコンに SVG を使えないので、PNG が要る。
   外部ライブラリを入れたくないので、node の zlib だけで書き出す。
   使い方: node tools/make-icon.js */
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');

const S = 180;                       // iOS のホーム画面アイコンの大きさ
const px = new Uint8Array(S * S * 4);

function set(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const sa = a / 255;
  px[i] = Math.round(px[i] * (1 - sa) + r * sa);
  px[i + 1] = Math.round(px[i + 1] * (1 - sa) + g * sa);
  px[i + 2] = Math.round(px[i + 2] * (1 - sa) + b * sa);
  px[i + 3] = Math.max(px[i + 3], a);
}

/* 背景 (縦のグラデーション) */
for (let y = 0; y < S; y++) {
  const t = y / (S - 1);
  const r = Math.round(19 + t * -6), g = Math.round(26 + t * -10), b = Math.round(46 + t * -20);
  for (let x = 0; x < S; x++) set(x, y, r, g, b, 255);
}

/* アンチエイリアスつきの円 */
function disc(cx, cy, rad, r, g, b, a) {
  const r0 = Math.ceil(rad) + 2;
  for (let y = cy - r0; y <= cy + r0; y++) {
    for (let x = cx - r0; x <= cx + r0; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cov = Math.max(0, Math.min(1, rad + 0.5 - d));
      if (cov > 0) set(x, y, r, g, b, Math.round(a * cov));
    }
  }
}
function ring(cx, cy, rad, w, r, g, b, a) {
  const r0 = Math.ceil(rad + w) + 2;
  for (let y = cy - r0; y <= cy + r0; y++) {
    for (let x = cx - r0; x <= cx + r0; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cov = Math.max(0, Math.min(1, (w / 2 + 0.5) - Math.abs(d - rad)));
      if (cov > 0) set(x, y, r, g, b, Math.round(a * cov));
    }
  }
}
function bar(x0, y0, x1, y1, w, r, g, b, a) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) * 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    disc(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), w / 2, r, g, b, a);
  }
}

/* 上から見たクアッドコプター */
const c = S / 2, arm = 44, rot = 26;
const motors = [[-arm, -arm], [arm, -arm], [arm, arm], [-arm, arm]];
motors.forEach(m => bar(c + m[0] * 0.25, c + m[1] * 0.25, c + m[0], c + m[1], 11, 46, 54, 74, 255));
motors.forEach(m => {
  disc(c + m[0], c + m[1], rot, 150, 180, 235, 40);
  ring(c + m[0], c + m[1], rot, 3, 150, 185, 240, 150);
  disc(c + m[0], c + m[1], 8, 42, 50, 68, 255);
});
/* 胴体 */
disc(c, c, 26, 34, 40, 55, 255);
disc(c, c - 3, 22, 52, 60, 80, 255);
/* 前を向いている印 (青い LED) */
disc(c, c - 20, 9, 79, 195, 255, 255);
disc(c, c - 20, 5, 190, 235, 255, 255);

/* ---- PNG に書き出す ---- */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;                       // フィルタ: なし
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8bit RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const out = path.join(__dirname, '..', 'apple-touch-icon.png');
fs.writeFileSync(out, png);
console.log('書き出した:', out, png.length, 'bytes');
