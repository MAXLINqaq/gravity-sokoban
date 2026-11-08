// 把 Design 求解器输出（tools/report_levels.py -v）转成测试夹具 tests/solutions.mjs
// 用法：node scripts/gen-solutions.mjs <.tmp_solutions.txt>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const raw = fs.readFileSync(process.argv[2] || path.join(root, ".tmp_solutions.txt"), "utf8").replace(/^\uFEFF/, "");
const lines = raw.split(/\r?\n/);

const out = {};
let cur = null;
for (const line of lines) {
  const head = line.match(/^([A-Z]\d+)\s+\S+\s+tilts=(\d+)\s+drags=(\d+)/);
  if (head) {
    cur = head[1];
    out[cur] = { id: cur, tilts: +head[2], drags: +head[3], moves: [] };
    continue;
  }
  const step = line.match(/^\s+\d+\.\s+([UDLR])\s*(?:@\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\))?/);
  if (step && cur) {
    out[cur].moves.push({
      dir: { U: "up", D: "down", L: "left", R: "right" }[step[1]],
      blocker: step[2] === undefined ? null : [+step[2], +step[3]],
    });
  }
}

const total = Object.values(out).reduce((n, s) => n + s.tilts, 0);
const body = Object.values(out)
  .map((s) => `  ${s.id}: ${JSON.stringify({ tilts: s.tilts, drags: s.drags, moves: s.moves })} ,`)
  .join("\n");
fs.mkdirSync(path.join(root, "tests"), { recursive: true });
fs.writeFileSync(
  path.join(root, "tests/solutions.mjs"),
  `// 自动生成：scripts/gen-solutions.mjs ← tools/report_levels.py -v（Design 求解器实算，勿手改）\nexport const SOLUTIONS = {\n${body}\n};\nexport const TOTAL_MIN_TILTS = ${total};\n`,
  "utf8"
);
console.log(`wrote tests/solutions.mjs: ${Object.keys(out).length} levels, ${total} tilts`);
for (const s of Object.values(out)) {
  if (s.moves.length !== s.tilts) console.log(`WARN ${s.id}: moves=${s.moves.length} != tilts=${s.tilts}`);
}
