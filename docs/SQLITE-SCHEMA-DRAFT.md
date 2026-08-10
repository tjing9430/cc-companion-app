# SQLite 迁移 + 记忆库架构 · schema 设计稿

- 出稿:2026-08-11
- **状态:纸面稿,未实弹。** 评审通过前不碰迁移。
- 目标:**schema 一次定型,不迁两次** —— 把记忆库升级里所有会动数据结构的项现在就吸进来,
  哪怕功能排在 UI 之后实现。字段先占位,逻辑后补。

## 0. 待拍板的前置(挡着迁移脚本那半,不挡 schema)

上 SQLite 有三条路,**它们的 schema 是同一份**,差别只在数据访问层:

| 方案 | 零依赖 | Node 下限 | 代价 |
|---|---|---|---|
| `better-sqlite3` | ❌ 破 | 18 | 原生模块要编译;Windows 装不上是经典投诉 |
| **`node:sqlite`**(建议) | ✅ 保住 | **22.5+** | API 实验性;老 Node 用户被挡 |
| 继续 JSON | ✅ | 18 | 整文件重写,量大就慢 |

零依赖是这个仓库对外最硬的卖点,是立过红线的。**已定:走 `node:sqlite`,红线不破。**
还有一条理由比上面三条都硬:Node 18 去年 4 月 EOL、20 今年 4 月 EOL —— 守着 `>=18` 不是照顾老用户,
是陪着过期引擎裸奔;提门槛本来就欠着,SQLite 只是把账单送上门。

### 免 flag 的最低版本(下官方二进制实测,不是查文档抄的)

| Node | 免 flag | 带 `--experimental-sqlite` |
|---|---|---|
| v22.12.0 | ❌ `ERR_UNKNOWN_BUILTIN_MODULE` | ✅ |
| **v22.13.0** | ✅ | ✅ |
| v23.3.0 | ❌ `ERR_UNKNOWN_BUILTIN_MODULE` | ✅ |
| **v23.4.0** | ✅ | ✅ |

