/*
 * worker.js — 予測を別スレッドで走らせる。
 *
 * 予測は画像1枚で数秒かかる。メインスレッドで回すと画面が固まるので
 * Worker に逃がし、距離帯ごとに進捗を返す。
 */
importScripts('engine.js');

self.onmessage = function (e) {
  var d = e.data;
  try {
    var res = Engine.predict(d.bw, d.W, d.H, {
      dpi: d.dpi,
      level: d.level,
      onProgress: function (i, n, w, h, dpi) {
        self.postMessage({ type: 'progress', i: i, n: n, w: w, h: h, dpi: dpi });
      }
    });
    // bw / cand / candVal / usable は転送可能オブジェクトなのでコピーせず渡す
    var transfer = [];
    res.bands.forEach(function (b) {
      transfer.push(b.bw.buffer, b.cand.buffer, b.candVal.buffer, b.usable.buffer);
    });
    self.postMessage({ type: 'done', result: res }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
