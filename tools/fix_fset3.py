#!/usr/bin/env python3
"""検出器の不具合を避けるため、.fset3 の先頭にダミーの段を1つ挿す。

【何を直しているか】
jsartoolkitNFT の kpmMatching.cpp の生きているコードがこうなっている。

    int matched_image_id = kpmHandle->freakMatcher->matchedId();
    if (matched_image_id != 0) {          // 本家 artoolkit5 は `if (... < 0) continue;`
        int matchedPageNo = kpmHandle->pageIDs[matched_image_id];
        ...姿勢計算...
    }

db_id は kpmSetRefDataSet が (ページ, 画像) の順に 0 から振る。
マッチャは最も対応点の多い参照画像を**1つだけ**返すので、
**db_id 0 が勝つと姿勢計算ごと飛ばされ、検出が丸ごと失敗する。**
2番手に落ちる仕組みは無い。

対処は、点を1つも参照しないダミーの段を先頭に足すこと。
db_id 0 がそこに割り当てられ、本物の段は全部 db_id >= 1 になって生き返る。
ダミーは点が0個なので、マッチの下限（8点）に届かず絶対に勝たない。

【なぜ「段0を除去」ではないか】
段0を消すと段1が db_id 0 になるだけで、問題が移動する。実測でも効果が無かった
（25マーカー×11条件で 176 → 175）。ダミー段では 176 → 216 になり、悪化は0本。

使い方（ar-marker-studio のルートで実行する。作品側は隣の website リポジトリ）:
    python3 tools/fix_fset3.py "../website/projects/atariar/markers/*/*.fset3"
    python3 tools/fix_fset3.py "../website/projects/atariar/markers/*/*.fset3" --write
    python3 tools/fix_fset3.py --self-test

**--write を付けない限り、ファイルは一切書き換えない。**
--write のときは元を <name>.fset3.bak に残す（.gitignore 済み）。

効果の確認は tools/check_detection.py。詳しい背景は docs/ar-marker-guide.md 第11章。
"""

import argparse
import glob
import os
import shutil
import struct
import sys

import parse_fset

# ダミー段の段番号。どの点もこの番号を参照しないことが条件。
# 実データの段番号は 0 から連番なので、9999 とぶつかることはない。
# parse_fset.py と ar-marker-studio/js/fset3.js は、この番号の段を表示から除く。
DUMMY_IMAGE_NO = parse_fset.DUMMY_IMAGE_NO

REC = parse_fset.FSET3_REC          # 1点あたり 132 バイト
IMAGE_ENTRY = 12                    # 1段あたり {int 幅, int 高さ, int 段番号}


def read_fset3(data):
    """.fset3 を「点の生バイト列」と「ページごとの段リスト」に分解する。

    点の中身には触らない。バイト列のまま持ち回して、書き戻すときにそのまま使う。
    """
    (total,) = struct.unpack_from('<i', data, 0)
    if total < 0 or 4 + total * REC + 4 > len(data):
        raise ValueError('点数が不正')
    points = data[4:4 + total * REC]

    used = set()
    base = 4 + 8 + 8 + parse_fset.FREAK_FEATURE_SIZE + 4
    for i in range(total):
        (no,) = struct.unpack_from('<i', data, base + i * REC)
        used.add(no)

    off = 4 + total * REC
    (page_num,) = struct.unpack_from('<i', data, off)
    off += 4
    if not 0 <= page_num <= 64:
        raise ValueError('ページ数が不正')

    pages = []
    for _ in range(page_num):
        page_no, image_num = struct.unpack_from('<2i', data, off)
        off += 8
        if image_num < 0 or off + image_num * IMAGE_ENTRY > len(data):
            raise ValueError('段数が不正')
        imgs = []
        for _ in range(image_num):
            imgs.append(struct.unpack_from('<3i', data, off))
            off += IMAGE_ENTRY
        pages.append((page_no, imgs))

    if off != len(data):
        raise ValueError('末尾が合わない（形式違い）')
    return total, points, pages, used


def write_fset3(total, points, pages):
    out = bytearray(struct.pack('<i', total))
    out += points
    out += struct.pack('<i', len(pages))
    for page_no, imgs in pages:
        out += struct.pack('<2i', page_no, len(imgs))
        for w, h, no in imgs:
            out += struct.pack('<3i', w, h, no)
    return bytes(out)


def add_dummy(data):
    """先頭にダミー段を挿した .fset3 を返す。点の部分は1バイトも変えない。

    既にダミーが入っていれば None を返す（二重に挿さない）。
    """
    total, points, pages, used = read_fset3(data)
    if any(no == DUMMY_IMAGE_NO for _, imgs in pages for _, _, no in imgs):
        return None
    if DUMMY_IMAGE_NO in used:
        raise ValueError(f'段番号 {DUMMY_IMAGE_NO} を参照する点がある。'
                         'ダミーに使えないので DUMMY_IMAGE_NO を変える必要がある')
    new_pages = []
    for page_no, imgs in pages:
        if not imgs:
            raise ValueError('段を持たないページがある')
        w, h, _ = imgs[0]                       # 大きさは先頭の段に合わせる（使われない）
        new_pages.append((page_no, [(w, h, DUMMY_IMAGE_NO)] + imgs))
    return write_fset3(total, points, new_pages)


