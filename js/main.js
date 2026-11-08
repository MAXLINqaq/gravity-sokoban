// main.js — 单页 UI：Canvas 渲染、拖拽、方向键、撤销/重开/选关。
// 规格来源：docs/GAME_DESIGN.md v0.2 §5（UI/动效）、§3.5（触控兜底）、§3.6（撤销）。
import {
  W, H, createState, restart, applySettle, undo, canUndo, isWin,
  canPlaceBlocker, dragBlocker,
} from "./core.js";
import { SensorInput, clearCalibration } from "./sensor.js";
import { LEVELS } from "./levels.js";

const HINTS = {
  T1: "往下倾，箱子会滑到墙边",
  T2: "把挡块拖到箱子下面，接住它",
  T3: "两箱会一起滑，一次倾到底",
  M1: "先落到底，再横着推进目标列",
  M2: "先靠到同侧墙，再一起滑下去",
  M3: "挡块要停准一格，差一格都不行",
  M4: "箱子只能从上方落进目标，靠墙顶当搁板",
  M5: "挡块先护住一个，处理另一个",
  M6: "不先让开上面那个，就永远合不上",
  M7: "三箱错列，先顶齐再归列",
  M8: "搁板寄存一个，挡块还得再用一次",
  M9: "三箱 + 搁板 + 三次拖拽，终局",
};

const COLORS = {
  bg: "#0b0e14",
  floor: "#151b26",
  wall: "#273446",
  wallEdge: "#334358",
  goal: "#5b7196",
  goalOn: "#34d399",
  box: "#f3c969",
  boxTop: "#ffe7ab",
  blocker: "#6ee7ff",
  danger: "#f87171",
  text: "#e8eefc",
  dim: "#93a3bb",
};

const app = {
  index: 0,
  state: null,
  anim: null,
  drag: null,
  won: false,
  flash: null,
  cleared: loadProgress(),
  mode: "tilt",          // tilt | buttons（§3.5 两种输入同一个结算入口）
  autoFallback: false,   // 因传感器失效自动切到按钮
  sensor: null,
  noticeTimer: 0,
  cs: 40,
  ox: 0,
  oy: 0,
  dpr: 1,
  cssW: 0,
  cssH: 0,
};

const $ = (s) => document.querySelector(s);
const el = {};
let ctx = null;
let rafId = 0;

