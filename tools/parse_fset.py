#!/usr/bin/env python3
"""ARマーカー（.fset）の品質を、実機に持っていく前に数値で判定する。

NFTマーカーが「認識はするのに姿勢が暴れる」とき、原因はほぼ追従点の不足。
ただし合計点数を見ても意味がない。**実際に使う距離帯にいくつ点があるか**が全て。

使い方（ar-marker-studio のルートで実行する。作品側は隣の website リポジトリ）:
    python3 tools/parse_fset.py ../website/projects/atariar/markers/edo/01.fset
    python3 tools/parse_fset.py "../website/projects/atariar/markers/*/*.fset" -q  # 一括比較
    python3 tools/parse_fset.py <path>.fset --size-mm 305                # 実寸を変えて試算
    python3 tools/parse_fset.py --self-test                              # 検算

【最重要】ARnft が画像処理する画布は 320x240 で固定。
ARnft.js の prepareImage() に 320 がハードコードされており、カメラが何を返しても
ここまで縮められる。「カメラは640px」ではない。この前提を間違えると判定が3.5倍ずれる。

そこから2段階で減る。両方を数えないと必ず過大評価になる（ガイド第12章）。
  1. 映像が画布にどう載るか。素の ARnft は縦持ちで左右に黒帯を入れるので 180x240
     しか使えない。本番は回転版(ARnft-rot.js)で、映像を90度回すので 240x320 使える
  2. object-fit: cover。映像の約1/4は画面の外にあり、見えないところにマーカーは置けない
実効は 縦持ち(回転版) 181x320 ／ 縦持ち(黒帯) 136x240 ／ 横持ち 320x181。

詳しい背景は docs/ar-marker-guide.md を参照。
"""

import argparse
import glob
import math
import os
import struct
import sys

# ------------------------------------------------------------------
# .fset のフォーマット（ARToolKit5 AR2FeatureSetT、リトルエンディアン）
#   int   レベル数
#   各レベル: int scale, float maxdpi, float mindpi, int 点数
#             その後 点数 × AR2FeatureCoordT(= float x, y, mx, my, maxSim = 20バイト)
#   ※ maxdpi が先。逆に読むと距離帯の判定が反転する
# ------------------------------------------------------------------
COORD_SIZE = 20
LEVEL_HEADER = '<iffi'
LEVEL_HEADER_SIZE = 16

# ARnft の画布（prepareImage が 320 固定）。向きに関係なくこの大きさ
PROCESS = (320, 240)


def visible_fraction(video_w, video_h, screen_w, screen_h):
    """object-fit: cover で映像のどれだけが画面に映っているか。

    細い方の軸が切られ、もう一方は丸ごと見えている。片方は必ず 1.0 になる。
    """
    vr, sr = video_w / video_h, screen_w / screen_h
    return (sr / vr, 1.0) if vr > sr else (1.0, vr / sr)


# 既定の可視率。ガイド第12章で実機確認した条件（映像600x800、画面375x664）
VISIBLE_PORTRAIT = visible_fraction(600, 800, 375, 664)    # (0.753, 1.0)
VISIBLE_LANDSCAPE = visible_fraction(800, 600, 664, 375)   # (1.0, 0.753)


def region_for(mode, vis=None):
    """判定に使える画素数を返す。

    3つ目は「切り取られる前」の映像の長辺（画布上の画素数）。
    焦点距離はレンズと画布で決まるもので、画面に何が映っているかとは関係ないため、
    可視率を掛けてはいけない。
    """
    canvas = {'rotate': (240, 320), 'letterbox': (180, 240)}.get(mode, (320, 240))
    if vis is None:
        vis = VISIBLE_LANDSCAPE if mode == 'landscape' else VISIBLE_PORTRAIT
    return (canvas[0] * vis[0], canvas[1] * vis[1], max(canvas))


# 既定の判定領域。縦持ちは回転版（本番の実装）を前提にする
REGION_PORTRAIT = region_for('rotate')                 # 実効 181 x 320
REGION_PORTRAIT_LETTERBOX = region_for('letterbox')    # 素の ARnft: 136 x 240
REGION_LANDSCAPE = region_for('landscape')             # 実効 320 x 181

