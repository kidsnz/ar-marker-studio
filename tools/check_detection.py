#!/usr/bin/env python3
"""マーカーが実際に「認識される」かを、刷らずに実測する。

parse_fset.py が測るのは**追従**（.fset）で、「認識した後、姿勢が安定するか」。
こちらが測るのは**検出**（.fset3）で、「そもそも認識するか、何cmまで離れられるか」。
2つは独立していて、症状の切り分けが違う。

本物の検出器（ARnft が中で使っているのと同じ WASM）に合成した映像を通す。
カメラもプリントも要らない。1条件あたり数ミリ秒。

使い方（ar-marker-studio のルートで実行する。作品側は隣の website リポジトリ）:
    python3 tools/check_detection.py ../website/projects/atariar/markers/edo/01 --size 305
    python3 tools/check_detection.py <prefix> --size 210x297      # 長方形
    python3 tools/check_detection.py <prefix> --size 305 --landscape
    python3 tools/check_detection.py <prefix> --size 305 --blur 1.0

    python3 tools/check_detection.py --self-test                  # 検算

  <prefix> は拡張子を付けない（.fset / .fset3 / .iset と元画像を自動で探す）。

準備（初回だけ）:
    cd tools && npm install

【何を測っているか】
マーカーを少しずつ小さく描いて、検出できなくなる大きさを探す。
小さくても検出できるほど、遠くから認識できるということ。
表示幅(px)と距離の関係は、既存の距離計算（parse_fset.py と同じ式）で換算する。

【縦持ちの再現】ARnft はスマホを縦持ちすると映像を左右に黒帯で letterbox して
320x240 に収める（実効 180x240）。ここでも同じ形の絵を作るので、
横持ちより不利になるという実機の条件がそのまま出る。

詳しい背景は docs/ar-marker-guide.md の第11章を参照。
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageFilter

import parse_fset

HERE = os.path.dirname(os.path.abspath(__file__))
# マーカーと camera_para.dat の実体は、隣に並ぶ website リポジトリの中にある。
# 道具は ar-marker-studio 側、作品のマーカーは website 側（2026-08-16 に整理）
SITE_ROOT = os.path.normpath(os.path.join(HERE, '..', '..', 'website'))
NODE_SCRIPT = os.path.join(HERE, 'nft_detect.js')
DEFAULT_CAMERA = os.path.join(SITE_ROOT, 'projects', 'atariar', 'data', 'camera_para.dat')

# 検出器が受け取る画像の大きさ。ARnft.js の prepareImage() が 320 固定で算出する値
CANVAS = (320, 240)

IMAGE_EXTS = ('.png', '.jpg', '.jpeg', '.PNG', '.JPG')

# 検出成功の下限。8点未満のインライアでは KPM が姿勢計算に進まない
# （FreakMatcher の kMinNumInliers。コンパイル時固定でオプションから変えられない）
MIN_INLIERS = 8


def find_source_image(prefix):
    """<prefix>.png / .jpg などを探す。"""
    for ext in IMAGE_EXTS:
        if os.path.exists(prefix + ext):
            return prefix + ext
    return None


def parse_size(text):
    """'305' か '210x297' を (幅mm, 高さmm) にする。"""
    if 'x' in text.lower():
        w, h = text.lower().split('x', 1)
        return float(w), float(h)
    v = float(text)
    return v, v


def video_area(portrait):
    """処理キャンバス(320x240)の中で、実際に映像が入っている領域。

    縦持ちは左右に黒帯が入るので 180x240。横持ちは全面 320x240。
    """
    return parse_fset.REGION_PORTRAIT if portrait else parse_fset.REGION_LANDSCAPE


def make_widths(img, area, steps=14):
    """試す表示幅(px)を、収まる最大から小さい方へ等比で並べる。"""
    aw, ah = area[0], area[1]   # 3つ目は焦点距離用の値なので使わない
    fit = min(aw, ah * img.width / img.height)
    top = int(fit)
    widths, w = [], top
    ratio = (20 / top) ** (1 / max(1, steps - 1))
    for _ in range(steps):
        iw = int(round(w))
        if iw < 12:
            break
        if not widths or iw < widths[-1]:
            widths.append(iw)
        w *= ratio
    return widths


def render(img, width_px, area, blur):
    """検出器に渡す1枚（320x240 の RGBA）を作る。

    背景は中間グレー。縦持ちの黒帯は ARnft の prepareImage が黒で塗るのに合わせる。
    """
    cw, ch = CANVAS
    # 領域は小数（可視率を掛けているため）。PIL は整数しか受けないので丸める
    aw, ah = int(round(area[0])), int(round(area[1]))
    frame = Image.new('RGB', (cw, ch), (0, 0, 0))          # 黒帯の部分
    inner = Image.new('RGB', (aw, ah), (144, 144, 144))    # 映像が写っている部分

    h_px = max(1, int(round(img.height * width_px / img.width)))
    scaled = img.resize((max(1, width_px), h_px), Image.LANCZOS)
    if blur:
        scaled = scaled.filter(ImageFilter.GaussianBlur(blur))
    inner.paste(scaled, ((aw - scaled.width) // 2, (ah - scaled.height) // 2))

    frame.paste(inner, ((cw - aw) // 2, (ch - ah) // 2))
    return frame.convert('RGBA').tobytes()


def run_detector(marker, camera, frames, attempts, cwd):
    """Node の検出器を1回だけ起動し、全フレームを流す。

    1プロセスに1コントローラという制約があるので（Emscripten Module が
    シングルトンで、2個目は初期化が完了しない）、まとめて渡す。
    """
    tmp = tempfile.mkdtemp(prefix='nftdetect-')
    try:
        paths = []
        for i, data in enumerate(frames):
            p = os.path.join(tmp, 'f%03d.rgba' % i)
            with open(p, 'wb') as f:
                f.write(data)
            paths.append(p)
        out = os.path.join(tmp, 'result.json')
        job = os.path.join(tmp, 'job.json')
        with open(job, 'w') as f:
            json.dump({'marker': os.path.relpath(marker, cwd),
                       'camera': os.path.relpath(camera, cwd),
                       'width': CANVAS[0], 'height': CANVAS[1],
                       'attempts': attempts, 'frames': paths, 'out': out}, f)

        proc = subprocess.run(['node', NODE_SCRIPT, job], cwd=cwd,
                              capture_output=True, text=True)
        if not os.path.exists(out):
            raise RuntimeError('検出器が結果を返さなかった\n'
                               + (proc.stderr or proc.stdout)[-1500:])
        with open(out) as f:
            results = json.load(f)
        # 検出器のログは stderr に出る（Emscripten の console.warn 経由）
        return results, inliers_from_log(proc.stderr, len(frames))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def inliers_from_log(text, count):
    """検出器のログからインライア数を拾う。

    `Page[0]  pre:247, aft:247, error = 0.467432` の 247 が、
    ホモグラフィを通った対応点の数。これが 8 未満だと検出が成立しない。
    数が大きいほど余裕がある。フレームの区切りは `##FRAME n` で入れてある。
    """
    per = [None] * count
    idx = None
    for line in text.splitlines():
        m = re.match(r'##FRAME (\d+)', line)
        if m:
            idx = int(m.group(1))
            continue
        m = re.search(r'Page\[\d+\]\s+pre:\s*(\d+)', line)
        if m and idx is not None and idx < count:
            n = int(m.group(1))
            if per[idx] is None or n > per[idx]:
                per[idx] = n
    return per


def distance_mm(width_px, marker_w_mm, area):
    """表示幅(px)から、その大きさに見える距離(mm)を出す。"""
    return parse_fset.focal_px(area) * marker_w_mm / width_px


def summarize(rows):
    """検出できた条件をまとめる。

    **検出は距離に対して連続しない。** 飛び地ができる（実測: 300px は駄目なのに
    220px では対応点62で通る、など）。「限界は◯px」と1つの数字で言うと嘘になるので、
    (a) 大きい方から連続して通った範囲 (b) 通った条件の総数 (c) 通った中で最小の幅
    の3つを返す。判定に使うのは主に (b)。
    """
    run = None
    for r in rows:
        if not r['found']:
            break
        run = r
    hits = [r for r in rows if r['found']]
    return {'run': run, 'count': len(hits), 'total': len(rows),
            'smallest': hits[-1] if hits else None}


def report(prefix, img, size_mm, portrait, blur, attempts, cwd, camera, quiet=False):
    """1つのマーカーを1つの持ち方で測って、結果を表示する。"""
    area = video_area(portrait)
    widths = make_widths(img, area)
    frames = [render(img, w, area, blur) for w in widths]
    results, inliers = run_detector(prefix, camera, frames, attempts, cwd)

    rows = []
    for w, r, inl in zip(widths, results, inliers):
        rows.append({'width': w, 'found': r.get('found', False),
                     'error': r.get('error'), 'inliers': inl,
                     'mm': distance_mm(w, size_mm[0], area)})

    if not quiet:
        name = os.path.basename(os.path.dirname(prefix)) + '/' + os.path.basename(prefix)
        print(f'\n{name}   {"縦持ち" if portrait else "横持ち"}'
              f'   元画像 {img.width}x{img.height}'
              f'   実寸 {size_mm[0]:.0f}x{size_mm[1]:.0f}mm'
              + (f'   ボケ {blur}px' if blur else ''))
        print(f'  映像の領域 {area[0]}x{area[1]}px'
              + ('（縦持ちは左右が黒帯）' if portrait else ''))
        print()
        print('   表示幅    距離     検出   対応点   誤差')
        for r in rows:
            mark = '○' if r['found'] else '×'
            inl = f"{r['inliers']:5d}" if r['inliers'] else '    -'
            err = f"{r['error']:.3f}" if r.get('error') is not None else '    -'
            print(f"  {r['width']:5d}px  {r['mm']/10:5.0f}cm    {mark}    {inl}   {err}")

    s = summarize(rows)
    if not quiet:
        print()
        if s['count'] == 0:
            print('  → 検出できなかった。画面いっぱいに写しても認識しない。')
        else:
            near = distance_mm(rows[0]['width'], size_mm[0], area)
            print(f"  → 通ったのは {s['count']}/{s['total']} 条件"
                  f"（対応点の下限は {MIN_INLIERS}）")
            if s['run']:
                print(f"  → 途切れずに認識できる距離 "
                      f"{near/10:.0f}cm 〜 {s['run']['mm']/10:.0f}cm")
            else:
                print('  → 手前から連続して認識できる範囲は無い（近くで取りこぼす）')
            if s['smallest'] is not s['run']:
                print(f"  → いちばん遠くで通ったのは {s['smallest']['mm']/10:.0f}cm"
                      f"（飛び地。途中に取りこぼしがある）")
    return rows


# ------------------------------------------------------------------
# 検算
# ------------------------------------------------------------------
GROUND_TRUTH = """
実機で確認済みの事実（satoshi-tomiie-bassline、307mm角で印刷）:
  - 01 … 認識も追従も不安定
  - 02 … ほぼ安定
  - 03 … 安定