**★ 23.0–23.3 是个洞。** unflag(nodejs/node#55890)在 22 线和 23 线是**分别**落的,
所以 `>=22.13.0` 这种写法会把这个洞放进来 —— 用户装个 23.2 就炸,而我们声称支持。

```
"engines": { "node": "^22.13.0 || >=23.4.0" }
```

### engines / CI / README 什么时候改

**跟 SQLite 代码同一个 commit 落,不提前。** 现在把门槛提到 22 而代码还没用上 sqlite,
等于纯付代价没收益:Node 20 的人被挡在门外,换来的功能一个都还没有;万一 schema 被否,
还要再回滚一次。CI 矩阵同理 —— 先撤 18/20 而 engines 还写着 `>=18`,就变成
「声称支持但不测」,比不改更糟。**一次改齐:engines + CI 矩阵(18/20 撤、22/24 上)+ README 门槛说明。**

**`node:sqlite` 能力实测(本稿用到的全验过,不是查文档推的)**:

| 能力 | 结果 | 本稿哪里用 |
|---|---|---|
| 建表 + 外键 `ON DELETE CASCADE/SET NULL` | ✅ | 到处 |
| 偏索引 `CREATE INDEX ... WHERE` | ✅ | 3 个热路径索引 |
| 事务 `BEGIN` / `ROLLBACK` | ✅ | 迁移整体回滚 |
| `prepare` + 参数绑定 | ✅ | 全部读写 |
| 外键约束真生效(**默认是关的,要 `PRAGMA foreign_keys=ON`**) | ✅ | 关系完整性断言 |
| FTS5 全文检索 | ✅ | §7 原标"未验",现已验通 |
| WAL 模式 | ✅ | 并发读写 |

★ 外键默认关闭这条要写进迁移脚本:不显式打开,`REFERENCES` 就只是注释。

## 1. 现状全集(迁移必须覆盖,一个都不能漏)

`data/app-data.json` 顶层 11 项:

| 键 | 形态 | 去向 |
|---|---|---|
| `chat_messages` / `group_messages` | list | 合并进 `messages`(本来就有 `scope` 列) |
| `memories` | list | `memories` |
| `documents`(内含 `chunks`) | list | `documents` + `document_chunks` |
| `console_events` | list | `console_events` |
| `stickers` | list | `stickers` |
| `settings` | dict | `kv`(单行 JSON,不拆列——它天天加字段) |
| `session` | dict | `kv` |
| `context_anchor` / `memory_extract_cursor` | dict | `kv`(按 scope 存) |
| `counters` | dict | `kv`(**要迁**,发号权仍归它,原因见 §5) |

## 2. 表结构

> **DDL 的真源是 `scripts/migrate-to-sqlite.mjs` 里的 `SCHEMA_SQL`。**
> 本节是它的说明版,两边不一致一律以脚本为准 —— 双源迟早漂,先把话钉死。

```sql
-- 会天天加字段的配置类:存 JSON,别拆列。拆了每加一个开关就要迁一次。
CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL              -- JSON
);
-- settings / session / context_anchor:chat / memory_extract_cursor:group ...

CREATE TABLE messages (
  id            INTEGER PRIMARY KEY,
  scope         TEXT NOT NULL,      -- 'chat' | 'group'
  sender        TEXT NOT NULL,
  role          TEXT NOT NULL,      -- 'user' | 'assistant'
  content       TEXT NOT NULL DEFAULT '',
  thinking      TEXT NOT NULL DEFAULT '',  -- 思考链;订阅态 print 模式下为空串(不是 NULL)
  msg_type      TEXT DEFAULT 'chat',
  parent_msg_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  attachments   TEXT DEFAULT '[]',  -- JSON 数组;附件是整体读写的,不值得开表
  -- ★ 是 favorited 不是 favorite,而且还有 recalled_at ——
  --   头一版这两处我是凭印象写的,扫代码才发现:字段名错一个 = 迁移当天静默丢一列。
  favorited     INTEGER DEFAULT 0,
  recalled      INTEGER DEFAULT 0,
  recalled_at   TEXT DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_messages_scope_id ON messages(scope, id);          -- 列表/分页主路径
CREATE INDEX idx_messages_parent   ON messages(parent_msg_id);      -- 引用回查

CREATE TABLE memories (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL DEFAULT '',
  mood          TEXT DEFAULT '',
  author        TEXT DEFAULT '',
  pinned        INTEGER DEFAULT 0,
  -- ① 事实键顶替(已上线,JSON 版已有这三个字段)
  fact_key      TEXT DEFAULT '',
  superseded_by INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  superseded_at TEXT DEFAULT '',
  -- ④ 强度:字段已占位,排序逻辑等真机跑几天再接
  strength      INTEGER DEFAULT 50,
  -- ⑥ 归档「已淡去」:先占位
  archived      INTEGER DEFAULT 0,
  archived_at   TEXT DEFAULT '',
  -- 自动提取来的标记(闭列表复用时用来分辨"用户填的"还是"模型挑的",可审计可回滚)
  auto_keyed    INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
-- 召回只看在效的:这个偏索引直接服务最热的那条路径
CREATE INDEX idx_memories_active ON memories(id)
  WHERE superseded_by IS NULL AND archived = 0;
-- 偏索引的 WHERE 已经把两列筛掉了,再把它们放进索引列没有意义(键更宽、命中一样)
CREATE INDEX idx_memories_factkey ON memories(fact_key) WHERE fact_key <> '';

-- 标签:JSON 数组查不了,开表。⑤实体也复用这套形状。
CREATE TABLE memory_tags (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);
CREATE INDEX idx_memory_tags_tag ON memory_tags(tag);

-- ⑤ 实体(排 UI 之后实现,表先立)。
-- ★ 人名表必须用户可配,绝不硬编码进代码 —— 自部署的人各有各的圈子,
--   把一份具体人名写死在源码里,既不通用,也等于把私人信息焊进仓库。
CREATE TABLE entities (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'person',   -- person | place | thing
  created_at TEXT NOT NULL,
  -- ★ 原来写的是 name UNIQUE。按「想不透就别硬编」的原则收窄成 (name, kind):
  --   SQLite 里加列、加表都便宜(ALTER TABLE ADD COLUMN 是 O(1)),
  --   **改唯一约束却要重建整张表** —— 所以这里只下最弱的、够防重的那个断言。
  --   两个形状我现在确实看不清,先不猜:①别名(张三/小张/老张 是不是一个人)
  --   ②关系上要不要挂权重或角色。真需要时前者加 entity_aliases 表、后者加列,都不动现有行。
  UNIQUE (name, kind)
);
CREATE TABLE memory_entities (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, entity_id)
);
CREATE INDEX idx_memory_entities_entity ON memory_entities(entity_id);

CREATE TABLE documents (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  source     TEXT DEFAULT 'typed',
  content    TEXT NOT NULL DEFAULT '',
  size       INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- chunk 从 JSON 数组里拆出来:它是召回的最小单位,得能单独索引和更新向量
CREATE TABLE document_chunks (
  id            INTEGER PRIMARY KEY,
  document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  text          TEXT NOT NULL,
  embedding_tag TEXT NOT NULL DEFAULT '',
  embedding_b64 TEXT NOT NULL DEFAULT '',
  UNIQUE (document_id, seq)
);
CREATE INDEX idx_chunks_embed ON document_chunks(embedding_tag);

-- 记忆向量单独一张:它比记忆本体大得多,分开存让 memories 的全表扫描便宜
CREATE TABLE memory_embeddings (
  memory_id     INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  embedding_tag TEXT NOT NULL,
  embedding_b64 TEXT NOT NULL
);

CREATE TABLE console_events (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,
  title      TEXT DEFAULT '',
  body       TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE stickers (
  id         INTEGER PRIMARY KEY,
  name       TEXT DEFAULT '',
  url        TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 迁移/版本记账:没有它,以后没人说得清这库是哪一版建的
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);  -- schema_version / migrated_at / migrated_from
```

## 3. 三个刻意的取舍

**① 配置类存 JSON 不拆列**(`settings`/`session`/游标)。它们天天加字段(今天就加过
`featureSemanticSearch`、头像还要加两个),拆成列等于每加一个开关迁一次库。
查询上也没需求 —— 从来只整取整存。

**② 附件留 JSON,chunk 拆表。** 判据是**有没有单独被查询/更新的需求**:
附件永远跟着消息整体读写;chunk 要单独算向量、单独进召回、单独更新 embedding。

**③ 向量分表。** `memory_embeddings` 独立,让 `memories` 的顺序扫描不用拖着几 KB 的
base64 走。文档 chunk 的向量留在 `document_chunks` 里,因为它本来就是按 chunk 取的。

## 4. 索引是按真实查询路径开的,不是见字段就加

| 索引 | 服务哪条路 |
|---|---|
| `idx_messages_scope_id` | 消息列表/分页(最热) |
| `idx_memories_active`(偏索引) | 召回只看在效的 —— 这是事实键顶替 + 归档的共同热路径 |
| `idx_memories_factkey`(偏索引) | 顶替时找同键 |
| `idx_memory_tags_tag` | 标签筛选 |
| `idx_chunks_embed` | 回填时找没向量的 chunk |

## 5. 计数器要迁(原稿写反了,实测打脸)

原稿写的是「计数器不迁,交给 `INTEGER PRIMARY KEY` 自带的自增」。**这个结论是错的。**

`INTEGER PRIMARY KEY` 发的是 `max(rowid)+1`。只要历史上**硬删过行**,`counters` 就会
领先于 `max(id)`,那些「发过、又被删掉」的号会被**第二次发出去**。实测:

```
表里已有 id = 1, 2, 5   （3、4 被硬删过）   counters = 9（下一个该发 9）
① 直接用 INTEGER PRIMARY KEY        → 新行拿到 6   ❌ 6/7/8 都是旧系统发过的号
② 插一行 id=8 当哨兵、再删掉         → 新行还是 6  ❌ 删完高水位就掉回去了
③ 改成 AUTOINCREMENT + 哨兵          → 新行拿到 9  ✅ 但要动主键语义、多一张 sqlite_sequence
```

**结论:`counters` 原样存进 `kv`,发号权仍归它。** 这是三条路里唯一「零 schema 代价 +
语义完全延续」的:应用层的 `nextId()` 一行都不用改,也不会有号被发第二次。

配套的断言 4 保的是「不撞现存行」(`counters > max(id)`),不是「不复用已删号」——
后者由「继续用 counters」这件事本身保证。

## 6. 迁移与回滚

**迁移**:读 `app-data.json` 全量 → 单个事务写入 → 提交前跑验收断言 → 断言不过就整体回滚。
**原文件不删不改名**,迁完仍留在原地(回滚就是"删掉 .db,继续用 JSON")。

**验收断言(每张表都要)**:
1. **逐表 count 对齐**:JSON 里几条,表里几条,不等就 abort
2. **抽样内容比对**:每表随机抽 N 条,逐字段比,不等就 abort(count 对不代表内容对)
3. **关系完整性**:`superseded_by` / `parent_msg_id` / `document_id` 指向的行都存在
4. **id 连续性**:每表 max(id) 与 `counters` 对得上
5. **JSON 往返**:从库里读回来重建一份 JSON,和原文件做结构比对

**★ 断言必须是控制流不是打印。** 今晚栽过两次「能看见失败≠失败被挡住」——
迁移脚本里所有检查都要 `if (!ok) throw`,不许只 `console.log`。

## 7. 明确不在这版里的

- 无障碍清单(归明天 UI 战役)
- ⑤实体、⑥归档的**实现**(表立了,逻辑等 UI 之后)
- 全文检索(FTS5):**已验可用**,但这版不建 —— 词法召回刚加过门槛、语义召回是正解,
  FTS5 属于第三套检索,先别开第三条路。表结构留着随时能加,不阻塞。

## 8. 迁移脚本骨架(配套迁移脚本,已落地)

`scripts/migrate-to-sqlite.mjs` + `test/migrate-sqlite.test.mjs`(19 条,全绿)。
**没对任何真数据跑过** —— 种子全是假的,实弹等审完。

三条设计:**默认演习**(不带 `--write` 就照样建表灌数据跑断言,跑完删库)、
**断言是控制流**(失败即 throw,事务整体回滚)、**原文件只读**(回滚 = 删掉 .db 继续用 JSON)。

### 字段清单是扫代码扫出来的,不是凭印象写的

这一步逮到自己两个错,都会在迁移当天静默丢数据:

1. **`favorite` 其实叫 `favorited`**,而且还有 `recalled_at` —— 我原稿两处都错。
2. **chunk 是 `{ text, embedding_tag?, embedding_b64? }` 对象,不是裸字符串。**

顺带把一条**推测**变成了**查证**:私聊和群聊都走 `nextId('message')` 这**同一个序列**,
所以合成一张 `messages` 表不会撞主键。但"现在的代码如此"不等于"老数据如此",
所以脚本里不假设、开工前直接验一遍 id 有没有重。

### 变异测试:故意把迁移写坏,看测试红不红

写完的测试全绿不说明任何事 —— 得看它**该红的时候红不红**。跑了 9 个变异:

| 把迁移改坏成 | 结果 |
|---|---|
| 文档正文偷偷 `trim()` | ✅ 11 条变红 |
| 漏迁 `recalled_at` | ✅ 1 条变红 |
| 静默漏迁最后一条消息 | ✅ 12 条变红 |
| 标签整个漏迁 | ✅ 12 条变红 |
| 顶替关系不连线 | ✅ 1 条变红 |
| **外键 `PRAGMA` 忘了开** | ❌ **全绿** → 已修 |
| **count 断言改成永远通过** | ❌ 全绿 → 见下 |

**外键那条是真漏。** 原来的测试自己建内存库、自己开 pragma,测的是 SQLite 不是我的脚本;
脚本里改成 `OFF` 整套照样绿。修法就是那条老教训 —— **写完读回来**:
`PRAGMA foreign_keys = ON` 之后立刻读回值断言等于 1,并把它放进返回值让测试能验。
改完再跑同一个变异:15 条变红。

**count 那条杀不掉,但不是断言失效 —— 是变异测试够不着。** 测试自己也硬编了同一批数字,
所以任何真的丢行都会被测试独立抓到(见变异测试那节);
脚本里那条 count 断言的**唯一作用域是真实数据**,那里没有测试知道预期值。
方法的边界,如实记在这里,不假装补了个测试。
