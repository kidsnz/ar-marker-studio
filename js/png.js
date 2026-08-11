/*
 * png.js — PNG を自前でデコードする。
 *
 * 【なぜ canvas を使わないのか】
 * canvas の drawImage はカラープロファイル（ICC）が付いた画像を変換することがあり、
 * 画素値が元ファイルと変わる。このツールは「生成器と1画素も違わないこと」が
 * 売りなので、画素値が動くと判定がずれる。生成器（pngjs）はプロファイルを
 * 無視して生の値を読むため、こちらも自前で読んで合わせる。
 *
 * 展開はブラウザなら DecompressionStream、Node なら zlib を使う。
 * depth=8 の colorType 0/2/3/4/6 に対応。インタレースは非対応。
 * JPEG は自前で読まないので canvas に任せる（生成器の JS デコーダとは
 * わずかに値が食い違うため、PNG を使う方が正確になる）。
 */
(function (root) {
  'use strict';

  var CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

  function inflate(bytes) {
    if (typeof DecompressionStream === 'function') {
      var ds = new DecompressionStream('deflate');
      var w = ds.writable.getWriter();
      w.write(bytes); w.close();
      return new Response(ds.readable).arrayBuffer().then(function (b) {
        return new Uint8Array(b);
      });
    }
    return Promise.resolve(new Uint8Array(require('zlib').inflateSync(Buffer.from(bytes))));
  }

  function u32(b, i) {
    return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  }

  /** ArrayBuffer / Uint8Array を受け取り {width,height,data(RGBA),colorType} を返す */
  function decode(buffer) {
    var b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (u32(b, 0) !== 0x89504e47) return Promise.reject(new Error('PNG ではない'));

    var off = 8, ihdr = null, palette = null, trns = null, idat = [], total = 0;
    while (off < b.length) {
      var len = u32(b, off);
      var type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
      var data = b.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') {
        ihdr = { width: u32(data, 0), height: u32(data, 4),
                 depth: data[8], colorType: data[9], interlace: data[12] };
      } else if (type === 'PLTE') palette = data;
      else if (type === 'tRNS') trns = data;
      else if (type === 'IDAT') { idat.push(data); total += len; }
      else if (type === 'IEND') break;
      off += 12 + len;
    }
    if (!ihdr) return Promise.reject(new Error('IHDR が無い'));
    if (ihdr.depth !== 8) return Promise.reject(new Error('16bit の PNG は未対応'));
    if (ihdr.interlace) return Promise.reject(new Error('インタレース PNG は未対応'));
    var nc = CHANNELS[ihdr.colorType];
    if (!nc) return Promise.reject(new Error('この PNG の形式は未対応'));

    var joined = new Uint8Array(total), o = 0;
    idat.forEach(function (d) { joined.set(d, o); o += d.length; });

    return inflate(joined).then(function (raw) {
      var W = ihdr.width, H = ihdr.height, stride = W * nc;
      var px = new Uint8Array(H * stride);
      // スキャンラインのフィルタを解く（PNG 仕様 9.2）
      for (var y = 0; y < H; y++) {
        var ft = raw[y * (stride + 1)];
        var s0 = y * (stride + 1) + 1, c0 = y * stride, p0 = (y - 1) * stride;
        for (var i = 0; i < stride; i++) {
          var a = i >= nc ? px[c0 + i - nc] : 0;
          var bb = y > 0 ? px[p0 + i] : 0;
          var c = (y > 0 && i >= nc) ? px[p0 + i - nc] : 0;
          var v = raw[s0 + i];
          if (ft === 1) v += a;
          else if (ft === 2) v += bb;
          else if (ft === 3) v += (a + bb) >> 1;
          else if (ft === 4) {
            var p = a + bb - c;
            var pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c);
            v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c);
          }
          px[c0 + i] = v & 0xff;
        }
      }
      // RGBA に展開する
      var out = new Uint8ClampedArray(W * H * 4);
      for (var k = 0; k < W * H; k++) {
        var s = k * nc, d = k * 4, r, g, bl, al = 255;
        if (ihdr.colorType === 0) { r = g = bl = px[s]; }
        else if (ihdr.colorType === 2) { r = px[s]; g = px[s + 1]; bl = px[s + 2]; }
        else if (ihdr.colorType === 3) {
          var idx = px[s];
          r = palette[idx * 3]; g = palette[idx * 3 + 1]; bl = palette[idx * 3 + 2];
          if (trns && idx < trns.length) al = trns[idx];
        } else if (ihdr.colorType === 4) { r = g = bl = px[s]; al = px[s + 1]; }
        else { r = px[s]; g = px[s + 1]; bl = px[s + 2]; al = px[s + 3]; }
        out[d] = r; out[d + 1] = g; out[d + 2] = bl; out[d + 3] = al;
      }
      return { width: W, height: H, data: out, colorType: ihdr.colorType };
    });
  }

  var API = { decode: decode };
  if (typeof module === 'object' && module.exports) module.exports = API;
  else root.PNGReader = API;
})(typeof self !== 'undefined' ? self : this);
