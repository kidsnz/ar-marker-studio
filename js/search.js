/*
 * search.js — 拡大率 × level を総当たりして、最適な生成設定を見つける。
 *
 * 【なぜ予測ではなく実生成で探すのか】
 * 当初は「生成せずに予測する」ことが売りだったが、実測すると生成の方が速かった。
 *   予測（engine.js 相当）… 1倍 1.25秒 / 2倍 3.24秒 / 4倍 8.91秒
 *   実生成               … 1倍 0.36秒 / 2倍 0.73秒 / 4倍 1.31秒
 * しかも実生成なら**正確な点数とファイルサイズが両方**手に入る。
 * 予測の出番は「絵のどこが弱いか」を見せるヒートマップ（そこは実生成では出せない）。
 *
 * 【なぜ拡大が効くのか】
 * 追従点の採否は「±10画素ずらして似ていないか」で決まり、この10画素は固定値。
 * Atari の絵は繰り返しの周期が10画素より短いので、元のサイズでは区別できない。
 * 2倍にすると周期が2倍に伸びて区別できるようになる。
 * **情報は増えていない。ものさしに対する絵の大きさが変わっただけ。**
 * 拡大は必ずニアレストネイバー（なめらかに拡大するとエッジが鈍って逆効果。実測済み）。
 * -dpi も同じ倍率で上げる。忘れると宣言される実寸が変わって距離帯が全部ずれる。
 *
 * 【大きいほど良い、ではない】実測（satoshi/01、使う距離での最悪値と合計）
 *   2倍 最悪2/合計23/178KB、3倍 最悪2/合計29/320KB、
 *   4倍 最悪2/合計27/391KB、6倍 最悪2/合計26/611KB
 * 3倍が頂点で、それ以上はファイルだけ膨らむ。だから総当たりで探す価値がある。
 */