【注意】検出できる条件は距離に対して連続しない。飛び地ができる。
なので「限界は◯px」では判定できない。**通った条件の数**で比べる。
"""


def self_test(cwd, camera):
    print(GROUND_TRUTH)
    base = os.path.join(cwd, 'projects', 'atariar', 'markers', 'satoshi-tomiie-bassline')
    hits = {}
    for n in ('01', '02', '03'):
        prefix = os.path.join(base, n)
        src = find_source_image(prefix)
        if not src:
            print(f'[skip] {prefix} の元画像が無い')
            return True
        rows = report(prefix, Image.open(src).convert('RGB'), (307.0, 307.0),
                      False, 0, 2, cwd, camera, quiet=True)
        s = summarize(rows)
        hits[n] = s['count']
        print(f"  {n}: {s['count']}/{s['total']} 条件で検出")

    ok = True
    print('\n[1] 3本とも1度は検出できるか（公開中で実際に動いているので、'
          'まったく検出できないのはおかしい）')
    if all(hits.values()):
        print('    → 3本とも検出できた')
    else:
        print('    → ★1度も検出できないものがある:', hits)
        ok = False

    print('[2] 01 < 02 < 03 の順に通る条件が増えるか（実機の体感と同じ順序）')
    if hits['01'] < hits['02'] < hits['03']:
        print(f"    → {hits['01']} < {hits['02']} < {hits['03']}  実機の体感と一致")
    else:
        print('    → ★順序が合わない:', hits)
        ok = False

    print('[3] 距離の換算が parse_fset.py と一致するか')
    area = parse_fset.REGION_PORTRAIT
    fit = parse_fset.fit_distance(area, 307.0, 307.0)
    got = distance_mm(area[0], 307.0, area)   # 幅いっぱいに写るときの距離
    if abs(fit - got) < 0.5:
        print(f'    → どちらも {fit/10:.1f}cm  一致')
    else:
        print(f'    → ★食い違う: fit_distance={fit:.1f} / distance_mm={got:.1f}')
        ok = False

    print('\n判定:', 'すべて合格' if ok else '★不合格')
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('prefix', nargs='?', help='マーカーのパス（拡張子なし）')
    ap.add_argument('--size', help='刷る実寸(mm)。"305" か "210x297"')
    ap.add_argument('--image', help='元画像。省略時は <prefix>.png / .jpg を探す')
    ap.add_argument('--camera', default=DEFAULT_CAMERA, help='camera_para.dat')
    ap.add_argument('--landscape', action='store_true', help='横持ちで測る（既定は縦持ち）')
    ap.add_argument('--both', action='store_true', help='縦持ちと横持ちの両方')
    ap.add_argument('--blur', type=float, default=0, help='ボケを足す(px)。実写に近づける')
    ap.add_argument('--attempts', type=int, default=4, help='1条件あたり何枚投げるか')
    ap.add_argument('--self-test', action='store_true', help='検算')
    args = ap.parse_args()

    cwd = SITE_ROOT
    camera = os.path.abspath(args.camera)

    if not os.path.exists(os.path.join(HERE, 'node_modules')):
        sys.exit('検出器が入っていない。先に:  cd tools && npm install')

    if args.self_test:
        sys.exit(0 if self_test(cwd, camera) else 1)

    if not args.prefix or not args.size:
        ap.error('prefix と --size が要る（例: tools/check_detection.py '
                 '../website/projects/atariar/markers/edo/01 --size 305）')

    prefix = os.path.abspath(args.prefix)
    for ext in ('.fset', '.fset3', '.iset'):
        if not os.path.exists(prefix + ext):
            sys.exit(f'{prefix + ext} が無い。prefix に拡張子を付けていないか確認する')

    src = args.image or find_source_image(prefix)
    if not src:
        sys.exit(f'{prefix} の元画像が見つからない。--image で指定する')
    img = Image.open(src).convert('RGB')
    size_mm = parse_size(args.size)

    modes = [True, False] if args.both else [not args.landscape]
    for portrait in modes:
        report(prefix, img, size_mm, portrait, args.blur, args.attempts, cwd, camera)
    print()


if __name__ == '__main__':
    main()
