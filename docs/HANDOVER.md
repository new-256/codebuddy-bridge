# 交接文档（HANDOVER）

> 本文档面向**下一个维护会话**：接手 codebuddy-first-bridge 的开发与维护。
> 写于 v1.1.10 发布之际（2026-09-10）。读完本文即可上手，细节按「文档地图」深入。

## 1. 项目是什么

**codebuddy-first-bridge** —— DeepSeek Harness（DSH）的 codebuddy 优先派发桥：

- 让 DSH 每种模式优先使用本地 codebuddy CLI（全程接管、无弹窗），带限流/网络回退对话；
- 实时状态灯（动态插件形态 + 家级插件形态双轨）；
- 零依赖 MCP server，让任何 MCP 客户端（Claude Code / Codex / Cherry Studio…）发现 codebuddy；
- 按项目维度的 token 用量核算。

| 关键坐标 | 值 |
| --- | --- |
| 工作区 | `C:\Users\lcl\Desktop\codebuddy-bridge` |
| GitHub | https://github.com/new-256/codebuddy-bridge |
| npm 包 | `codebuddy-first-bridge`（账号 `luchenglong`，CI 绿） |
| 当前版本 | 1.1.10（tag/Release/npm 三侧同步，audit 全过） |
| 姊妹项目 | `agy-first-bridge`（同构，已独立完成 1.6.1 整改，仓库 `C:\Users\lcl\Desktop\agy-first-bridge`） |

## 2. 文档地图

| 文档 | 用途 |
| --- | --- |
| [RELEASE-SOP.md](RELEASE-SOP.md) | **npm/GitHub 提交与维护 SOP**（发布流程、认证坑、网络坑、历史坑档案） |
| [COMPATIBILITY.md](COMPATIBILITY.md) | **支持声明**：dsh 全版本回测矩阵 + 兼容结论 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构深解（四形态、状态机、通道设计） |
| [../docs/CHANGELOG.md](CHANGELOG.md) | 版本历史（每版根因/改动/测试） |
| [../README.md](../README.md) / [README.en.md](../README.en.md) | 用户文档（安装方式 A/B/C、版本表） |
| [../scripts/verify.mjs](../scripts/verify.mjs) | 发布闸门（版本锁 + persona 护栏 + 分发结构 + **client id 契约**） |
| [../scripts/audit-npm-sync.mjs](../scripts/audit-npm-sync.mjs) | npm↔git 逐版本内容审计（CI 已接入） |
| [../scripts/dsh-compat.mjs](../scripts/dsh-compat.mjs) | dsh 全版本回测（静态契约探测 + 沙箱安装） |

## 3. 架构速览（四形态）

```
codebuddy-first-bridge
├── preset/codebuddy-first/          ① Agent preset 形态（方式 A）
│   ├── agent.cordis.yml             # bridge 行 + persona 行（prefix/suffix）
│   ├── preset.yml
│   └── codebuddy-first-bridge.mjs   # 会话内插件：codebuddy 优先派发 + 限流回退
├── home-plugin/codebuddy-indicator/ ② 家级状态灯（方式 B，v1.1.7 并入主包分发）
│   ├── cordis.patch.yml             # bundle 补丁层（id: codebuddy-indicator / name: codebuddy-first-bridge）
│   ├── lib/index.mjs                # host 半：codebuddyCollector 服务 + /codebuddy-indicator/status 端点
│   └── lib/client.js                # client 半：__ModuleLoader__.load({ id: "codebuddy-first-bridge" }) ←⚠ 契约
├── dynamic/                         ③ 动态 Cordis 插件形态（方式 C，host.js/client.js 函数体）
└── mcp/codebuddy-mcp-server.mjs     ④ MCP server（零依赖，bin: codebuddy-mcp-server）
```

**最核心的契约**（v1.1.8 事故根因，verify.mjs 已锁死）：
`home-plugin/.../client.js` 里 `__ModuleLoader__.load({ id })` 的 id **必须等于主包名**
`codebuddy-first-bridge`。client-modules 的 graph 行 id 按包名生成，浏览器侧 `arrive()`
校验 bundle 必须注册同名模块，否则整个 client combo 崩溃（`Failed to load plugins`）。
slot id `codebuddy-indicator-home` 是另一命名空间，无需与包名一致。

## 4. 发布与维护

**一切按 [RELEASE-SOP.md](RELEASE-SOP.md) 执行**，要点速记：

