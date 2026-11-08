// 内核自测：A1–A3、A5–A8（A4 用 Trigger 时间注入在无 DOM 环境验证）
// 运行：node tests/core.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEVELS, TOTAL_MIN_TILTS, BOARD } from "../js/levels.js";
import { SOLUTIONS } from "./solutions.mjs";
import {
  W, H, createState, settle, settleReference, applySettle, undo, restart,
  canUndo, canPlaceBlocker, dragBlocker, isWin, signature, Trigger, DIRS, DELTA,
} from "../js/core.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

// 确定性随机
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const freeCells = (st) => {
  const out = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (st.cells[y][x] !== "#") out.push([x, y]);
  return out;
};

function randomState(level, rand) {
  const st = createState(level);
  const free = freeCells(st);
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [free[i], free[j]] = [free[j], free[i]];
  }
  const n = st.boxes.length;
  st.boxes = free.slice(0, n).map((c) => [...c]);
  st.blocker = [...free[n]];
  return st;
}

function assertInvariants(st) {
  const seen = new Set();
  for (const [x, y] of st.boxes) {
    assert.ok(x >= 0 && x < W && y >= 0 && y < H, `箱子越界 (${x},${y})`);
    assert.notEqual(st.cells[y][x], "#", `箱子在墙上 (${x},${y})`);
    const k = `${x},${y}`;
    assert.ok(!seen.has(k), `箱子重叠 ${k}`);
    seen.add(k);
  }
  assert.ok(!seen.has(`${st.blocker[0]},${st.blocker[1]}`), "箱子与挡块重叠");
}

// ---------- 数据一致性 ----------
check("关卡数据：12 关 / 7×9 / 箱数==目标数 / 唯一 K", () => {
  assert.equal(LEVELS.length, 12);
  assert.equal(BOARD.w, 7);
  assert.equal(BOARD.h, 9);
  assert.equal(TOTAL_MIN_TILTS, 32);
  for (const lv of LEVELS) {
    const st = createState(lv);
    assert.equal(st.boxes.length, st.goals.length, `${lv.id} 箱数 != 目标数`);
    assert.equal(lv.tiles.length, 9, `${lv.id} 行数`);
    assert.ok(lv.tiles.every((r) => r.length === 7), `${lv.id} 列数`);
  }
});

check("关卡数据与 docs/levels_v1.json 逐格一致", () => {
  const json = JSON.parse(fs.readFileSync(path.join(root, "docs/levels_v1.json"), "utf8"));
  assert.equal(json.totalMinTilts, TOTAL_MIN_TILTS);
  assert.deepEqual(
    LEVELS.map((l) => ({ id: l.id, name: l.name, minTilts: l.minTilts, tiles: l.tiles })),
    json.levels.map((l) => ({ id: l.id, name: l.name, minTilts: l.minTilts, tiles: l.tiles }))
  );
});

check("求解器最短步数与关卡表一致（合计 32）", () => {
  const total = LEVELS.reduce((n, l) => {
    assert.equal(SOLUTIONS[l.id].tilts, l.minTilts, `${l.id} 最短 ${l.minTilts} vs ${SOLUTIONS[l.id].tilts}`);
    return n + l.minTilts;
  }, 0);
  assert.equal(total, 32);
});

// ---------- A1 结算可复现 ----------
check("A1 同一操作序列回放 100 次，逐格状态 0 差异", () => {
  for (const lv of LEVELS) {
    const seq = [];
    const r = rng(lv.id.charCodeAt(0) * 1000 + lv.id.length);
    for (let i = 0; i < 24; i++) {
      if (r() < 0.65) seq.push({ move: DIRS[Math.floor(r() * 4)] });
      else {
        const st = createState(lv);
        const free = freeCells(st);
        const c = free[Math.floor(r() * free.length)];
        seq.push({ drag: c });
      }
    }
    const run = () => {
      const st = createState(lv);
      const sigs = [];
      for (const op of seq) {
        if (op.move) applySettle(st, op.move);
        else dragBlocker(st, op.drag[0], op.drag[1]);
        sigs.push(signature(st));
      }
      return sigs;
    };
    const base = run().join("\n");
    for (let k = 0; k < 99; k++) assert.equal(run().join("\n"), base, `${lv.id} 第 ${k + 2} 次回放有差异`);
  }
});

