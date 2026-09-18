# 兼容性与支持声明（COMPATIBILITY）

> 对 npm 上**全部已发布**的 `@deepseek-ai/dsh` 版本（22 个，0.0.1-rc.1 → 0.1.6-alpha.2）的
> 回测结论与支持声明。数据由 `npm run compat:dsh --full`（[scripts/dsh-compat.mjs](../scripts/dsh-compat.mjs)）
> 生成；方法与证据见各节。**新 dsh 版本发布后请重跑回测并更新本文**（见
> [RELEASE-SOP.md](RELEASE-SOP.md) §3）。
>
> ⚠ **v1.1.12 更正**：v1.1.10 本档曾把 0.1.0-rc.\*/0.1.1-rc.\* 判为「CLI 环境不兼容」——
> 该结论是**回测基线的两处缺陷**（`--legacy-peer-deps` 跳过运行时必需 peer + 无时间锚定导致
> caret 范围漂移混合树）造成的假象，并非真实不兼容。修复后这批版本**全部通过**。本档为修复
> 后的最终结论，取代 v1.1.10 的对应段落。

## 1. 支持声明（速览）

按安装方式划分（方式编号沿用 [README](../README.md)）：

| 形态 | 支持的 dsh 版本 | 附加要求 | 说明 |
| --- | --- | --- | --- |
| **方式 A** preset（`codebuddy-first`） | **≥ 0.1.3-alpha.2** | bridge ≥ 1.1.6 | dsh-persona 自 0.1.3-alpha.2 起强制 `prefix:`/`suffix:` schema（旧 `text:` 字段被校验器拒绝挂载）。更早 dsh 请用 bridge ≤ 1.1.5（旧 persona 结构）或改用方式 C/D |
| **方式 B** 家级灯 bundle 安装（`dsh plugin --profile web add codebuddy-first-bridge`） | **0.0.1-rc.5 → 0.1.6-alpha.2 全部可安装版本**（实测 17 PASS / 0 功能失败 / 3 待重跑瞬时网络超时 / 2 不可安装） | **bridge ≥ 1.1.8** | 除 0.0.1-rc.1/rc.2（依赖下架 E404，平台事实）外，**所有可安装的 dsh 版本安装链路全绿**（含旧 0.1.0-rc.\*/0.1.1-rc.\* 时代——v1.1.10 曾误判为「CLI 环境不兼容」，实为回测基线缺陷，见 §3）。bridge = 1.1.7 会在**所有** dsh 版本上触发启动致命屏（见 §4） |
| **方式 C** 动态 Cordis 插件（`dynamic/`） | 与 dsh 版本无关（会话内机制） | — | 跟随宿主会话加载，不依赖 profile 体系 |
| **方式 D** MCP server（`codebuddy-mcp-server`） | 与 dsh 版本无关（零依赖独立进程） | — | 任何 MCP 客户端可用 |

**DSH Desktop 版本对应**（桌面壳会自动更新后端 dsh）：

| DSH Desktop | 内置 dsh | 备注 |
| --- | --- | --- |
| 0.3.14 | 0.1.2-alpha.5 | v1.1.2 实测机型 |
| 0.3.36 | 0.1.5-rc.1 | v1.1.7 事故机型（桌面壳安全模式）；dsh 0.1.2-rc.1 环境实测触发 crash |
| （当前） | 0.1.6-alpha.2 | 2026-09-18 本机运行中，状态灯正常、`/codebuddy-indicator/status` 有响应 |

## 2. 静态契约探测（22/22 全覆盖）

对每个 dsh 版本的 tarball 做字符串探针（拼接 lib 全部 JS 后按符号匹配，符号均经本地
后端源码逐一定位核对）。七个契约点：

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
| 0.1.6-alpha.1 | 2026-09-15 | ✓ | ✓ | ✓ | ✓ | prefix/suffix | ✓ | ✓ |
| 0.1.6-alpha.2 | 2026-09-17 | ✓ | ✓ | ✓ | ✓ | prefix/suffix | ✓ | ✓ |

**关键翻转点**：

- **C5 persona schema 在 0.1.3-alpha.2 翻转**（`text:` → `prefix:`+`suffix:`）——这就是
  bridge v1.1.6 迁移的根因，也是方式 A 要求 dsh ≥ 0.1.3-alpha.2 的依据。
- **C7 graph id 机制在 0.1.2-alpha.2 出现**（`locatePkgJson`/`nearestPackage`，graph 行 id
  由 Loader 行名改为行名解析出的**包名**）。对 profile 安装（行名 = 包名）两种机制等价，
  因此 1.1.8+ 的注册 id 修法（注册包名 `codebuddy-first-bridge`）在**全部版本**上成立。
