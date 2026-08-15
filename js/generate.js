/*
 * generate.js — 本物の生成器（ARToolKit5 の genTexData を Emscripten で
 * 固めたもの）をブラウザ内で走らせて .fset / .fset3 / .iset を作る。
 *
 * vendor/NftMarkerCreator.min.js は NFT-Marker-Creator（Carnaux、MIT）の
 * 成果物をそのまま使っている。asm.js の単一ファイルなので別途 .wasm は要らない。
 * サーバーには一切送らない。全部ブラウザの中で終わる。
 *
 * 生成は一本の長い同期処理なので、必ず Worker（js/genworker.js）で回す。
 * メインスレッドで回すとタブが固まって操作できなくなる。
 */
(function (root) {
  'use strict';

  /**
   * マーカーを生成する。
   * @param {Uint8ClampedArray} rgba 元画像（RGBA）
   * @param {number} W,H 画素数
   * @param {Object} opts {dpi, level, leveli, name, onLog, quiet}
   * @returns {Promise<{fset,fset3,iset,ms,params}>}
   */
  function generate(rgba, W, H, opts) {
    // app.js / Home.vue と同じ手順で画素を渡す。
    // r==g==b なら「グレースケール」と見なして R だけを送る（nc=1）
    var gray = true, i, p;
    for (i = 0; i < W * H; i++) {
      p = i * 4;
      if (rgba[p] !== rgba[p + 1] || rgba[p] !== rgba[p + 2]) { gray = false; break; }
    }
    var nc = gray ? 1 : 3;
    var arr = new Uint8Array(W * H * nc);
    for (i = 0, p = 0; i < W * H; i++) {
      var q = i * 4;
      arr[p++] = rgba[q];
      if (nc === 3) { arr[p++] = rgba[q + 1]; arr[p++] = rgba[q + 2]; }
    }

    return run({
      arr: arr, W: W, H: H, nc: nc,
      dpi: opts.dpi, level: opts.level, leveli: opts.leveli,
      name: opts.name || 'marker', quiet: !!opts.quiet
    }, opts.onLog);
  }

  // ------------------------------------------------------------------
  // ワーカーは1つだけ作って使い回す。
  // 自動探索では25通り生成するので、毎回作り直すと wasm の初期化を25回やることになる。
  // ------------------------------------------------------------------
  var worker = null, seq = 0, waiting = {};

  function getWorker() {
    if (worker) return worker;
    worker = new Worker('js/genworker.js' + (root.AMS_VER || ''));
    worker.onmessage = function (e) {
      var m = e.data, w = waiting[m.id];
      if (!w) return;
      if (m.type === 'log') { if (w.onLog) w.onLog(m.text); return; }
      delete waiting[m.id];
      if (m.type === 'done') w.resolve(m);
      else w.reject(new Error(m.message || '生成に失敗した'));
    };
    worker.onerror = function (err) {
      var msg = err.message || '生成器を読み込めなかった';
      Object.keys(waiting).forEach(function (k) {
        waiting[k].reject(new Error(msg)); delete waiting[k];
      });
      // 壊れたワーカーは捨てる。次の呼び出しで作り直す
      try { worker.terminate(); } catch (ignore) {}
      worker = null;
    };
    return worker;
  }

  function run(msg, onLog) {
    return new Promise(function (resolve, reject) {
      var w = getWorker();
      msg.id = ++seq;
      waiting[msg.id] = { resolve: resolve, reject: reject, onLog: onLog };
      w.postMessage(msg, [msg.arr.buffer]);
    });
  }

  /** ブラウザにファイルとして保存させる */
  function download(bytes, filename) {
    var blob = new Blob([bytes], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /**
   * 3つまとめて落とす。**マーカーは3つ揃って初めて使えるので、これが既定。**
   *
   * 【ブラウザの制限】サイトごとに「複数ファイルのダウンロード」を1度許可するまで、
   * ブラウザは2つ目以降を落とさない（実測: 許可前は .fset だけしか届かなかった）。
   * Chrome ならアドレスバーの右端に確認が出るので、一度「許可」すれば以後は黙って3つ届く。
   * 落ちなかったぶんは、下に出るリンクから個別に取れる。
   *
   * 間隔を空けるのは、続けて呼ぶとブラウザが取りこぼすことがあるため。
   * @param files {fset, fset3, iset}
   * @param base 拡張子を除いたファイル名
   */
  function downloadAll(files, base) {
    ['fset', 'fset3', 'iset'].forEach(function (ext, i) {
      setTimeout(function () { download(files[ext], base + '.' + ext); }, i * 400);
    });
  }

  /** ダウンロード用のリンクを作る（あとからもう一度落としたいとき用） */
  function linkFor(bytes, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    a.download = filename;
    a.textContent = '▼ ' + filename + '（'
      + (bytes.length > 1024 ? (bytes.length / 1024).toFixed(1) + ' KB' : bytes.length + ' B')
      + '）';
    return a;
  }

  root.Generator = { generate: generate, download: download,
                     downloadAll: downloadAll, linkFor: linkFor };
})(typeof self !== 'undefined' ? self : this);
