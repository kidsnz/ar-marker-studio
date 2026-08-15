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

  // 探す軸は**拡大率だけ**。
  //
  // -dpi は距離帯を動かすだけで点数を変えない（実測）ので探索に入れない。
  // -level も振らない。**実測で振る意味が無いと分かったため**:
  //   ・品質は level=4 が全条件で勝つ
  //   ・ファイルサイズはほとんど動かない（同じ画像で level 4/3/0 が 83/83/83 KB）。
  //     サイズを決めているのは .fset3 で、そこに -level は効かない
  // 5通り試して1つも勝てない軸のために、かかる時間を5倍にしていた。
  // ブラウザでの生成は 1920x1080 の等倍で 28.6 秒かかる。5倍は致命的だった。
  var SCALES = [1, 2, 3, 4, 6];
  var LEVELS = [4];

  // 採点に使う距離は呼び出し側が渡す（実際にどこから見るかは使う人しか知らない）。
  // 渡されなければ、絵の前に立つ既定（1.2m〜2.2m）で5点。
  var DISTANCES = [1200, 1450, 1700, 1950, 2200];

  // 散らばりの許容幅（マーカー面積に対する割合）。
  // 実測は 1% = 大小に飛ぶ / 17% = ほぼ安定 / 33% = 安定 の3点しかない。
  // これより細かい分解能は持っていないので、5ポイント未満の差は同じとみなす。
  // 実測どうしの間隔（16ポイント）より十分小さいので、区別できると分かっている
  // 状態どうしを取り違えることはない。
  var SPREAD_STEP = 0.05;

  // ファイルサイズの許容幅（KB）。1KB の差で中身の悪い方を選ぶ失敗をしたので入れた。
  var KB_STEP = 10;

  // 拡大後の画素数の上限。6倍は画素数が36倍になるので、大きい絵をそのまま
  // 掛けるとブラウザが落ちる（1600x1200 の6倍で 1.4GB の確保になる）。
  // 1600万画素 = RGBA で 64MB。ここで切って、切ったことは呼び出し側から見えるようにする。
  var MAX_PIXELS = 16e6;

  /**
   * その画像で実際に試せる拡大率だけを返す。
   *
   * **等倍(k=1)は必ず残す。** 上限は「拡大でメモリが破裂しないように」入れたもので、
   * 等倍は新しく確保しないので弾く理由が無い。一度ここを間違えて、
   * 3660万画素の画像で候補が0通りになり「生成が1つも通らなかった」と出していた。
   */
  function usableScales(W, H, scales) {
    return (scales || SCALES).filter(function (k) {
      return k === 1 || W * k * H * k <= MAX_PIXELS;
    });
  }

  /**
   * 元画像が大きすぎないか。
   *
   * トラッカーが見るのは**どんなに大きくても画面上250px程度**。それより上の
   * 距離帯は .iset と .fset3 に入るのに一度も使われない。
   * 実例: 7370x4961 だと距離帯が24段できるが、狙う的に入るのは2段だけで、
   * 残り22段はファイルを膨らませるだけ。生成にも等倍で160秒かかる。
   * @returns {number|null} 縮めたほうがよければ推奨する幅(px)、問題なければ null
   */
  function tooBig(W, H) {
    if (W * H <= 4e6) return null;        // 400万画素までは気にしない
    // 狙う的の上（250px）から2倍ぶんの余裕を見て、1000px あれば十分
    return 1000;
  }

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
  function score(levels, wMm, hMm, region, distances) {
    distances = distances || DISTANCES;
    var profile = [], worst = Infinity, sum = 0, minSpread = Infinity;
    for (var i = 0; i < distances.length; i++) {
      var z = distances[i];
      var ap = Engine.dpiAtDistance(region, z);
      var on = Engine.onCanvas(wMm, hMm, z, region);
      // **画面に写っているぶんだけ**数える。大きい絵は必ずはみ出すので、
      // 隠れている部分の点まで数えると実機と食い違う（2026-08-15 に実測で確認）
      var pts = Engine.selectable(
        Engine.visible(FSet.pointsAt(levels, ap, wMm, hMm, true), on[0], on[1], region));
      var n = pts.length;
      var sp = Engine.spreadArea(pts);
      profile.push({ mm: z, points: n, spread: sp,
                     fits: on[0] <= region[0] && on[1] <= region[1] });
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
   * @param opts {wMm, hMm, region, leveli, scales, levels,
   *              onResult(r), onProgress(done,total),
   *              onStart(scale,level,i,total) いま何を生成し始めたか,
   *              onLog(text) 生成器が吐く進捗（1通りに30秒かかることがあるので要る）,
   *              stopped() true を返すとそこで打ち切る}
   * @returns {Promise<Array>} 全結果
   */
  function search(rgba, W, H, opts) {
    var wMm = opts.wMm, hMm = opts.hMm;
    var region = opts.region || Engine.REGION_PORTRAIT;
    var scales = usableScales(W, H, opts.scales);
    var levels = opts.levels || LEVELS;
    var results = [], total = scales.length * levels.length, done = 0;

    // 拡大した画像は使い回す（同じ倍率で level だけ変えるとき作り直さない）
    var cache = {};

    var chain = Promise.resolve();
    scales.forEach(function (k) {
      levels.forEach(function (lv) {
        chain = chain.then(function () {
          // 中止されていたら、以降は何も生成しない（残りは黙って素通りする）
          if (opts.stopped && opts.stopped()) return;
          if (opts.onStart) opts.onStart(k, lv, done + 1, total);
          if (!cache[k]) cache[k] = upscale(rgba, W, H, k);
          var img = cache[k];
          // 実寸を変えないために dpi も同じ倍率で上げる。
          // 整数に丸めない。画面の入力欄は小数2桁で dpi を出すので、丸めると
          // 「おすすめを適用したのに、生成に使った dpi と欄の数字が違う」ことになる
          var dpi = +(img.W / (wMm / 25.4)).toFixed(2);
          return Generator.generate(img.rgba.slice(), img.W, img.H, {
            dpi: dpi, level: lv, leveli: opts.leveli,
            name: 'tempFilename.png',
            // 1通りに30秒かかることがあるので、生成器の進捗をそのまま外に流す。
            // これが無いと「動いているのか止まっているのか」が分からない
            quiet: !opts.onLog, onLog: opts.onLog
          }).then(function (g) {
            var parsed = FSet.parse(g.fset);
            var r = {
              scale: k, level: lv, dpi: dpi, W: img.W, H: img.H,
              bytes: { fset: g.fset.length, fset3: g.fset3.length, iset: g.iset.length },
              kb: (g.fset.length + g.fset3.length + g.iset.length) / 1024,
              ms: g.ms, files: g, total: parsed ? parsed.total : 0
            };
            if (parsed) {
              var s = score(parsed.levels, wMm, hMm, region, opts.distances);
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
  /**
   * 品質の順。**画面の並べ替えもこれを使う**（UI 側に書き直すと必ずずれる）。
   *   1. 使える距離の数（3点未満は追従が止まるので、ここが崖）
   *   2. その中でいちばん散らばりが小さいところ（姿勢の決まりやすさ）
   *   3. 合計点数（ここまで並んだときの最後の拠り所。これ単独では使わない）
   */
  function better(a, b) {
    return (b.coverage - a.coverage) || (b.spread - a.spread) || (b.sum - a.sum);
  }

  /**
   * 候補の中から、いちばん小さいものと**同じ大きさとみなせる**範囲を取り、
   * その中で中身のいちばん良いものを返す。
   *
   * 刻んだ値（Math.round(kb/10) など）で比べてはいけない。格子の境目が恣意的で、
   * 104KB と 105KB が「別の大きさ」に、100KB と 104KB が「同じ大きさ」になる。
   * 基準を「いちばん小さいもの」に取れば境目は動かない。
   */
  function smallestOf(cands) {
    var min = cands.reduce(function (m, r) { return r.kb < m ? r.kb : m; }, Infinity);
    return cands.filter(function (r) { return r.kb <= min + KB_STEP; })
                .sort(function (a, b) { return better(a, b) || (a.kb - b.kb); })[0];
  }

  function pick(results) {
    if (!results.length) return null;

    // 性能重視。サイズを一切見ないので、細かい差もそのまま拾ってよい。
    var best = results.slice().sort(function (a, b) {
      return better(a, b) || (a.kb - b.kb);
    })[0];

    // バランス。**品質を落とさずに**いちばん小さいもの。
    // 散らばりの許容幅が要る。**持っている根拠は 1% / 17% / 33% の3点だけ**なので、
    // それより細かい差を「良い」と読むのは、測っていないことを測ったことにする行為。
    // これが無いと 1.7% と 1.5% の差で 291KB 大きい方が選ばれ、
    // バランス案が性能案と同じものになってしまう（実際に起きた）。
    var tied = results.filter(function (r) {
      return r.coverage === best.coverage && r.spread >= best.spread - SPREAD_STEP;
    });
    var balanced = smallestOf(tied);

    // サイズ重視。使える距離が1つ減ってもいいから小さいもの。
    var lower = results.filter(function (r) {
      return r.coverage >= Math.max(1, best.coverage - 1);
    });
    var small = smallestOf(lower.length ? lower : results);
    // 候補が広い分だけ、同じ大きさの中でより中身の良い（＝わずかに大きい）ものを
    // 引き当てることがある。バランス案より大きい「サイズ重視」は名前と食い違うので、
    // そうなったらバランス案をそのまま返す（これ以上小さくできない、が正しい答え）
    if (small.kb > balanced.kb) small = balanced;

    return { best: best, balanced: balanced, small: small };
  }

  var API = { SCALES: SCALES, LEVELS: LEVELS, DISTANCES: DISTANCES,
              SPREAD_STEP: SPREAD_STEP, KB_STEP: KB_STEP, MAX_PIXELS: MAX_PIXELS,
              upscale: upscale, usableScales: usableScales, tooBig: tooBig,
              score: score, search: search, pick: pick, better: better };
  if (typeof module === 'object' && module.exports) module.exports = API;
  else root.Search = API;
})(typeof self !== 'undefined' ? self : this);
