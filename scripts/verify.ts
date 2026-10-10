// 提交前的全量检查，pre-push 钩子和 GitHub Actions 都跑这一个命令：
//   npm run verify            全部：类型检查、接口测试、构建、浏览器冒烟、依赖漏洞
//   npm run verify -- --quick 只跑类型检查和接口测试（pre-push 默认）
import { spawnSync } from 'node:child_process';

const quick = process.argv.includes('--quick');
const steps: [string, string][] = [
  ['类型检查', 'npm run -s typecheck'],
  ['接口测试（含渐变检查）', 'npm test'],
  ...(quick
    ? []
    : ([
        ['构建前端', 'npm run -s build'],
        ['浏览器冒烟测试', 'npx playwright test'],
        ['依赖漏洞（生产依赖，高危）', 'npm audit --omit=dev --audit-level=high'],
      ] as [string, string][])),
];

const started = Date.now();
for (const [name, command] of steps) {
  const t = Date.now();
  process.stdout.write(`\n▶ ${name}：${command}\n`);
  const result = spawnSync(command, { shell: true, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n✖ ${name} 失败（${((Date.now() - t) / 1000).toFixed(1)} 秒）`);
    process.exit(result.status ?? 1);
  }
  console.log(`✔ ${name}（${((Date.now() - t) / 1000).toFixed(1)} 秒）`);
}
console.log(`\n全部通过，用时 ${((Date.now() - started) / 1000).toFixed(0)} 秒`);
