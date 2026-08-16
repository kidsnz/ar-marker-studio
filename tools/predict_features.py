#!/usr/bin/env python3
"""マーカーを生成せずに、画像から追従点を予測する（ARToolKit5 の完全再現）。

`parse_fset.py` は「生成した .fset を採点する」ツール。こちらは**生成前**に
同じ採点を出す。加えて `--heatmap` で「画像のどこが弱いのか」を可視化する。
絵を直す → 予測を見る、を生成の待ち時間なしで回すためのツール。

    python3 tools/predict_features.py <画像> --dpi 53
    python3 tools/predict_features.py <画像> --dpi 53 --heatmap out.png
    python3 tools/predict_features.py --self-test

再現しているのは ARToolKit5 の以下3つ（`docs/ar-marker-guide.md` 第10章に背景）:
  ar2GenImageSet   … 距離帯ごとの縮小画像（ブロック平均・整数除算）
  ar2GenFeatureMap … 勾配の極大点だけを候補にして、近傍との最大相関を測る
  ar2SelectFeature2… 相関の低い順に採り、周囲を塗り潰して間隔を空ける

【精度】12通り（画像9枚 × level 0〜4 × dpi 40〜150）を、実際の生成器のログと
全点・全距離帯で突き合わせて検証した（`--self-test` がその再検算）。
  7件 … 座標・点数・候補数まで1点残らず一致
  3件 … 点数・候補数は一致、値差 5e-6 の同着で座標が数点入れ替わる
  2件 … 数％ずれる（edo/01 のようなのっぺりした絵）

ずれの原因はすべて**生成器側の丸め誤差**。生成器は相関を float32 で 2025 画素ぶん
足し込むため、輝度SDが小さい領域（edo/01 のグラデ空は SD≒13）では桁落ちで
値が 1e-3 ほど動く。float32 の逐次加算で追試すると生成器のログの値を
小数点以下6桁まで再現できたので、こちらの float64 の方が数学的には正しい。
実測した食い違い（edo/01, level=4）:
  L0 160/164点  L1 128/128  L2 80/85  L3 48/48  L4 27/28
判定（安定/不足/暴れる）が変わるほどの差ではない。
"""

import argparse
import glob
import math
import os
import sys

import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import parse_fset

# ------------------------------------------------------------------
# ARToolKit5 の定数（include/AR2/config.h、util/genTexData/genTexData.c）
# ------------------------------------------------------------------
TS1 = TS2 = 22          # AR2_DEFAULT_TS1(11) × AR2_TEMP_SCALE(2)
TN = TS1 + TS2 + 1      # テンプレートは 45x45 の連続領域
SEARCH1 = 10            # 近傍探索の外側（21x21 の正方形。円ではない）
SEARCH2 = 2             # 近傍探索の内側（半径2の円板は除外 → ドーナツ状）
MAX_SIM_THRESH2 = 0.95  # featureMap 生成時の打ち切り。オプションで変えられない
SD_THRESH2 = 5.0        # 同上
NEAR_MAX_LIMIT = 0.99   # 「1〜2pxずらしても同じ」なら却下。ハードコードされている
FEATURE_RATIO = 0.02    # 勾配の極大点のうち、上位2%だけを候補にする
KPM_MINIMUM_IMAGE_SIZE = 28   # 最小の距離帯はこの画素数まで縮む

# -level が変えるのはこの4つだけ（max_thresh, min_thresh, sd_thresh, occ_size）
LEVELS = {
    0: (0.80, 0.70, 12.0, 24),
    1: (0.85, 0.65, 10.0, 24),
    2: (0.90, 0.55, 8.0, 16),   # 既定
    3: (0.98, 0.45, 6.0, 16),
    4: (0.98, 0.45, 6.0, 12),
}

F32 = np.float32