# 判定の目安（実機で確認した体感と対応させた値。詳細は下の GROUND_TRUTH）
GOOD = 12     # これ以上あれば安定して見える
POOR = 5      # これ未満は姿勢が飛ぶ

# ------------------------------------------------------------------
# 実行時（追従）の仕様。ARToolKit5 の lib/SRC/AR2/tracking.c と
# selectTemplate.c を読んで確認した値。「何点あればいいのか」を決めている本体。
#
# 【注意】ARToolKit5 の既定値をそのまま使ってはいけない。
# 私たちが実際に動かしている jsartoolkitNFT は、起動時に setupAR2() で上書きする
# （emscripten/ARToolKitNFT_js.cpp）:
#     ar2SetTrackingThresh(5.0) / ar2SetSimThresh(0.50) / ar2SetSearchFeatureNum(16)
#     ar2SetSearchSize(6) / ar2SetTemplateSize1(6) / ar2SetTemplateSize2(6)
# ------------------------------------------------------------------
TRACK_MIN = 3        # これを切ると追従が止まる（tracking.c の `if(num < 3) return -3`）
TRACK_PER_FRAME = 16  # 1フレームで試す点の数。既定の10ではなく setupAR2() の16
EDGE_MARGIN = 1 / 8   # 画面の外周1/8にある点は絶対に選ばれない（ar2SelectTemplate）


def convex_hull(pts):
    """凸包（monotone chain）。最大四角形の頂点は必ず凸包の上にある"""
    if len(pts) < 4:
        return list(pts)
    p = sorted(set(pts))
    if len(p) < 4:
        return p

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for q in p:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], q) <= 0:
            lower.pop()
        lower.append(q)
    upper = []
    for q in reversed(p):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], q) <= 0:
            upper.pop()
        upper.append(q)
    return lower[:-1] + upper[:-1]


def spread_area(pts):
    """点の散らばり具合。凸包の面積（マーカー全体を 1 とした割合）を返す。

    **これは思いつきの指標ではない。** ar2SelectTemplate は追従の最初の4点を
      1点目 = 画面中心から最も遠い点
      2点目 = 1点目から最も遠い点
      3点目 = 1〜2点目を結ぶ線から最も離れた点
      4点目 = 四角形の面積が最大になる点
    という順で選ぶ。つまり実行時は「点が作る四角形の面積」を最大化している。
    凸包の面積はその上限で、凸包がちょうど四角形のときは一致する。
    同じ点数でも固まっていれば小さい四角形しか作れず、姿勢が不安定になる。

    実測（satoshi の3枚、縦持ち）:
      1% = 大小に飛ぶ / 17% = ほぼ安定 / 33% = 安定

    【2026-08-15 撤回】この目安を合否の基準に使ってはいけない。
    例を7本に増やすと、安定なものの散らばりが 1.8%〜22.4% とばらばらで
    何も予測しなかった（satoshi の3枚では点数と散らばりが一緒に動いていただけ）。
    合否は「3点の下限」だけで判定し、散らばりは参考値として添えるだけにする。
    """
    h = convex_hull(pts)
    if len(h) < 3:
        return 0.0
    n = len(h)
    return abs(sum(h[i][0] * h[(i + 1) % n][1] - h[(i + 1) % n][0] * h[i][1]
                   for i in range(n))) / 2


def selectable(pts):
    """実行時が実際に選びうる点だけに絞る（画面の外周1/8は選ばれない）"""
    return [p for p in pts
            if EDGE_MARGIN <= p[0] <= 1 - EDGE_MARGIN
            and EDGE_MARGIN <= p[1] <= 1 - EDGE_MARGIN]


