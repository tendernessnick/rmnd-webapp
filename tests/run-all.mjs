// run-all.mjs —— node 测试入口：跑全部套件，失败退出码 1
import { runSuite } from './harness.mjs';
import { suite as protocolSuite } from './protocol.test.mjs';
import { suite as bmpSuite } from './bmp.test.mjs';
import { suite as simSuite } from './simlink.test.mjs';

const results = [];
for (const s of [protocolSuite, bmpSuite, simSuite]) {
  results.push(await runSuite(s.title, s.tests));
}
const total = results.reduce((a, r) => a + r.results.length, 0);
const failedSuites = results.filter((r) => !r.pass);
const failedCases = results.flatMap((r) => r.results.filter((x) => !x.pass));
console.log(`\n===== 总计 ${total} 项，失败 ${failedCases.length} 项，套件失败 ${failedSuites.length} 个 =====`);
process.exit(failedCases.length ? 1 : 0);
