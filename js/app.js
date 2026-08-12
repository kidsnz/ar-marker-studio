/*
 * app.js — 画面まわり。重い計算は js/worker.js（別スレッド）に投げる。
 *
 * 流れ: 画像を読む → 実寸から dpi を出す → 予測（Worker）→ 判定表 →
 *       ヒートマップ → 生成（vendor の本物の生成器）
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

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
    'res.portrait': 'Held upright ({px}px effective)',
    'res.landscape': 'Held sideways ({px}px effective)',
    'res.portrait.short': 'upright',
    'res.landscape.short': 'sideways',
    'res.apparent': 'apparent {n} dpi →',
    'res.points': 'points',
    'res.summary': 'Source {w}×{h} / -dpi={dpi} / -level={level} → printed {mw}×{mh} mm'
      + '  /  {total} tracking points in total',
    'res.usedBy': 'used when held {who}',
    'verdict.stable': 'stable',
    'verdict.marginal': 'marginal',
    'verdict.limit': 'on the edge',
    'verdict.cannot': 'cannot track',
    'res.detail': '{sel} of them can actually be picked / spread {spread}% / {fb} with the runtime fallback',
    'res.floor': 'Tracking stops below {n} points, so one lost point ends it.',
    'res.cap': 'Only {n} points are tried per frame, so more than that buys little. Spread matters more than count.',
    'res.spreadNote': 'Spread is the area the points enclose, as a share of the marker. '
      + 'The tracker picks its first four points to maximise exactly this. '
      + 'Measured on real devices: 1% jumps around, 17% mostly stable, 33% stable.',
    'res.basis': 'ARnft processes the camera image at a fixed 320×240 (hardcoded in '
      + 'ARnft.js prepareImage). Held upright the video is letterboxed, leaving 180×240 '
      + 'effective. apparent dpi = min(effective width px ÷ marker width in inches, '
      + '240 ÷ marker height in inches).',
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
    'err.gen': 'Generation failed: {m}'
  };
  Object.keys(EN).forEach(function (k) {
    if (self.I18N_EN[k] == null) self.I18N_EN[k] = EN[k];
  });
  var t = function (k, v) { return I18N.t(k, v); };
  var state = { rgba: null, W: 0, H: 0, name: 'marker', isPNG: true, result: null };

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
      state.isPNG = isPNG;
      showImage();
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
      + row(t('meta.color'), t(info.nc === 1 ? 'meta.gray' : 'meta.rgb'))
      + row(t('meta.format'), t(state.isPNG ? 'meta.png' : 'meta.jpeg'));
    $('imginfo').hidden = false;
    $('alpha-warn').hidden = !info.hasAlpha;

    $('step-config').hidden = false;
    syncDpiFromMm();
    ['step-result', 'step-heatmap', 'step-generate'].forEach(function (s) { $(s).hidden = true; });
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
  // 3. 予測を走らせる
  // ------------------------------------------------------------------
  var worker = null;

  $('run').addEventListener('click', function () {
    if (!state.rgba) return;
    var dpi = parseFloat($('dpi').value), level = parseInt($('level').value, 10);
    if (!(dpi > 0)) { alert(t('err.dpi')); return; }

    $('run').disabled = true;
    $('progress').textContent = t('progress.prep');

    var bw = Engine.toBW(state.rgba, state.W, state.H).bw;
    if (worker) worker.terminate();
    worker = new Worker('js/worker.js');
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
      } else if (m.type === 'error') {
        $('progress').textContent = '';
        $('run').disabled = false;
        alert(t('err.calc', { m: m.message }));
      }
    };
    // bw はコピーせず所有権ごと渡す（元は使い終わっている）
    worker.postMessage({ bw: bw, W: state.W, H: state.H, dpi: dpi, level: level },
                       [bw.buffer]);
  });

  // ------------------------------------------------------------------
  // 4. 判定を表示する
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
        mw: ev.widthMm.toFixed(0), mh: ev.heightMm.toFixed(0), total: ev.total
      }) + '</p>'
      + verdictRow('res.portrait', Engine.REGION_PORTRAIT[0], ev.portrait)
      + verdictRow('res.landscape', Engine.REGION_LANDSCAPE[0], ev.landscape)
      + '<p class="hint">' + t('res.spreadNote') + '</p>';

    var max = Math.max.apply(null, r.bands.map(function (b) { return b.points.length; })) || 1;
    var tb = $('bands').querySelector('tbody');
    tb.innerHTML = r.bands.map(function (b, i) {
      var used = [];
      if (b.mindpi <= ev.portrait.dpi && ev.portrait.dpi <= b.maxdpi) used.push(t('res.portrait.short'));
      if (b.mindpi <= ev.landscape.dpi && ev.landscape.dpi <= b.maxdpi) used.push(t('res.landscape.short'));
      return '<tr class="' + (used.length ? 'used' : '') + '">'
        + '<td>' + i + '</td>'
        + '<td>' + t('tbl.rangeFmt', { min: b.mindpi.toFixed(1),
                                        max: b.maxdpi.toFixed(1) }) + '</td>'
        + '<td>' + b.W + '×' + b.H + '</td>'
        + '<td>' + b.points.length + '</td>'
        + '<td><span class="bar" style="width:' + (b.points.length / max * 100) + '%"></span>'
        + (used.length ? '<span class="tag">'
            + t('res.usedBy', { who: used.join(' / ') }) + '</span>' : '')
        + '</td></tr>';
    }).join('');

    $('basis').textContent = t('res.basis');

    var sel = $('band');
    sel.innerHTML = r.bands.map(function (b, i) {
      return '<option value="' + i + '">'
        + t('hm.opt', { i: i, dpi: b.dpi.toFixed(1), w: b.W, h: b.H, n: b.points.length })
        + '</option>';
    }).join('');
    sel.value = Engine.bandForDpi(r.bands, ev.portrait.dpi);
    sel.onchange = drawHeatmap;

    ['step-result', 'step-heatmap', 'step-generate'].forEach(function (s) { $(s).hidden = false; });
    $('name').value = state.name;
    drawHeatmap();
  }

  function verdictRow(labelKey, px, d) {
    var note = '';
    if (d.points < Engine.POOR) {
      note = '<div class="note v-bad">' + t('res.floor', { n: Engine.TRACK_MIN }) + '</div>';
    } else if (d.points > Engine.TRACK_PER_FRAME) {
      note = '<div class="note">' + t('res.cap', { n: Engine.TRACK_PER_FRAME }) + '</div>';
    }
    return '<div class="verdict">'
      + '<span>' + t(labelKey, { px: px }) + '</span>'
      + '<span class="hint">' + t('res.apparent', { n: d.dpi.toFixed(1) }) + '</span>'
      + '<span class="n ' + vClass(d.points) + '">' + d.points + '</span>'
      + '<span class="' + vClass(d.points) + '">' + t('res.points') + '</span>'
      + '<span class="' + vClass(d.points) + '">' + vText(d.points) + '</span></div>'
      + '<div class="subrow">' + t('res.detail', {
          sel: d.selectable, spread: (d.spread * 100).toFixed(1), fb: d.fallback
        }) + '</div>'
      + note;
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
  // 5. 生成
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
