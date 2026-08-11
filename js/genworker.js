/*
 * genworker.js — 本物の生成器を別スレッドで走らせる。
 *
 * 生成は一本の長い同期処理なので、メインスレッドで回すとタブが固まって
 * 操作も画面更新もできなくなる（実際に固まることを確認済み）。必ず Worker で回す。
 */
importScripts('../vendor/NftMarkerCreator.min.js');

self.onmessage = function (e) {
  var d = e.data;
  var t0 = Date.now();
  var lastLog = 0;

  new Module({
    print: function (t) {
      // 生成器は進捗を大量に吐く。0.5秒ごとにだけ拾ってメインに返す
      var now = Date.now();
      if (now - lastLog > 500) {
        lastLog = now;
        self.postMessage({ type: 'log', text: String(t).slice(0, 120) });
      }
    },
    printErr: function () {}
  }).then(function (M) {
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
      self.postMessage({
        type: 'done', ms: Date.now() - t0, params: str,
        fset: fset, fset3: fset3, iset: iset
      }, [fset.buffer, fset3.buffer, iset.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
  }).catch(function (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  });
};
