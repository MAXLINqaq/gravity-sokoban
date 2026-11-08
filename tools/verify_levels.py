"""设计期关卡校验器（不是游戏实现，不进游戏代码）。

用途：验证《重力推箱子》关卡可解，并算出最少倾斜次数，供设计文档的关卡表使用。
规则口径与 docs/GAME_DESIGN.md §3 一致：

- 一次倾斜：所有箱子沿方向 d 逐格滑动，撞墙 / 撞已停下的箱子 / 撞挡块即停。
- 结算顺序：按沿 d 到边缘的格数升序（贴着目的地墙的先动），同 t 按 (y, x)。
- 箱子不能推动箱子。
- 挡块：1 格，不受重力，倾斜前可自由拖到任意非墙非箱格（拖动是直接落格，不模拟路径）。

关键推论（已写进文档）：挡块只能处在一条射线上，所以一次倾斜里**最多一条行/列**的箱子
会被挡块改变落点；其余箱子只能靠墙或靠箱停。
同理，挡块位置不进入状态——每回合都能重放，所以搜索状态只需箱子集合。
"""

import sys
from collections import deque

# Windows 默认控制台是 cp1252，直接 print 中文会抛 UnicodeEncodeError。
# 所有 tools/ 下的脚本都 import 本模块，这里统一把 stdout 切成 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass

DIRS = {'U': (0, -1), 'D': (0, 1), 'L': (-1, 0), 'R': (1, 0)}


def parse(text):
    rows = [r for r in text.strip('\n').split('\n')]
    h = len(rows)
    w = max(len(r) for r in rows)
    walls, boxes, goals = set(), set(), set()
    for y, r in enumerate(rows):
        for x in range(w):
            ch = r[x] if x < len(r) else '#'
            if ch == '#':
                walls.add((x, y))
            elif ch == 'B':
                boxes.add((x, y))
            elif ch == 'T':
                goals.add((x, y))
            elif ch == '*':
                boxes.add((x, y)); goals.add((x, y))
            elif ch == 'K':
                pass  # 挡块初始位置不影响可解性（每回合可自由重放）
            elif ch != '.':
                raise ValueError(f'bad tile {ch!r} at ({x},{y})')
    return w, h, walls, frozenset(boxes), frozenset(goals)


def dist_to_edge(w, h, cell, d):
    x, y = cell
    if d == 'R': return (w - 1) - x
    if d == 'L': return x
    if d == 'D': return (h - 1) - y
    return y


def slide(w, h, walls, boxes, blocker, d):
    dx, dy = DIRS[d]
    order = sorted(boxes, key=lambda b: (dist_to_edge(w, h, b, d), b[1], b[0]))
    settled = set()
    for bx, by in order:
        x, y = bx, by
        while True:
            nx, ny = x + dx, y + dy
            if (nx, ny) in walls or (nx, ny) in settled or (nx, ny) == blocker:
                break
            x, y = nx, ny
        settled.add((x, y))
    return frozenset(settled)


def path_cells(walls, boxes, d):
    """挡块放这些格才会改变本次倾斜的结果（其余位置等价于没有挡块）。"""
    dx, dy = DIRS[d]
    out = set()
    for (x, y) in boxes:
        cx, cy = x + dx, y + dy
        while (cx, cy) not in walls and (cx, cy) not in boxes:
            out.add((cx, cy))
            cx, cy = cx + dx, cy + dy
    return out


def solve(w, h, walls, goals, start, maxtilts=40):
    if len(start) != len(goals):
        return None, 0, -1
    start = frozenset(start)
    if start == goals:
        return [], 0, 0
    seen = {start}
    q = deque([(start, [])])
    best = None
    while q:
        boxes, path = q.popleft()
        for d in ('U', 'D', 'L', 'R'):
            cands = [None] + sorted(path_cells(walls, boxes, d))
            for c in cands:
                nb = slide(w, h, walls, boxes, c, d)
                if nb == boxes or nb in seen:
                    continue
                seen.add(nb)
                np = path + [(d, c)]
                if nb == goals:
                    if best is None or len(np) < len(best):
                        best = np
                    q.append((nb, np))
                    continue
                if len(np) < maxtilts:
                    q.append((nb, np))
    if best is None:
        return None, len(seen), -1
    return best, len(seen), len(best)


def render(w, h, walls, boxes, goals, blocker=None):
    out = []
    for y in range(h):
        line = ''
        for x in range(w):
            c = (x, y)
            if c in walls: ch = '#'
            elif c == blocker: ch = 'K'
            elif c in boxes and c in goals: ch = '*'
            elif c in boxes: ch = 'B'
            elif c in goals: ch = 'T'
            else: ch = '.'
            line += ch
        out.append(line)
    return '\n'.join(out)


def show(name, text, verbose=False):
    w, h, walls, boxes, goals = parse(text)
    if len(boxes) != len(goals):
        print(f'[{name}] INVALID: boxes={len(boxes)} goals={len(goals)}')
        return
    sol, states, n = solve(w, h, walls, goals, boxes)
    if sol is None:
        print(f'[{name}] UNSOLVABLE ({states} states)')
        return
    drags = sum(1 for _, c in sol if c is not None)
    print(f'[{name}] OK  min_tilts={n}  drags={drags}  states={states}  box={len(boxes)}')
    if verbose:
        cur, blk = boxes, None
        for i, (d, c) in enumerate(sol, 1):
            cur = slide(w, h, walls, cur, c, d)
            tag = f'{d}' + (f' @{c}' if c else '')
            print(f'   {i}. {tag:14s} -> ' + ' '.join(f'({x},{y})' for x, y in sorted(cur)))
    return n


LEVELS = {}

def L(name, text):
    LEVELS[name] = text


# ---------------- 教学 ----------------
L('T1 撞墙即停', """
#######
#.....#
#..B..#
#.....#
#.....#
#.....#
#.....#
#..T..#
#######
""")

L('T2 挡块接住', """
#######
#.....#
#..B..#
#.....#
#.....#
#..T..#
#.....#
#...K.#
#######
""")

L('T3 箱子排队', """
#######
#.....#
#..B..#
#..B..#
#.....#
#.....#
#..T..#
#..T..#
#######
""")

# ---------------- 主线候选 ----------------
L('L01 靠右排队', """
#######
#.....#
#.B.B.#
#.....#
#.....#
#.....#
#.....#
#...TT#
#######
""")

L('L02 一次换道', """
#######
#.....#
#.B...#
#.....#
#.....#
#.....#
#.....#
#...T.#
#######
""")

L('L03 两列都得挪', """
#######
#.....#
#BB...#
#.....#
#.....#
#.....#
#.....#
#..TT.#
#######
""")

L('L04 挡块只救一个', """
#######
#.....#
#.B.B.#
#.....#
#.....#
#.....#
#.....#
#..T.T#
#######
""")

L('L05 先让路', """
#######
#.....#
#.B...#
#.B...#
#.....#
#.....#
#.....#
#..TT.#
#######
""")

L('L06 两箱同列', """
#######
#.....#
#.B...#
#.B...#
#.....#
#.....#
#.....#
#..T..#
#######
""")

L('L07 三箱', """
#######
#.....#
#.B.B.#
#..B..#
#.....#
#.....#
#.....#
#.TTT.#
#######
""")

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    only = args[0] if args else None
    for name, text in LEVELS.items():
        if only and only not in name:
            continue
        show(name, text, verbose='-v' in sys.argv)
