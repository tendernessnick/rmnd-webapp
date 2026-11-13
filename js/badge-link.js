// badge-link.js —— 链路抽象层。
// BadgeLink 基类：行收发 + 停等请求（契约 §4.1：3s 超时重发 ×3，busy 视为可重试）。
// SimulatedLink：内存模拟工牌（完整实现契约状态机，含 err 分支、fired 定时、可注入断连）。
// BleLink：真 Web Bluetooth（NUS，≤20B 分块写，notify 收行）。
// 除 BleLink 里的 navigator.bluetooth（运行时才触碰）外无 DOM 依赖，node 可单测。

import {
  NUS_SERVICE_UUID, NUS_RX_CHAR_UUID, NUS_TX_CHAR_UUID, DEVICE_NAME_PREFIX,
  MAX_LINE_BYTES, CMD_TIMEOUT_MS, CMD_RETRIES, MAX_REMINDERS, MEDLOG_MAX,
  encodeLine, parseLine, validateReminder, LineAssembler,
  defaultMatcherFor, GET_DONE_MATCHER, GET_ITEM_MATCHER,
} from './protocol.js';

export class LinkError extends Error {
  /** kind: timeout | disconnected | writefail | device:<why> | toolong | busy-local | connect | unsupported */
  constructor(kind, message, detail) {
    super(message);
    this.name = 'LinkError';
    this.kind = kind;
    this.detail = detail;
  }
}

const fmt2 = (n) => String(n).padStart(2, '0');

/**
 * 延迟调度：≤32ms 用 MessageChannel 宏任务（立即、且不受后台标签页定时器节流影响），
 * 更长延迟走 setTimeout（保留 SimulatedLink 的 busy 模拟语义）。
 * 背景：Chrome 对被遮挡窗口的 setTimeout 有秒级钳制，曾导致模拟连接握手在不可见窗口挂起。
 */
function schedule(fn, ms) {
  if (ms > 32 || typeof MessageChannel === 'undefined') {
    return setTimeout(fn, ms);
  }
  const ch = new MessageChannel();
  ch.port1.onmessage = () => {
    try { ch.port1.close(); } catch { /* 忽略 */ }
    fn();
  };
  ch.port2.postMessage(0);
}

const sleep = (ms) => new Promise((r) => schedule(r, ms));

/**
 * 断连重连退避策略（纯函数，node 可测）。
 * 前 fastMax 次指数退避（1s→2s→4s→8s→…封顶 10s），耗尽后转 slowMs 低频**持续**重试
 * ——契约 §4.2「一切断连当可重试事件」：不放弃，直到手动取消或连上。
 */
export function reconnectDelayMs(attempt, { fastMax = 8, fastCapMs = 10_000, slowMs = 30_000 } = {}) {
  if (attempt < fastMax) return Math.min(1000 * 2 ** attempt, fastCapMs);
  return slowMs;
}

// ============================================================
// BadgeLink 基类
// ============================================================

export class BadgeLink extends EventTarget {
  constructor() {
    super();
    this.mode = 'abstract';
    this.connected = false;
    this._pending = null;  // 停等请求：{match, resolve, reject}
    this._stream = null;   // 流式请求：{match, push, reject}
    this._queue = Promise.resolve(); // 本端请求串行化（停等协议不允许并发请求）
  }

  /* ---- 子类接口 ---- */
  async open() { throw new LinkError('unsupported', 'open() 未实现'); }
  async close() {}
  async _writeLine(_text) { throw new LinkError('unsupported', '_writeLine() 未实现'); }

  /* ---- 事件 ---- */
  _emitStatus(state, detail) {
    const was = this.connected;
    this.connected = state === 'connected';
    if (was && !this.connected) this._failPending(new LinkError('disconnected', '连接已断开'));
    this.dispatchEvent(new CustomEvent('status', { detail: { state, detail } }));
  }

  /** 子类收到一行设备消息时调用（已按 \n 重组） */
  _onLine(text) {
    const { evt, bad } = parseLine(text);
    if (bad) {
      this.dispatchEvent(new CustomEvent('fault', { detail: { kind: bad, text } }));
      return;
    }
    const p = this._pending;
    if (p && p.match(evt)) {
      this._pending = null;
      p.resolve(evt);
      return;
    }
    const s = this._stream;
    if (s && s.match(evt)) {
      s.push(evt);
      return;
    }
    // 不属于当前请求的回执（含 fired 主动推送、迟到回执）→ 交给监听者
    this.dispatchEvent(new CustomEvent('evt', { detail: evt }));
  }

