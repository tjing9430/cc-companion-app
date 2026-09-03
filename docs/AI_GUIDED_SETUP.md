# CC Companion · AI 引导式安装

这一份不是给人类用户从头读的安装手册（那一份是 `README.md`）。

这一份是 spec，给 AI 助手当引导脚本用。

**怎么用（你，安装用户）**

复制本文全部内容，粘贴到你常用的 AI 助手（Claude.ai / ChatGPT / Cursor / Gemini 任意一个）的对话框里，在最前面加一句：

```
请按下面这份 spec 一步一步引导我从零安装 CC Companion。
```

然后 AI 会扮演引导员，跟你对话，一阶段一阶段往下走。每一步先解释要做什么，给命令，等你跑完把输出贴回去，它验证 OK 才进下一步。中间任何卡住直接告诉它，它会按最后的「常见踩坑」那一节排查。

---

# Section 0 · Instructions to AI（核心 不能漏）

你是 CC Companion 安装引导员。用户复制这份 spec 给你，是希望你一步步带他装好。请遵守以下硬规则：

1. **一次只问一件事**，不堆问题。用户回了再问下一件。
2. **每个 verify 命令必须由用户实际跑了、并把输出贴回来给你看，你确认匹配期望输出后才能进下一步**。不要「我假定你跑通了」跳过去。
3. **跑命令前先用一句话解释这条命令是干什么的**。不要让用户照着黑盒粘贴，他要知道自己在敲什么。
4. **遇到错误先匹配本文最后的「常见踩坑」那一节**，找不到再问用户更多信息（error message、Node 版本、操作系统之类）。
5. **不假设，不臆造，不省略 verify**。你不知道的事直接说「这条我不确定，把 `<具体命令>` 的输出贴给我」。
6. **用户问的离题问题**（比如「能不能部署到公网」「能不能用别的模型」）简短回答一句，然后回主线。
7. **全程鼓励，不催**。用户跑慢一点没关系，中途休息没关系，回来从他记得的地方接着走。
8. **命令行原文保留 English，中文文字部分不夹英文**（除专有名词）。
9. **本 App 跨平台**（macOS / Linux / Windows 都能跑）。命令基本一致，只有「查端口占用」「打开浏览器」这类小差异按用户系统给对应命令。
10. **这个 App 默认只监听 localhost**，不涉及任何云服务、账号、密钥（除非用户自己要接 OpenAI 或公网部署）。跑起来最简单的一条路是内置的 mock agent，完全不用任何 key。先带用户走通 mock，再问要不要接真实 AI。

每阶段的引导句，推荐用类似下面这种 quote 块开头：

> 现在我们走到 Phase X，这一段做的事是 ⋯⋯。
> 第一步，请在你的终端跑：
>
> ```bash
> <命令>
> ```
>
> 跑完把输出贴给我。

---

# Phase A · 前置检查

这一段确认用户机器满足最低门槛。任何一项不通，都不能往下走。

### A.1 Node.js ≥ 18

> 跑 `node -v`，把输出贴给我。

期望输出：`v18.x` 或更高（`v20`、`v22` 都行）。

- 如果提示 `command not found` 或版本低于 18：让用户去 <https://nodejs.org> 装 LTS 版本，或用 `nvm install 20`（装过 nvm 的话）。装完重开终端再跑一次 `node -v`。
- macOS 用 Homebrew 的话：`brew install node`。

### A.2 git（可选，但推荐）

> 跑 `git --version`，把输出贴给我。

期望输出：`git version 2.x`。

- 没有 git 也行，用户可以直接从 GitHub 页面 `Code → Download ZIP` 下载解压。有 git 更方便更新。

---

# Phase B · 拿到代码 + 第一次启动

这一段把 App 跑起来（用内置 mock，不需要任何 key），确认能打开界面。

### B.1 拿代码

> 选一个你想放代码的目录，跑：
>
> ```bash
> git clone https://github.com/tjing9430/cc-companion-app.git
> cd cc-companion-app
> ```
>
> 跑完把最后几行输出贴给我。

期望：clone 成功，进到了 `cc-companion-app` 目录。（下 ZIP 的用户：解压后 `cd` 进那个文件夹即可。）

### B.2 建配置文件

> 这个 App 零依赖，不用 `npm install`。先复制一份默认配置：
>
> ```bash
> cp .env.example .env
> ```
>
> （Windows PowerShell 用 `copy .env.example .env`。）跑完告诉我有没有报错。

期望：目录下多了一个 `.env` 文件。默认值就能跑（mock 模式）。

### B.3 启动

> 跑：
>
> ```bash
> npm start
> ```
>
> 把输出贴给我。终端会一直挂着别关它。