def parse_fset(path):
    """.fset をパースして [(scale, maxdpi, mindpi, 点数), ...] を返す。壊れていれば None。"""
    with open(path, 'rb') as f:
        data = f.read()

    if len(data) < 4:
        return None

    offset = 0
    (num_levels,) = struct.unpack_from('<i', data, offset)
    offset += 4
    if not 0 < num_levels < 64:
        return None

    levels = []
    for _ in range(num_levels):
        try:
            scale, maxdpi, mindpi, num = struct.unpack_from(LEVEL_HEADER, data, offset)
        except struct.error:
            return None
        offset += LEVEL_HEADER_SIZE
        if num < 0 or offset + num * COORD_SIZE > len(data):
            return None
        # 各点の実寸座標（mm）。点の散らばり具合の判定に使う
        coords = []
        for i in range(num):
            _x, _y, mx, my, _sim = struct.unpack_from('<5f', data, offset + i * COORD_SIZE)
            coords.append((mx, my))
        offset += num * COORD_SIZE
        levels.append((scale, maxdpi, mindpi, num, coords))

    # 末尾ぴったりで終わらなければフォーマット違い
    if offset != len(data):
        return None
    return levels


# ------------------------------------------------------------------
# 検出側（.fset3）
#
# NFT は2段構え。追従（.fset）と検出（.fset3）は別物で、症状の切り分けが違う。
#   そもそも認識しない       → .fset3（検出）が弱い
#   認識はするが姿勢が暴れる → .fset（追従）の点が足りない
#
# ここでは距離帯ごとの検出キーポイント数だけを出す。0点の帯は
# その距離で「そもそも認識できない」ことを意味する。
#
# 記述子を使った「繰り返し模様」の判定は**やらない**。閾値を決める材料
# （検出に失敗する実例）が取れなかったため。詳細は docs/ar-marker-guide.md 第2章。
# ------------------------------------------------------------------
FREAK_FEATURE_SIZE = 108          # 記述子96バイト + angle(4) + scale(4) + maxima(4)
FSET3_REC = 8 + 8 + FREAK_FEATURE_SIZE + 4 + 4      # 1点あたり132バイト


# ダミー段の段番号。tools/fix_fset3.py が検出器の不具合を避けるために挿す、
# 点を1つも持たない段。実データの段番号は 0 から連番なのでぶつからない。
# 中身のある段ではないので、ここでは一覧から除く。
DUMMY_IMAGE_NO = 9999


def parse_fset3(path):
    """.fset3 を読んで [(段番号, 幅, 高さ, 点数), ...] を返す。読めなければ None。"""
    if not os.path.exists(path):
        return None
    with open(path, 'rb') as f:
        return parse_fset3_raw(f.read())


def parse_fset3_raw(d):
    """.fset3 のバイト列を読む。

    形式は実ファイルで検算済み（全マーカーで末尾ぴったりに収まることを確認）。
    """
    if len(d) < 8:
        return None

    (total,) = struct.unpack_from('<i', d, 0)
    if total < 0 or 4 + total * FSET3_REC + 4 > len(d):
        return None

    # 各点がどの段のものかを数える
    per_image = {}
    base = 4 + 8 + 8 + FREAK_FEATURE_SIZE + 4
    for i in range(total):
        (no,) = struct.unpack_from('<i', d, base + i * FSET3_REC)
        per_image[no] = per_image.get(no, 0) + 1

    off = 4 + total * FSET3_REC
    (page_num,) = struct.unpack_from('<i', d, off)
    off += 4
    if not 0 <= page_num <= 64:
        return None

    levels = []
    for _ in range(page_num):
        if off + 8 > len(d):
            return None
        off += 4                                   # pageNo は使わない
        (image_num,) = struct.unpack_from('<i', d, off)
        off += 4
        if image_num < 0 or off + image_num * 12 > len(d):
            return None
        for _ in range(image_num):
            w, h, no = struct.unpack_from('<3i', d, off)
            off += 12
            if no == DUMMY_IMAGE_NO:               # 中身のないダミー段は数えない
                continue
            levels.append((no, w, h, per_image.get(no, 0)))
    if off != len(d):                              # 末尾ぴったりで終わらなければ形式違い
        return None
    return sorted(levels)


