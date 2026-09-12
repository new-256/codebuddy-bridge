# 兼容性与支持声明（COMPATIBILITY）

> 对 npm 上**全部已发布**的 `@deepseek-ai/dsh` 版本（20 个，0.0.1-rc.1 → 0.1.5-rc.2）的
> 回测结论与支持声明。数据由 `npm run compat:dsh --full`（[scripts/dsh-compat.mjs](../scripts/dsh-compat.mjs)）
> 生成；方法与证据见各节。**新 dsh 版本发布后请重跑回测并更新本文**（见
> [RELEASE-SOP.md](RELEASE-SOP.md) §3）。

## 1. 支持声明（速览）

按安装方式划分（方式编号沿用 [README](../README.md)）：

| 形态 | 支持的 dsh 版本 | 附加要求 | 说明 |
| --- | --- | --- | --- |
| **方式 A** preset（`codebuddy-first`） | **≥ 0.1.3-alpha.2** | bridge ≥ 1.1.6 | dsh-persona 自 0.1.3-alpha.2 起强制 `prefix:`/`suffix:` schema（旧 `text:` 字段被校验器拒绝挂载）。更早 dsh 请用 bridge ≤ 1.1.5（旧 persona 结构）或改用方式 C/D |
| **方式 B** 家级灯 bundle 安装（`dsh plugin --profile web add codebuddy-first-bridge`） | **≥ 0.1.2-alpha.2**（实测 10/10 PASS，截至 0.1.5-rc.2）；**加** 0.0.1-rc.5 亦 PASS | **bridge ≥ 1.1.8** | plugin CLI 自 0.0.1-rc.1 即存在（静态），但功能回测显示 0.1.2-alpha.2 是安装链路可用的起点：0.1.0-rc.\*/0.1.1-rc.\*（7 个版本）的旧 CLI 在现代 Node 下自身 ESM 解析失败，0.0.1-rc.1/rc.2 因依赖下架今日不可安装——详见 §3/§4。bridge = 1.1.7 会在**所有** dsh 版本上触发启动致命屏（见 §4） |
| **方式 C** 动态 Cordis 插件（`dynamic/`） | 与 dsh 版本无关（会话内机制） | — | 跟随宿主会话加载，不依赖 profile 体系 |
| **方式 D** MCP server（`codebuddy-mcp-server`） | 与 dsh 版本无关（零依赖独立进程） | — | 任何 MCP 客户端可用 |

**DSH Desktop 版本对应**（桌面壳会自动更新后端 dsh）：

| DSH Desktop | 内置 dsh | 备注 |
| --- | --- | --- |
| 0.3.14 | 0.1.2-alpha.5 | v1.1.2 实测机型 |
| 0.3.36 | 0.1.5-rc.1 | v1.1.7 事故机型（桌面壳安全模式）；dsh 0.1.2-rc.1 环境实测触发 crash |

## 2. 静态契约探测（20/20 全覆盖）

对每个 dsh 版本的 tarball 做字符串探针（拼接 lib 全部 JS 后按符号匹配，符号均经本地
0.1.5-rc.1 后端源码逐一定位核对）。七个契约点：

| 契约点 | 探针符号 | 含义 |
| --- | --- | --- |
| C1 plugin CLI | `command("plugin")`（bin.js） | `dsh plugin --profile <p> add <pkg>` 命令存在 |
| C2 pnpm 转发 | `pnpm`（plugin chunk） | plugin 命令以 pnpm 转发器实现 |
| C3 bundle.patch | `dsh?.bundle?.patch`（plugin chunk exportsPatch） | 读取依赖包的 bundle 补丁声明并挂载 |
| C4 bundles 对账 | `profile.bundles` | 维护 profile 层列表（装后 reconcile） |
| C5 persona schema | `prefix: z.string().required()`（dsh-persona） | 新 schema；旧版探 `text: z.string()` |
| C6 注册名校验 | `loaded without registering`（dsh-client-modules client.js） | arrive() 强制 bundle 注册同名模块（v1.1.8 事故的检查点） |
| C7 graph id 机制 | `locatePkgJson`（dsh-client-modules index.js） | graph 行 id 按包名生成（0.1.2-alpha.2 起）；此前按 Loader 行名 |

### 静态矩阵

