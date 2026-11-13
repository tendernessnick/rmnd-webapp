// protocol.js —— 徽章↔手机 协议契约 v1（冻结）的纯函数实现。
// 语义来源：docs/protocol_v1.md。只实现，不改契约；发现的契约问题记 docs/notes_phone.md「协议偏差提案」。
// 本文件不含 DOM 依赖，可在 node 与浏览器双端运行。

export const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // 手机→设备（write）
export const NUS_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // 设备→手机（notify）
export const DEVICE_NAME_PREFIX = 'RMND-';

export const MAX_LINE_BYTES = 480;  // 契约 §1：单行最大 480 字节
export const CMD_TIMEOUT_MS = 3000; // 契约 §4.1：3s 超时
export const CMD_RETRIES = 3;       // 契约 §4.1：重发 3 次失败判链路故障
export const MAX_REMINDERS = 8;     // 契约 §2：0..7
export const MAX_NAME_CHARS = 14;   // 契约 §2
export const BMP_H = 16;            // 契约 §2：位图高度固定 16
export const BMP_MAX_W = 112;       // 契约 §2：位图宽度上限
export const MEDLOG_MAX = 64;       // 契约 §4.5：环形 64 条

const encoder = new TextEncoder();
const byteLen = (s) => encoder.encode(s).length;

// ---------------- cmd 构造器（手机 → 设备） ----------------

export const cmd = {
  hello: () => ({ cmd: 'hello' }),
  get: () => ({ cmd: 'get' }),
  set: (i, r) => ({ cmd: 'set', i, r }),
  del: (i) => ({ cmd: 'del', i }),
  time: (utc, tz) => ({ cmd: 'time', utc, tz }),
  log: () => ({ cmd: 'log' }),
  bell: () => ({ cmd: 'bell' }),
};

/** cmd 对象 → 一行文本（含结尾 \n）。超 480B 抛 Error（调用方须精简位图/截断名字后重试）。 */
export function encodeLine(obj) {
  const text = JSON.stringify(obj) + '\n';
  if (byteLen(text) > MAX_LINE_BYTES) {
    throw new Error(`消息超长（>${MAX_LINE_BYTES}B）：需精简位图或截断名字`);
  }
  return text;
}

// ---------------- evt 解析（设备 → 手机） ----------------

/** 一行 → { evt } 或 { bad: 原因 }。解析失败不抛异常，由上层决定处置。 */
export function parseLine(line) {
  const text = String(line).trim();
  if (!text) return { bad: 'empty' };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { bad: 'badjson' };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return { bad: 'notobject' };
  if (typeof obj.evt !== 'string') return { bad: 'noevt' };
  return { evt: obj };
}

// ---------------- 行分帧器：按 \n 切，容忍 BLE 分块到达 ----------------

export class LineAssembler {
  /**
   * @param onLine  收到一条完整行（不含 \n）
   * @param onFault 帧故障（oversize：单行超限；oversize-buffer：残帧积压超限）
   */
  constructor({ maxBytes = MAX_LINE_BYTES, onLine, onFault } = {}) {
    this.maxBytes = maxBytes;
    this.onLine = onLine ?? (() => {});
    this.onFault = onFault ?? (() => {});
    this._buf = '';
  }

  /** 喂入任意文本分块（UTF-8 已解码）；内部按 \n 重组出完整行 */
  push(chunk) {
    this._buf += chunk;
    for (;;) {
      const i = this._buf.indexOf('\n');
      if (i < 0) break;
      const line = this._buf.slice(0, i);
      this._buf = this._buf.slice(i + 1);
      if (byteLen(line + '\n') > this.maxBytes) {
        this.onFault({ kind: 'oversize', bytes: byteLen(line) });
        continue;
      }
      if (line.trim()) this.onLine(line);
    }
    // 残帧超限：帧头早已丢失、无法恢复对齐，丢弃等下一个 \n
    if (byteLen(this._buf) > this.maxBytes) {
      this.onFault({ kind: 'oversize-buffer', bytes: byteLen(this._buf) });
      this._buf = '';
    }
  }

  /** 断连时调用：不完整帧不可信，直接丢弃 */
  reset() {
    this._buf = '';
  }
}

// ---------------- 提醒对象校验（契约 §2 r 字段） ----------------