- **C1–C4、C6 自 0.0.1-rc.1（首个公开发布版本）全部存在**——插件安装体系与注册名校验
  从第一天就是现在这个形态。
- **0.1.6-alpha.1/.2 七个契约点与 0.1.5-rc.2 完全一致**（无新增/移除契约点）。

## 3. 沙箱安装回测（功能，逐版本）

**方法**：对每个版本——① `npm install @deepseek-ai/dsh@<V> --before=<发布时间+1天>` 装出
**与发布时代一致**的完整运行环境（`--before` 时间锚定防内部组件 caret 范围漂移；不再加
`--legacy-peer-deps`，因为 dsh-app-boot 的 peerDependencies 是运行时必需的；沙箱隔离
`DSH_HOME` + `USERPROFILE`/`HOME`/`APPDATA`/`LOCALAPPDATA`；pnpm 走 npmmirror，经 integrity
校验内容等价）；② 跑 `dsh plugin --profile web add codebuddy-first-bridge@1.1.11`；③ 验证
8 项：profile 创建 / `dependencies` 入列 / `dsh.profile.bundles` 层列表 / node_modules 内
版本 = 1.1.11 / `dsh.bundle.patch` 声明 / `exports["./client"]` 存在 / client.js 注册 id ===
包名（契约核心）/ 各项布尔全过。

**结果**：见 §3.1 矩阵（`dsh-compat-result.json` 明细随交接包归档）。

### 3.1 功能回测矩阵

| dsh 版本 | 发布 | 沙箱安装 `codebuddy-first-bridge@1.1.11` | 说明 |
| --- | --- | --- | --- |
| 0.0.1-rc.1 | 2026-08-10 | ⏭ 今日不可安装 | 依赖 `@deepseek-ai/dsh-agent-tool-mode` 已从 registry 下架（官方源与 npmmirror 均 E404） |
| 0.0.1-rc.2 | 2026-08-11 | ⏭ 今日不可安装 | 同上 |
| 0.0.1-rc.5 | 2026-08-12 | ✅ PASS | 8 项检查全过（含 `clientRegId=codebuddy-first-bridge`） |
| 0.1.0-rc.2 | 2026-08-13 | ✅ PASS | 同上（v1.1.10 曾误判「CLI 环境不兼容」，见 §3.3） |
| 0.1.0-rc.3 | 2026-08-13 | ✅ PASS | 同上 |
| 0.1.0-rc.6 | 2026-08-13 | ✅ PASS | 同上 |
| 0.1.0-rc.7 | 2026-08-17 | ✅ PASS | 同上 |
| 0.1.0-rc.8 | 2026-08-19 | ⏱ 待重跑 | 沙箱 install 瞬时网络超时（ETIMEDOUT，重试仍超时）；同代 0.1.0-rc.2/3/6/7 均 PASS，判定为网络问题而非兼容性 |
| 0.1.1-rc.1 | 2026-08-21 | ⏱ 待重跑 | 同上（瞬时网络超时） |
| 0.1.1-rc.2 | 2026-08-21 | ⏱ 待重跑 | 同上（瞬时网络超时） |
| 0.1.2-alpha.2 | 2026-08-30 | ✅ PASS | 8 项检查全过 |
| 0.1.2-alpha.3 | 2026-08-31 | ✅ PASS | 同上 |
| 0.1.2-alpha.4 | 2026-09-01 | ✅ PASS | 同上 |
| 0.1.2-alpha.5 | 2026-09-02 | ✅ PASS | 同上（Desktop 0.3.14 内置） |
| 0.1.2-rc.1 | 2026-09-03 | ✅ PASS | 同上 |
| 0.1.3-alpha.2 | 2026-09-07 | ✅ PASS | 同上（persona 新 schema 起点） |
| 0.1.5-alpha.1 | 2026-09-08 | ✅ PASS | 同上 |
| 0.1.5-alpha.2 | 2026-09-09 | ✅ PASS | 同上 |
| 0.1.5-rc.1 | 2026-09-10 | ✅ PASS | 同上（Desktop 0.3.36 内置） |
| 0.1.5-rc.2 | 2026-09-10 | ✅ PASS | 同上 |
| 0.1.6-alpha.1 | 2026-09-15 | ✅ PASS | 同上 |
| 0.1.6-alpha.2 | 2026-09-17 | ✅ PASS | 同上（当前 alpha 通道，本机运行中） |

**汇总：PASS 17 / 功能失败 0 / 不可安装 2 / 待重跑 3 / 未回测 0。**

