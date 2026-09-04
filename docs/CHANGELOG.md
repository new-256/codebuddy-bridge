# 更新日志

本项目遵循 [语义化版本](https://semver.org/)；版本号同步 `package.json`、Git tag 与 GitHub Release（`npm run check` 中的 `scripts/verify.mjs` 在 CI 里锁三处一致）。

## [1.1.4] - 2026-09-04

修复：标准模式下调用不顺畅 —— CLI 瞬时错误既不重试也不给原因，调用方只能白耗回合靠猜。

### 背景（实际会话记录）

标准（非 codebuddy-first）模式下下发一个 FizzBuzz 冒烟测试任务，第一次 `codebuddy_run` 失败，工具**只回了一行**：

```
codebuddy FAILED [status=ERROR_DURING_EXECUTION mode=bypassPermissions session=1f70715d… tokens=25268 29.154s]
```

没有原因、没有指引。调用方于是白耗一次 `codebuddy_status`（同样只有一行状态），再靠**猜**显式指定 `model=glm-5.3` 才成功。复现验证：同一任务、同一默认模型（`hy4-preview`）重跑 39s 直接成功 —— 说明 `ERROR_DURING_EXECUTION` 是 **CLI/服务端瞬时故障**，不是默认模型坏了、也不是任务本身有问题。

### 修复

- **瞬时错误自动重试一次**：新增 `isTransientCliError()` 识别 CLI 自报的 `error_during_execution`，preset 与 MCP 两条路径都会静默重试一次后再交还结果（不打断用户）。与限流/网络类失败明确分流：后者可能是额度耗尽，重试纯烧钱，仍走原有「问用户」弹窗；瞬时错误则重试一次大概率就过。续接类调用（`--resume` / `--continue`）不自动重试，避免会话状态已被前一次改动。
- **失败必带可行动指引**：新增 `failureHint()`，失败结果不再只有一行 head。瞬时错误明确告知「直接重试同一请求通常即可通过，不要据此认为任务有问题」；已自动重试过则改口径提示换 `model` 或改用原生工具；`PARSE_ERROR` 提示输出被截断 / 进程被中断。
- **结果记录实际使用的模型**：`buildResult()` 从 result 事件的 `modelUsage` 提取模型名（只取键名字符串，不把其下对象带进结果，保持通道可无损 JSON 化），head 里输出 `model=…`；自动重试过的结果额外标 `retried=1`。此前结果完全不含模型信息，排查「默认模型是否不稳」只能靠猜着换 `model` 试 —— 用户那次正是这样才蒙对。

修复后同一失败形态的输出：

```
codebuddy FAILED [status=ERROR_DURING_EXECUTION mode=bypassPermissions model=hy4-preview retried=1 session=1f70715d… tokens=25268 29.154s]

[诊断] codebuddy CLI 侧瞬时错误（error_during_execution，CLI 未给出原因），已自动重试 1 次仍失败。可换 model 再试一次；若仍失败请改用原生工具完成，或告知用户。
```

### 测试

- 测试 66→68 例：瞬时错误识别与限流优先级（`ERROR_DURING_EXECUTION` + 429 判为限流，不走静默重试）、其他失败态不误判、三类指引文案、`modelUsage` 提取与 JSON 可序列化、head 的 `model=` / `retried=1` 输出、无 `modelUsage` 时不影响渲染。

## [1.1.3] - 2026-09-03

修复：① 计划模式下 codebuddy 的 Bash 被门禁拦死（「无交互模式下未获授权」）；② 状态灯的会话判定改用自有权威通道，不再随 DSH 客户端 API 漂移。

### 修复

- **① 计划模式 Bash 门禁（新发现）**：DSH 处于计划模式时，preset 把 `mode=auto` 映射成 `--permission-mode plan`。CLI 在 `-p` 非交互 + plan 下**默认拒绝 Bash**（该档需交互授权，非交互下无人可授），codebuddy 于是报「**Bash 工具在无交互模式下未获授权（被拒绝），所以我改用 PowerShell 执行了同一条命令**」——同样是 shell，却因门禁不一致白耗回合，有时干脆放弃调查。修复：plan 模式额外传 `--allowedTools Bash` **预批**只读 shell。实测确认：Bash 恢复可用（`tool_use` 出现且命令真跑），**写入仍被 plan 模式独立禁止**（预批后 codebuddy 仍拒绝创建文件并说明「该约束优先级高于本次请求」），`Read`/`Grep` 等工具不受影响（`--allowedTools` 是预批而非排他白名单）。`bypassPermissions` 模式本不受门禁影响，不加白名单。
- **② 状态灯会话判定改为 host 侧实时枚举**：v1.1.2 靠读 DSH 客户端会话摘要的 `agentPreset`（0.3.14 起在 `projectionValues` 里）判断「本会话是否 codebuddy-first」。但**默认会话本就没有这个字段** → 判定「未知」→ 回退全局租约 → 普通会话仍可能亮灯；且该字段位置随 DSH 版本漂移（0.3.14 刚移过一次）。修复：家级插件**自己在 host 侧算**——`agents.list()` 遍历活着的 agent，用 `agentPresets.composedPreset(agent.ctx)` 读它实际组合的 preset id，端点新增 `presetSessions` 名单（每次请求现算，**对已经开着的会话立即生效**，无需重开）。客户端只需判断「我的 sessionId 在不在名单里」。
- **判定逻辑设两条独立通道且「任一肯定即肯定」**：host 名单（权威）与 DSH 客户端摘要通道并行，任一给出肯定即显示；都不肯定时才让名单做否定；两者皆无结论则回退全局租约。这不是冗余而是**安全阀**：万一两端 `sessionId` 取法失配，结果是「灯不亮」而不是「永久不亮」——若让名单单方面否定，一旦失配就比原缺陷更糟。
- **兜底上报通道**：preset 仍在 `codebuddy/mode` 事件里带自己的 sessionId（apply 阶段试 `agents.currentInitiator()`，拿不到则在第一次工具调用时从 `exec.agent` 补记），host 按会话记租约并与实时枚举取并集；实时枚举不可用时（服务缺失或 DSH 内部 API 变动）仍能工作。preset 卸载时主动发 `active:false` + sessionId，该会话立刻熄灯，不必等 75s；最后一个会话离场时顺带清全局租约，让仍读 `presetActive` 的旧客户端也立即熄灭。
- 端点契约扩展为 `{ state, running, projects[], presetActive, presetSessions[], lastModeAt }`（新增字段向后兼容）。会话名单上限 64，超出丢最早到期。

### 测试

- 测试 58→66 例：实时枚举为权威来源（无需任何上报即产出名单、会话关闭立即离场）、双源取并集且去重、枚举器抛错时安全降级到上报租约、按会话租约（多会话共存 / 单会话到期离场）、带 `sessionId` 的主动下线（只熄该会话 / 最后一个离场清全局）、旧版 preset 无 `sessionId` 的全局语义、名单容量上限、`apply()` 端到端（枚举出的 codebuddy-first 会话 ∪ 上报会话经路由送达，普通会话不在名单），以及 plan 模式预批 Bash 的 argv 契约。

## [1.1.2] - 2026-09-03

适配：**DSH Desktop 0.3.14 / @deepseek-ai/dsh 0.1.2-alpha.5**（本次 DSH 更新带来的客户端 API 变更修复 + 全线 DSH 版本适配标注）。

### 适配

- **背景**：DSH Desktop 0.3.12 起插件体系重构（插件隔离、profiles bundles 化、客户端模块系统重写）。0.3.14 / dsh 0.1.2-alpha.5 实测发现 v1.1.1 的「会话级就绪灯」判定失效——客户端会话摘要里的 `agentPreset` 字段已移入 `projectionValues` 投影值，且槽位 `inject` 的调用契约从 `inject(sessionId)` 变为零参（会话身份改由框架标准 props 提供），导致 v1.1.1 的读取永远 UNKNOWN、退回全局租约 → 空闲 codebuddy-first 标签页开着时其他会话又出现「CB 就绪」灯（v1.1.1 修复的回归）。
- **修复（双通道，跨版本兼容）**：
  - 优先走 **框架标准 props**（DSH ≥ 0.3.14）：会话作用域槽位向条目组件注入 `sessionId` 与 `useSessions` 选择器钩子，读 `byId[sessionId].projectionValues.agentPreset`；
  - 回退走 **旧式注入**（更早版本）：`inject(sessionId)` 收到会话 id（改名 `injectedSessionId` 避免与标准 props 冲突）+ `sessions` 服务的 `list` 快照；
  - 两条通道的读取函数同时认新旧两种摘要形状（`projectionValues.agentPreset` / 顶层 `agentPreset`）；都不可用时仍回退端点全局心跳租约。
- **`dsh.compat` 元数据**：家级插件 package.json 声明 `desktop: ">=0.3.4"`、`backend: ">=0.1.2-alpha.4"`、`verified: "DSH Desktop 0.3.5 & 0.3.14 / @deepseek-ai/dsh 0.1.2-alpha.5"`（跟随 dsh-model-status 的家级插件约定）。
- **版本适配标注**：README 中英文版版本表新增「适配 DSH」列；历史 Release 备注补标各自适配的 DSH 版本（v1.0.0 / v1.1.0 → DSH Desktop 0.3.5；v1.1.1 → 0.3.5 开发、0.3.14 实测兼容）。
- 文档：`client-entry.mjs` 头注释更新为 0.3.14 的新扫描机制说明（client-modules 现扫描所有 Loader 行，裸名行仅为旧版兼容保留）。

### 实测（DSH Desktop 0.3.14 / dsh 0.1.2-alpha.5）

- host 半：`GET /codebuddy-indicator/status` 正常返回，preset 30s 心跳租约续期（`lastModeAt` 持续刷新）。
- 客户端半：新 client-modules 花名册（combo 路由 `/plugins/??<id>/client.js&rev=<内容指纹>`）逐字节命中（sha1 复算 rev 后 HTTP 200，正文与部署文件一致）；HMR 内容指纹重建生效。
- preset 半：codebuddy-first preset 在新进程正常 apply 并心跳。
- 浏览器侧渲染需刷新页面（或等待客户端 HMR 热替换）后确认。

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
