"""校验 docs/GAME_DESIGN.md 附录 A 里的地图：可解、箱数=目标数、最短倾斜与表格一致。"""

import re
import sys
from verify_levels import parse, solve
from levels_v1 import LEVELS_V1

DOC = r'C:\Workspace\game-demos\gravity-sokoban\docs\GAME_DESIGN.md'

EXPECTED = {
    'T1': 1, 'T2': 1, 'T3': 1,
    'M1': 2, 'M2': 2, 'M3': 2, 'M4': 2,
    'M5': 3, 'M6': 3, 'M7': 4, 'M8': 5, 'M9': 6,
}

text = open(DOC, encoding='utf-8').read()
appendix = text.split('## 附录 A')[1]

blocks = []
for m in re.finditer(r'### ([A-Z]\d) [^\n]*\n```\n(.*?)```', appendix, re.S):
    blocks.append((m.group(1), m.group(2)))

print('附录 A 解析到 %d 关' % len(blocks))
bad = 0
for key, board in blocks:
    w, h, walls, boxes, goals = parse(board)
    k = board.count('K')
    if len(boxes) != len(goals):
        print('%s INVALID 箱%d 目标%d' % (key, len(boxes), len(goals))); bad += 1; continue
    if k != 1:
        print('%s K 数量=%d（应恰好 1）' % (key, k)); bad += 1
    sol, _, n = solve(w, h, walls, goals, boxes)
    if sol is None:
        print('%s UNSOLVABLE' % key); bad += 1; continue
    ok = (n == EXPECTED[key])
    print('%s  %dx%d  箱%d  最短=%d  期望=%d  %s' % (key, w, h, len(boxes), n, EXPECTED[key], 'OK' if ok else 'MISMATCH'))
    if not ok:
        bad += 1

# 与 levels_v1.py 逐关比对（防止文档与校验源不一致）
print()
src = {n.split()[0]: t for n, t in LEVELS_V1.items()}
for key, board in blocks:
    if key in src and parse(board)[3] != parse(src[key])[3] or key in src and parse(board)[4] != parse(src[key])[4]:
        print('%s 与 levels_v1.py 不一致' % key); bad += 1

print('\n%s' % ('全部通过' if bad == 0 else '%d 处问题' % bad))
sys.exit(1 if bad else 0)
