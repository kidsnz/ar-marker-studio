/*
 * fset.js — 生成された .fset を読む。
 *
 * engine.js は「生成せずに予測する」ためのもの。こちらは**実際に生成された結果**を
 * 読んで、同じ判定にかける。生成が 0.3〜1.3 秒で終わると分かったので、
 * 予測より実測の方が速くて正確な場面が出てきた（自動探索がそれ）。
 *
 * 【形式】ARToolKit5 AR2FeatureSetT、リトルエンディアン
 *   int   レベル数
 *   各レベル: int scale, float maxdpi, float mindpi, int 点数
 *             点数 × AR2FeatureCoordT(= float x, y, mx, my, maxSim の20バイト)
 *   ※ maxdpi が先。逆に読むと距離帯の判定が反転する
 *
 * x,y はその段の画像上の画素座標、mx,my はマーカー上の実座標(mm)。
 * 判定には mx,my を使う（マーカー全体を 1x1 とした座標に直せるため）。
 */
(function (root) {
  'use strict';

  var COORD = 20;          // float x, y, mx, my, maxSim
  var HEADER = 16;         // int scale, float maxdpi, float mindpi, int 点数

  /**
   * .fset を読む。
   * @param {Uint8Array|ArrayBuffer} bytes
   * @returns {{levels:Array<{scale,maxdpi,mindpi,points:Array<[number,number]>}>,total:number}}
   *          読めなければ null
   */
  function parse(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.byteLength < 4) return null;

    var num = dv.getInt32(0, true);
    if (num < 0 || num > 64) return null;

    var off = 4, levels = [], total = 0;
    for (var i = 0; i < num; i++) {
      if (off + HEADER > b.byteLength) return null;
      var scale = dv.getInt32(off, true);
      var maxdpi = dv.getFloat32(off + 4, true);
      var mindpi = dv.getFloat32(off + 8, true);
      var n = dv.getInt32(off + 12, true);
      off += HEADER;
      if (n < 0 || off + n * COORD > b.byteLength) return null;
      var pts = new Array(n);
      for (var j = 0; j < n; j++) {
        // x,y は使わない。判定はマーカー上の実座標 mx,my で行う
        pts[j] = [dv.getFloat32(off + 8, true), dv.getFloat32(off + 12, true)];
        off += COORD;
      }
      levels.push({ scale: scale, maxdpi: maxdpi, mindpi: mindpi, points: pts });
      total += n;
    }
    // 末尾ぴったりで終わらなければ形式違い
    if (off !== b.byteLength) return null;
    return { levels: levels, total: total };
  }

  /**
   * 見かけ dpi ap で使われる帯の点を、マーカー全体を 1x1 とした座標で集める。
   * parse_fset.py の points_at と同じ。
   * @param strict false なら実行時のフォールバック範囲 [mindpi/2, maxdpi*2] まで広げる
   */
  function pointsAt(levels, ap, wMm, hMm, strict) {
    var out = [];
    for (var i = 0; i < levels.length; i++) {
      var lv = levels[i];
      var lo = strict ? lv.mindpi : lv.mindpi / 2;
      var hi = strict ? lv.maxdpi : lv.maxdpi * 2;
      if (ap < lo || ap > hi) continue;
      for (var j = 0; j < lv.points.length; j++) {
        out.push([lv.points[j][0] / wMm, lv.points[j][1] / hMm]);
      }
    }
    return out;
  }

  /** 見かけ dpi ap で使える点の数（帯の合算） */
  function usablePoints(levels, ap) {
    var n = 0;
    for (var i = 0; i < levels.length; i++) {
      if (levels[i].mindpi <= ap && ap <= levels[i].maxdpi) n += levels[i].points.length;
    }
    return n;
  }

  var API = { parse: parse, pointsAt: pointsAt, usablePoints: usablePoints };
  if (typeof module === 'object' && module.exports) module.exports = API;
  else root.FSet = API;
})(typeof self !== 'undefined' ? self : this);
