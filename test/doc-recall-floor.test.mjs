// 文档召回的相关度门槛。
//
// 病症(真实观测,不是推演):用户只上传了一份中文资料,结果**每一轮闲聊**都把它当
// 「参考资料」塞进 prompt —— agent 会把这份反复出现的东西读成一种持续的引导意图,
// 然后开始对着它表态。用户的 agent 原话:"每一轮消息都把那份东西当参考资料塞进来"。
//
// 根因:分词器对中文产「单字 + 二元组」,单字(你/在/的/我)几乎能撞上任何长中文文档,
// 停用词表只有十几个 —— 于是 `score > 0` 这个下限对中文形同虚设。
// 记忆召回没这病,因为它有 IDF 加权压常见字;文档召回没有。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'docfloor-'));
const { store } = await import('../lib/state.js');
const { recallDocumentChunks } = await import('../lib/docs.js');

// 一份和"闲聊"完全无关、但用词常见的中文资料
const TEXT = '这份说明讲的是项目的部署流程和目录结构,包括今天需要注意的配置项、'
  + '天气影响不到的服务器环境,以及写代码时的一些约定。';
store.documents = [{ id: 1, name: '部署说明.txt', source: 'typed', content: TEXT,
  chunks: [{ text: TEXT }],   // 真实形状是 {text} 对象,不是裸字符串(第一版我造错了,测试自己逮到)
  size: TEXT.length, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }];

test('闲聊不会把资料拽进 prompt', async () => {
  for (const q of ['你好', '在吗', '晚安', '我有点累']) {
    const hits = await recallDocumentChunks(q, 3, null);
    assert.equal(hits.length, 0, `「${q}」不该召回资料,却召回了 ${hits.length} 块`);
  }
});

test('真的在问这份资料时照样召得回', async () => {
  const hits = await recallDocumentChunks('部署流程和目录结构是怎样的', 3, null);
  assert.ok(hits.length > 0, '问到点子上就该召回,门槛不能高到把正事也挡了');
  assert.equal(hits[0].name, '部署说明.txt');
});

test('单个多字词命中不够(一个二元组撞上是很弱的证据)', async () => {
  // 只共享「今天」这一个词
  const hits = await recallDocumentChunks('今天', 3, null);
  assert.equal(hits.length, 0);
});

test('查询里没有多字词时直接不召回(纯单字/标点)', async () => {
  for (const q of ['?', '。', '我']) {
    assert.equal((await recallDocumentChunks(q, 3, null)).length, 0);
  }
});

test('limit=0 时一律不召回(关掉就是关掉)', async () => {
  assert.equal((await recallDocumentChunks('部署流程和目录结构', 0, null)).length, 0);
});