  _failPending(err) {
    if (this._pending) { const p = this._pending; this._pending = null; p.reject(err); }
    if (this._stream) { const s = this._stream; this._stream = null; s.reject(err); }
  }

  /** 所有 request/requestStream 串行排队，避免停等互踩 */
  enqueue(fn) {
    const run = this._queue.then(fn, fn); // 前一个失败也继续下一个
    this._queue = run.then(() => {}, () => {});
    return run;
  }

  /** 停等请求（契约 §4.1）。resolve 匹配回执；err:busy 与超时计入重试，其余直接抛 LinkError。 */
  request(cmdObj, opts = {}) {
    return this.enqueue(() => this._requestOnce(cmdObj, opts));
  }

  async _requestOnce(cmdObj, opts = {}) {
    const { match = defaultMatcherFor(cmdObj), timeoutMs = CMD_TIMEOUT_MS, retries = CMD_RETRIES } = opts;
    let line;
    try {
      line = encodeLine(cmdObj);
    } catch (e) {
      throw new LinkError('toolong', e.message);
    }
    let last = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      if (!this.connected) throw new LinkError('disconnected', '链路未连接');
      try {
        const evt = await this._exchange(line, match, timeoutMs);
        if (evt.evt === 'err') throw new LinkError('device:' + (evt.why ?? '?'), `设备回执 err:${evt.why ?? '?'}`, evt);
        if (evt.evt === 'clock' && evt.ok === false) throw new LinkError('device:clock', '设备校时失败（clock.ok=false）', evt);
        return evt;
      } catch (e) {
        if (e instanceof LinkError && (e.kind === 'timeout' || e.kind === 'device:busy')) {
          last = e;
          continue; // 契约 §4.1：超时重发；busy 可重试，计入重发次数
        }
        throw e;
      }
    }
    throw last ?? new LinkError('timeout', `${retries} 次无回执，判链路故障`);
  }

  _exchange(line, match, timeoutMs) {
    return new Promise((resolve, reject) => {
      let p;
      const timer = setTimeout(() => {
        if (this._pending === p) this._pending = null;
        reject(new LinkError('timeout', `${timeoutMs}ms 内无回执`));
      }, timeoutMs);
      p = {
        match,
        resolve: (evt) => { clearTimeout(timer); resolve(evt); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this._pending = p;
      this._writeLine(line).catch((e) => {
        if (this._pending === p) {
          this._pending = null;
          reject(new LinkError('writefail', String(e?.message || e)));
        }
      });
    });
  }

  /**
   * 流式请求：cmd 发出后收集 itemMatch 的条目，直到 match 的终结回执。
   * 每收到一条流内事件就重置超时（链路仍活着的证据）；整体失败按契约重发整条 cmd。
   * 返回 { items, done }。
   */
  requestStream(cmdObj, opts = {}) {
    return this.enqueue(() => this._streamOnce(cmdObj, opts));
  }

  async _streamOnce(cmdObj, opts = {}) {
    const {
      match = GET_DONE_MATCHER,
      itemMatch = GET_ITEM_MATCHER,
      timeoutMs = CMD_TIMEOUT_MS,
      retries = CMD_RETRIES,
    } = opts;
    let line;
    try {
      line = encodeLine(cmdObj);
    } catch (e) {
      throw new LinkError('toolong', e.message);
    }
    let last = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      if (!this.connected) throw new LinkError('disconnected', '链路未连接');
      const items = [];
      try {
        const doneEvt = await this._exchangeStream(line, match, itemMatch, items, timeoutMs);
        if (doneEvt.evt === 'err') throw new LinkError('device:' + (doneEvt.why ?? '?'), `设备回执 err:${doneEvt.why}`, doneEvt);
        return { items, done: doneEvt };
      } catch (e) {
        if (e instanceof LinkError && (e.kind === 'timeout' || e.kind === 'device:busy')) {
          last = e;
          continue;
        }
        throw e;
      }
    }
    throw last ?? new LinkError('timeout', `${retries} 次无回执，判链路故障`);
  }

  _exchangeStream(line, match, itemMatch, items, timeoutMs) {
    return new Promise((resolve, reject) => {
      let s;
      const arm = () => setTimeout(() => {
        if (this._stream === s) this._stream = null;
        reject(new LinkError('timeout', '流式回执中断（超时）'));
      }, timeoutMs);
      let timer = arm();
      s = {
        match: itemMatch,
        push: (evt) => {
          clearTimeout(timer);
          if (match(evt)) { // 终结回执（done 或 err）
            if (this._stream === s) this._stream = null;
            resolve(evt);
          } else {
            items.push(evt);
            timer = arm();
          }
        },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this._stream = s;
      this._writeLine(line).catch((e) => {
        if (this._stream === s) {
          this._stream = null;
          reject(new LinkError('writefail', String(e?.message || e)));
        }
      });
    });
  }
}

// ============================================================
// SimulatedLink —— 内存模拟工牌（契约的完整设备侧状态机）
// ============================================================

export class SimulatedLink extends BadgeLink {
  /**
   * @param opts.deviceName   广播名（默认 RMND-SIM1）
   * @param opts.fw / battery
   * @param opts.audioOn      设备音频开关（静音红线：默认 false ⇒ bell 回 err:audiooff）
   * @param opts.clockSkewMs  设备时钟偏差（演示校时用）
   * @param opts.procDelayMs  模拟设备处理延迟（>0 时快速连发可触发 err:busy）
   * @param opts.seed         初始提醒数组（依序放槽 0..7）
   * @param opts.seedLog      初始服药记录
   */
  constructor(opts = {}) {
    super();
    this.mode = 'simulated';
    this.deviceName = opts.deviceName ?? 'RMND-SIM1';
    this.fw = opts.fw ?? '0.1.1-sim';
    this.bat = opts.battery ?? 87;
    this.audioOn = opts.audioOn ?? false;
    this.tz = 480;
    this._clockSkewMs = opts.clockSkewMs ?? 0;
    this._procDelayMs = opts.procDelayMs ?? 25;
    this._muteDispatch = false; // 测试钩子：让设备“装死”以验证超时重发路径
    this._forcedErr = null;     // 测试钩子：forceErr('full') 等
    this.slots = new Array(MAX_REMINDERS).fill(null);
    this.medlog = [];
    this._busy = false;
    this._ticker = null;
    this._firedMemo = new Set(); // 契约 §4.6：当日防重复触发
    this._snoozes = [];          // {utc, i, at} 一次性触发
    (opts.seed ?? []).slice(0, MAX_REMINDERS).forEach((r, i) => {
      this.slots[i] = structuredClone(r);
    });
    (opts.seedLog ?? []).forEach((row) => this.pushLog(row));
  }

  async open() {
    await sleep(40);
    this._emitStatus('connected', this.deviceName);
    this._startTicker();
    return this;
  }

  async close() {
    this._stopTicker();
    this._emitStatus('disconnected', 'local');
  }

  async _writeLine(text) {
    if (!this.connected) throw new LinkError('disconnected', '模拟设备未连接');
    schedule(() => this._deviceReceive(text), this._procDelayMs);
  }

  /* ---------- 注入钩子（测试 / 演示用） ---------- */

  /** 注入断连（模拟设备重启/走远）。断开后可再次 open() 重连。 */
  dropConnection() {
    this._stopTicker();
    this._emitStatus('disconnected', 'injected');
  }

  /** 立即触发第 i 条的 fired 事件（跳过真实等钟） */
  forceFire(i) {
    const r = this.slots[i];
    const at = r ? `${fmt2(r.hh)}:${fmt2(r.mm)}` : '--:--';
    this._deviceSend({ evt: 'fired', i, at });
  }

  /** 预置设备时钟偏差（秒，正=设备快） */
  setClockSkewSeconds(sec) { this._clockSkewMs = sec * 1000; }

  /** 强制下一次设备回执为 err:<why>（测手机端回执分支，如 full） */
  forceErr(why) { this._forcedErr = why; }

  pushLog(row) {
    this.medlog.push(row);
    if (this.medlog.length > MEDLOG_MAX) this.medlog.shift();
  }

  deviceUtc() { return Math.floor((Date.now() + this._clockSkewMs) / 1000); }

  /* ---------- 设备侧行为（契约 §2/§3 的工牌语义） ---------- */

  _deviceReceive(text) {
    if (!this.connected) return; // 断连窗口内到达的字节视为丢失
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return this._deviceSend({ evt: 'err', why: 'badjson' });
    }
    if (typeof obj !== 'object' || obj === null || typeof obj.cmd !== 'string') {
      return this._deviceSend({ evt: 'err', why: 'badjson' });
    }
    if (this._busy) return this._deviceSend({ evt: 'err', why: 'busy' });
    this._busy = true;
    schedule(() => {
      this._busy = false;
      try {
        this._deviceDispatch(obj);
      } catch {
        this._deviceSend({ evt: 'err', why: 'range' });
      }
    }, this._procDelayMs);
  }

  _deviceSend(obj) {
    this._onLine(JSON.stringify(obj) + '\n');
  }

  _deviceDispatch(o) {
    if (this._forcedErr) {
      const why = this._forcedErr;
      this._forcedErr = null;
      return this._deviceSend({ evt: 'err', why });
    }
    if (this._muteDispatch) return; // 装死：验证手机端超时重发
    switch (o.cmd) {
      case 'hello':
        return this._deviceSend({
          evt: 'hello', fw: this.fw, bat: this.bat,
          utc: this.deviceUtc(), tz: this.tz, n: this._usedCount(),
        });
      case 'get':
        this.slots.forEach((r, i) => {
          if (r) this._deviceSend({ evt: 'reminders', i, r: structuredClone(r) });
        });
        return this._deviceSend({ evt: 'reminders', done: true });
      case 'set': {
        const i = o.i;
        if (!Number.isInteger(i) || i < 0 || i >= MAX_REMINDERS) return this._deviceSend({ evt: 'err', why: 'range' });
        const v = validateReminder(o.r);
        if (!v.ok) return this._deviceSend({ evt: 'err', why: 'range' });
        this.slots[i] = structuredClone(o.r);
        return this._deviceSend({ evt: 'ok' });
      }
      case 'del': {
        const i = o.i;
        if (!Number.isInteger(i) || i < 0 || i >= MAX_REMINDERS) return this._deviceSend({ evt: 'err', why: 'range' });
        this.slots[i] = null;
        return this._deviceSend({ evt: 'ok' });
      }
      case 'time': {
        const { utc, tz } = o;
        if (!Number.isInteger(utc) || utc <= 0 || !Number.isInteger(tz) || Math.abs(tz) > 840) {
          return this._deviceSend({ evt: 'err', why: 'range' });
        }
        this.tz = tz;
        this._clockSkewMs = 0; // 对时后设备时钟与手机对齐
        this._snoozes = [];
        return this._deviceSend({ evt: 'clock', ok: true }); // 契约 §3 口径（§2 写 evt:ok —— 偏差提案 P-01）
      }
      case 'log':
        return this._deviceSend({ evt: 'log', rows: structuredClone(this.medlog) });
      case 'bell':
        // 🔇 静音红线：模拟设备绝不发声，只回回执。音频未启用 ⇒ err:audiooff（契约 §2 bell）。
        return this.audioOn ? this._deviceSend({ evt: 'ok' }) : this._deviceSend({ evt: 'err', why: 'audiooff' });
      default:
        // 契约 err 枚举未定义未知 cmd 口径 → 按 badjson 回（偏差提案 P-02）
        return this._deviceSend({ evt: 'err', why: 'badjson' });
    }
  }

  /* ---------- 每秒闹钟判定（契约 §4.6） ---------- */

  _startTicker() {
    this._stopTicker();
    this._ticker = setInterval(() => this._tick(), 1000);
  }

  _stopTicker() {
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
  }

  _tick() {
    if (!this.connected) return;
    const d = new Date(Date.now() + this._clockSkewMs);
    const weekday = (d.getDay() + 6) % 7; // 契约 days：周一=0 .. 周日=6
    const at = `${fmt2(d.getHours())}:${fmt2(d.getMinutes())}`;
    const nowUtc = Math.floor(d.getTime() / 1000);
    // snooze 一次性触发（+5min 由生成方写入 utc/at）
    this._snoozes = this._snoozes.filter((s) => {
      if (s.utc <= nowUtc) {
        this._deviceSend({ evt: 'fired', i: s.i, at: s.at });
        return false;
      }
      return true;
    });
    this.slots.forEach((r, i) => {
      if (!r || !r.on) return;
      if (r.days[weekday] !== '1') return;
      if (`${fmt2(r.hh)}:${fmt2(r.mm)}` !== at) return;
      const key = `${i}|${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}|${at}`;
      if (this._firedMemo.has(key)) return;
      this._firedMemo.add(key);
      this._deviceSend({ evt: 'fired', i, at });
    });
  }

  _usedCount() { return this.slots.filter(Boolean).length; }
}

