/* local-boost.js — 生成だけを手元の Node に肩代わりさせる差し込み。
 *
 * 画面のファイル（index.html / js/*）は 1 行も書き換えない。server.js が配信時に
 * このスクリプトのタグを足し、ここが `Worker` を横取りして、genworker.js を
 * 作ろうとしたときだけ「同じ受け答えをするが中身はサーバに投げる」偽物を返す。
 *
 * サーバが居なければ何もしない（＝公開版と同じくブラウザ内で生成する）。
 *
 * 実測（500x751 の絵）: ブラウザ内 12.0秒 → ここ経由 4.0秒
 */
(function () {
  var ENDPOINT = '/local/generate';
  var alive = false;

  fetch('/local/ping').then(function (r) { return r.json(); }).then(function (d) {
    alive = !!(d && d.ok);
    if (alive) banner('ローカル生成 有効（' + d.threads + 'スレッド）');
  }).catch(function () { alive = false; });

  function banner(text) {
    var el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;' +
      'font:12px ui-monospace,monospace;background:#1b5e20;color:#fff;' +
      'padding:4px 10px;border-radius:4px;opacity:.9';
    (document.body || document.documentElement).appendChild(el);
  }

  function u8(b64) {
    var bin = atob(b64), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function b64(arr) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < arr.length; i += CH) {
      s += String.fromCharCode.apply(null, arr.subarray(i, i + CH));
    }
    return btoa(s);
  }

  var RealWorker = window.Worker;

  function FakeGenWorker() {
    var self = this;
    this._handlers = [];
    this.onmessage = null;

    this._emit = function (data) {
      if (self.onmessage) self.onmessage({ data: data });
      self._handlers.forEach(function (h) { h({ data: data }); });
    };

    this.addEventListener = function (t, h) { if (t === 'message') self._handlers.push(h); };
    this.removeEventListener = function (t, h) {
      if (t !== 'message') return;
      var i = self._handlers.indexOf(h);
      if (i >= 0) self._handlers.splice(i, 1);
    };
    this.terminate = function () {};

    this.postMessage = function (d) {
      var t0 = performance.now();
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          raw: b64(d.arr), W: d.W, H: d.H, nc: d.nc,
          dpi: d.dpi, level: d.level, leveli: d.leveli
        })
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (!res.ok) throw new Error(res.error);
        self._emit({
          type: 'done', id: d.id, ms: Math.round(performance.now() - t0),
          params: '0 ' + d.name + ' -level=' + d.level + ' -dpi=' + d.dpi + ' (local)',
          fset: u8(res.fset), fset3: u8(res.fset3), iset: u8(res.iset)
        });
      }).catch(function (e) {
        self._emit({ type: 'error', id: d.id, message: String(e.message || e) });
      });
    };
  }

  window.Worker = function (url, opts) {
    if (alive && String(url).indexOf('genworker') >= 0) return new FakeGenWorker();
    return new RealWorker(url, opts);
  };
  window.Worker.prototype = RealWorker.prototype;
})();
