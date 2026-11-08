// 游戏页传感器验收：把 spike 的 cdp-test 迁到游戏页，保留原 15 条等价断言，
// 补 A4（抖动不刷步）、A9（后台恢复不白算）、A11（兜底）各一条可见结果。
// 运行：node tests/cdp-game.test.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9338;
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const rel = u.pathname === "/" ? "/index.html" : u.pathname;
  const p = path.join(root, decodeURIComponent(rel));
  if (!p.startsWith(root)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-cdp-game-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${userDir}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  "--window-size=430,900", `http://127.0.0.1:${PORT}/index.html`,
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
async function waitFor(fn, timeout = 20000, step = 80) {
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
    p.on("exit", r);
    p.on("error", r);
  });
}

// —— 注入 deviceorientation 事件（真事件路径，走游戏里的监听器） ——
async function feed(beta, gamma) {
  const lit = (v) => (v === null ? "null" : Number.isNaN(v) ? "NaN" : String(v));
  await evalJS(`(() => {
    const e = new Event('deviceorientation');
    Object.defineProperty(e, 'beta', { value: ${lit(beta)} });
    Object.defineProperty(e, 'gamma', { value: ${lit(gamma)} });
    Object.defineProperty(e, 'alpha', { value: 0 });
    window.dispatchEvent(e);
  })()`);
}
const state = () => evalJS("__game.getState()");
const info = () => evalJS("__game.sensorInfo()");
const mode = () => evalJS("__game.sensorMode()");
const notice = () => evalJS("__game.noticeText()");
const idle = () => waitFor(async () => !(await evalJS("__game.isAnimating()")));

