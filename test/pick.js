/*
 * pick.js — おすすめ3案の選び方が「判断の軸」どおりかを検算する（Node 版）。
 *
 *   node test/pick.js
 *
 * 生成器も画像も要らない。Search.pick() は純粋な関数なので、
 * 採点済みの結果を並べて「どれが選ばれるべきか」だけを見る。
 *
 * 【軸】（すべてガイドの実測が根拠。変えるときは実測を先に取ること）
 *   1. 使える距離の数がいちばん多いもの。3点は崖であって連続量ではない
 *   2. 次に散らばり。ただし実測は 1% / 17% / 33% の3点しかないので、
 *      それより細かい差は「同じ」とみなす（ここが抜けていて不具合になった）
 *   3. 合計点数は最後の拠り所。これ単独では絶対に選ばない
 *      （実測で合計92点の設定が合計38点の設定にどの距離でも負けた）
 *   4. ファイルサイズは 10KB 刻み。1KB の差で中身の悪い方を選ばない
 */
const Search = require('../js/search.js');

let bad = 0;

/** 採点済みの結果を1件でっち上げる（pick が見るのはこの4つだけ） */
function r(tag, coverage, spread, sum, kb) {
  return { tag: tag, coverage: coverage, spread: spread, sum: sum, kb: kb };
}

function check(title, results, want) {
  const got = Search.pick(results);
  const keys = Object.keys(want);
  const ng = keys.filter((k) => !got[k] || got[k].tag !== want[k]);
  console.log(`  ${ng.length ? 'NG ' : 'OK '} ${title}`);
  if (ng.length) {
    bad++;
    keys.forEach((k) => {
      console.log(`      ${k}: 期待 ${want[k]} / 実際 ${got[k] ? got[k].tag : 'なし'}`);
    });
  }
  return got;
}

console.log('=== 検算: おすすめ3案の選び方 ===\n');

console.log('[1] 散らばりの差が実測の分解能より細かいときは、小さい方をバランス案にする');
// 実際に起きた不具合。1.7% と 1.5% の差で 291KB 大きい方が選ばれ、
// バランス案が性能案と同じになっていた。
check('1.7% と 1.5% は同じ扱い（291KB の差で決めない）', [
  r('4倍/391KB', 4, 0.017, 27, 391),
  r('2倍/100KB', 4, 0.015, 23, 100),
], { best: '4倍/391KB', balanced: '2倍/100KB' });

console.log('[2] 散らばりに実測どおりの差があるときは、大きくても質を採る');
check('1.5% より 20% を採る（飛ぶ / ほぼ安定 の差）', [
  r('よく散る/400KB', 4, 0.20, 23, 400),
  r('固まる/100KB', 4, 0.015, 27, 100),
], { best: 'よく散る/400KB', balanced: 'よく散る/400KB' });

console.log('[3] 使える距離の数が散らばりより先に来る');
check('距離5・散らばり1% が 距離4・散らばり30% に勝つ', [
  r('距離5', 5, 0.01, 20, 200),
  r('距離4', 4, 0.30, 60, 200),
], { best: '距離5' });

console.log('[4] 合計点数だけでは選ばない');
check('合計38点（距離4）が 合計92点（距離3）に勝つ', [
  r('合計92/距離3', 3, 0.20, 92, 200),
  r('合計38/距離4', 4, 0.20, 38, 200),
], { best: '合計38/距離4' });

console.log('[5] ファイルサイズは 10KB の許容幅。1KB の差で中身の悪い方を選ばない');
check('104KB と 105KB なら合計点数の多い方', [
  r('104KB/合計20', 4, 0.20, 20, 104),
  r('105KB/合計27', 4, 0.20, 27, 105),
], { balanced: '105KB/合計27' });

console.log('[6] サイズ案は距離を1つまで落としてよい');
check('距離3・50KB をサイズ案に選ぶ', [
  r('距離4/400KB', 4, 0.20, 40, 400),
  r('距離3/50KB', 3, 0.20, 20, 50),
  r('距離1/10KB', 1, 0.20, 5, 10),
], { best: '距離4/400KB', small: '距離3/50KB' });

console.log('\n[7] 3案の間で辻褄が合っているか（総当たり）');
// pick は3つを別々の並べ替えで選ぶので、食い違いが起きていないかを確かめる。
// 性能案が「質を落としていない候補」から外れる、バランス案が性能案より大きい、
// といった矛盾は、比較の物差しが揃っていないと実際に起きる。
const COV = [1, 2, 3, 4, 5];
const SPREAD = [0.005, 0.015, 0.05, 0.17, 0.33];
const SUM = [5, 23, 38, 92];
const KB = [10, 100, 104, 391, 611];
let n = 0;
for (let i = 0; i < 400; i++) {
  // 乱数は使わない（毎回同じケースを踏むように）。桁の違う素数で回す。
  const set = [];
  for (let j = 0; j < 4; j++) {
    const s = i * 4 + j;
    set.push(r('c' + j,
      COV[(s * 3) % COV.length],
      SPREAD[(s * 7) % SPREAD.length],
      SUM[(s * 11) % SUM.length],
      KB[(s * 13) % KB.length]));
  }
  const p = Search.pick(set);
  const msgs = [];
  if (p.balanced.coverage !== p.best.coverage) msgs.push('バランス案の距離が性能案と違う');
  if (p.balanced.kb > p.best.kb) msgs.push('バランス案が性能案より大きい');
  if (p.small.kb > p.balanced.kb) msgs.push('サイズ案がバランス案より大きい');
  if (p.small.coverage < Math.max(1, p.best.coverage - 1)) msgs.push('サイズ案が距離を2つ以上落としている');
  if (msgs.length) {
    bad++;
    if (n++ < 3) {
      console.log(`  NG  ${msgs.join(' / ')}`);
      console.log('      ' + JSON.stringify(set));
    }
  }
}
console.log(`  ${n ? 'NG ' : 'OK '} 400 通り（矛盾 ${n} 件）`);

console.log('\n判定: ' + (bad === 0 ? 'すべて合格' : `不合格（${bad} 件）`));
process.exit(bad === 0 ? 0 : 1);