- `npm run check` 全绿（verify 22 项 + 74 测试）→ commit → tag → push → Release → publish → audit；
- npm 认证必须命令行显式 `--//registry.npmjs.org/:_authToken=<TOKEN>`（token 由所有者提供，
  绝不入文件）；
- dsh 发新版本后：`node scripts/dsh-compat.mjs --full` 回测 → 更新 COMPATIBILITY.md。

## 5. 历史事故档案（时间线）

| 版本 | 事件 |
| --- | --- |
| v1.1.6 | 适配 dsh-persona 0.1.3-alpha.2（`text:` → `prefix:`/`suffix:`）；首次 npm 发布 |
| v1.1.7 | 家级灯并入主包标准分发（bundle patch 层）；**埋雷**：client.js 注册 id 仍是旧内层包名 `codebuddy-indicator` |
| 2026-09-10 18:08 | **事故爆发**：本机更新到含 1.1.7 的组合 → client combo 崩溃 → `Failed to load plugins` 致命屏 → 桌面壳（dsh-desktop 0.3.36）enterSafeMode 把家级补丁 10 行全注释（safe-mode.json 备份原状） |
| v1.1.8 | 紧急热修：id 改为包名；教训——npm 先发、git 欠账、test 断言漏 bump |
| v1.1.9 | 发布闸门加固：verify.mjs 加 client id 静态检查（4 条护栏）+ prepack 升级为 verify + npm test；补齐 1.1.8 的 git 欠账 |
| v1.1.10 | 本轮：npm↔git 一致性审计（audit 脚本 + CI job，4 版本全过，仅历史 CRLF 行尾差异）+ dsh 20 版本全量回测 + 支持声明 + CRLF 归一化 + .gitattributes + 本交接文档体系 |

同构整改已在姊妹仓库 agy-first-bridge 完成（v1.6.1：修 id + verify 闸门 + CI 接入 + tag/Release）。

## 6. 未决事项（新会话的待办清单）

1. **上游 issue 未提交**（责任方为官方平台，证据链已钉死，文本尚未起草提交）：
   - `dsh` 仓库：`dsh/lib/plugin-Ddi42qoW.js` —— `plugin add` 时应静态校验 client 注册 id=包名（本次回测证实全 20 版本都缺此校验）；
   - `dsh` 仓库：`dsh-client-modules` combo 机制——单模块注册失败应只禁用该插件，不该炸整批；
   - `dsh-desktop` 仓库：`updater-backend.js` enterSafeMode（L1242-1282 + commentPatchEntries L1402）——单插件故障应优先隔离该 bundle/补丁行，而非全树注释。
2. **`dsh-session-cleaner/` 目录**（工作区未跟踪）：是一个**独立完整项目**
   （`@luchenglong/dsh-session-cleaner` v1.2.1，package.json 声明自己的仓库
   `new-256/dsh-session-cleaner`），不属于本包。**建议移出本工作区、独立建仓维护**，
   避免误提交污染本仓库（npm 侧有 files 白名单保护，不会进包）。
3. **本机安装升级**：`dsh-home` 里 profile 安装的 codebuddy-first-bridge 仍是 1.1.7+热修
   （profiles/web/node_modules，package.json 报 1.1.7 但 client.js 已被热改）。
   建议执行 `dsh plugin --profile web add codebuddy-first-bridge@latest` 升到 1.1.10 并重启验证。
4. **本机用户层 `cordis.patch.yml`**：安全模式注释态的家级灯旧行（`# - id: codebuddy-indicator`
   等）**不要取消注释**——现在由 bundle 层（profile 安装）承载，取消注释会变回旧式双行形态，
   有历史双实例风险。
5. **回测数据**：`%TEMP%\dsh-compat-cache\dsh-compat-result.json`（20 版本明细）已随本交接
   打包归档（见桌面 handover 包）；Temp 目录会被系统清理，长期数据以 COMPATIBILITY.md 内的
   矩阵为准。

## 7. 新会话快速上手（5 分钟）

```powershell
cd C:\Users\lcl\Desktop\codebuddy-bridge
git status                     # 应干净（除 dsh-session-cleaner/ 未跟踪，见 §6.2）
git log --oneline -5           # HEAD 应为 v1.1.10 发布提交
npm run check                  # 22 项 ok + 74 测试全过
node scripts/audit-npm-sync.mjs  # npm↔git 全版本一致（1.1.10 起 IDENTICAL）
```

然后按任务性质查文档：发布/维护 → RELEASE-SOP；兼容性问题 → COMPATIBILITY；
架构细节 → ARCHITECTURE；历史 → CHANGELOG §对应版本。
