/* アイコンの PNG を作る。
   iOS はホーム画面のアイコンに SVG を使えないので、PNG が要る。

   icon-source.png (正方形・大きめ) を読んで、必要な大きさに縮める。
   外部ライブラリを入れたくないので、node の zlib だけで PNG を読み書きする。

   使い方: node tools/make-icon.js
           node tools/make-icon.js --from 元.png --out 出す.png --size 512 */
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------- PNG を読む

/** 8bit・非インターレースの PNG を {w, h, px(RGBA)} にする。 */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG ではない');
  let w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  let pal = null, trns = null;

  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const body = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      depth = body[8]; color = body[9]; interlace = body[12];
    } else if (type === 'PLTE') pal = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (depth !== 8) throw new Error('8bit の PNG だけ扱える (' + depth + 'bit)');
  if (interlace) throw new Error('インターレースは扱えない');

  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!ch) throw new Error('色の種類 ' + color + ' は扱えない');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const lines = Buffer.alloc(h * stride);

  // フィルタを戻す
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = lines.subarray(y * stride, y * stride + stride);
    const up = y ? lines.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = up ? up[i] : 0;
      const c = (up && i >= ch) ? up[i - ch] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
  }

  // RGBA にそろえる
  const px = new Uint8Array(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    let r, g, b, a = 255;
    if (color === 0) { r = g = b = lines[i]; }
    else if (color === 2) { r = lines[i * 3]; g = lines[i * 3 + 1]; b = lines[i * 3 + 2]; }
    else if (color === 3) {
      const k = lines[i];
      r = pal[k * 3]; g = pal[k * 3 + 1]; b = pal[k * 3 + 2];
      if (trns && k < trns.length) a = trns[k];
    } else if (color === 4) { r = g = b = lines[i * 2]; a = lines[i * 2 + 1]; }
    else { r = lines[i * 4]; g = lines[i * 4 + 1]; b = lines[i * 4 + 2]; a = lines[i * 4 + 3]; }
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = a;
  }
  return { w: w, h: h, px: px };
}

// ---------------------------------------------------------------- PNG を書く

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, px) {
  // 透けていないなら α を落とす。滑らかなグラデーションの絵なので、
  // 1 画素 1 バイト減るだけでファイルがかなり小さくなる。
  let opaque = true;
  for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) { opaque = false; break; }
  const ch = opaque ? 3 : 4;
  const stride = w * ch;

  // 行ごとに 5 種類のフィルタを試して、いちばん平らになるものを選ぶ。
  // グラデーションはフィルタなしだとまるで縮まない。
  const raw = Buffer.alloc(h * (stride + 1));
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  const cand = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) cur[x * ch + c] = px[(y * w + x) * 4 + c];
    }
    let bestF = 0, bestScore = Infinity, best = null;
    for (let f = 0; f < 5; f++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? cur[i - ch] : 0;
        const b = prev[i];
        const c0 = i >= ch ? prev[i - ch] : 0;
        let v = cur[i];
        if (f === 1) v -= a;
        else if (f === 2) v -= b;
        else if (f === 3) v -= (a + b) >> 1;
        else if (f === 4) {
          const p = a + b - c0, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c0);
          v -= (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c0);
        }
        cand[i] = v & 0xff;
        score += cand[i] < 128 ? cand[i] : 256 - cand[i];
      }
      if (score < bestScore) { bestScore = score; bestF = f; best = Buffer.from(cand); }
    }
    raw[y * (stride + 1)] = bestF;
    best.copy(raw, y * (stride + 1) + 1);
    cur.copy(prev);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------- 縮める

/**
 * 面で平均を取って縮める (ボックスフィルタ)。
 * 間引くと、細いプロペラが消えたりギザギザになる。
 */
