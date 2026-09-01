# 架构

## 背景：DSH / Cordis 的两个平面

DSH 的能力由 Cordis 组合而成，每个能力是 `cordis.yml` 里的一行插件。存在两个平面：

- **Host 平面**：跑在 DSH 的 Node.js 进程里，掌管注册表、沙箱与审批栈、持久化、模型路由、子代理注册表等跨会话共享的东西。文件、网络、命令、Agent/Session 访问、Host 事件与服务、模型工具都在这里。
- **Client 平面**：跑在浏览器页面里，负责主题、布局、当前页面状态、工具卡片、Slot UI。

一个 **Agent Preset** 是「单个会话向这些注册表贡献了什么」——它的工具、人设、提示段。发布服务的行属于 Host 组合；只向 `tools` / `systemPrompt` 注册、不发布服务的行是「preset 面安全」的（像 `tool-fs`），无需 isolate realm。本插件正属于后者。

Host 与 Client 之间只能通过包私有的 JSON RPC 通信：Host 用 `harness.handle(method, handler)` 暴露方法，Client 用 `host.call(method, args)` 调用，方向是 **Client → Host**。

## 组件总览

```
                          ┌─────────────────────────── DSH Host (Node.js) ───────────────────────────┐
                          │                                                                          │
  模型 (任一模式)  ──工具调用──▶  codebuddy_run / codebuddy_continue / codebuddy_status                                │
                          │        │                                                                 │
                          │        ├─ buildArgv: 强制 -p + --output-format stream-json               │
                          │        │              + --permission-mode plan/bypassPermissions   │
                          │        │              + mode(auto→plan/accept-edits)/model/effort/maxTurns/...     │
                          │        │                                                                 │
                          │        ├─ subprocess.spawn(codebuddy ...) ──────────▶  本机 codebuddy CLI            │
                          │        │      exec.signal + ctx.timeout→terminate() 做取消/超时           │
                          │        │      逐行解析 stream-json 事件 → 更新 current/trail（实时）      │
                          │        │                                                                 │
                          │        ├─ 解析末尾 result 事件 → { ok, status, response, sessionId, ... }    │
                          │        │                                                                 │
                          │        ├─ 失败且疑似限流/网络？ ──▶ userQuestions.ask()  ← 真人弹窗          │
                          │        │         回退 → { fallback:true, status:FALLBACK_TO_DSH }         │
                          │        │         重试 → 再跑一次（上限 2 次）                              │
                          │        │                                                                 │
                          │        └─ 更新 status 快照 (begin/end + foldEvent，含 runs/totalTokens 累计) │
                          │                                          │                                │
                          │   systemPrompt.section('codebuddy:policy')                       │
                          └──────────────────────────────────────────┼───────────────────┘
                                                                     │ 状态变化 → 家级收集器
                                                                     │ （preset: ctx.emit / 动态: codebuddyCollector）
                          ┌──────── 家级 codebuddy-indicator（随软件启动，全软件只有一盏灯）───┐
                          │  GET /codebuddy-indicator/status → JSON 快照 {state, projects[]} │
                          └──────────────────────────────────────────┬──────────────────────┘
                                                                     ▼
                          ┌───────────────── DSH Client (浏览器) ────────────────────────┐
                          │  家级灯 client 半（lib/client.js，花名册模块）                 │
                          │  fetch('/codebuddy-indicator/status') 每 1.2s               │
                          │       ● 按项目渲染：工作中/成功/失败/本地回退/就绪（主题 token） │
                          └──────────────────────────────────────────────────────────────┘
```

## Host 半（`dynamic/host.js` / `preset/.../codebuddy-first-bridge.mjs`）

