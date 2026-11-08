// Pages 子路径部署模拟：只把 index.html + css/ + js/ 拷到 <tmp>/gravity-sokoban/，
// 以 /gravity-sokoban/ 访问（等价 GitHub 项目页地址），验证无绝对路径、无 404、可玩。
// 运行：node tests/pages-sim.test.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9339;
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}
function killTree(pid) {
  return new Promise((r) => {
    const p = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    p.on("exit", r);
    p.on("error", r);
  });
}

// ---- 组装发布包（只挑游戏本体，模拟仓库根目录） ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gs-pages-"));
const site = path.join(tmp, "gravity-sokoban");
fs.mkdirSync(path.join(site, "js"), { recursive: true });
fs.mkdirSync(path.join(site, "css"), { recursive: true });
fs.copyFileSync(path.join(root, "index.html"), path.join(site, "index.html"));
fs.copyFileSync(path.join(root, "css/app.css"), path.join(site, "css/app.css"));
for (const f of fs.readdirSync(path.join(root, "js"))) {
  fs.copyFileSync(path.join(root, "js", f), path.join(site, "js", f));
}
const publishFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else publishFiles.push([path.relative(site, p), fs.statSync(p).size]);
  }
})(site);
const publishBytes = publishFiles.reduce((n, [, s]) => n + s, 0);

// ---- 静态服务（顶层目录 = tmp，站点在 /gravity-sokoban/） ----
const notFound = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let p = path.join(tmp, decodeURIComponent(u.pathname));
  if (!p.startsWith(tmp)) { res.writeHead(403); return res.end("forbidden"); }
  // GitHub Pages 对目录请求返回 index.html，本地模拟也要一致
  try {
    if (fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  } catch { /* 交给下面的 readFile 报 404 */ }
  fs.readFile(p, (err, buf) => {
    if (err) { notFound.push(u.pathname); res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const URL_ = `http://127.0.0.1:${PORT}/gravity-sokoban/`;

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

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "gs-pages-prof-"))}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--window-size=430,900", URL_,
], { stdio: "ignore" });

try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok);
  const dirResp = await fetch(URL_);
  check("子路径目录请求返回 200", dirResp.ok, `HTTP ${dirResp.status}`);
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes("gravity-sokoban")) || list.find((t) => t.type === "page");
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
    if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails?.text);
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") pageErrors.push(m.params.entry.text);
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Log.enable");

  await waitFor(async () => evalJS("document.readyState==='complete' && !!window.__game"));
  check("子路径 /gravity-sokoban/ 可加载", true);
  const info = await evalJS("({ ...__game.constants })");
  check("12 关、7×9 正常", info.levels === 12 && info.W === 7 && info.H === 9, JSON.stringify(info));

  const bg = await evalJS("getComputedStyle(document.body).backgroundColor");
  check("css 走相对路径加载成功", bg === "rgb(11, 14, 20)", bg);

  await evalJS("document.querySelector('#pad button[data-dir=\"down\"]').click()");
  await waitFor(async () => !(await evalJS("__game.isAnimating()")));
  const s = await evalJS("__game.getState()");
  check("子路径下按钮模式可通关 T1", s.won === true && s.moves === 1, `moves=${s.moves}`);

  fs.mkdirSync(path.join(root, "shots"), { recursive: true });
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(root, "shots/pages-sim.png"), Buffer.from(shot.data, "base64"));

  check("页面无 JS 异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 240));
  check("发布包内无 404 请求", notFound.length === 0, notFound.join(", "));
  check("发布包体积 < 300KB", publishBytes < 300 * 1024, `${publishBytes} B / ${publishFiles.length} 文件：${publishFiles.map(([n]) => n).join(", ")}`);
} catch (err) {
  check("测试执行", false, err.message);
} finally {
  try { ws && ws.close(); } catch {}
  await killTree(chrome.pid);
  server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail === 0 ? 0 : 1);
