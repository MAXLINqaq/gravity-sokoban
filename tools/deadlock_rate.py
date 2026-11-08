"""随机瞎按的死局率：判断「重开」在 MVP 里是否必需。"""

import random
from verify_levels import parse, solve, slide, path_cells
from levels_v1 import LEVELS_V1

random.seed(7)

print('%-16s %4s %10s' % ('关卡', '最优', '瞎按死局率'))
for name, text in LEVELS_V1.items():
    w, h, walls, boxes, goals = parse(text)
    sol, _, n = solve(w, h, walls, goals, boxes)
    dead = 0
    trials = 300
    for _ in range(trials):
        cur = boxes
        for _ in range(n * 2):
            moves = []
            for d in ('U', 'D', 'L', 'R'):
                for c in [None] + sorted(path_cells(walls, cur, d)):
                    nb = slide(w, h, walls, cur, c, d)
                    if nb != cur:
                        moves.append(nb)
            if not moves:
                break
            cur = random.choice(moves)
        sub, _, _ = solve(w, h, walls, goals, cur, maxtilts=n + 4)
        if sub is None:
            dead += 1
    print('%-16s %4d %9.0f%%' % (name, n, 100.0 * dead / trials))
