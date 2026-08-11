/*
 * heatmap.js — 「絵のどこが弱いのか」を3面で描く。
 *
 *   1面目 … 選ばれた追従点（その距離帯で実際に使われる点と占有半径）
 *   2面目 … 候補の強さ（青＝紛らわしくない＝良い、赤＝紛らわしい）
 *   3面目 … 弱い領域（使える手がかりからの距離。赤い場所には手がかりが無い）
 *
 * 直すべき場所は3面目で分かる。外周22pxはテンプレートが収まらず
 * 構造的に点が立たないので、判定から外して灰色にしてある。
 */
(function (root) {
  'use strict';

  var TS = 22;

  /** 表示倍率。小さい距離帯でも注記が潰れないように整数倍で拡大する */
  function scaleFor(W, H) {
    return Math.max(1, Math.min(4, Math.round(560 / Math.max(W, H))));
  }

  /** 元画像を拡大してキャンバスに敷く（ドット絵が崩れないよう最近傍で） */
  function drawBase(ctx, bw, W, H, S, dim) {
    var img = ctx.createImageData(W, H);
    for (var i = 0; i < W * H; i++) {
      // dim のときは中間グレーに寄せる（明暗どちらのテーマでも点が見えるように）
      var v = dim ? 128 + (bw[i] - 128) * 0.3 : bw[i];
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    var tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, W * S, H * S);
  }

  /** 値 0..1 を 青→黄→赤 に写す */
  function ramp(t) {
    t = Math.max(0, Math.min(1, t));
    if (t < 0.5) {
      var u = t * 2;
      return [Math.round(60 + 195 * u), Math.round(100 + 155 * u), Math.round(220 - 60 * u)];
    }
    var w = (t - 0.5) * 2;
    return [255, Math.round(255 - 200 * w), Math.round(160 - 150 * w)];
  }

  // --- 正確なユークリッド距離変換（Felzenszwalb & Huttenlocher の1次元パス） ---
  function edt1d(f, n, d, v, z) {
    var k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (var q = 1; q < n; q++) {
      var s;
      for (;;) {
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        if (k > 0 && s <= z[k]) k--; else break;
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (var q2 = 0; q2 < n; q2++) {
      while (z[k + 1] < q2) k++;
      d[q2] = (q2 - v[k]) * (q2 - v[k]) + f[v[k]];
    }
  }

  /** mask が 1 の画素からの距離（画素単位）を返す */
  function distanceTo(mask, W, H) {
    var INF = 1e12;
    var f = new Float64Array(Math.max(W, H));
    var d = new Float64Array(Math.max(W, H));
    var v = new Int32Array(Math.max(W, H));
    var z = new Float64Array(Math.max(W, H) + 1);
    var out = new Float64Array(W * H);
    var x, y;
    for (x = 0; x < W; x++) {
      for (y = 0; y < H; y++) f[y] = mask[y * W + x] ? 0 : INF;
      edt1d(f, H, d, v, z);
      for (y = 0; y < H; y++) out[y * W + x] = d[y];
    }
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) f[x] = out[y * W + x];
      edt1d(f, W, d, v, z);
      for (x = 0; x < W; x++) out[y * W + x] = Math.sqrt(d[x]);
    }
    return out;
  }

  /**
   * 3面を描く。
   * @param {Array<HTMLCanvasElement>} canvases 3枚
   * @param {Object} band Engine.predict が返す距離帯ひとつ
   */
  function draw(canvases, band) {
    var W = band.W, H = band.H, S = scaleFor(W, H);
    canvases.forEach(function (c) { c.width = W * S; c.height = H * S; });

    // --- 1面目: 選ばれた追従点 ---
    var c0 = canvases[0].getContext('2d');
    drawBase(c0, band.bw, W, H, S, false);
    c0.lineWidth = Math.max(1, S * 0.6);
    c0.font = (9 * Math.max(1, S * 0.7)) + 'px ui-monospace, monospace';
    c0.textBaseline = 'middle';
    band.points.forEach(function (p, i) {
      var x = (p.x + 0.5) * S, y = (p.y + 0.5) * S, r = band.occ * S / 2;
      c0.strokeStyle = '#00c853';
      c0.beginPath(); c0.arc(x, y, r, 0, Math.PI * 2); c0.stroke();
      c0.beginPath();
      c0.moveTo(x - 4 * S / 2, y); c0.lineTo(x + 4 * S / 2, y);
      c0.moveTo(x, y - 4 * S / 2); c0.lineTo(x, y + 4 * S / 2);
      c0.stroke();
      c0.lineWidth = 3; c0.strokeStyle = 'rgba(0,0,0,0.85)';
      c0.strokeText(String(i + 1), x + r + 3, y);
      c0.fillStyle = '#00c853';
      c0.fillText(String(i + 1), x + r + 3, y);
      c0.lineWidth = Math.max(1, S * 0.6);
    });

    // --- 2面目: 候補の強さ ---
    var c1 = canvases[1].getContext('2d');
    drawBase(c1, band.bw, W, H, S, true);
    var r1 = Math.max(2.2, S * 1.5);
    for (var i = 0; i < band.cand.length; i++) {
      var p = band.cand[i];
      var t = (band.candVal[i] - 0.6) / 0.4;          // 0.6〜1.0 を色に割り当てる
      var rgb = ramp(t);
      c1.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
      c1.beginPath();
      c1.arc(((p % W) + 0.5) * S, (((p / W) | 0) + 0.5) * S, r1, 0, Math.PI * 2);
      c1.fill();
    }

    // --- 3面目: 弱い領域 ---
    var c2 = canvases[2].getContext('2d');
    drawBase(c2, band.bw, W, H, S, false);
    var mask = new Uint8Array(W * H);
    for (var u = 0; u < band.usable.length; u++) mask[band.usable[u]] = 1;
    var dist = band.usable.length ? distanceTo(mask, W, H) : null;
    var ov = c2.createImageData(W, H);
    for (var q = 0; q < W * H; q++) {
      var yy = (q / W) | 0, xx = q % W;
      var edge = yy < TS || yy >= H - TS || xx < TS || xx >= W - TS;
      if (edge) {                                    // 構造的に対象外
        ov.data[q * 4] = ov.data[q * 4 + 1] = ov.data[q * 4 + 2] = 128;
        ov.data[q * 4 + 3] = 70;
        continue;
      }
      var t2 = dist ? Math.min(dist[q] / band.occ, 3) / 3 : 1;
      var col = ramp(t2);
      ov.data[q * 4] = col[0]; ov.data[q * 4 + 1] = col[1]; ov.data[q * 4 + 2] = col[2];
      ov.data[q * 4 + 3] = 140;
    }
    var tmp2 = document.createElement('canvas');
    tmp2.width = W; tmp2.height = H;
    tmp2.getContext('2d').putImageData(ov, 0, 0);
    c2.imageSmoothingEnabled = false;
    c2.drawImage(tmp2, 0, 0, W * S, H * S);
  }

  root.Heatmap = { draw: draw, ramp: ramp };
})(typeof self !== 'undefined' ? self : this);
