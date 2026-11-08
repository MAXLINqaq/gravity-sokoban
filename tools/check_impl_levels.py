"""复核 Dev 实现的关卡数据：与 docs/levels_v1.json 逐格比对，并用设计侧求解器重算最短步数。

用法：node --input-type=module -e "..." > %TEMP%\\dev_levels.json
     python tools/check_impl_levels.py %TEMP%\\dev_levels.json
"""

import io
import json
import sys

from verify_levels import parse, solve

STRUCT = ('id', 'name', 'group', 'boxes', 'goals', 'minTilts', 'dragsInOptimal')


def main(dump_path):
    with io.open(dump_path, encoding='utf-8') as f:
        impl = json.load(f)
    with io.open(r'C:\Workspace\game-demos\gravity-sokoban\docs\levels_v1.json', encoding='utf-8') as f:
        spec = json.load(f)['levels']

    bad = 0
    if len(impl) != len(spec):
        print('关卡数不一致：实现 %d / 规格 %d' % (len(impl), len(spec)))
        return 1

    total = 0
    for got, want in zip(impl, spec):
        for k in STRUCT:
            if got.get(k) != want.get(k):
                print('%s 字段 %s 不一致：实现=%r 规格=%r' % (want['id'], k, got.get(k), want.get(k)))
                bad += 1
        g, s = got['tiles'], want['tiles']
        if len(g) != 9 or any(len(r) != 7 for r in g):
            print('%s 行列数不是 7x9' % want['id'])
            bad += 1
            continue
        diff = [(y, x) for y in range(9) for x in range(7) if g[y][x] != s[y][x]]
        if diff:
            print('%s 地图有 %d 处与规格不同：%s' % (want['id'], len(diff), diff[:8]))
            bad += 1
            continue
        # 用设计侧求解器独立重算
        w, h, walls, boxes, goals = parse('\n'.join(g))
        sol, _, n = solve(w, h, walls, goals, boxes)
        if sol is None:
            print('%s 实现在设计侧求解器下不可解' % want['id'])
            bad += 1
            continue
        total += n
        flag = 'OK' if n == want['minTilts'] else 'MISMATCH'
        if n != want['minTilts']:
            bad += 1
        print('%-3s %-6s 逐格一致  %d步(规格%d) %s' % (want['id'], want['name'], n, want['minTilts'], flag))

    print('\n合计最少倾斜 %d（规格 %d）' % (total, sum(l['minTilts'] for l in spec)))
    print('关卡数 %d' % len(impl))
    print('结论：%s' % ('全部一致' if bad == 0 else '%d 处不符' % bad))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else sys.argv[0]))