- `inject: ['tools', 'subprocess', 'systemPrompt', 'timer']` —— 硬依赖；其余用 `ctx.get()` 可选读取（`jobs` / `planMode` / `sandboxPolicy` / `userQuestions`）。
- `buildArgv()` 组装 codebuddy 命令行，**始终**带上 `-p`、`--output-format stream-json`、`--permission-mode bypassPermissions`（plan 模式则 `--permission-mode plan`；codebuddy 无 `--mode`/`--print-timeout`）；`mode:auto` 时读 `planMode` 决定 `plan` 还是 `accept-edits`。
- `runSync()` 通过 `subprocess.spawn` 执行，把调用方 `exec.signal` 透传给子进程，并用 `ctx.timeout(() => handle.terminate(), (timeout+60)s)` 兜底超时（codebuddy 自身无 `--print-timeout`，这是唯一防线）。运行期间 `startLiveParser()` 用 `ctx.interval` 增量读取 stdout，把 stream-json 事件（`assistant` 的 `tool_use`/`thinking`/`text`、`user` 的 `tool_result`）折入 `status.current` / `status.trail`（`foldEvent`），实现**实时观察**。
- 可执行文件解析：`subprocess.resolveExecutable('codebuddy')`（命中 `.cmd`/`.bat` shim 时弃用）→ `node + CODEBUDDY_BIN` → `node + %APPDATA%\npm\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy`——codebuddy 通常不在 DSH 进程 PATH 里，node+bin 回退是常态。
- 后台路径通过 `jobs.start({ kind:'bash', owner: exec.agent, run() {...} })` 执行，`run()` 返回 `{ cancel, done }`；`done` 解析结果并回填状态（同样挂 live parser）。
- `parseCodebuddyJson()` 容错解析 codebuddy 的 `stream-json` 输出（从末尾向前找 `{"type":"result",...}` 行，容忍日志行；整体 JSON 兜底）。
- 结果统一为一个纯 JSON 对象；`render()` 生成人类可读的工具卡片文本。
- `codebuddy_status` 工具 / RPC 返回纯标量快照 `{ state, running, current, trail, lastStatus, lastSessionId, runs, totalTokens, updatedAt, projects[] }`；`projects[]` 按项目（cwd）分节，每节含该项目 `current`（正在执行的步骤：工具名+参数，或 thinking/typing 思考/打字中）、`trail`、`lastStatus`、`runs`/`totalTokens`（按项目累计的调用次数与 token 用量——codebuddy 无套餐额度 API，以 token 计量作替代观察）等；顶层字段为全局聚合（向后兼容）。支持 `cwd` 参数只看某个项目。

### 关键约束（沙箱 vs 真实 Node）

| 约束 | 动态插件（沙箱） | Preset `.mjs`（真实 Node） |
| --- | --- | --- |
| `import` / `require` | ❌ 禁止 | ⚠️ 可用，但**够不到** `@deepseek-ai/*`（用户目录向上找不到 harness 包），故本模块**零依赖** |
| `AbortController` | ❌ 无（改用 `exec.signal` + `handle.terminate()`） | ✅ 有，但仍沿用同一套以保持一致 |
| `process` / `Buffer` / 原生定时器 | ❌ 无 | ✅ 有（未使用） |
| 工具注册 | `harness.registerTool(ctx, harness.defineTool({...}))` | `ctx.tools.register(<纯对象 ToolDefinition>)` |
| Host→Client RPC | `harness.handle('codebuddy_status', ...)` | ⚠️ 无 Client 半，故不注册（也无消费者） |

> 这也是**状态灯不能由 preset 提供**的原因：Preset 是 Host 面组合，其 `.mjs` 只在 Node 侧运行，没有浏览器 UI；实时灯是 Client 面 Slot 组件。本项目用**家级插件形态**解决持久性问题（见下）。

## 家级状态灯插件（`home-plugin/codebuddy-indicator/`，v1.0.0+；全软件只有一盏灯）

状态灯不依赖会话内动态插件（重启即失），而是通过 `cordis.patch.yml` 注册的家级插件实现**随软件启动、所有会话自动显示、无需审批**。**全软件只有这一盏灯**：动态形态不自渲染 UI，其状态经 `codebuddyCollector` 服务推入同一张表，由家级灯统一呈现。

```
会话内 codebuddy-first-bridge                              DSH Host（root realm）
  ┌─ preset 形态（真 Node 模块）：                ┌─ codebuddy-indicator host 半（lib/index.mjs）
  │   begin/end/foldStepUpdate                    │   ctx.on('codebuddy/status') → projects[cwd] 全局表
  │   ── ctx.emit('codebuddy/status', {snapshot}) ─────►│   ctx.on('codebuddy/mode')   → presetActive 标志
  │   （挂载时 emit codebuddy/mode {active:true}，30s 续期）│   ctx.provide('codebuddyCollector', {mergeSnapshot})
  │                                                │   webServer.register({kind:'exact', path:'/codebuddy-indicator/status'})
  └─ 动态形态（沙箱无 ctx.emit）：                 │   GET → JSON {state, running, projects[], presetActive}
      publish() → ctx.get('codebuddyCollector')           │
      .mergeSnapshot(snapshot()) ─────────────────►│   （服务方法调用，无需事件）
                                                    ▼
                                        DSH Client（浏览器）
                                          codebuddy-indicator client 半（lib/client.js，花名册模块）
                                          fetch('/codebuddy-indicator/status') 每 1.2s → 按项目渲染灯
```

