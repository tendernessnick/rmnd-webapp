// protocol.test.mjs —— 契约编码/解码/分帧的正反例覆盖
import {
  cmd, encodeLine, parseLine, LineAssembler, validateReminder,
  b64ByteLen, defaultMatcherFor, parseNdefUrl,
} from '../js/protocol.js';
import { packBitmap } from '../js/bmp.js';
import { assert, assertEq } from './harness.mjs';

const tests = [
  {
    name: 'encodeLine: hello 行逐字节精确',
    fn: () => assertEq(encodeLine(cmd.hello()), '{"cmd":"hello"}\n'),
  },
  {
    name: 'encodeLine: set 行含 i 与完整 r',
    fn: () => {
      const line = encodeLine(cmd.set(2, { on: true, hh: 8, mm: 0, days: '1111100', name: 'a' }));
      assert(line.startsWith('{"cmd":"set","i":2,"r":{'), line);
      assert(line.endsWith('\n'));
    },
  },
  {
    name: 'encodeLine: 超长行（>480B）拒绝发送',
    fn: () => {
      const long = { cmd: 'set', i: 0, r: { on: true, hh: 0, mm: 0, days: '1111111', name: 'x'.repeat(600) } };
      let threw = false;
      try { encodeLine(long); } catch { threw = true; }
      assert(threw, '超长应抛错');
    },
  },
  {
    name: 'parseLine: 合法 evt 行',
    fn: () => {
      const { evt, bad } = parseLine('{"evt":"ok"}');
      assert(!bad);
      assertEq(evt.evt, 'ok');
    },
  },
  { name: 'parseLine: 坏 JSON → badjson', fn: () => assertEq(parseLine('{oops').bad, 'badjson') },
  { name: 'parseLine: 空行 → empty', fn: () => assertEq(parseLine('   ').bad, 'empty') },
  { name: 'parseLine: 无 evt 字段 → noevt', fn: () => assertEq(parseLine('{"cmd":1}').bad, 'noevt') },
  { name: 'parseLine: JSON 数组 → notobject', fn: () => assertEq(parseLine('[1,2]').bad, 'notobject') },

  {
    name: 'LineAssembler: BLE 分块到达重组一行',
    fn: () => {
      const got = [];
      const asm = new LineAssembler({ onLine: (l) => got.push(l) });
      asm.push('{"evt":"o');
      asm.push('k"}\n{"evt":"er');
      asm.push('r"}\n');
      assertEq(got, ['{"evt":"ok"}', '{"evt":"err"}']);
    },
  },
  {
    name: 'LineAssembler: 一块多行、空行跳过、尾部残帧保留',
    fn: () => {
      const got = [];
      const asm = new LineAssembler({ onLine: (l) => got.push(l) });
      asm.push('a\n\nb\nc');
      assertEq(got, ['a', 'b']);
      asm.push('d\n');
      assertEq(got, ['a', 'b', 'cd']);
    },
  },
  {
    name: 'LineAssembler: 超长行触发 fault 且不影响后续行',
    fn: () => {
      const got = [];
      const faults = [];
      const asm = new LineAssembler({ onLine: (l) => got.push(l), onFault: (f) => faults.push(f) });
      asm.push('x'.repeat(600) + '\n{"evt":"ok"}\n');
      assertEq(faults, [{ kind: 'oversize', bytes: 600 }]);
      assertEq(got, ['{"evt":"ok"}']);
    },
  },
  {
    name: 'LineAssembler: 480B 恰好边界行放行（479 字符 + \\n）',
    fn: () => {
      let ok = false;
      const asm = new LineAssembler({ onLine: () => { ok = true; } });
      asm.push('y'.repeat(479) + '\n');
      assert(ok, '恰好 480B 应放行');
    },
  },
  {
    name: 'LineAssembler: 481B 行拒绝（fault=oversize）',
    fn: () => {
      const faults = [];
      const asm = new LineAssembler({ onFault: (f) => faults.push(f) });
      asm.push('y'.repeat(480) + '\n');
      assertEq(faults.length, 1);
      assertEq(faults[0].kind, 'oversize');
    },
  },
  {
    name: 'LineAssembler: reset 丢弃残帧（断连语义）',
    fn: () => {
      const got = [];
      const asm = new LineAssembler({ onLine: (l) => got.push(l) });
      asm.push('partial');
      asm.reset();
      asm.push('new\n');
      assertEq(got, ['new']);
    },
  },

  {
    name: 'validateReminder: 合法最小对象',
    fn: () => {
      const v = validateReminder({ on: true, hh: 0, mm: 0, days: '0000000', name: '' });
      assert(v.ok, v.why);
    },
  },
  {
    name: 'validateReminder: 含合规 8×16 位图（b64 长度匹配）',
    fn: () => {
      const bmp = packBitmap(new Array(8 * 16).fill(0), 8);
      const v = validateReminder({ on: false, hh: 23, mm: 59, days: '1111111', name: '阿莫西林', bmp });
      assert(v.ok, v.why);
    },
  },
  {
    name: 'validateReminder: hh=24 拒绝',
    fn: () => assertEq(validateReminder({ on: true, hh: 24, mm: 0, days: '1111111', name: '' }).ok, false),
  },
  {
    name: 'validateReminder: mm=-1 拒绝',
    fn: () => assertEq(validateReminder({ on: true, hh: 0, mm: -1, days: '1111111', name: '' }).ok, false),
  },
  {
    name: 'validateReminder: days 8 位拒绝',
    fn: () => assertEq(validateReminder({ on: true, hh: 0, mm: 0, days: '11111111', name: '' }).ok, false),
  },
  {
    name: 'validateReminder: days 含非 0/1 拒绝',
    fn: () => assertEq(validateReminder({ on: true, hh: 0, mm: 0, days: '11111 1', name: '' }).ok, false),
  },
  {
    name: 'validateReminder: name 15 字拒绝（上限 14）',
    fn: () => assertEq(validateReminder({ on: true, hh: 0, mm: 0, days: '1111111', name: '一二三四五六七八九十一二三四五' }).ok, false),
  },
  {
    name: 'validateReminder: bmp.w=113 拒绝（上限 112）',
    fn: () => assertEq(validateReminder({ on: true, hh: 0, mm: 0, days: '1111111', name: '', bmp: { w: 113, h: 16, b64: 'AAAAAAAAAAAAAAAAAAAAAA==' } }).ok, false),
  },
  {
    name: 'validateReminder: bmp.h≠16 拒绝',
    fn: () => assertEq(validateReminder({ on: true, hh: 0, mm: 0, days: '1111111', name: '', bmp: { w: 8, h: 15, b64: 'AAAA' } }).ok, false),
  },
  {
    name: 'validateReminder: b64 长度不符拒绝',
    fn: () => assertEq(validateReminder({ on: true, hh: 0, mm: 0, days: '1111111', name: '', bmp: { w: 8, h: 16, b64: 'AAAA' } }).ok, false),
  },

  {
    name: 'b64ByteLen: 基本口径',
    fn: () => {
      assertEq(b64ByteLen('AAAA'), 3);
      assertEq(b64ByteLen('AA=='), 1);
      assertEq(b64ByteLen('A'), NaN);
      assertEq(b64ByteLen('ABCDE'), NaN);
    },
  },
  {
    name: 'defaultMatcherFor: time 同时收 clock 与 ok（偏差提案 P-01）',
    fn: () => {
      const m = defaultMatcherFor({ cmd: 'time' });
      assert(m({ evt: 'clock' }));
      assert(m({ evt: 'ok' }));
      assert(m({ evt: 'err', why: 'range' }));
      assert(!m({ evt: 'fired' }));
    },
  },
  {
    name: 'defaultMatcherFor: fired 不算 set 回执',
    fn: () => assert(!defaultMatcherFor({ cmd: 'set' })({ evt: 'fired', i: 0, at: '08:00' })),
  },

  // ---- parseNdefUrl（NFC 写入读回核对，A2） ----
  {
    name: 'parseNdefUrl: url 记录（ArrayBuffer data）→ URI',
    fn: () => {
      const enc = new TextEncoder();
      const buf = enc.encode('https://x.example/r?b=SN01').buffer;
      assertEq(parseNdefUrl([{ recordType: 'url', data: buf }]), 'https://x.example/r?b=SN01');
    },
  },
  {
    name: 'parseNdefUrl: url 记录（Uint8Array data）→ URI',
    fn: () => {
      const bytes = new TextEncoder().encode('http://localhost:8000/?b=SN01');
      assertEq(parseNdefUrl([{ recordType: 'url', data: bytes }]), 'http://localhost:8000/?b=SN01');
    },
  },
  {
    name: 'parseNdefUrl: 多条记录取第一条 URI，跳过 text',
    fn: () => {
      const bytes = new TextEncoder().encode('https://a/?b=SN01');
      const recs = [
        { recordType: 'text', data: new TextEncoder().encode('hello') },
        { recordType: 'url', data: bytes },
        { recordType: 'url', data: new TextEncoder().encode('https://b/') },
      ];
      assertEq(parseNdefUrl(recs), 'https://a/?b=SN01');
    },
  },
  {
    name: 'parseNdefUrl: 无 url 记录 / 空数组 / 非数组 → null',
    fn: () => {
      assertEq(parseNdefUrl([{ recordType: 'text', data: new TextEncoder().encode('x') }]), null);
      assertEq(parseNdefUrl([]), null);
      assertEq(parseNdefUrl(undefined), null);
      assertEq(parseNdefUrl('nope'), null);
    },
  },
];

export const suite = { title: 'protocol（契约编解码/分帧/校验）', tests };
