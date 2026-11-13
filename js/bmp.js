// bmp.js —— 中文药名 → 1bpp 位图（契约 §2 渲染规范）+ 回显绘制。
// 纯函数（pack/unpack/分行/预算判定）node 可单测；canvas 渲染与回显仅在浏览器。
//
// 契约要点：16px 无衬线字体画到白底 → 逐像素阈值 128 → 1bpp 行优先、每行 ceil(w/8) 字节
// 对齐、每字节 MSB=最左像素、1=墨色 0=底色 → base64。w≤112，h 固定 16。
//
// 480B 行预算问题（偏差提案 P-03）：bmp+bmp2 双宽位图必超单行上限，
// renderNameBitmap 按预算自动降级：两行(≤112px) → 收窄两行(≤64px) → 单行截断。

import {
  BMP_H, BMP_MAX_W, MAX_NAME_CHARS, MAX_LINE_BYTES,
  encodeLine, cmd, b64ByteLen,
} from './protocol.js';

export const FONT_PX = 16;
export const DEFAULT_FONT = `${FONT_PX}px sans-serif`;
const LINE_MAX_W = BMP_MAX_W;

// ---------------- 纯函数：位图打包 / 解包 ----------------

/**
 * pixels（长度 w*h 的 0/1，行优先，1=墨色）→ {w, h, b64}。
 * 每行按 ceil(w/8) 字节对齐，MSB=该字节最左像素。
 */
export function packBitmap(pixels, w, h = BMP_H) {
  const rowBytes = Math.ceil(w / 8);
  const bytes = new Uint8Array(h * rowBytes);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (pixels[y * w + x]) bytes[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { w, h, b64: bytesToB64(bytes) };
}

/** {w,h,b64} → 0/1 像素数组（行优先）。用于回显与位序自检。 */
export function unpackBitmap(bmp) {
  const { w, h, b64 } = bmp;
  const bytes = b64ToBytes(b64);
  const rowBytes = Math.ceil(w / 8);
  const pixels = new Array(w * h).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const byte = bytes[y * rowBytes + (x >> 3)] ?? 0;
      pixels[y * w + x] = (byte >> (7 - (x & 7))) & 1;
    }
  }
  return pixels;
}

