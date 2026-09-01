# 安装指南

本插件提供三种形态，可组合使用：

1. **持久 Agent Preset** —— 工具 + 优先策略 + 回退弹窗 + `codebuddy_status`（多数用户首选）；
2. **家级状态灯插件**（v1.0.0+）—— 状态灯随软件启动、所有会话自动显示、无需审批（与方式 A 搭配，见方式 B）；
3. **动态 Cordis 插件** —— 进程内临时形态，额外带浏览器状态灯（需一次性审批，见方式 C）。

**推荐组合：方式 A + 方式 B**，一次安装，工具与常驻状态灯齐备，随 DSH 启动即用。

---

## 前提

- 一套可运行的 **DeepSeek Harness (DSH)**。
- 本机安装了 **`codebuddy` CLI**（`npm i -g @tencent-ai/codebuddy-code`；开发时验证：v2.143.0）。**不要求在 PATH 里**——桥接会依次解析 `subprocess.resolveExecutable('codebuddy')`（排除 `.cmd` shim）→ `node + CODEBUDDY_BIN` 环境变量 → `node + %APPDATA%\npm\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy`，npm 全局安装即可被找到：

  ```bash
  codebuddy --version   # 开发时验证：v2.143.0
  ```

- 会话组合里挂载了这些 Host 服务（`standard` preset 默认都有）：
  `tools`、`subprocess`、`systemPrompt`、`timer`；可选增强：`jobs`（后台任务）、`planMode`（plan 自动判定）、`sandboxPolicy`（默认 cwd）、`userQuestions`（回退弹窗）。

---

## 方式 A：持久 Agent Preset（推荐）

### 1. 找到你的用户 preset 根目录

Preset 目录位于：

```
${DSH_HOME:-$HOME/.dsh}/.agent-presets/
```

`DSH_HOME` 未设置时回退到 `$HOME/.dsh`。本仓库开发环境中它是：

```
C:\Users\<you>\AppData\Roaming\DSH Desktop\dsh-home\.agent-presets\
```

> 用 DSH 的 `agentPresets` 服务（`list()` / `resolve()`）可以在运行时读到每个 preset 的真实路径，不要凭空假设。

### 2. 复制 preset 目录

```powershell
# Windows PowerShell
Copy-Item -Recurse .\preset\codebuddy-first "$env:DSH_HOME\.agent-presets\codebuddy-first"
```

```bash
# macOS / Linux
cp -R ./preset/codebuddy-first "${DSH_HOME:-$HOME/.dsh}/.agent-presets/codebuddy-first"
```

复制后目录应为（preset 自包含两个模块文件）：

```
.agent-presets/codebuddy-first/
├─ preset.yml
├─ agent.cordis.yml
├─ codebuddy-first-bridge.mjs        # 宿主适配层（工具注册 / 事件发布 / env 解析）
└─ codebuddy-core.mjs                # 共享核心副本（bridge 相对导入 './codebuddy-core.mjs'）
```

> 两个 `.mjs` 必须一起复制（整目录复制天然满足）。`codebuddy-core.mjs` 是仓库 `core/codebuddy-core.mjs` 的生成副本（`npm run build` 产出），保证安装目录无外部依赖。

### 3. （可选）核对工作目录默认值

`codebuddy-first-bridge.mjs` 顶部有一个兜底常量：

```js
const CWD_FALLBACK = 'C:\\Users\\lcl\\Desktop\\codebuddy-bridge'
```

仅当会话未提供 `sandboxPolicy.workspaceRoot`、且调用时未显式传 `cwd` 时才会用到它。按需改成你的默认工作目录即可（一般无需改动）。

### 4. 校验它能挂载

在一个带 Cordis 能力的会话里，通过 `agentPresets.standingKeyFor('codebuddy-first')` 做一次 mount 校验；返回成功即表示模块被正确导入、三个工具（`codebuddy_run` / `codebuddy_continue` / `codebuddy_status`）已注册、提示段已装配、且没有触发根 realm 冲突。

也可以先做一次语法自检：

```bash
node --check ./preset/codebuddy-first/codebuddy-first-bridge.mjs
node --check ./preset/codebuddy-first/codebuddy-core.mjs
```

### 5. 使用