// ---------- A2 状态不变量 ----------
check("A2 1000 次随机局面 × 随机方向，不重叠/不越界/不上墙", () => {
  const r = rng(0xa2);
  for (let i = 0; i < 1000; i++) {
    const lv = LEVELS[i % LEVELS.length];
    const st = randomState(lv, r);
    const dir = DIRS[Math.floor(r() * 4)];
    st.boxes = settle(st, dir).boxes;
    assertInvariants(st);
    assert.ok(!st.boxes.some(([x, y]) => x === st.blocker[0] && y === st.blocker[1]), "箱子压在挡块上");
  }
});

// ---------- A3 结算等价性 ----------
check("A3 前序优先 vs 逐格微步参考实现，1000 例全等", () => {
  const r = rng(0xa3);
  for (let i = 0; i < 1000; i++) {
    const lv = LEVELS[i % LEVELS.length];
    const st = randomState(lv, r);
    const dir = DIRS[Math.floor(r() * 4)];
    const fast = settle(st, dir).boxes.map((b) => b.join(",")).sort().join("|");
    const slow = settleReference(st, dir).map((b) => b.join(",")).sort().join("|");
    assert.equal(fast, slow, `${lv.id} ${dir} 例 ${i}: ${fast} vs ${slow}`);
  }
});

// ---------- A4 抖动不刷步 ----------
check("A4 快速左右倾 20 次不回正，最多结算 1 次", () => {
  const t = new Trigger();
  let fires = 0;
  let now = 1000;
  for (let i = 0; i < 20; i++) {
    if (t.feed(i % 2 ? -25 : 25, 0, now)) fires++;
    now += 30;
    if (t.feed(0, 0, now)) fires++; // 只停 30ms，不足 80ms
    now += 20;
  }
  assert.equal(fires, 1);
});

check("A4 回正保持 80ms 后可再触发；不足 80ms 不行", () => {
  const t = new Trigger();
  assert.equal(t.feed(25, 0, 0), "down");
  assert.equal(t.feed(0, 0, 100), null); // 开始回正计时
  assert.equal(t.feed(25, 0, 150), null); // 只保持 50ms，且幅度回到阈上 → 计时清零
  assert.equal(t.feed(0, 0, 200), null);
  assert.equal(t.feed(25, 0, 260), null); // 保持 60ms，仍不足
  assert.equal(t.feed(0, 0, 300), null);
  assert.equal(t.feed(0, 0, 390), null); // 90ms → 已重新武装
  assert.equal(t.feed(25, 0, 400), "down");
});

check("A4 45° 斜倾丢弃；纯轴（次分量 <0.5°）必须触发", () => {
  const t = new Trigger();
  assert.equal(t.feed(25, 25, 0), null, "45° 应丢弃");
  assert.equal(t.feed(25, 0.2, 10), "down", "纯轴必须触发");
  const t2 = new Trigger();
  assert.equal(t2.feed(25, 13, 0), null, "轴比 1.92 < 2.0 应丢弃，且不能因丢弃而解除武装外的副作用");
});

check("A4 轴比闸门：2.0 通过、1.6 丢弃", () => {
  const a = new Trigger();
  assert.equal(a.feed(25, 12, 0), "down"); // 2.08 ≥ 2
  const b = new Trigger();
  assert.equal(b.feed(25, 16, 0), null); // 1.56 < 2
});

check("A4 切后台 reset 后必须回正才触发（§3.4）", () => {
  const t = new Trigger();
  t.reset();
  assert.equal(t.feed(30, 0, 0), null);
  assert.equal(t.feed(0, 0, 50), null);
  assert.equal(t.feed(0, 0, 140), null);
  assert.equal(t.feed(30, 0, 150), "down");
});