- host 半 `lib/index.mjs`：
  - `ctx.on('codebuddy/status')`（preset 事件通道）与 `codebuddyCollector` 服务（动态形态通道）都汇入同一张 `projects[cwd]` 全局表（idle 项目按模式过滤，最多 24 项）。
  - `ctx.provide('codebuddyCollector', { mergeSnapshot })`：动态沙箱插件通过服务方法推送快照（沙箱无 `ctx.emit`）。
  - `presetActive` 标志：preset 挂载时 `ctx.emit('codebuddy/mode', {active:true})` 置真（每 30s 续期），路由随响应返回。
  - 显示策略：`presetActive=true` → 常驻（ok/idle 保留 10 分钟 TTL）；`presetActive=false` → 仅运行/回退时显示，ok/failed 保留 8 秒后隐藏。
- client 半 `lib/client.js`：`window.__ModuleLoader__.load({id, factory})` 格式（同 `dsh-model-status`），挂 `conversation.session.header.utilities`，轮询 HTTP 路由渲染；无项目且 `presetActive=false` 时**不渲染**（普通模式空闲无灯）。
- **裸名行占位 `lib/client-entry.mjs`（双实例加载崩溃防护，沿自参考实现 agy-first-bridge 的教训）**：patch 中裸名行 `codebuddy-indicator`（供 client-modules 扫描花名册）经 `package.json` 的 `main` 解析；`main`/`exports["."]` 必须指向本空占位而非 `index.mjs`，否则同一宿主逻辑被 file:// 行与裸名行加载成两个模块实例（ESM URL 不同），`apply` 执行两次 → `ctx.provide` 二次注册同名服务 → 后端启动崩溃。host 逻辑仅由 file:// 行加载。
- `cordis.patch.yml` 通过 Cordis HMR 热重载：改 `lib/index.mjs` 后 bump `?v=N`，改 `lib/client.js` 后刷新浏览器。

## Client 半（`dynamic/client.js`）

- **空骨架**：动态形态不注册自己的标题栏灯（避免与家级灯重复），UI 统一由家级 `codebuddy-indicator` 呈现；动态插件通过 `ctx.get('codebuddyCollector').mergeSnapshot(snapshot())` 把状态推入家级收集器。

## 共享核心与派生产物（v1.0.0+）

三个交付形态不各自复制核心逻辑（复制式多形态维护是字段级漂移的温床），而是收敛为**单一事实来源 + 生成派生产物 + 同步测试锁定**：

```
core/codebuddy-core.mjs（单一事实来源：纯函数 + createStatusEngine + createLineStream
                        + createRunner 执行编排 + 共享文案；不用 process/env/import）
   ├─ 直接 import（MCP server，仓库内运行）
   ├─ 生成副本 preset/codebuddy-first/codebuddy-core.mjs（scripts/build.mjs 原样复制；
   │   preset 经 './codebuddy-core.mjs' 相对导入 → 安装目录自包含无外部依赖）
   └─ 文本注入 dynamic/host.js（scripts/build.mjs 把 core 剥掉 export 关键字后
       注入 host.template.mjs 的 /*__CORE__*/ 占位符——动态沙箱禁止 import，
       只能自包含）
```

- 三形态只剩**宿主适配层**：preset（`ctx.tools.register` + `ctx.emit` 事件 + `process.env` 形态的 exe 解析）、dynamic（`harness.registerTool` + collector 推送 + 沙箱内无 env 的 exe 解析）、MCP（stdio JSON-RPC + cwd 白名单 + 文本渲染）。
- `scripts/build.mjs --check`（CI 与 `npm test` 都跑）重新生成两个产物并与盘上比对：改了 core 或 template 忘记重生成的提交会失败——「修两漏一」的漂移源头就此关闭（`test/build-sync.test.mjs`）。
- 用量统计（`runs`/`totalTokens`）位于状态引擎 `end()`：每完成一次调用按项目累计，codebuddy 无套餐额度 API，以 token 计量作替代观察。

## 生命周期与可逆性

所有副作用都挂到当前 Fiber，`cordis_stop` / `cordis_undefine` / preset 卸载时自动回收：

- 工具：`ctx.tools.register(...)` / `harness.registerTool(...)` 返回 disposer；
- 提示段：`ctx.systemPrompt.section(...)`；
- 样式：`styles.insert(...)`（`ctx.effect` 包裹）；
- 定时器：`ctx.timeout(...)` / `ctx.interval(...)` 返回 disposer。

## 数据流纪律

插件从不序列化 DSH 的活对象（Service / Event / Slot / Session）。它只读取需要的叶子字段（codebuddy 的 stdout 文本、退出码等），构造最小的、无 Host 引用的 JSON 对象跨 RPC 传输和展示。
