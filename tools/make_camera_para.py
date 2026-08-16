#!/usr/bin/env python3
"""カメラ設定ファイル（camera_para.dat）を、別の向き・別の大きさ用に作り直す。

【なぜ要るか】
ARnft はスマホを縦に持つと、縦長の映像を 320x240 の横長画像の**真ん中に置いて
左右を黒く塗る**（実測: 600x800 の映像 → 映像部分は 180x240、左右70pxずつ黒）。
検出に使えるのが 180px しかないので、追従点が 3 点しか取れない。横持ちなら
320px 使えて 9 点になる。実機でも横持ちの方が明らかに安定する。

そこで黒帯をやめて縦長のまま 320x427 で渡したいのだが、画像が 4:3 でなくなるため
既存の 640x480 用の設定ファイルが使えない。自動伸縮すると縦横で伸び方が変わり、
ピクセルが正方形でなくなって姿勢計算が壊れる。

【値の求め方】
推測はしない。**同じレンズを 90 度回しただけ**なので、既存の値から導出できる。

    fx' = fy      cx' = cy
    fy' = fx      cy' = xsize - cx

そのあと目的の大きさに等倍で縮める。

使い方（ar-marker-studio のルートで実行する。作品側は隣の website リポジトリ）:
    python3 tools/make_camera_para.py ../website/projects/atariar/data/camera_para.dat \\
        --rotate --size 320x427 \\
        -o ../website/projects/atariar/data/camera_para_portrait.dat
    python3 tools/make_camera_para.py --self-test

【形式】ARToolKit5 ARParam、ビッグエンディアン、176 バイト
    int    xsize, ysize
    double mat[3][4]          カメラ行列（行優先）
    double dist_factor[9]     歪み: k1, k2, p1, p2, fx, fy, x0, y0, s
"""

import argparse
import os
import struct
import sys

SIZE = 176
HEAD = 8
MAT = 96          # 12 doubles
DIST = 72         # 9 doubles


def load(path):
    with open(path, 'rb') as f:
        d = f.read()
    if len(d) != SIZE:
        raise ValueError(f'{path}: {len(d)} バイト。176 バイトのはず')
    xsize, ysize = struct.unpack_from('>2i', d, 0)
    mat = list(struct.unpack_from('>12d', d, HEAD))
    dist = list(struct.unpack_from('>9d', d, HEAD + MAT))
    return {'xsize': xsize, 'ysize': ysize, 'mat': mat, 'dist': dist}


def save(p, path):
    d = struct.pack('>2i', p['xsize'], p['ysize'])
    d += struct.pack('>12d', *p['mat'])
    d += struct.pack('>9d', *p['dist'])
    assert len(d) == SIZE
    with open(path, 'wb') as f:
        f.write(d)


def rotate90(p):
    """レンズを 90 度回したときの設定にする（横向き → 縦向き）。

    画像が (x, y) → (y, W - x) と写るので、焦点距離は入れ替わり、
    中心は cx' = cy, cy' = W - cx になる。歪みの中心も同じ扱い。
    半径方向の係数(k1, k2)は回転で変わらない。接線方向(p1, p2)は入れ替わる。
    """
    m, d = p['mat'], p['dist']
    fx, cx = m[0], m[2]
    fy, cy = m[5], m[6]
    W = p['xsize']
    out = dict(p)
    out['xsize'], out['ysize'] = p['ysize'], p['xsize']
    out['mat'] = [fy, 0.0, cy, 0.0,
                  0.0, fx, W - cx, 0.0,
                  0.0, 0.0, 1.0, 0.0]
    # 歪み: k1, k2（半径方向）は回転で変わらない。
    # 接線方向 (p1, p2) は **(p1, p2) → (-p2, p1)**。単に入れ替えるだけだと鏡映になる。
    #   歪みベクトルも座標と同じように回るので (dx, dy) → (dy, -dx)。
    #   dx' = 2 p1' x' y' + p2'(r²+2x'²) に x'=y, y'=-x を入れて
    #   dy = p1(r²+2y²) + 2 p2 x y と係数を突き合わせると p2'=p1, p1'=-p2 になる。
    # fx,fy と x0,y0 は行列と同じ扱い。
    out['dist'] = [d[0], d[1], -d[3], d[2],
                   d[5], d[4], d[7], W - d[6], d[8]]
    return out


