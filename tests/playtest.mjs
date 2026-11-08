// 真浏览器验收：起静态服务 → 无头 Chrome → 按求解器最优解逐关点通 12 关，
// 并核对页面状态与 Node 端同一内核逐格一致；附带 A6 动画时序、A7 撤销、拖拽指针事件。
// 运行：node tests/playtest.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LEVELS } from "../js/levels.js";
import { SOLUTIONS } from "./solutions.mjs";
import {
  W, H, DELTA, createState, applySettle, dragBlocker, canPlaceBlocker, isWin, signature,
} from "../js/core.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9334;
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png",
  ".mjs": "text/javascript; charset=utf-8",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; failures.push(name); console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}

// ---------- Node 端预演（与页面同一份 core.js） ----------
function park(st, dir) {
  const [dx, dy] = DELTA[dir];
  const blocked = new Set();
  for (const [x, y] of st.boxes) {
    let cx = x;
    let cy = y;
    for (;;) {
      cx += dx; cy += dy;
      if (cx < 0 || cx >= W || cy < 0 || cy >= H || st.cells[cy][cx] === "#") break;
      blocked.add(`${cx},${cy}`);
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (st.cells[y][x] === "#") continue;
      if (st.boxes.some(([bx, by]) => bx === x && by === y)) continue;
      if (blocked.has(`${x},${y}`)) continue;
      if (st.blocker[0] === x && st.blocker[1] === y) return null;
      return [x, y];
    }
  }
  throw new Error("没有可停放挡块的空位");
}

function buildPlan(level) {
  const st = createState(level);
  const ops = [];
  const snap = () => ({ boxes: st.boxes.map((b) => b.join(",")).join("|"), blocker: st.blocker.join(","), moves: st.moves });
  for (const step of SOLUTIONS[level.id].moves) {
    if (step.blocker) {
      if (!canPlaceBlocker(st, step.blocker[0], step.blocker[1])) throw new Error(`${level.id} 挡块落点非法`);
      dragBlocker(st, step.blocker[0], step.blocker[1]);
      ops.push({ drag: step.blocker, expect: snap() });
    } else {
      const p = park(st, step.dir);
      if (p) {
        dragBlocker(st, p[0], p[1]);
        ops.push({ drag: p, expect: snap() });
      }
    }
    applySettle(st, step.dir);
    ops.push({ move: step.dir, expect: snap() });
  }
  if (!isWin(st)) throw new Error(`${level.id} Node 预演未通关`);
  return { ops, final: snap() };
}

// ---------- 静态服务 ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const p = path.join(root, rel.replace(/^\/+/, ""));
  if (!p.startsWith(root)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const URL_ = `http://127.0.0.1:${PORT}/index.html`;

// ---------- 浏览器 ----------
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-play-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${userDir}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  "--force-device-scale-factor=2", "--window-size=430,900", URL_,
], { stdio: "ignore" });

let ws = null;
let msgId = 0;
const pending = new Map();
const pageErrors = [];
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
async function evalJS(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
  return r.result.value;
}
async function waitFor(fn, timeout = 20000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > timeout) throw new Error("timeout");
    await sleep(step);
  }
}
function killTree(pid) {
  return new Promise((r) => {
    const p = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    p.on("exit", r); p.on("error", r);
  });
}

