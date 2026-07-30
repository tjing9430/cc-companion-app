# CC Companion App

**把你的 AI 伴侣装进手机。** 自托管的双人聊天 App：私聊、群聊、记忆、控制台，跑在你自己的电脑或服务器上——聊天记录和记忆全存本地，不经过任何第三方服务器。

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
- **装起来是真的快**：Node 18+，零依赖，`npm start` 就跑。没有数据库要装，没有 Docker 要学。

## 快速开始（3 分钟）

```bash
git clone https://github.com/tjing9430/cc-companion-app.git
cd cc-companion-app
cp .env.example .env
npm start
```

浏览器打开 `http://localhost:8787`。不填任何 key 也能跑——内置了一个本地 mock 助手，先把界面玩起来，再决定接哪个模型。

**嫌读文档麻烦？让 AI 带你装。** 把 [`docs/AI_GUIDED_SETUP.md`](docs/AI_GUIDED_SETUP.md) 整篇粘给任意 AI（Claude / ChatGPT / Gemini），加一句「请按下面这份 spec 一步一步引导我安装 CC Companion」。它会一步一验地把你带到装好为止。

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

bridge 只绑 `127.0.0.1`，不要裸暴露到公网。默认 `interactive` 模式能显示 extended thinking（需 Linux/WSL）；跨平台可用 `BRIDGE_MODE=print`。人格设定写在 Claude Code 自己的 `CLAUDE.md` 里，不在 App 的设置里。详细配置、会话管理、架构说明见 [docs/CC-CONNECT.md](docs/CC-CONNECT.md)。

## 装到手机上

没有 APK，也不需要——这是 PWA，两步装完，日常用起来跟原生 App 没区别。

**第一步，让手机够得着它**（三选一，从简到稳）：

1. **同一个 WiFi**：手机直接开 `http://<电脑IP>:8787`。
2. **任何网络、零配置**：装免费的 [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)，`.env` 里设 `TUNNEL=quick` 重启——终端和控制台里会打出一个公网 HTTPS 地址。**先设好 `APP_AUTH_TOKEN`**，不然拿到链接的人都能用你的 AI。
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
- 可选 `APP_AUTH_TOKEN` 访问口令，适合公网部署
- 存储就是两个路径：`data/app-data.json` + `data/uploads/`，备份 = 复制

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

## 商标与免责

本项目与 Anthropic 无关。"Claude" 与 "Claude Code" 是 Anthropic PBC 的商标。本项目不内置任何模型服务，所有 LLM 调用走你自己的 API key 或订阅。

## 开源卫生

发布 fork 或衍生版本前：

- `.env` 和 `data/` 不进 git
- 清掉日志、截图、私聊导出和个人部署笔记
- 换掉曾经提交或分享过的一切 token
- 把个人姓名与域名换回配置默认值

## License

[MIT](LICENSE)
