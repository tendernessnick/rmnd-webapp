// bmp.test.mjs —— 位图打包/解包/分行/480B 预算判定的纯函数验证（node 可跑，无 canvas）
import {
  packBitmap, unpackBitmap, splitNameByWidth, reminderFitsLine, bitmapSizeOk,
} from '../js/bmp.js';
import { b64ByteLen } from '../js/protocol.js';
import { assert, assertEq } from './harness.mjs';

/** 合成全零位图（预算测试用，无需 canvas） */
const zeroBmp = (w) => packBitmap(new Array(w * 16).fill(0), w, 16);

/** 伪字宽：全角/非 ASCII = 16px，ASCII = 8px（node 环境无 canvas，注入 measure） */
const fakeMeasure = (t) =>
  [...t].reduce((s, ch) => s + (ch.charCodeAt(0) > 127 ? 16 : 8), 0);
const split = (text, opts = {}) =>
  splitNameByWidth(text, { measure: fakeMeasure, ...opts });

const tests = [
  {
    name: 'packBitmap: MSB-first 位序（x=1 → 0x40）',
    fn: () => {
      const bmp = packBitmap([0, 1, 0, 0, 0, 0, 0, 0], 8, 1);
      // 0x40 → base64 "QA=="（64 → 010000|00… → 16,0 → 'Q','A'）
      assertEq(bmp.b64, 'QA==');
      const bytes = [...atob(bmp.b64)].map((c) => c.charCodeAt(0));
      assertEq(bytes, [0x40]);
      assertEq(unpackBitmap(bmp), [0, 1, 0, 0, 0, 0, 0, 0]);
    },
  },
  {
    name: 'packBitmap: 3×2 已知图案 → gCA=（0x80,0x20）',
    fn: () => {
      const bmp = packBitmap([1, 0, 0, 0, 0, 1], 3, 2);
      // 行1 的墨点在 x=2 → 0x80>>2 = 0x20（此前期望值 0x04 算错，roundtrip 用例已证位序正确）
      assertEq(bmp.b64, 'gCA=');
      const bytes = [...atob(bmp.b64)].map((c) => c.charCodeAt(0));
      assertEq(bytes, [0x80, 0x20]);
    },
  },
  {
    name: 'packBitmap: 行对齐 w=9 → 每行 2 字节，x=8 落在第 2 字节 0x80',
    fn: () => {
      const pixels = new Array(9).fill(0);
      pixels[8] = 1;
      const bmp = packBitmap(pixels, 9, 1);
      assertEq(b64ByteLen(bmp.b64), 2, '9px 一行应占 2 字节');
      const bytes = [...atob(bmp.b64)].map((c) => c.charCodeAt(0));
      assertEq(bytes, [0x00, 0x80]);
    },
  },
  {
    name: 'packBitmap: 112×16 全 1 → 224B 原始 → 300 字符 b64（契约上限位图）',
    fn: () => {
      const bmp = packBitmap(new Array(112 * 16).fill(1), 112, 16);
      assertEq(bmp.b64.length, 300);
      assert(bitmapSizeOk(bmp));
      const back = unpackBitmap(bmp);
      assertEq(back.length, 112 * 16);
      assert(back.every((p) => p === 1));
    },
  },
  {
    name: 'unpackBitmap: 交错图案 roundtrip（w=13）',
    fn: () => {
      const pixels = [];
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 13; x++) pixels.push((x + y) % 2);
      }
      const bmp = packBitmap(pixels, 13, 16);
      assert(bitmapSizeOk(bmp));
      assertEq(unpackBitmap(bmp), pixels);
    },
  },
  {
    name: 'splitNameByWidth: 9 个全角字、112px、2 行 → 7+2，无截断',
    fn: () => {
      const { lines, rest } = split('一二三四五六七八九');
      assertEq(lines, ['一二三四五六七', '八九']);
      assertEq(rest, '');
    },
  },
  {
    name: 'splitNameByWidth: 20 个 ASCII、112px、2 行 → 14+6',
    fn: () => {
      const { lines, rest } = split('Metformin500mgTabx');
      assertEq(lines, ['Metformin500mg', 'Tabx']);
      assertEq(rest, '');
    },
  },
  {
    name: 'splitNameByWidth: 15 个全角字、2 行放不下 → rest=1 字',
    fn: () => {
      const { lines, rest } = split('一二三四五六七八九十一二三四五');
      assertEq(lines.length, 2);
      assertEq(lines[0], '一二三四五六七');
      assertEq(rest, '五');
    },
  },
  {
    name: 'splitNameByWidth: maxLines=1 单行模式',
    fn: () => {
      const { lines, rest } = split('一二三四五六七八九', { maxLines: 1 });
      assertEq(lines, ['一二三四五六七']);
      assertEq(rest, '八九');
    },
  },
  {
    name: 'splitNameByWidth: 空串 → 无行',
    fn: () => {
      const { lines, rest } = split('');
      assertEq(lines, []);
      assertEq(rest, '');
    },
  },
  {
    name: 'reminderFitsLine: 单条 112×16 位图 + 14 全角名 → 480B 内放行',
    fn: () => {
      assert(reminderFitsLine('一二三四五六七八九十一二三四', zeroBmp(112), null),
        '单条宽位图应放行（契约口径 300-400B）');
    },
  },
  {
    name: 'reminderFitsLine: bmp+bmp2 双 112×16 + 14 全角名 → 超预算（偏差提案 P-03 实证）',
    fn: () => {
      assert(!reminderFitsLine('一二三四五六七八九十一二三四', zeroBmp(112), zeroBmp(112)),
        '双宽位图必超 480B');
    },
  },
  {
    name: 'reminderFitsLine: 双 64×16 + 8 全角名 → 仍超预算（name 字段挤占）',
    fn: () => {
      assert(!reminderFitsLine('一二三四五六七八', zeroBmp(64), zeroBmp(64)),
        '收窄双行 + 全角名也超预算');
    },
  },
  {
    name: 'reminderFitsLine: 双 48×16 + 短 ASCII 名 → 放行（bmp+bmp2 路径可达性实证）',
    fn: () => {
      // 实测：双 64×16(172b64×2)+骨架144+名 → ~493B 超 480；降到 48px（128b64×2）→ ~405B 放行
      assert(reminderFitsLine('D3 x2', zeroBmp(48), zeroBmp(48)),
        '48px 双行位图 + 短名可装下（bmp+bmp2 路径存在且可达）');
    },
  },
  {
    name: 'reminderFitsLine: 无位图必放行',
    fn: () => assert(reminderFitsLine('一二三四五六七八九十一二三四', null, null)),
  },
];

export const suite = { title: 'bmp（打包位序/分行/480B 预算）', tests };
