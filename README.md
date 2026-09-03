# CC Companion App

面向手机使用的自托管 AI Companion Web App。提供私聊、群聊、记忆、资料、配置、控制台和多主题界面；应用数据保存在运行主机本地，可连接 OpenAI 兼容 API、Claude Code Bridge 或 DSH。

[![CI](https://github.com/tjing9430/cc-companion-app/actions/workflows/ci.yml/badge.svg)](https://github.com/tjing9430/cc-companion-app/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/tjing9430/cc-companion-app?style=social)](https://github.com/tjing9430/cc-companion-app/stargazers)

English: [README.en.md](README.en.md)

| 私聊 | 草稿 | 记忆 | 控制台 |
|---|---|---|---|
| ![Private chat](docs/screenshots/chat.jpg) | ![Inline drafts](docs/screenshots/drafts.jpg) | ![Memory](docs/screenshots/memory.jpg) | ![Console](docs/screenshots/console.jpg) |

## 功能

- 私聊和群聊；群聊支持按提及触发或自动回复。
- 文本、图片和文件发送，附件预览、下载与聊天内容检索。
- 消息回复、复制、删除、召回和收藏。
- 持久记忆、资料库、语义检索、自动记忆提取和事实更新。
- 在前端查看及编辑受控范围内的 Hook、Skill、Markdown 和配置文件。
- Codex CLI 风格控制台、实时事件流、工具调用与文件改动差异。
- OpenAI 兼容 API、Claude Code Bridge 和 DSH 的正文及推理流式显示。
- 奶油白、浮岛、星空、暖深色主题和移动端 PWA。
- JSON 或 SQLite 本地存储，支持本机、局域网和 HTTPS 反向代理部署。

## 环境要求

- Node.js `22.13.0+`，或 `23.4.0+`。
- Node 23.0–23.3 的 `node:sqlite` 仍需要实验参数，不在支持范围内；遇到 `ERR_UNKNOWN_BUILTIN_MODULE` 时请升级到受支持版本。
- Claude Code Bridge 需要已安装并登录的 Claude Code CLI。
- DSH 模式需要 Python、DeepSeek Harness；Windows 推荐通过 WSL 执行工具。
- 公网访问建议使用 Cloudflare Tunnel、Tailscale 或带 HTTPS 的反向代理。

应用本身没有 npm 运行时依赖，克隆后可以直接启动。

## 快速开始

```bash
git clone https://github.com/tjing9430/cc-companion-app.git
cd cc-companion-app
cp .env.example .env
npm start
```

Windows PowerShell 可用：

```powershell
Copy-Item .env.example .env
npm start
```

默认地址是 [http://localhost:8787](http://localhost:8787)。没有配置模型时会使用内置 mock agent，便于先检查界面和部署。

需要引导式安装时，使用 [AI 安装指南](docs/AI_GUIDED_SETUP.md)。

## 接入模型

### OpenAI 兼容 API

编辑 `.env`：

```dotenv
OPENAI_API_KEY=your-key
OPENAI_BASE_URL=https://api.example.com/v1
OPENAI_MODEL=your-model
```

兼容提供标准 Chat Completions 接口的服务。支持流式正文；服务返回 reasoning 字段时也会显示推理内容。

### Claude Code Bridge

Bridge 把本机 Claude Code CLI 暴露为仅限本机访问的 OpenAI 兼容端点：

```dotenv
OPENAI_API_KEY=bridge
OPENAI_BASE_URL=http://127.0.0.1:8788/v1
OPENAI_MODEL=claude-code
```

分别启动应用和 Bridge：

```bash
npm start
npm run bridge
```

`BRIDGE_MODE=interactive` 支持会话、工具和 extended thinking，适用于 Linux/WSL；`BRIDGE_MODE=print` 适合非交互式跨平台运行。完整配置见 [Claude Code Bridge 文档](docs/CC-CONNECT.md)。

Bridge 默认只应监听 `127.0.0.1`，不要把未鉴权端点直接暴露到公网。

### DeepSeek Harness（DSH）

DSH 提供持久本地 Session、工具调用、推理流和文件交付。设置 `AGENT_PROVIDER=dsh`，并配置 DSH 仓库、工作目录、模型和执行器。

Windows/WSL 示例和全部变量见 [Adapter 文档](docs/ADAPTERS.md#deepseek-harness-dsh)。

## 手机访问与安装

同一局域网内，手机访问：

```text
http://<电脑局域网 IP>:8787
```

临时公网预览可以在 `.env` 中设置：

```dotenv
APP_AUTH_TOKEN=请使用足够长的随机口令
TUNNEL=quick
```

稳定部署建议使用 Named Cloudflare Tunnel、Tailscale、Caddy 或 nginx，并启用 HTTPS。

- Android：使用 Chrome 或 Edge 打开页面，选择“添加到主屏幕”。
- iPhone/iPad：使用 Safari 打开页面，选择“分享 → 添加到主屏幕”。

缓存策略见 [PWA 文档](docs/PWA.md)。

## 配置

`.env` 位于仓库根目录，启动时读取。操作系统、systemd、Docker 或 Shell 中已经存在的环境变量优先于 `.env`。

常用配置：

| 配置 | 用途 |
|---|---|
| `PORT` / `DATA_DIR` | 服务端口和数据目录 |
| `APP_AUTH_TOKEN` | Web 访问口令；公网部署必须设置 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | OpenAI 兼容模型 |
| `STORE_BACKEND` | `json` 或 `sqlite` |
| `CHAT_CONTEXT_MAX_MESSAGES` / `CHAT_CONTEXT_KEEP_MESSAGES` | API 模式上下文窗口 |
| `EMBEDDING_*` | 语义记忆与资料检索 |
| `MEMORY_EXTRACT_EVERY` / `EXTRACT_*` | 自动记忆提取 |
| `FORGE_ADAPTER_*` / `QUOTA_ADAPTER_*` | 外部换窗和额度适配器 |
| `HEARTBEAT_*` | 主动消息、空闲时间和静默时段 |
| `TUNNEL` | Cloudflare Quick Tunnel |

基础配置示例见 [.env.example](.env.example)，Bridge 与 DSH 的扩展变量见下方文档。

## 数据与备份

运行数据默认位于 `data/`：

```text
data/app-data.json
data/app.db
data/app.db-wal
data/app.db-shm
data/uploads/
data/dsh-sessions/
```

JSON 后端主要使用 `app-data.json`；SQLite 后端使用 `app.db` 及其 WAL/SHM 文件。最稳妥的备份方式是停止服务后复制整个 `data/` 目录。

`.env`、`data/`、上传附件、Session 和本地凭据不应提交到 Git。

## 项目结构

```text
server.js                 HTTP API、静态服务和启动入口
lib/                      状态、聊天、记忆、存储、SSE 和适配逻辑
public/                   PWA 页面、样式、主题和静态资源
public/js/                前端状态、视图、格式化与事件模块
public/js/actions/        从主事件分发器拆出的 action
bridge/                   Claude Code Bridge
adapters/                 OpenAI、CLI 和 DSH 适配器
scripts/                  检查、迁移、数据守卫和 UI 基线工具
test/                     自动化测试
docs/                     部署、协议、安全和扩展文档
data/                     本地运行数据，不进入 Git
```

## 开发与验证

长期运行的部署目录与开发目录建议分开：

```bash
git worktree add ../cc-companion-work -b work
```

`public/` 会在请求时读取，`lib/` 和 `server.js` 在进程启动时加载。后端代码变化后需要重启服务。

提交前运行：

```bash
npm run check
npm test
```

`npm run check` 会递归检查运行时代码目录中的 JavaScript 语法；`npm test` 使用数据守卫，避免测试写入真实运行数据。

前端结构基线：

```bash
node scripts/ui-baseline.mjs before.json
# 修改前端
node scripts/ui-baseline.mjs after.json
node scripts/ui-baseline.mjs --diff before.json after.json
```

该工具使用固定种子和临时数据目录，不读取真实聊天记录。需要 `puppeteer-core` 和本地 Chrome。

## 文档

| 文档 | 内容 |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | 版本更新记录 |
| [docs/AI_GUIDED_SETUP.md](docs/AI_GUIDED_SETUP.md) | AI 引导式安装 |
| [docs/CC-CONNECT.md](docs/CC-CONNECT.md) | Claude Code Bridge |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | DSH、Forge 和 Quota 适配器 |
| [docs/PWA.md](docs/PWA.md) | PWA 与缓存 |
| [docs/SSE.md](docs/SSE.md) | 实时事件流 |
| [docs/IMAGES.md](docs/IMAGES.md) | 图片上传与压缩 |
| [docs/SECURITY.md](docs/SECURITY.md) | 部署安全清单 |

## 安全

- 公网访问前设置强随机 `APP_AUTH_TOKEN`。
- Bridge 和本地模型代理保持监听 `127.0.0.1`。
- 不提交 `.env`、`data/`、日志、截图、聊天导出或凭据。
- 配置 DSH 时将 `DSH_CWD` 限制在允许 Agent 操作的工作区。
- 分享 fork 前轮换所有曾经暴露的 Token。

## 致谢

- [CyberSealNull/CcCompanion](https://github.com/CyberSealNull/CcCompanion)
- [DasterProkio/awesome-ai-companion](https://github.com/DasterProkio/awesome-ai-companion)
- [Ma Shan Zheng 马善政楷体](https://github.com/googlefonts/mashanzheng)，SIL Open Font License 1.1

## 商标

本项目与 Anthropic 无关。“Claude”与“Claude Code”是 Anthropic PBC 的商标。本项目不内置模型服务。

## License

[MIT](LICENSE)