// ============================================================
// BleLink —— 真 Web Bluetooth（NUS）
// ============================================================

export class BleLink extends BadgeLink {
  constructor() {
    super();
    this.mode = 'ble';
    this.device = null;   // BluetoothDevice（保留引用以支持静默重连）
    this._gatt = null;
    this._rx = null;      // 写特征（手机→设备）
    this._tx = null;      // 通知特征（设备→手机）
    this._assembler = null;
    this._decoder = new TextDecoder('utf-8');
    this._wantClose = false;
  }

  static available() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  /**
   * 建立连接。
   * 首连：必须在用户手势里调用（Chrome 会弹设备选择框）。
   * 静默重连：open({reuse:true}) 复用已授权设备，无需手势。
   */
  async open({ reuse = false } = {}) {
    if (!BleLink.available()) {
      throw new LinkError('unsupported', '此浏览器不支持 Web Bluetooth（需 Chrome/Edge + localhost/HTTPS）');
    }
    this._wantClose = false;
    if (!reuse || !this.device) {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: DEVICE_NAME_PREFIX }],
        optionalServices: [NUS_SERVICE_UUID],
      });
    }
    this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
    this.device.addEventListener('gattserverdisconnected', this._onGattDisconnected);
    this._emitStatus('connecting', this.device.name ?? 'RMND-????');
    try {
      const gatt = await this.device.gatt.connect();
      const svc = await gatt.getPrimaryService(NUS_SERVICE_UUID);
      this._rx = await svc.getCharacteristic(NUS_RX_CHAR_UUID);
      this._tx = await svc.getCharacteristic(NUS_TX_CHAR_UUID);
      await this._tx.startNotifications();
      this._tx.addEventListener('characteristicvaluechanged', this._onNotify);
      this._gatt = gatt;
      this._assembler = new LineAssembler({
        onLine: (l) => this._onLine(l),
        onFault: (f) => this.dispatchEvent(new CustomEvent('fault', { detail: f })),
      });
    } catch (e) {
      this._emitStatus('disconnected', 'connect-failed');
      throw new LinkError('connect', this._friendly(e), { cause: String(e?.message || e) });
    }
    this._emitStatus('connected', this.device.name ?? 'RMND-????');
    return this;
  }

  _onNotify = (e) => {
    // TextDecoder stream:true 处理 UTF-8 多字节字符跨 chunk 的情况
    const text = this._decoder.decode(e.target.value, { stream: true });
    this._assembler?.push(text);
  };

  _onGattDisconnected = () => {
    this._assembler?.reset();
    this._decoder = new TextDecoder('utf-8'); // 丢弃跨断连的多字节残片
    if (this._tx) {
      try { this._tx.removeEventListener('characteristicvaluechanged', this._onNotify); } catch { /* 已断开 */ }
    }
    this._tx = null;
    this._rx = null;
    this._gatt = null;
    if (!this._wantClose) this._emitStatus('disconnected', 'gatt');
    // 不在此处自动重连：由 app 层统一退避重试（SimulatedLink 注入断连走同一条路）
  };

  async _writeLine(line) {
    if (!this._gatt?.connected) throw new LinkError('disconnected', 'GATT 未连接');
    const bytes = new TextEncoder().encode(line);
    const CHUNK = 20; // 默认 MTU 23 ⇒ 20B 载荷；契约 §1：设备不依赖 write 边界
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const chunk = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
      if (typeof this._rx.writeValueWithoutResponse === 'function') {
        await this._rx.writeValueWithoutResponse(chunk);
      } else {
        await this._rx.writeValue(chunk);
      }
    }
  }

  async close() {
    this._wantClose = true;
    try { this.device?.gatt?.disconnect(); } catch { /* 忽略 */ }
    this._emitStatus('disconnected', 'local');
  }

  _friendly(e) {
    const msg = String(e?.message || e);
    if (/User cancelled|选择/i.test(msg)) return '已取消选择设备';
    if (/No Devices|no devices/i.test(msg)) return '没找到 RMND- 开头的设备（工牌未广播？PC 蓝牙没开？）';
    return msg;
  }
}
