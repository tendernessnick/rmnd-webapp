// harness.mjs —— 极简测试骨架（node 与浏览器共用，selftest.html 也导入这些套件）

export function assert(cond, msg = 'assert failed') {
  if (!cond) throw new Error(msg);
}

export function assertEq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg ? msg + '：' : ''}期望 ${b}，实际 ${a}`);
}

export async function waitFor(fn, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** 顺序执行一个套件；返回 {title, results, pass} */
export async function runSuite(title, tests, log = (s) => console.log(s)) {
  const results = [];
  for (const t of tests) {
    try {
      await t.fn();
      results.push({ name: t.name, pass: true });
    } catch (e) {
      results.push({ name: t.name, pass: false, error: String((e && e.message) || e) });
    }
  }
  const failed = results.filter((r) => !r.pass);
  log(`\n== ${title} ==`);
  for (const r of results) log(` ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : ' —— ' + r.error}`);
  log(`${title}: ${results.length - failed.length}/${results.length} 通过`);
  return { title, results, pass: failed.length === 0 };
}