| dsh 版本 | 发布 | C1 | C2 | C3 | C4 | C5 persona | C6 | C7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.0.1-rc.1 | 2026-08-10 | ✓ | ✓ | ✓ | ✓ | text: | ✓ | — |
| 0.0.1-rc.2 | 2026-08-11 | ✓ | ✓ | ✓ | ✓ | text: | ✓ | — |
| 0.0.1-rc.5 | 2026-08-12 | ✓ | ✓ | ✓ | ✓ | text: | ✓ | — |
| 0.1.0-rc.2 | 2026-08-13 | ✓ | ✓ | ✓ | ✓ | text: | ✓ | — |
| 0.1.0-rc.3 | 2026-08-13 | ✓ | ✓ | ✓ | ✓ | text: | ✓ | — |
| 0.1.0-rc.6 | 2026-08-13 | ✓ | ✓ | ✓ | ✓ | text: | ✓ | — |
| 0.1.0-rc.7 | 2026-08-17 | ✓ | ✓ | ✓ | ✓ | text: | ✓ | — |
| 0.1.0-rc.8 | 2026-08-19 | ✓ | ✓ | ✓ | ✓ | text: | ✓ | — |
| 0.1.1-rc.1 | 2026-08-21 | ✓ | ✓ | ✓ | ✓ | text: | ✓ | — |
| 0.1.1-rc.2 | 2026-08-21 | ✓ | ✓ | ✓ | ✓ | text: | ✓ | — |
| 0.1.2-alpha.2 | 2026-08-30 | ✓ | ✓ | ✓ | ✓ | text: | ✓ | ✓ |
| 0.1.2-alpha.3 | 2026-08-31 | ✓ | ✓ | ✓ | ✓ | text: | ✓ | ✓ |
| 0.1.2-alpha.4 | 2026-09-01 | ✓ | ✓ | ✓ | ✓ | text: | ✓ | ✓ |
| 0.1.2-alpha.5 | 2026-09-02 | ✓ | ✓ | ✓ | ✓ | text: | ✓ | ✓ |
| 0.1.2-rc.1 | 2026-09-03 | ✓ | ✓ | ✓ | ✓ | text: | ✓ | ✓ |
| 0.1.3-alpha.2 | 2026-09-07 | ✓ | ✓ | ✓ | ✓ | **prefix/suffix** | ✓ | ✓ |
| 0.1.5-alpha.1 | 2026-09-08 | ✓ | ✓ | ✓ | ✓ | prefix/suffix | ✓ | ✓ |
| 0.1.5-alpha.2 | 2026-09-09 | ✓ | ✓ | ✓ | ✓ | prefix/suffix | ✓ | ✓ |
| 0.1.5-rc.1 | 2026-09-10 | ✓ | ✓ | ✓ | ✓ | prefix/suffix | ✓ | ✓ |
| 0.1.5-rc.2 | 2026-09-10 | ✓ | ✓ | ✓ | ✓ | prefix/suffix | ✓ | ✓ |

**关键翻转点**：

- **C5 persona schema 在 0.1.3-alpha.2 翻转**（`text:` → `prefix:`+`suffix:`）——这就是
  bridge v1.1.6 迁移的根因，也是方式 A 要求 dsh ≥ 0.1.3-alpha.2 的依据。
- **C7 graph id 机制在 0.1.2-alpha.2 出现**（`locatePkgJson`/`nearestPackage`，graph 行 id
  由 Loader 行名改为行名解析出的**包名**）。对 profile 安装（行名 = 包名）两种机制等价，
  因此 1.1.8+ 的注册 id 修法（注册包名 `codebuddy-first-bridge`）在**全部版本**上成立。
- **C1–C4、C6 自 0.0.1-rc.1（首个公开发布版本）全部存在**——插件安装体系与注册名校验
  从第一天就是现在这个形态。

## 3. 沙箱安装回测（功能，逐版本）

**方法**：对每个版本——① `npm install @deepseek-ai/dsh@<V>` 装出完整运行环境
（沙箱隔离 `DSH_HOME` + `USERPROFILE`/`HOME`/`APPDATA`/`LOCALAPPDATA`，老版本即使忽略
`DSH_HOME` 也不会污染真实用户目录；pnpm 走 npmmirror，经 integrity 校验内容等价）；
② 跑 `dsh plugin --profile web add codebuddy-first-bridge@1.1.9`；③ 验证 8 项：
profile 创建 / `dependencies` 入列 / `dsh.profile.bundles` 层列表 / node_modules 内版本
= 1.1.9 / `dsh.bundle.patch` 声明 / `exports["./client"]` 存在 / client.js 注册 id ===
包名（契约核心）/ 各项布尔全过。

**结果**：见 §3.1 矩阵（`dsh-compat-result.json` 明细随交接包归档）。

### 3.1 功能回测矩阵

