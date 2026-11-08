"""生成 GAME_DESIGN.md §5 用的关卡表 + 首步容错率。

用法：python tools/report_levels.py [-v]
输出：每个关卡的最少倾斜、拖拽次数、首步安全率（可解开的首步 / 全部会改变盘面的首步），
     以及一条最优解路径，供设计文档核对。
"""

import sys
from collections import deque
from verify_levels import parse, solve, slide, path_cells, render
from levels_v1 import LEVELS_V1


def first_moves(w, h, walls, boxes):
    """所有会改变盘面的首步（同结果去重），返回 {resulting_boxes: (dir, blocker)}。"""
    out = {}
    for d in ('U', 'D', 'L', 'R'):
        for c in [None] + sorted(path_cells(walls, boxes, d)):
            nb = slide(w, h, walls, boxes, c, d)
            if nb != boxes:
                out.setdefault(nb, (d, c))
    return out


def report(name, text):
    w, h, walls, boxes, goals = parse(text)
    if len(boxes) != len(goals):
        print(f'{name:14s} INVALID boxes={len(boxes)} goals={len(goals)}')
        return None
    sol, states, n = solve(w, h, walls, goals, boxes)
    if sol is None:
        print(f'{name:14s} UNSOLVABLE')
        return None
    fm = first_moves(w, h, walls, boxes)
    safe = 0
    for nb in fm:
        sub, _, _ = solve(w, h, walls, goals, nb, maxtilts=n + 2)
        if sub is not None:
            safe += 1
    drags = sum(1 for _, c in sol if c is not None)
    rate = 100.0 * safe / max(1, len(fm))
    print(f'{name:14s} tilts={n} drags={drags} 首步安全={safe}/{len(fm)} ({rate:.0f}%) 状态={states}')
    return dict(name=name, w=w, h=h, walls=walls, boxes=boxes, goals=goals,
                sol=sol, n=n, drags=drags, safe=safe, total=len(fm), rate=rate)


if __name__ == '__main__':
    verbose = '-v' in sys.argv
    rows = []
    for name, text in LEVELS_V1.items():
        r = report(name, text)
        if r is None:
            continue
        rows.append(r)
        if verbose:
            cur = r['boxes']
            for i, (d, c) in enumerate(r['sol'], 1):
                cur = slide(r['w'], r['h'], r['walls'], cur, c, d)
                print(f'     {i}. {d}' + (f' @{c}' if c else '') +
                      '  -> ' + ' '.join(f'({x},{y})' for x, y in sorted(cur)))
    print(f'\n合计 {len(rows)} 关，最少倾斜 {sum(r["n"] for r in rows)} 次')