function resize(src, size) {
  const out = new Uint8Array(size * size * 4);
  const sx = src.w / size, sy = src.h / size;
  for (let y = 0; y < size; y++) {
    const y0 = y * sy, y1 = (y + 1) * sy;
    for (let x = 0; x < size; x++) {
      const x0 = x * sx, x1 = (x + 1) * sx;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let iy = Math.floor(y0); iy < Math.ceil(y1); iy++) {
        const cy = Math.min(y1, iy + 1) - Math.max(y0, iy);
        for (let ix = Math.floor(x0); ix < Math.ceil(x1); ix++) {
          const cx = Math.min(x1, ix + 1) - Math.max(x0, ix);
          const wgt = cx * cy;
          const i = (iy * src.w + ix) * 4;
          const al = src.px[i + 3] / 255;
          // 透明なところの色を混ぜないよう、色は α で重みづけする
          r += src.px[i] * wgt * al; g += src.px[i + 1] * wgt * al; b += src.px[i + 2] * wgt * al;
          a += src.px[i + 3] * wgt; wsum += wgt * al;
        }
      }
      const area = (y1 - y0) * (x1 - x0);
      const o = (y * size + x) * 4;
      out[o] = wsum ? Math.round(r / wsum) : 0;
      out[o + 1] = wsum ? Math.round(g / wsum) : 0;
      out[o + 2] = wsum ? Math.round(b / wsum) : 0;
      out[o + 3] = Math.round(a / area);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 角を埋める

/**
 * 角の白を、絵そのものの色で埋めて全面にする。
 *
 * iOS はホーム画面のアイコンを自分で角丸に切り抜く。元の絵が角丸だと、
 * 切り抜いたあとに元の白い角がすきまとして残る。透明にしても iOS では
 * 黒くなるので、絵の色で埋めるのが正しい。
 *
 * 角丸の半径は、いちばん上の行の「白でないところ」の始まりから分かる。
 */
function fillCorners(img) {
  const w = img.w, h = img.h, px = img.px;
  const white = function (i) { return px[i] >= 235 && px[i + 1] >= 235 && px[i + 2] >= 235; };

  let r = 0;
  while (r < w / 2 && white(r * 4)) r++;
  if (r < 2) return img;                       // もともと全面。何もしない

  const centers = [[r, r], [w - 1 - r, r], [r, h - 1 - r], [w - 1 - r, h - 1 - r]];
  for (const c of centers) {
    // その角のふちの色 (弧のすぐ内側) を平均して、1 色にする。
    // 半径の向きにコピーして伸ばすと、わずかなムラが筋になって出る。
    let ar = 0, ag = 0, ab = 0, n = 0;
    for (let a = 0; a <= 90; a += 2) {
      const th = (a / 180) * Math.PI;
      const ux = (c[0] < w / 2 ? -1 : 1) * Math.cos(th);
      const uy = (c[1] < h / 2 ? -1 : 1) * Math.sin(th);
      for (let back = 2; back <= 16; back++) {
        const sx = Math.round(c[0] + ux * (r - back)), sy = Math.round(c[1] + uy * (r - back));
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        if (white((sy * w + sx) * 4)) continue;
        // ふちは白とのなじみで灰色になっている。そこから 5 画素ぶん
        // 内側に入ったところが、その角の本当の色。
        const tx = Math.round(c[0] + ux * (r - back - 5)), ty = Math.round(c[1] + uy * (r - back - 5));
        const i = (Math.min(h - 1, Math.max(0, ty)) * w + Math.min(w - 1, Math.max(0, tx))) * 4;
        ar += px[i]; ag += px[i + 1]; ab += px[i + 2]; n++;
        break;
      }
    }
    if (!n) continue;
    const fr = Math.round(ar / n), fg = Math.round(ag / n), fb = Math.round(ab / n);

    const x0 = Math.max(0, c[0] - r - 1), x1 = Math.min(w - 1, c[0] + r + 1);
    const y0 = Math.max(0, c[1] - r - 1), y1 = Math.min(h - 1, c[1] + r + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // 角の外側だけを見る (中心から見て、角の向きにある四分円)
        if ((x - c[0]) * (c[0] - w / 2) < 0 || (y - c[1]) * (c[1] - h / 2) < 0) continue;
        const d = Math.hypot(x - c[0], y - c[1]);
        const di = (y * w + x) * 4;
        // 弧の外は必ず塗る。加えて、そのすぐ内側に残る「白となじんだ
        // 明るい 1 本の線」も消す。塗る色より明るいものだけを見るので、
        // 絵そのものには食いこまない。
        const lighter = (px[di] + px[di + 1] + px[di + 2]) > (fr + fg + fb) + 36;
        if (d <= r - 0.5 && !(d > r - 6 && lighter)) continue;
        px[di] = fr; px[di + 1] = fg; px[di + 2] = fb; px[di + 3] = 255;
      }
    }
  }
  return img;
}

// ---------------------------------------------------------------- 実行

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
}

const from = path.resolve(ROOT, arg('from', 'icon-source.png'));
const out = path.resolve(ROOT, arg('out', 'apple-touch-icon.png'));
const size = Number(arg('size', 180));   // iOS のホーム画面アイコンの大きさ

const src = decodePNG(fs.readFileSync(from));
if (src.w !== src.h) throw new Error('正方形の絵を渡すこと (' + src.w + 'x' + src.h + ')');
if (argv.indexOf('--keep-corners') < 0) fillCorners(src);
fs.writeFileSync(out, encodePNG(size, size, resize(src, size)));
console.log('書き出した: ' + out + ' (' + size + 'x' + size + ', '
  + Math.round(fs.statSync(out).size / 1024) + ' KB)');
