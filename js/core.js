// core.js — 纯规则内核，无 DOM、无渲染。浏览器与 Node 共用。
// 规格来源：docs/GAME_DESIGN.md v0.2 §2（结算/挡块/胜负）、§3.2（触发）、§3.6（撤销）。

export const W = 7;
export const H = 9;

export const DELTA = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

export const DIRS = ["up", "down", "left", "right"];

// 真机方向符号（R1）：beta/gamma 的正负与屏幕上下左右的关系依赖机型与持握，
// 上真机试一次后把对应轴改成 -1。stage 2 接传感器时才用得到。
export const FLIP = { x: 1, y: 1 };

const key = (x, y) => y * W + x;
const inBounds = (x, y) => x >= 0 && x < W && y >= 0 && y < H;

/** 解析一关：cells[y][x] ∈ {'#','.','T'}，boxes/goals 为 [x,y]，blocker 唯一。 */
export function createState(def) {
  const cells = [];
  const boxes = [];
  const goals = [];
  let blocker = null;

  def.tiles.forEach((row, y) => {
    if (row.length !== W) throw new Error(`${def.id} 第 ${y} 行宽度 ${row.length} != ${W}`);
    const line = row.split("");
    const map = line.map((ch) => (ch === "T" ? "T" : ch === "#" ? "#" : "."));
    cells.push(map);
    line.forEach((ch, x) => {
      if (ch === "B") boxes.push([x, y]);
      else if (ch === "T") goals.push([x, y]);
      else if (ch === "K") {
        if (blocker) throw new Error(`${def.id} 有多个 K`);
        blocker = [x, y];
      } else if (ch !== "#" && ch !== ".") {
        throw new Error(`${def.id} 非法字符 ${ch} @(${x},${y})`);
      }
    });
  });

  if (def.tiles.length !== H) throw new Error(`${def.id} 行数 ${def.tiles.length} != ${H}`);
  if (!blocker) throw new Error(`${def.id} 缺少 K`);
  if (boxes.length !== goals.length) throw new Error(`${def.id} 箱数 ${boxes.length} != 目标数 ${goals.length}`);
  if (boxes.some(([x, y]) => cells[y][x] === "#")) throw new Error(`${def.id} 箱子在墙上`);

  const state = {
    id: def.id,
    name: def.name,
    minTilts: def.minTilts,
    cells,
    goals,
    boxes: boxes.map((b) => [...b]),
    blocker: [...blocker],
    moves: 0,
    history: [],
  };
  state.start = snapshot(state); // 重开用
  return state;
}

export function snapshot(state) {
  return {
    boxes: state.boxes.map((b) => [...b]),
    blocker: [...state.blocker],
    moves: state.moves,
  };
}

export function restore(state, snap) {
  state.boxes = snap.boxes.map((b) => [...b]);
  state.blocker = [...snap.blocker];
  state.moves = snap.moves;
}

/** 一次倾斜的结算（§2.2）：按“到边缘的格数”升序，前箱先走，逐格试探。 */
export function settle(state, dir) {
  const [dx, dy] = DELTA[dir];
  if (!dx && !dy) throw new Error(`bad dir ${dir}`);

  const order = state.boxes.map(([x, y], i) => {
    const t = dir === "right" ? W - 1 - x : dir === "left" ? x : dir === "down" ? H - 1 - y : y;
    return { i, x, y, t };
  });
  order.sort((a, b) => a.t - b.t || a.y - b.y || a.x - b.x);

  const occ = new Set(state.boxes.map(([x, y]) => key(x, y)));
  const bk = key(state.blocker[0], state.blocker[1]);
  occ.add(bk);

  const boxes = new Array(state.boxes.length);
  const moves = [];

  for (const item of order) {
    let { x, y } = item;
    occ.delete(key(x, y));
    let stopped = "wall";
    for (;;) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny) || state.cells[ny][nx] === "#") {
        stopped = "wall";
        break;
      }
      if (key(nx, ny) === bk) {
        stopped = "blocker";
        break;
      }
      if (occ.has(key(nx, ny))) {
        stopped = "box";
        break;
      }
      x = nx;
      y = ny;
    }
    occ.add(key(x, y));
    boxes[item.i] = [x, y];
    moves.push({
      i: item.i,
      from: [item.x, item.y],
      to: [x, y],
      steps: Math.abs(x - item.x) + Math.abs(y - item.y),
      stopped,
    });
  }
  return { boxes, moves };
}

