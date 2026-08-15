/*
 * app.js — 画面まわり。重い計算は js/worker.js（別スレッド）に投げる。
 *
 * 流れ: 画像を読む → 実寸から dpi を出す → 予測（Worker）→ 判定表 →
 *       ヒートマップ → 生成（vendor の本物の生成器）
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  // 自分の <script src="js/app.js?v=14"> から版数を取り、Worker にも同じものを付ける。
  // **これが無いと ?v= を上げても Worker の中身が古いまま残る。**
  // index.html の ?v= は <script> と <link> にしか効かず、
  // new Worker() と、その中の importScripts() は素の URL で取りに行くため
  var VER = (function () {
    var src = (document.currentScript && document.currentScript.src) || '';
    var m = src.match(/[?&]v=([^&]+)/);
    return m ? '?v=' + m[1] : '';
  })();
  // generate.js は自分で版数を知りようがないので、ここから渡す
  self.AMS_VER = VER;

  // 動的に組み立てる文字列の英語原本。日本語は js/i18n.js が持つ
  self.I18N_EN = self.I18N_EN || {};
  var EN = {
    'meta.size': 'Pixels',
    'meta.color': 'Colour',
    'meta.format': 'Format',
    'meta.gray': 'greyscale (r=g=b)',
    'meta.rgb': 'colour → converted with (r+g+b)/3',
    'meta.png': 'PNG (decoded here, so values match the generator exactly)',
    'meta.jpeg': 'JPEG (decoded by canvas; values differ slightly from the generator)',
    'meta.scale': 'Upscaled',
    'meta.scaleV': '{k}× nearest-neighbour (source was {w}×{h})',

    // --- 3. 自動探索 ---
    'search.progress': 'Generating and scoring… {i}/{n}',
    'search.took': 'Tried {n} combinations in {s}s. Every number below is measured, not predicted.',
    'search.none': 'Nothing could be generated, so there is nothing to recommend.',
    'search.failed': '{d} of the {n} could not be generated and are left out.',
    'search.doing': 'Generating {k}\u00d7 ({i}/{n})\u2026 {s}s',
    'search.left': 'about {t} left',
    'search.etaSec': '{s}s',
    'search.etaMin': '{m} min',
    'search.stopped': 'Stopped after {n} of {total}. The recommendations below use what was finished.',
    'search.skipped': 'Not tried: {list}, because upscaling would push the image past '
      + '{mp} megapixels and the browser would run out of memory.',
    'search.region': 'Scored for a phone held upright ({w}×{h} effective), the same basis as the verdict below.',
    'pick.best': 'Best tracking',
    'pick.balanced': 'Balanced',
    'pick.small': 'Smallest',
    'pick.set': '{k}× / -level={lv} / -dpi={dpi}   ({w}×{h})',
    'pick.size': '{kb} KB in total   (.fset {f} / .fset3 {f3} / .iset {i} KB)',
    'pick.profileNote': 'Tracking points by how much of the frame the marker fills:',
    'why.best': 'Usable at {c} of the {n} distances, spread {s}%. The best of the {tried} tried.',
    'why.balanced': 'Same {c}/{n} distances as the best one, spread {s}% against its {s2}%, {d} KB smaller.',
    'why.balanced.eq': 'Same {c}/{n} distances and the same {s}% spread as the best one, {d} KB smaller.',
    'why.balanced.same': 'Nothing smaller holds that quality, so this is the balanced choice too.',
    'why.small': 'Gives up one distance ({c}/{n}) to save {d} KB against the balanced choice.',
    'why.small.eq': 'Same {c}/{n} distances but spread {s}% instead of {s2}%, {d} KB smaller.',
    'why.small.same': 'Nothing smaller was worth taking, so the balanced choice is also the smallest.',
    'btn.use': 'Use these settings',
    'pick.applied': 'Applied. The working image is now {k}× and -dpi/-level are filled in. '
      + 'The three files are generated already, so the buttons above download them as they are.',

    'res.portrait': 'Held upright ({w}×{h}px usable)',
    'res.portrait.short': 'upright',
    'res.apparent': 'apparent {n} dpi →',
    'res.points': 'points',
    'res.summary': 'Source {w}×{h} / -dpi={dpi} / -level={level} → printed {mw}×{mh} mm',
    'res.skipped': '{n} of the {total} distance bands were not computed: they are only reached '
      + 'when the marker is larger than the screen. They are still in the generated .fset. '
      + 'Skipping them is what keeps this fast — measured on a 1920×1080 image, they were '
      + '12.0s of the 12.2s.',
    'res.usedBy': 'this is the band actually used',
    'verdict.stable': 'stable',
    'verdict.marginal': 'marginal',
    'verdict.limit': 'on the edge',
    'verdict.cannot': 'cannot track',
    'res.detail': '{sel} of them can actually be picked / spread {spread}% / {fb} with the runtime fallback',
    'res.floor': 'Tracking stops below {n} points, so one lost point ends it.',
    'res.provisional': '<strong>"stable" and "marginal" are provisional.</strong> The {good} and {poor} point thresholds were calibrated against the same ~181px width this tool now uses, so they carry over — but the device notes they came from contain a contradiction that is still open: a marker written down as steady works out at 2 points under the stock letterbox model, below the {floor}-point floor where tracking stops outright. Only that {floor}-point floor comes from the source (tracking.c) rather than from how something felt.',
    'res.cap': 'Only {n} points are tried per frame, so more than that buys little. Spread matters more than count.',
    'res.spreadNote': 'Spread is the area the points enclose, as a share of the marker. '
      + 'The tracker picks its first four points to maximise exactly this. '
      + 'Measured on real devices: 1% jumps around, 17% mostly stable, 33% stable.',
    'res.basis': 'ARnft processes the camera image on a fixed 320×240 canvas (hardcoded in '
      + 'ARnft.js prepareImage). Held upright, ARnft-rot turns the video 90° so the marker '
      + 'gets 240×320 of that canvas instead of the 180×240 the stock letterbox leaves. '
      + 'On top of that, `object-fit: cover` keeps about a quarter of the video off-screen, '
      + 'so what is actually usable is 181×320. apparent dpi = min(effective width px ÷ '
      + 'marker width in inches, effective height px ÷ marker height in inches).',
    'progress.band': 'Band {i}/{n} ({w}×{h}, {dpi}dpi)…',
    'progress.prep': 'Preparing…',
    'progress.final': 'Finishing…',
    'tbl.rangeFmt': '{min} to {max}',
    'hm.opt': '{i}: {dpi} dpi ({w}×{h}, {n} pts)',
    'hm.note': 'Valid range {min} to {max} dpi / {cand} candidate pixels, {usable} of them usable'
      + ' / {n} points selected (cap {max2})',
    'gen.loading': 'Loading the generator… (about 1MB, first time only)',
    'gen.running': 'Generating… {t}',
    'gen.done': 'Done in {s}s. Keep all three files in the same folder.',
    'gen.match': 'Prediction matched the real output across all {n} bands.',
    'gen.mismatch': 'Prediction differed in {d} of {n} bands (actual: [{got}]). '
      + 'On flat artwork the generator\'s own rounding can shift things by a few percent.',
    'gen.actual': 'Actual .fset: [{got}]',
    'err.image': 'Could not read the image: {m}',
    'err.dpi': 'That dpi is not valid',
    'err.calc': 'Calculation failed: {m}',
    'err.gen': 'Generation failed: {m}',
    'tbl.detect': 'Detection',
    'det.note': 'Detection keypoints come from the generated .fset3. A band with 0 cannot be '
      + 'recognised at all at that distance, no matter how many tracking points it has. '
      + '"It never recognises" and "it recognises but wobbles" are different problems.',
    'det.summary': 'Detection keypoints in the band actually used: {n}',
    'det.none': 'The band actually used has no detection keypoints, so it cannot be recognised there',
    'dist.range': 'Stable between {min} and {max} ({n}+ points)',
    'dist.rangeMin': 'Tracks at all between {min} and {max} ({n}+ points)',
    'dist.rangeOne': 'Stable only at {min} ({n}+ points)',
    'dist.rangeOneMin': 'Tracks at all only at {min} ({n}+ points)',
    'dist.none': 'Never reaches {n} points at any distance',
    'dist.overflow': 'marker runs off the frame',
    'dist.patchy': 'The count does not fall off smoothly with distance, because the bands '
      + 'overlap unevenly. This is the longest continuous stretch; there are {n} separate '
      + 'stretches in total.'
  };
  Object.keys(EN).forEach(function (k) {
    if (self.I18N_EN[k] == null) self.I18N_EN[k] = EN[k];
  });
  var t = function (k, v) { return I18N.t(k, v); };
  // rgba/W/H は「いま作業している画像」。おすすめを適用すると拡大版に差し替わる。
  // orig は読み込んだそのままの画像で、拡大の元は必ずこちらを使う
  // （作業中の画像を拡大すると、2回適用したときに倍率が掛け算になってしまう）
  var state = { rgba: null, W: 0, H: 0, name: 'marker', isPNG: true,
                orig: null, scale: 1, result: null, detect: null };

  // ------------------------------------------------------------------
  // 1. 画像を読む
  // ------------------------------------------------------------------
  var drop = $('drop'), fileInput = $('file');

  drop.addEventListener('click', function () { fileInput.click(); });
  drop.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  ['dragenter', 'dragover'].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) {
    if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', function () {
    if (fileInput.files.length) loadFile(fileInput.files[0]);
  });

  function loadFile(file) {
    state.name = file.name.replace(/\.[^.]+$/, '') || 'marker';
    var isPNG = /\.png$/i.test(file.name) || file.type === 'image/png';
    file.arrayBuffer().then(function (buf) {
      // PNG は自前で読む（canvas はカラープロファイルで画素値を変えることがあり、
      // それだと生成器と数値が食い違うため）
      if (isPNG) return PNGReader.decode(buf);
      return decodeViaCanvas(file);
    }).then(function (img) {
      state.rgba = img.data; state.W = img.width; state.H = img.height;
      state.orig = { rgba: img.data, W: img.width, H: img.height };
      state.scale = 1;
      state.isPNG = isPNG;
      state.detect = null;              // 画像を変えたら前の検出結果は捨てる
      clearSearch();                    // 前の画像で探した結果も捨てる
      showImage();
      // 画像が入ったら、判定 → 最適設定の探索まで自動で走らせる。
      // 押させる意味が無いし、探索は時間がかかるので少しでも早く始めたい
      runPredict(true);
    }).catch(function (err) {
      alert(t('err.image', { m: err.message }));
    });
  }

  /** JPEG など、自前で読まない形式は canvas に任せる */
  function decodeViaCanvas(file) {
    return createImageBitmap(file).then(function (bmp) {
      var c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      var d = ctx.getImageData(0, 0, bmp.width, bmp.height);
      return { width: bmp.width, height: bmp.height, data: d.data };
    });
  }

  function showImage() {
    var cv = $('preview');
    cv.width = state.W; cv.height = state.H;
    var id = new ImageData(new Uint8ClampedArray(state.rgba), state.W, state.H);
    cv.getContext('2d').putImageData(id, 0, 0);

    var info = Engine.toBW(state.rgba, state.W, state.H);
    $('imgmeta').innerHTML =
      row(t('meta.size'), state.W + ' × ' + state.H)
      + (state.scale > 1
          ? row(t('meta.scale'), t('meta.scaleV', { k: state.scale,
                                                    w: state.orig.W, h: state.orig.H }))
          : '')
      + row(t('meta.color'), t(info.nc === 1 ? 'meta.gray' : 'meta.rgb'))
      + row(t('meta.format'), t(state.isPNG ? 'meta.png' : 'meta.jpeg'));
    $('imginfo').hidden = false;
    $('alpha-warn').hidden = !info.hasAlpha;

    $('step-config').hidden = false;
    $('step-search').hidden = false;
    $('name').value = state.name;
    syncDpiFromMm();
    // 作業中の画像が変わったので、前の判定は消す（step-distance の消し忘れがあった）
    ['step-result', 'step-distance', 'step-heatmap', 'step-generate']
      .forEach(function (s) { $(s).hidden = true; });
  }

  function row(k, v) { return '<dt>' + k + '</dt><dd>' + v + '</dd>'; }

  // ------------------------------------------------------------------
  // 2. 実寸 ⇄ dpi
  // ------------------------------------------------------------------
  function syncDpiFromMm() {
    var mm = parseFloat($('size-mm').value);
    if (mm > 0 && state.W) $('dpi').value = (state.W / (mm / 25.4)).toFixed(2);
  }
  function syncMmFromDpi() {
    var dpi = parseFloat($('dpi').value);
    if (dpi > 0 && state.W) $('size-mm').value = (state.W / dpi * 25.4).toFixed(0);
  }
  $('size-mm').addEventListener('input', syncDpiFromMm);
  $('dpi').addEventListener('input', syncMmFromDpi);
  Array.prototype.forEach.call(document.querySelectorAll('button.mm'), function (b) {
    b.addEventListener('click', function () {
      $('size-mm').value = b.dataset.mm;
      syncDpiFromMm();
    });
  });

  // ------------------------------------------------------------------
  // 3. 自動探索 — 拡大率 × level を総当たりし、**実際に生成して**比べる
  //
  // 予測ではなく実生成で探す。実測で生成の方が速く（1倍 0.36秒 / 4倍 1.31秒）、
  // しかも正確な点数とファイルサイズが同時に手に入る。
  // 拡大の元は必ず state.orig（読み込んだそのままの画像）を使う。
  // ------------------------------------------------------------------
  var search = { results: null, picks: null, cards: null, skipped: [],
                 running: false, stop: false, left: null };

  function clearSearch() {
    search = { results: null, picks: null, cards: null, skipped: [],
               running: false, stop: false, left: null };
    $('picks').innerHTML = '';
    $('picks').hidden = true;
    $('search-note').hidden = true;
    $('search-all').hidden = true;
    $('search-stop').hidden = true;
    $('search-progress').textContent = '';
  }

  function pct(x) { return (x * 100).toFixed(1); }
  function toKb(bytes) { return (bytes / 1024).toFixed(1); }

  $('search-run').addEventListener('click', function () { runSearch(); });
  $('search-stop').addEventListener('click', function () {
    search.stop = true;
    $('search-stop').disabled = true;
  });

  /** 「あと何分」を、いま測った時間だけから出す。モデルは持たない */
  function eta(msLeft) {
    var s = Math.round(msLeft / 1000);
    return s >= 60 ? t('search.etaMin', { m: Math.ceil(s / 60) })
                   : t('search.etaSec', { s: s });
  }

  function runSearch() {
    if (!state.orig || search.running) return;
    var mm = parseFloat($('size-mm').value);
    if (!(mm > 0)) { alert(t('err.dpi')); return; }

    var o = state.orig;
    var hMm = mm * o.H / o.W;
    var scales = Search.usableScales(o.W, o.H);
    var skipped = Search.SCALES.filter(function (k) { return scales.indexOf(k) < 0; });
    var total = scales.length * Search.LEVELS.length;

    clearSearch();
    search.skipped = skipped;
    search.running = true;
    search.stop = false;
    $('search-run').disabled = true;
    $('search-stop').disabled = false;
    $('search-stop').hidden = false;
    // 生成ワーカーは1つしかないので取り合わせない。押せない理由は画面に出す
    $('gen').disabled = true;
    $('gen-blocked').hidden = false;

    // 1通りに30秒以上かかることがある（1920x1080 の等倍で実測 28.6秒）。
    // n/N だけでは止まって見えるので、いま何を生成しているか・経過・見込みを出す
    var t0 = Date.now(), curStart = t0, cur = null, perScale = {}, ticker = null;

    function paint(extra) {
      if (!cur) return;
      var el = Math.round((Date.now() - curStart) / 1000);
      var line = t('search.doing', { k: cur.k, i: cur.i, n: cur.n, s: el });
      // 1通り終わっていれば、そこから残りの見込みが出せる
      if (search.left != null) line += '　' + t('search.left', { t: eta(search.left) });
      if (extra) line += '　' + extra;
      $('search-progress').textContent = line;
    }

    Search.search(o.rgba, o.W, o.H, {
      wMm: mm, hMm: hMm,
      leveli: parseInt($('leveli').value, 10),
      scales: scales,
      stopped: function () { return search.stop; },
      onStart: function (k, lv, i, n) {
        cur = { k: k, i: i, n: n };
        curStart = Date.now();
        paint();
        if (!ticker) ticker = setInterval(paint, 1000);
      },
      onLog: function (line) { paint(line.slice(0, 60)); },
      onProgress: function (done) {
        // 残りの見込みを、済んだ倍率の実測から出す。
        // **単純平均にしてはいけない。** 拡大率が上がると画素数は2乗で増えるので、
        // 1倍の実測をそのまま当てると2倍を4分の1に見積もってしまう。
        // 生成時間は画素数に比例もしない。実測2点
        //   72,960px → 4.4秒 ／ 2,073,600px → 28.6秒
        // から log(6.5)/log(28.4) = 0.56 乗で伸びる。丸めて 0.6 を使う
        if (cur) perScale[cur.k] = (Date.now() - curStart) / Math.pow(cur.k * cur.k, 0.6);
        var per = Object.keys(perScale).map(function (k) { return perScale[k]; });
        var unit = per.reduce(function (a, b) { return a + b; }, 0) / per.length;
        search.left = scales.slice(done).reduce(function (sum, k) {
          return sum + unit * Math.pow(k * k, 0.6);
        }, 0);
      }
    }).then(function (results) {
      var msg = search.stop
        ? t('search.stopped', { n: results.length, total: total })
        : t('search.took', { n: results.length,
                             s: ((Date.now() - t0) / 1000).toFixed(1) });
      // 生成が通らなかったものがあれば黙って落とさず、いくつ落ちたか言う
      if (!search.stop && results.length < total) {
        msg += '　' + t('search.failed', { d: total - results.length, n: total });
      }
      $('search-progress').textContent = msg;
      search.results = results;
      search.picks = Search.pick(results);   // 途中で止めても、出た分から選ぶ
      showPicks();
    }).catch(function (err) {
      $('search-progress').textContent = '';
      alert(t('err.gen', { m: err.message }));
    }).then(function () {
      if (ticker) clearInterval(ticker);
      search.running = false;
      $('search-run').disabled = false;
      $('search-stop').hidden = true;
      $('gen').disabled = false;
      $('gen-blocked').hidden = true;
    });
  }

  function showPicks() {
    var p = search.picks;
    if (!p) {
      $('search-note').textContent = t('search.none');
      $('search-note').hidden = false;
      return;
    }
    // 同じ設定が2役を兼ねることがある（よくある）ので、まとめて1枚の札にする
    var cards = [];
    [['pick.best', p.best], ['pick.balanced', p.balanced], ['pick.small', p.small]]
      .forEach(function (e) {
        var hit = null;
        cards.forEach(function (c) { if (c.r === e[1]) hit = c; });
        if (hit) hit.roles.push(e[0]);
        else cards.push({ r: e[1], roles: [e[0]] });
      });
    search.cards = cards;

    $('picks').innerHTML = cards.map(cardHtml).join('');
    $('picks').hidden = false;

    var notes = [t('search.region', { w: Math.round(Engine.REGION_PORTRAIT[0]),
                                      h: Math.round(Engine.REGION_PORTRAIT[1]) })];
    if (search.skipped.length) {
      notes.push(t('search.skipped', {
        list: search.skipped.map(function (k) { return k + '×'; }).join(', '),
        mp: Math.round(Search.MAX_PIXELS / 1e6),      // 英語は megapixel
        man: Math.round(Search.MAX_PIXELS / 1e4)      // 日本語は万画素
      }));
    }
    $('search-note').textContent = notes.join('　');
    $('search-note').hidden = false;

    showAllResults();
    $('search-all').hidden = false;
  }

  function cardHtml(c, i) {
    var r = c.r;
    return '<div class="pick">'
      + '<h3>' + c.roles.map(function (k) { return t(k); }).join(' / ') + '</h3>'
      + '<p class="pick-set">' + t('pick.set', { k: r.scale, lv: r.level,
                                                 dpi: r.dpi, w: r.W, h: r.H }) + '</p>'
      + c.roles.map(function (k) {
          return '<p class="pick-why">' + reasonFor(k, r) + '</p>';
        }).join('')
      + '<p class="pick-size">' + t('pick.size', {
          kb: r.kb.toFixed(0), f: toKb(r.bytes.fset),
          f3: toKb(r.bytes.fset3), i: toKb(r.bytes.iset) }) + '</p>'
      + '<p class="hint">' + t('pick.profileNote') + '</p>'
      + profileHtml(r)
      + '<p class="row pick-actions">'
      + '<button type="button" data-card="' + i + '" data-act="use">' + t('btn.use') + '</button>'
      + ['fset', 'fset3', 'iset'].map(function (ext) {
          return '<button type="button" data-card="' + i + '" data-act="' + ext + '">▼ .'
            + ext + '</button>';
        }).join('')
      + '</p>'
      + '<p class="hint applied" hidden></p>'
      + '</div>';
  }

  /**
   * なぜその設定が選ばれたのかを1行で書く。
   * **数字はすべてこの画像で実際に測った値**。一般論は書かない。
   */
  function reasonFor(role, r) {
    var p = search.picks, n = Search.FILL.length;
    if (role === 'pick.best') {
      return t('why.best', { c: r.coverage, n: n, s: pct(r.spread),
                             tried: search.results.length });
    }
    if (role === 'pick.balanced') {
      if (r === p.best) return t('why.balanced.same');
      var same = pct(r.spread) === pct(p.best.spread);
      return t(same ? 'why.balanced.eq' : 'why.balanced', {
        c: r.coverage, n: n, s: pct(r.spread), s2: pct(p.best.spread),
        d: Math.round(p.best.kb - r.kb) });
    }
    // pick.small
    if (r === p.balanced) return t('why.small.same');
    if (r.coverage === p.balanced.coverage) {
      return t('why.small.eq', { c: r.coverage, n: n, s: pct(r.spread),
                                 s2: pct(p.balanced.spread),
                                 d: Math.round(p.balanced.kb - r.kb) });
    }
    return t('why.small', { c: r.coverage, n: n,
                            d: Math.round(p.balanced.kb - r.kb) });
  }

  /** 「マーカーが画面幅の何割を占めるか」ごとの追従点。3点未満は追従が止まる */
  function profileHtml(r) {
    return '<div class="profile">' + r.profile.map(function (q) {
      return '<span class="' + (q.points >= Engine.TRACK_MIN ? 'v-good' : 'v-bad') + '">'
        + '<b>' + q.points + '</b><i>' + Math.round(q.fill * 100) + '%</i></span>';
    }).join('') + '</div>';
  }

  /** 試したものを全部出す。黙って切り捨てない */
  function showAllResults() {
    var p = search.picks;
    var rows = search.results.slice().sort(function (a, b) {
      return Search.better(a, b) || (a.kb - b.kb);
    });
    $('search-table').querySelector('tbody').innerHTML = rows.map(function (r) {
      var roles = [];
      if (r === p.best) roles.push(t('pick.best'));
      if (r === p.balanced) roles.push(t('pick.balanced'));
      if (r === p.small) roles.push(t('pick.small'));
      return '<tr class="' + (roles.length ? 'used' : '') + '">'
        + '<td>' + r.scale + '×</td>'
        + '<td>' + r.level + '</td>'
        + '<td>' + r.dpi + '</td>'
        + '<td>' + r.W + '×' + r.H + '</td>'
        + '<td>' + r.coverage + '/' + Search.FILL.length + '</td>'
        + '<td>' + r.points.map(function (v) {
            return '<span class="' + (v >= Engine.TRACK_MIN ? '' : 'v-bad') + '">'
              + v + '</span>';
          }).join(' ') + '</td>'
        + '<td>' + pct(r.spread) + '%</td>'
        + '<td>' + r.kb.toFixed(0) + ' KB'
        + (roles.length ? ' <span class="tag">' + roles.join(' / ') + '</span>' : '')
        + '</td></tr>';
    }).join('');
  }

  // 札のボタンは後から作るので、まとめて受ける
  $('picks').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!b || !search.cards) return;
    var card = search.cards[+b.dataset.card];
    if (!card) return;
    if (b.dataset.act === 'use') applyPick(card, b);
    else Generator.download(card.r.files[b.dataset.act],
                            fileBase() + '.' + b.dataset.act);
  });

  function fileBase() {
    return ($('name').value || state.name || 'marker').replace(/[^\w.-]/g, '_');
  }

  /**
   * おすすめの設定を実際に反映する。
   * 拡大は**必ず元画像から**やる（作業中の画像から拡大すると倍率が掛け算になる）。
   */
  function applyPick(card, btn) {
    var r = card.r, o = state.orig;
    var up = Search.upscale(o.rgba, o.W, o.H, r.scale);
    state.rgba = up.rgba; state.W = up.W; state.H = up.H;
    state.scale = r.scale;
    state.result = null;
    state.detect = null;
    $('level').value = r.level;
    showImage();            // プレビューと画素数を描き直し、dpi を実寸から入れ直す
    // 生成に使った dpi をそのまま入れる（実寸からの計算と一致するはずだが、
    // 一致させること自体が大事なので明示的に入れ直す）
    $('dpi').value = r.dpi;

    Array.prototype.forEach.call($('picks').querySelectorAll('.applied'), function (el) {
      el.hidden = true;
    });
    var note = btn.closest('.pick').querySelector('.applied');
    note.textContent = t('pick.applied', { k: r.scale });
    note.hidden = false;
    runPredict(false);      // 反映した設定での判定をそのまま見せる
  }

  // ------------------------------------------------------------------
  // 4. 予測を走らせる
  // ------------------------------------------------------------------
  var worker = null;

  $('run').addEventListener('click', function () { runPredict(); });

  /**
   * 品質判定（予測）を走らせる。
   * @param andSearch true なら、終わったあと続けて最適設定の探索まで自動で始める
   */
  function runPredict(andSearch) {
    if (!state.rgba) return;
    var dpi = parseFloat($('dpi').value), level = parseInt($('level').value, 10);
    if (!(dpi > 0)) { alert(t('err.dpi')); return; }

    $('run').disabled = true;
    $('progress').textContent = t('progress.prep');

    var bw = Engine.toBW(state.rgba, state.W, state.H).bw;
    if (worker) worker.terminate();
    worker = new Worker('js/worker.js' + VER);
    worker.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'progress') {
        $('progress').textContent = m.i >= m.n ? t('progress.final')
          : t('progress.band', { i: m.i + 1, n: m.n, w: m.w, h: m.h,
                                 dpi: m.dpi.toFixed(1) });
      } else if (m.type === 'done') {
        $('progress').textContent = '';
        $('run').disabled = false;
        state.result = m.result;
        showResult();
        // 画像を入れたときは、判定に続けて探索まで自動で走らせる
        if (andSearch) runSearch();
      } else if (m.type === 'error') {
        $('progress').textContent = '';
        $('run').disabled = false;
        alert(t('err.calc', { m: m.message }));
      }
    };
    // 計算する距離帯の上限。
    // マーカーが画面いっぱいに写るときの見かけ dpi の2倍まで見る。
    // 2倍 = 画面の2倍の大きさに写るまで寄った状態で、距離表のいちばん近い行より
    // さらに近い。それより上の帯は**使えないうえに、いちばん重い**
    // （実測 1920x1080: 予測12.2秒のうち12.0秒がその帯）
    var mmW = parseFloat($('size-mm').value) || 305;
    var maxDpi = Engine.apparentDpi(mmW, mmW * state.H / state.W,
                                    Engine.REGION_PORTRAIT) * 2;

    // bw はコピーせず所有権ごと渡す（元は使い終わっている）
    worker.postMessage({ bw: bw, W: state.W, H: state.H, dpi: dpi, level: level,
                         maxDpi: maxDpi },
                       [bw.buffer]);
  }

  // ------------------------------------------------------------------
  // 5. 判定を表示する
  // ------------------------------------------------------------------
  function vClass(n) {
    return n >= Engine.GOOD ? 'v-good' : (n >= Engine.POOR ? 'v-mid' : 'v-bad');
  }

  function vText(n) { return t('verdict.' + Engine.verdict(n)); }

  function showResult() {
    var r = state.result;
    var mm = parseFloat($('size-mm').value);
    var ev = Engine.evaluate(r, mm);

    $('verdicts').innerHTML =
      '<p class="hint">' + t('res.summary', {
        w: r.W, h: r.H, dpi: +r.dpi.toFixed(2), level: r.level,
        mw: ev.widthMm.toFixed(0), mh: ev.heightMm.toFixed(0)
      }) + '</p>'
      + verdictRow('res.portrait', Engine.REGION_PORTRAIT, ev.portrait)
      + '<p class="warn">' + t('res.provisional', { good: Engine.GOOD, poor: Engine.POOR,
                                                    floor: Engine.TRACK_MIN }) + '</p>'
      + '<p class="hint">' + t('res.spreadNote') + '</p>';

    var max = Math.max.apply(null, r.bands.map(function (b) { return b.points.length; })) || 1;
    var tb = $('bands').querySelector('tbody');
    tb.innerHTML = r.bands.map(function (b, i) {
      // 実際に使う帯かどうかだけ印を付ける（縦持ちで判定する）
      var used = b.mindpi <= ev.portrait.dpi && ev.portrait.dpi <= b.maxdpi;
      var det = state.detect && state.detect.levels[i];
      return '<tr class="' + (used ? 'used' : '') + '">'
        + '<td>' + i + '</td>'
        + '<td>' + b.W + '×' + b.H + '</td>'
        + '<td>' + b.points.length + '</td>'
        + (state.detect
            ? '<td class="' + (det && det.count ? '' : 'v-bad') + '">'
              + (det ? det.count : '-') + '</td>'
            : '')
        + '<td><span class="bar" style="width:' + (b.points.length / max * 100) + '%"></span>'
        + (used ? '<span class="tag">' + t('res.usedBy') + '</span>' : '')
        + '</td></tr>';
    }).join('');

    // 検出列の見出しは、生成後にだけ出す
    var headRow = $('bands').querySelector('thead tr');
    var detTh = headRow.querySelector('.det-col');
    if (state.detect && !detTh) {
      var th = document.createElement('th');
      th.className = 'det-col';
      th.textContent = t('tbl.detect');
      headRow.insertBefore(th, headRow.lastElementChild);
    } else if (!state.detect && detTh) {
      detTh.remove();
    }

    $('basis').textContent = t('res.basis');
    // 計算を飛ばした帯があるなら、黙って落とさずその場で言う
    if (r.skipped) {
      $('basis').textContent += '  ' + t('res.skipped', { n: r.skipped,
                                                          total: r.bandsTotal });
    }
    if (state.detect) {
      var n = 0;
      r.bands.forEach(function (b, i) {
        var d = state.detect.levels[i];
        if (d && b.mindpi <= ev.portrait.dpi && ev.portrait.dpi <= b.maxdpi) n += d.count;
      });
      $('basis').textContent += '  ' + t(n ? 'det.summary' : 'det.none', { n: n })
                              + '  ' + t('det.note');
    }

    var sel = $('band');
    sel.innerHTML = r.bands.map(function (b, i) {
      return '<option value="' + i + '">'
        + t('hm.opt', { i: i, dpi: b.dpi.toFixed(1), w: b.W, h: b.H, n: b.points.length })
        + '</option>';
    }).join('');
    sel.value = Engine.bandForDpi(r.bands, ev.portrait.dpi);
    sel.onchange = drawHeatmap;

    showDistances(ev);
    ['step-result', 'step-distance', 'step-heatmap', 'step-generate']
      .forEach(function (s) { $(s).hidden = false; });
    $('name').value = state.name;
    drawHeatmap();
  }

  function verdictRow(labelKey, region, d) {
    var note = '';
    if (d.points < Engine.POOR) {
      note = '<div class="note v-bad">' + t('res.floor', { n: Engine.TRACK_MIN }) + '</div>';
    } else if (d.points > Engine.TRACK_PER_FRAME) {
      note = '<div class="note">' + t('res.cap', { n: Engine.TRACK_PER_FRAME }) + '</div>';
    }
    return '<div class="verdict">'
      + '<span>' + t(labelKey, { w: Math.round(region[0]),
                                 h: Math.round(region[1]) }) + '</span>'
      + '<span class="hint">' + t('res.apparent', { n: d.dpi.toFixed(1) }) + '</span>'
      + '<span class="n ' + vClass(d.points) + '">' + d.points + '</span>'
      + '<span class="' + vClass(d.points) + '">' + t('res.points') + '</span>'
      + '<span class="' + vClass(d.points) + '">' + vText(d.points) + '</span></div>'
      + '<div class="subrow">' + t('res.detail', {
          sel: d.selectable, spread: (d.spread * 100).toFixed(1), fb: d.fallback
        }) + '</div>'
      + note;
  }

  // ------------------------------------------------------------------
  // 5-b. 使える距離
  // ------------------------------------------------------------------
  var DISTANCES_MM = [300, 500, 1000, 1500, 2000];

  function fmtMm(mm) {
    return mm >= 1000 ? (mm / 1000).toFixed(mm % 1000 ? 1 : 0) + 'm'
                      : Math.round(mm / 10) + 'cm';
  }

  function showDistances(ev) {
    var r = state.result;
    var wMm = ev.widthMm, hMm = ev.heightMm;
    var pt = Engine.distanceTable(r.bands, Engine.REGION_PORTRAIT, wMm, hMm, DISTANCES_MM);

    $('dist-summary').innerHTML = [
      [Engine.REGION_PORTRAIT]
    ].map(function (e) {
      var good = Engine.usableRange(r.bands, e[0], wMm, hMm, Engine.GOOD);
      var any = Engine.usableRange(r.bands, e[0], wMm, hMm, Engine.TRACK_MIN);
      var use = good || any, key = good ? 'dist.range' : 'dist.rangeMin';
      // 幅が無いときに「52cm 〜 52cm」と出ると壊れて見える
      if (use && use.min === use.max) key = good ? 'dist.rangeOne' : 'dist.rangeOneMin';
      var cls = good ? 'v-good' : 'v-mid';
      if (!use) {
        return '<div class="v-bad">' + t('dist.none', { n: Engine.GOOD }) + '</div>';
      }
      var line = '<div class="' + cls + '">' + t(key, {
        min: fmtMm(use.min), max: fmtMm(use.max),
        n: good ? Engine.GOOD : Engine.TRACK_MIN }) + '</div>';
      if (use.segments > 1) {
        line += '<div class="subrow">' + t('dist.patchy', { n: use.segments }) + '</div>';
      }
      return line;
    }).join('');

    $('dist').querySelector('tbody').innerHTML = DISTANCES_MM.map(function (z, i) {
      var a = pt[i];
      return '<tr class="' + (a.points >= Engine.GOOD ? 'used' : '') + '">'
        + '<td>' + fmtMm(z) + '</td>'
        + '<td class="' + vClass(a.points) + '">' + a.points + '</td>'
        + '<td>' + (a.fits ? '' : '<span class="tag">' + t('dist.overflow') + '</span>')
        + '</td></tr>';
    }).join('');
  }

  function drawHeatmap() {
    var i = parseInt($('band').value, 10);
    var b = state.result.bands[i];
    Heatmap.draw([$('hm0'), $('hm1'), $('hm2')], b);
    $('band-note').textContent = t('hm.note', {
      min: b.mindpi.toFixed(1), max: b.maxdpi.toFixed(1),
      cand: b.cand.length, usable: b.usable.length,
      n: b.points.length, max2: b.maxFeatureNum
    });
  }

  // ------------------------------------------------------------------
  // 6. 生成
  // ------------------------------------------------------------------
  $('gen').addEventListener('click', function () {
    if (!state.rgba) return;
    var name = ($('name').value || 'marker').replace(/[^\w.-]/g, '_');
    $('gen').disabled = true;
    $('genresult').hidden = true;
    $('genstat').textContent = t('gen.loading');

    Generator.generate(state.rgba, state.W, state.H, {
      dpi: parseFloat($('dpi').value),
      level: parseInt($('level').value, 10),
      leveli: parseInt($('leveli').value, 10),
      name: name,
      onLog: function (line) { $('genstat').textContent = t('gen.running', { t: line }); }
    }).then(function (out) {
      $('genstat').textContent = '';
      $('gen').disabled = false;
      $('genresult').hidden = false;
      $('gensummary').textContent = t('gen.done', { s: (out.ms / 1000).toFixed(1) });
      // 生成できたので検出側（.fset3）も読んで、距離帯の表に足す
      try {
        state.detect = FSet3.parse(out.fset3);
        if (state.detect) showResult();
      } catch (e) { state.detect = null; }
      var links = $('genlinks');
      links.innerHTML = '';
      [['fset', out.fset], ['fset3', out.fset3], ['iset', out.iset]].forEach(function (e) {
        links.appendChild(Generator.linkFor(e[1], name + '.' + e[0]));
      });
      $('gencheck').textContent = check(out.fset);
    }).catch(function (err) {
      $('genstat').textContent = '';
      $('gen').disabled = false;
      alert(t('err.gen', { m: err.message }));
    });
  });

  /** 生成された .fset を読んで、予測と合っていたかを確かめる */
  // 言語を切り替えたら、動的に組み立てた部分も描き直す
  self.onI18nChange = function () {
    if (state.rgba) showImage();
    if (search.picks) showPicks();
    if (state.result) showResult();
  };

  I18N.init();

  function check(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var n = dv.getInt32(0, true), off = 4, got = [];
    for (var i = 0; i < n; i++) {
      got.push(dv.getInt32(off + 12, true));
      off += 16 + dv.getInt32(off + 12, true) * 20;
    }
    var want = state.result.bands.map(function (b) { return b.points.length; });
    if (got.length !== want.length) return t('gen.actual', { got: got });
    var diff = got.reduce(function (a, g, i) { return a + (g === want[i] ? 0 : 1); }, 0);
    return diff === 0
      ? t('gen.match', { n: got.length })
      : t('gen.mismatch', { d: diff, n: got.length, got: got });
  }
})();
