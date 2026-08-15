/*
 * genworker.js — 本物の生成器を別スレッドで走らせる。
 *
 * 生成は一本の長い同期処理なので、メインスレッドで回すとタブが固まって
 * 操作も画面更新もできなくなる（実際に固まることを確認済み）。必ず Worker で回す。
 *
 * 【Module は毎回作り直す。使い回してはいけない】
 * 「自動探索では25通り生成するのだから初期化は1回でいい」と考えて Module を
 * 1つだけ作って使い回していたことがあるが、**これは間違いだった**。
 * 生成器は内部に状態を持っていて、2回目以降の .fset が1回目のまま返ってくる。
 * 実測（同じ画像・同じ dpi、ブラウザ）:
 *   使い回し … -level=4 → fset 464バイト ／ 続けて -level=0 → fset 464バイト（変わらない）
 *   作り直し … -level=0 → fset 204バイト（こちらが正しい）
 * 探索の結果が「拡大率も level も違うのに全部同じ数字」になって発覚した。
 * ワーカー自体は使い回すので、1MB のスクリプトの読み直しまでは起きない。
 */
// 自分の URL に付いてきた ?v= をそのまま引き継ぐ（ワーカーの中だけ古くならないように）
importScripts('../vendor/NftMarkerCreator.min.js' + self.location.search);

var logSink = null;

/**
 * 生成器を1つ作る。
 *
 * 【Emscripten の Module は Promise ではない】
 * vendor の中身はこうなっている:
 *   Module["then"] = function(func){ if(calledRun){func(Module)} else {…} return Module }
 * 返ってくるのは Module 自身なので **`.catch` が生えていない**。
 * `makeModule().then(…).catch(…)` と素で書くと毎回 TypeError になり、
 * それが onmessage の外に飛んで worker の error になる。すると generate.js が
 * ワーカーを丸ごと捨てて作り直すので、生成が1つおきに失敗する
 * （25通り中12通りが落ちるのを実測した）。だから本物の Promise で包む。
 *
 * **Module をそのまま resolve してはいけない。** thenable と見なされて
 * Module.then が延々と呼ばれ続けるので、箱に入れて渡す。
 */
function makeModule() {
  return new Promise(function (resolve) {
    var m = new Module({
      print: function (t) {
        // 生成器は進捗を大量に吐く。受け手が居るときだけ、間引いて渡す
        if (logSink) logSink(String(t));
      },
      printErr: function () {}
    });
    m.then(function (M) { resolve({ M: M }); });
  });
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

  makeModule().then(function (box) {
    var M = box.M;
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

      // 出力名は d.name ではなく tempFilename 固定（生成器側がそう書き出す）。
      // Module ごと作り直しているので、前回の書き出しが残っていることはない
      var fset = M.FS.readFile('tempFilename.fset');
      var fset3 = M.FS.readFile('tempFilename.fset3');
      var iset = M.FS.readFile('tempFilename.iset');

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
