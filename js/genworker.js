/*
 * genworker.js — 本物の生成器を別スレッドで走らせる。
 *
 * 生成は一本の長い同期処理なので、メインスレッドで回すとタブが固まって
 * 操作も画面更新もできなくなる（実際に固まることを確認済み）。必ず Worker で回す。
 *
 * 【wasm は1回だけ作って使い回す】
 * 以前は onmessage のたびに new Module() していた。1枚生成するだけなら気にならないが、
 * 自動探索では25通り生成するので、初期化を25回やることになる。
 * 作り直さなければ、2回目以降は正味の生成時間だけで済む
 * （ネイティブでの実測: 固定費 0.09秒 / 正味 0.27〜1.22秒）。
 */
importScripts('../vendor/NftMarkerCreator.min.js');

var modulePromise = null;
var logSink = null;

function getModule() {
  if (!modulePromise) {
    modulePromise = new Module({
      print: function (t) {
        // 生成器は進捗を大量に吐く。受け手が居るときだけ、間引いて渡す
        if (logSink) logSink(String(t));
      },
      printErr: function () {}
    });
  }
  return modulePromise;
}

self.onmessage = function (e) {
  var d = e.data;
  var t0 = Date.now();
  var lastLog = 0;

  // 進捗のログは 0.5 秒ごとにだけ返す。探索中（quiet）は返さない
  logSink = d.quiet ? null : function (t) {
    var now = Date.now();
    if (now - lastLog > 500) {
      lastLog = now;
      self.postMessage({ type: 'log', text: t.slice(0, 120), id: d.id });
    }
  };

  getModule().then(function (M) {
    try {
      var params = ['0', d.name, '-level=' + d.level, '-dpi=' + d.dpi];
      if (d.leveli != null) params.push('-leveli=' + d.leveli);
      var str = params.join(' ');

      var sb = M._malloc(str.length + 1);
      M.writeStringToMemory(str, sb);
      var heap = M._malloc(d.arr.length);
      M.HEAPU8.set(d.arr, heap);
      M._createImageSet(heap, d.dpi, d.W, d.H, d.nc, sb);
      M._free(heap);
      M._free(sb);

      var fset = M.FS.readFile('tempFilename.fset');
      var fset3 = M.FS.readFile('tempFilename.fset3');
      var iset = M.FS.readFile('tempFilename.iset');
      // 使い回すので、書き出したファイルは消しておく（次の生成に混ざらないように）
      try {
        M.FS.unlink('tempFilename.fset');
        M.FS.unlink('tempFilename.fset3');
        M.FS.unlink('tempFilename.iset');
      } catch (ignore) {}

      self.postMessage({
        type: 'done', id: d.id, ms: Date.now() - t0, params: str,
        fset: fset, fset3: fset3, iset: iset
      }, [fset.buffer, fset3.buffer, iset.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id: d.id,
                         message: String(err && err.message || err) });
    }
  }).catch(function (err) {
    self.postMessage({ type: 'error', id: d.id,
                       message: String(err && err.message || err) });
  });
};