function bytesToB64(bytes) {
  let s = '';
  const CH = 0x8000; // 分段避免 Function.prototype.apply 参数上限
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

// ---------------- 纯函数：按像素宽分行 / 预算判定 ----------------

/**
 * 贪心按像素宽分行（全角字 16px、ASCII 窄字自动多放）。
 * @param measure 文本→像素宽的函数；默认浏览器 canvas（可注入以便 node 单测）
 * @returns { lines: string[], rest: string } rest 非空 ⇒ 放不下（须截断）
 */
export function splitNameByWidth(text, { font = DEFAULT_FONT, maxW = LINE_MAX_W, maxLines = 2, measure } = {}) {
  const m = measure ?? ((t) => domMeasure(t, font));
  const lines = [];
  let cur = '';
  let rest = '';
  let full = false;
  for (const ch of [...text]) {
    if (full) { rest += ch; continue; }
    const next = cur + ch;
    if (!cur || m(next) <= maxW) { cur = next; continue; }
    lines.push(cur);
    cur = ch;
    if (lines.length === maxLines) full = true;
  }
  if (full) rest = cur + rest;
  else if (cur) lines.push(cur);
  return { lines, rest };
}

/**
 * 预算判定：这条提醒以 set(i=0) 下发时能否装进一条 480B 行（契约 §1）。
 * 用最坏情形骨架（hh:23 mm:59）实测编码，不估算。node 可测。
 */
export function reminderFitsLine(name, bmp, bmp2) {
  const r = { on: true, hh: 23, mm: 59, days: '1111111', name };
  if (bmp) r.bmp = bmp;
  if (bmp2) r.bmp2 = bmp2;
  try {
    encodeLine(cmd.set(0, r));
    return true;
  } catch {
    return false;
  }
}

/** 位图完整性自检：b64 解出的字节数应等于 h*ceil(w/8) */
export function bitmapSizeOk(bmp) {
  return b64ByteLen(bmp.b64) === bmp.h * Math.ceil(bmp.w / 8);
}

// ---------------- 浏览器：文本 → 位图 ----------------

let _sharedCtx = null;
function domMeasure(text, font) {
  if (typeof document === 'undefined') throw new Error('splitNameByWidth 需要浏览器环境，或注入 measure 函数');
  if (!_sharedCtx) {
    const c = document.createElement('canvas');
    _sharedCtx = c.getContext('2d');
  }
  _sharedCtx.font = font;
  return _sharedCtx.measureText(text).width;
}

/** emoji/变体选择符/ZWJ 等：位图里剔除（name 字段保留原文） */
function stripUnrenderable(text) {
  return [...text]
    .filter((ch) => !/\p{Extended_Pictographic}|\uFE0F|\u200D|\u20E3/u.test(ch))
    .join('');
}

/** 一行文本 → 位图（白底黑字，阈值 128，垂直居中防裁顶） */
function rasterLine(text, font = DEFAULT_FONT) {
  const w = Math.max(1, Math.ceil(domMeasure(text, font)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = BMP_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, BMP_H);
  ctx.font = font;
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'alphabetic';
  // 用字形实际上下沿垂直居中；老浏览器无 actualBoundingBox 时退化为经验基线
  const m = ctx.measureText(text);
  const asc = m.actualBoundingBoxAscent ?? FONT_PX * 0.8;
  const desc = m.actualBoundingBoxDescent ?? FONT_PX * 0.2;
  const y = Math.round((BMP_H + asc - desc) / 2);
  ctx.fillText(text, 0, y);
  const img = ctx.getImageData(0, 0, w, BMP_H).data;
  const pixels = new Array(w * BMP_H);
  for (let i = 0; i < pixels.length; i++) {
    const lum = 0.299 * img[i * 4] + 0.587 * img[i * 4 + 1] + 0.114 * img[i * 4 + 2];
    pixels[i] = lum < 128 ? 1 : 0; // 契约：阈值 128
  }
  return packBitmap(pixels, w, BMP_H);
}

/** 截断渲染：尽量带省略号（…），放不下就硬截到 112px */
function rasterTruncated(name, font = DEFAULT_FONT) {
  const head = splitNameByWidth(name, { font, maxW: LINE_MAX_W - FONT_PX, maxLines: 1 }).lines[0] ?? '';
  if ([...head].length >= 2) return rasterLine(head + '…', font);
  const raw = splitNameByWidth(name, { font, maxW: LINE_MAX_W, maxLines: 1 }).lines[0] ?? '';
  return rasterLine(raw, font);
}

/**
 * 名字 → 位图组。返回 { name, bmp, bmp2, truncated }。
 * 空名 → bmp=null（工牌只显示时间不显示名字，契约 §2）。
 * 降级链：两行(≤112px,预算内) → 两行(≤64px,预算内) → 单行截断(6字+…)。
 */
export function renderNameBitmap(text, opts = {}) {
  if (typeof document === 'undefined') throw new Error('renderNameBitmap 需要浏览器环境（canvas）');
  const name0 = stripUnrenderable(String(text ?? '')).trim();
  const name = [...name0].slice(0, MAX_NAME_CHARS).join(''); // name 字段仍保留≤14字符口径
  if (!name) return { name: '', bmp: null, bmp2: null, truncated: false };

  const font = opts.font || DEFAULT_FONT;
  const build = (lines) => {
    const bmp = rasterLine(lines[0], font);
    const bmp2 = lines[1] ? rasterLine(lines[1], font) : null;
    return { bmp, bmp2 };
  };

  // ① 两行、每行最宽 112px
  const wide = splitNameByWidth(name, { font, maxW: LINE_MAX_W, maxLines: 2 });
  if (!wide.rest) {
    const b = build(wide.lines);
    if (reminderFitsLine(name, b.bmp, b.bmp2)) return { name, ...b, truncated: false };
  }
  // ② 两行、收窄到 64px（约 4 个全角字/行）
  const narrow = splitNameByWidth(name, { font, maxW: 64, maxLines: 2 });
  if (!narrow.rest) {
    const b = build(narrow.lines);
    if (reminderFitsLine(name, b.bmp, b.bmp2)) return { name, ...b, truncated: false };
  }
  // ③ 单行截断（480B 预算装不下双宽位图 —— 偏差提案 P-03）
  return { name, bmp: rasterTruncated(name, font), bmp2: null, truncated: true };
}

// ---------------- 浏览器：位图回显（所见即工牌所得） ----------------

/**
 * 把位图按 scale 倍画到 canvas。ink/bg 可配（默认工牌纸色底 + 墨色字）。
 */
export function drawBitmap(canvas, bmp, { scale = 1, ink = '#141414', bg = '#f4f0e5' } = {}) {
  if (!bmp) {
    canvas.width = 0;
    canvas.height = 0;
    return;
  }
  const pixels = unpackBitmap(bmp);
  canvas.width = bmp.w * scale;
  canvas.height = bmp.h * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = ink;
  for (let y = 0; y < bmp.h; y++) {
    for (let x = 0; x < bmp.w; x++) {
      if (pixels[y * bmp.w + x]) ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
}