def image_size(base):
    """マーカー生成に使われた画像の寸法を .iset から読む。外部ライブラリは使わない。

    隣にある .png（ガイド表示用）を読んではいけない。生成時に2倍に拡大している場合、
    ガイド画像は拡大前の寸法なので、実寸の計算が2倍ずれる。
    .iset は「int num + レベル0のJPEG + float dpi×(num-1)」という構造で、
    そのJPEGが生成時の解像度そのもの（ARToolKit5 imageSet.c の ar2WriteImageSet）。
    """
    path = base + '.iset'
    if not os.path.exists(path):
        return None
    with open(path, 'rb') as f:
        f.read(4)                                  # int num を読み飛ばす
        if f.read(2) != b'\xff\xd8':               # JPEG の開始マーカー
            return None
        while True:
            b = f.read(1)
            if not b:
                return None
            if b != b'\xff':
                continue
            marker = f.read(1)
            if not marker:
                return None
            if marker in (b'\xc0', b'\xc1', b'\xc2', b'\xc3'):   # SOF: ここに寸法がある
                f.read(3)                          # 長さ2バイト + 精度1バイト
                h, w = struct.unpack('>HH', f.read(4))
                return w, h
            if marker == b'\xff' or marker == b'\x00':
                continue
            head = f.read(2)
            if len(head) < 2:
                return None
            (seglen,) = struct.unpack('>H', head)
            f.seek(seglen - 2, 1)


def declared_dpi(levels):
    """生成時に指定された dpi。最上位レベルの maxdpi はその2倍になる。"""
    return max(lv[1] for lv in levels) / 2.0


def apparent_dpi(marker_w_mm, marker_h_mm, region):
    """マーカーが処理領域に収まって写るときの見かけdpi。

    縦横比によって幅で決まるか高さで決まるかが変わる。
    正方形のマーカーは高さで決まるため、4:3 のマーカーより見かけdpiが下がる。
    """
    region_w, region_h = region[0], region[1]
    w_inch = marker_w_mm / 25.4
    h_inch = marker_h_mm / 25.4
    return min(region_w / w_inch, region_h / h_inch)


def usable_points(levels, ap):
    """見かけdpi ap のとき、実際に使える追従点の数。"""
    return sum(lv[3] for lv in levels if lv[2] <= ap <= lv[1])


# ------------------------------------------------------------------
# 使える距離（ar2GetResolution2 と同じ考え方）
# ------------------------------------------------------------------
# ARnft が標準で使う camera_para.dat（website/projects/atariar/data/camera_para.dat）は
# 640x480 基準で fx=609.37, fy=606.52。長辺方向の画角は 2*atan(320/609.37)=55.4度。
# 別のレンズを使う場合は距離が比例してずれる。
CAMERA_FOV_LONG = 55.4


def focal_px(region):
    """処理キャンバス上での焦点距離(px)。

    画角はセンサー全体のものなので、映像の長辺が画布の何画素に載るかで決まる。
    画面に映っていない部分もレンズは写しているので、可視率を掛けてはいけない。
    region_for() が3つ目に入れている値がそれ。素の (w, h) なら長辺で代用する。
    """
    long_px = region[2] if len(region) > 2 else max(region)
    return (long_px / 2) / math.tan(math.radians(CAMERA_FOV_LONG / 2))


def dpi_at_distance(region, z_mm):
    """距離 z(mm) から見たときの見かけ dpi。"""
    return focal_px(region) / z_mm * 25.4


def fit_distance(region, w_mm, h_mm):
    """マーカー全体が画面に収まる最短距離(mm)。これより近いとはみ出す。"""
    f = focal_px(region)
    return max(f * w_mm / region[0], f * h_mm / region[1])


