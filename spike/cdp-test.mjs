// 传感器探针的自动化验证：起本地静态服务 → 无头 Chrome → CDP 注入 DeviceOrientation → 断言触发模型。
// 用法：node spike/cdp-test.mjs
// 依赖：Chrome（默认路径可用 CHROME 环境变量覆盖）、Node 18+（自带 fetch / WebSocket）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "sensor-probe");
const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9333;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// ---------- 静态服务 ----------
const server = http.createServer((req, res) => {
  let p = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (req.url === "/" || req.url.startsWith("/?")) p = path.join(ROOT, "index.html");
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const URL_ = `http://127.0.0.1:${PORT}/index.html`;
console.log(`serving ${ROOT} at ${URL_}`);

// ---------- 启动 Chrome ----------
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-cdp-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${userDir}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  "--window-size=430,932",
  URL_
], { stdio: "ignore" });

let ws = null, msgId = 0;
const pending = new Map();
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

async function waitFor(fn, timeout = 20000, step = 250) {
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
  const ver = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
  console.log(`chrome: ${ver.Browser}`);
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes(`:${PORT}`)) || list.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });

  await send("Runtime.enable");
  await send("Page.enable");
  await waitFor(async () => evalJS("document.readyState==='complete' && !!window.__probe"));

  const s0 = await evalJS("window.__probe.snapshot()");
  check("页面加载 + probe 就绪", !!s0 && typeof s0.events === "number");
  check("localhost 属安全上下文", s0.secure === true, `secure=${s0.secure}`);
  check("DeviceOrientationEvent 存在", s0.api === true, `api=${s0.api} permFn=${s0.permFn}`);

  // 真实 iOS 路径：先点按钮（用户手势）再挂监听，这里模拟这一下点击
  console.log("perm 前置状态:", JSON.stringify(await evalJS("window.__probe.snapshot().perm")));
  await evalJS("document.getElementById('btnEnable').click()");
  await sleep(400);
  const sBtn = await evalJS("window.__probe.snapshot()");
  check("点击授权按钮后进入监听态", ["granted", "listening", "granted(no-fn)"].includes(sBtn.perm), `perm=${sBtn.perm}`);

  // 传感器注入：优先走真实事件管线（CDP DeviceOrientation 域），失败再退回页面模拟钩子
  let injected = false;
  try {
    await send("DeviceOrientation.setDeviceOrientationOverride", { alpha: 0, beta: 0, gamma: 0 });
    await sleep(600);
    const s = await evalJS("window.__probe.snapshot()");
    injected = s.events > 0;
    check("CDP 方向注入 → 页面收到 deviceorientation", injected, `events=${s.events} hz=${s.hz}`);
  } catch (e) {
    check("CDP 方向注入 → 页面收到 deviceorientation", false, "CDP 调用失败：" + e.message);
  }

  const feed = async (beta, gamma) => {
    if (!injected) return evalJS(`window.__probe.simulate(${beta},${gamma})`);
    await send("DeviceOrientation.setDeviceOrientationOverride", { alpha: 0, beta, gamma });
    await sleep(350);
    return evalJS("window.__probe.snapshot()");
  };

  // 归零 + 校准
  await feed(0, 0);
  await evalJS("window.__probe.calibrate()");
  check("基准可记录（直立/平放姿态自适应）", (await evalJS("window.__probe.snapshot()")).base.beta === 0);

  const a1 = await feed(22, 0);
  check("超过阈值触发一次（一次倾斜=一次结算）", a1.fires === 1 && a1.armed === false, `fires=${a1.fires} dir=${a1.lastDir} mag=${a1.mag}`);

  // CDP 只在姿态值变化时推事件，同值不重发：用 1° → 0° 制造两次回正内的事件
  await feed(1, 0);
  const a2 = await feed(0, 0);
  check("回正保持 80ms 后重新武装（设计稿口径）", a2.armed === true && a2.fires === 1, `armed=${a2.armed} fires=${a2.fires}`);

  const a3 = await feed(0, 30);
  check("第二次倾斜可再触发（gamma 轴）", a3.fires === 2, `fires=${a3.fires} dir=${a3.lastDir}`);

  await feed(0, 0);
  let jitterFires = 0;
  for (const g of [6, -6, 5, -4]) { const s = await feed(0, g); jitterFires = s.fires; }
  check("阈值下抖动不误触", jitterFires === 2, `fires=${jitterFires}`);

  const ar = await feed(22, 22);
  check("45° 斜倾不触发（轴比 1.0 < 2.0）", ar.fires === 2, `fires=${ar.fires} ratio=${ar.ratio}`);

  const a4 = await feed(0, 35);
  const a5 = await feed(0, 35);
  check("持续倾斜不连发", a4.fires === 3 && a5.fires === 3, `fires=${a4.fires}→${a5.fires}`);

  await feed(0, 0);
  await sleep(1200);
  const sFps = await evalJS("window.__probe.snapshot()");
  check("rAF 循环在跑（本机无头 Chrome）", sFps.fps > 0, `fps=${sFps.fps}`);

  const logOk = sFps.log.some((l) => l.includes("FIRE #1"));
  check("触发日志可读（含方向与幅度）", logOk, `log=${sFps.log.length} 行`);
  check("采样频率已统计", sFps.hz > 0 || injected, `hz=${sFps.hz}`);

  // 证据截图（真机读数由用户在手机上截）
  try {
    await send("Runtime.evaluate", { expression: "window.__probe.calibrate()" });
    await feed(0, 28);
    await sleep(300);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const out = path.join(__dirname, "sensor-probe", "preview.png");
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log(`screenshot: ${out}`);
  } catch (e) {
    console.log("screenshot skipped: " + e.message);
  }
} catch (err) {
  check("测试执行", false, err.message);
} finally {
  try { ws && ws.close(); } catch {}
  await killTree(chrome.pid);
  server.close();
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
