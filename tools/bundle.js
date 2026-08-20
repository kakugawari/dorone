/* 全ファイルを 1 枚の HTML にまとめる。
   スマホですぐ開けるように、CSS も JS も画像も埋めこむ。

   使い方:
     node tools/bundle.js                そのまま開ける 1 枚 (dist/dorone.html)
     node tools/bundle.js --artifact     Artifact 用。<head>/<body> は向こうが付けるので中身だけ。
                                         確認用に、包んだ dist/artifact-preview.html も出す */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ARTIFACT = process.argv.includes('--artifact');
const argOut = process.argv.slice(2).find(a => !a.startsWith('--'));
const out = argOut || path.join(ROOT, 'dist', ARTIFACT ? 'artifact.html' : 'dorone.html');
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

if (/src="\.\//.test(html) || /href="\.\//.test(html)) {
  console.error('外を参照したままの箇所が残っています:');
  console.error(html.match(/(src|href)="\.\/[^"]*"/g).join('\n'));
  process.exit(1);
}
// 外のサーバーを見にいく記述が残っていないか (Artifact は外部への通信を止めている)
const external = html.match(/(?:src|href)="https?:\/\/[^"]*"/g);
if (external) {
  console.error('外部のアドレスを参照しています: ' + external.join(', '));
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });

if (!ARTIFACT) {
  fs.writeFileSync(out, html);
  console.log('書き出した: ' + out + ' (' + (fs.statSync(out).size / 1024).toFixed(0) + ' KB)');
} else {
  // <!DOCTYPE>/<html>/<head>/<body> は Artifact 側が付ける。中身だけ出す。
  // <title> は残す (タブとギャラリーの名前になる)。
  const head = html.slice(html.indexOf('<head>') + 6, html.indexOf('</head>'));
  const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
  const title = (head.match(/<title>[\s\S]*?<\/title>/) || [''])[0];
  const style = (head.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
  const fragment = [title, style, body.trim()].filter(Boolean).join('\n');
  fs.writeFileSync(out, fragment);
  console.log('書き出した: ' + out + ' (' + (fs.statSync(out).size / 1024).toFixed(0) + ' KB)');

  // Artifact が包むのと同じ形にして、テストできるようにする
  const preview = path.join(path.dirname(out), 'artifact-preview.html');
  fs.writeFileSync(preview,
    '<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
    '</head>\n<body>\n' + fragment + '\n</body>\n</html>\n');
  console.log('確認用:     ' + preview);
}