def usable_range(levels, region, w_mm, h_mm, min_points):
    """min_points 以上の点がある距離の範囲(mm)。

    **点数は距離に対して滑らかに減らない。** 距離帯どうしの重なり方が不規則なので
    点数は上下に飛ぶ（実測: 39cm=14点 / 41cm=8点 / 49cm=12点）。
    「最小〜最大」を返すと嘘になるので、いちばん長く連続している区間と、
    区間がいくつに分かれているかを返す。見つからなければ None。
    """
    fit = fit_distance(region, w_mm, h_mm)
    best = cur = None
    segments = 0
    z = max(100, int(math.ceil(fit / 10)) * 10)
    while z <= 5000:
        if usable_points(levels, dpi_at_distance(region, z)) >= min_points:
            if cur is None:
                cur = [z, z]
                segments += 1
            else:
                cur[1] = z
        elif cur is not None:
            if best is None or cur[1] - cur[0] > best[1] - best[0]:
                best = cur
            cur = None
        z += 10
    if cur is not None and (best is None or cur[1] - cur[0] > best[1] - best[0]):
        best = cur
    if best is None:
        return None
    return {'min': best[0], 'max': best[1], 'fit': fit, 'segments': segments}


def points_at(levels, ap, w_mm, h_mm, strict=True):
    """見かけdpi ap で使われる帯の点を、マーカー全体を 1x1 とした座標で集める。

    strict=False にすると実行時のフォールバック範囲 [mindpi/2, maxdpi*2] まで広げる
    （extractVisibleFeatures は本来の帯に点が無いとこの範囲で再検索する）。
    """
    out = []
    for lv in levels:
        if len(lv) < 5:
            continue
        lo = lv[2] if strict else lv[2] / 2
        hi = lv[1] if strict else lv[1] * 2
        if not (lo <= ap <= hi):
            continue
        for mx, my in lv[4]:
            out.append((mx / w_mm, my / h_mm))
    return out


def evaluate_levels(levels, img_w, img_h, name, size_mm=None, path=None):
    """距離帯の一覧と元画像の寸法から評価 dict を作る。

    predict_features.py（生成せずに予測する側）からも呼ぶので、
    ファイルの読み込みとは切り離してある。
    """
    # 生成時に宣言された実寸。--size-mm があればそちらを優先（別サイズで刷る場合の試算）
    D = declared_dpi(levels)
    if D <= 0:
        return None
    nat_w_mm = img_w / D * 25.4
    nat_h_mm = img_h / D * 25.4
    if size_mm:
        scale = size_mm / nat_w_mm
        w_mm, h_mm = nat_w_mm * scale, nat_h_mm * scale
    else:
        w_mm, h_mm = nat_w_mm, nat_h_mm

    result = {
        'path': path,
        'name': name,
        'levels': levels,
        'total': sum(lv[3] for lv in levels),
        'image': (img_w, img_h),
        'declared_dpi': D,
        'size_mm': (w_mm, h_mm),
    }
    # 実寸は --size-mm で変わるが、点の座標の「割合」は変わらないので nat_ を使う
    for label, region in (('portrait', REGION_PORTRAIT), ('landscape', REGION_LANDSCAPE)):
        ap = apparent_dpi(w_mm, h_mm, region)
        strict = points_at(levels, ap, nat_w_mm, nat_h_mm, True)
        loose = points_at(levels, ap, nat_w_mm, nat_h_mm, False)
        sel = selectable(strict)
        result[label] = {
            'dpi': ap,
            'points': usable_points(levels, ap),
            'fallback': len(loose),      # 実行時のフォールバック込み
            'selectable': len(sel),      # 外周1/8を除いて、実際に選ばれうる点
            'spread': spread_area(sel),    # 点の散らばり（凸包の面積）
        }
    return result


def evaluate(path, size_mm=None):
    """1つの .fset を評価して dict を返す。判定できなければ None。"""
    levels = parse_fset(path)
    if levels is None:
        return None

    base = path[:-5] if path.endswith('.fset') else path
    size = image_size(base)
    if size is None:
        return None
    img_w, img_h = size
    name = os.path.basename(os.path.dirname(path)) + '/' + os.path.basename(base)
    r = evaluate_levels(levels, img_w, img_h, name, size_mm, path)
    if r is not None:
        r['detect'] = parse_fset3(base + '.fset3')     # 検出側。無ければ None
    return r