const isInt = (v) => Number.isInteger(v);

/** 校验单条提醒对象。返回 {ok:true} 或 {ok:false, why}（对应设备 err:range 的口径）。 */
export function validateReminder(r) {
  if (typeof r !== 'object' || r === null) return { ok: false, why: 'r 不是对象' };
  if (typeof r.on !== 'boolean') return { ok: false, why: 'on 须为 boolean' };
  if (!isInt(r.hh) || r.hh < 0 || r.hh > 23) return { ok: false, why: 'hh 越界（0..23）' };
  if (!isInt(r.mm) || r.mm < 0 || r.mm > 59) return { ok: false, why: 'mm 越界（0..59）' };
  if (typeof r.days !== 'string' || !/^[01]{7}$/.test(r.days)) {
    return { ok: false, why: 'days 须为 7 位 0/1 串（周一..周日）' };
  }
  if (typeof r.name !== 'string' || [...r.name].length > MAX_NAME_CHARS) {
    return { ok: false, why: `name 须为 ≤${MAX_NAME_CHARS} 字符的字符串` };
  }
  for (const key of ['bmp', 'bmp2']) {
    const b = r[key];
    if (b === undefined || b === null) continue;
    if (typeof b !== 'object') return { ok: false, why: `${key} 须为对象` };
    if (!isInt(b.w) || b.w < 1 || b.w > BMP_MAX_W) return { ok: false, why: `${key}.w 越界（1..${BMP_MAX_W}）` };
    if (b.h !== BMP_H) return { ok: false, why: `${key}.h 须为 ${BMP_H}` };
    if (typeof b.b64 !== 'string' || !b.b64.length) return { ok: false, why: `${key}.b64 缺失` };
    const expect = BMP_H * Math.ceil(b.w / 8); // 每行 ceil(w/8) 字节对齐 × 16 行
    if (b64ByteLen(b.b64) !== expect) return { ok: false, why: `${key}.b64 长度不符（应解出 ${expect}B）` };
  }
  return { ok: true };
}

/** base64 字符串解出的原始字节数（不解码，用于快速校验） */
export function b64ByteLen(s) {
  const n = s.length;
  if (n === 0 || n % 4 !== 0) return NaN;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return (n / 4) * 3 - pad;
}

// ---------------- 请求匹配器（哪类 evt 算哪条 cmd 的回执） ----------------

/**
 * 契约 §4.1：每条 cmd 必须有对应 evt:ok/err。
 * time 的回执口径在 §2（evt:ok）与 §3（evt:clock）之间二义 → 两者都收（偏差提案 P-01）。
 */
export function defaultMatcherFor(cmdObj) {
  switch (cmdObj?.cmd) {
    case 'hello': return (e) => e.evt === 'hello' || e.evt === 'err';
    case 'set':
    case 'del':
    case 'bell': return (e) => e.evt === 'ok' || e.evt === 'err';
    case 'time': return (e) => e.evt === 'clock' || e.evt === 'ok' || e.evt === 'err';
    case 'log': return (e) => e.evt === 'log' || e.evt === 'err';
    default: return (e) => e.evt !== 'fired'; // fired 是主动推送，不算回执
  }
}

/** cmd:get 的流式终结匹配器：err 或 reminders done */
export const GET_DONE_MATCHER = (e) => (e.evt === 'reminders' && e.done === true) || e.evt === 'err';
/** cmd:get 的流式条目匹配器 */
export const GET_ITEM_MATCHER = (e) => e.evt === 'reminders';

// ---------------- NFC 入口（契约 PHONE_APP_DEV §1/§3：NDEF URI = 入口 + 身份） ----------------

/**
 * 从 Web NFC 的 message.records 里解析第一条 URI 记录（纯函数，可注入假 records 测试）。
 * 返回 URI 字符串；无 URI 记录返回 null。用于写入后的读回核对。
 */
export function parseNdefUrl(records) {
  if (!Array.isArray(records)) return null;
  for (const rec of records) {
    if (rec?.recordType === 'url' && rec?.data != null) {
      try {
        return new TextDecoder().decode(rec.data);
      } catch {
        /* 该记录解码失败，继续找下一条 */
      }
    }
  }
  return null;
}
