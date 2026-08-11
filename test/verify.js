/*
 * verify.js — エンジンが本物の生成器と一致するかを検算する（Node 版）。
 *
 *   node test/verify.js <markers フォルダ>
 *
 * 期待値は test/fixtures.js（実際の生成器のログから取った実測値）。
 * ブラウザ版の検算は test/verify.html で、同じ fixtures を使う。
 *
 * 【エンジンを直したら必ずこれを通すこと。】
 * 「直したつもり」は当てにならない。この検算は実際に誤りを検出している
 * （truncf の丸め、勾配の float32 の取り扱いなど）。
 */
const path = require('path');
const fs = require('fs');
const Engine = require('../js/engine.js');
const PNGReader = require('../js/png.js');
const { EXACT, TOLERANT, TOLERANCE } = require('./fixtures.js');

async function run(root, cases, tol) {
  let bad = 0;
  for (const c of cases) {
    const file = path.join(root, c.image);
    if (!fs.existsSync(file)) {
      console.log(`  --  ${c.image} が無い`);
      bad++;
      continue;
    }
    const png = await PNGReader.decode(fs.readFileSync(file));
    const bw = Engine.toBW(png.data, png.width, png.height).bw;
    const res = Engine.predict(bw, png.width, png.height, { dpi: c.dpi, level: c.level });
    const got = res.bands.map((b) => b.points.length);
    const gc = [res.bands[0].extracted, res.bands[0].filtered];

    let ok = got.length === c.points.length;
    if (ok) {
      ok = tol === 0
        ? got.every((g, i) => g === c.points[i])
        : got.every((g, i) => Math.abs(g - c.points[i]) <= Math.max(1, c.points[i] * tol));
    }
    const okCounts = gc[0] === c.counts[0] && gc[1] === c.counts[1];

    console.log(`  ${ok && okCounts ? 'OK ' : 'NG '} ${c.image.padEnd(30)}`
      + ` -dpi=${c.dpi} -level=${c.level}  候補 ${gc[0]}/${gc[1]}`
      + (tol ? `  （許容 ${tol * 100}%）` : ''));
    if (!ok) {
      bad++;
      console.log(`      予測 [${got}]`);
      console.log(`      実際 [${c.points}]`);
    }
    if (!okCounts) {
      bad++;
      console.log(`      NG 候補数 [${gc}] / 実際 [${c.counts}]`);
    }
  }
  return bad;
}

(async () => {
  const root = process.argv[2];
  if (!root) {
    console.log('使い方: node test/verify.js <markers フォルダ>');
    process.exit(1);
  }
  console.log('=== 検算: 実際の生成器のログと一致するか ===\n');
  console.log('[1] コントラストのある絵（完全一致を要求する）');
  let bad = await run(root, EXACT, 0);
  console.log('[2] のっぺりした絵（生成器側の float32 の丸めでずれる既知のケース）');
  bad += await run(root, TOLERANT, TOLERANCE);
  console.log('\n判定: ' + (bad === 0 ? 'すべて合格' : `不合格（${bad} 件）`));
  process.exit(bad === 0 ? 0 : 1);
})();
