/*
 * engine.js — ARToolKit5 の追従点抽出を再現し、マーカーを生成せずに点数を予測する。
 *
 * 再現しているのは次の3つ（詳細は README と docs/algorithm.md）:
 *   ar2GenImageSet    … 距離帯ごとの縮小画像（ブロック平均・整数除算）
 *   ar2GenFeatureMap  … 勾配の極大点だけを候補にして、近傍との最大相関を測る
 *   ar2SelectFeature2 … 相関の低い順に採り、周囲を塗り潰して間隔を空ける
 *
 * 【移植で最も重要なこと】
 * ARToolKit は要所を float(32bit) で計算している。JavaScript の数値は
 * 常に double(64bit) なので、そのまま書くと値がずれる。ずれると
 * 「勾配の極大点」の判定や「距離帯の画素数」が変わり、下流が全部合わなくなる。
 * そのため C が float で計算している箇所は Math.fround() で 1 段ずつ丸めている。
 * ここを省略してはいけない。
 *
 * 逆に相関(NCC)の計算だけは double のままにしてある。本物は float で
 * 2025 画素ぶん足し込むため桁落ちするが、それは本物側の誤差であり、
 * double の方が数学的に正しい（Python 版 tools/predict_features.py と同じ方針）。
 *
 * ブラウザ（Worker）でも Node でも動く。Node からは module.exports で使う。
 */