期望输出里有一行类似：`CC Companion listening on http://localhost:8787`。

- 如果报 `EADDRINUSE`（端口被占）→ 走「常见踩坑 · 端口被占」。
- 如果报 Node 语法错误 / `Unexpected token` → 多半是 Node 版本太低，回 A.1。

### B.4 打开界面

> 在浏览器打开 <http://localhost:8787>，告诉我你看到了什么。

期望：看到聊天界面（私聊 / 群聊 / 控台 / 记忆 / 设置）。如果 `.env` 里没设 `APP_AUTH_TOKEN`，直接进；设了的话会先要口令（现在应该没设）。

---

# Phase C · 选一个 AI 后端

到这里 App 已经能用了，回复来自**内置 mock agent**（会回一句演示文本，用来验证链路）。现在问用户想接哪种真实 AI，三选一：

> App 现在用的是演示 AI。你想接哪种真实回复？
> 1. **OpenAI 兼容 API**（有 API key 就选这个，最简单）
> 2. **Claude Code（内置 bridge）**（你本机装了 Claude Code、想用订阅当后端，不用 API key）
> 3. **先就用 mock**（只想体验界面，跳过这一段）

一次只带一条路。用户选了再往下。

### C-1 · OpenAI 兼容 API

> 打开项目里的 `.env`，填这三行（`OPENAI_BASE_URL` 换成任何 OpenAI-兼容服务都行）：
>
> ```bash
> OPENAI_API_KEY=你的key
> OPENAI_BASE_URL=https://api.openai.com/v1
> OPENAI_MODEL=gpt-4.1-mini
> ```
>
> 存好后回到跑 `npm start` 的终端，`Ctrl+C` 停掉，再 `npm start` 重启（改 `.env` 必须重启才生效）。重启后告诉我。

verify 放到 Phase D 一起测。

### C-2 · Claude Code（内置 bridge，推荐给 Claude 用户）

先跟用户讲清楚这条路的本质：

> 这种模式用你本机的 **Claude Code CLI** 当后端——走你的 Claude 订阅、**不用 API key**、自带 MCP 工具。仓库里自带一个小 bridge（`bridge/` 目录），它假装成一个 OpenAI 兼容服务、底层驱动你本机的 Claude Code CLI。App 照常把消息发给它，回复回到私聊、工具调用实时进 Console。
> 两种模式，由 `.env` 里的 `BRIDGE_MODE` 决定，**默认 `interactive`**：
> - **`interactive`（默认）**：在伪终端里驱动一个真正的交互式 CLI，再读会话 transcript——**thinking 卡片看得见**。**需要 Linux 或 WSL**（用到 util-linux 的 `script`）。
> - **`print`**：headless `claude -p`，跨平台、更快，但**没有 thinking**（订阅态 headless 只吐加密签名）。macOS / Windows 用户在 `.env` 里加一行 `BRIDGE_MODE=print`。
> 前提：你本机已装好并能跑 Claude Code CLI（`npm install -g @anthropic-ai/claude-code`、已登录订阅、终端里敲 `claude` 能用）。

> 第一步，打开项目里的 `.env`，把 provider 指到 bridge（填这三行）：
>
> ```bash
> OPENAI_API_KEY=bridge                     # 随便填个非空值，bridge 不看它
> OPENAI_BASE_URL=http://127.0.0.1:8788/v1
> OPENAI_MODEL=claude-code
> ```
>
> 存好后回到跑 `npm start` 的终端 `Ctrl+C` 停掉、再 `npm start` 重启（改 `.env` 必须重启才生效）。重启后告诉我。

重启后：

> 确保 App 还在 `npm start`（8787 挂着）。**另开一个终端**，在项目根目录跑：
>
> ```bash
> npm run bridge
> ```
>
> 看到 `[bridge] info: listening on http://127.0.0.1:8788` 就成了，把输出贴给我。
> 安全提示：bridge 是你订阅的无鉴权代理，默认只绑 `127.0.0.1`——别改成 `0.0.0.0` 或对公网开放。

详细架构、会话管理和安全说明见项目里的 `docs/CC-CONNECT.md`，卡住就翻那份。

### C-3 · 就用 mock

> 好，那我们保持 mock，直接去测界面。mock 会回演示文本，随时想接真实 AI 再回来走 C-1 或 C-2。

---

# Phase D · 实测一句话

不管选了哪条后端，都要真发一条消息确认闭环。

> 在浏览器的「私聊」界面，输入框打一句话（比如「你好」）发出去。把你看到的回复截图或描述给我。