def resize(p, xsize, ysize):
    """等倍で縮める。縦横で比が違うとピクセルが正方形でなくなるので、そのときは拒否する。"""
    sx = xsize / p['xsize']
    sy = ysize / p['ysize']
    if abs(sx - sy) / max(sx, sy) > 0.01:
        raise ValueError(
            f"縦横の比が合わない（横 {sx:.4f} 倍 / 縦 {sy:.4f} 倍）。"
            f"このまま縮めるとピクセルが正方形でなくなり、姿勢計算が壊れる。\n"
            f"  元 {p['xsize']}x{p['ysize']} → 指定 {xsize}x{ysize}\n"
            f"  比を保つなら {xsize}x{round(p['ysize'] * sx)} を指定する")
    s = sx
    m, d = p['mat'], p['dist']
    out = dict(p)
    out['xsize'], out['ysize'] = xsize, ysize
    out['mat'] = [m[0] * s, m[1] * s, m[2] * s, m[3] * s,
                  m[4] * s, m[5] * s, m[6] * s, m[7] * s,
                  m[8], m[9], m[10], m[11]]
    out['dist'] = [d[0], d[1], d[2], d[3], d[4] * s, d[5] * s, d[6] * s, d[7] * s, d[8]]
    return out


def crop(p, x, y, xsize, ysize):
    """(x, y) を左上として切り取る。

    切り取っても**レンズは変わらない**ので焦点距離はそのまま。
    変わるのは光学中心の座標で、切り取った原点のぶんだけ引く。
    ここを忘れると姿勢が傾く（実際にやらかした。docs の第11章を参照）。

    【重要】上下左右を**対称に**切ること。
    ARnft の描画補正は「倍率」しか持たず「ずらし」が無いので、
    非対称に切ると表示がずれる。対称なら中心が画像の真ん中に留まるので合う。
    """
    if x < 0 or y < 0 or x + xsize > p['xsize'] or y + ysize > p['ysize']:
        raise ValueError(f"切り取りが元の外に出る: {p['xsize']}x{p['ysize']} から "
                         f"({x},{y}) {xsize}x{ysize}")
    m, d = p['mat'], p['dist']
    out = dict(p)
    out['xsize'], out['ysize'] = xsize, ysize
    out['mat'] = list(m)
    out['mat'][2] = m[2] - x        # cx
    out['mat'][6] = m[6] - y        # cy
    out['dist'] = list(d)
    out['dist'][6] = d[6] - x       # 歪みの中心 x0
    out['dist'][7] = d[7] - y       # 歪みの中心 y0
    return out


def describe(p, label=''):
    m = p['mat']
    import math
    fovx = 2 * math.degrees(math.atan(p['xsize'] / 2 / m[0]))
    fovy = 2 * math.degrees(math.atan(p['ysize'] / 2 / m[5]))
    return (f"{label}{p['xsize']}x{p['ysize']}  "
            f"fx={m[0]:.1f} fy={m[5]:.1f}  中心=({m[2]:.1f}, {m[6]:.1f})  "
            f"画角 横{fovx:.1f}度 縦{fovy:.1f}度")