def verdict(points):
    """**3点を切ると追従そのものが止まる**（tracking.c の `if(num < 3) return -3`）
    ので、そこを独立した段として扱う。"""
    if points >= GOOD:
        return '安定'
    if points >= POOR:
        return '不足ぎみ'
    if points >= TRACK_MIN:
        return 'ギリギリ'      # 1点失うと止まる
    return '追従不可'          # 最低3点に届いていない


def report(r, verbose=True):
    w_mm, h_mm = r['size_mm']
    print(r['name'])
    print(f'  元画像 {r["image"][0]}x{r["image"][1]} / 生成dpi {r["declared_dpi"]:.0f}'
          f' → マーカー実寸 {w_mm:.0f}x{h_mm:.0f} mm')
    print(f'  追従点 合計 {r["total"]} 点（合計は目安にならない。下の実使用の点数で判断する）')

    for label, jp in (('portrait', '縦持ち'), ('landscape', '横持ち')):
        d = r[label]
        px = REGION_PORTRAIT[0] if label == 'portrait' else REGION_LANDSCAPE[0]
        print(f'  {jp}（実効{px}px）'
              f' 見かけ {d["dpi"]:5.1f} dpi → 使える点 {d["points"]:3d} 点  （{verdict(d["points"])}）')
        if 'spread' in d:
            note = ''
            if d['points'] > TRACK_PER_FRAME:
                note = f'  ※1フレームで使われるのは最大{TRACK_PER_FRAME}点'
            print(f'    └ 選ばれうる {d["selectable"]:3d} 点 / 散らばり {d["spread"] * 100:4.1f}%'
                  f' / フォールバック込み {d["fallback"]:3d} 点{note}')

    det = r.get('detect')
    if det:
        zero = sum(1 for x in det if x[3] == 0)
        for label, jp, key in (('portrait', '縦持ち', 'portrait'), ('landscape', '横持ち', 'landscape')):
            ap = r[key]['dpi']
            n = sum(det[i][3] for i, lv in enumerate(r['levels'])
                    if i < len(det) and lv[2] <= ap <= lv[1])
            print(f'  検出（.fset3）{jp}で使う帯のキーポイント {n:5d} 点'
                  + ('' if n else '  ← この距離では認識できない'))
        if zero:
            print(f'    ※ {zero} 段が0点（その距離では認識できない）')

    if 'spread' in r['portrait']:
        print('  使える距離（ARnft標準のカメラ、画角55.4度を前提）')
        for label, jp, region in (('portrait', '縦持ち', REGION_PORTRAIT),
                                  ('landscape', '横持ち', REGION_LANDSCAPE)):
            good = usable_range(r['levels'], region, w_mm, h_mm, GOOD)
            any_ = usable_range(r['levels'], region, w_mm, h_mm, TRACK_MIN)
            use, tag, n = (good, '安定', GOOD) if good else (any_, '追従は成立', TRACK_MIN)
            if use is None:
                print(f'    {jp}: どの距離でも {GOOD} 点に届かない')
                continue
            seg = f'（全{use["segments"]}区間のうち最長）' if use['segments'] > 1 else ''
            print(f'    {jp}: {use["min"] / 10:.0f}cm 〜 {use["max"] / 10:.0f}cm で{tag}'
                  f'（{n}点以上）{seg}  ※{use["fit"] / 10:.0f}cm より近いと画面からはみ出す')

    if verbose:
        ap_p = r['portrait']['dpi']
        ap_l = r['landscape']['dpi']
        det = r.get('detect')
        head = f'  {"距離帯(dpi)":>20} {"追従":>5}'
        if det:
            head += f' {"検出":>6}'
        print(head)
        for i, (scale, maxdpi, mindpi, num, _coords) in enumerate(r['levels']):
            mark = ''
            if mindpi <= ap_p <= maxdpi:
                mark += ' ←縦持ちで使う'
            if mindpi <= ap_l <= maxdpi:
                mark += ' ←横持ちで使う'
            bar = '#' * min(num, 30)
            col = ''
            if det and i < len(det):
                d3 = det[i][3]
                col = f' {d3:6d}' + ('' if d3 else ' ←検出不可')
            print(f'  {mindpi:8.1f} 〜 {maxdpi:8.1f} {num:5d}{col}  {bar}{mark}')
    print()