/** A3 用的参考实现：逐格微步进的“真·同时滑动”，与 settle 结果必须逐例相等。 */
export function settleReference(state, dir) {
  const [dx, dy] = DELTA[dir];
  const boxes = state.boxes.map((b) => [...b]);
  const bk = [state.blocker[0], state.blocker[1]];
  const n = boxes.length;

  for (let guard = 0; guard < 100; guard++) {
    const movable = new Array(n).fill(false);
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < n; i++) {
        if (movable[i]) continue;
        const [x, y] = boxes[i];
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(nx, ny) || state.cells[ny][nx] === "#") continue;
        if (nx === bk[0] && ny === bk[1]) continue;
        const j = boxes.findIndex((b, idx) => idx !== i && b[0] === nx && b[1] === ny);
        if (j === -1 || movable[j]) {
          movable[i] = true;
          grew = true;
        }
      }
    }
    if (!movable.some(Boolean)) break;
    for (let i = 0; i < n; i++) {
      if (movable[i]) {
        boxes[i][0] += dx;
        boxes[i][1] += dy;
      }
    }
  }
  return boxes;
}

/** 倾斜一步：先存快照再结算。步数只统计倾斜，拖拽不进栈（§3.6）。 */
export function applySettle(state, dir) {
  const snap = snapshot(state);
  const { boxes, moves } = settle(state, dir);
  state.history.push(snap);
  state.boxes = boxes;
  state.moves += 1;
  return moves;
}

export function canUndo(state) {
  return state.history.length > 0;
}

/** 撤销 = 弹出最近快照，箱子/挡块/步数一起回退。 */
export function undo(state) {
  const snap = state.history.pop();
  if (!snap) return false;
  restore(state, snap);
  return true;
}

/** 重开 = 回到开局快照，步数归零，栈清空；不进撤销栈。 */
export function restart(state) {
  restore(state, state.start);
  state.history.length = 0;
}

export function canPlaceBlocker(state, x, y) {
  if (!inBounds(x, y)) return false;
  if (state.cells[y][x] === "#") return false;
  return !state.boxes.some(([bx, by]) => bx === x && by === y);
}

/** 拖拽 = 直接落格，不模拟路径；非法落点不改棋盘（§2.3）。返回是否移动。 */
export function dragBlocker(state, x, y) {
  if (!canPlaceBlocker(state, x, y)) return false;
  if (state.blocker[0] === x && state.blocker[1] === y) return false;
  state.blocker = [x, y];
  return true;
}

export function isWin(state) {
  if (!state.boxes.length) return false;
  return state.boxes.every(([x, y]) => state.cells[y][x] === "T");
}

/** 稳定签名，用于 A1 回放比对。 */
export function signature(state) {
  return JSON.stringify({
    boxes: state.boxes.map(([x, y]) => `${x},${y}`).join("|"),
    blocker: state.blocker.join(","),
    moves: state.moves,
  });
}

/** 倾斜触发状态机（§3.2 / §3.4）。输入是相对零偏的 (db, dg) 与时间戳（ms）。 */
export class Trigger {
  constructor(opts = {}) {
    this.triggerDeg = opts.triggerDeg ?? 20.5;
    this.releaseDeg = opts.releaseDeg ?? 5.7;
    this.holdMs = opts.holdMs ?? 80;
    this.axisRatio = opts.axisRatio ?? 2.0;
    this.minorEps = opts.minorEps ?? 0.5;
    this.armed = true;
    this.holdSince = null;
  }

  /** 切后台/锁屏恢复：必须回正才能再触发（§3.4）。 */
  reset() {
    this.armed = false;
    this.holdSince = null;
  }

  /** 返回方向或 null。调用方只在返回非 null 时结算一次。 */
  feed(db, dg, now) {
    const ab = Math.abs(db);
    const ag = Math.abs(dg);
    const M = Math.max(ab, ag);
    const m = Math.min(ab, ag);

    if (this.armed && M >= this.triggerDeg) {
      // 除零保护：次分量过小视为纯轴输入，直接通过轴比闸门（§3.2）
      const axisOk = m < this.minorEps || M / m >= this.axisRatio;
      if (axisOk) {
        this.armed = false;
        this.holdSince = null;
        const yAxis = ab >= ag;
        if (yAxis) return db * FLIP.y > 0 ? "down" : "up";
        return dg * FLIP.x > 0 ? "right" : "left";
      }
    }

    if (!this.armed) {
      if (M <= this.releaseDeg) {
        if (this.holdSince === null) this.holdSince = now;
        if (now - this.holdSince >= this.holdMs) {
          this.armed = true;
          this.holdSince = null;
        }
      } else {
        this.holdSince = null;
      }
    }
    return null;
  }
}
