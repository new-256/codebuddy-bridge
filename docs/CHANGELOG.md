# 更新日志

本项目遵循 [语义化版本](https://semver.org/)；版本号同步 `package.json`、Git tag 与 GitHub Release（`npm run check` 中的 `scripts/verify.mjs` 在 CI 里锁三处一致）。

## [1.1.1] - 2026-09-02

修复：非 codebuddy-first 会话里状态灯常驻不灭（两层原因，都修）。

### 修复

- **① 家级插件 host 半 `presetActive` 粘滞**：`codebuddy/mode {active:true}` 事件把 `presetActive` 永久置 true——既无 TTL，preset 会话关闭时也无 `active:false`。DSH 进程启动后只要有任何会话加载过一次 codebuddy-first preset，之后即使再无 codebuddy-first 会话，所有会话（含普通模式）的标题栏都会常驻灰灯。修复：改为**心跳租约**——preset 每 30s 宣告一次续期，TTL 75s（≈两拍容差，容忍事件循环抖动）；最后一个 codebuddy-first 会话关闭后 ≤75s 自动熄灭；收到 `active:false` 立即熄灭。host 半状态逻辑抽取为可独立测试的 `createIndicatorState()`（注入时钟 + TTL），端点新增 `lastModeAt` 诊断字段。
- **② 「CB 就绪」空转灯是全局的**：只要任何一个标签页开着 codebuddy-first 会话（哪怕空闲），其余所有会话（含普通模式）都会显示「CB 就绪」。修复：**会话级判定**——客户端经 slot `inject(sessionId)` 拿到本会话 id，从客户端 `sessions.list` 快照读取本会话的 `agentPreset`（preset id = 目录名 `codebuddy-first`）本地判定；空转灯只在该会话本身是 codebuddy-first 时显示，**活动灯（项目 pill）保持全局显示**。快照/服务不可用（旧版 DSH）时回退到全局租约判定。
- 家级插件 host 半首获测试覆盖：`test/indicator.test.mjs` 9 例（初始态、租约到期熄灭、心跳续期、`active:false`、ok 保持窗口 8s/10min、running/fallback 不受窗口影响、容量淘汰 MRU、无损 JSON、`apply()` 装配 + webServer 路由）。测试 49→58 例。

### 验证

- `npm test`：58/58 通过。
- 实机（host 半热加载部署，cordis.patch.yml `?v=3`）：`lastModeAt` 采样证实存在开着的 codebuddy-first 会话每 30s 心跳续期（相隔恰 30014ms）；新实例装载后无心跳时 `presetActive` 立即为 false。
- 客户端半：浏览器花名册已供应新 bundle（含 per-session 判定）；本会话（非 codebuddy-first）刷新页面后空转灯不再渲染，即使另一标签页的 codebuddy-first 心跳仍在续期。

## [1.1.0] - 2026-09-02

双后端：`backend="workbuddy"` 把任务派发给 **腾讯 WorkBuddy**（CodeBuddy 的同引擎「孪生兄弟」，主打办公场景）。

### 背景

WorkBuddy 桌面版（`C:\Program Files\WorkBuddy`）内置与 codebuddy-code **同一引擎、同一 CLI、同一 stream-json 协议**的命令行（`resources\app.asar.unpacked\cli\bin\codebuddy`，`@genie/agent-cli`），差异只在产品面：办公工具集（腾讯文档/PPT/表格、知识库、图片视频生成、微信/企微回复），登录态与桌面应用共享。实测 `node <wb-bin> -p ... --output-format stream-json --permission-mode bypassPermissions` 输出事件逐字段兼容。

### 新增

- **`backend` 参数**（`codebuddy_run` / `codebuddy_continue`，三形态齐备）：`'codebuddy'`（默认，编码场景）或 `'workbuddy'`（办公场景）。preset/dynamic 经 `WORKBUDDY_BIN` 环境变量（preset）或内置路径（dynamic 沙箱无 env）解析 WorkBuddy CLI；MCP 经 `WORKBUDDY_BIN`（未装 WorkBuddy 时返回带安装指引的 `CODEBUDDY_UNAVAILABLE`，而非裸 ENOENT）。
- **会话感知后端路由**：codebuddy 与 workbuddy 各自维护独立会话存储（`~/.codebuddy` 与 `~/.workbuddy`），同一 sessionId 只在其中一个后端有效。引擎以 `sessions[sessionId] = {cwd, backend}` 表一次解析出续接所需的工作目录与后端：`codebuddy_continue` 不带 backend 时按 sessionId 自动路由回所属 CLI；显式 `backend` 参数始终最优先。cwd 解析按会话查表而非项目级 `lastSessionId`（后者只记最后一个会话，同项目混跑多会话时会 miss）。
- **状态呈现**：结果对象新增 `backend` 字段（渲染头部 `workbuddy OK [...]`）；`codebuddy_status` 项目行带 `[workbuddy]` 标记；回退弹窗文案按后端命名。
- **策略段更新**：office 任务（文档/幻灯/表格、知识库、图片视频生成、微信企微回复）优先 `backend="workbuddy"` 派发。

### 验证

- `npm test`：49/49 通过（新增 resolveTarget 后端路由、buildResult/fallbackResult/renderResult backend 贯通、dynamic 沙箱 backend 派发 + 自动路由、MCP workbuddy 夹具真跑 + 未装 WorkBuddy 报错文案）。
- 真实端到端（MCP + 真实 WorkBuddy CLI）：`backend="workbuddy"` 真跑 SUCCESS + 同会话续接自动路由回 workbuddy；codebuddy 默认路径回归通过。

## [1.0.0] - 2026-09-02

首个正式版本：**codebuddy 优先派发 + DSH 全程掌控 + 受限回退**的完整闭环，外部代码评审驱动的可靠性基线、共享核心架构与测试套件。自 [agy-first-bridge](https://github.com/new-256/agy-first-bridge) v1.5.11 移植并完成 codebuddy 适配（`--permission-mode bypassPermissions`、`--resume`/`--continue` 续接、Claude Code 风格 stream-json 事件解析、effort 扩为 minimal/max 两端、新增 `maxTurns`、node+bin 可执行解析回退；codebuddy 无套餐额度 API，移除 agy 的 quota 体系，以 token 计量作替代观察）。

### 功能

- **三模型工具**：`codebuddy_run`（`mode` / `model` / `effort` / `maxTurns` / `cwd` / `addDirs` / `timeoutSec` / `background`）、`codebuddy_continue`（`sessionId` 或 `latest: true` 续接）、`codebuddy_status`（实时观测 + 按项目用量统计）。
- **codebuddy 优先策略**注入 systemPrompt（`codebuddy:policy` 段）：所有模式下优先把实际工作派发给 codebuddy，原生工具只做快速只读查询与最终验证。
- **DSH 全程掌控**：非交互运行、权限全自动批准（codebuddy 从不弹提示）；模式/模型/effort/工作目录/超时/后台/取消均由 DSH 决定（`exec.signal` + `handle.terminate()` 可中止）。
- **受限回退弹窗**：失败命中限流/网络/认证特征时 `userQuestions.ask()` 三选一（回退 DSH 本地 API 配置 / 重试 / 取消），最多 2 次尝试；子代理无应答者与后台任务失败不弹窗。
- **实时状态灯**：家级插件 `home-plugin/codebuddy-indicator/`（随软件启动、所有会话自动显示、无需审批；按项目一盏灯，点击弹出实时活动面板）+ 动态形态经 `codebuddyCollector` 推入同一张表。
- **按项目 token 用量统计**（`runs` / `totalTokens`，三形态一致）：codebuddy 无套餐额度 API，以 token 计量作替代观察。
- **零依赖 MCP 服务器**：三个工具经 stdio JSON-RPC 暴露给任何 MCP 宿主（Claude Code / Codex / Cherry Studio…）自动发现；`--check` 自检；**安全护栏 `CODEBUDDY_MCP_ALLOWED_ROOTS`**（`;`/`,` 分隔的 cwd 白名单，越界返回 `CWD_BLOCKED`）。
- **文档与 CI**：中英双语 README / INSTALL / ARCHITECTURE / FALLBACK-AND-INDICATOR、MCP-POLICY、GitHub Actions（语法矩阵 + YAML 结构断言 + 测试 job）。

### 可靠性基线（全部由故障注入回归测试锁定）

- `codebuddy_status` 在任何失败路径下可用：全局状态判定仅依据最近 `lastStatus`（`SUCCESS → ok`，其余 `→ failed`），非 SUCCESS 失败后状态工具与家级灯数据通道不被异常打断。
- 会话感知 cwd 回落：codebuddy 会话按项目目录归档，续接未显式给 `cwd` 时回落到该 session 所在项目的 cwd（否则换目录报 "No conversation found"），三形态共用同一实现。
- 结果对象全程无损 JSON（轨迹折叠 `args` 存 `null` 而非 `undefined`）。
- 回退弹窗单次三选一；「重试」仅在还有重试次数时提供。
- 后台任务与前台一致的挂起守卫（`timeoutSec+60s` 强杀 + `HUNG_TIMEOUT` 标注）；`jobs.start` 失败立即返回 `JOB_START_ERROR`，绝不静默回落前台重跑。
- 限流/网络判定只匹配 `stderr + status`（不匹配回复全文），数字码词边界（`"1500"` 不命中 `500`）。
- 半行安全的实时流解析：跨 stdout chunk 的 NDJSON 行不丢失（`createLineStream` 残余缓冲 + 结束冲刷）。
- MCP spawn ENOENT 单次结算（`settled` 标志）；stdin EOF 请求护栏。
- 工具入参对象不可扩展（冻结）场景下可执行解析回退不误报（`_binPath` 存局部变量）。

### 架构：共享核心（单一事实来源 + 生成派生产物 + 同步锁定）

- **`core/codebuddy-core.mjs`**：纯函数（`parseCodebuddyJson` / `buildResult` / `buildArgv` / `isLimited` / `summarizeArgs` / `clampInt` / `shortLabel` / `fallbackResult`）、状态引擎（`createStatusEngine`：按项目聚合 + MRU 淘汰 + 会话感知路由 + 用量累计）、半行流（`createLineStream`）、执行编排（`createRunner`：runSync / 挂起守卫 / 弹窗回退 / 后台派发 / 限流循环）与共享文案（`POLICY_TEXT`）。
- 三形态只剩宿主适配层：**preset**（ctx.tools 注册 + `ctx.emit` 事件 + `process.env` 解析）；**dynamic**（`scripts/build.mjs` 文本注入生成 `host.js`——动态沙箱禁止 import；`harness.registerTool` + collector 推送）；**MCP**（stdio JSON-RPC + 白名单护栏 + 文本渲染）。复制式多形态维护是字段级漂移的温床，共享核心从结构上消除该类缺陷。
- `scripts/build.mjs` 生成两个派生产物（`dynamic/host.js` + preset 侧 `codebuddy-core.mjs` 副本），`test/build-sync.test.mjs` 重新生成并比对——改 core 忘记重新生成时 CI 失败。

### 测试（44 例）

`test/`（node:test，零依赖）：纯函数/状态引擎/行流 22 例；dynamic 沙箱模拟 8 例（按真实求值方式 `new Function('harness', body)` 装载生成产物，故障注入覆盖上述回归位）；preset 适配层 3 例（真实 ESM 导入 + `process.env` 解析形态）；MCP stdio 端到端 6 例（真实子进程 + 伪 codebuddy 夹具）；构建同步锁定 3 例。CI：语法矩阵（Node 18/20/22）+ 测试 job + `scripts/verify.mjs`（`package.json` ↔ MCP `VERSION` ↔ CHANGELOG 版本三处锁死 + preset YAML 结构断言）。

### 验证

- `npm test`：44/44 通过。
- 真实端到端（MCP server + 真实 codebuddy CLI）：指定 `model: hy3` 真跑 SUCCESS、同会话续接 SUCCESS；用量累计算术自洽（25157 + 50347 = 75504 tokens）。
- 动态形态真实运行：工具注册 / 回退弹窗 / 后台 jobId 链路 / 运行中实时灯数据流实测通过。
- 安装同步：preset 目录 4 文件 SHA-256 与源码一致；MCP `--check` 自检通过。
