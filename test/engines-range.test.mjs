// engines 范围的守卫。
//
// 这一条存在的唯一理由:`^22.13.0 || >=23.4.0` 看起来像是可以「化简」成 `>=22.13.0` 的,
// 但那样会把 **23.0–23.3** 放进来 —— 那几个版本号更高、反而没有免 flag 的 node:sqlite
// (unflag 在 22 线和 23 线是分别落的,nodejs/node#55890)。用户装个 23.2 会当场撞
// ERR_UNKNOWN_BUILTIN_MODULE,而我们的 package.json 声称支持他。
//
// 这里不引 semver(零依赖是硬承诺),所以钉的是**字符串形状**:
// 拿真 semver 验过一遍边界(22.12 挡 / 22.13 放 / 23.0 挡 / 23.3 挡 / 23.4 放 / 24 放),
// 结论就固化成下面这条断言,别再让人顺手改窄。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

test('engines 必须是双段范围,不能被化简成 >=22.13.0', () => {
  assert.equal(pkg.engines.node, '^22.13.0 || >=23.4.0',
    '化简成 >=22.13.0 会把 23.0–23.3 这个 unflag 空洞放进来');
  assert.ok(pkg.engines.node.includes('||'), '必须是两段,单段一定漏洞');
});

test('迁移脚本里公布的最低版本和 package.json 对得上', async () => {
  const { NODE_REQUIREMENT } = await import('../scripts/migrate-to-sqlite.mjs');
  assert.equal(NODE_REQUIREMENT, pkg.engines.node,
    '脚本报错里告诉用户的版本要求,和 package.json 声明的必须是同一句');
});

test('README 把这个空洞讲清楚了,而且带报错原文(撞坑的人得能搜到)', () => {
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  assert.match(readme, /23\.0\s*[–\-]\s*23\.3/, 'README 要点名这个区间');
  assert.match(readme, /ERR_UNKNOWN_BUILTIN_MODULE/,
    '要带报错原文 —— 判据是撞坑的人拿报错去搜,能搜到这一页');
  assert.match(readme, /22\.13/, 'README 要写清最低版本');
});

test('CI 矩阵只跑真能拿到 node:sqlite 的版本(否则迁移测试被静默跳过,等于没测)', () => {
  const ci = fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');
  const m = ci.match(/node:\s*\[([^\]]+)\]/);
  assert.ok(m, 'CI 矩阵行不见了');
  const versions = m[1].split(',').map((x) => Number(x.trim()));
  // 实测过:18/20 上整套迁移测试(22 条)会被跳过,CI 绿得毫无意义
  for (const v of versions) {
    assert.ok(v >= 22, `CI 里还留着 Node ${v} —— 那上面迁移测试全跳过,绿了也不算数`);
  }
});
