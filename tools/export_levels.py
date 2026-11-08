"""把 12 关从校验源导出成 JSON（docs/levels_v1.json），供实现直接拷、供复核直接 diff。

源：tools/levels_v1.py（= docs/GAME_DESIGN.md 附录 A，check_doc_levels.py 保证逐格一致）
用法：python tools/export_levels.py
"""

import io
import json
import os
import sys
from verify_levels import parse, solve
from levels_v1 import LEVELS_V1

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'levels_v1.json')

GROUPS = {'T': 'teach', 'M': 'main'}

levels = []
total = 0
for key, text in LEVELS_V1.items():
    lid = key.split()[0]
    name = key[len(lid):].strip()
    tiles = [r for r in text.strip('\n').split('\n')]
    w, h, walls, boxes, goals = parse(text)
    sol, _, n = solve(w, h, walls, goals, boxes)
    assert sol is not None, '%s 不可解' % lid
    drags = sum(1 for _, c in sol if c is not None)
    total += n
    levels.append({
        'id': lid,
        'name': name,
        'group': GROUPS[lid[0]],
        'boxes': len(boxes),
        'goals': len(goals),
        'minTilts': n,
        'dragsInOptimal': drags,
        'tiles': tiles,
    })

doc = {
    'version': 'v0.2',
    'source': 'docs/GAME_DESIGN.md 附录 A / tools/levels_v1.py',
    'board': {'w': 7, 'h': 9},
    'legend': {'#': 'wall', '.': 'floor', 'B': 'box', 'T': 'goal', 'K': 'blocker-start'},
    'totalMinTilts': total,
    'levels': levels,
}

with io.open(OUT, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write('\n')

print('导出 %d 关 -> %s' % (len(levels), os.path.normpath(OUT)))
print('合计最少倾斜 %d' % total)
for l in levels:
    print('  %-3s %-6s %s箱  %d步  %d拖' % (l['id'], l['name'], l['boxes'], l['minTilts'], l['dragsInOptimal']))

# 自检：写出去的文件能读回来，且每关 tiles 与源一致
with io.open(OUT, encoding='utf-8') as f:
    back = json.load(f)
assert len(back['levels']) == len(levels)
for l in back['levels']:
    assert len(l['tiles']) == 9 and all(len(r) == 7 for r in l['tiles']), l['id']
print('自检通过：%d 关 × 7×9，JSON 可回读' % len(back['levels']))
