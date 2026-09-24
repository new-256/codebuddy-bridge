# 更新日志

本项目遵循 [语义化版本](https://semver.org/)；版本号同步 `package.json`、Git tag 与 GitHub Release（`npm run check` 中的 `scripts/verify.mjs` 在 CI 里锁三处一致）。

## [1.3.2] - 2026-09-25

**可视化配置界面**：DSH 设置里新增「CodeBuddy 桥接」分区 —— 首选 CLI / 默认模型 / 端点覆盖 / 国际版凭据四项偏好在同一面板编辑保存，外加逐后端的生效配置诊断（登录域 → 端点 → 凭据来源）。保存即对 **preset / 动态插件 / MCP 三种形态**同时生效，无需重启。

### 为什么是自绘面板而不是官方自动表单

- 官方 `Config` 导出投影表单只覆盖 `fiber.entry.id === "include"` 的条目（`dsh-config-editor` L31）；preset 桥接行经 `PresetTree` 组合挂载、不是 include → 桥接插件的 `Config` 永远进不了表单投影（0.1.7-rc.1 源码逐行核实）。
- `ctx.configForms` 的 host 命名空间通道依赖未在本 build 安装的 owner 包与 `WEB_SETTINGS_NAMESPACES` 白名单，且写入 `profiles\web\cordis.patch.yml` —— 对 preset/dynamic/MCP 三个进程不可见。
- 结论：**自绘分区 + 自家读写路由** 是唯一能让一次保存抵达全部三种形态的路径。表单消费面（settings.section 列表槽、label thunk、locale 读时解析）与 dsh-dream-skin / dsh-mobile-companion 完全同构。

### 机制（单一事实源：`<dsh-home>/codebuddy-bridge-settings.json`）

- **core 新增设置文件原语**（三形态与 host 共用）：`SETTINGS_FILE_NAME` / `SETTINGS_KEYS` / `bridgeSettingsPath()`（`CODEBUDDY_SETTINGS_FILE` 可整体覆盖，测试注入）/ `normalizeBridgeSettings()` / `readBridgeSettingsFile()`（**文件缺失返回 `null`**，与「文件说默认值」可区分）/ `sanitizeBridgeSettings()` / `writeBridgeSettingsFile()`（tmp+rename 原子写，失败清理）。另新增 `BACKEND_MODEL_IDS` / `BACKEND_LABELS` / `backendSettingsMeta()` / `allBackendSettingsMeta()` / `diagnoseBackend()` / `readBackendAuthDomain()`（不占用 `readAuthDomain` 之名：core 以文本注入 dynamic 模板作用域，重名函数声明会静默互相覆盖）。
- **host 半（codebuddy-indicator）**：新增 `GET/POST /codebuddy-indicator/settings`（webServer 精确路由，handler 内自分发方法；body ≤64KB）。GET 返回视图 = 当前值 + 三后端元数据 + 诊断 + **掩码 token（尾 4 位，明文永不回传浏览器）**；POST 只认四个已知字段全清洗，token 语义：缺省/空串 = 保持现值、`codebuddyEnTokenClear:true` 显式清除。纯函数面（`maskToken`/`settingsView`/`parseSettingsBody`）可脱离 DSH 单测。
- **浏览器半（client.js）**：注册 `settings.section` 分区（id `codebuddy-bridge-settings`、order 7、label thunk 中英双语）。面板含后端下拉（联动该后端实测模型候选 datalist）、默认模型、端点覆盖、token（password 输入 + 清除勾选）、保存/重载反馈与诊断表（每后端：生效端点+来源、登录域、凭据来源、可能 401 警示）。
- **三形态热生效**：preset 桥接与 dynamic 模板的 runner getters 每次调用现读设置文件（文件 > 行 config > 默认——旧 patch 遗留行 config 不再吞掉面板保存）；dynamic 模板删掉本地 `readBridgeSettings()` 副本改用 core；MCP 用 core 的 `readBridgeSettingsFile` 替换本地清洗（5s 缓存与 bin 父目录回退保留）。
- **deploy.mjs 新增第 5 步**：把 `core/` 与 `mcp/` 同步复制到 `<dsh-home>/core` + `<dsh-home>/bin`（家级 patch 的 mcp-codebuddy-global 指向 bin 副本，v1.3.1 时它漂移在 1.3.0 无人察觉）。

### 测试与治理

- 新增 `test/settings-ui.test.mjs` 14 例：core 原语（缺失/往返/原子性/损坏/清洗/写失败清理）、host 纯函数与 GET/POST 端到端（含 token 保持/清除、400/405、掩码无泄漏）、preset 热生效三连（保存即切后端、文件优先于行 config、无文件回退行 config）、client 假 react 烟测（注册形状 + 加载 id 回归锁 + 首帧不触网）。
- `verify.mjs` 新增 6 道闸门：indicator package.json 版本同步（本次即抓到 1.3.0 漂移）、settings.section 注册、路由注册、core 原语存在、dynamic 无本地重复实现。`mcp.test.mjs` 的 serverInfo 版本断言改为对照源码而非钉死字面量。
- 版本号本次起 **四处齐步**：根 package.json / indicator package.json / MCP `VERSION` / CHANGELOG 顶部，全部 1.3.2。

## [1.3.1] - 2026-09-24

**端点与凭据根因修复**：v1.3.0 关于国际版的机制结论（「国际版没有独立安装包，就是同一个 npm CLI + 端点 env」）经真机全盘核实**已被推翻**；本版据实测矩阵重写端点解析，并修复了一个影响**默认后端**的既存缺陷。

### 推翻 v1.3.0 的错误结论（真机证据）

- **三个产品面各有独立安装包与独立 `product.json`**，不是同一个 CLI：

  | 后端 | 二进制 | productName | product 端点 | authentication.id |
  |---|---|---|---|---|
  | `codebuddy` | `%APPDATA%\npm\node_modules\@tencent-ai\codebuddy-code` | CodeBuddy | `www.codebuddy.ai` | `Tencent-Cloud.coding-copilot` |
  | `codebuddy-en` | `C:\Program Files\WorkBuddyAI\...\cli\bin\codebuddy` | WorkBuddy AI | `www.workbuddy.ai` | `workbuddy-desktop-ai` |
  | `workbuddy` | `C:\Program Files\WorkBuddy\...\cli\bin\codebuddy` | WorkBuddy | `copilot.tencent.com` | `workbuddy-desktop` |

  （`C:\Users\lcl\AppData\Local\Programs\CodeBuddy` 即 CodeBuddy IDE **不附带** headless CLI，`resources/app.asar.unpacked/cli` 不存在，不可作二进制来源。）
- **`CODEBUDDY_AUTH_TOKEN` 本身不决定端点**：token 只在其登录域对应的端点上生效。实测：国内 token（域 `www.codebuddy.cn`）配 `workbuddy.ai/v2` → 401；配 `copilot.tencent.com/v2` → PONG。
- **`CODEBUDDY_INTERNET_ENVIROMENT=cloudhosted` 语义错误已删**：`www.workbuddy.ai` 属 `product.json` 的 `externalDomain`，不是 `cloudHostedDomain`。

### 修复：默认后端 codebuddy 的 401（既存缺陷）

npm CLI 的 product 端点是 `www.codebuddy.ai`，而本机登录 token 的域是 `www.codebuddy.cn` —— **域不匹配必然 401**。这正是用户会话日志中 312 次 `www.codebuddy.ai` 与 116 次 `Authentication required` 的根因：默认后端此前是坏的。实测注入 `CODEBUDDY_BASE_URL=https://www.codebuddy.cn/v2` 即恢复 PONG。

### 新机制：端点按登录域自动对齐

- 新增纯函数 `resolveEndpoint()` / `endpointEnv()` / `endpointMismatchHint()` / `endpointHost()` 与注册表 `BACKEND_ENDPOINTS` / `AUTH_DOMAIN_ENDPOINTS` / `BACKEND_AUTH_IDS`（取代 `intlEndpointEnv`）。
- 宿主侧读 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\<authentication.id>.info` 的 **`auth.domain`（三个文件均为明文）**，无需解密 token 即可对齐端点；读取失败一律回退为「沿用 CLI 自身 product 端点」。
- **仅当推导端点与后端 product 端点不同时才注入** `CODEBUDDY_BASE_URL`，避免无谓覆盖。

### `codebuddy-en` 凭据通道（三通道 + 自动复用）

国际版自己的 token 被 protector key（keyId `9127dea1b44020a7`）封装，该密钥**只经桌面 App 的 sidecar 通道下发、不落盘**——全盘 51612 个文件扫描、全部 DPAPI blob 解包尝试均未命中，且 CLI 自身亦以 `category:"missing-key"` 失败 21 次（`at-rest-failures-v1.json`），证明这不是探针假象。**但用户通常已经在 DSH 里配好了同一个 token**：DSH 的 provider 配置里有一个指向 `https://www.workbuddy.ai/v2` 的 workbuddy provider（`apiKeyEnv: WORKBUDDY_TOKEN`），其值就存在 `dsh-home` 的 `.credentials.yaml` / `.env` 里。真机实测：把该 token 经 `CODEBUDDY_AUTH_TOKEN` 下发给 WorkBuddyAI 自带 CLI，**无 BASE_URL 即返回 PONG**。故：

- 新增 `resolveEnToken()` / `readDshWorkbuddyToken()`：凭据按 **设置面板 `codebuddyEnToken` → 环境变量 `CODEBUDDY_AUTH_TOKEN` → DSH 凭据库** 依次取用，使 `codebuddy-en` **开箱即用**（无需用户手工粘贴）。凭据库解析只接受真实 token（≥40 字符、非 `$VAR` 引用、非 `<占位符>`），文件读取失败一律回退。
- 新增设置项 **`codebuddyEnToken`**；新增 **`endpointOverride`** 取代 `codebuddyEnBaseUrl`（后者默认值错误，已移除）。
- 三通道皆空时 `codebuddy-en` 前置返回 `AUTH_REQUIRED` 并附**可操作指引**（列出三条通道，而非让 CLI 报一句无从下手的 `Authentication required`）；`isLimited` 将该状态排除出限流类，`failureHint` 透传指引。
- `codebuddy-en` 的二进制改指 WorkBuddyAI 自带 CLI（`CODEBUDDY_EN_BIN` 可覆盖），不再复用 npm CLI。
- 新增 `CODEBUDDY_CREDENTIALS_DIR` 覆盖 + `isolateHostState()` 测试助手：桥接会读 auth 库/凭据库/`DSH_HOME` 三类真机状态，不隔离则用例会随「本机是否登录、是否配过 workbuddy key」变化而不可复现。

### 测试与文档

- 测试改写：`intlEndpointEnv` 4 例断言（含已删除的 `INTERNET_ENVIROMENT`）→ 新增 `resolveEndpoint`/`endpointEnv`/`endpointMismatchHint`/`AUTH_REQUIRED` 归类共 5 例；`dynamic-sim`/`preset`/`mcp` 中依赖旧设置键与旧 env 的用例同步更新。
- 新增 [docs/ROOT-CAUSE-codebuddy-en.md](ROOT-CAUSE-codebuddy-en.md)：完整实测矩阵（11 组后端 × 端点 × token 组合）与根因链。

## [1.3.0] - 2026-09-24

> **勘误（v1.3.1 更正）**：本版对国际版机制的结论「国际版没有独立 npm 包，就是同一个
> `@tencent-ai/codebuddy-code` CLI + 端点切换」**已被真机 `product.json` 推翻** —— 三个产品面
> 各有独立安装包（`productName` / `dataFolderName` / `endpoint` / `auth.id` 全不同），且
> `CODEBUDDY_INTERNET_ENVIROMENT=cloudhosted` 语义错误、`codebuddyEnBaseUrl` 默认值对默认后端有害。
> 详见 [1.3.1] 与 [ROOT-CAUSE-codebuddy-en.md](ROOT-CAUSE-codebuddy-en.md)。

**CodeBuddy 国际版接入 + 插件设置**：后端列表新增第三个条目 `codebuddy-en`（国际版 CodeBuddy / WorkBuddy 国际面），并在 DSH 设置面板提供「优先 CLI + 默认模型」两项用户偏好。

### 国际版后端（codebuddy-en）

- 新增 `codebuddy-en` 后端：国际版 CodeBuddy（`workbuddy.ai` 端点）。国际版**没有独立 npm 包**（已核实 npm 全量扫描与 CLI dist 内部常量）——它就是同一个 `@tencent-ai/codebuddy-code` CLI + 端点切换：CLI 官方支持 `CODEBUDDY_BASE_URL` 覆盖端点（`resolveModelBaseURL` 直接采用该值；CLI 自带 401 故障指引原文引用该变量），`CODEBUDDY_INTERNET_ENVIROMENT=cloudhosted`（官方拼写）声明云端企业环境。桥接在每次 `codebuddy-en` 调用的 spawn 上注入这两个变量（DSH subprocess 的 `spec.env` / MCP 的 spawn env），国内后端零注入。
- 端点机制核实（CLI dist 反编译）：`isInternationalEndpoint` 按 hostname 判定国际端点（`codebuddy.ai` / `workbuddy.ai` / `staging-codebuddy.tencent.com`）；`CODEBUDDY_BASE_URL` 需带 `/v2`（env 值按原样使用，只有 product 端点才会补 `/v2`）——默认值 `https://www.workbuddy.ai/v2` 与本机 profile patch 里 WorkBuddy 供应商行一致（已在用）。
- `coreExecute`/MCP 的后端路由重写为统一 `resolveBackend()`：显式 `backend` > 会话归属（登录域互斥）> 用户偏好 > 默认 `codebuddy`；白名单从硬编码双值改为 `BACKENDS` 注册表。工具 schema（preset/dynamic/MCP 三形态六处）与策略提示（POLICY_TEXT）同步扩为三后端，模型清单按产品面分列（国内 `hy4-preview`/`hy3`/`glm-5.3`…；国际 `auto`/`glm-5.1`/`kimi-k2.5`…——两列表来自两个已装 CLI 的 `--help` 实测）。

### 插件设置（优先 CLI + 默认模型）

- **新 DSH（≥0.1.7-alpha.1）设置面板**：preset 桥接行导出 `Config`（schemastery 同构鸭子 schema——preset 沙箱无法 import schemastery，鸭子形态是零依赖唯一路径；`toJSON()` 产出官方 refs JSON，可被官方 `z()` 原样重建，SettingsForms 投影契约逐函数核实）。三个字段全部标 `volatile`（热编辑无需重载）：`preferredBackend`（枚举三后端）、`defaultModel`（留空 = CLI 默认）、`codebuddyEnBaseUrl`（默认 `https://www.workbuddy.ai/v2`）。
- **旧 DSH（≤0.1.6，provider/document settings）兼容**：`apply()` 里对 `ctx.settings` 鸭子探测（有 `register()` 才注册 `codebuddy-bridge` namespace + `watch` 热同步）；服务缺失时静默降级为「profile patch 行 config 手改」。
- **MCP/动态形态**：共享同一份 dsh-home 根的 `codebuddy-bridge-settings.json`（MCP 5s 缓存重读；动态形态经 `DSH_HOME` 定位 apply 时读一次），三种形态的用户偏好一致生效。

### 测试与文档

- 新增 15 例（含真机 401 归类回归 1 例）：core（BACKENDS/resolveBackend/intlEndpointEnv/buildArgv defaultModel+env/isLimited 401 收窄）×5、preset（鸭子 Config cordis 契约/SettingsForms 投影契约含官方 z() 重建对拍/三读数生效/非法回落/旧 settings 通道/静默降级）×6、dynamic-sim（codebuddy-en env 注入/偏好 defaultModel 注入与显式覆盖）×2（+2 改造）、mcp e2e（设置文件偏好 + en 路由 + 偏好模型端到端）×1；`fake-codebuddy.mjs` 夹具回报 `--model`（modelUsage 通道）。
- **真机验证**：`codebuddy-en` 实调（真实 CLI + env 注入）——CLI 错误原文确认请求确实被路由到 `https://www.workbuddy.ai`（env 注入链路生效），401 为国际域未登录（国际/国内登录互斥，属预期行为而非缺陷）；据此把 401 认证失败从 `isLimited` 限流类中**收窄排除**（否则会误弹「回退/重试」三选一，而这两者对认证失败都无效），`failureHint` 新增认证类可行动指引（换登录域）。
- `npm run check` 全绿：verify 闸门 + **100** 例测试全过；版本五处同步 1.3.0。

## [1.2.0] - 2026-09-19

**Form-A 修复**：新 DSH（`@deepseek-ai/dsh` ≥ 0.1.7-alpha.1）上 preset 交付形态（A 形态）静默失效——本版恢复全版本可用，交付形态不变（安装方式/命令零改动）。

### 根因

- DSH 0.1.7-alpha.1 起 preset 从**目录制**（读取 `$DSH_HOME/.agent-presets/<id>/` 的 `preset.yml` + `agent.cordis.yml`）切换为**声明制**：preset 必须由插件在运行时向 `agentPresets` 注册表登记（官方四个 preset 即 dsh-web-app bundle patch 里的 `@deepseek-ai/dsh-agent-preset` 声明行）。旧目录在新 DSH 上**永远不会被读取**——装上即失效，无任何报错。机制边界：目录制 ≤ 0.1.6-alpha.2，声明制 ≥ 0.1.7-alpha.1。

### 修复方案（indicator 自注册声明）

- 新增 `home-plugin/codebuddy-indicator/lib/preset-definition.mjs`：codebuddy-first preset 的声明定义（官方 standard preset 全量移植 + 桥接行）。`plugins` 行序/id/config 与官方 `standard.patch.yml`（0.1.7-rc.1）逐项对齐，仅两处必要差异：末尾追加 `codebuddy-first-bridge` 桥接行（本插件全部增量）；YAML `!!js` 表达式改写为等价 `{ __jsExpr: "…" }` 字面量（loader `interpolate` 一视同仁）。
- **注册通道 = indicator 自注册**：indicator `apply()` 里 `ctx.inject(['agentPresets'], …)` 等注册表服务出现后调用 `register(definition)`，返回的注销 disposer 登记为 effect（插件卸载/重载时先注销再重注册）。选此通道而非新增声明行的根因：`@deepseek-ai/dsh-agent-preset` 包 0.1.7-alpha.1 才存在，旧 DSH 的 loader（1.0.3）对导入失败**致命**（单声明行失败会炸掉整棵 profile 树）；而 indicator 在全部 26 个已发布 dsh 版本上可加载。旧 DSH 上 `agentPresets` 服务永不出现，注入器按 cordis 语义保持挂起（等待≠失败，loader 不收集等待中的注入器），零副作用。
- **桥接行 name 用裸说明符子路径** `codebuddy-first-bridge/preset-bridge`（package.json `exports` 新增该子路径）：注册表挂载 preset 插件时以**注册表自身的 baseUrl**（dsh-web-app 包目录）解析相对名，任何相对路径必然指错；裸说明符走 profile 包图路由，与官方行 `@deepseek-ai/dsh-tool-subagent-control/list-agents` 同机制。
- 失败隔离：`register()` 抛错（如重复 id）仅 `logger.warn`，绝不向宿主树抛出；等待器挂起不参与 loader 的 await 集，不拖慢启动。

### 兼容矩阵

- `scripts/dsh-compat.mjs`：新增 **C8 声明制 preset 探针**（agent-preset-registry 包存在性 + register API + 声明插件包），矩阵新增「声明制 preset」列；`PROBE_VER` → 1.2.0。
- `docs/COMPATIBILITY.md`：矩阵 22 → 26 版本（新增 `0.1.5-rc.3` / `0.1.7-alpha.1` / `0.1.7-alpha.2` / `0.1.7-rc.1`），Form-A 交付形态拆分为两段声明（目录制 ≤ 0.1.6-alpha.2 / 声明制 ≥ 0.1.7-alpha.1）。

### 测试

- 新增 `test/preset-declaration.test.mjs`（11 例）：定义骨架 / 裸说明符（禁相对与 file:）/ `__jsExpr` 求值语义对拍 / 官方行移植完整性 / **与已装官方 standard.patch.yml 逐行 drift 比对** / 等待器新 DSH 形态（注册 + 注销）/ 旧 DSH 形态（挂起零副作用）/ 注册失败隔离 / 官方 shape 校验等价。
- `npm run check` 全绿：版本五处同步（package.json / MCP VERSION / CHANGELOG 顶部 / `test/mcp.test.mjs` 断言 / indicator package.json）+ verify 闸门（新增 9 项声明结构检查）+ 85 例测试全过。

## [1.1.12] - 2026-09-18

工程化修补：修复 `dsh-compat.mjs` 功能回测基线的两处真实缺陷，并把兼容矩阵从 20 个 dsh 版本扩展到 22 个（新增 `0.1.6-alpha.1` / `0.1.6-alpha.2`）。不涉及插件运行时行为。

### 修复

- **移除 `--legacy-peer-deps`**（`scripts/dsh-compat.mjs`）：`@deepseek-ai/dsh-app-boot` 自 0.1.5-rc.2 起把 `@deepseek-ai/cordis-plugin-group` 等声明为**运行时必需的 peerDependencies**；`--legacy-peer-deps` 让 npm 跳过 peer 安装却仍返回成功（exit 0）——于是「第一顺位成功」后兜底不再执行，沙箱得到一个缺 peer、无法 boot 的 dsh 环境，实测 22 个版本全部在 `dsh-app-boot` 导入处 `ERR_MODULE_NOT_FOUND`（与所装插件无关）。
- **加 `--before=<发布时间>` 时间锚定**：dsh 内部组件互相以 `^0.1.x-rc.y` caret 范围引用；0.1.6-alpha.1/.2（2026-09-15/17 发布）出现后，安装任何历史 dsh 版本都会解析进 0.1.6-alpha.x 组件形成**混合树**，回测结果随上游发版漂移、不可复现。`--before` 让 npm 只取该版本发布时间点及以前存在的版本（另 +1 天缓冲防边界排除），树的构成与发布时代一致。
- **`PROBE_VER` 1.1.9 → 1.1.11**：功能回测安装的探测包版本对齐当前已发布版本。

### 兼容声明更新

- `docs/COMPATIBILITY.md`：20 → 22 版本，新增 `0.1.6-alpha.1`（2026-09-15）/ `0.1.6-alpha.2`（2026-09-17）两行，矩阵与分档按修复后的基线重跑。
- **更正 v1.1.10 的「CLI 环境不兼容」结论**：重跑后 `0.1.0-rc.*` / `0.1.1-rc.*` 旧版本**全部通过**，最终汇总 **PASS 17 / 功能失败 0 / 不可安装 2（E404 平台事实）/ 待重跑 3（瞬时网络超时）**。原「旧 CLI 与现代 Node ESM 不兼容」的归因随撤回（见 COMPATIBILITY §3.3）。

### 测试

- `npm run check` 全绿：版本四处同步（package.json / MCP VERSION / CHANGELOG 顶部 / `test/mcp.test.mjs` 断言，另同步 `home-plugin/codebuddy-indicator/package.json`）+ verify 闸门 + 74 例测试全过。

## [1.1.11] - 2026-09-18

工程化修补：两个发布/回测工具的**观测准确性**修复——审计刚发布的版本不再被 npm 本地缓存遮蔽，回测汇总不再把「功能失败」并入「未回测」。两者都是 v1.1.10 引入脚本后的实测反馈修，不涉及插件运行时行为。

### 修复

- **`scripts/audit-npm-sync.mjs`：版本列表加 `--prefer-online`**。`npm view <pkg> versions` 会命中 npm 本地元数据缓存，导致**刚 `npm publish` 完立刻审计仍只看到旧版本列表**（实测），审计看上去「少了最新版」；CI 里同样是新 tag 刚推、需要最新元数据。加 `--prefer-online` 强制回源取版本清单（仅版本列表回源，tarball 传输层不动，镜像兜底与 shasum 校验照旧）。
- **`scripts/dsh-compat.mjs`：回测汇总单列「功能失败」**。此前汇总按 `pass / skip / pending` 分档，`functional.ok === false` 的**真实功能失败**被算进 `untested`，与「根本没跑过」混为一谈——20 版本回测中 7 个「CLI 环境不兼容」的失败行口径不准确。现在 `untested = 总数 − pass − failed − skip − pending`，并把 `功能失败 ${failed}` 打进汇总行（与 `docs/COMPATIBILITY.md` §3.1 的「不可安装 / CLI 环境不兼容」分档对齐）。

### 测试

- `npm run check` 全绿：版本四处同步（package.json / MCP VERSION / CHANGELOG 顶部 / `test/mcp.test.mjs` 断言，另同步 `home-plugin/codebuddy-indicator/package.json`）+ verify 闸门 + 74 例测试全过。

## [1.1.10] - 2026-09-10

工程化：npm↔git 双侧一致性审计 + dsh 全版本回测 + 支持声明 + 交接文档体系。

### 新增

- **`scripts/audit-npm-sync.mjs`（npm run audit:npm）**：对 npm 上每个已发布版本做逐文件 sha256 比对（tarball vs `git -c core.autocrlf=false archive` 的 tag 树，取原始提交字节防 autocrlf 假阳性），校验 tag 存在性与 tarball 内 name/version 规格。分级输出 IDENTICAL / EOL-ONLY（仅行尾差异，通过但显著标注）/ DRIFT（exit 1）。传输层经 npm CLI（自动重试 + 官方元数据 dist.shasum 校验 + npmmirror 镜像兜底），规避国内直连官方 CDN 的间歇性 ECONNRESET 与 Node fetch 流截断（terminated）。**审计结论：1.1.6–1.1.9 全部版本内容零漂移**，唯一差异为 `docs/ARCHITECTURE.md` 行尾（历史工作区 CRLF 产物，见下）。
- **`scripts/dsh-compat.mjs`（npm run compat:dsh）**：dsh 全版本兼容性回测。Phase 1 静态探测全部 20 个已发布 `@deepseek-ai/dsh` 版本的 7 个契约点（plugin CLI / pnpm 转发 / `dsh.bundle.patch` 读取 / `dsh.profile.bundles` 对账 / persona schema / client-modules arrive 注册名校验 / `locatePkgJson` graph id 机制）；Phase 2（`--full`）对每个版本做沙箱真实安装回测（隔离 USERPROFILE/APPDATA/LOCALAPPDATA 的 DSH_HOME 沙箱内跑 `dsh plugin --profile web add codebuddy-first-bridge@1.1.9`，验证依赖入列、bundles 层挂载、client 注册 id 契约）。
- **`docs/COMPATIBILITY.md` 支持声明**：20 版本回测矩阵 + 兼容结论（preset 要求 dsh ≥ 0.1.3-alpha.2；家级灯 bundle 安装全版本支持；1.1.7 类 id 失配在全版本都会崩，1.1.8+ 全版本成立）。
- **`docs/RELEASE-SOP.md`**：npm/GitHub 提交与维护 SOP（发布流程、npm 认证坑、网络坑、历史坑档案）。
- **`docs/HANDOVER.md`**：交接文档（项目坐标、架构速览、事故档案、未决事项、新会话上手清单）。
- CI 新增 **npm↔git sync audit job**（fetch-depth: 0 拉全量 tag，每次 push 自动审计双侧一致性）。

### 修复

- **CRLF 行尾归一化**：`docs/ARCHITECTURE.md`、`assets/indicator-states.svg`、`test/core.test.mjs`、`test/indicator.test.mjs` 四个工作区文件由 CRLF 归一为 LF，并新增 `.gitattributes`（`* text=auto eol=lf`）。根因：npm tarball 打包自工作区字节而 git blob 存 LF，工作区 CRLF 文件会造成 tarball 与 tag 树的行尾漂移（1.1.6–1.1.9 的 ARCHITECTURE.md 属此类；1.1.10 起工作区已归一，未来 tarball 与 tag 字节级一致）。

### 版本一致性基线

- npm 已发布版本：1.1.6 / 1.1.7 / 1.1.8 / 1.1.9，全部有对应 tag（v1.0.0–v1.1.9 共 11 个）与 GitHub Release；audit 全过（EOL-ONLY 4 项已解释归档）。

## [1.1.9] - 2026-09-11

加固：发布闸门补上 **client 注册 id 必须等于包名** 的静态检查，杜绝 v1.1.7→v1.1.8 同类事故复发。

### 背景（2026-09-10 事故）

v1.1.7 把家级灯并入主包后，`client.js` 的 `__ModuleLoader__.load({ id })` 仍写旧独立包名 `codebuddy-indicator`，与 graph row 以包名注册的 id `codebuddy-first-bridge` 不匹配 → client-modules 校验 `loaded without registering "codebuddy-first-bridge"` 失败 → 整个 client combo 崩溃 → DSH 启动致命屏（v1.1.8 热修）。根因除 id 写错外，**发布闸门漏检**：`verify.mjs` 不校验 client 注册 id，且 `prepack` 不跑测试（热修时 test 版本断言漂移也漏过）。

### 改动

- `scripts/verify.mjs` 新增 4 条护栏：主包必须声明 `exports["./client"]`；client 文件必须含 `__ModuleLoader__.load(` 调用；必须能从 load 块提取 `id:`；**提取的 id 必须严格等于 `package.json` 的 `name`**（剥除 `//` 注释后匹配，避免注释里的 id 字样干扰）。
- `prepack` 由 `verify + build --check` 加强为 `verify + npm test`：发布前强制跑完整测试套件，版本断言漂移等问题不再可能漏到 npm。
- 三处版本号同步 1.1.9（package.json / MCP VERSION / CHANGELOG；test 断言、home-plugin 子包版本一并同步）。

### 测试

- `npm run check` 全绿：版本三处同步 + persona 护栏 + 标准分发护栏 + **client id 护栏** + 全部 74 例测试通过。

## [1.1.8] - 2026-09-10

修复：client 半 `__ModuleLoader__.load` 注册 id 与包名不匹配导致 DSH 启动致命屏。

### 根因

client-modules 的 graph row 以【包名】（`codebuddy-first-bridge`）为 id；bundle 脚本执行后按
`loaded without registering "<packageName>"` 校验注册名。v1.1.7 起包内 client.js 仍写
`id: "codebuddy-indicator"`（旧独立包名），包并入主包后两者不匹配 → 整个 client combo
加载失败 → `Failed to load plugins`（2026-09-10 18:08 事故，桌面壳被迫进入安全模式）。

### 改动

- `home-plugin/codebuddy-indicator/lib/client.js`：注册 id 改为 `codebuddy-first-bridge`（与包名一致；slot id `codebuddy-indicator-home` 与 CSS 标记属另一命名空间，无需改）。
- 对照组：`agy-indicator`（独立 npm 包）包名 = 注册名，无此问题；`agy-first-bridge` v1.6.0 的 home-plugin 形态存在同样隐患（包名 ≠ 注册名），其安装为 bundle 时将复现同类错误——建议下个版本同步修正。

## [1.1.7] - 2026-09-08

适配：家级状态灯 `codebuddy-indicator` 从旧式本地 `file://` 注册改为**标准 npm 分发形态**（对齐 agy-first-bridge v1.6.0）。

### 改动

- **主包 package.json 补全标准分发字段**：`main` 直指 `./home-plugin/codebuddy-indicator/lib/index.mjs`（host 半真入口，不再是 client-entry 占位）、`exports`（`.` → index.mjs、`./client` → client.js）、`dsh.client.platform: web`（client 半自动纳入浏览器花名册）、`dsh.bundle.patch`（安装后自动挂载家级灯 bundle 补丁层）、`bin`（`codebuddy-mcp-server`）、`repository`/`homepage`/`bugs`。
- **新增 bundle 补丁层** `home-plugin/codebuddy-indicator/cordis.patch.yml`：裸包名 `name: codebuddy-first-bridge` 一行加载，不再有 `file://` 行、不再有 client-entry 占位 → 单实例，消除双实例二次注册崩溃风险（历史原因见 client-entry.mjs 留档注释）。
- **本机注册同步**：dsh-home 用户层 `cordis.patch.yml` 的 codebuddy-indicator 行由 `file:///...?v=6` 改为裸包名 `name: codebuddy-indicator`（经 junction 解析到 lib/index.mjs）。
- **防回归护栏**：`scripts/verify.mjs` 新增 6 条检查——主包 main 指向 indicator index.mjs、dsh.bundle.patch 声明、exports ./client、indicator 包 main 无占位、bundle 补丁层存在且含 insert。

### 安装方式（跨设备）

```
dsh plugin --profile web add codebuddy-first-bridge
```

### 测试

- `npm run check` 全绿：版本三处同步（package.json / MCP VERSION / CHANGELOG 顶部）+ persona 结构护栏 + 标准分发护栏 + 全部 73 例测试通过。

## [1.1.6] - 2026-09-08

适配：DSH 后端自动更新至 **0.1.3-alpha.2**（`@deepseek-ai/dsh-persona` 0.1.3-alpha.2 / Schemastery 3.18.2）的配置校验升级。

### 背景（实际报错）

DSH 后端自动更新后，官方插件 `@deepseek-ai/dsh-persona` 将配置 schema 由旧版 `text:` 字段强制升级为：

```
prefix: z.string().required()
suffix: z.string().default("")
```

Schemastery 校验器直接拒绝旧结构挂载，恢复会话时抛出：

```
invalid config: - $.prefix missing required value
```

自定义预设（`codebuddy-first`、`cordis-agy`）因仍使用旧版 `text:` 字段全部被拒。

### 修复

- **persona 配置结构迁移**：`preset/codebuddy-first/agent.cordis.yml` 的 persona 行改为新版 `prefix:` + `suffix:` 拆分，与官方 standard preset 写法完全一致：`prefix` 渲染为 `deployment:persona-prefix` 段落（必填），`suffix` 渲染为 `deployment:persona-suffix`（此处给 `Your working directory is {{cwd}}.`）；两者都是 `{{…}}` 模板，渲染时严格解析。
- **防回归护栏**：`scripts/verify.mjs` 新增三条检查——persona 行必须使用 `prefix:`（0.1.3-alpha.2 起必填）、必须声明 `suffix:`、**禁止出现旧 `text:` 字段**（否则 `npm run check` / CI 直接失败）。全局目录（dsh-home）的迁移由部署侧完成并已核对无残留旧字段。
- **npm 发布能力**：去掉 `"private": true`，`files` 白名单补齐 `README*` 与 `LICENSE`，新增 `prepack` 钩子（发布前强制跑 verify + build 校验，保证发布内容与仓库一致且通过全部校验）。包名 `codebuddy-first-bridge` 在 npm registry 未被占用。

### 测试

- `npm run check` 全绿：版本三处同步（package.json / MCP VERSION / CHANGELOG 顶部）+ 新增 persona 结构护栏 + 全部 73 例测试通过。

## [1.1.5] - 2026-09-04

修复：① 状态灯在标准模式下**整个调用过程完全不出现**；② 状态输出里混入希腊字母 `Σ`。

### 修复

- **① 状态灯对标准模式完全失明（架构缺口）**：标准（非 codebuddy-first）模式下 codebuddy 经**全局 MCP 行**调用，而 MCP 服务器是**独立子进程** —— 它既没有 `ctx.emit`，也拿不到家级插件 `ctx.provide` 的 `codebuddyCollector` 服务，`createStatusEngine(null)` 更是直接把 publish 关掉了。结果家级插件从来收不到 MCP 路径的任何运行数据，标题栏状态灯在整个调用过程中不出现。
  修复：新增 **文件通道**。MCP 每次状态变化把快照**原子写入**（临时文件 + rename，避免读到半截 JSON）`<dsh-home>/codebuddy-indicator-mcp.json`，家级插件在响应 `/codebuddy-indicator/status` 时读取合并。两端都只从自身模块位置推导 dsh-home，**不需要端口**。
  为什么不用 HTTP 反推：`webServer.register` 不暴露端口（客户端能工作是因为同源相对 URL），子进程无从发现；且端口实测会变（49301 → 58199）。
- **② 活动明细永远为空（静默失败）**：修好通道后发现 `current`/`trail` 仍全空。根因是 `child.stdout` **未声明编码** —— `'data'` 事件派发的是 `Buffer`，而 `createLineStream.pushChunk` 只接受字符串（非字符串静默 `return`），于是 `engine.foldEvent` 从不触发。这个失败完全无声：`result` 事件是从累积的 `out` 字符串解析的，所以 tokens、session、状态全都正常，只有实时明细缺失。
  修复：`child.stdout.setEncoding('utf8')`（stderr 同样处理）。用 `setEncoding` 而非 `String(d)`：后者会在多字节 UTF-8 字符跨 chunk 边界时产生乱码，`setEncoding` 由 Node 的 `StringDecoder` 正确处理半个字符。
- **过期保护**：快照带 `updatedAt` 与 `pid`；超过 90s 未更新且仍标记 running 的项目按「进程已死」降级（子进程可能被强杀而来不及写收尾快照），否则灯会永久转圈。读取端还按文件 mtime 去重，避免重复合并把过期数据一直刷新成「很新」而绕过过期判定。
- **③ 状态输出改为纯 ASCII**：`renderStatus` 此前用希腊字母 `Σ`（U+03A3）当合计记号，输出形如 `codebuddy status: failed | Σ 1 runs · 25268 tokens` —— 在中英文语境里都是异类字符。改为 `total 1 runs, 15 tokens`。（`·`、`×` 等中文排版合法符号保留。）

### 实测（DSH Desktop 0.3.14 / 真实 MCP 路径）

- 修复前：整段调用期间端点恒为 `projects: []`。
- 修复后：`state=running` 全程可见，活动明细逐步推进 —— 端点实测到 `cur=Bash#6`、`typing#0`，trail 由 1 增至 12，结束后转 `ok`。

### 测试

- 测试 68→73 例：快照载荷收窄与 JSON 无损往返、过期快照的 running 降级（含已结束项目不受影响、无 `cwd` 条目丢弃）、`createLineStream` 对非字符串 chunk 的丢弃契约与半行拼接、MCP 源码断言 `child.stdout.setEncoding('utf8')` 必须存在（静默失败模式，用源码契约钉住防回归）、状态输出不含希腊字母。

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