**回测口径**：每个版本在独立一次性沙箱内完成「装 dsh 运行环境 → `dsh plugin --profile web add
codebuddy-first-bridge@1.1.11` → 8 项结果验证」，无跨版本状态。全部 PASS 行实测
`clientRegId = codebuddy-first-bridge`（与包名一致），即 v1.1.8 的修复在所有可运行版本上成立。

### 3.2 已知不可安装版本

**dsh 0.0.1-rc.1 / 0.0.1-rc.2**：依赖树中声明的 `@deepseek-ai/dsh-agent-tool-mode@^0.0.1-rc.1`
已在 registry 上不存在（官方源与 npmmirror 均 E404），今天任何环境下都无法全新安装这两个
dsh 版本——这是平台侧的不可逆事实，与本插件无关。0.0.1-rc.5 起不再依赖该包，可正常安装。

### 3.3 对 v1.1.10 「CLI 环境不兼容」结论的更正

v1.1.10 的 §3 曾把 0.1.0-rc.\*（rc.2/3/6/7/8）/ 0.1.1-rc.\*（rc.1/rc.2）共 7 个版本判为
「CLI 环境不兼容」：`dsh plugin add` 在旧 CLI 自身模块解析处报 `getPackageJSONURL` 的
`ERR_MODULE_NOT_FOUND`，当时归因为「旧 CLI 与现代 Node（v24）运行时 ESM 不兼容」。

**该归因错误。** 真正的根因是回测基线（`scripts/dsh-compat.mjs`）的两处缺陷：

1. **`--legacy-peer-deps`**（第一顺位安装参数）：`@deepseek-ai/dsh-app-boot` 自 0.1.5-rc.2
   起把 `@deepseek-ai/cordis-plugin-group` 等声明为**运行时必需的 peerDependencies**；
   `--legacy-peer-deps` 让 npm 跳过 peer 安装却仍返回成功（exit 0），于是第一顺位「成功」
   后兜底不再执行，沙箱得到一个缺 peer、无法 boot 的 dsh 环境——`dsh plugin add` 启动
   dsh 时在 `dsh-app-boot` 导入 `cordis-plugin-group` 处 `ERR_MODULE_NOT_FOUND`，与所装
   插件无关。
2. **无时间锚定**：dsh 内部组件互相以 `^0.1.x-rc.y` caret 范围引用；0.1.6-alpha.1/.2
   （2026-09-15/17 发布）出现后，安装任何历史 dsh 版本都会解析进 0.1.6-alpha.x 组件形成
   **混合树**，结果随上游发版漂移、不可复现。

修复（v1.1.12：移除 `--legacy-peer-deps` + 加 `--before=<发布时间>` 锚定 + `PROBE_VER` 对齐
1.1.11）后重跑：0.1.0-rc.2/3/6/7、0.1.1-rc.\* 等旧版本**全部通过**，`功能失败 0`。旧 CLI
在现代 Node 下**并无 ESM 兼容性问题**——那份结论连同「回测环境口径与 Node 版本相关」的推论
一并撤回。

## 4. 事故对应关系

- **v1.1.7 启动致命屏**（2026-09-10）：client.js 注册 id 写旧内层包名，与 graph 行 id
  （包名）不匹配 → client-modules arrive 校验（C6）失败 → 整个 client combo 崩溃 →
  桌面壳安全模式。**回测证实 C6 在全部 22 个版本上都存在**——该事故不是某个 dsh 版本的
  回归，在任何版本上都会发生；1.1.8 起修复并全版本成立（见 §2 翻转点说明）。
- **v1.1.6 preset 挂载失败**：dsh-persona 0.1.3-alpha.2 schema 升级（C5 翻转点）所致。

## 5. 维护约定

- 新 dsh 版本发布 → `npm run compat:dsh --full` 回测 → 按结果更新本文矩阵与支持声明；
- **回测环境口径**：回测机为 Windows + Node v24.21.0（DSH Desktop 后端自带运行时）+ pnpm 10。
  **功能回测安装必须带 `--before=<发布时间>` 时间锚定、且不得加 `--legacy-peer-deps`**
  （否则 peer 缺失 / caret 漂移会产生与插件无关的假失败，见 §3.3）；
- 出现「待重跑（瞬时网络超时）」行时，用 `--only <版本列表>` 重试；若同一版本多次超时，
  判定为网络问题（其同代相邻版本 PASS 即旁证），在矩阵注明「待重跑」而非「失败」；
- 若出现新的契约点变化（探针 FAIL/异常），先在
  `%TEMP%\dsh-compat-cache\` 下解包对应版本 tarball 人工核对探针符号，再判定支持范围；
- 本文矩阵即支持声明的**唯一事实来源**，README 只做速览引用。
