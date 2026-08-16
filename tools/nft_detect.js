#!/usr/bin/env node
/*
 * nft_detect.js — 本物の NFT 検出器に画像を通して、検出できるかを測る。
 *
 * ARnft が中で使っているのと同じ WASM（@webarkit/jsartoolkit-nft の Node ビルド）を
 * 直接叩く。ブラウザもカメラも canvas も要らない。1枚あたり数ミリ秒。
 *
 * 【役割分担】このスクリプトは画像を一切扱わない。
 *   画像の読み込み・合成・リサイズは tools/check_detection.py（Python + PIL）が行い、
 *   ここには「生の RGBA バイト列」だけが渡ってくる。
 *   単体で使うことは想定していない。入口は check_detection.py。
 *
 * 使い方:
 *   node tools/nft_detect.js <job.json>
 *
 * job.json:
 *   cwd は check_detection.py が隣の website リポジトリのルートに設定する
 *   （道具は ar-marker-studio 側、作品のマーカーは website 側）。
 *   { "marker":  "projects/atariar/markers/x/01",   ← 拡張子なし。cwd からの相対パス
 *     "camera":  "projects/atariar/data/camera_para.dat",  ← 同上
 *     "width": 320, "height": 240,
 *     "attempts": 4,                                ← 1条件あたり何枚投げるか
 *     "frames": ["/abs/path/f000.rgba", ...],       ← 生 RGBA。絶対パスでよい
 *     "out":     "/abs/path/result.json" }
 *
 * 【重要】marker と camera だけは cwd からの相対パスにすること。
 * Node ビルドは NODEFS で cwd を /temp にマウントし、全パスに /temp/ を前置するため、
 * 絶対パスを渡すと見つからない。frames は通常の fs で読むので絶対パスでよい。
 */
'use strict';

const fs = require('fs');
const { ARToolkitNFT, ARControllerNFT } = require('@webarkit/jsartoolkit-nft');

// ------------------------------------------------------------------
// 上流のバグ回避（@webarkit/jsartoolkit-nft 1.10.1）
//
// C++ 側は setup(w, h, cameraID, bool enableFiltering) と
//          passVideoData(id, framePtr, lumaPtr, bool internalLuma) の 4 引数だが、
// 同梱の dist/ARToolkitNFT_node.js は 3 引数で呼ぶ。そのままだと
//   ERROR: function setup called with 3 arguments, expected 4
// で落ちる。node_modules は触らず prototype だけ差し替える。
// ------------------------------------------------------------------
ARToolkitNFT.prototype.setup = function (width, height, cameraId) {
  this.videoFramePtr = this.malloc(width * height * 4);
  this.videoLumaPtr = this.malloc(width * height);
  return this.instance.setup(width, height, cameraId, false);
};
ARToolkitNFT.prototype.passVideoData = function (id, videoFrame, videoLuma) {
  // HEAPU8 は毎回 instance から取り直す（メモリ拡張で detach されるため）
  if (this.videoFramePtr) this.instance.HEAPU8.set(videoFrame, this.videoFramePtr);
  if (this.videoLumaPtr) this.instance.HEAPU8.set(videoLuma, this.videoLumaPtr);
  return this.instance.passVideoData(id, this.videoFramePtr, this.videoLumaPtr, false);
};

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const PIXELS = job.width * job.height * 4;

// WASM のログは **stderr** に出る（Emscripten の emscripten_console_warn 経由）。
// 捨てずに残す。`Page[n] pre:.. aft:..` にインライア数が入っていて、
// これが「検出の確からしさ」の生データになる（8点未満だと検出が成立しない）。
// フレームの区切りが分かるよう、同じ stderr に目印を1行入れる（順序を保つため）。
const mark = (s) => process.stderr.write('##' + s + '\n');

/** 1枚投げて結果を取る。1枚あたりの所要時間(ms)も返す */
function shoot(ar, data, attempts) {
  let ms = 0;
  for (let i = 0; i < attempts; i++) {
    const t0 = process.hrtime.bigint();
    ar._copyImageToHeap(data);      // HEAP に転送し、RGBA から luma を作る
    ar.detectNFTMarker();           // KPM 検出（.fset3）→ AR2 追従（.fset）
    const info = ar.getNFTMarker(0);
    ms += Number(process.hrtime.bigint() - t0) / 1e6;
    if (info && info.found) {
      return { found: true, at: i + 1, ms: ms / (i + 1), error: info.error,
               pose: Array.from(info.pose || []) };
    }
  }
  return { found: false, ms: ms / attempts };
}

/**
 * 検出器を「未検出」の状態に戻す。
 * 一度見つけると detectedPage が立ち、以後 KPM は走らない（追従に切り替わる）。
 * 空の画面を見せて追従を切らないと、次の条件で「検出」ではなく
 * 「前の条件の追従」を見ることになる。
 */
function reset(ar, blank) {
  for (let i = 0; i < 4; i++) {
    ar._copyImageToHeap(blank);
    ar.detectNFTMarker();
    const info = ar.getNFTMarker(0);
    if (!info || !info.found) return true;
  }
  return false;
}

(async () => {
  const ar = await ARControllerNFT.initWithDimensions(job.width, job.height, job.camera);
  await new Promise((res, rej) => {
    ar.loadNFTMarker(job.marker, res, (e) => rej(new Error('マーカーを読めない: ' + e)));
  });

  const blank = new Uint8ClampedArray(PIXELS).fill(128);
  const results = [];
  for (let i = 0; i < job.frames.length; i++) {
    // noReset を立てると、条件のあいだで検出器を戻さない。
    // 一度見つけた後は追従が引き継ぐので、実際にスマホを近づけていく動きに近くなる
    // （「ゼロから見つけられるか」ではなく「見失わずに追えるか」を測ることになる）。
    if (!job.noReset) reset(ar, blank);
    mark('FRAME ' + i);
    const buf = fs.readFileSync(job.frames[i]);
    if (buf.length !== PIXELS) throw new Error(`${job.frames[i]}: ${buf.length} バイト、`
      + `${PIXELS} のはず（${job.width}x${job.height}x4）`);
    results.push(shoot(ar, new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length),
                       job.attempts || 4));
  }
  mark('END');
  fs.writeFileSync(job.out, JSON.stringify(results));
  process.exit(0);
})().catch((e) => {
  console.error('ERROR: ' + e.message);
  process.exit(1);
});