// ---------- A5 非法拖动 ----------
check("A5 拖到墙/箱/图外：返回 false，棋盘与撤销栈都不变", () => {
  for (const lv of LEVELS) {
    const st = createState(lv);
    applySettle(st, "down");
    const before = signature(st);
    const hist = st.history.length;
    const walls = [];
    const boxes = st.boxes.map((b) => [...b]);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (st.cells[y][x] === "#") walls.push([x, y]);
    assert.equal(dragBlocker(st, walls[0][0], walls[0][1]), false, `${lv.id} 墙`);
    assert.equal(dragBlocker(st, boxes[0][0], boxes[0][1]), false, `${lv.id} 箱`);
    assert.equal(dragBlocker(st, -1, 3), false, `${lv.id} 图外`);
    assert.equal(dragBlocker(st, W, 3), false, `${lv.id} 图外`);
    assert.equal(signature(st), before, `${lv.id} 棋盘被改`);
    assert.equal(st.history.length, hist, `${lv.id} 撤销栈被改`);
  }
});

check("A5 合法落点可到任意空格（含目标格），且不计步", () => {
  const st = createState(LEVELS[0]);
  const [gx, gy] = st.goals[0];
  assert.equal(canPlaceBlocker(st, gx, gy), true);
  assert.equal(dragBlocker(st, gx, gy), true);
  assert.deepEqual(st.blocker, [gx, gy]);
  assert.equal(st.moves, 0);
  assert.equal(st.history.length, 0);
});

// ---------- A6 胜利判定 ----------
check("A6 仅当所有箱子都在目标格才赢；挡块压目标不算", () => {
  const lv = LEVELS.find((l) => l.id === "M2"); // 2 箱 2 目标
  const st = createState(lv);
  assert.equal(isWin(st), false);
  st.boxes = st.goals.map((g) => [...g]);
  assert.equal(isWin(st), true);
  st.boxes = [st.goals[0], [1, 1]];
  assert.equal(isWin(st), false);
  // 挡块站在目标上不改变判定
  st.boxes = st.goals.map((g) => [...g]);
  st.blocker = [...st.goals[0]];
  assert.equal(isWin(st), true);
  st.boxes = [st.goals[0], [1, 1]];
  st.blocker = [...st.goals[1]];
  assert.equal(isWin(st), false);
});

// ---------- A7 撤销语义 ----------
check("A7 倾斜前快照；拖 3 次后撤销，箱子/挡块/步数一起回退", () => {
  for (const lv of LEVELS) {
    const st = createState(lv);
    const before = signature(st);
    applySettle(st, "down");
    assert.equal(st.moves, 1);
    const free = freeCells(st).filter(([x, y]) => !st.boxes.some(([bx, by]) => bx === x && by === y));
    for (let i = 0; i < 3; i++) dragBlocker(st, free[i][0], free[i][1]);
    assert.equal(st.moves, 1, "拖拽不计步");
    assert.equal(undo(st), true, `${lv.id} 撤销应成功`);
    assert.equal(signature(st), before, `${lv.id} 撤销未回到倾斜前`);
    assert.equal(st.history.length, 0);
    assert.equal(canUndo(st), false);
    assert.equal(undo(st), false, "栈空再撤销应失败");
  }
});

check("A7 连按可一路回开局；重开清空栈且不进栈", () => {
  const st = createState(LEVELS.find((l) => l.id === "M9"));
  for (let i = 0; i < 6; i++) applySettle(st, DIRS[i % 4]);
  while (canUndo(st)) undo(st);
  assert.equal(st.moves, 0);
  assert.equal(signature(st), signature(createState(LEVELS.find((l) => l.id === "M9"))));
  applySettle(st, "left");
  restart(st);
  assert.equal(st.moves, 0);
  assert.equal(st.history.length, 0);
});