async function rearm() {
  await feed(0, 0);
  await sleep(110);
  await feed(0, 0);
  await sleep(20);
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

  // ===== 原 1–4：环境与监听 =====
  check("原1 游戏页加载 + 内核就绪", (await evalJS("!!window.__game")) === true);
  check("原2 localhost 属安全上下文", (await evalJS("window.isSecureContext")) === true);
  let inf = await info();
  check("原3 DeviceOrientationEvent 存在", inf.supported === true, JSON.stringify({ supported: inf.supported }));
  inf = await waitFor(async () => { const i = await info(); return i.listening ? i : null; });
  check("原4 授权通过并挂上监听", inf.listening === true, `state=${inf.state}`);

  // ===== A11：3 秒 0 数据 → 按钮模式 =====
  const noData = await waitFor(async () => ((await mode()) === "buttons" ? await info() : null), 6000);
  check("A11 3 秒 0 数据 → 按钮模式", noData.state === "no-data" && (await mode()) === "buttons", `state=${noData.state}`);
  const noticeText = await notice();
  check("A11 顶部提示已出现", /已切换到方向键/.test(noticeText), noticeText);

  // A11：按钮模式完整通关一关（T1）
  await evalJS('__game.loadLevelById("T1")');
  await evalJS("document.querySelector('#pad button[data-dir=\"down\"]').click()");
  await idle();
  const padWin = await state();
  check("A11 按钮模式完整通关 T1", padWin.won === true && padWin.moves === 1, `moves=${padWin.moves} won=${padWin.won}`);

  // 原13：rAF 循环
  const f1 = await evalJS("__game.frames()");
  await sleep(320);
  const f2 = await evalJS("__game.frames()");
  check("原13 rAF 循环在跑", f2 - f1 > 5, `frames ${f1}→${f2}`);

  // ===== 原5–6：注入数据 → 校准 =====
  await feed(0.4, -0.6);
  inf = await waitFor(async () => { const i = await info(); return i.state === "live" ? i : null; }, 3000);
  check("原5 注入 deviceorientation → 页面收到", inf.dataEvents > 0 && inf.state === "live", `dataEvents=${inf.dataEvents}`);
  check("原5b 信号恢复后自动切回倾斜模式", (await mode()) === "tilt");

  const sheetOpen = await evalJS("document.getElementById('calibSheet').classList.contains('show')");
  check("原6 首次检测到重力自动弹校准", sheetOpen === true);
  if (sheetOpen) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync(path.join(root, "shots"), { recursive: true });
    fs.writeFileSync(path.join(root, "shots/sensor-calib.png"), Buffer.from(shot.data, "base64"));
  }
  await evalJS("document.getElementById('btnDoCalib').click()");
  await evalJS(`(() => { for (let i = 0; i < 210; i++) {
    const e = new Event('deviceorientation');
    Object.defineProperty(e, 'beta', { value: 0.4 });
    Object.defineProperty(e, 'gamma', { value: -0.6 });
    Object.defineProperty(e, 'alpha', { value: 0 });
    window.dispatchEvent(e);
  } })()`);
  const cal = await waitFor(async () => { const i = await info(); return i.baseline ? i : null; }, 4000);
  const closeB = Math.abs(cal.baseline.b - 0.4) < 0.2 && Math.abs(cal.baseline.g + 0.6) < 0.2;
  check("原6 200 帧均值写入零偏", closeB, JSON.stringify(cal.baseline));
  const storedCalib = await evalJS("localStorage.getItem('lb.gravity.calib')");
  check("原6b 零偏写入 localStorage", typeof storedCalib === "string" && storedCalib.includes('"b"'), String(storedCalib).slice(0, 60));

  // ===== 原7–12：触发与防抖 =====
  await evalJS('__game.loadLevelById("M9")');
  await rearm();
  await feed(25, 0);
  await idle();
  let s = await state();
  check("原7 超过阈值触发一次", s.moves === 1, `moves=${s.moves}`);

  await feed(25, 0);
  await feed(25, 0);
  await idle();
  s = await state();
  const armedNow = await evalJS("__game.triggerArmed()");
  check("原8 持续倾斜不连发 + 重新武装前 armed=false", s.moves === 1 && armedNow === false, `moves=${s.moves} armed=${armedNow}`);

  await rearm();
  const armedAfter = await evalJS("__game.triggerArmed()");
  check("原8b 回正 80ms 后重新武装", armedAfter === true);
  await feed(0, 30);
  await idle();
  s = await state();
  check("原9 第二次倾斜可再触发（gamma 轴）", s.moves === 2, `moves=${s.moves}`);

  // 原10 + A4：抖动不刷步
  await rearm();
  const beforeJitter = (await state()).moves;
  for (let i = 0; i < 20; i++) {
    await feed(i % 2 ? -25 : 25, 0);
    await sleep(15);
  }
  await idle();
  const afterJitter = (await state()).moves;
  check("A4 快速左右倾 20 次不回正，最多结算 1 次", afterJitter - beforeJitter === 1, `${beforeJitter}→${afterJitter}`);

  // 原11：45° 斜倾丢弃
  await rearm();
  const before45 = (await state()).moves;
  await feed(25, 25);
  await idle();
  const after45 = (await state()).moves;
  check("原11 45° 斜倾被丢弃", after45 === before45, `moves=${after45}`);

  // 原12：持续倾斜不连发
  await rearm();
  const beforeHold = (await state()).moves;
  for (let i = 0; i < 6; i++) { await feed(25, 0); await sleep(80); }
  await idle();
  const afterHold = (await state()).moves;
  check("原12 持续倾斜 2 秒不连发", afterHold - beforeHold === 1, `${beforeHold}→${afterHold}`);

  // 原14：倾斜与方向键走同一个结算入口
  await evalJS('__game.loadLevelById("T3")');
  await rearm();
  await feed(25, 0);
  await idle();
  const tiltBoxes = (await state()).boxes;
  await evalJS("__game.restart()");
  await evalJS("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))");
  await idle();
  const keyBoxes = (await state()).boxes;
  check("原14 倾斜与方向键结果逐格一致", JSON.stringify(tiltBoxes) === JSON.stringify(keyBoxes), JSON.stringify(keyBoxes));

  // 原15：零偏持久化（重载后复用，不重弹校准）
  await send("Page.reload");
  await waitFor(async () => evalJS("document.readyState==='complete' && !!window.__game"));
  const afterReload = await info();
  const persistOk = afterReload.baseline && Math.abs(afterReload.baseline.b - 0.4) < 0.2;
  const resheet = await evalJS("document.getElementById('calibSheet').classList.contains('show')");
  check("原15 重载后复用零偏、不重复弹校准", !!persistOk && resheet === false, JSON.stringify(afterReload.baseline));

  // ===== A9：后台恢复不白算 =====
  await evalJS('__game.loadLevelById("M9")');
  await feed(0, 0);
  await waitFor(async () => (await info()).state === "live");
  await evalJS("__game.testVisibility(true)");
  await sleep(150);
  const hiddenState = await info();
  await evalJS("__game.testVisibility(false)");
  await feed(25, 0); // 回前台第一帧：必须被丢弃
  await idle();
  const afterResume = await state();
  check("A9 回前台第一帧不结算", afterResume.moves === 0, `moves=${afterResume.moves} hidden=${hiddenState.state}`);
  await sleep(230);
  await rearm();
  await feed(25, 0);
  await idle();
  const afterRearm = await state();
  check("A9 回正后仍可正常触发", afterRearm.moves === 1, `moves=${afterRearm.moves}`);

  // ===== A11：异常帧 =====
  await feed(NaN, 0);
  await idle();
  const afterNaN = await state();
  check("A11 单帧 NaN 丢弃、不消耗步数", afterNaN.moves === 1, `moves=${afterNaN.moves}`);
  await feed(-80, 0); // 相对上一帧跳变 > 90°
  await idle();
  const afterJump = await state();
  check("A11 跳变 >90° 丢弃、不消耗步数", afterJump.moves === 1, `moves=${afterJump.moves}`);
  for (let i = 0; i < 20; i++) await feed(NaN, 0);
  const failed = await info();
  await waitFor(async () => (await mode()) === "buttons", 2000);
  check("A11 连续 20 帧异常 → 按钮模式", failed.state === "failed" && (await mode()) === "buttons", `state=${failed.state}`);

  // ===== A11：无 API 直接兜底 =====
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: "Object.defineProperty(window, 'DeviceOrientationEvent', { value: undefined, configurable: true });",
  });
  await send("Page.reload");
  await waitFor(async () => evalJS("document.readyState==='complete' && !!window.__game"));
  const noApi = await info();
  await sleep(200);
  check("A11 无 DeviceOrientationEvent → 直接按钮模式", noApi.supported === false && (await mode()) === "buttons", `supported=${noApi.supported}`);
  const noApiNotice = await notice();
  check("A11 无 API 时顶部提示", /已切换到方向键/.test(noApiNotice), noApiNotice);

  check("页面无 JS 异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
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
