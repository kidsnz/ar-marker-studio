/* 1 回の生成だけを行う子プロセス。
 *
 * 生成器は webarkit/Nft-Marker-Creator-App のスレッド版（vendor/ に置いてある）。
 * carnaux 版と入口の名前が違う:
 *   carnaux : M._createImageSet(ポインタ, dpi, W, H, nc, 文字列ポインタ)  ← malloc が要る
 *   これ    : M.createNftDataSet(配列, dpi, W, H, nc, 文字列)             ← そのまま渡せる
 * 書き出すファイル名は両方とも tempFilename.{fset,fset3,iset} で共通。
 */
const path = require('path');

const THREADS = Number(process.env.THREADS || 4);
const GENERATOR = path.join(__dirname, 'vendor', 'NftMarkerCreator_wasm.thread.js');

process.on('message', (job) => {
  try {
    const Module = require(GENERATOR);
    const arr = new Uint8Array(Buffer.from(job.raw, 'base64'));

    Module.onRuntimeInitialized = function () {
      try {
        const params = ['0', 'img', `-level=${job.level}`, `-dpi=${job.dpi}`];
        if (job.leveli != null) params.push(`-leveli=${job.leveli}`);
        params.push('--threaded', String(THREADS));

        Module.createNftDataSet(arr, Number(job.dpi), job.W, job.H, job.nc, params.join(' '));

        const out = {};
        for (const ext of ['fset', 'fset3', 'iset']) {
          out[ext] = Buffer.from(Module.FS.readFile('tempFilename.' + ext)).toString('base64');
        }
        process.send({ ok: true, ...out });
      } catch (e) {
        process.send({ ok: false, error: String((e && e.message) || e) });
      }
    };
  } catch (e) {
    process.send({ ok: false, error: String((e && e.message) || e) });
  }
});