function loadProgress() {
  try {
    const raw = localStorage.getItem("lb.gravity.progress");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function saveProgress() {
  try {
    localStorage.setItem("lb.gravity.progress", JSON.stringify(app.cleared));
  } catch { /* 隐私模式忽略 */ }
}

// ---------- 关卡 ----------
function loadLevel(index) {
  app.index = Math.max(0, Math.min(LEVELS.length - 1, index));
  app.state = createState(LEVELS[app.index]);
  app.anim = null;
  app.drag = null;
  app.won = false;
  app.flash = null;
  el.hint.textContent = HINTS[app.state.id] || "";
  el.banner.classList.remove("show");
  hideSheets();
  updateHud();
  markLevelList();
}

function updateHud() {
  const s = app.state;
  el.lvlId.textContent = s.id;
  el.lvlName.textContent = s.name;
  el.moves.textContent = String(s.moves);
  el.best.textContent = `最少 ${s.minTilts} 步`;
  el.undo.disabled = !canUndo(s) || !!app.anim || app.won;
}

function markLevelList() {
  for (const btn of el.levelBtns) {
    const id = btn.dataset.id;
    btn.classList.toggle("cleared", id in app.cleared);
    btn.classList.toggle("current", id === app.state.id);
  }
}

// ---------- 结算 ----------
function tryMove(dir) {
  if (app.anim || app.drag || app.won || !app.state) return false;
  const moves = applySettle(app.state, dir);
  const maxSteps = moves.reduce((n, m) => Math.max(n, m.steps), 0);
  const dur = Math.max(120, Math.min(350, 85 * Math.max(1, maxSteps)));
  app.anim = { t0: performance.now(), dur, maxSteps: Math.max(1, maxSteps), moves };
  updateHud();
  return true;
}

function finishMove() {
  const a = app.anim;
  app.anim = null;
  const stops = a.moves.filter((m) => m.steps > 0).map((m) => m.to);
  if (stops.length) app.flash = { cells: stops, t0: performance.now() };
  const s = app.state;
  if (isWin(s)) {
    app.won = true;
    const prev = app.cleared[s.id];
    if (prev === undefined || s.moves < prev) app.cleared[s.id] = s.moves;
    saveProgress();
    el.bannerText.textContent = `通关 · ${s.moves} 步`;
    el.banner.classList.add("show");
    el.next.disabled = app.index >= LEVELS.length - 1;
  }
  updateHud();
  markLevelList();
}

// ---------- 绘制 ----------
function resize() {
  const wrap = el.wrap;
  const pad = 4;
  const availW = Math.max(120, wrap.clientWidth - pad * 2);
  const availH = Math.max(120, wrap.clientHeight - pad * 2);
  const cs = Math.floor(Math.min(availW / W, availH / H));
  app.cs = Math.max(18, cs);
  app.dpr = Math.min(3, window.devicePixelRatio || 1);
  app.cssW = app.cs * W;
  app.cssH = app.cs * H;
  el.canvas.style.width = `${app.cssW}px`;
  el.canvas.style.height = `${app.cssH}px`;
  el.canvas.width = Math.round(app.cssW * app.dpr);
  el.canvas.height = Math.round(app.cssH * app.dpr);
  ctx.setTransform(app.dpr, 0, 0, app.dpr, 0, 0);
  app.ox = 0;
  app.oy = 0;
  draw(performance.now());
}

function cellX(x) { return x * app.cs; }
function cellY(y) { return y * app.cs; }
function cx(x) { return cellX(x) + app.cs / 2; }
function cy(y) { return cellY(y) + app.cs / 2; }

function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

function boxOnGoal(s, i) {
  const [x, y] = s.boxes[i];
  return s.cells[y][x] === "T";
}

function draw(now) {
  const s = app.state;
  if (!ctx || !s) return;
  const { cs } = app;
  ctx.clearRect(0, 0, app.cssW, app.cssH);

  // 棋盘底：地板铺平 + 细网格，墙做成凸起块（墙/地板必须一眼分开）
  ctx.fillStyle = "#0e141d";
  roundRect(ctx, 0, 0, app.cssW, app.cssH, cs * 0.18);
  ctx.fill();

  ctx.save();
  ctx.strokeStyle = "#18222f";
  ctx.lineWidth = 1;
  for (let x = 1; x < W; x++) {
    ctx.beginPath();
    ctx.moveTo(cellX(x), 0);
    ctx.lineTo(cellX(x), app.cssH);
    ctx.stroke();
  }
  for (let y = 1; y < H; y++) {
    ctx.beginPath();
    ctx.moveTo(0, cellY(y));
    ctx.lineTo(app.cssW, cellY(y));
    ctx.stroke();
  }
  ctx.restore();

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (s.cells[y][x] !== "#") continue;
      const px = cellX(x);
      const py = cellY(y);
      ctx.fillStyle = "#2b3a4f";
      roundRect(ctx, px + 2, py + 2, cs - 4, cs - 4, cs * 0.16);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      roundRect(ctx, px + 2, py + 2, cs - 4, cs * 0.3, cs * 0.14);
      ctx.fill();
      ctx.strokeStyle = "#3c5069";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // 目标格（虚线框；上面有箱子时变实线高亮）
  ctx.save();
  for (const [gx, gy] of s.goals) {
    const occupied = s.boxes.some(([bx, by]) => bx === gx && by === gy);
    if (!occupied) {
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = COLORS.goal;
      roundRect(ctx, cellX(gx) + cs * 0.16, cellY(gy) + cs * 0.16, cs * 0.68, cs * 0.68, cs * 0.14);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = occupied ? COLORS.goalOn : COLORS.goal;
    ctx.lineWidth = Math.max(1.5, cs * 0.045);
    ctx.setLineDash(occupied ? [] : [cs * 0.14, cs * 0.12]);
    roundRect(ctx, cellX(gx) + cs * 0.2, cellY(gy) + cs * 0.2, cs * 0.6, cs * 0.6, cs * 0.14);
    ctx.stroke();
  }
  ctx.restore();

  // 落点闪一下
  if (app.flash) {
    const age = now - app.flash.t0;
    if (age > 220) app.flash = null;
    else {
      const k = 1 - age / 220;
      ctx.save();
      ctx.globalAlpha = k * 0.55;
      ctx.strokeStyle = COLORS.box;
      ctx.lineWidth = Math.max(1, cs * 0.06);
      for (const [fx, fy] of app.flash.cells) {
        roundRect(ctx, cellX(fx) + cs * 0.12, cellY(fy) + cs * 0.12, cs * 0.76, cs * 0.76, cs * 0.16);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // 箱子
  for (let i = 0; i < s.boxes.length; i++) {
    let [x, y] = s.boxes[i];
    let pxX = cellX(x);
    let pxY = cellY(y);
    if (app.anim) {
      const mv = app.anim.moves.find((m) => m.i === i);
      if (mv && mv.steps > 0) {
        const speed = app.anim.maxSteps / app.anim.dur; // 格/毫秒
        const done = Math.min(mv.steps, (now - app.anim.t0) * speed);
        const [dx, dy] = [Math.sign(mv.to[0] - mv.from[0]), Math.sign(mv.to[1] - mv.from[1])];
        pxX = cellX(mv.from[0] + dx * done);
        pxY = cellY(mv.from[1] + dy * done);
      }
    }
    const pad = cs * 0.14;
    const size = cs - pad * 2;
    ctx.save();
    ctx.shadowColor = "rgba(243,201,105,0.35)";
    ctx.shadowBlur = cs * 0.22;
    ctx.fillStyle = COLORS.box;
    roundRect(ctx, pxX + pad, pxY + pad, size, size, cs * 0.22);
    ctx.fill();
    ctx.restore();
    // 高光面，强化“实心方块”的形状识别
    ctx.fillStyle = COLORS.boxTop;
    roundRect(ctx, pxX + pad + cs * 0.12, pxY + pad + cs * 0.12, size - cs * 0.24, size * 0.28, cs * 0.12);
    ctx.fill();
  }

  // 挡块：空心菱形，最亮描边
  const drawBlockerAt = (bx, by, alpha = 1, stroke = COLORS.blocker) => {
    const px = cx(bx);
    const py = cy(by);
    const r = cs * 0.34;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(px, py - r);
    ctx.lineTo(px + r, py);
    ctx.lineTo(px, py + r);
    ctx.lineTo(px - r, py);
    ctx.closePath();
    ctx.fillStyle = "rgba(110,231,255,0.10)";
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(2, cs * 0.075);
    ctx.stroke();
    ctx.restore();
  };

  if (app.drag) {
    // 目标格高亮
    const g = app.drag.cell;
    if (g) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = app.drag.valid ? COLORS.goalOn : COLORS.danger;
      ctx.lineWidth = Math.max(2, cs * 0.06);
      roundRect(ctx, cellX(g[0]) + 2, cellY(g[1]) + 2, cs - 4, cs - 4, cs * 0.16);
      ctx.stroke();
      ctx.restore();
    }
    drawBlockerAt(
      app.drag.px / cs - 0.5,
      app.drag.py / cs - 0.5,
      0.75,
      app.drag.valid ? COLORS.blocker : COLORS.danger
    );
  } else {
    drawBlockerAt(s.blocker[0], s.blocker[1]);
  }

  // 胜利：所有目标呼吸
  if (app.won) {
    const pulse = 0.45 + 0.35 * Math.sin(now / 260);
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = COLORS.goalOn;
    ctx.lineWidth = Math.max(2, cs * 0.06);
    for (const [gx, gy] of s.goals) {
      roundRect(ctx, cellX(gx) + cs * 0.1, cellY(gy) + cs * 0.1, cs * 0.8, cs * 0.8, cs * 0.18);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function loop(now) {
  app.frames = (app.frames || 0) + 1;
  if (app.anim && now - app.anim.t0 >= app.anim.dur) finishMove();
  draw(now);
  rafId = requestAnimationFrame(loop);
}

// ---------- 拖拽 ----------
function toCell(px, py) {
  const x = Math.round(px / app.cs - 0.5);
  const y = Math.round(py / app.cs - 0.5);
  if (x < 0 || x >= W || y < 0 || y >= H) return null;
  return [x, y];
}

function localPoint(ev) {
  const r = el.canvas.getBoundingClientRect();
  return [ev.clientX - r.left, ev.clientY - r.top];
}

function onPointerDown(ev) {
  if (app.anim || app.won || app.drag || !app.state) return;
  const [px, py] = localPoint(ev);
  const [bx, by] = app.state.blocker;
  const hit = Math.hypot(px - cx(bx), py - cy(by)) <= app.cs * 0.55;
  if (!hit) return;
  ev.preventDefault();
  try { el.canvas.setPointerCapture?.(ev.pointerId); } catch { /* 合成事件没有活动指针 */ }
  app.drag = { id: ev.pointerId, px, py, cell: [bx, by], valid: true };
}

function onPointerMove(ev) {
  if (!app.drag || ev.pointerId !== app.drag.id) return;
  ev.preventDefault();
  const [px, py] = localPoint(ev);
  app.drag.px = px;
  app.drag.py = py;
  const c = toCell(px, py);
  app.drag.cell = c;
  app.drag.valid = !!c && canPlaceBlocker(app.state, c[0], c[1]);
}

function onPointerUp(ev) {
  if (!app.drag || ev.pointerId !== app.drag.id) return;
  const d = app.drag;
  app.drag = null;
  const c = toCell(d.px, d.py);
  if (c && canPlaceBlocker(app.state, c[0], c[1])) dragBlocker(app.state, c[0], c[1]);
  updateHud();
  markLevelList();
}

// ---------- 选关 / 帮助 ----------
function hideSheets() {
  el.levelSheet.classList.remove("show");
  el.helpSheet.classList.remove("show");
  el.calibSheet.classList.remove("show");
}

function openLevels() {
  el.levelSheet.classList.add("show");
  el.helpSheet.classList.remove("show");
  el.calibSheet.classList.remove("show");
}

function openHelp() {
  el.helpSheet.classList.add("show");
  el.levelSheet.classList.remove("show");
  el.calibSheet.classList.remove("show");
  updateSensorStatus();
}

function openCalib() {
  el.calibSheet.classList.add("show");
  el.levelSheet.classList.remove("show");
  el.helpSheet.classList.remove("show");
  el.calibHint.textContent = "";
  el.calibHint.classList.remove("warn");
}

// ---------- 传感器（§3.2–§3.7） ----------
function setNotice(text, ms = 0) {
  el.notice.textContent = text || "";
  el.notice.classList.toggle("show", !!text);
  if (app.noticeTimer) clearTimeout(app.noticeTimer);
  if (text && ms) app.noticeTimer = setTimeout(() => setNotice(""), ms);
}

function setMode(mode, auto = false) {
  app.mode = mode;
  app.autoFallback = auto;
  el.btnMode.textContent = mode === "tilt" ? "改用方向键" : "改用倾斜";
  updateSensorStatus();
}

const SENSOR_TEXT = {
  idle: "重力：初始化中",
  waiting: "重力：等待数据",
  live: "重力：已连接",
  "no-data": "重力：无数据",
  failed: "重力：数据异常",
  unsupported: "重力：此设备不支持",
  insecure: "重力：需要 HTTPS",
  denied: "重力：权限未开启",
  hidden: "重力：后台暂停",
};

function updateSensorStatus() {
  if (!el.sensorStatus) return;
  const info = app.sensor ? app.sensor.info() : null;
  const st = info ? SENSOR_TEXT[info.state] || info.state : "重力：未初始化";
  const base = info && info.baseline ? `零偏 ${info.baseline.b.toFixed(1)}°/${info.baseline.g.toFixed(1)}°` : "未校准";
  el.sensorStatus.textContent = `${st} · ${base} · 当前${app.mode === "tilt" ? "倾斜" : "方向键"}模式`;
  el.btnMode.disabled = !info || !info.supported;
  el.btnCalib.disabled = !info || !info.supported;
}

function onSensorState(state) {
  updateSensorStatus();
  switch (state) {
    case "live":
      el.btnRetry.hidden = true;
      if (app.autoFallback) {
        setMode("tilt", false);
        setNotice("");
      }
      if (app.sensor && !app.sensor.baseline) {
        setNotice("第一次用重力：把手机平放，点「校准」", 0);
        openCalib();
      }
      break;
    case "no-data":
    case "unsupported":
    case "insecure":
      setMode("buttons", true);
      setNotice("未检测到重力传感器，已切换到方向键");
      break;
    case "failed":
      setMode("buttons", true);
      setNotice("重力数据异常，已切换到方向键");
      break;
    case "denied":
      setMode("buttons", true);
      setNotice("重力权限未开启，已切换到方向键，可在「?」里重试");
      el.btnRetry.hidden = false;
      break;
    case "hidden":
      break;
    default:
      break;
  }
}

async function doCalibration() {
  if (!app.sensor) return;
  el.btnDoCalib.disabled = true;
  el.calibHint.textContent = "保持平放，正在采样…";
  el.calibHint.classList.remove("warn");
  const r = await app.sensor.calibrate();
  el.btnDoCalib.disabled = false;
  if (r.ok) {
    el.calibHint.textContent = `校准完成：${r.samples} 帧，零偏 ${r.b.toFixed(1)}° / ${r.g.toFixed(1)}°`;
    setMode("tilt", false);
    setNotice("校准完成，倾斜手机开始", 2600);
    updateSensorStatus();
    setTimeout(() => hideSheets(), 650);
  } else {
    el.calibHint.textContent = r.warning || "校准失败，请重试";
    el.calibHint.classList.add("warn");
  }
}

async function initSensor() {
  if (!window.isSecureContext) {
    onSensorState("insecure");
    return;
  }
  const s = new SensorInput({
    onTilt: (dir) => {
      if (app.mode === "tilt") tryMove(dir);
    },
    onState: onSensorState,
  });
  app.sensor = s;
  updateSensorStatus();
  if (!s.supported) {
    onSensorState("unsupported");
    return;
  }
  const perm = await s.requestPermission();
  if (perm !== "granted") {
    onSensorState("denied");
    return;
  }
  s.attach();
  updateSensorStatus();
}

/** §3.4：隐藏停监听 + 重置；恢复后静默丢弃 200ms 样本。 */
function handleVisibility(hidden) {
  if (hidden) {
    cancelAnimationFrame(rafId);
    app.drag = null;
    app.sensor?.setHidden(true);
  } else {
    app.sensor?.setHidden(false);
    rafId = requestAnimationFrame(loop);
  }
  updateSensorStatus();
}

// ---------- 启动 ----------
function boot() {
  Object.assign(el, {
    canvas: $("#board"), wrap: $("#boardWrap"), hint: $("#hint"),
    lvlId: $("#lvlId"), lvlName: $("#lvlName"), moves: $("#moves"), best: $("#best"),
    undo: $("#btnUndo"), restart: $("#btnRestart"), levels: $("#btnLevels"),
    levels2: $("#btnLevels2"), help: $("#btnHelp"), next: $("#btnNext"),
    banner: $("#banner"), bannerText: $("#bannerText"),
    levelSheet: $("#levelSheet"), helpSheet: $("#helpSheet"), levelGrid: $("#levelGrid"),
    pad: $("#pad"), notice: $("#notice"), calibSheet: $("#calibSheet"),
    calibHint: $("#calibHint"), btnDoCalib: $("#btnDoCalib"),
    sensorStatus: $("#sensorStatus"), btnCalib: $("#btnCalib"), btnMode: $("#btnMode"),
    btnRetry: $("#btnRetry"),
  });
  ctx = el.canvas.getContext("2d");

  el.levelBtns = [];
  for (const lv of LEVELS) {
    const b = document.createElement("button");
    b.className = "lvbtn";
    b.dataset.id = lv.id;
    b.innerHTML = `<b>${lv.id}</b><span>${lv.name}</span><i>${lv.minTilts} 步</i>`;
    b.addEventListener("click", () => loadLevel(LEVELS.findIndex((l) => l.id === lv.id)));
    el.levelGrid.appendChild(b);
    el.levelBtns.push(b);
  }

  el.pad.querySelectorAll("button[data-dir]").forEach((b) => {
    b.addEventListener("click", () => tryMove(b.dataset.dir));
  });
  el.undo.addEventListener("click", () => {
    if (app.anim || !app.state) return;
    if (undo(app.state)) {
      app.won = false;
      el.banner.classList.remove("show");
      updateHud();
    }
  });
  el.restart.addEventListener("click", () => {
    if (!app.state) return;
    restart(app.state);
    app.anim = null;
    app.drag = null;
    app.won = false;
    app.flash = null;
    el.banner.classList.remove("show");
    updateHud();
  });
  el.levels.addEventListener("click", openLevels);
  el.levels2.addEventListener("click", openLevels);
  el.help.addEventListener("click", openHelp);
  el.next.addEventListener("click", () => loadLevel(app.index + 1));
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", hideSheets));
  el.btnCalib.addEventListener("click", openCalib);
  el.btnDoCalib.addEventListener("click", doCalibration);
  el.btnMode.addEventListener("click", () => setMode(app.mode === "tilt" ? "buttons" : "tilt", false));
  el.btnRetry.addEventListener("click", () => {
    el.btnRetry.hidden = true;
    initSensor();
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    if (map[ev.key]) {
      ev.preventDefault();
      tryMove(map[ev.key]);
    } else if (ev.key === "z" || ev.key === "Z") {
      el.undo.click();
    } else if (ev.key === "r" || ev.key === "R") {
      el.restart.click();
    } else if (ev.key === "Enter" && app.won) {
      el.next.click();
    }
  });

  el.canvas.addEventListener("pointerdown", onPointerDown);
  el.canvas.addEventListener("pointermove", onPointerMove);
  el.canvas.addEventListener("pointerup", onPointerUp);
  el.canvas.addEventListener("pointercancel", onPointerUp);

  document.addEventListener("visibilitychange", () => handleVisibility(document.hidden));

  new ResizeObserver(() => resize()).observe(el.wrap);
  loadLevel(0);
  resize();
  rafId = requestAnimationFrame(loop);
  initSensor().catch(() => onSensorState("failed"));

  // 自动化测试钩子（无副作用，只读/驱动同一套入口）
  window.__game = {
    getState: () => ({
      levelId: app.state.id,
      moves: app.state.moves,
      boxes: app.state.boxes.map((b) => [...b]),
      blocker: [...app.state.blocker],
      won: app.won,
      animating: !!app.anim,
      canUndo: canUndo(app.state),
      history: app.state.history.length,
      cleared: { ...app.cleared },
      minTilts: app.state.minTilts,
    }),
    move: (dir) => tryMove(dir),
    dragTo: (x, y) => {
      if (app.anim || app.won) return false;
      const ok = dragBlocker(app.state, x, y);
      updateHud();
      return ok;
    },
    undo: () => {
      if (app.anim) return false;
      if (!undo(app.state)) return false;
      app.won = false;
      el.banner.classList.remove("show");
      updateHud();
      return true;
    },
    restart: () => {
      restart(app.state);
      app.anim = null;
      app.won = false;
      updateHud();
    },
    loadLevel: (index) => loadLevel(index),
    loadLevelById: (id) => loadLevel(LEVELS.findIndex((l) => l.id === id)),
    next: () => loadLevel(app.index + 1),
    isAnimating: () => !!app.anim,
    frames: () => app.frames || 0,
    sensorInfo: () => (app.sensor ? app.sensor.info() : null),
    sensorMode: () => app.mode,
    noticeText: () => el.notice.textContent,
    calibrate: () => doCalibration(),
    testVisibility: (hidden) => handleVisibility(!!hidden),
    resetCalibration: () => {
      clearCalibration();
      if (app.sensor) {
        app.sensor.baseline = null;
        app.sensor.trigger.reset();
      }
      updateSensorStatus();
    },
    triggerArmed: () => (app.sensor ? app.sensor.trigger.armed : null),
    screenPoint: (x, y) => {
      const r = el.canvas.getBoundingClientRect();
      return { x: r.left + cx(x), y: r.top + cy(y) };
    },
    geometry: () => ({
      cs: app.cs, cssW: app.cssW, cssH: app.cssH, dpr: app.dpr,
      wrapW: el.wrap.clientWidth, wrapH: el.wrap.clientHeight,
      rect: el.canvas.getBoundingClientRect().toJSON(),
    }),
    constants: { W, H, levels: LEVELS.length },
  };
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
