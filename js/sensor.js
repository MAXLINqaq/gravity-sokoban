// sensor.js — DeviceOrientation 倾斜输入（§3.2–§3.4、§3.7）
// 只做"把姿态变成一次倾斜指令"，结算仍然走 core.js 的同一个 applySettle 入口。
import { Trigger } from "./core.js";

export const CALIB_KEY = "lb.gravity.calib";
export const CALIB_FRAMES = 200;
export const CALIB_MAX_DEG = 17; // ≈0.3g，超过说明没平放

export function loadCalibration() {
  try {
    const raw = localStorage.getItem(CALIB_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (Number.isFinite(o.b) && Number.isFinite(o.g)) return { b: o.b, g: o.g };
  } catch { /* 隐私模式/坏数据都当作未校准 */ }
  return null;
}

export function saveCalibration(b, g) {
  try {
    localStorage.setItem(CALIB_KEY, JSON.stringify({ b, g, at: Date.now() }));
  } catch { /* 忽略 */ }
}

export function clearCalibration() {
  try { localStorage.removeItem(CALIB_KEY); } catch { /* 忽略 */ }
}

export class SensorInput {
  /**
   * @param {(dir:string)=>void} onTilt
   * @param {(state:string, detail?:object)=>void} onState
   */
  constructor({ onTilt, onState, now = () => performance.now(), schedule = (fn, ms) => setTimeout(fn, ms), cancel = (id) => clearTimeout(id) } = {}) {
    this.trigger = new Trigger();
    this.onTilt = onTilt || (() => {});
    this.onState = onState || (() => {});
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;

    this.baseline = loadCalibration();
    this.state = "idle";
    this.events = 0;
    this.eventsSinceAttach = 0;
    this.badStreak = 0;
    this.lastEventAt = 0;
    this.prev = null;
    this.listening = false;
    this.discardUntil = 0;
    this.calibrating = null;
    this.watchdog = null;
    this.watchId = 0;
    this.handler = (e) => this.handle(e);
  }

  get supported() {
    return typeof window !== "undefined" && "DeviceOrientationEvent" in window && !!window.DeviceOrientationEvent;
  }

  get hasPermissionApi() {
    return this.supported && typeof window.DeviceOrientationEvent.requestPermission === "function";
  }

  setState(s, detail) {
    if (this.state === s) return;
    this.state = s;
    this.onState(s, detail || {});
  }

  attach() {
    if (!this.supported) {
      this.setState("unsupported");
      return false;
    }
    if (!this.listening) {
      window.addEventListener("deviceorientation", this.handler, true);
      this.listening = true;
    }
    this.eventsSinceAttach = 0;
    this.armWatchdog();
    this.setState(this.baseline ? "live" : "waiting");
    return true;
  }

  detach() {
    if (this.listening) {
      window.removeEventListener("deviceorientation", this.handler, true);
      this.listening = false;
    }
    if (this.watchdog) {
      this.cancel(this.watchdog);
      this.watchdog = null;
    }
  }

  /** 3 秒内 0 个事件 → 判定传感器无数据（§3.7）。安卓 http 下就是这个表现。 */
  armWatchdog() {
    const token = ++this.watchId;
    if (this.watchdog) this.cancel(this.watchdog);
    this.watchdog = this.schedule(() => {
      if (token !== this.watchId) return;
      if (this.eventsSinceAttach === 0 && this.listening) this.setState("no-data");
    }, 3000);
  }

  handle(ev) {
    if (!this.listening) return;
    const now = this.now();
    if (now < this.discardUntil) return; // 回到前台先静默丢弃 200ms（§3.4）

    const b = ev.beta;
    const g = ev.gamma;
    const usable = Number.isFinite(b) && Number.isFinite(g);

    this.events++;
    if (!usable) {
      // 桌面/无传感器设备会发一条 beta=gamma=null 的“空事件”：
      // 它不算数据帧，不能喂饱 3 秒看门狗（§3.7），否则永远判不出无数据。
      const bad =
        (b !== null && b !== undefined && !Number.isFinite(b)) ||
        (g !== null && g !== undefined && !Number.isFinite(g));
      if (bad) this.countBad();
      return;
    }

    this.eventsSinceAttach++;
    this.lastEventAt = now;
    if (this.watchdog) {
      this.cancel(this.watchdog);
      this.watchdog = null;
    }
    if (this.state === "waiting" || this.state === "no-data") this.setState("live");

    // 校准采样：先于一切触发判定
    if (this.calibrating) {
      this.calibrating.samples.push([b, g]);
      if (this.calibrating.samples.length >= this.calibrating.frames) this.finishCalibration(true);
      return;
    }

    if (!this.baseline) return; // 未校准不触发

    // 单帧异常：跳变 > 90° → 丢弃，armed 不变（§3.7）
    const db = b - this.baseline.b;
    const dg = g - this.baseline.g;
    if (this.prev) {
      const jump = Math.hypot(db - this.prev.db, dg - this.prev.dg);
      if (jump > 90) {
        this.prev = { db, dg };
        this.countBad();
        return;
      }
    }
    this.prev = { db, dg };
    this.badStreak = 0;

    const dir = this.trigger.feed(db, dg, now);
    if (dir) this.onTilt(dir);
  }

  countBad() {
    this.badStreak++;
    if (this.badStreak >= 20) this.setState("failed");
  }

  /** 采 200 帧均值当零偏；平放异常（>17°）拒绝，不静默接受（§3.3）。 */
  calibrate({ frames = CALIB_FRAMES, timeoutMs = 1600 } = {}) {
    if (!this.supported) return Promise.resolve({ ok: false, warning: "此设备没有方向传感器" });
    return new Promise((resolve) => {
      const timer = this.schedule(() => this.finishCalibration(true), timeoutMs);
      this.calibrating = {
        samples: [],
        frames,
        timeoutMs,
        timer,
        resolve,
        startedAt: this.now(),
      };
      if (this.listening) this.armWatchdog();
    });
  }

  finishCalibration(commit) {
    const c = this.calibrating;
    if (!c) return;
    this.calibrating = null;
    this.cancel(c.timer);
    if (!commit) {
      c.resolve({ ok: false, warning: "校准已取消" });
      return;
    }
    if (c.samples.length === 0) {
      c.resolve({ ok: false, warning: "没有收到传感器数据，请确认手机支持并重试" });
      return;
    }
    let sb = 0;
    let sg = 0;
    for (const [b, g] of c.samples) { sb += b; sg += g; }
    const b = sb / c.samples.length;
    const g = sg / c.samples.length;
    if (Math.abs(b) > CALIB_MAX_DEG || Math.abs(g) > CALIB_MAX_DEG) {
      c.resolve({ ok: false, warning: "读数不像平放（超过 17°），请把手机放平再校准", b, g, samples: c.samples.length });
      return;
    }
    this.baseline = { b, g };
    saveCalibration(b, g);
    this.prev = null;
    this.trigger.reset();
    c.resolve({ ok: true, b, g, samples: c.samples.length });
  }

  /** §3.4：隐藏时停监听并重置；恢复后 200ms 内样本全部丢弃。 */
  setHidden(hidden) {
    if (hidden) {
      this.detach();
      this.trigger.reset();
      this.prev = null;
      if (this.calibrating) this.finishCalibration(false);
      this.setState("hidden");
    } else {
      this.attach();
      this.trigger.reset();
      this.prev = null;
      this.discardUntil = this.now() + 200;
    }
  }

  /** 首次授权（iOS 需要用户手势；安卓/桌面不需要）。 */
  async requestPermission() {
    if (!this.hasPermissionApi) return "granted";
    try {
      const r = await window.DeviceOrientationEvent.requestPermission();
      return r === "granted" ? "granted" : "denied";
    } catch {
      return "denied";
    }
  }

  info() {
    return {
      supported: this.supported,
      hasPermissionApi: this.hasPermissionApi,
      state: this.state,
      listening: this.listening,
      events: this.events,
      dataEvents: this.eventsSinceAttach,
      baseline: this.baseline ? { b: +this.baseline.b.toFixed(2), g: +this.baseline.g.toFixed(2) } : null,
      armed: this.trigger.armed,
      badStreak: this.badStreak,
      lastEventAt: this.lastEventAt,
    };
  }
}