新开会话时选择 preset **`CodeBuddy-First 执行代理`**（id：`codebuddy-first`）。你会得到 `standard` 的全部能力，外加 `codebuddy_run` / `codebuddy_continue` / `codebuddy_status` 工具、codebuddy 优先策略与限流/网络回退弹窗。

> **重要：切勿编辑随部署发行的 `agent-presets` 安装目录**（它会在升级时被覆盖，破坏 `cordis` 等出厂 preset 甚至会使该模式失效）。始终安装到**用户** preset 根目录下的独立子目录。

---

## 方式 B：家级状态灯插件（随软件启动、所有会话可见，v1.0.0+）

把 [`home-plugin/codebuddy-indicator/`](../home-plugin/codebuddy-indicator/) 安装为 DSH 家级插件，状态灯即随 DSH 启动自动加载、所有会话自动显示、无需审批。**推荐与方式 A 搭配**：preset 每次状态变化会 `ctx.emit('codebuddy/status')` 推送，家级收集器接收后经 HTTP 路由暴露，浏览器灯轮询渲染。

```powershell
$dshHome = "$env:APPDATA\DSH Desktop\dsh-home"   # 或你的 DSH 家目录

# 1) 复制插件源码
Copy-Item -Recurse .\home-plugin\codebuddy-indicator "$dshHome\plugins\codebuddy-indicator"

# 2) 建 junction（host 解析与浏览器花名册都需要；共 3 条）
New-Item -ItemType Junction -Path "$dshHome\node_modules\codebuddy-indicator" -Target "$dshHome\plugins\codebuddy-indicator"
New-Item -ItemType Junction -Path "$dshHome\profiles\node_modules\codebuddy-indicator" -Target "$dshHome\plugins\codebuddy-indicator"
New-Item -ItemType Junction -Path "$dshHome\profiles\web\node_modules\codebuddy-indicator" -Target "$dshHome\plugins\codebuddy-indicator"

# 3) 在 cordis.patch.yml 末尾追加两行（Cordis HMR 自动热载，无需重启）：
#    - insert:
#        - id: codebuddy-indicator
#          name: file:///.../plugins/codebuddy-indicator/lib/index.mjs?v=1
#    - insert:
#        - id: codebuddy-indicator-client
#          name: codebuddy-indicator
```

校验：

```powershell
# host 路由（浏览器灯的数据源）
Invoke-WebRequest -Uri "http://127.0.0.1:<DSH端口>/codebuddy-indicator/status"   # → {"state":"idle","running":0,"projects":[]}

# client 模块已入浏览器花名册
Invoke-WebRequest -Uri "http://127.0.0.1:<DSH端口>/plugins/codebuddy-indicator/client.js"  # → 200
```

改 `lib/index.mjs` 后 bump `?v=N` 即热载；改 `lib/client.js` 后刷新浏览器即生效。

---

## 方式 C：动态 Cordis 插件（进程内临时形态）

动态形态是进程内临时插件，**进程重启后消失**，但它自带浏览器状态灯（通过 Client→Host RPC，不依赖家级插件）。

1. 在一个已加载 Cordis 能力的 DSH 会话里，用 `cordis_define` 定义插件：
   - `code.host` = [`dynamic/host.js`](../dynamic/host.js) 的完整内容；
   - `code.client` = [`dynamic/client.js`](../dynamic/client.js) 的完整内容。
2. 用 `cordis_run`（`mode: "run"`）激活返回的 `pluginId` / `packageId`。
3. 首次运行 **Client 半** 时，DSH GUI 会弹出一次性审批（单勾仅授权当前包，双勾授权后续版本）。批准后，状态灯出现在会话标题栏右侧。
4. 需要临时停用用 `cordis_stop`；彻底删除用 `cordis_undefine`。

> 若本会话禁用了审批提示，Client 半会被自动拒绝——改用「方式 A + 方式 B」组合：回退弹窗与家级状态灯依然可用。

---

## 卸载

- **Preset**：删除 `.agent-presets/codebuddy-first/` 目录即可（下次读取 roster 时消失）。
- **家级状态灯插件**：从 `cordis.patch.yml` 移除两行（HMR 自动卸载），删除 `dsh-home/plugins/codebuddy-indicator/` 与三条 junction（`node_modules\codebuddy-indicator`、`profiles\node_modules\codebuddy-indicator`、`profiles\web\node_modules\codebuddy-indicator`）。
- **动态插件**：`cordis_undefine <pluginId>`。