try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok);
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes(`:${PORT}`)) || list.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      return;
    }
    if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") pageErrors.push(m.params.entry.text);
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Log.enable");

  await waitFor(async () => evalJS("document.readyState==='complete' && !!window.__game"));
  check("页面加载 + 内核就绪", true);

  const info = await evalJS("({ ...__game.constants })");
  check("常量 7×9 / 12 关", info.W === 7 && info.H === 9 && info.levels === 12, JSON.stringify(info));

  // 逐关：按最优解点通，且每一步页面状态与 Node 预演一致
  let totalTilts = 0;
  const shots = [];
  for (const lv of LEVELS) {
    const plan = buildPlan(lv);
    await evalJS(`__game.loadLevelById("${lv.id}")`);
    if (lv.id === "T1") {
      const s0shot = await send("Page.captureScreenshot", { format: "png" });
      shots.push(["T1_start", s0shot.data]);
    }
    let mismatch = null;
    for (const op of plan.ops) {
      if (op.drag) await evalJS(`__game.dragTo(${op.drag[0]},${op.drag[1]})`);
      else await evalJS(`__game.move("${op.move}")`);
      await waitFor(async () => !(await evalJS("__game.isAnimating()")));
      const s = await evalJS("__game.getState()");
      const got = {
        boxes: s.boxes.map((b) => b.join(",")).join("|"),
        blocker: s.blocker.join(","),
        moves: s.moves,
      };
      if (got.boxes !== op.expect.boxes || got.blocker !== op.expect.blocker || got.moves !== op.expect.moves) {
        mismatch = { op, got, want: op.expect };
        break;
      }
    }
    const fin = await evalJS("__game.getState()");
    const ok = !mismatch && fin.won === true && fin.moves === lv.minTilts;
    totalTilts += fin.moves;
    check(`${lv.id} 通关（${fin.moves} 步，最少 ${lv.minTilts}）`, ok, mismatch ? JSON.stringify(mismatch) : "");
    if (lv.id === "T1" || lv.id === "M4") {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      shots.push([lv.id, shot.data]);
    }
  }
  check("12 关合计倾斜 32 次", totalTilts === 32, `total=${totalTilts}`);

  const cleared = await evalJS("__game.getState().cleared");
  check("通关进度写入 localStorage（12 关）", Object.keys(cleared).length === 12, JSON.stringify(cleared));
  const stored = await evalJS("localStorage.getItem('lb.gravity.progress')");
  check("存储 key 前缀 lb.gravity.", typeof stored === "string" && stored.includes('"T1"'), String(stored).slice(0, 60));

  // 选关面板
  await evalJS("document.getElementById('btnLevels2').click()");
  const sheetOpen = await evalJS("document.getElementById('levelSheet').classList.contains('show')");
  check("选关面板可打开", sheetOpen === true);
  await evalJS("document.querySelector('.lvbtn[data-id=\\'M9\\']').click()");
  const picked = await evalJS("__game.getState().levelId");
  const sheetClosed = await evalJS("document.getElementById('levelSheet').classList.contains('show')");
  check("选关面板点 M9 可进关并关闭", picked === "M9" && sheetClosed === false, `${picked}/${sheetClosed}`);

  // 重开
  await evalJS('__game.loadLevelById("M4")');
  await evalJS('__game.move("down")');
  await waitFor(async () => !(await evalJS("__game.isAnimating()")));
  await evalJS("document.getElementById('btnRestart').click()");
  const restarted = await evalJS("__game.getState()");
  check("重开：步数归零、撤销栈清空", restarted.moves === 0 && restarted.canUndo === false && restarted.history === 0);

  // 方向键（桌面兜底）
  await evalJS('__game.loadLevelById("T1")');
  await evalJS("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))");
  await waitFor(async () => !(await evalJS("__game.isAnimating()")));
  const byKey = await evalJS("__game.getState()");
  check("方向键 ↓ 触发结算（桌面兜底）", byKey.moves === 1 && byKey.won === true, `moves=${byKey.moves} won=${byKey.won}`);

  // 屏幕方向按钮（触控兜底，与传感器同一入口）
  await evalJS('__game.loadLevelById("T1")');
  await evalJS("document.querySelector('#pad button[data-dir=\\'down\\']').click()");
  await waitFor(async () => !(await evalJS("__game.isAnimating()")));
  const byPad = await evalJS("__game.getState()");
  check("屏幕 ↓ 按钮触发结算（触控兜底）", byPad.moves === 1 && byPad.won === true, `moves=${byPad.moves} won=${byPad.won}`);

  // A6：动画未结束不判胜
  await evalJS('__game.loadLevelById("T1")');
  await evalJS('__game.move("down")');
  const mid = await evalJS("__game.getState()");
  check("A6 动画未结束不弹胜利", mid.animating === true && mid.won === false, JSON.stringify({ animating: mid.animating, won: mid.won }));
  await waitFor(async () => !(await evalJS("__game.isAnimating()")));
  const after = await evalJS("__game.getState()");
  check("A6 动画结束后判胜", after.won === true);

  // A7：撤销回到倾斜前（箱子 + 挡块 + 步数）；倾斜后的拖拽不进快照
  await evalJS('__game.loadLevelById("M7")');
  await evalJS("__game.dragTo(1,1)"); // 倾斜前的挡块位置属于快照
  const s0 = await evalJS("__game.getState()");
  await evalJS('__game.move("up")');
  await waitFor(async () => !(await evalJS("__game.isAnimating()")));
  await evalJS("__game.dragTo(2,1)");
  await evalJS("__game.dragTo(3,2)");
  await evalJS("__game.undo()");
  const s1 = await evalJS("__game.getState()");
  check(
    "A7 撤销：箱子/挡块/步数一起回退，拖拽不进栈",
    JSON.stringify(s1.boxes) === JSON.stringify(s0.boxes) && JSON.stringify(s1.blocker) === JSON.stringify(s0.blocker) && s1.moves === 0 && s1.canUndo === false,
    JSON.stringify({ boxes: s1.boxes, blocker: s1.blocker, moves: s1.moves, canUndo: s1.canUndo })
  );

  // 拖拽走真实指针事件路径（T2：挡块初始 (4,7) → 拖到 (3,6)）
  await evalJS('__game.loadLevelById("T2")');
  const from = await evalJS("__game.screenPoint(4,7)");
  const to = await evalJS("__game.screenPoint(3,6)");
  await evalJS(`(() => {
    const c = document.getElementById('board');
    const mk = (type, p) => new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: p.x, clientY: p.y, isPrimary: true });
    c.dispatchEvent(mk('pointerdown', ${JSON.stringify(from)}));
    c.dispatchEvent(mk('pointermove', ${JSON.stringify(to)}));
    c.dispatchEvent(mk('pointerup', ${JSON.stringify(to)}));
  })()`);
  const dragState = await evalJS("__game.getState()");
  check("拖拽：指针事件把挡块吸到目标格", JSON.stringify(dragState.blocker) === "[3,6]", JSON.stringify(dragState.blocker));
  check("拖拽不计步", dragState.moves === 0);

  // 非法拖拽：拖到墙 (0,1)，应弹回
  const wallPt = await evalJS("__game.screenPoint(0,1)");
  await evalJS(`(() => {
    const c = document.getElementById('board');
    const mk = (type, p) => new PointerEvent(type, { bubbles: true, pointerId: 8, pointerType: 'touch', clientX: p.x, clientY: p.y, isPrimary: true });
    c.dispatchEvent(mk('pointerdown', ${JSON.stringify(to)}));
    c.dispatchEvent(mk('pointermove', ${JSON.stringify(wallPt)}));
    c.dispatchEvent(mk('pointerup', ${JSON.stringify(wallPt)}));
  })()`);
  const illegal = await evalJS("__game.getState()");
  check("A5 非法拖拽弹回，挡块不动", JSON.stringify(illegal.blocker) === "[3,6]", JSON.stringify(illegal.blocker));

  check("页面无 JS 异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));

  // 截图
  fs.mkdirSync(path.join(root, "shots"), { recursive: true });
  for (const [id, data] of shots) {
    fs.writeFileSync(path.join(root, `shots/${id}.png`), Buffer.from(data, "base64"));
  }
  console.log(`screenshots: ${shots.map(([id]) => `shots/${id}.png`).join(", ")}`);
} catch (err) {
  check("测试执行", false, err.message);
} finally {
  try { ws && ws.close(); } catch {}
  await killTree(chrome.pid);
  server.close();
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail === 0 ? 0 : 1);
