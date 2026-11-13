// simlink.test.mjs —— SimulatedLink 全量回归：契约全部 cmd/evt 往返 + err 分支 + 断连/重连 + fired
import { SimulatedLink, LinkError, reconnectDelayMs } from '../js/badge-link.js';
import { cmd } from '../js/protocol.js';
import { assert, assertEq, waitFor } from './harness.mjs';

const VALID_R = { on: true, hh: 8, mm: 0, days: '1111100', name: '阿莫西林' };

async function makeLink(opts = {}) {
  const link = new SimulatedLink({ procDelayMs: 5, ...opts });
  await link.open();
  return link;
}

/** 收集一条主动推送的 evt（fired / err 等非请求回执） */
function nextEvt(link) {
  return new Promise((resolve) => {
    const h = (e) => {
      link.removeEventListener('evt', h);
      resolve(e.detail);
    };
    link.addEventListener('evt', h);
  });
}

const tests = [
  {
    name: 'open/close 发出状态事件',
    fn: async () => {
      const link = new SimulatedLink({ procDelayMs: 1 });
      const states = [];
      link.addEventListener('status', (e) => states.push(e.detail.state));
      await link.open();
      await link.close();
      assertEq(states, ['connected', 'disconnected']);
      assertEq(link.connected, false);
    },
  },
  {
    name: 'hello：fw/bat/utc/tz/n 全字段',
    fn: async () => {
      const link = await makeLink();
      const e = await link.request(cmd.hello());
      assertEq(e.evt, 'hello');
      assert(typeof e.fw === 'string' && e.fw.length > 0);
      assert(e.bat >= 0 && e.bat <= 100);
      assert(e.utc > 1_700_000_000, 'utc 应为当前 epoch 秒');
      assertEq(e.tz, 480);
      assertEq(e.n, 0);
      await link.close();
    },
  },
  {
    name: 'get 空表：0 条 + done',
    fn: async () => {
      const link = await makeLink();
      const { items, done } = await link.requestStream(cmd.get());
      assertEq(items, []);
      assertEq(done.evt, 'reminders');
      assertEq(done.done, true);
      await link.close();
    },
  },
  {
    name: 'set → ok → get 逐条回 → hello n=1（整条覆盖语义）',
    fn: async () => {
      const link = await makeLink();
      const ok = await link.request(cmd.set(0, VALID_R));
      assertEq(ok.evt, 'ok');
      let { items } = await link.requestStream(cmd.get());
      assertEq(items.length, 1);
      assertEq(items[0].i, 0);
      assertEq(items[0].r.name, '阿莫西林');
      // 整条覆盖：改时间后 get 应只见新值
      await link.request(cmd.set(0, { ...VALID_R, hh: 9 }));
      ({ items } = await link.requestStream(cmd.get()));
      assertEq(items[0].r.hh, 9);
      assertEq(items[0].r.mm, 0);
      const hello = await link.request(cmd.hello());
      assertEq(hello.n, 1);
      await link.close();
    },
  },
  {
    name: 'set 槽位 2/5 分散存储，get 按槽位回',
    fn: async () => {
      const link = await makeLink();
      await link.request(cmd.set(2, { ...VALID_R, name: 'a' }));
      await link.request(cmd.set(5, { ...VALID_R, name: 'b' }));
      const { items } = await link.requestStream(cmd.get());
      assertEq(items.map((x) => x.i), [2, 5]);
      const hello = await link.request(cmd.hello());
      assertEq(hello.n, 2);
      await link.close();
    },
  },
  {
    name: 'set 索引越界（8）→ device:range',
    fn: async () => {
      const link = await makeLink();
      await assertRejectKind(() => link.request(cmd.set(8, VALID_R)), 'device:range');
      await link.close();
    },
  },
  {
    name: 'set 非法 r（days 8 位）→ device:range',
    fn: async () => {
      const link = await makeLink();
      await assertRejectKind(() => link.request(cmd.set(0, { ...VALID_R, days: '11111111' })), 'device:range');
      await link.close();
    },
  },
  {
    name: 'del → ok；删空槽幂等 ok；del(9) → range',
    fn: async () => {
      const link = await makeLink();
      await link.request(cmd.set(0, VALID_R));
      const ok = await link.request(cmd.del(0));
      assertEq(ok.evt, 'ok');
      const { items } = await link.requestStream(cmd.get());
      assertEq(items, []);
      const ok2 = await link.request(cmd.del(3)); // 空槽删除幂等
      assertEq(ok2.evt, 'ok');
      await assertRejectKind(() => link.request(cmd.del(9)), 'device:range');
      await link.close();
    },
  },
  {
    name: 'time → clock ok:true；校时后设备 utc 与手机对齐（偏差提案 P-01 口径）',
    fn: async () => {
      const link = await makeLink({ clockSkewMs: -60_000 });
      const before = await link.request(cmd.hello());
      assert(Math.abs(before.utc * 1000 + 60_000 - Date.now()) < 5000, '注入 -60s 偏差应生效');
      const e = await link.request(cmd.time(Math.floor(Date.now() / 1000), 480));
      assertEq(e.evt, 'clock');
      assertEq(e.ok, true);
      const after = await link.request(cmd.hello());
      assert(Math.abs(after.utc * 1000 - Date.now()) < 3000, '校时后偏差应清零');
      await link.close();
    },
  },
  {
    name: 'time 非法参数（utc=0）→ device:range',
    fn: async () => {
      const link = await makeLink();
      await assertRejectKind(() => link.request(cmd.time(0, 480)), 'device:range');
      await link.close();
    },
  },
  {
    name: 'log → rows 原样返回',
    fn: async () => {
      const link = await makeLink();
      link.pushLog({ utc: 1_763_000_000, i: 1, act: 'taken' });
      link.pushLog({ utc: 1_763_000_100, i: 2, act: 'snooze' });
      const e = await link.request(cmd.log());
      assertEq(e.evt, 'log');
      assertEq(e.rows.length, 2);
      assertEq(e.rows[0].act, 'taken');
      await link.close();
    },
  },
  {
    name: 'bell（静音模式）→ device:audiooff（静音红线：绝不本地发声）',
    fn: async () => {
      const link = await makeLink(); // audioOn 默认 false
      await assertRejectKind(() => link.request(cmd.bell()), 'device:audiooff');
      await link.close();
    },
  },
  {
    name: 'bell（audioOn=true）→ ok',
    fn: async () => {
      const link = await makeLink({ audioOn: true });
      const e = await link.request(cmd.bell());
      assertEq(e.evt, 'ok');
      await link.close();
    },
  },
  {
    name: 'forceErr(full) → 下一条 set 回执 device:full（P-04 测试钩子）',
    fn: async () => {
      const link = await makeLink();
      link.forceErr('full');
      await assertRejectKind(() => link.request(cmd.set(0, VALID_R)), 'device:full');
      // 钩子是一次性的：下一条恢复正常
      const ok = await link.request(cmd.set(0, VALID_R));
      assertEq(ok.evt, 'ok');
      await link.close();
    },
  },
  {
    name: '坏 JSON 行 → 设备回 err:badjson（走 evt 通道）',
    fn: async () => {
      const link = await makeLink();
      const p = nextEvt(link);
      await link._writeLine('{broken\n');
      const evt = await p;
      assertEq(evt, { evt: 'err', why: 'badjson' });
      await link.close();
    },
  },
  {
    name: '未知 cmd → err（P-02：契约未定义口径，模拟端回 badjson）',
    fn: async () => {
      const link = await makeLink();
      const p = nextEvt(link);
      await link._writeLine('{"cmd":"wat"}\n');
      const evt = await p;
      assertEq(evt.evt, 'err');
      assertEq(evt.why, 'badjson');
      await link.close();
    },
  },
  {
    name: 'busy：处理中收到第二条 cmd → err:busy（原始并发写，绕过本端排队）',
    fn: async () => {
      const link = await makeLink({ procDelayMs: 80 });
      const got = []; // 收集器模式：并发 nextEvt 会互抢同一事件，不能那么写
      link.addEventListener('evt', (e) => got.push(e.detail));
      const line = JSON.stringify({ cmd: 'hello' }) + '\n';
      await link._writeLine(line);
      await link._writeLine(line);
      await waitFor(() => got.length >= 2, { timeoutMs: 2000 });
      const whys = got
        .map((e) => (e.evt === 'hello' ? 'hello' : e.why))
        .sort();
      assertEq(whys, ['busy', 'hello']);
      await link.close();
    },
  },
  {
    name: '超时重发 ×3 后放弃（LinkError timeout，写次数=3）',
    fn: async () => {
      const link = await makeLink({ procDelayMs: 1 });
      link._muteDispatch = true; // 设备装死
      let writes = 0;
      const orig = link._writeLine.bind(link);
      link._writeLine = async (t) => { writes++; return orig(t); };
      const t0 = Date.now();
      await assertRejectKind(() => link.request(cmd.hello(), { timeoutMs: 60, retries: 3 }), 'timeout');
      assertEq(writes, 3, '首发+2 次重发共 3 次');
      assert(Date.now() - t0 >= 180, '3×60ms');
      link._muteDispatch = false;
      link._writeLine = orig;
      const e = await link.request(cmd.hello());
      assertEq(e.evt, 'hello'); // 恢复后可用
      await link.close();
    },
  },
  {
    name: 'busy 回执也计入重试并最终成功',
    fn: async () => {
      const link = await makeLink({ procDelayMs: 30 });
      // 不经 enqueue 的原始写占住处理管线，再发正式请求 → 第一次 busy → 重试成功
      await link._writeLine('{"cmd":"log"}\n');
      const e = await link.request(cmd.log(), { timeoutMs: 200 });
      assertEq(e.evt, 'log');
      await link.close();
    },
  },
  {
    name: '注入断连：pending 请求立刻被拒（disconnected）',
    fn: async () => {
      const link = await makeLink({ procDelayMs: 300 });
      const p = link.request(cmd.hello(), { timeoutMs: 2000 }).catch((e) => e);
      await link.dropConnection();
      const err = await p;
      assert(err instanceof LinkError && err.kind === 'disconnected', `应为 disconnected，实为 ${err.kind}`);
      await link.close();
    },
  },
  {
    name: '注入断连后可重连，槽位数据保留',
    fn: async () => {
      const link = await makeLink({ procDelayMs: 5 });
      await link.request(cmd.set(1, VALID_R));
      link.dropConnection();
      assertEq(link.connected, false);
      await link.open();
      const { items } = await link.requestStream(cmd.get());
      assertEq(items.length, 1);
      assertEq(items[0].i, 1);
      await link.close();
    },
  },
  {
    name: 'close 后请求 → disconnected（不发不猜）',
    fn: async () => {
      const link = await makeLink();
      await link.close();
      await assertRejectKind(() => link.request(cmd.hello()), 'disconnected');
    },
  },
  {
    name: 'forceFire → 主动推送 evt:fired {i, at}',
    fn: async () => {
      const link = await makeLink();
      await link.request(cmd.set(3, VALID_R));
      const p = nextEvt(link);
      link.forceFire(3);
      const evt = await p;
      assertEq(evt.evt, 'fired');
      assertEq(evt.i, 3);
      assertEq(evt.at, '08:00');
      await link.close();
    },
  },
  {
    name: '自然触发：_tick 命中当前 hh:mm + 当日 → fired；同分钟防重复',
    fn: async () => {
      const link = await makeLink();
      const d = new Date();
      const weekday = (d.getDay() + 6) % 7; // 周一=0
      const days = [0, 1, 2, 3, 4, 5, 6].map((i) => (i === weekday ? '1' : '0')).join('');
      const hh = d.getHours();
      const mm = d.getMinutes();
      await link.request(cmd.set(0, { on: true, hh, mm, days, name: 'x' }));
      // 关闭开关的不触发
      await link.request(cmd.set(1, { on: false, hh, mm, days, name: 'y' }));
      const p = nextEvt(link);
      link._tick();
      const evt = await waitForEvt(p, (e) => e.evt === 'fired' && e.i === 0);
      assertEq(evt.at, `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
      // 同一分钟内再 tick 不重复触发
      let extra = false;
      link.addEventListener('evt', (e) => { if (e.detail.evt === 'fired') extra = true; }, { once: true });
      link._tick();
      await new Promise((r) => setTimeout(r, 40));
      assert(!extra, '当日已触发标志应防重复');
      await link.close();
    },
  },
  {
    name: 'seed 种子数据生效（hello.n / get 一致）',
    fn: async () => {
      const link = await makeLink({ seed: [VALID_R, { ...VALID_R, name: 'b' }] });
      const hello = await link.request(cmd.hello());
      assertEq(hello.n, 2);
      const { items } = await link.requestStream(cmd.get());
      assertEq(items.length, 2);
      await link.close();
    },
  },

  // ---- reconnectDelayMs（断连重连退避策略，A1） ----
  {
    name: 'reconnectDelayMs: 快速阶段指数退避 1s→2s→4s→…封顶 10s',
    fn: () => {
      assertEq([0, 1, 2, 3, 4, 5, 6, 7].map((a) => reconnectDelayMs(a)),
        [1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000]);
    },
  },
  {
    name: 'reconnectDelayMs: 耗尽（≥fastMax）转低频 slowMs，不放弃',
    fn: () => {
      assertEq(reconnectDelayMs(8), 30000);
      assertEq(reconnectDelayMs(9), 30000);
      assertEq(reconnectDelayMs(99), 30000);
      // 自定义参数（低频可配置，演示时调小即可观察循环）
      assertEq(reconnectDelayMs(8, { fastMax: 4, slowMs: 2000 }), 2000);
      assertEq(reconnectDelayMs(3, { fastMax: 4, slowMs: 2000 }), 8000);
    },
  },
];

async function assertRejectKind(fn, kind) {
  try {
    await fn();
  } catch (e) {
    assert(e instanceof LinkError, `应抛 LinkError，实为 ${e?.constructor?.name}: ${e?.message}`);
    assertEq(e.kind, kind, 'LinkError.kind');
    return;
  }
  throw new Error(`应抛 kind=${kind} 的 LinkError，但成功了`);
}

/** 等到符合条件的 evt（跳过其它主动推送） */
async function waitForEvt(promise, pred) {
  let evt = await promise;
  for (let i = 0; i < 50 && !pred(evt); i++) {
    // promise 已消费；此分支正常不会走到（测试环境无杂音）
    await new Promise((r) => setTimeout(r, 10));
  }
  return evt;
}

export const suite = { title: 'simlink（SimulatedLink 契约回归）', tests };