(function (root) {
  'use strict';

  // 探す軸。ガイド第5章の実測で「効く」と確認できたものだけ。
  // -dpi は距離帯を動かすだけで点数を変えない（実測）ので探索に入れない。
  var SCALES = [1, 2, 3, 4, 6];
  var LEVELS = [4, 2, 3, 1, 0];   // 実測で level=4 が全条件で勝ったので先に試す

  // 判定に使う「マーカーが画面に占める割合」。1.0 = 見えている幅いっぱい。
  var FILL = [1.0, 0.85, 0.7, 0.55, 0.45, 0.35];

  /** ニアレストネイバーで整数倍に拡大する（なめらかにしてはいけない） */
  function upscale(rgba, W, H, k) {
    if (k === 1) return { rgba: rgba, W: W, H: H };
    var W2 = W * k, H2 = H * k;
    var out = new Uint8ClampedArray(W2 * H2 * 4);
    for (var y = 0; y < H2; y++) {
      var sy = (y / k) | 0;
      for (var x = 0; x < W2; x++) {
        var s = (sy * W + ((x / k) | 0)) * 4, d = (y * W2 + x) * 4;
        out[d] = rgba[s]; out[d + 1] = rgba[s + 1];
        out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3];
      }
    }
    return { rgba: out, W: W2, H: H2 };
  }

  /**
   * 生成結果を採点する。
   *
   * 点数だけでは足りない。追従は最初の4点で四角形を作り、その面積が大きいほど
   * 姿勢が決まる（ar2SelectTemplate）。同じ3点でも、固まっているのと散っているのでは
   * 別物。実測: 散らばり 1% は大小に飛び、17% はほぼ安定、33% は安定。
   *
   * ただし**追従が成立しない距離（3点未満）では散らばりに意味が無い**ので、
   * 3点以上ある距離だけを見る。
   *
   * @param levels FSet.parse の結果の levels
   * @param wMm,hMm マーカーの実寸
   * @param region 検出に使える領域 [幅px, 高さpx]
   */
  function score(levels, wMm, hMm, region) {
    var full = Engine.apparentDpi(wMm, hMm, region);
    var profile = [], worst = Infinity, sum = 0, minSpread = Infinity;
    for (var i = 0; i < FILL.length; i++) {
      var ap = full * FILL[i];
      var n = FSet.usablePoints(levels, ap);
      var pts = Engine.selectable(FSet.pointsAt(levels, ap, wMm, hMm, true));
      var sp = Engine.spreadArea(pts);
      profile.push({ fill: FILL[i], points: n, spread: sp });
      sum += n;
      if (n < worst) worst = n;
      // 追従が成立している距離だけで、いちばん散らばりが小さいところを見る
      if (n >= Engine.TRACK_MIN && sp < minSpread) minSpread = sp;
    }
    // 追従が成立した距離の数。**3点は崖であって連続量ではない**（切ると追従が止まる）。
    // なので「点数の最小値」より「使える距離がいくつあるか」で比べる方が実態に近い。
    var coverage = profile.filter(function (p) {
      return p.points >= Engine.TRACK_MIN;
    }).length;
    return {
      profile: profile, coverage: coverage, worst: worst, sum: sum,
      spread: minSpread === Infinity ? 0 : minSpread,
      points: profile.map(function (p) { return p.points; })
    };
  }

  /**
   * 総当たりで探す。結果は出た順に onResult で返す（待たせないため）。
   *
   * @param rgba,W,H 元画像
   * @param opts {wMm, hMm, region, leveli, scales, levels, onResult(r), onProgress(done,total)}
   * @returns {Promise<Array>} 全結果
   */
  function search(rgba, W, H, opts) {
    var wMm = opts.wMm, hMm = opts.hMm;
    var region = opts.region || Engine.REGION_PORTRAIT;
    var scales = opts.scales || SCALES;
    var levels = opts.levels || LEVELS;
    var results = [], total = scales.length * levels.length, done = 0;

    // 拡大した画像は使い回す（同じ倍率で level だけ変えるとき作り直さない）
    var cache = {};

    var chain = Promise.resolve();
    scales.forEach(function (k) {
      levels.forEach(function (lv) {
        chain = chain.then(function () {
          if (!cache[k]) cache[k] = upscale(rgba, W, H, k);
          var img = cache[k];
          // 実寸を変えないために dpi も同じ倍率で上げる
          var dpi = Math.round(img.W / (wMm / 25.4));
          return Generator.generate(img.rgba.slice(), img.W, img.H, {
            dpi: dpi, level: lv, leveli: opts.leveli,
            name: 'tempFilename.png', quiet: true
          }).then(function (g) {
            var parsed = FSet.parse(g.fset);
            var r = {
              scale: k, level: lv, dpi: dpi, W: img.W, H: img.H,
              bytes: { fset: g.fset.length, fset3: g.fset3.length, iset: g.iset.length },
              kb: (g.fset.length + g.fset3.length + g.iset.length) / 1024,
              ms: g.ms, files: g, total: parsed ? parsed.total : 0
            };
            if (parsed) {
              var s = score(parsed.levels, wMm, hMm, region);
              r.profile = s.profile; r.worst = s.worst;
              r.coverage = s.coverage; r.points = s.points;
              r.sum = s.sum; r.spread = s.spread;
              r.bands = parsed.levels.length;
            } else {
              r.profile = []; r.coverage = 0; r.points = [];
              r.worst = 0; r.sum = 0; r.spread = 0; r.bands = 0;
            }
            results.push(r);
            done++;
            if (opts.onResult) opts.onResult(r, results);
            if (opts.onProgress) opts.onProgress(done, total);
          }).catch(function (err) {
            done++;
            if (opts.onProgress) opts.onProgress(done, total, err);
          });
        });
      });
    });
    return chain.then(function () { return results; });
  }

  /**
   * 3つのおすすめを選ぶ。
   *
   *  性能重視 … 最悪値が最大。同点なら合計が最大。サイズは見ない
   *  バランス … **最悪値は性能重視と同じまま**、いちばん小さいもの
   *  サイズ重視 … 一段落ちてもいいから、いちばん小さいもの
   *
   * 「合計点数が最大」で選んではいけない。合計は使わない距離帯の点まで足した数で、
   * 実際に使うのは1つの帯だけ。実測では合計92点の設定が、合計38点の設定に
   * どの距離でも負けていた。**困るのは調子が悪いときなので、最悪値で比べる。**
   */
  function pick(results) {
    if (!results.length) return null;

    // ファイルサイズは 10KB 刻みで比べる。1KB の差で中身の悪い方を選ばないように。
    function bucket(kb) { return Math.round(kb / 10); }

    // 品質の順。
    //   1. 使える距離の数（3点未満は追従が止まるので、ここが崖）
    //   2. その中でいちばん散らばりが小さいところ（姿勢の決まりやすさ）
    //   3. 合計点数
    function better(a, b) {
      return (b.coverage - a.coverage) || (b.spread - a.spread) || (b.sum - a.sum);
    }
    var best = results.slice().sort(function (a, b) {
      return better(a, b) || (a.kb - b.kb);
    })[0];

    // 品質を落とさずに、いちばん小さいもの
    var tied = results.filter(function (r) {
      return r.coverage === best.coverage && r.spread >= best.spread * 0.9;
    });
    var balanced = tied.slice().sort(function (a, b) {
      return (bucket(a.kb) - bucket(b.kb)) || better(a, b) || (a.kb - b.kb);
    })[0];

    // 使える距離が1つ減ってもいいから小さいもの。
    // **同じくらいの大きさなら中身の良い方**を採る（10KB 刻みで比べる理由）
    var lower = results.filter(function (r) {
      return r.coverage >= Math.max(1, best.coverage - 1);
    });
    var small = (lower.length ? lower : results).slice().sort(function (a, b) {
      return (bucket(a.kb) - bucket(b.kb)) || better(a, b) || (a.kb - b.kb);
    })[0];

    return { best: best, balanced: balanced, small: small };
  }

  var API = { SCALES: SCALES, LEVELS: LEVELS, FILL: FILL,
              upscale: upscale, score: score, search: search, pick: pick };
  if (typeof module === 'object' && module.exports) module.exports = API;
  else root.Search = API;
})(typeof self !== 'undefined' ? self : this);