# ------------------------------------------------------------------
# 検算（--self-test）
#
# ツールの出力が「実機で確認された事実」と矛盾しないかを機械的に確かめる。
# ここに書いてある実測結果は、2026-08-10〜11 に実機（iPhone・縦持ち）で
# 確認したもの。ツールを変更したら必ずこのテストを通すこと。
# ------------------------------------------------------------------
GROUND_TRUTH_NOTE = """
実機で確認した事実（このテストの根拠）:
  - satoshi-tomiie-bassline/01 … 大小に飛んで不安定
  - satoshi-tomiie-bassline/02 … 01より確実に安定。ただし少し症状が残る
  - satoshi-tomiie-bassline/03 … 確実に安定
  - pizzaboy/07, marslander/01 … 問題なく動作
  - 既存8ゲームのマーカーは全て公開中で、実際に動作している
"""

# 実機の体感が「01 < 02 < 03」の順に良くなった。点数もこの順でなければならない
ORDERING_TEST = [
    'projects/atariar/markers/satoshi-tomiie-bassline/01.fset',
    'projects/atariar/markers/satoshi-tomiie-bassline/02.fset',
    'projects/atariar/markers/satoshi-tomiie-bassline/03.fset',
]

# 実際に動いているマーカーが 0 点と判定されたら、ツールが壊れている
WORKING_MARKERS_GLOB = 'projects/atariar/markers/*/*.fset'
WORKING_EXCLUDE = 'satoshi-tomiie-bassline'   # 検証中のため除外