def verify(before, after):
    """書き込む前の検算。1つでも落ちたら書かない。"""
    t0, p0, pg0, _ = read_fset3(before)
    t1, p1, pg1, used1 = read_fset3(after)

    if t0 != t1:
        return f'点数が変わった {t0} → {t1}'
    if p0 != p1:
        return '点の中身が変わった（1バイトも変わってはいけない）'
    if len(after) != len(before) + IMAGE_ENTRY * len(pg0):
        return f'ファイル長が想定と違う {len(before)} → {len(after)}'
    if len(pg0) != len(pg1):
        return f'ページ数が変わった {len(pg0)} → {len(pg1)}'
    for (_, a), (_, b) in zip(pg0, pg1):
        if b[0][2] != DUMMY_IMAGE_NO:
            return '先頭がダミー段になっていない'
        if b[1:] != a:
            return '元の段の並びが変わった'
    if DUMMY_IMAGE_NO in used1:
        return 'ダミー段を参照する点ができてしまった'
    if parse_fset.parse_fset3_raw(after) is None:
        return '書き出したものを parse_fset3 が読めない'
    return None


def process(path, write):
    with open(path, 'rb') as f:
        before = f.read()
    try:
        after = add_dummy(before)
    except ValueError as e:
        return f'★ {path}: {e}'
    if after is None:
        return f'   {path}: 既にダミー段が入っている（何もしない）'

    bad = verify(before, after)
    if bad:
        return f'★ {path}: 検算に失敗したので書かない … {bad}'

    levels = len(read_fset3(before)[2][0][1])
    if not write:
        return f'   {path}: {levels} 段 → {levels + 1} 段（下見のみ。--write で実行）'

    bak = path + '.bak'
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
    with open(path, 'wb') as f:
        f.write(after)
    return f' ✓ {path}: {levels} 段 → {levels + 1} 段（元は {os.path.basename(bak)}）'


# ------------------------------------------------------------------
def self_test():
    """実ファイルで往復させて、壊していないことを機械的に確かめる。"""
    ok = True
    # マーカーの実体は隣に並ぶ website リポジトリの中にある。
    # 道具は ar-marker-studio 側、作品のマーカーは website 側（2026-08-16 に整理）
    targets = sorted(glob.glob(os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '..', '..', 'website',
        'projects', 'atariar', 'markers', '*', '*.fset3')))
    targets = [t for t in targets if not t.endswith('.bak')]
    if not targets:
        print('マーカーが見つからない。検算できない。')
        return False

    print(f'[1] 実ファイル {len(targets)} 個で、点の中身を変えずに段を1つ増やせるか')
    bad = []
    for t in targets:
        with open(t, 'rb') as f:
            before = f.read()
        try:
            after = add_dummy(before)
        except ValueError as e:
            bad.append(f'{os.path.basename(t)}: {e}')
            continue
        if after is None:
            continue                      # 既に適用済み
        msg = verify(before, after)
        if msg:
            bad.append(f'{os.path.basename(t)}: {msg}')
    if bad:
        print('    → ★失敗:', '; '.join(bad[:3]))
        ok = False
    else:
        print('    → 全部通った')

    print('[2] 二重に挿さないか')
    with open(targets[0], 'rb') as f:
        once = add_dummy(f.read())
    if once is None:
        print('    → 既に適用済みのファイルだったので判定できない')
    elif add_dummy(once) is None:
        print('    → 2回目は何もしない')
    else:
        print('    → ★2回目も挿してしまう')
        ok = False

    print(f'[3] parse_fset3 が表示からダミー段（段番号 {DUMMY_IMAGE_NO}）を除くか')
    if once is None:
        with open(targets[0], 'rb') as f:
            once = f.read()
    lv_before = parse_fset.parse_fset3(targets[0])
    lv_after = parse_fset.parse_fset3_raw(once)
    if lv_before is not None and lv_after == lv_before:
        print(f'    → 除かれている（{len(lv_before)} 段のまま）')
    else:
        print('    → ★段の一覧が変わってしまう:',
              None if lv_before is None else len(lv_before),
              None if lv_after is None else len(lv_after))
        ok = False

    print('\n判定:', 'すべて合格' if ok else '★不合格')
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('paths', nargs='*', help='.fset3 のパス（ワイルドカード可）')
    ap.add_argument('--write', action='store_true',
                    help='実際に書き換える。付けなければ下見のみ')
    ap.add_argument('--self-test', action='store_true', help='検算')
    args = ap.parse_args()

    if args.self_test:
        sys.exit(0 if self_test() else 1)
    if not args.paths:
        ap.error('直す .fset3 を指定する')

    files = []
    for p in args.paths:
        files.extend(sorted(glob.glob(p)) if any(c in p for c in '*?[') else [p])
    files = [f for f in files if not f.endswith('.bak')]
    if not files:
        sys.exit('該当するファイルが無い')

    if not args.write:
        print('※ 下見だけ。実際に書き換えるには --write を付ける\n')
    for f in files:
        print(process(f, args.write))


if __name__ == '__main__':
    main()