// ---------- A8 12 关最优解可通 ----------
// 求解器把挡块当作"每步可自由选择放/不放"，而正式关卡有初始 K。
// 因此没有 @ 的步骤要先把它挪到一条不挡任何箱子的空位上（拖拽免费、不计步）。
function pathSet(st, dir) {
  const [dx, dy] = DELTA[dir];
  const set = new Set();
  for (const [x, y] of st.boxes) {
    let cx = x;
    let cy = y;
    for (;;) {
      cx += dx;
      cy += dy;
      if (!inBounds(cx, cy) || st.cells[cy][cx] === "#") break;
      set.add(`${cx},${cy}`);
    }
  }
  return set;
}
function inBounds(x, y) {
  return x >= 0 && x < W && y >= 0 && y < H;
}
function park(st, dir) {
  const blocked = pathSet(st, dir);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (st.cells[y][x] === "#") continue;
      if (st.boxes.some(([bx, by]) => bx === x && by === y)) continue;
      if (blocked.has(`${x},${y}`)) continue;
      if (st.blocker[0] === x && st.blocker[1] === y) return;
      dragBlocker(st, x, y);
      return;
    }
  }
  throw new Error("找不到可停放的挡块空位");
}

check("A8 按求解器序列逐关跑通（含挡块避让），步数等于表内最短", () => {
  for (const lv of LEVELS) {
    const st = createState(lv);
    const sol = SOLUTIONS[lv.id];
    assert.equal(sol.moves.length, sol.tilts, `${lv.id} 解长度不符`);
    for (const step of sol.moves) {
      if (step.blocker) {
        assert.equal(canPlaceBlocker(st, step.blocker[0], step.blocker[1]), true, `${lv.id} 挡块落点非法`);
        dragBlocker(st, step.blocker[0], step.blocker[1]);
      } else {
        park(st, step.dir);
      }
      applySettle(st, step.dir);
      assertInvariants(st);
    }
    assert.equal(isWin(st), true, `${lv.id} 未通关，箱子=${st.boxes.map((b) => b.join(","))} 目标=${st.goals.map((g) => g.join(","))}`);
    assert.equal(st.moves, lv.minTilts, `${lv.id} 步数 ${st.moves} != ${lv.minTilts}`);
  }
});

// ---------- §2.6 边界判定（容易写反的两条） ----------
// 便捷构造：只给 cells/boxes/blocker，绕过关卡校验（这些是规则微例，不是正式关卡）
function mkState(rows, boxes, blocker) {
  const cells = rows.map((r) => [...r].map((ch) => (ch === "T" ? "T" : ch === "#" ? "#" : ".")));
  const goals = [];
  cells.forEach((row, y) => row.forEach((ch, x) => ch === "T" && goals.push([x, y])));
  return { id: "synthetic", name: "synthetic", minTilts: 1, cells, goals, boxes, blocker, moves: 0, history: [] };
}

check("§2.6 箱子贴箱：整串一起走，不是被挡住", () => {
  const rows = [
    "#######", "#.....#", "#.BBB.#", "#.....#", "#.....#", "#.....#", "#....T#", "#....T#", "#######",
  ];
  const st = mkState(rows, [[2, 2], [3, 2], [4, 2]], [1, 7]);
  const moved = settle(st, "right").boxes;
  assert.deepEqual(moved.map((b) => b.join(",")).sort(), ["3,2", "4,2", "5,2"].sort());
});

check("§2.6 箱子经过目标格不停", () => {
  const rows = [
    "#######", "#.....#", "#B.T..#", "#.....#", "#.....#", "#.....#", "#....T#", "#.....#", "#######",
  ];
  const st = mkState(rows, [[1, 2]], [6, 8]);
  const moved = settle(st, "right").boxes;
  assert.deepEqual(moved, [[5, 2]], "应一路滑到墙边，越过 (3,2) 的目标");
});

check("§2.6 箱子贴挡块不动；挡块不被推走", () => {
  const rows = [
    "#######", "#.....#", "#.B...#", "#.....#", "#.....#", "#.....#", "#....T#", "#....T#", "#######",
  ];
  const st = mkState(rows, [[2, 2]], [3, 2]);
  const moved = settle(st, "right").boxes;
  assert.deepEqual(moved, [[2, 2]]);
  assert.deepEqual(st.blocker, [3, 2]);
});

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail === 0 ? 0 : 1);
