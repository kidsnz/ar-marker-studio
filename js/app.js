/*
 * app.js — 画面まわり。重い計算は js/worker.js（別スレッド）に投げる。
 *
 * 流れ: 画像を読む → 実寸から dpi を出す → 予測（Worker）→ 判定表 →
 *       ヒートマップ → 生成（vendor の本物の生成器）
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
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
      alert('画像を読めなかった: ' + err.message);
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
      row('画素数', state.W + ' × ' + state.H)
      + row('色', info.nc === 1 ? 'グレースケール（r=g=b）' : 'カラー → (r+g+b)/3 で白黒化')
      + row('形式', state.isPNG ? 'PNG（自前でデコード＝生成器と同じ値）'
                                : 'JPEG（canvas でデコード。生成器と数値がわずかに違う）');
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
    if (!(dpi > 0)) { alert('dpi が正しくない'); return; }

    $('run').disabled = true;
    $('progress').textContent = '準備中…';

    var bw = Engine.toBW(state.rgba, state.W, state.H).bw;
    if (worker) worker.terminate();
    worker = new Worker('js/worker.js');
    worker.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'progress') {
        $('progress').textContent = m.i >= m.n ? 'まとめ中…'
          : '距離帯 ' + (m.i + 1) + '/' + m.n + '（' + m.w + '×' + m.h + '、'
            + m.dpi.toFixed(1) + 'dpi）を計算中…';
      } else if (m.type === 'done') {
        $('progress').textContent = '';
        $('run').disabled = false;
        state.result = m.result;
        showResult();
      } else if (m.type === 'error') {
        $('progress').textContent = '';
        $('run').disabled = false;
        alert('計算に失敗した: ' + m.message);
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

  function showResult() {
    var r = state.result;
    var mm = parseFloat($('size-mm').value);
    var ev = Engine.evaluate(r, mm);

    $('verdicts').innerHTML =
      '<p class="hint">元画像 ' + r.W + '×' + r.H + ' / -dpi=' + (+r.dpi.toFixed(2))
        + ' / -level=' + r.level + ' → 実寸 '
        + ev.widthMm.toFixed(0) + '×' + ev.heightMm.toFixed(0) + ' mm'
        + '　　追従点の合計 ' + ev.total + ' 点</p>'
      + verdictRow('縦持ち', '実効180px', ev.portrait)
      + verdictRow('横持ち', '実効320px', ev.landscape);

    var max = Math.max.apply(null, r.bands.map(function (b) { return b.points.length; })) || 1;
    var tb = $('bands').querySelector('tbody');
    tb.innerHTML = r.bands.map(function (b, i) {
      var used = [];
      if (b.mindpi <= ev.portrait.dpi && ev.portrait.dpi <= b.maxdpi) used.push('縦持ち');
      if (b.mindpi <= ev.landscape.dpi && ev.landscape.dpi <= b.maxdpi) used.push('横持ち');
      return '<tr class="' + (used.length ? 'used' : '') + '">'
        + '<td>' + i + '</td>'
        + '<td>' + b.mindpi.toFixed(1) + ' 〜 ' + b.maxdpi.toFixed(1) + '</td>'
        + '<td>' + b.W + '×' + b.H + '</td>'
        + '<td>' + b.points.length + '</td>'
        + '<td><span class="bar" style="width:' + (b.points.length / max * 100) + '%"></span>'
        + (used.length ? '<span class="tag">' + used.join('・') + 'で使う</span>' : '')
        + '</td></tr>';
    }).join('');

    $('basis').textContent =
      'ARnft が画像処理する解像度は 320×240 固定（ARnft.js の prepareImage）。'
      + '縦持ちでは映像が左右に黒帯で letterbox され実効 180×240 になる。'
      + '見かけdpi = min(実効幅px ÷ マーカー幅インチ, 240 ÷ マーカー高さインチ)。';

    var sel = $('band');
    sel.innerHTML = r.bands.map(function (b, i) {
      return '<option value="' + i + '">' + i + ': ' + b.dpi.toFixed(1) + ' dpi（'
        + b.W + '×' + b.H + '、' + b.points.length + '点）</option>';
    }).join('');
    sel.value = Engine.bandForDpi(r.bands, ev.portrait.dpi);
    sel.onchange = drawHeatmap;

    ['step-result', 'step-heatmap', 'step-generate'].forEach(function (s) { $(s).hidden = false; });
    $('name').value = state.name;
    drawHeatmap();
  }

  function verdictRow(label, region, d) {
    return '<div class="verdict"><span>' + label + '（' + region + '）</span>'
      + '<span class="hint">見かけ ' + d.dpi.toFixed(1) + ' dpi →</span>'
      + '<span class="n ' + vClass(d.points) + '">' + d.points + '</span>'
      + '<span class="' + vClass(d.points) + '">点　' + d.verdict + '</span></div>';
  }

  function drawHeatmap() {
    var i = parseInt($('band').value, 10);
    var b = state.result.bands[i];
    Heatmap.draw([$('hm0'), $('hm1'), $('hm2')], b);
    $('band-note').textContent =
      '有効範囲 ' + b.mindpi.toFixed(1) + '〜' + b.maxdpi.toFixed(1) + ' dpi ／ '
      + '候補 ' + b.cand.length + ' 画素、うち条件を満たすもの ' + b.usable.length + ' 画素 ／ '
      + '選ばれた点 ' + b.points.length + '（上限 ' + b.maxFeatureNum + '）';
  }

  // ------------------------------------------------------------------
  // 5. 生成
  // ------------------------------------------------------------------
  $('gen').addEventListener('click', function () {
    if (!state.rgba) return;
    var name = ($('name').value || 'marker').replace(/[^\w.-]/g, '_');
    $('gen').disabled = true;
    $('genresult').hidden = true;
    $('genstat').textContent = '生成器を読み込み中…（初回は約1MB）';

    Generator.generate(state.rgba, state.W, state.H, {
      dpi: parseFloat($('dpi').value),
      level: parseInt($('level').value, 10),
      leveli: parseInt($('leveli').value, 10),
      name: name,
      onLog: function (t) { $('genstat').textContent = '生成中… ' + t; }
    }).then(function (out) {
      $('genstat').textContent = '';
      $('gen').disabled = false;
      $('genresult').hidden = false;
      $('gensummary').textContent = '生成した（' + (out.ms / 1000).toFixed(1) + ' 秒）。'
        + '3つとも同じフォルダに置いて使う。';
      var links = $('genlinks');
      links.innerHTML = '';
      [['fset', out.fset], ['fset3', out.fset3], ['iset', out.iset]].forEach(function (e) {
        links.appendChild(Generator.linkFor(e[1], name + '.' + e[0]));
      });
      $('gencheck').textContent = check(out.fset);
    }).catch(function (err) {
      $('genstat').textContent = '';
      $('gen').disabled = false;
      alert('生成に失敗した: ' + err.message);
    });
  });

  /** 生成された .fset を読んで、予測と合っていたかを確かめる */
  function check(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var n = dv.getInt32(0, true), off = 4, got = [];
    for (var i = 0; i < n; i++) {
      got.push(dv.getInt32(off + 12, true));
      off += 16 + dv.getInt32(off + 12, true) * 20;
    }
    var want = state.result.bands.map(function (b) { return b.points.length; });
    if (got.length !== want.length) return '実際の .fset: [' + got + ']';
    var diff = got.reduce(function (s, g, i) { return s + (g === want[i] ? 0 : 1); }, 0);
    return diff === 0
      ? '予測と実際が全' + got.length + '帯で一致した。'
      : '予測と実際が ' + diff + '/' + got.length + ' 帯で違った（実際: [' + got + ']）。'
        + 'のっぺりした絵では生成器側の丸め誤差で数%ずれることがある。';
  }
})();
