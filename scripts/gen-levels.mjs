// 由 docs/levels_v1.json 生成 js/levels.js（Dev 侧一次性生成，非运行期构建）
// 用法：node scripts/gen-levels.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = JSON.parse(fs.readFileSync(path.join(root, "docs/levels_v1.json"), "utf8"));

const rows = src.levels
  .map((lv) => {
    const tiles = lv.tiles.map((r) => `    "${r}",`).join("\n");
    return `  {
    id: "${lv.id}", name: "${lv.name}", group: "${lv.group}",
    boxes: ${lv.boxes}, goals: ${lv.goals},
    minTilts: ${lv.minTilts}, dragsInOptimal: ${lv.dragsInOptimal},
    tiles: [
${tiles}
    ],
  },`;
  })
  .join("\n");

const out = `// 自动生成：scripts/gen-levels.mjs ← docs/levels_v1.json（勿手改）
// 地图记号：# 墙  . 地板  B 箱子  T 目标  K 挡块初始位；严格 7 列 × 9 行。
export const BOARD = { w: ${src.board.w}, h: ${src.board.h} };
export const TOTAL_MIN_TILTS = ${src.totalMinTilts};

export const LEVELS = [
${rows}
];
`;

fs.mkdirSync(path.join(root, "js"), { recursive: true });
fs.writeFileSync(path.join(root, "js/levels.js"), out, "utf8");
console.log(`wrote js/levels.js: ${src.levels.length} levels, ${out.length} bytes, totalMinTilts=${src.totalMinTilts}`);