(function (root) {
  'use strict';

  var f32 = Math.fround;

  // --- ARToolKit5 の定数（include/AR2/config.h） ---
  var TS = 22;                  // AR2_DEFAULT_TS1(11) × AR2_TEMP_SCALE(2)
  var TN = TS * 2 + 1;          // テンプレートは 45×45
  var SEARCH1 = 10;             // 近傍探索の外側（21×21 の正方形。円ではない）
  var SEARCH2 = 2;              // 内側（半径2の円板は除外 → ドーナツ状）
  var MAX_SIM_THRESH2 = 0.95;   // featureMap 生成時の打ち切り。変更不可
  var SD_THRESH2 = 5.0;         // 同上
  var NEAR_MAX_LIMIT = 0.99;    // 「1〜2pxずらしても同じ」なら却下。ハードコード
  var FEATURE_RATIO = 0.02;     // 勾配の極大点のうち上位2%だけを候補にする
  var KPM_MINIMUM_IMAGE_SIZE = 28;

  // -level が変えるのはこの4つだけ [max_thresh, min_thresh, sd_thresh, occ_size]
  var LEVELS = {
    0: [0.80, 0.70, 12.0, 24],
    1: [0.85, 0.65, 10.0, 24],
    2: [0.90, 0.55, 8.0, 16],   // 生成器の既定
    3: [0.98, 0.45, 6.0, 16],
    4: [0.98, 0.45, 6.0, 12]
  };

  // ARnft が実際に画像処理する領域（ARnft.js の prepareImage が 320 固定）
  var REGION_LANDSCAPE = [320, 240];   // 横持ち
  var REGION_PORTRAIT = [180, 240];    // 縦持ち: 左右に黒帯が入り実効180px
  var GOOD = 12, POOR = 5;             // 実機の体感と対応させた判定の目安

  /** C の lroundf（0から遠い方へ丸める） */
  function lroundf(x) {
    return x >= 0 ? Math.floor(x + 0.5) : -Math.floor(-x + 0.5);
  }

  // ------------------------------------------------------------------
  // 画像の読み込み
  // ------------------------------------------------------------------
  /**
   * ImageData（RGBA）から、生成器が使うのと同じ白黒画像を作る。
   * 生成器は r==g==b の画像を「グレースケール」と見て R だけを使い、
   * そうでなければ (r+g+b)/3 を整数除算で取る。
   */
  function toBW(rgba, W, H) {
    var gray = true, i, p;
    for (i = 0; i < W * H; i++) {
      p = i * 4;
      if (rgba[p] !== rgba[p + 1] || rgba[p] !== rgba[p + 2]) { gray = false; break; }
    }
    var hasAlpha = false;
    for (i = 0; i < W * H; i++) { if (rgba[i * 4 + 3] !== 255) { hasAlpha = true; break; } }

    var bw = new Uint8Array(W * H);
    for (i = 0; i < W * H; i++) {
      p = i * 4;
      bw[i] = gray ? rgba[p] : ((rgba[p] + rgba[p + 1] + rgba[p + 2]) / 3) | 0;
    }
    return { bw: bw, nc: gray ? 1 : 3, hasAlpha: hasAlpha };
  }

  // ------------------------------------------------------------------
  // 距離帯（ar2GenImageSet / genTexData の setDPI）
  // ------------------------------------------------------------------
  /**
   * 距離帯の dpi 一覧を返す（高い dpi＝原寸が先頭）。
   *
   * 最小 dpi は「短辺が 28px まで縮む」ところ。そこから 2^(1/3) 倍ずつ上げる。
   *
   * 【罠】最小 dpi の計算は C ではこうなっている:
   *     truncf( (28.0f / 短辺) * dpi * 1000.0 ) / 1000.0f
   * `* 1000.0` は double の定数なので途中まで double で進むが、truncf の引数は
   * float なので、そこで丸め上がってから切り捨てられる。
   * 520×400・dpi=60 だと 4199.9998 が 4200.0 に丸め上がって 4.2 になる。
   * double のまま切り捨てると 4.199 になり、以降の距離帯が全部 0.02% ずれ、
   * 縮小画像の高さが 1px 変わって下流が全部合わなくなる。
   */
  function dpiLevels(W, H, dpi) {
    dpi = f32(dpi);
    var ratio = f32(f32(f32(KPM_MINIMUM_IMAGE_SIZE) / f32(Math.min(W, H))) * dpi);
    var dpiMin = f32(Math.trunc(f32(ratio * 1000.0)) / 1000.0);
    if (dpiMin === dpi) return [dpiMin];

    var step = f32(Math.pow(2, f32(1 / 3)));
    var limit = f32(dpi * f32(0.95));
    var w = dpiMin, num = 1;
    for (;;) {
      w = f32(w * step);
      if (w >= limit) break;
      num++;
    }
    num++;

    var out = [];
    w = dpiMin;
    for (var i = 0; i < num; i++) {
      out.push(w);
      w = f32(w * step);
      if (w >= limit) w = dpi;
    }
    return out.reverse();
  }

  /** ar2GenImageLayer2: ブロック平均で縮小する（平均は整数除算で切り捨て） */
  function scaleImage(src, W, H, srcDpi, dstDpi) {
    srcDpi = f32(srcDpi); dstDpi = f32(dstDpi);
    var wx = lroundf(f32(f32(W * dstDpi) / srcDpi));
    var wy = lroundf(f32(f32(H * dstDpi) / srcDpi));

    function bounds(n, limit) {
      var s = new Int32Array(n), e = new Int32Array(n);
      for (var i = 0; i < n; i++) {
        s[i] = lroundf(f32(f32(i * srcDpi) / dstDpi));
        e[i] = Math.min(lroundf(f32(f32((i + 1) * srcDpi) / dstDpi)) - 1, limit - 1);
      }
      return [s, e];
    }
    var bx = bounds(wx, W), by = bounds(wy, H);

    // 積分画像でブロック和を O(1) にする
    var ii = new Float64Array((W + 1) * (H + 1));
    for (var y = 0; y < H; y++) {
      var row = 0;
      for (var x = 0; x < W; x++) {
        row += src[y * W + x];
        ii[(y + 1) * (W + 1) + x + 1] = ii[y * (W + 1) + x + 1] + row;
      }
    }

    var out = new Uint8Array(wx * wy);
    for (var j = 0; j < wy; j++) {
      var y0 = by[0][j], y1 = by[1][j] + 1;
      for (var i2 = 0; i2 < wx; i2++) {
        var x0 = bx[0][i2], x1 = bx[1][i2] + 1;
        var sum = ii[y1 * (W + 1) + x1] - ii[y0 * (W + 1) + x1]
                - ii[y1 * (W + 1) + x0] + ii[y0 * (W + 1) + x0];
        out[j * wx + i2] = (sum / ((y1 - y0) * (x1 - x0))) | 0;   // 整数除算
      }
    }
    return { bw: out, W: wx, H: wy };
  }

  /** 各距離帯の有効範囲 (mindpi, maxdpi)。生成器が .fset に書く値と同じ */
  function bandRanges(dpis) {
    return dpis.map(function (d) {
      var lower = dpis.filter(function (x) { return x < d; });
      var upper = dpis.filter(function (x) { return x > d; });
      return {
        mindpi: lower.length ? Math.max.apply(null, lower) : d * 0.5,
        maxdpi: upper.length ? d * 0.8 + Math.min.apply(null, upper) * 0.2 : d * 2.0
      };
    });
  }

  // ------------------------------------------------------------------
  // featureMap（ar2GenFeatureMap）
  // ------------------------------------------------------------------
  /** 積分画像を作る（(W+1)×(H+1)） */
  function integral(src, W, H) {
    var out = new Float64Array((W + 1) * (H + 1));
    for (var y = 0; y < H; y++) {
      var row = 0;
      for (var x = 0; x < W; x++) {
        row += src[y * W + x];
        out[(y + 1) * (W + 1) + x + 1] = out[y * (W + 1) + x + 1] + row;
      }
    }
    return out;
  }

  /** (x,y) を左上とする TN×TN の和 */
  function boxAt(ii, W, x, y) {
    return ii[(y + TN) * (W + 1) + x + TN] - ii[y * (W + 1) + x + TN]
         - ii[(y + TN) * (W + 1) + x] + ii[y * (W + 1) + x];
  }

  /**
   * 候補画素を絞り込む。**ここが点数を決める最大の関門**。
   *
   * 全画素の相関を計算するわけではない。まず勾配を取り、4近傍すべてより大きい
   * 画素だけを残し（Extracted）、さらにその中で強い順に画像の2%以内に収まる分
   * だけを候補にする（Filtered）。ここで落ちた画素は二度と特徴点にならない。
   */
  function gradientCandidates(bw, W, H) {
    var g = new Float32Array(W * H);
    g.fill(-1);                                    // 外周は -1（＝対象外）
    for (var y = 1; y < H - 1; y++) {
      for (var x = 1; x < W - 1; x++) {
        var p = y * W + x;
        // C は int で差を取ってから float で割る
        var sx = (bw[p - W + 1] - bw[p - W - 1]) + (bw[p + 1] - bw[p - 1])
               + (bw[p + W + 1] - bw[p + W - 1]);
        var sy = (bw[p + W + 1] - bw[p - W + 1]) + (bw[p + W] - bw[p - W])
               + (bw[p + W - 1] - bw[p - W - 1]);
        var dx = f32(sx / 768);                    // 3.0f * 256
        var dy = f32(sy / 768);
        g[p] = f32(Math.sqrt(f32(f32(f32(dx * dx) + f32(dy * dy)) / 2)));
      }
    }

    // 4近傍の極大点（strict >）
    var hist = new Int32Array(1000);
    var nms = [];
    for (var y2 = 1; y2 < H - 1; y2++) {
      for (var x2 = 1; x2 < W - 1; x2++) {
        var q = y2 * W + x2, v = g[q];
        if (v > g[q - 1] && v > g[q + 1] && v > g[q - W] && v > g[q + W]) {
          nms.push(q);
          var b = Math.trunc(f32(v * 1000));       // C も float のまま掛ける
          hist[b > 999 ? 999 : (b < 0 ? 0 : b)]++;
        }
      }
    }

    // 強い順に積んで、画素数の2%に達したところで足切り
    var acc = 0, k = -1;
    for (var i = 999; i >= 0; i--) {
      acc += hist[i];
      if (acc / (W * H) >= FEATURE_RATIO) { k = i; break; }
    }
    return {
      g: g, nms: nms, k: k,
      extracted: nms.length,
      filtered: k >= 0 ? acc : nms.length
    };
  }

  /**
   * ar2GenFeatureMap の再現。
   * featureMap の値は「半径2より外・半径10以内（21×21の正方形から半径2の円板を
   * くり抜いたドーナツ）にある、いちばん似ている場所との相関」。小さいほど良い。
   */
  function featureMap(bw, W, H) {
    var N = TN * TN;
    var I = new Float64Array(W * H);
    var sq = new Float64Array(W * H);
    for (var i = 0; i < W * H; i++) { I[i] = bw[i]; sq[i] = bw[i] * bw[i]; }
    var iI = integral(I, W, H), iQ = integral(sq, W, H);

    var gc = gradientCandidates(bw, W, H);

    // テンプレートが画像内に収まり、コントラストが足りる候補だけ残す
    var cand = [], sumOf = new Float64Array(W * H), varOf = new Float64Array(W * H);
    for (var n = 0; n < gc.nms.length; n++) {
      var p = gc.nms[n];
      if (Math.trunc(f32(gc.g[p] * 1000)) < gc.k) continue;
      var y = (p / W) | 0, x = p % W;
      if (y < TS || y >= H - TS || x < TS || x >= W - TS) continue;
      var s = boxAt(iI, W, x - TS, y - TS), qq = boxAt(iQ, W, x - TS, y - TS);
      var v = qq - s * s / N;
      if (v <= 0 || v / N < SD_THRESH2 * SD_THRESH2) continue;
      sumOf[p] = s; varOf[p] = v; cand.push(p);
    }

    var best = new Float64Array(W * H);
    best.fill(-1);
    var active = cand.slice();
    if (!cand.length) {
      return { cand: cand, best: best, sumOf: sumOf, varOf: varOf,
               iI: iI, iQ: iQ, I: I, extracted: gc.extracted, filtered: gc.filtered };
    }

    // 候補が実際にある範囲だけを計算する。
    // 相関の分子は積分画像の「差」で取るので、箱の外を 0 とみなしても
    // 引き算で打ち消されて値は変わらない（差分だけを見るため）。
    // 候補が固まっている絵ではここで数倍速くなる。
    var minY = H, maxY = 0, minX = W, maxX = 0;
    for (var ci = 0; ci < cand.length; ci++) {
      var cy2 = (cand[ci] / W) | 0, cx2 = cand[ci] % W;
      if (cy2 < minY) minY = cy2;
      if (cy2 > maxY) maxY = cy2;
      if (cx2 < minX) minX = cx2;
      if (cx2 > maxX) maxX = cx2;
    }
    var r0 = Math.max(0, minY - TS - SEARCH1), r1 = Math.min(H, maxY + TS + 1 + SEARCH1);
    var c0 = Math.max(0, minX - TS - SEARCH1), c1 = Math.min(W, maxX + TS + 1 + SEARCH1);

    var prod = new Float64Array(W * H);
    var iP = new Float64Array((W + 1) * (H + 1));

    // ドーナツ状の全オフセットを、C と同じ順（jj 外・ii 内）で回す
    for (var dy = -SEARCH1; dy <= SEARCH1 && active.length; dy++) {
      for (var dx = -SEARCH1; dx <= SEARCH1 && active.length; dx++) {
        if (dx * dx + dy * dy <= SEARCH2 * SEARCH2) continue;
        // P = I × (dx,dy) ずらした I。この積分画像から相関の分子が O(1) で出る
        for (var yy = r0; yy < r1; yy++) {
          var ra = yy * W, sy2 = yy + dy;
          if (sy2 < 0 || sy2 >= H) {
            for (var xz = c0; xz < c1; xz++) prod[ra + xz] = 0;
            continue;
          }
          var rb = sy2 * W + dx;
          for (var xx = c0; xx < c1; xx++) {
            var sx2 = xx + dx;
            prod[ra + xx] = (sx2 >= 0 && sx2 < W) ? I[ra + xx] * I[rb + xx] : 0;
          }
        }
        // 箱の中だけの積分画像（上端・左端は 0 から積み直す）
        for (var xz2 = c0; xz2 <= c1; xz2++) iP[r0 * (W + 1) + xz2] = 0;
        for (var yz = r0; yz < r1; yz++) {
          var acc = 0, rowA = yz * (W + 1), rowB = (yz + 1) * (W + 1), rowP = yz * W;
          iP[rowB + c0] = 0;
          for (var xw = c0; xw < c1; xw++) {
            acc += prod[rowP + xw];
            iP[rowB + xw + 1] = iP[rowA + xw + 1] + acc;
          }
        }

        var next = [];
        for (var a = 0; a < active.length; a++) {
          var pp = active[a];
          var py = (pp / W) | 0, px = pp % W, ny = py + dy, nx = px + dx;
          if (ny >= TS && ny < H - TS && nx >= TS && nx < W - TS) {
            var s2 = boxAt(iI, W, nx - TS, ny - TS);
            var q2 = boxAt(iQ, W, nx - TS, ny - TS);
            var v2 = q2 - s2 * s2 / N;
            if (v2 > 0) {
              var sxy = boxAt(iP, W, px - TS, py - TS) - sumOf[pp] * s2 / N;
              var ncc = sxy / Math.sqrt(varOf[pp] * v2);
              if (ncc > best[pp]) best[pp] = ncc;
            }
          }
          // 0.95 を超えたら本物もそこで打ち切る（記録値は真の最大とは限らない）
          if (best[pp] <= MAX_SIM_THRESH2) next.push(pp);
        }
        active = next;
      }
    }

    return {
      cand: cand, best: best, sumOf: sumOf, varOf: varOf, iI: iI, iQ: iQ, I: I,
      extracted: gc.extracted, filtered: gc.filtered
    };
  }

  /**
   * ±2px（半径2の円板、中心を除く12点）との相関の最小・最大。
   * 最大が 0.99 を超える画素は「1〜2pxずらしても同じに見える」ので却下される。
   * 横線ばかりの絵はここで大量に落ちる。
   */
  function nearStats(fm, W, H, p) {
    var N = TN * TN, I = fm.I;
    var y = (p / W) | 0, x = p % W;
    var s = fm.sumOf[p], va = fm.varOf[p], ave = s / N;
    var mn = 1, mx = -1;
    for (var dy = -SEARCH2; dy <= SEARCH2; dy++) {
      for (var dx = -SEARCH2; dx <= SEARCH2; dx++) {
        if ((dx === 0 && dy === 0) || dx * dx + dy * dy > SEARCH2 * SEARCH2) continue;
        var ny = y + dy, nx = x + dx;
        if (ny < TS || ny >= H - TS || nx < TS || nx >= W - TS) continue;
        var s2 = boxAt(fm.iI, W, nx - TS, ny - TS);
        var q2 = boxAt(fm.iQ, W, nx - TS, ny - TS);
        var v2 = q2 - s2 * s2 / N;
        if (v2 <= 0) continue;
        var sxy = 0;
        for (var j = -TS; j <= TS; j++) {
          var ra = (y + j) * W + x - TS, rb = (ny + j) * W + nx - TS;
          for (var i = 0; i < TN; i++) sxy += (I[ra + i] - ave) * I[rb + i];
        }
        var ncc = sxy / Math.sqrt(va * v2);
        if (ncc < mn) mn = ncc;
        if (ncc > mx) mx = ncc;
      }
    }
    return { min: mn, max: mx, sd: Math.sqrt(va / N) };
  }

  /**
   * ar2SelectFeature2 の再現。相関の低い順に採り、周囲 occ_size×2 を塗り潰す。
   * 却下された画素はその1点だけが無効になる（周囲は塗り潰さない）ので、
   * 却下の条件は画素ごとに独立に先に判定してよい。
   */
  function selectFeatures(fm, W, H, level) {
    var L = LEVELS[level];
    var maxT = L[0], minT = L[1], sdT = L[2], occ = L[3] * 2;
    var div = TN * 3;
    var maxFeatureNum = ((W / occ) | 0) * ((H / occ) | 0) + ((W / div) | 0) * ((H / div) | 0);

    var usable = [], val = {};
    for (var i = 0; i < fm.cand.length; i++) {
      var p = fm.cand[i];
      var st = nearStats(fm, W, H, p);
      if (st.sd < sdT) continue;
      if (st.max > NEAR_MAX_LIMIT) continue;
      if (st.min < minT && st.min < fm.best[p]) continue;
      if (!(fm.best[p] < maxT)) continue;
      usable.push(p);
      val[p] = { v: fm.best[p], sd: st.sd, min: st.min, max: st.max };
    }

    var taken = new Uint8Array(W * H);
    var points = [];
    var pool = usable.slice();
    while (points.length < maxFeatureNum) {
      var bp = -1, bv = maxT;
      for (var a = 0; a < pool.length; a++) {
        var q = pool[a];
        if (!taken[q] && val[q].v < bv) { bv = val[q].v; bp = q; }
      }
      if (bp < 0) break;
      var by = (bp / W) | 0, bx = bp % W;
      points.push({ x: bx, y: by, v: bv, sd: val[bp].sd });
      for (var b = 0; b < pool.length; b++) {
        var r = pool[b];
        if (Math.abs(((r / W) | 0) - by) <= occ && Math.abs((r % W) - bx) <= occ) taken[r] = 1;
      }
    }
    return { points: points, maxFeatureNum: maxFeatureNum, usable: usable, occ: occ };
  }

  // ------------------------------------------------------------------
  // 予測（全距離帯）
  // ------------------------------------------------------------------
  /**
   * 画像から全距離帯の追従点を予測する。
   * onProgress(現在, 全体) を渡すと進捗を報告する。
   */
  function predict(bw0, W0, H0, opts) {
    opts = opts || {};
    var dpi = opts.dpi || 72, level = opts.level == null ? 4 : opts.level;
    var dpis = dpiLevels(W0, H0, dpi);
    var bands = bandRanges(dpis);
    var out = [];

    for (var i = 0; i < dpis.length; i++) {
      var img = i === 0 ? { bw: bw0, W: W0, H: H0 }
                        : scaleImage(bw0, W0, H0, dpis[0], dpis[i]);
      if (opts.onProgress) opts.onProgress(i, dpis.length, img.W, img.H, dpis[i]);
      var fm = featureMap(img.bw, img.W, img.H);
      var sel = selectFeatures(fm, img.W, img.H, level);
      out.push({
        index: i, dpi: dpis[i], mindpi: bands[i].mindpi, maxdpi: bands[i].maxdpi,
        W: img.W, H: img.H, bw: img.bw,
        points: sel.points, maxFeatureNum: sel.maxFeatureNum, occ: sel.occ,
        extracted: fm.extracted, filtered: fm.filtered,
        // ヒートマップ用（重い配列は持たず、候補の位置と値だけ残す）
        cand: Int32Array.from(fm.cand),
        candVal: Float64Array.from(fm.cand.map(function (p) { return fm.best[p]; })),
        usable: Int32Array.from(sel.usable)
      });
    }
    if (opts.onProgress) opts.onProgress(dpis.length, dpis.length);
    return { bands: out, W: W0, H: H0, dpi: dpi, level: level };
  }

  // ------------------------------------------------------------------
  // 判定（parse_fset.py と同じ基準）
  // ------------------------------------------------------------------
  /** マーカーが処理領域に収まって写るときの見かけ dpi */
  function apparentDpi(wMm, hMm, region) {
    return Math.min(region[0] / (wMm / 25.4), region[1] / (hMm / 25.4));
  }

  /** 見かけ dpi ap のとき、実際に使える追従点の数（帯をまたぐので合算する） */
  function usablePoints(bands, ap) {
    return bands.reduce(function (s, b) {
      return s + (b.mindpi <= ap && ap <= b.maxdpi ? b.points.length : 0);
    }, 0);
  }

  function verdict(n) { return n >= GOOD ? '安定' : (n >= POOR ? '不足ぎみ' : '暴れる'); }

  /** 予測結果に、実寸と持ち方から見た判定を足す */
  function evaluate(result, sizeMm) {
    var natW = result.W / result.dpi * 25.4, natH = result.H / result.dpi * 25.4;
    var k = sizeMm ? sizeMm / natW : 1;
    var wMm = natW * k, hMm = natH * k;
    var r = {
      widthMm: wMm, heightMm: hMm,
      total: result.bands.reduce(function (s, b) { return s + b.points.length; }, 0)
    };
    [['portrait', REGION_PORTRAIT], ['landscape', REGION_LANDSCAPE]].forEach(function (e) {
      var ap = apparentDpi(wMm, hMm, e[1]);
      r[e[0]] = { dpi: ap, points: usablePoints(result.bands, ap) };
      r[e[0]].verdict = verdict(r[e[0]].points);
    });
    return r;
  }

  /** 見かけ dpi がその距離帯に入る band の番号。無ければいちばん近いもの */
  function bandForDpi(bands, ap) {
    for (var i = 0; i < bands.length; i++) {
      if (bands[i].mindpi <= ap && ap <= bands[i].maxdpi) return i;
    }
    var best = 0;
    for (var j = 1; j < bands.length; j++) {
      if (Math.abs(bands[j].dpi - ap) < Math.abs(bands[best].dpi - ap)) best = j;
    }
    return best;
  }

  var Engine = {
    TS: TS, TN: TN, LEVELS: LEVELS,
    REGION_PORTRAIT: REGION_PORTRAIT, REGION_LANDSCAPE: REGION_LANDSCAPE,
    GOOD: GOOD, POOR: POOR,
    toBW: toBW, dpiLevels: dpiLevels, scaleImage: scaleImage, bandRanges: bandRanges,
    featureMap: featureMap, selectFeatures: selectFeatures, predict: predict,
    evaluate: evaluate, apparentDpi: apparentDpi, usablePoints: usablePoints,
    verdict: verdict, bandForDpi: bandForDpi
  };

  if (typeof module === 'object' && module.exports) module.exports = Engine;
  else root.Engine = Engine;
})(typeof self !== 'undefined' ? self : this);
