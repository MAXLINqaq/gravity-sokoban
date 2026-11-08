"""§2.6 边界情形的实算（贴墙 / 贴箱 / 贴挡块 / 经过目标 / 目标被推走）。"""

from verify_levels import parse, slide, render

CASES = [
    ('B1 贴右墙再向右倾', """
#######
#....B#
#.....#
#######
""", 'R', None),
    ('B2 贴箱向右倾', """
#######
#.BB..#
#.....#
#######
""", 'R', None),
    ('B3 贴挡块再向右倾', """
#######
#..BK.#
#.....#
#######
""", 'R', (4, 1)),
    ('B4 经过目标不停', """
#######
#..T..#
#B....#
#.....#
#######
""", 'R', None),
    ('B5 目标上的箱子被推走', """
#######
#.....#
#..*..#
#.....#
#######
""", 'L', None),
    ('B6 三箱贴紧一起右移', """
#######
#.BBB.#
#.....#
#######
""", 'R', None),
]

for name, board, d, blk in CASES:
    w, h, walls, boxes, goals = parse(board)
    after = slide(w, h, walls, boxes, blk, d)
    same = (after == boxes)
    print('=== %s  [%s] %s' % (name, d, '不动' if same else '移动'))
    print('前:', sorted(boxes), ' 后:', sorted(after))
    print(render(w, h, walls, boxes, goals))
    print('  ↓')
    print(render(w, h, walls, after, goals))
    print()
