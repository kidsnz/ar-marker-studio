/* AR Marker Studio ローカル版のサーバ
 *
 * 画面は ar-marker-studio をそのまま配り、生成だけ手元の Node に肩代わりさせる。
 * ブラウザ内の生成は 12 秒かかるが、Node のスレッド版なら 4 秒で終わる（実測）。
 *
 * 使い方:  start-local.command をダブルクリック
 *          （手で動かすなら  node local/server.js  でも同じ）
 *
 * サーバが居ない環境では、公開版と同じくブラウザ内生成に自動で戻る。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8790);
const HERE = __dirname;
const STUDIO = path.dirname(HERE);          // local/ の親 = ar-marker-studio
const THREADS = Number(process.env.THREADS || 4);   // 実測で 4 が最速（8 は頭打ち）

// ---------------------------------------------------------------- 生成
// 1 回ごとに子プロセスを使い捨てる。スレッド版はワーカーを抱えたまま常駐するので、
// 使い回すと状態が残るおそれがあり、失敗したときにサーバ本体を巻き込む。
// 初期化は数百ミリ秒で、生成の 4 秒に対して十分小さい。
const { fork } = require('child_process');

function generate(payload) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(HERE, 'worker.js'), {
      env: { ...process.env, THREADS: String(THREADS) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('生成が 10 分を超えた')); }, 600000);
    child.on('message', (m) => {
      clearTimeout(timer);
      child.kill();
      m.ok ? resolve(m) : reject(new Error(m.error));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`生成プロセスが異常終了 (${code})\n${err.slice(0, 500)}`));
    });
    child.send(payload);
  });
}

// ---------------------------------------------------------------- 静的配信
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm', '.dat': 'application/octet-stream',
};

// 画面のファイルは書き換えない。配信するときに 1 行だけ足す
const BOOST = '<script src="/local/local-boost.js"></script>';

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';

  // /local/ 以下はこのフォルダから配る
  if (rel.startsWith('/local/')) {
    const f = path.join(HERE, path.basename(rel));
    if (!fs.existsSync(f)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(f));
  }

  const file = path.join(STUDIO, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(STUDIO)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404).end('not found'); return; }
    if (path.extname(file) === '.html') {
      let html = buf.toString('utf8');
      html = html.includes('</head>') ? html.replace('</head>', BOOST + '\n</head>') : BOOST + html;
      res.writeHead(200, { 'Content-Type': TYPES['.html'] });
      return res.end(html);
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- 本体
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/local/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, threads: THREADS }));
  }

  if (req.method === 'POST' && req.url === '/local/generate') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const t0 = Date.now();
        const out = await generate({
          raw: body.raw, W: body.W, H: body.H, nc: body.nc,
          dpi: body.dpi, level: body.level, leveli: body.leveli,
        });
        const ms = Date.now() - t0;
        console.log(`  生成 level=${body.level} dpi=${body.dpi} → ${(ms / 1000).toFixed(1)}秒`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ms, ...out }));
      } catch (e) {
        console.log('  失敗:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  serveStatic(req, res);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`\n  ポート ${PORT} は既に使われています。`);
    console.log(`  たぶん、もう起動しています → http://localhost:${PORT}/\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log('AR Marker Studio ローカル版');
  console.log(`  生成: ${THREADS} スレッド（ブラウザ内の約 3 倍速）`);
  console.log(`\n  → http://localhost:${PORT}/\n`);
  console.log('  終わるときはこのウインドウを閉じてください。\n');
});