def self_test(root=None):
    # 上の相対パスの基点。マーカーの実体は隣に並ぶ website リポジトリの中にある。
    # 道具は ar-marker-studio 側、作品のマーカーは website 側（2026-08-16 に整理）
    root = root or os.path.normpath(os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'website'))
    print('=== 検算: ツールの出力が実機の事実と矛盾しないか ===')
    print(GROUND_TRUTH_NOTE)
    failures = []

    # [1] 実際に動いているマーカーが「使えない」と判定されないか
    print('[1] 公開中のマーカーが 0 点と判定されないか')
    paths = sorted(glob.glob(os.path.join(root, WORKING_MARKERS_GLOB)))
    paths = [p for p in paths if WORKING_EXCLUDE not in p]
    checked = 0
    for p in paths:
        r = evaluate(p)
        if r is None:
            failures.append(f'{p} を評価できない')
            continue
        checked += 1
        pts = max(r['portrait']['points'], r['landscape']['points'])
        if pts == 0:
            failures.append(f'{r["name"]} が 0 点（実際は動いているので誤り）')
            print(f'    NG  {r["name"]:26s} 縦{r["portrait"]["points"]:3d} 横{r["landscape"]["points"]:3d}')
    print(f'    → {checked} 個を検査、0点のものは '
          f'{len([f for f in failures if "0 点" in f])} 個')

    # [2] 実機の体感の順序（01 < 02 < 03）と一致するか
    print('[2] satoshi 01 < 02 < 03 の順に点数が上がるか（実機の体感と同じ順序）')
    pts = []
    for p in ORDERING_TEST:
        r = evaluate(os.path.join(root, p))
        if r is None:
            failures.append(f'{p} を評価できない')
            pts.append(None)
            continue
        pts.append(r['portrait']['points'])
        print(f'    {os.path.basename(p)[:2]}: 縦持ち {r["portrait"]["points"]:3d} 点')
    if None not in pts:
        if not (pts[0] < pts[1] < pts[2]):
            failures.append(f'順序が実機と一致しない: {pts}')
            print(f'    NG  {pts} は昇順でない')
        else:
            print(f'    → {pts[0]} < {pts[1]} < {pts[2]}  実機の体感と一致')

    # [3] 散らばり（凸包の面積）も実機の体感と同じ順序になるか
    #     ar2SelectTemplate が最大化しているものなので、点数と独立した情報を持つ
    print('[3] 散らばりが 01 < 02 < 03 の順に大きくなるか')
    spreads = []
    for p in ORDERING_TEST:
        r = evaluate(os.path.join(root, p))
        if r is None:
            failures.append(f'{p} を評価できない')
            spreads.append(None)
            continue
        spreads.append(r['portrait']['spread'])
        print(f'    {os.path.basename(p)[:2]}: 縦持ち {r["portrait"]["spread"] * 100:5.1f}%')
    if None not in spreads:
        if not (spreads[0] < spreads[1] < spreads[2]):
            failures.append(f'散らばりの順序が実機と一致しない: {spreads}')
            print(f'    NG  {spreads} は昇順でない')
        else:
            print('    → 昇順。実機の体感と一致')

    # [4] 前提となる領域が、ガイド第12章の実測値を再現するか。
    #     数字を直書きで比べるのではなく、画布と可視率から導いた値が
    #     実測（回転181px / 黒帯136px）に一致するかを見る
    print('[4] 判定に使う領域が、ガイド第12章の実測値を再現するか')
    want = [('縦持ち・回転版（本番）', REGION_PORTRAIT, 181, 320),
            ('縦持ち・黒帯（素のARnft）', REGION_PORTRAIT_LETTERBOX, 136, 240),
            ('横持ち', REGION_LANDSCAPE, 320, 181)]
    for label, got, ew, eh in want:
        ok = round(got[0]) == ew and round(got[1]) == eh
        mark = '   ' if ok else 'NG '
        print(f'    {mark} {label:26s} {got[0]:5.1f} x {got[1]:5.1f}  （実測 {ew} x {eh}）')
        if not ok:
            failures.append(f'{label} の領域が実測と違う: {got[0]:.1f}x{got[1]:.1f} '
                            f'（実測 {ew}x{eh}）')
    # 焦点距離には可視率を掛けてはいけない（画布の長辺そのもの）
    if round(focal_px(REGION_PORTRAIT)) != round(focal_px(REGION_LANDSCAPE)):
        failures.append('回転版と横持ちで焦点距離が違う（画布の長辺は同じ320のはず）')
        print('    NG  回転版と横持ちの焦点距離が食い違っている')

    print()
    if failures:
        print(f'判定: 不合格（{len(failures)} 件）')
        for f in failures:
            print(f'  - {f}')
        return 1
    print('判定: すべて合格')
    return 0


def main():
    ap = argparse.ArgumentParser(
        description='ARマーカー（.fset）の品質を実使用の距離帯で判定する',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument('paths', nargs='*', help='.fset ファイル（グロブ可）')
    ap.add_argument('--size-mm', type=float, default=None,
                    help='マーカーを別の実寸で刷る場合の幅(mm)。省略時は生成時の宣言値を使う')
    ap.add_argument('-q', '--quiet', action='store_true', help='距離帯の内訳を省く')
    ap.add_argument('--self-test', action='store_true',
                    help='実機で確認した事実と矛盾しないかを検算する')
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    if not args.paths:
        ap.print_help()
        return 1

    targets = []
    for p in args.paths:
        targets.extend(sorted(glob.glob(p)) if any(c in p for c in '*?[') else [p])
    if not targets:
        print('対象のファイルが見つからない')
        return 1

    results = []
    for path in targets:
        r = evaluate(path, args.size_mm)
        if r is None:
            print(f'{path}: 判定できない（.fset でないか、隣に元画像が無い）')
            continue
        report(r, verbose=not args.quiet)
        results.append(r)

    if len(results) > 1:
        print('=== まとめ（縦持ちで使える点の多い順） ===')
        for r in sorted(results, key=lambda x: -x['portrait']['points']):
            print(f'  縦{r["portrait"]["points"]:3d}点 横{r["landscape"]["points"]:3d}点  {r["name"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
