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
   * @param {Object} opts {dpi, level, leveli, name, onLog}
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

    return new Promise(function (resolve, reject) {
      var w = new Worker('js/genworker.js');
      w.onmessage = function (e) {
        var m = e.data;
        if (m.type === 'log') { if (opts.onLog) opts.onLog(m.text); return; }
        w.terminate();
        if (m.type === 'done') resolve(m);
        else reject(new Error(m.message || '生成に失敗した'));
      };
      w.onerror = function (err) {
        w.terminate();
        reject(new Error(err.message || '生成器を読み込めなかった'));
      };
      w.postMessage({
        arr: arr, W: W, H: H, nc: nc,
        dpi: opts.dpi, level: opts.level, leveli: opts.leveli,
        name: opts.name || 'marker'
      }, [arr.buffer]);
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

  /** ダウンロード用のリンクを作る（3つ同時ダウンロードは確認ダイアログが出るため） */
  function linkFor(bytes, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    a.download = filename;
    a.textContent = '▼ ' + filename + '（'
      + (bytes.length > 1024 ? (bytes.length / 1024).toFixed(1) + ' KB' : bytes.length + ' B')
      + '）';
    return a;
  }

  root.Generator = { generate: generate, download: download, linkFor: linkFor };
})(typeof self !== 'undefined' ? self : this);
