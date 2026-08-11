/*
 * fixtures.js — 検算の期待値。**すべて実際の生成器のログから取った実測値**。
 *
 * 取り方:
 *   node run.js -i ./in/<img>.png -o out -level=<n> -dpi=<dpi> 2>&1 \
 *     | grep -E "Start for|Extracted|Filtered|^\[info\] +[0-9]+: \("
 *
 * 画像は murakamishinji.com のリポジトリの projects/atariar/markers/ にあるもの。
 * Python 版 tools/predict_features.py --self-test と同じケースを使っているので、
 * 両者が同じ答えを出すことも同時に保証される。
 *
 * points = 距離帯ごとの追従点の数（高い dpi から順）
 * counts = レベル0の [Extracted, Filtered]（勾配の極大点／2%足切り後）
 */
(function (root) {
  'use strict';

  // コントラストのある絵。ここは1点の狂いもなく一致しなければならない
  var EXACT = [
    { image: 'satoshi-tomiie-bassline/01.png', dpi: 53, level: 4,
      points: [2, 2, 1, 3, 3, 2, 1, 0, 0, 0], counts: [16, 16] },
    { image: 'satoshi-tomiie-bassline/03.png', dpi: 53, level: 4,
      points: [6, 7, 6, 7, 3, 3, 4, 1, 1, 0, 0, 0], counts: [57, 57] },
    { image: 'x/01.png', dpi: 72, level: 4,
      points: [15, 18, 17, 17, 14, 15, 9, 5, 5, 3, 1, 1, 0, 0, 0], counts: [267, 267] },
    { image: 'emoticons/01.png', dpi: 72, level: 2,
      points: [1, 2, 2, 3, 2, 2, 3, 0, 0, 0, 0, 0, 0], counts: [5, 5] },
    { image: 'pizzaboy/06.png', dpi: 72, level: 3,
      points: [11, 12, 9, 6, 4, 3, 5, 3, 1, 3, 1, 1, 0, 0, 0], counts: [251, 251] },
    { image: 'marslander/02.png', dpi: 96, level: 1,
      points: [5, 9, 7, 4, 6, 4, 4, 2, 2, 1, 1, 1, 0, 0, 0], counts: [251, 251] },
    // dpi=60 は距離帯の計算が truncf の丸めに乗る境目。
    // ここが崩れると縮小画像が1px変わり、下流が全部合わなくなる
    { image: 'pizzaboy/07.png', dpi: 60, level: 4,
      points: [0, 35, 48, 43, 27, 12, 6, 4, 2, 0, 0, 0, 0], counts: [0, 0] },
    { image: 'pizzaboy/04.png', dpi: 40, level: 3,
      points: [5, 7, 9, 6, 4, 2, 2, 0, 0, 0], counts: [38, 38] },
    // 1点も採れない絵（level=0 は厳しすぎる）。0点でも落ちないことの確認
    { image: 'x/02.png', dpi: 72, level: 0,
      points: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], counts: [0, 0] }
  ];

  // のっぺりした絵。生成器は相関を float32 で 2025 画素ぶん足し込むため、
  // 輝度SDが小さい領域（edo/01 の空は SD≒13）で桁落ちして値が 1e-3 ほど動く。
  // こちらの double の方が数学的には正しいので、数%までは許す。
  var TOLERANT = [
    { image: 'edo/01.png', dpi: 72, level: 4,
      points: [164, 128, 85, 48, 28, 21, 14, 11, 5, 2, 2, 0, 0, 0], counts: [49500, 7712] },
    { image: 'edo/01.png', dpi: 72, level: 0,
      points: [14, 10, 10, 6, 2, 1, 1, 1, 1, 1, 1, 0, 0, 0], counts: [49500, 7712] },
    { image: 'emoticons/02.png', dpi: 150, level: 2,
      points: [14, 14, 11, 6, 9, 9, 5, 5, 3, 1, 0, 0, 0, 0, 0], counts: [335, 335] }
  ];

  var API = { EXACT: EXACT, TOLERANT: TOLERANT, TOLERANCE: 0.10 };
  if (typeof module === 'object' && module.exports) module.exports = API;
  else root.Fixtures = API;
})(typeof self !== 'undefined' ? self : this);
