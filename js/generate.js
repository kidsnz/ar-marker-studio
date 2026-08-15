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

  // ------------------------------------------------------------------
  // ZIP（無圧縮）を自前で作る
  //
  // **3つ別々に落とそうとしてはいけない。** 実測すると Chrome は2つ目以降を
  // 黙って捨て、1つしか届かなかった（マーカーは3つ揃わないと使えないので致命的）。
  // 「複数ファイルのダウンロードを許可」を利用者に押させる作りにもしたくない。
  // ZIP なら1ファイルなので必ず届く。中身は既に圧縮済み（iset は JPEG、
  // fset3 はバイナリ）なので、無圧縮で入れても大きさはほとんど変わらない。
  // ------------------------------------------------------------------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * 無圧縮の ZIP を組み立てる。
   * @param entries [{name, bytes}]
   * @returns {Uint8Array}
   */
  function makeZip(entries) {
    var enc = new TextEncoder();
    var parts = [], central = [], offset = 0;
    // 日時は固定にする（同じ入力なら同じ ZIP が出るように）。1980-01-01 00:00
    var DOS_TIME = 0, DOS_DATE = 33;

    entries.forEach(function (e) {
      var name = enc.encode(e.name), crc = crc32(e.bytes), len = e.bytes.length;
      var h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true);   // ローカルヘッダの署名
      h.setUint16(4, 20, true);           // 必要バージョン
      h.setUint16(6, 0, true);            // フラグ
      h.setUint16(8, 0, true);            // 方式 0 = 無圧縮
      h.setUint16(10, DOS_TIME, true);
      h.setUint16(12, DOS_DATE, true);
      h.setUint32(14, crc, true);
      h.setUint32(18, len, true);         // 圧縮後の大きさ（無圧縮なので同じ）
      h.setUint32(22, len, true);         // 元の大きさ
      h.setUint16(26, name.length, true);
      h.setUint16(28, 0, true);           // extra なし
      parts.push(new Uint8Array(h.buffer), name, e.bytes);

      var c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);   // 中央ディレクトリの署名
      c.setUint16(4, 20, true); c.setUint16(6, 20, true);
      c.setUint16(8, 0, true); c.setUint16(10, 0, true);
      c.setUint16(12, DOS_TIME, true); c.setUint16(14, DOS_DATE, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, len, true); c.setUint32(24, len, true);
      c.setUint16(28, name.length, true);
      c.setUint16(30, 0, true); c.setUint16(32, 0, true);
      c.setUint16(34, 0, true); c.setUint16(36, 0, true);
      c.setUint32(38, 0, true);
      c.setUint32(42, offset, true);      // このファイルのローカルヘッダの位置
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + len;
    });

    var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);   // 終端レコードの署名
    end.setUint16(4, 0, true); end.setUint16(6, 0, true);
    end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    end.setUint16(20, 0, true);           // コメントなし

    var all = parts.concat(central, [new Uint8Array(end.buffer)]);
    var total = all.reduce(function (a, b) { return a + b.length; }, 0);
    var out = new Uint8Array(total), at = 0;
    all.forEach(function (b) { out.set(b, at); at += b.length; });
    return out;
  }

  /**
   * 3つまとめて1つの ZIP で落とす。**マーカーは3つ揃って初めて使えるので、これが既定。**
   * @param files {fset, fset3, iset}
   * @param base 拡張子を除いたファイル名
   */
  function downloadAll(files, base) {
    var zip = makeZip(['fset', 'fset3', 'iset'].map(function (ext) {
      return { name: base + '.' + ext, bytes: files[ext] };
    }));
    download(zip, base + '.zip');
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
                     downloadAll: downloadAll, makeZip: makeZip, linkFor: linkFor };
})(typeof self !== 'undefined' ? self : this);