# ------------------------------------------------------------------
# 画像の読み込みと距離帯ごとの縮小（ar2GenImageSet）
# ------------------------------------------------------------------
def load_bw(path):
    """生成器が使うのと同じ白黒画像を作る。(画像, チャンネル数, アルファ有無) を返す。

    NFT-Marker-Creator は RGB の平均 (r+g+b)/3 を整数除算で取る。
    r==g==b の画像は「グレースケール」と判定して R だけを使う。
    """
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        return None, 0, False
    has_alpha = img.ndim == 3 and img.shape[2] == 4
    if img.ndim == 2:
        return img, 1, False
    if has_alpha:
        img = img[:, :, :3]
    b, g, r = img[:, :, 0], img[:, :, 1], img[:, :, 2]
    if np.array_equal(r, g) and np.array_equal(r, b):
        return r.copy(), 1, has_alpha
    bw = (r.astype(np.int32) + g.astype(np.int32) + b.astype(np.int32)) // 3
    return bw.astype(np.uint8), 3, has_alpha


def _lroundf(x):
    """C の lroundf（0から遠い方へ丸める）"""
    x = float(x)
    return int(math.floor(x + 0.5)) if x >= 0 else -int(math.floor(-x + 0.5))


def dpi_levels(img_w, img_h, dpi):
    """距離帯の dpi 一覧。genTexData の setDPI（min/max 未指定時）の再現。

    最小 dpi は「短辺が 28px まで縮む」ところ。そこから 2^(1/3) 倍ずつ上げる。
    """
    dpi = F32(dpi)
    # C: truncf( (28.0f/短辺) * dpi * 1000.0 ) / 1000.0f
    # truncf の引数は float なので、double で出た 4199.9998 が 4200.0 に丸め上がる。
    # ここを float64 のまま切り捨てると距離帯が全体に 0.02% ずれ、縮小画像が1px変わる
    ratio = F32(F32(KPM_MINIMUM_IMAGE_SIZE) / F32(min(img_w, img_h)) * dpi)
    dpi_min = F32(math.trunc(float(F32(float(ratio) * 1000.0))) / 1000.0)
    if dpi_min == dpi:
        return [float(dpi_min)]

    step = F32(2.0) ** F32(1.0 / 3.0)
    limit = F32(dpi * F32(0.95))
    w, num = dpi_min, 1
    while True:
        w = F32(w * step)
        if w >= limit:
            break
        num += 1
    num += 1

    out, w = [], dpi_min
    for _ in range(num):
        out.append(float(w))
        w = F32(w * step)
        if w >= limit:
            w = dpi
    return out[::-1]            # 高い dpi（＝原寸）が先頭