| dsh 版本 | 发布 | 沙箱安装 `codebuddy-first-bridge@1.1.9` | 说明 |
| --- | --- | --- | --- |
| 0.0.1-rc.5 | 2026-08-12 | ✅ PASS | 8 项检查全过（含 `clientRegId=codebuddy-first-bridge`） |
| 0.1.2-alpha.2 | 2026-08-30 | ✅ PASS | 同上 |
| 0.1.2-alpha.3 | 2026-08-31 | ✅ PASS | 同上 |
| 0.1.2-alpha.4 | 2026-09-01 | ✅ PASS | 同上 |
| 0.1.2-alpha.5 | 2026-09-02 | ✅ PASS | 同上（Desktop 0.3.14 内置） |
| 0.1.2-rc.1 | 2026-09-03 | ✅ PASS | 同上 |
| 0.1.3-alpha.2 | 2026-09-07 | ✅ PASS | 同上（persona 新 schema 起点） |
| 0.1.5-alpha.1 | 2026-09-08 | ✅ PASS | 同上 |
| 0.1.5-alpha.2 | 2026-09-09 | ✅ PASS | 同上 |
| 0.1.5-rc.1 | 2026-09-10 | ✅ PASS | 同上（Desktop 0.3.36 内置） |
| 0.1.5-rc.2 | 2026-09-10 | ✅ PASS | 同上（当前最新） |
| 0.0.1-rc.1 | 2026-08-10 | ⏭ 今日不可安装 | 依赖 `@deepseek-ai/dsh-agent-tool-mode` 已从 registry 下架（官方源与 npmmirror 均 E404） |
| 0.0.1-rc.2 | 2026-08-11 | ⏭ 今日不可安装 | 同上 |
| 0.1.0-rc.2 | 2026-08-13 | ❌ CLI 环境不兼容 | `dsh plugin add` 在旧 CLI 自身模块解析处失败（`getPackageJSONURL` ESM 错误，见下） |
| 0.1.0-rc.3 | 2026-08-13 | ❌ CLI 环境不兼容 | 同上 |
| 0.1.0-rc.6 | 2026-08-13 | ❌ CLI 环境不兼容 | 同上 |
| 0.1.0-rc.7 | 2026-08-17 | ❌ CLI 环境不兼容 | 同上 |
| 0.1.0-rc.8 | 2026-08-19 | ❌ CLI 环境不兼容 | 同上 |
| 0.1.1-rc.1 | 2026-08-21 | ❌ CLI 环境不兼容 | 同上 |
| 0.1.1-rc.2 | 2026-08-21 | ❌ CLI 环境不兼容 | 同上 |

**分界线：0.1.2-alpha.2。** 该版本起 plugin 安装链路全绿（10/10），也正是 `locatePkgJson`
（graph id = 包名，C7）出现的版本——平台在 0.1.1-rc.2 → 0.1.2-alpha.2 之间重构了客户端模块
体系。此前：

- **0.1.0-rc.\* / 0.1.1-rc.\***（7 个版本）在回测环境中 `dsh plugin add` 100% 复现同一失败：
  旧 CLI 自身的 ESM 解析报错（`getPackageJSONURL`）——失败发生在 dsh 内部代码路径，与所装
  插件无关（安装已完成、profile 已初始化）。判定为该时代 CLI 与现代 Node（v24）运行时不
  兼容；这些版本在发布后数天内即被 0.1.2-alpha.\* 取代，无现网使用面。它们的静态契约
  （§2：plugin CLI / bundle.patch / bundles 对账）**全部存在**，接口面与现代版本一致，
  仅 CLI 运行时在新环境下不可用。
- **0.0.1-rc.1 / rc.2** 无法安装（依赖包下架 E404）。

**回测口径**：每个版本在独立一次性沙箱内完成「装 dsh 运行环境 → `dsh plugin --profile web add
codebuddy-first-bridge@1.1.9` → 8 项结果验证」，无跨版本状态。全部 PASS 行实测
`clientRegId = codebuddy-first-bridge`（与包名一致），即 v1.1.8 的修复在所有可运行版本上成立。

### 3.2 已知不可安装 / 不兼容版本

**dsh 0.0.1-rc.1 / 0.0.1-rc.2**：依赖树中声明的 `@deepseek-ai/dsh-agent-tool-mode@^0.0.1-rc.1`
已在 registry 上不存在（官方源与 npmmirror 均 E404），今天任何环境下都无法全新安装这两个
dsh 版本——这是平台侧的不可逆事实，与本插件无关。0.0.1-rc.5 起不再依赖该包，可正常安装。

## 4. 事故对应关系

- **v1.1.7 启动致命屏**（2026-09-10）：client.js 注册 id 写旧内层包名，与 graph 行 id
  （包名）不匹配 → client-modules arrive 校验（C6）失败 → 整个 client combo 崩溃 →
  桌面壳安全模式。**回测证实 C6 在全部 20 个版本上都存在**——该事故不是某个 dsh 版本的
  回归，在任何版本上都会发生；1.1.8 起修复并全版本成立（见 §2 翻转点说明）。
- **v1.1.6 preset 挂载失败**：dsh-persona 0.1.3-alpha.2 schema 升级（C5 翻转点）所致。

## 5. 维护约定

- 新 dsh 版本发布 → `npm run compat:dsh --full` 回测 → 按结果更新本文矩阵与支持声明；
- **回测环境口径**：回测机为 Windows + Node v24.21.0（DSH Desktop 后端自带运行时）+ pnpm 10。
  §3.1 中「CLI 环境不兼容」的判定与 Node 版本相关——同一批老版本换 Node 20 复测可能得到
  不同结果（如需精确归因，用 `--only <版本>` 在目标 Node 下复跑）；
- 若出现新的契约点变化（探针 FAIL/异常），先在
  `%TEMP%\dsh-compat-cache\` 下解包对应版本 tarball 人工核对探针符号，再判定支持范围；
- 本文矩阵即支持声明的**唯一事实来源**，README 只做速览引用。
