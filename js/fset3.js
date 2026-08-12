/*
 * fset3.js — 検出側のデータ（.fset3）を読む。
 *
 * NFT は2段構え。**追従**（.fset）と**検出**（.fset3）は別物で、
 * 症状の切り分けが違う:
 *   そもそも認識しない        → .fset3（検出）が弱い
 *   認識はするが姿勢が暴れる  → .fset（追従）の点が足りない
 *
 * このツールの本体（engine.js）は追従側だけを扱う。こちらは生成した .fset3 を
 * 読んで、距離帯ごとに検出キーポイントが何点あるかを出す。
 * 0点の帯はその距離で「そもそも認識できない」ことを意味する。
 *
 * 【形式】実ファイルで検算済み（全マーカーで末尾ぴったりに収まることを確認）
 *   int  点数
 *   各点: coord2D(float x,y) + coord3D(float x,y) + FreakFeature(108) + int pageNo + int refImageNo
 *         FreakFeature = 記述子 96 バイト(768ビット) + float angle + float scale + int maxima
 *   int  ページ数
 *   各ページ: int pageNo, int imageNum, imageNum×{int width, height, imageNo}
 *
 * ※ 記述子そのものを使った「繰り返し模様」の判定は**やらない**。
 *   閾値を決める材料（検出に失敗する実例）が無く、
 *   根拠のない数値を出すことになるため。詳しくは README を参照。
 */
(function (root) {
  'use strict';

  var FREAK_BYTES = 96;
  var FEATURE_SIZE = 108;                       // 96 + angle(4) + scale(4) + maxima(4)
  var REC = 8 + 8 + FEATURE_SIZE + 4 + 4;       // 1点あたり 132 バイト

  // 点を1つも持たないダミー段の段番号。検出器の不具合を避けるために先頭に挿す
  // （website の tools/fix_fset3.py が入れる）。中身が無いので一覧からは除く。
  var DUMMY_IMAGE_NO = 9999;

  /**
   * .fset3 を読む。
   * @param {Uint8Array|ArrayBuffer} bytes
   * @returns {{total:number, levels:Array<{no:number,w:number,h:number,count:number}>}}
   *          読めなければ null
   */
  function parse(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.byteLength < 8) return null;

    var total = dv.getInt32(0, true);
    if (total < 0 || 4 + total * REC + 4 > b.byteLength) return null;

    // 各点がどの段（縮小画像）のものかを数える
    var perImage = {};
    for (var i = 0; i < total; i++) {
      var no = dv.getInt32(4 + i * REC + 8 + 8 + FEATURE_SIZE + 4, true);
      perImage[no] = (perImage[no] || 0) + 1;
    }

    var off = 4 + total * REC;
    var pageNum = dv.getInt32(off, true);
    off += 4;
    if (pageNum < 0 || pageNum > 64) return null;

    var levels = [];
    for (var p = 0; p < pageNum; p++) {
      if (off + 8 > b.byteLength) return null;
      off += 4;                                  // pageNo は使わない
      var imageNum = dv.getInt32(off, true);
      off += 4;
      if (imageNum < 0 || off + imageNum * 12 > b.byteLength) return null;
      for (var j = 0; j < imageNum; j++) {
        var w = dv.getInt32(off, true);
        var h = dv.getInt32(off + 4, true);
        var no2 = dv.getInt32(off + 8, true);
        off += 12;
        if (no2 === DUMMY_IMAGE_NO) continue;     // 中身のないダミー段は数えない
        levels.push({ no: no2, w: w, h: h, count: perImage[no2] || 0 });
      }
    }
    // 末尾ぴったりで終わらなければ形式違い
    if (off !== b.byteLength) return null;

    levels.sort(function (a, c) { return a.no - c.no; });
    return { total: total, levels: levels };
  }

  var API = { parse: parse, FEATURE_SIZE: FEATURE_SIZE, FREAK_BYTES: FREAK_BYTES };
  if (typeof module === 'object' && module.exports) module.exports = API;
  else root.FSet3 = API;
})(typeof self !== 'undefined' ? self : this);
