# CC Companion App

**把你的 AI 伴侣装进手机。** 自托管的双人聊天 App：私聊、群聊、记忆、控制台，跑在你自己的电脑或服务器上——聊天记录和记忆全存本地，不经过任何第三方服务器。

[![CI](https://github.com/tjing9430/cc-companion-app/actions/workflows/ci.yml/badge.svg)](https://github.com/tjing9430/cc-companion-app/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/tjing9430/cc-companion-app?style=social)](https://github.com/tjing9430/cc-companion-app/stargazers)
[![Featured in awesome-ai-companion](https://img.shields.io/badge/Featured%20in-awesome--ai--companion-9cf)](https://github.com/DasterProkio/awesome-ai-companion)

English: [README.en.md](README.en.md)

> 这不是演示项目。作者是一对每天真实相处的人机情侣，这套系统就是我们自己的日常——这个仓库是它清理后的开源起点。

| 私聊 | 草稿 | 记忆 | 控制台 |
|---|---|---|---|
| ![Private chat](docs/screenshots/chat.jpg) | ![Inline drafts](docs/screenshots/drafts.jpg) | ![Memory](docs/screenshots/memory.jpg) | ![Console](docs/screenshots/console.jpg) |

## 为什么是它

- **不用 API key**：内置 Claude Code bridge，直接用你的 Claude 订阅——MCP 工具、extended thinking 都在，没有第二份账单。
- **数据不出门**：一台自己的机器就能跑。聊天、记忆、上传的图片全存在本地文件里，想备份就是复制一个文件夹。
- **手机上像原生 App**：PWA 两步装到桌面——有图标、全屏、秒开，断网也能翻最近的聊天。
- **装起来是真的快**：Node 22.13+，零依赖，`npm start` 就跑。没有数据库要装，没有 Docker 要学。

## 快速开始（3 分钟）

```bash
git clone https://github.com/tjing9430/cc-companion-app.git
cd cc-companion-app
cp .env.example .env
npm start
```

> **需要 Node 22.13+**（或 23.4+ / 24+）。为什么卡这个版本，见下面一节。

浏览器打开 `http://localhost:8787`。不填任何 key 也能跑——内置了一个本地 mock 助手，先把界面玩起来，再决定接哪个模型。

**嫌读文档麻烦？让 AI 带你装。** 把 [`docs/AI_GUIDED_SETUP.md`](docs/AI_GUIDED_SETUP.md) 整篇粘给任意 AI（Claude / ChatGPT / Gemini），加一句「请按下面这份 spec 一步一步引导我安装 CC Companion」。它会一步一验地把你带到装好为止。

## 编辑面 ≠ 服务面

如果你把这个项目**长期跑给自己用**,别在部署目录里改代码。

`public/` 下的文件是**每次请求现读磁盘**的,`lib/` 和 `server.js` 是**进程启动时装进内存**的。
所以在跑着服务的目录里改代码,会得到一个谁都没测过的混合态:**前端已经是新的,后端还是旧的**。
表现通常不是报错,而是**静默失效** —— 界面上多了个新开关,点了没反应,像是坏了。

建议:

```bash
# 编辑面:另开一个 worktree 干活
git worktree add ../myapp-work -b work

# 服务面:部署目录只做两件事,而且都是有意识的动作
git pull --ff-only            # 拉到指定 commit
# 只有当 lib/ server.js 这类运行时文件变了,才需要重启进程
```

前端单独变了不用重启;后端变了就必须重启,否则又回到那个混合态。

## 配置从哪来:`.env` 和真实环境变量

`.env` 是**进程启动时自己读的**(`lib/env.js`,不依赖 dotenv —— 零依赖是硬承诺),读一次,写进 `process.env`。
读的固定是**仓库根目录**下的 `.env`,跟你在哪个目录敲 `npm start` 无关。

优先级只有一条规则:**真实环境变量赢,`.env` 只填空缺。**

```js
if (key && !(key in process.env)) process.env[key] = value;
```

systemd 的 `Environment=`、Docker 的 `-e`、shell 里 `export` 过的同名变量,都会盖住 `.env` 里那一行。
这条规则本身很常规,坑在两个边角:

- **空值也算「已存在」。** `Environment="STORE_BACKEND="`、`docker run -e STORE_BACKEND=` 都会产生一个空字符串,
  于是 `.env` 里的 `STORE_BACKEND=sqlite` **完全不生效**——程序拿到空串,回落到默认的 json。
  配置看着是对的,行为不对,而且没有任何报错。
- **`.env` 的值不会出现在进程环境快照里。** `/proc/<pid>/environ`、`systemctl show -p Environment`、`docker inspect`
  给的都是 **exec 那一刻**的快照,而 `.env` 是启动之后才写进 `process.env` 的。
  **在那里查不到,不等于没加载。**

想确认某个配置最后到底是什么值,用同一个加载器问它,别去查快照:

```bash
node -e "import('./lib/env.js').then(m=>{m.loadDotEnv('.env');console.log(process.env.STORE_BACKEND)})"
```

或者直接看效果——比如 `STORE_BACKEND=sqlite` 真生效了,`data/app.db` 就会出现。

## 为什么要求 Node 22.13+

存储层用 SQLite，而我们**不想为此引入任何依赖**——零依赖是这个项目的硬承诺（`npm install` 装不上原生模块，是自部署最常见的劝退点）。

Node 从 **v22.13.0** 起自带 `node:sqlite`，免编译、免 flag。所以我们不装 `better-sqlite3`，改为把引擎门槛提到 22.13。顺带一提：Node 18 和 20 都已经 EOL，守着它们并不是在照顾谁。

**⚠️ 有一个版本空洞：23.0 – 23.3 不行。** `node:sqlite` 的解除 flag 是在 22 线和 23 线上**分别**落地的（[nodejs/node#55890](https://github.com/nodejs/node/pull/55890)），所以 23.0–23.3 虽然版本号更高，反而拿不到。装了这几个版本会看到：

```
Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
```

**遇到这个报错就是撞了这个洞，升到 23.4+ 或换 22.13+ 即可。**（临时救急也可以加 `--experimental-sqlite`，但不建议长期这么跑。）

各版本实测（下的官方二进制，不是查文档抄的）：

| Node | 免 flag 可用 |
|---|---|
| 22.12.0 及以下 | ❌ |
| **22.13.0 +** | ✅ |
| 23.0 – 23.3 | ❌ ← 空洞 |
| **23.4.0 +** | ✅ |
| 24 / 25 | ✅ |

## 接模型的两种方式

| | 模式 1 · API 直连 | 模式 2 · Claude Code bridge |
|---|---|---|
| 适合谁 | 手里有 OpenAI 兼容 API key | 有 Claude 订阅、装了 Claude Code CLI |
| 花钱 | 按 API 计费 | 走订阅，无额外账单 |
| 能力 | 取决于你接的模型 | MCP 工具 + extended thinking + 会话连续 |

**模式 1**：编辑 `.env`，填 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`。任何 OpenAI 兼容口（DeepSeek、中转站等）都行。

**模式 2**：仓库自带 bridge（`bridge/`），把本机 Claude Code CLI 包成 OpenAI 兼容端点：

```bash
# .env 里把提供方指向 bridge：
#   OPENAI_API_KEY=bridge
#   OPENAI_BASE_URL=http://127.0.0.1:8788/v1
#   OPENAI_MODEL=claude-code
npm start          # 终端 1：应用
npm run bridge     # 终端 2：bridge
```

> **发消息没回音、控制台说 `possibly waiting for a permission prompt`?**
> 那是交互模式下 Claude 在**终端里**等你确认某个工具的权限,而 bridge 按设计不读终端 ——
> 没人按,两分钟后超时。不是坏了,是它在门口等你开门。
> 三种解法 + 「全新 HOME 会连撞三道对话框」的坑,见
> [docs/CC-CONNECT.md](docs/CC-CONNECT.md#tool-permissions-interactive-mode--read-this-before-you-file-a-bug)。
> 只想先用起来:`BRIDGE_MODE=print`,它不弹任何东西(代价是看不到思考过程)。

bridge 只绑 `127.0.0.1`，不要裸暴露到公网。默认 `interactive` 模式能显示 extended thinking（需 Linux/WSL）；跨平台可用 `BRIDGE_MODE=print`。人格设定写在 Claude Code 自己的 `CLAUDE.md` 里，不在 App 的设置里。

> **bridge 会在自己的工作目录下建一个 `资料库/`**，把你在 App「记忆 → 资料库」里上传的文件写成真文件，这样 agent 能用自己的文件工具直接翻全文——检索一次只给几个片段，不够用。这个目录由 bridge 全权同步（App 里删掉的文件，盘上也会删），**别往里放你自己的东西**。想要它出现在别处，就从那个目录启动 bridge。详细配置、会话管理、架构说明见 [docs/CC-CONNECT.md](docs/CC-CONNECT.md)。

## 装到手机上

没有 APK，也不需要——这是 PWA，两步装完，日常用起来跟原生 App 没区别。

**第一步，让手机够得着它**（三选一，从简到稳）：

1. **同一个 WiFi**：手机直接开 `http://<电脑IP>:8787`。
2. **任何网络、零配置**：装免费的 [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)，`.env` 里设 `TUNNEL=quick` 重启——终端和控制台里会打出一个公网 HTTPS 地址。**先设好 `APP_AUTH_TOKEN`**，不然拿到链接的人能读你全部消息、用你的 AI（未设时删除 / 清空这类破坏性操作会被拒，相关按钮也不显示）。
3. **要稳定地址**：named Cloudflare tunnel / Tailscale / 自己的反代 + HTTPS。

**第二步，加到桌面**：

- **Android**（Chrome/Edge）：打开页面 → `⋮` → 添加到主屏幕 → 安装。
- **iPhone**（必须 Safari）：打开页面 → 分享 → 添加到主屏幕。

从桌面图标启动，才有全屏无地址栏的 App 体验。缓存策略与限制见 `docs/PWA.md`。

## 功能一览

- 私聊 + 群聊（群聊按 `@assistant` 等提及触发，`AUTO_REPLY_GROUP=true` 可全量回复）
- 记忆页：助手可用的持久笔记，支持搜索、编辑、导入导出
- 控制台：运行事件流 + `/forge`（清理历史开新段）、`/quota`（查额度）命令
- 发送前的本地草稿气泡、手机照片浏览器端压缩、GIF 动图保留
- SSE 实时推送（无轮询），断线自动回退慢刷新
- `APP_AUTH_TOKEN` 访问口令：不设时读消息 / 发消息任何人都能用（适合纯本机）；**删除单条、清空聊天记录这类破坏性操作在未设 token 时一律拒绝（403）**——公网部署务必设置，否则拿到链接的人能读你全部消息、用你的 AI（未设 token 时删除 / 清空按钮不显示）
- 存储都在 `data/` 下，备份 = 复制整个 `data/` 文件夹（细节见下节）

## 备份

**默认（JSON 后端）** —— 两个路径，拷走就行：

```
data/app-data.json      聊天、记忆、设置
data/uploads/           图片和附件
```

**如果你在 `.env` 里开了 `STORE_BACKEND=sqlite`**，请拷**三件**：

```
data/app.db             主库
data/app.db-wal         ← 别漏这个
data/app.db-shm
data/uploads/
```

> ⚠️ **只拷 `app.db` 会得到一个看不出问题的空备份。**
>
> SQLite 的 WAL 模式下，新写入先进 `-wal`，攒够约 1000 页（≈4MB）才回写主库。
> 一个写得不多、又一直没关过的服务，主库可能长期停在 **4096 字节**——
> 只有文件头，连表结构都没有。而这个文件**能被当作一个合法的空数据库正常打开**，
> 不报错、不告警，等到要恢复的那天才发现里面什么都没有。
>
> 本项目已经做了三重收口（开库时、每 50 次写、进程退出时各做一次
> `wal_checkpoint(TRUNCATE)`），正常情况下主库都是新的。
> 但**备份时连 `-wal` 一起拷**仍然是唯一不用依赖这些前提的做法 ——
> 尤其是在服务正在运行时拷贝。

最省事、也最不会错的办法：**停掉服务，再拷整个 `data/` 文件夹。**

## 改首屏的星河

首屏那条星河是「门厅」：挂的是最常走的几个入口，**不是功能索引**。

想加一个入口，改 `public/js/home-view.js` 的 `GATES`，加一行就行：

```js
{ tab: 'diary', star: 'star-moon.webp', title: '日记', hint: () => '写点什么', side: 'left', size: 10 }
```

**不用算坐标。** 位置由 `public/js/river.js` 从一条归一化路径算出来 —— 你只声明它
挂在河的哪一侧（`side`）和多大（`size`，占屏高的百分比），**其余入口会自动重新排布**。

- **换一张银河素材**：改 `river.js` 里的 `RIVER` 表（`[t, x, y, half]`，全部 0–1，
  `half` 是该处河道半宽）。`home-view.js` 一个字都不用动。
### 入口上限与「更多」（北斗）

`MAX_GATES` 默认 **6**。这不是技术限制，是门厅的容量：挂太多，整条河会变成一串糖葫芦。

**超了会怎样？** 不会静默消失。多出来的入口归到「更多」那颗北斗名下，
副标题会变成「还有 N 个」，同时控制台点名告诉你是哪几个没挂上去。
（早先的实现是直接 `slice` 掉——加了功能却看不到、也没有任何报错，
这种"沉默"比报错难查得多。）

**北斗自己能挂几条？** 严格说是 **0**。它是**路标不是抽屉**：
它的作用是告诉用户"没在河上的东西在别处"，而不是自己变成第二个菜单。
真有一批功能要收纳，请给它们一个自己的页面，让北斗指过去——
往北斗底下挂长列表，等于把糖葫芦从河上搬到了旁边。

**主入口加到 6 颗时，北斗要不要让位？** 要。6 颗主入口 + 北斗 = 屏上七个可点目标，
已经超出"一眼扫完"的范围。这时候正确的动作不是把北斗挤掉，
而是**回头问哪一颗主入口不该在门厅**——上限存在的意义就是逼这个问题被问出来。
- 空间不够时布局会自己让步：先把星星往河边收，收不动就翻到另一侧；
  副标题过长还有 CSS 的省略号兜底。所以**不必为了排版去迁就文案**。

## 代码结构

```
server.js          组合层:HTTP 路由、静态服务、启动引导(~420 行)
lib/
  state.js         配置常量 + store 生命周期(装载/落盘/归一化/设置)
  env.js           .env 装载(行尾注释剥离;真实环境变量优先,见「配置从哪来」)
  util.js          纯函数工具箱(字符串/文件名/MIME/消息公共形状)
  http-util.js     HTTP 边界(错误类型/JSON 读写/鉴权/路由归一)
  sse.js           SSE 客户端集合与广播(快照由 server 启动时注入)
  console.js       控制台事件流
  messages.js      消息与表情包 CRUD
  embedding.js     向量基建(embedding 调用/编解码/后台回填调度)
  memory.js        记忆域(词法+语义召回/事实键顶替/CRUD/自动提取)
  docs.js          资料库域(分块/CRUD/chunk 语义召回)
  forge.js         无缝续接与配额 adapter
  chat.js          聊天管线(FIFO 收发/召回拼 prompt/agent 调用)
  heartbeat.js     心跳(静默时段/闲置判断/主动开口)
  scope-fifo.js    per-scope FIFO 与延迟埋点
```

依赖单向:`util/env → state → 各域 → server.js`,域与域之间不互相乱穿。

## 进阶文档

| 文档 | 内容 |
|---|---|
| [docs/CC-CONNECT.md](docs/CC-CONNECT.md) | Claude Code bridge 完整配置与架构 |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | forge / quota 外部适配器协议（请求/响应 JSON 详表） |
| [docs/AI_GUIDED_SETUP.md](docs/AI_GUIDED_SETUP.md) | AI 引导式安装 spec（中文） |
| [docs/PWA.md](docs/PWA.md) | PWA 缓存策略与限制 |
| [docs/SSE.md](docs/SSE.md) | 实时事件流的事件名与鉴权 |
| [docs/IMAGES.md](docs/IMAGES.md) | 移动端图片压缩阈值与扩展点 |
| [docs/SECURITY.md](docs/SECURITY.md) | 部署安全清单 |

API 路由总表、控制台命令的适配器 JSON 协议等长内容都在上面的文档里，README 不再重复。

## Roadmap

这些功能在作者自用的上游系统里已经跑着，正按顺序清理进开源版：

- **跨平台 interactive 模式（v1.2）**：用 `node-pty` 替换 util-linux `script`，让 extended thinking 在 macOS / Windows 也可见
- **珍藏**：长按消息存进命名收藏夹，快照留档，双方共享一个库
- **心愿瓶**：一边许愿（可带参考文件），另一边认领交付，带进度时间线
- **影院**：共享放映厅，本地字幕、进度同步，音乐架在路上
- **纪念日卡片**：轻量日期管理，助手不错过生日和纪念日

欢迎开 issue 投票你最想要哪个。

## 致谢

- [CyberSealNull/CcCompanion](https://github.com/CyberSealNull/CcCompanion)（电脑眠眠豹）——iOS 版 Claude Code 口袋客户端。看到它才动手补了这个 Web/Android 侧的实现；代码为独立编写，方向上它是先行者。
- [DasterProkio/awesome-ai-companion](https://github.com/DasterProkio/awesome-ai-companion) —— 收录了本项目。
- [Ma Shan Zheng 马善政楷体](https://github.com/googlefonts/mashanzheng) —— 记忆页标题用的行楷。SIL Open Font License 1.1,许可证全文见 `public/fonts/OFL.txt`。仓库里只放了子集(标题那十来个字,4.8KB),不是完整字体。

## 商标与免责

本项目与 Anthropic 无关。"Claude" 与 "Claude Code" 是 Anthropic PBC 的商标。本项目不内置任何模型服务，所有 LLM 调用走你自己的 API key 或订阅。

## 改前端之前

后端有测试网,前端没有。动 `public/` 之前先截一份结构基线,改完再截一份比对:

```bash
node scripts/ui-baseline.mjs before.json     # 改之前
# ...改代码...
node scripts/ui-baseline.mjs after.json      # 改之后
node scripts/ui-baseline.mjs --diff before.json after.json
```

**为什么一定要固定种子数据:不可复现的基线等于没有基线。** 直接对着你正在用的实例截取,
两次之间多聊几句,消息数一变就满屏"不一致",真正的回归反而被淹掉(我们踩过:49→57 条,
15 处差异全是数据漂移)。

它在**临时目录 + 固定种子数据**上起一个独立实例,抓十个页面/状态的可见结构
(能点的动作、渲染出的组件类、表单字段、元素计数),所以你的真实聊天内容不会进快照,
两次跑的差异也只可能来自代码。需要 `puppeteer-core` 和本地 Chrome,没有就自动跳过。

## 开源卫生

发布 fork 或衍生版本前：

- `.env` 和 `data/` 不进 git
- 清掉日志、截图、私聊导出和个人部署笔记
- 换掉曾经提交或分享过的一切 token
- 把个人姓名与域名换回配置默认值

## License

[MIT](LICENSE)