def scale_image(src, src_dpi, dst_dpi):
    """ar2GenImageLayer2: ブロック平均で縮小する（平均は整数除算で切り捨て）"""
    H, W = src.shape
    src_dpi, dst_dpi = F32(src_dpi), F32(dst_dpi)
    wx = _lroundf(F32(F32(W) * dst_dpi) / src_dpi)
    wy = _lroundf(F32(F32(H) * dst_dpi) / src_dpi)

    def bounds(n, limit):
        s = np.array([_lroundf(F32(F32(i) * src_dpi) / dst_dpi) for i in range(n)])
        e = np.array([min(_lroundf(F32(F32(i + 1) * src_dpi) / dst_dpi) - 1, limit - 1)
                      for i in range(n)])
        return s, e + 1

    x0, x1 = bounds(wx, W)
    y0, y1 = bounds(wy, H)
    integral = np.zeros((H + 1, W + 1), np.int64)
    integral[1:, 1:] = src.astype(np.int64).cumsum(0).cumsum(1)
    y0, y1 = y0[:, None], y1[:, None]
    x0, x1 = x0[None, :], x1[None, :]
    total = integral[y1, x1] - integral[y0, x1] - integral[y1, x0] + integral[y0, x0]
    return (total // ((y1 - y0) * (x1 - x0))).astype(np.uint8)


def band_ranges(dpis):
    """各距離帯の (mindpi, maxdpi)。genTexData が .fset に書く値と同じ。"""
    out = []
    for i, d in enumerate(dpis):
        lower = [x for x in dpis if x < d]
        upper = [x for x in dpis if x > d]
        mindpi = max(lower) if lower else d * 0.5
        maxdpi = (d * 0.8 + min(upper) * 0.2) if upper else d * 2.0
        out.append((mindpi, maxdpi))
    return out


# ------------------------------------------------------------------
# featureMap（ar2GenFeatureMap）
# ------------------------------------------------------------------
def _box(a, k):
    """k×k の移動和"""
    return cv2.boxFilter(a, -1, (k, k), normalize=False, borderType=cv2.BORDER_CONSTANT)


def gradient_candidates(bw):
    """候補画素を絞り込む。**ここが点数を決める最大の関門**。

    全画素の相関を計算するわけではない。まず勾配を取り、4近傍の極大点だけを
    残し（Extracted）、さらにその中で強い順に**画像の2%以内**に収まる分だけを
    候補にする（Filtered）。ここで落ちた画素は二度と特徴点にならない。
    """
    H, W = bw.shape
    p = bw.astype(np.int32)
    g = np.full((H, W), -1.0, dtype=np.float32)     # 外周は -1（＝対象外）
    dx = ((p[0:-2, 2:] - p[0:-2, 0:-2]) + (p[1:-1, 2:] - p[1:-1, 0:-2]) +
          (p[2:, 2:] - p[2:, 0:-2])).astype(np.float32) / F32(3.0 * 256)
    dy = ((p[2:, 2:] - p[0:-2, 2:]) + (p[2:, 1:-1] - p[0:-2, 1:-1]) +
          (p[2:, 0:-2] - p[0:-2, 0:-2])).astype(np.float32) / F32(3.0 * 256)
    g[1:-1, 1:-1] = np.sqrt((dx * dx + dy * dy) / F32(2.0))

    c = g[1:-1, 1:-1]
    nms = np.zeros((H, W), dtype=bool)
    nms[1:-1, 1:-1] = ((c > g[1:-1, 0:-2]) & (c > g[1:-1, 2:]) &
                       (c > g[0:-2, 1:-1]) & (c > g[2:, 1:-1]))

    # C は `(int)(*fp2 * 1000.0f)`。float32 のまま掛けてから切り捨てる。
    # float64 で掛けると、積がちょうど整数をまたぐ画素でビンが1つずれる
    bins = np.trunc((g * F32(1000.0)).astype(np.float64)).astype(np.int64)
    hist = np.bincount(np.clip(bins[nms], 0, 999), minlength=1000)
    acc, k = 0, -1
    for i in range(999, -1, -1):
        acc += hist[i]
        if acc / (H * W) >= FEATURE_RATIO:
            k = i
            break
    n_extracted = int(nms.sum())
    n_filtered = acc if k >= 0 else n_extracted
    return nms & (bins >= k), n_extracted, int(n_filtered)


def feature_map(bw):
    """ar2GenFeatureMap の再現。(featureMap, 輝度SD, 候補マスク, 候補数, 絞込後) を返す。

    featureMap の値は「半径2より外・半径10以内（21x21の正方形からくり抜いた
    ドーナツ）にある、いちばん似ている場所との相関」。小さいほど紛らわしくない。
    候補にならなかった画素は 1.0（＝使えない）。
    """
    H, W = bw.shape
    I = bw.astype(np.float64)
    n = TN * TN

    s1 = _box(I, TN)                       # Σx
    s2 = _box(I * I, TN)                   # Σx²
    var = s2 - s1 * s1 / n                 # Σ(x-μ)²
    sd = np.sqrt(np.maximum(var, 0.0) / n)

    cand, n_extracted, n_filtered = gradient_candidates(bw)

    valid = np.zeros((H, W), dtype=bool)   # テンプレートが画像内に収まる中心だけ
    valid[TS1:H - TS2, TS1:W - TS2] = True
    cand &= valid
    cand &= (var > 0)
    cand &= (var / n >= SD_THRESH2 ** 2)   # コントラスト不足は除外

    fmap = np.ones((H, W), dtype=np.float64)
    if not cand.any():
        return fmap, sd, cand, n_extracted, n_filtered

    best = np.full((H, W), -1.0)
    done = ~cand                           # 候補以外は計算しない
    ys, xs = np.mgrid[0:H, 0:W]
    for dy in range(-SEARCH1, SEARCH1 + 1):
        for dx in range(-SEARCH1, SEARCH1 + 1):
            if dx * dx + dy * dy <= SEARCH2 * SEARCH2:
                continue                   # 内側のドーナツの穴
            if done.all():
                break
            J = np.roll(np.roll(I, -dy, axis=0), -dx, axis=1)
            sj1 = np.roll(np.roll(s1, -dy, axis=0), -dx, axis=1)
            sj2 = np.roll(np.roll(s2, -dy, axis=0), -dx, axis=1)
            vj = sj2 - sj1 * sj1 / n
            with np.errstate(invalid='ignore', divide='ignore'):
                ncc = (_box(I * J, TN) - s1 * sj1 / n) / np.sqrt(var * vj)
            # ずらした先のテンプレートが画像外に出る位置は比較しない
            ok = ((ys + dy >= TS1) & (ys + dy < H - TS2) &
                  (xs + dx >= TS1) & (xs + dx < W - TS2) & (vj > 0))
            upd = (~done) & ok & (ncc > best)
            best[upd] = ncc[upd]
            done |= (best > MAX_SIM_THRESH2)   # 0.95 を超えたらそこで打ち切る

    fmap[cand] = best[cand]
    return fmap, sd, cand, n_extracted, n_filtered


def near_min_max(bw):
    """±2px（半径2の円板、中心を除く12点）との相関の最小・最大。

    最大が 0.99 を超える画素は「1〜2pxずらしても同じに見える」ので却下される。
    横線ばかりの絵はここで大量に落ちる。
    """
    H, W = bw.shape
    I = bw.astype(np.float64)
    n = TN * TN
    s1 = _box(I, TN)
    s2 = _box(I * I, TN)
    var = s2 - s1 * s1 / n

    mx = np.full((H, W), -1.0)
    mn = np.full((H, W), 1.0)
    for dy in range(-SEARCH2, SEARCH2 + 1):
        for dx in range(-SEARCH2, SEARCH2 + 1):
            if (dx == 0 and dy == 0) or dx * dx + dy * dy > SEARCH2 * SEARCH2:
                continue
            J = np.roll(np.roll(I, -dy, axis=0), -dx, axis=1)
            sj1 = np.roll(np.roll(s1, -dy, axis=0), -dx, axis=1)
            sj2 = np.roll(np.roll(s2, -dy, axis=0), -dx, axis=1)
            vj = sj2 - sj1 * sj1 / n
            with np.errstate(invalid='ignore', divide='ignore'):
                ncc = (_box(I * J, TN) - s1 * sj1 / n) / np.sqrt(var * vj)
            np.maximum(mx, ncc, out=mx)
            np.minimum(mn, ncc, out=mn)
    return mn, mx


# ------------------------------------------------------------------
# 点の選択（ar2SelectFeature2）
# ------------------------------------------------------------------
def select_features(bw, fmap, sd, level):
    """相関の低い順に採り、周囲 occ_size*2 を塗り潰して間隔を空ける。

    却下された画素はその1点だけが無効になる（周囲は塗り潰さない）ので、
    却下の条件は画素ごとに独立に先に判定してよい。
    """
    max_thresh, min_thresh, sd_thresh, occ_size = LEVELS[level]
    H, W = bw.shape
    occ = occ_size * 2                     # 内部で2倍される
    div_size = TN * 3
    max_feature_num = (W // occ) * (H // occ) + (W // div_size) * (H // div_size)

    near_mn, near_mx = near_min_max(bw)
    work = fmap.copy()
    work[sd < sd_thresh] = 1.0                                  # コントラスト不足
    work[near_mx > NEAR_MAX_LIMIT] = 1.0                        # ずらしても同じ
    work[(near_mn < min_thresh) & (near_mn < fmap)] = 1.0       # ずらすと崩れすぎ
    usable = work < max_thresh                                  # 採用されうる画素

    points = []
    while len(points) < max_feature_num:
        cy, cx = divmod(int(np.argmin(work)), W)
        if not work[cy, cx] < max_thresh:
            break
        points.append((cx, cy, float(work[cy, cx]), float(sd[cy, cx])))
        work[max(0, cy - occ):cy + occ + 1, max(0, cx - occ):cx + occ + 1] = 1.0
    return points, max_feature_num, usable


# ------------------------------------------------------------------
# 予測（全距離帯）
# ------------------------------------------------------------------
def predict(image_path, dpi, level, progress=False):
    """画像から全距離帯を予測する。parse_fset と同じ形の levels を返す。"""
    bw0, nc, has_alpha = load_bw(image_path)
    if bw0 is None:
        return None
    H, W = bw0.shape
    dpis = dpi_levels(W, H, dpi)
    bands = band_ranges(dpis)

    levels, detail = [], []
    for i, d in enumerate(dpis):
        bw = bw0 if i == 0 else scale_image(bw0, dpis[0], d)
        if progress and sys.stderr.isatty():
            print(f'  ... {i + 1}/{len(dpis)} ({bw.shape[1]}x{bw.shape[0]}, {d:.1f}dpi)'
                  .ljust(60), end='\r', file=sys.stderr)
        fmap, sd, cand, n_ext, n_fil = feature_map(bw)
        points, max_feature_num, usable = select_features(bw, fmap, sd, level)
        mindpi, maxdpi = bands[i]
        # parse_fset と同じ形にそろえる。5要素目は実寸(mm)の座標で、
        # 点の散らばりの判定に使う（.fset から読むときと同じ単位）
        nat_w_mm = W / dpis[0] * 25.4
        nat_h_mm = H / dpis[0] * 25.4
        coords = [((p[0] + 0.5) / bw.shape[1] * nat_w_mm,
                   (p[1] + 0.5) / bw.shape[0] * nat_h_mm) for p in points]
        levels.append((i, maxdpi, mindpi, len(points), coords))
        detail.append({'dpi': d, 'image': bw, 'fmap': fmap, 'sd': sd, 'cand': cand,
                       'usable': usable, 'points': points, 'extracted': n_ext,
                       'filtered': n_fil, 'max_feature_num': max_feature_num,
                       'mindpi': mindpi, 'maxdpi': maxdpi})
    if progress and sys.stderr.isatty():
        print(' ' * 60, end='\r', file=sys.stderr)
    return {'path': image_path, 'levels': levels, 'detail': detail, 'image': (W, H),
            'bw': bw0, 'nc': nc, 'has_alpha': has_alpha, 'dpi': dpi, 'level': level}


def level_for_dpi(detail, ap_dpi):
    """見かけ dpi がその距離帯に入るレベル。無ければいちばん近いもの。"""
    for i, d in enumerate(detail):
        if d['mindpi'] <= ap_dpi <= d['maxdpi']:
            return i
    return min(range(len(detail)), key=lambda i: abs(detail[i]['dpi'] - ap_dpi))


# ------------------------------------------------------------------
# ヒートマップ
# ------------------------------------------------------------------
def _use_japanese_font():
    import matplotlib
    from matplotlib import font_manager
    have = {f.name for f in font_manager.fontManager.ttflist}
    for name in ('Hiragino Sans', 'Hiragino Maru Gothic Pro', 'Noto Sans CJK JP', 'Osaka'):
        if name in have:
            matplotlib.rcParams['font.family'] = [name]
            return True
    return False


def draw_heatmap(result, out_path, band=0):
    """「どこが弱いか」を3面で描く。

    左  … 選ばれた追従点（この距離帯で実際に使われる点）
    中  … 候補画素の強さ（青=紛らわしくない＝良い、赤=紛らわしい）
    右  … 使える手がかりからの距離（赤い領域には追従の手がかりが無い）
    """
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.patheffects as pe
    from matplotlib.colors import Normalize

    _use_japanese_font()
    d = result['detail'][band]
    bw, fmap, cand, usable = d['image'], d['fmap'], d['cand'], d['usable']
    H, W = bw.shape
    occ = LEVELS[result['level']][3] * 2

    # 使える候補からどれだけ離れているか（占有半径 occ を単位にする）。
    # 外周 TS1 px はテンプレートが収まらず構造的に点が立たないので、判定から外す
    far = cv2.distanceTransform((~usable).astype(np.uint8), cv2.DIST_L2, 5) / occ
    far = np.minimum(far, 3.0)
    far[:TS1, :] = np.nan; far[H - TS2:, :] = np.nan
    far[:, :TS1] = np.nan; far[:, W - TS2:] = np.nan

    fig, axes = plt.subplots(1, 3, figsize=(16, 5.0 * H / W + 1.3))
    for ax in axes:
        ax.set_xticks([]); ax.set_yticks([])

    axes[0].imshow(bw, cmap='gray', vmin=0, vmax=255)
    for i, (x, y, v, s) in enumerate(d['points'], 1):
        axes[0].add_patch(plt.Circle((x, y), occ / 2, fill=False, color='#00c853', lw=1.2))
        axes[0].plot(x, y, '+', color='#00c853', ms=7, mew=1.4)
        axes[0].text(x + occ / 2 + 3, y, str(i), color='#00c853', fontsize=9, va='center',
                     path_effects=[pe.withStroke(linewidth=2, foreground='black')])
    axes[0].set_title(f'選ばれた追従点 {len(d["points"])} 点'
                      f'（上限 {d["max_feature_num"]}）', fontsize=11)

    axes[1].imshow(bw, cmap='gray', vmin=0, vmax=255, alpha=0.35)
    ys, xs = np.nonzero(cand)
    if len(xs):
        sc = axes[1].scatter(xs, ys, c=fmap[ys, xs], s=9, cmap='RdYlBu_r',
                             norm=Normalize(0.6, 1.0), linewidths=0)
        fig.colorbar(sc, ax=axes[1], fraction=0.046, label='近傍との相関（低いほど良い）')
    axes[1].set_xlim(0, W); axes[1].set_ylim(H, 0)
    axes[1].set_title(f'候補の強さ（候補 {int(cand.sum())} 画素 / '
                      f'使える {int(usable.sum())} 画素）', fontsize=11)

    axes[2].imshow(bw, cmap='gray', vmin=0, vmax=255)
    im = axes[2].imshow(far, cmap='RdYlBu_r', alpha=0.55, vmin=0, vmax=3)
    fig.colorbar(im, ax=axes[2], fraction=0.046, label='手がかりまでの距離（占有半径の倍数）')
    axes[2].set_title(f'弱い領域（赤いほど手がかりが無い）'
                      f'／外周 {TS1}px は構造的に対象外', fontsize=11)

    src_w, src_h = result['image']
    head = (f'{os.path.basename(result["path"])}   元画像 {src_w}x{src_h}px / '
            f'生成dpi {result["dpi"]:g} / -level={result["level"]}\n'
            f'この面は距離帯 {band}（{d["mindpi"]:.1f}〜{d["maxdpi"]:.1f} dpi、'
            f'{W}x{H}px に縮小したもの）')
    if result.get('report'):
        head += f'\n{result["report"]}'
    fig.suptitle(head, fontsize=11.5, y=0.99, va='top')
    fig.tight_layout(rect=[0, 0, 1, 0.95])
    fig.savefig(out_path, dpi=110)
    plt.close(fig)


# ------------------------------------------------------------------
# 検算（--self-test）
#
# 生成器のログと突き合わせて確認した事実を、コードの側で機械的に確かめる。
# 生成器がなくても走るように、実測値をここに埋め込んである。
# ------------------------------------------------------------------
SELF_TEST_NOTE = """
2026-08-11 に NFT-Marker-Creator（wasm 版）のログと1点ずつ突き合わせた実測値。
コマンド: node app.js -i ./in/<img>.png -o out -level=<n> -dpi=<dpi>
"""

# (画像, dpi, level, 距離帯ごとの点数, レベル0の Extracted/Filtered)
# コントラストのある絵。ここは1点の狂いもなく一致しなければならない
SELF_TEST_EXACT = [
    ('projects/atariar/markers/satoshi-tomiie-bassline/01.png', 53, 4,
     [2, 2, 1, 3, 3, 2, 1, 0, 0, 0], (16, 16)),
    ('projects/atariar/markers/satoshi-tomiie-bassline/03.png', 53, 4,
     [6, 7, 6, 7, 3, 3, 4, 1, 1, 0, 0, 0], (57, 57)),
    ('projects/atariar/markers/x/01.png', 72, 4,
     [15, 18, 17, 17, 14, 15, 9, 5, 5, 3, 1, 1, 0, 0, 0], (267, 267)),
    ('projects/atariar/markers/emoticons/01.png', 72, 2,
     [1, 2, 2, 3, 2, 2, 3, 0, 0, 0, 0, 0, 0], (5, 5)),
    ('projects/atariar/markers/pizzaboy/06.png', 72, 3,
     [11, 12, 9, 6, 4, 3, 5, 3, 1, 3, 1, 1, 0, 0, 0], (251, 251)),
    ('projects/atariar/markers/marslander/02.png', 96, 1,
     [5, 9, 7, 4, 6, 4, 4, 2, 2, 1, 1, 1, 0, 0, 0], (251, 251)),
    # dpi=60 は距離帯の計算が truncf の丸めに乗る境目。ここが崩れると縮小画像が1px変わる
    ('projects/atariar/markers/pizzaboy/07.png', 60, 4,
     [0, 35, 48, 43, 27, 12, 6, 4, 2, 0, 0, 0, 0], (0, 0)),
    ('projects/atariar/markers/pizzaboy/04.png', 40, 3,
     [5, 7, 9, 6, 4, 2, 2, 0, 0, 0], (38, 38)),
    # 1点も採れない絵（level=0 は厳しすぎる）。0点でも落ちないことの確認
    ('projects/atariar/markers/x/02.png', 72, 0,
     [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], (0, 0)),
]

# のっぺりした絵。生成器側の float32 の桁落ちでずれるので、数%までは許す。
# 候補数（Extracted/Filtered）は誤差が乗らないので、こちらは完全一致を要求する
SELF_TEST_TOLERANT = [
    ('projects/atariar/markers/edo/01.png', 72, 4,
     [164, 128, 85, 48, 28, 21, 14, 11, 5, 2, 2, 0, 0, 0], (49500, 7712)),
    ('projects/atariar/markers/edo/01.png', 72, 0,
     [14, 10, 10, 6, 2, 1, 1, 1, 1, 1, 1, 0, 0, 0], (49500, 7712)),
    ('projects/atariar/markers/emoticons/02.png', 150, 2,
     [14, 14, 11, 6, 9, 9, 5, 5, 3, 1, 0, 0, 0, 0, 0], (335, 335)),
]
TOLERANCE = 0.10        # 実測の最大ずれは 6%（85点に対し5点）


def _run_case(root, rel, dpi, level, expected, counts, tol, failures):
    path = os.path.join(root, rel)
    if not os.path.exists(path):
        failures.append(f'{rel} が無い')
        return
    r = predict(path, dpi, level)
    got = [lv[3] for lv in r['levels']]
    if len(got) != len(expected):
        ok = False
    elif tol == 0:
        ok = got == expected
    else:
        ok = all(abs(g - e) <= max(1, e * tol) for g, e in zip(got, expected))
    got_counts = (r['detail'][0]['extracted'], r['detail'][0]['filtered'])
    ok_counts = got_counts == counts
    print(f'  {"OK " if ok and ok_counts else "NG "} {rel}  -dpi={dpi:g} -level={level}'
          f'  候補 {got_counts[0]}/{got_counts[1]}'
          + ('' if tol == 0 else f'  （許容 {tol:.0%}）'))
    if not ok:
        failures.append(f'{rel} -level={level}: 予測 {got} / 実際 {expected}')
        print(f'      予測 {got}')
        print(f'      実際 {expected}')
    if not ok_counts:
        failures.append(f'{rel} -level={level}: 候補数 {got_counts}（実際 {counts}）')


def self_test(root=None):
    # 期待値テーブルの相対パスの基点。マーカーの実体は隣に並ぶ website リポジトリにある。
    # 道具は ar-marker-studio 側、作品のマーカーは website 側（2026-08-16 に整理）
    root = root or os.path.normpath(os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'website'))
    print('=== 検算: 実際の生成器のログと一致するか ===')
    print(SELF_TEST_NOTE)
    failures = []
    print('[1] コントラストのある絵（完全一致を要求する）')
    for rel, dpi, level, expected, counts in SELF_TEST_EXACT:
        _run_case(root, rel, dpi, level, expected, counts, 0, failures)
    print('[2] のっぺりした絵（生成器側の float32 の丸めでずれる既知のケース）')
    for rel, dpi, level, expected, counts in SELF_TEST_TOLERANT:
        _run_case(root, rel, dpi, level, expected, counts, TOLERANCE, failures)

    print()
    if failures:
        print(f'判定: 不合格（{len(failures)} 件）')
        for f in failures:
            print(f'  - {f}')
        return 1
    print('判定: すべて合格')
    return 0


# ------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description='マーカーを生成せずに、画像から追従点を予測する',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    ap.add_argument('images', nargs='*', help='元画像（png / jpg。グロブ可）')
    ap.add_argument('--dpi', type=float, default=72.0,
                    help='生成時に渡す -dpi（既定 72）。dpi = 画像幅px ÷ 実寸インチ')
    ap.add_argument('--level', type=int, default=4, choices=[0, 1, 2, 3, 4],
                    help='生成時に渡す -level（既定 4）')
    ap.add_argument('--size-mm', type=float, default=None,
                    help='別の実寸で刷る場合の幅(mm)')
    ap.add_argument('--heatmap', default=None,
                    help='ヒートマップの出力先（.png）。複数画像なら連番になる')
    ap.add_argument('--heatmap-band', type=int, default=None,
                    help='ヒートマップに描く距離帯の番号（既定は縦持ちで使う帯）')
    ap.add_argument('-q', '--quiet', action='store_true', help='距離帯の内訳を省く')
    ap.add_argument('--self-test', action='store_true',
                    help='生成器のログと一致するかを検算する')
    args = ap.parse_args()

    if args.self_test:
        return self_test()
    if not args.images:
        ap.print_help()
        return 1

    targets = []
    for p in args.images:
        targets.extend(sorted(glob.glob(p)) if any(c in p for c in '*?[') else [p])
    if not targets:
        print('対象の画像が見つからない')
        return 1

    for idx, path in enumerate(targets):
        result = predict(path, args.dpi, args.level, progress=True)
        if result is None:
            print(f'{path}: 画像を読めない')
            continue
        W, H = result['image']
        r = parse_fset.evaluate_levels(result['levels'], W, H,
                                       os.path.basename(path), args.size_mm)
        print(f'[予測] -dpi={args.dpi:g} -level={args.level}')
        parse_fset.report(r, verbose=not args.quiet)
        if result['has_alpha']:
            print('  !! この画像はアルファチャンネルを持っている。'
                  'NFT-Marker-Creator は RGBA の PNG を壊すので、')
            print('     生成前に必ず背景を白などで塗り潰して RGB / JPEG にすること'
                  '（docs/ar-marker-guide.md 第7章）')
            print()

        if args.heatmap:
            band = args.heatmap_band
            if band is None:
                band = level_for_dpi(result['detail'], r['portrait']['dpi'])
            elif not 0 <= band < len(result['detail']):
                print(f'  --heatmap-band は 0〜{len(result["detail"]) - 1} の範囲で指定する')
                continue
            result['report'] = (f'縦持ちの見かけ {r["portrait"]["dpi"]:.1f} dpi → '
                                f'使える点 {r["portrait"]["points"]} 点'
                                f'（{parse_fset.verdict(r["portrait"]["points"])}）')
            out = args.heatmap
            if len(targets) > 1:
                stem, ext = os.path.splitext(out)
                out = f'{stem}_{idx + 1:02d}{ext}'
            draw_heatmap(result, out, band)
            print(f'  ヒートマップを書き出した: {out}（距離帯 {band}: '
                  f'{result["detail"][band]["dpi"]:.1f} dpi）\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
