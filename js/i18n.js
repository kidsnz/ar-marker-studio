/*
 * i18n.js — 言語切り替え。
 *
 * 英語を原本にしている。index.html には英語をそのまま書き、
 * ここには日本語だけを持つ（翻訳が無ければ英語のまま出る）。
 * こうすると HTML を読むだけで内容が分かり、翻訳が古くなっても壊れない。
 *
 * 使い方:
 *   HTML  … <p data-i18n="some.key">English text</p>
 *   JS    … I18N.t('some.key', { n: 5 })   ← 第2引数は {n} の置換
 *
 * 既定は英語。切り替えると localStorage に覚える。
 */
(function (root) {
  'use strict';

  var JA = {
    // --- ヘッダー ---
    'head.lead1': 'NFT マーカーの品質が<strong>作る前に</strong>分かる。',
    'head.lead2': '追従点の数を距離帯ごとに予測し、絵のどこが弱いのかを示す。生成もこのページで終わる。',
    'lang.label': 'Language',

    // --- 1. 画像 ---
    'step1.title': '1. 元画像',
    'drop.main': '<strong>画像をドロップ</strong>、またはクリックして選ぶ',
    'drop.hint': 'PNG 推奨。JPEG も読めるが、生成器と数値がわずかに食い違う',
    'meta.size': '画素数',
    'meta.color': '色',
    'meta.format': '形式',
    'meta.gray': 'グレースケール（r=g=b）',
    'meta.rgb': 'カラー → (r+g+b)/3 で白黒化',
    'meta.png': 'PNG（自前でデコード＝生成器と同じ値）',
    'meta.jpeg': 'JPEG（canvas でデコード。生成器と数値がわずかに違う）',
    'alpha.warn': '<strong>この画像にはアルファチャンネルがある。</strong> '
      + 'NFT-Marker-Creator は RGBA の PNG を壊す（画像が横に繰り返され階調も反転した別物になる）。'
      + '生成する前に背景を白などで塗り潰して RGB にすること。',

    // --- 2. 設定 ---
    'step2.title': '2. 設定',
    'cfg.width': 'マーカーの実寸幅',
    'cfg.width.sub': '印刷したときの横幅。ここから dpi が決まる',
    'cfg.dpi.sub': '画像幅px ÷ 実寸インチ。実寸を変えると自動で入る',
    'cfg.level.sub': '追従点の密度。既定は2だが、基本は4にする',
    'cfg.leveli.sub': '検出側（.fset3）の密度。追従の安定性には効かない',
    'cfg.level0': '0（最も厳しい）',
    'cfg.level2': '2（生成器の既定）',
    'cfg.level4': '4（最も点が採れる。推奨）',
    'cfg.leveli1': '1（既定）',
    'cfg.presets': 'よくある実寸:',
    'cfg.p305': '12インチ 305mm',
    'cfg.p180': '7インチ 180mm',
    'cfg.p297': 'A4横 297mm',
    'cfg.p210': 'A4縦 210mm',
    'cfg.p100': 'ポストカード 100mm',
    'btn.run': '品質を判定する',

    // --- 3. 判定 ---
    'step3.title': '3. 判定',
    'tbl.caption': '距離帯ごとの追従点。<strong>合計は当てにならない。実際に使う帯の点数だけを見る</strong>',
    'tbl.range': '有効範囲 (dpi)',
    'tbl.px': '画素数',
    'tbl.pts': '点',
    'res.portrait': '縦持ち（実効{px}px）',
    'res.landscape': '横持ち（実効{px}px）',
    'res.portrait.short': '縦持ち',
    'res.landscape.short': '横持ち',
    'res.apparent': '見かけ {n} dpi →',
    'res.points': '点',
    'res.summary': '元画像 {w}×{h} / -dpi={dpi} / -level={level} → 実寸 {mw}×{mh} mm　　追従点の合計 {total} 点',
    'res.usedBy': '{who}で使う',
    'verdict.good': '安定',
    'verdict.mid': '不足ぎみ',
    'verdict.bad': '暴れる',
    'res.basis': 'ARnft が画像処理する解像度は 320×240 固定（ARnft.js の prepareImage）。'
      + '縦持ちでは映像が左右に黒帯で letterbox され実効 180×240 になる。'
      + '見かけdpi = min(実効幅px ÷ マーカー幅インチ, 240 ÷ マーカー高さインチ)。',
    'progress.band': '距離帯 {i}/{n}（{w}×{h}、{dpi}dpi）を計算中…',
    'progress.prep': '準備中…',
    'progress.final': 'まとめ中…',

    // --- 4. ヒートマップ ---
    'step4.title': '4. 絵のどこが弱いか',
    'hm.band': '見る距離帯',
    'tbl.rangeFmt': '{min} 〜 {max}',
    'hm.opt': '{i}: {dpi} dpi（{w}×{h}、{n}点）',
    'hm.note': '有効範囲 {min}〜{max} dpi ／ 候補 {cand} 画素、うち条件を満たすもの {usable} 画素 ／ 選ばれた点 {n}（上限 {max2}）',
    'hm.p1.title': '選ばれた追従点',
    'hm.p1.sub': '丸は占有半径。この中には他の点が入れない',
    'hm.p2.title': '候補の強さ',
    'hm.p2.sub': '青＝紛らわしくない（良い）　赤＝紛らわしい',
    'hm.p3.title': '弱い領域',
    'hm.p3.sub': '青＝手がかりが近い　赤＝手がかりが無い',
    'hm.p3.sub2': '外周22pxはテンプレートが収まらず構造的に対象外（灰色）',
    'tips.summary': '点を増やすには（すべて実測で確認した手）',
    'tips.1': '<b>ニアレストネイバーで2倍に拡大する。</b>最も効く。補間拡大は逆効果',
    'tips.2': '<b>-level=4 にする。</b>既定の2から上げるだけで倍近くになる',
    'tips.3': '<b>絵を粗くする。</b>大きな塊を離して複数置く。塊1個で数点増える',
    'tips.4': '<b>四辺すべてに構造を置く。</b>上下だけでは横方向の位置が決まらない',
    'tips.5': '<b>正方形か4:3にする。</b>横長は縦持ちで不利',
    'tips.6': '<b>グレーの階調を残す。</b>白黒2値化は大幅に悪化する',
    'tips.no': '効かないと分かっているもの: 細線・ディザ・二重線・破線、細い枠（縮小後3px未満）、'
      + '<code>-dpi</code> の変更（距離帯が動くだけ）、4倍拡大（2倍より悪い）。',

    // --- 5. 生成 ---
    'step5.title': '5. マーカーを生成する',
    'gen.hint': '本物の生成器（ARToolKit5 の genTexData）をこのページの中で動かす。サーバーには何も送らない。',
    'gen.name': 'ファイル名',
    'btn.gen': '生成してダウンロード',
    'gen.loading': '生成器を読み込み中…（初回は約1MB）',
    'gen.running': '生成中… {t}',
    'gen.done': '生成した（{s} 秒）。3つとも同じフォルダに置いて使う。',
    'gen.match': '予測と実際が全{n}帯で一致した。',
    'gen.mismatch': '予測と実際が {d}/{n} 帯で違った（実際: [{got}]）。'
      + 'のっぺりした絵では生成器側の丸め誤差で数%ずれることがある。',
    'gen.actual': '実際の .fset: [{got}]',

    // --- エラー ---
    'err.image': '画像を読めなかった: {m}',
    'err.dpi': 'dpi が正しくない',
    'err.calc': '計算に失敗した: {m}',
    'err.gen': '生成に失敗した: {m}',

    // --- フッター ---
    'foot.credit': '生成部分は <a href="https://github.com/Carnaux/NFT-Marker-Creator">Carnaux/NFT-Marker-Creator</a>（MIT）の成果物をそのまま使っている。'
      + '判定・ヒートマップは実際の生成器のログと突き合わせて検証した独自実装。',
    'foot.verify': '検算ページ',
    'foot.source': 'ソース',

    // --- 検算ページ ---
    'v.title': '検算',
    'v.lead': 'このページの計算結果が、<strong>本物の生成器の出力と一致するか</strong>を確かめる。'
      + '期待値は NFT-Marker-Creator を実際に走らせて、そのログから取った実測値（<code>test/fixtures.js</code>）。',
    'v.how': '使い方',
    'v.howto': 'マーカーの元画像が入ったフォルダを選ぶ。',
    'v.privacy': '画像はブラウザの外に出ない。全部この場で計算する。',
    'v.btn': '検算する',
    'v.results': '結果',
    'v.ready': 'フォルダを選ぶと始められる。',
    'v.loaded': '{n} 個のファイルを読み込んだ。「検算する」を押す。',
    'v.back': '← ツールに戻る',
    'v.missing': '{name} が選んだフォルダに無い',
    'v.working': '計算中…',
    'v.exact': '[1] コントラストのある絵（完全一致を要求する）',
    'v.tolerant': '[2] のっぺりした絵（生成器側の float32 の丸めでずれる既知のケース）',
    'v.tol': '（許容 {n}%）',
    'v.predicted': '        予測 [{v}]',
    'v.actual': '        実際 [{v}]',
    'v.candNg': '        NG 候補数 [{got}] / 実際 [{want}]',
    'v.pass': '判定: すべて合格',
    'v.fail': '判定: 不合格（{n} 件）'
  };

  var lang = 'en';

  function t(key, vars) {
    var s = (lang === 'ja' && JA[key] != null) ? JA[key] : (root.I18N_EN && root.I18N_EN[key]);
    if (s == null) s = key;
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, function (m, k) {
        return vars[k] != null ? vars[k] : m;
      });
    }
    return s;
  }

  /** data-i18n が付いた要素を今の言語で書き換える */
  function apply() {
    document.documentElement.lang = lang;
    var nodes = document.querySelectorAll('[data-i18n]');
    Array.prototype.forEach.call(nodes, function (el) {
      var key = el.getAttribute('data-i18n');
      if (!root.I18N_EN) root.I18N_EN = {};
      // 初回に HTML の英語を原本として控えておく
      if (root.I18N_EN[key] == null) root.I18N_EN[key] = el.innerHTML;
      el.innerHTML = t(key);
    });
    if (root.onI18nChange) root.onI18nChange();
  }

  function set(l) {
    lang = (l === 'ja') ? 'ja' : 'en';
    try { localStorage.setItem('ams-lang', lang); } catch (e) { /* 無視 */ }
    apply();
  }

  function init() {
    var saved = null;
    try { saved = localStorage.getItem('ams-lang'); } catch (e) { /* 無視 */ }
    lang = saved === 'ja' ? 'ja' : 'en';
    apply();
    var sel = document.getElementById('lang');
    if (sel) {
      sel.value = lang;
      sel.addEventListener('change', function () { set(sel.value); });
    }
  }

  root.I18N = { t: t, set: set, init: init, apply: apply,
                get lang() { return lang; } };
})(typeof self !== 'undefined' ? self : this);