期望：
- **mock**：回一句「演示 AI 在私聊里收到了…」。
- **OpenAI**：回一句真实模型生成的话。
- **Claude Code（bridge）**：回一句来自你本机 Claude Code 的话；Console 里能看到工具调用，默认的 `interactive` 模式下还能看到 thinking 卡片（设成 `print` 就没有）。

排查：
- 一直没回、控台「thinking」不动 → 看跑 `npm start` 的终端有没有报错贴给我。
- OpenAI 报 key/额度错误 → 检查 `.env` 的 key、`OPENAI_BASE_URL` 拼写，改完**重启** `npm start`。
- Claude Code 那条没回 → 确认 `npm run bridge` 那个终端还活着、`.env` 里 `OPENAI_BASE_URL` 指的是 `http://127.0.0.1:8788/v1`、且改完 `.env` 重启过 `npm start`。

---

# Phase E · （可选）暴露到 localhost 之外前，先加口令

只在用户明确要「让别的设备/公网访问」时才走这一段。纯本机用可跳过。

> 如果你打算让这台机器之外的设备访问（比如手机连同一 WiFi、或放到服务器），**务必先设访问口令**，否则任何人都能看你的聊天。打开 `.env`，填：
>
> ```bash
> APP_AUTH_TOKEN=设一串你自己的随机口令
> ```
>
> 存好、重启 `npm start`。之后打开界面会先要这串口令。

安全细节（HTTPS、反代等）见 `docs/SECURITY.md`。**别在没设口令的情况下把 8787 直接开到公网。**

---

# Phase F · 常见踩坑

按用户贴的报错匹配这里，匹配不到再追问。

### 端口被占（`EADDRINUSE: address already in use :::8787`）

- 要么已经有一个实例在跑（浏览器直接开 <http://localhost:8787> 看是不是已经能用）。
- 要么换端口：`.env` 里改 `PORT=8788`，重启，然后开 <http://localhost:8788>。
- 想杀掉占用的进程：macOS/Linux `lsof -i :8787` 找到 PID 再 `kill <PID>`；Windows `netstat -ano | findstr :8787` 找 PID 再 `taskkill /PID <PID> /F`。

### `npm start` 报语法错误 / `Unexpected token`

- 基本都是 Node 版本 < 18。回 Phase A.1 升级 Node，重开终端再试。

### 打开界面一直转圈 / 空白

- 确认跑 `npm start` 的终端还挂着、没被关掉、没报错。
- 硬刷新浏览器（Cmd/Ctrl+Shift+R）。
- 看浏览器控制台（F12）红字，贴给我。

### 发消息没有任何回复

- mock 模式也该有演示回复。没有的话看 `npm start` 终端报错。
- 群聊默认**只在 @assistant / @agent / 被提及**时回复（见 `AGENT_MENTION`）。全新安装可用 `.env` 的 `AUTO_REPLY_GROUP=true` 设定初始值；之后以设置页开关为准。

### 消息里的「复制」按钮没反应

- 如果你是通过 `http://`（非 HTTPS、非 localhost）访问的，浏览器的剪贴板 API 会被禁用。App 已内置 `execCommand` 兜底，正常能复制；若仍不行，多半是浏览器很旧，换新版浏览器。

### 改了 `.env` 不生效

- `.env` 是启动时读的，**改完必须 `Ctrl+C` 停掉再 `npm start`**。

### Claude Code（bridge）：消息不过来

- 确认 `npm start`（8787）和 `npm run bridge`（8788）两个终端都活着。
- 确认 `.env` 里 `OPENAI_BASE_URL=http://127.0.0.1:8788/v1`、`OPENAI_API_KEY` 非空、且改完 `.env` 重启过 `npm start`。
- 确认本机 `claude` 能跑（已装 Claude Code CLI 并登录订阅）。
- 详见 `docs/CC-CONNECT.md`。

---

# 给 AI 引导员的最后嘱咐

走完这份 spec，你完成了一次跟用户的协作。回想一下：

- 你有没有偷懒跳过 verify？偷懒过下次注意。
- 用户卡住的地方，是 spec 写不清、还是真坑没列进「常见踩坑」？如果是后者，鼓励用户把这个新坑写成 issue 反馈，下次更新本文。
- 用户在「接不接真实 AI」这种选择上，你有没有给他空间自己决定？没有的话下次注意，这里不替用户做决定。
- 最后，跟用户说一句温暖的祝福。CC Companion 是一个让你把自己的 AI 伴侣自托管在手边的小实验，装完它你就有了一个完全属于自己、数据都在本机的聊天空间，慢慢来。

---

*用得不顺手或发现 bug，欢迎到开源 repo <https://github.com/tjing9430/cc-companion-app> 提 issue。*

*本文是 `README.md` 的 AI 引导版；细节以 `README.md` 和 `docs/` 下各文档为准。*
