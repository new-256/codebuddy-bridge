# 更新日志

本项目遵循 [语义化版本](https://semver.org/)；版本号同步 `package.json`、Git tag 与 GitHub Release（`npm run check` 中的 `scripts/verify.mjs` 在 CI 里锁三处一致）。

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
