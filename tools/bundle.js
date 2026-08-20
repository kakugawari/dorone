/* 全ファイルを 1 枚の HTML にまとめる。
   スマホですぐ開けるように、CSS も JS も画像も埋めこむ。
   使い方: node tools/bundle.js [出力先]  (既定: dist/dorone.html) */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const out = process.argv[2] || path.join(ROOT, 'dist', 'dorone.html');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let html = read('index.html');
const css = read('styles.css');
const js = ['core.js', 'tasks.js', 'app.js'].map(read).join('\n');

// アイコンは data URI にする。1 枚で完結させるため。
const svg = read('icon.svg');
const svgURI = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
const pngURI = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'apple-touch-icon.png')).toString('base64');

html = html
  .replace('<link rel="stylesheet" href="./styles.css">', '<style>\n' + css + '\n</style>')
  .replace(/<script src="\.\/(core|tasks)\.js"><\/script>\s*/g, '')
  .replace('<script src="./app.js"></script>', '<script>\n' + js + '\n</script>')
  .replace('href="./icon.svg"', 'href="' + svgURI + '"')
  .replace('href="./apple-touch-icon.png"', 'href="' + pngURI + '"')
  // マニフェストは別ファイルなので、1 枚版では外す
  .replace(/<link rel="manifest"[^>]*>\s*/, '');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);

const kb = (fs.statSync(out).size / 1024).toFixed(0);
if (/src="\.\//.test(html) || /href="\.\//.test(html)) {
  console.error('外を参照したままの箇所が残っています:');
  console.error(html.match(/(src|href)="\.\/[^"]*"/g).join('\n'));
  process.exit(1);
}
console.log('書き出した: ' + out + ' (' + kb + ' KB)');
