"""生成 §2.5 示意图的前后盘面（保证文档里的例子是真算出来的）。"""

from verify_levels import parse, slide, render, DIRS

EXAMPLES = {
    'E1 同向队列': ("""
#######
#.BBB.#
#.....#
#######
""", 'R', None),
    'E2 挡块定住两箱': ("""
#######
#..B..#
#..B..#
#.....#
#.....#
#..K..#
#.....#
#######
""", 'D', (3, 6)),
    'E3 搁板': ("""
#######
#..B..#
#.....#
#..T..#
#.###.#
#.....#
#######
""", 'D', None),
}

for name, (board, d, blk) in EXAMPLES.items():
    w, h, walls, boxes, goals = parse(board)
    after = slide(w, h, walls, boxes, blk, d)
    print('===', name)
    print('前:')
    print(render(w, h, walls, boxes, goals))
    print('后:')
    print(render(w, h, walls, after, goals))
    print('箱子', sorted(boxes), '->', sorted(after))
    print()