# ------------------------------------------------------------------
def self_test():
    here = os.path.dirname(os.path.abspath(__file__))
    # camera_para.dat の実体は隣に並ぶ website リポジトリの中にある。
    # 道具は ar-marker-studio 側、作品のデータは website 側（2026-08-16 に整理）
    src = os.path.join(here, '..', '..', 'website',
                       'projects', 'atariar', 'data', 'camera_para.dat')
    if not os.path.exists(src):
        print('camera_para.dat が無い。検算できない。')
        return False
    ok = True
    p = load(src)
    print('元:', describe(p))

    print('\n[1] 読んで書き戻すと 1 バイトも変わらないか')
    import tempfile
    tmp = tempfile.mktemp(suffix='.dat')
    save(p, tmp)
    same = open(src, 'rb').read() == open(tmp, 'rb').read()
    os.unlink(tmp)
    print('    →', 'ぴったり一致' if same else '★変わってしまう')
    ok &= same

    print('[2] 4 回まわすと元に戻るか（90度 x 4 = 360度）。歪み係数も含めて')
    q = p
    for _ in range(4):
        q = rotate90(q)
    back = (q['xsize'] == p['xsize'] and q['ysize'] == p['ysize']
            and all(abs(a - b) < 1e-9 for a, b in zip(q['mat'], p['mat']))
            and all(abs(a - b) < 1e-12 for a, b in zip(q['dist'], p['dist'])))
    print('    →', '元に戻った' if back else f'★戻らない: {describe(q)}')
    ok &= back

    print('[2b] 2 回まわす（180度）と接線歪みの符号が反転するか')
    # 単に入れ替えるだけの実装（鏡映）だとここが通らない。回転なら (p1,p2)→(-p1,-p2)
    r2 = rotate90(rotate90(p))
    flipped = (abs(r2['dist'][2] + p['dist'][2]) < 1e-12
               and abs(r2['dist'][3] + p['dist'][3]) < 1e-12)
    print(f"    p1 {p['dist'][2]:+.6f} → {r2['dist'][2]:+.6f} / "
          f"p2 {p['dist'][3]:+.6f} → {r2['dist'][3]:+.6f}")
    print('    →', '反転している' if flipped else '★反転していない（鏡映になっている）')
    ok &= flipped

    print('[3] 回すと画角の縦横が入れ替わるか')
    r = rotate90(p)
    import math
    f0 = 2 * math.degrees(math.atan(p['xsize'] / 2 / p['mat'][0]))
    f1 = 2 * math.degrees(math.atan(r['ysize'] / 2 / r['mat'][5]))
    print(f'    元の横画角 {f0:.2f}度 / 回した後の縦画角 {f1:.2f}度')
    swapped = abs(f0 - f1) < 0.01
    print('    →', '入れ替わっている' if swapped else '★入れ替わっていない')
    ok &= swapped

    print('[4] 比の合わない大きさを拒否するか')
    try:
        resize(rotate90(p), 320, 240)
        print('    → ★通してしまった（壊れた設定を作りうる）')
        ok = False
    except ValueError:
        print('    → 拒否した')

    print('[5] 目的の 320x427 が正しく作れるか')
    out = resize(rotate90(p), 320, 427)
    print('   ', describe(out, '結果: '))
    # 画角は縮小で変わらないはず
    fov_before = 2 * math.degrees(math.atan(rotate90(p)['xsize'] / 2 / rotate90(p)['mat'][0]))
    fov_after = 2 * math.degrees(math.atan(out['xsize'] / 2 / out['mat'][0]))
    keep = abs(fov_before - fov_after) < 0.2
    print('    → 画角が保たれている' if keep else f'    → ★画角が変わった {fov_before:.2f} → {fov_after:.2f}')
    ok &= keep

    print('[6] 対称に切ると光学中心が画像の真ん中に残るか')
    q = resize(rotate90(p), 600, 800)                 # 実際の映像の大きさ
    cw, ch = 452, 452                                 # 見えている正方形
    r = crop(q, (600 - cw) // 2, (800 - ch) // 2, cw, ch)
    r = resize(r, 320, 320)
    off = max(abs(r['mat'][2] - 160), abs(r['mat'][6] - 160))
    print('   ', describe(r, '結果: '))
    print(f'    → 中心のずれ {off:.1f}px', '（許容内）' if off < 5 else '★大きすぎる')
    ok &= off < 5

    print('\n判定:', 'すべて合格' if ok else '★不合格')
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('src', nargs='?', help='元の camera_para.dat')
    ap.add_argument('--rotate', action='store_true', help='90 度回す（横向き → 縦向き）')
    ap.add_argument('--video', help='実際の映像の大きさ "600x800"（先に等倍で合わせる）')
    ap.add_argument('--crop', help='切り取る領域 "x,y,幅,高さ"（--video のあと）')
    ap.add_argument('--size', help='最後に縮める大きさ "320x320"')
    ap.add_argument('-o', '--out', help='出力先')
    ap.add_argument('--self-test', action='store_true', help='検算')
    args = ap.parse_args()

    if args.self_test:
        sys.exit(0 if self_test() else 1)
    if not args.src:
        ap.error('元の camera_para.dat を指定する')

    p = load(args.src)
    print(describe(p, '元:   '))
    if args.rotate:
        p = rotate90(p)
        print(describe(p, '回転: '))
    if args.video:
        w, h = (int(v) for v in args.video.lower().split('x'))
        p = resize(p, w, h)
        print(describe(p, '映像: '))
    if args.crop:
        x, y, w, h = (int(v) for v in args.crop.split(','))
        p = crop(p, x, y, w, h)
        print(describe(p, '切取: '))
    if args.size:
        w, h = (int(v) for v in args.size.lower().split('x'))
        p = resize(p, w, h)
        print(describe(p, '縮小: '))
    if args.out:
        save(p, args.out)
        print('書き出し:', args.out)
    else:
        print('※ -o を付けると書き出す')


if __name__ == '__main__':
    main()
