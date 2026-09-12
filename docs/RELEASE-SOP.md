# 发布与维护 SOP（npm + GitHub）

> 本文档是 codebuddy-first-bridge 的发布与日常维护操作手册，覆盖 npm 与 GitHub
> 两侧的提交、发布、审计、回测全流程。新会话接手维护请先读 [HANDOVER.md](HANDOVER.md)，
> 再按需查本文。每一步的「为什么」都指向历史事故或已知坑，不要跳步。

## 0. 铁律（违反任何一条都不要发布）

1. **版本号四处同步**：`package.json` ↔ `mcp/codebuddy-mcp-server.mjs` 的 `const VERSION` ↔
   `docs/CHANGELOG.md` 顶部条目 ↔ `test/mcp.test.mjs` 版本断言。`scripts/verify.mjs` 锁前三处，
   `npm test` 锁第四处——**`npm run check` 全绿是发布的前置条件**。
2. **client 注册 id 必须 === npm 包名**（`codebuddy-first-bridge`）。这是 v1.1.8 事故的根因，
   `verify.mjs` 已做静态闸门（从 `exports["./client"]` 解析文件、提取
   `__ModuleLoader__.load({ id })` 与 `package.json` 的 `name` 严格比对）。改 client.js 时
   绝不能把 id 改回 `codebuddy-indicator`（旧内层包名，触发
   `loaded without registering` → 整屏插件页崩溃）。
3. **先 git 后 npm**：commit → tag → push → GitHub Release → `npm publish` 的顺序不可倒置。
   v1.1.8 热修曾「npm 先发、git 欠账」，造成 tarball 与 tag 树漂移风险（v1.1.10 的
   audit 脚本就是为堵这个洞而生）。
4. **发布后必跑审计**：`node scripts/audit-npm-sync.mjs`（见 §4），确认 npm 上每个版本
   与 git tag 内容一致。

## 1. 标准发布流程（SOP）

```powershell
# ① 改动完成后：全量校验（MCP self-check + verify 闸门 + 74 例测试）
npm run check

# ② 版本号四处 bump（假设 1.1.10 → 1.1.11）
#    package.json / mcp/codebuddy-mcp-server.mjs / docs/CHANGELOG.md / test/mcp.test.mjs
#    （home-plugin/codebuddy-indicator/package.json 的 version 也一并同步）

# ③ 提交（只提交本版本相关文件；不要顺手提交无关目录）
git add <相关文件>
git commit -m "<type>: <摘要> (v1.1.11)"

# ④ 打 tag 并推送
git tag -a v1.1.11 -m "v1.1.11"
git push origin main
git push origin v1.1.11

# ⑤ GitHub Release（gh 已登录；notes 用中文，格式参考既有 release）
gh release create v1.1.11 --title 'v1.1.11 — <一句话>' --notes-file <notes.txt>

# ⑥ npm 发布（认证方式见 §2，token 由仓库所有者持有，绝不写入任何文件）
npm publish --registry=https://registry.npmjs.org --//registry.npmjs.org/:_authToken=<TOKEN>

# ⑦ 发布后审计：npm ↔ git 逐版本内容比对
node scripts/audit-npm-sync.mjs
```

> `npm publish` 会自动执行 `prepack` = `node scripts/verify.mjs && npm test`
> （v1.1.9 起加强），即发布动作自带完整闸门；但不要依赖它替代 ① 的显式检查。

### 1.1 已知网络坑（中国网络环境）

- **官方 CDN 间歇性 ECONNRESET**：`registry.npmjs.org` 的 tarball 下载（尤其大文件）
  会随机被重置。`npm publish` 本身是小请求 + npm 自带重试，一般能过；但
  `npm pack` / `npm install` 拉 tarball 时可能失败。
- **兜底方案**：npmmirror 镜像（`--registry=https://registry.npmmirror.com`）内容与官方
  逐字节一致（tarball 有 shasum/integrity 校验）。本仓库的 `audit-npm-sync.mjs` 与
  `dsh-compat.mjs` 都内置了「官方源优先 → 镜像兜底 + 官方元数据 shasum 校验」的双层
  传输，直接用脚本即可；手动操作时挂 `--registry` 参数。
- `npm install` 在**空目录**会静默 no-op（npm 11.19 的怪癖），用 `--prefix <dir>` 或
  先放一个 package.json。

## 2. npm 认证（重要坑）

本机 npm 11.19 实测：**`NODE_AUTH_TOKEN` 环境变量和 `~/.npmrc` 里的 token 都会被忽略**
（`ENEEDAUTH`）。唯一可靠的方式是发布命令行里显式传参：

```powershell
npm publish --registry=https://registry.npmjs.org --//registry.npmjs.org/:_authToken=<TOKEN>
```

- token 是 npm 网站生成的 granular token（发布权限 + bypass 2FA；普通 token 会卡 2FA
  的 E403）。
- token 只在命令行使用，**绝不写入任何文件 / 环境变量持久化 / 提交进仓库**。
- npm 账号：`luchenglong`；包名 `codebuddy-first-bridge`。

## 3. dsh 新版本发布后的维护动作

官方 `@deepseek-ai/dsh` 发新版本后（DSH Desktop 会自动更新后端）：

```powershell
# ① 全版本回测（静态契约探测 + 沙箱真实安装；结果矩阵打印到 stdout，
#    明细 JSON 在 %TEMP%\dsh-compat-cache\dsh-compat-result.json）
node scripts/dsh-compat.mjs --full

# ② 按矩阵结果更新 docs/COMPATIBILITY.md（支持声明），必要时发布适配版本
# ③ 回归验证本机：重启 DSH Desktop 后状态灯正常、`/codebuddy-indicator/status` 有响应
```

回测探测的契约点（详见 `scripts/dsh-compat.mjs` 头注）：plugin CLI、pnpm 转发、
`dsh.bundle.patch` 读取、`dsh.profile.bundles` 对账、persona schema（prefix/suffix）、
client-modules arrive 注册名校验、`locatePkgJson`（graph id=包名机制）。

## 4. npm ↔ git 一致性审计

```powershell
node scripts/audit-npm-sync.mjs
```

对 npm 上每个已发布版本：① 必须有 `v<version>` tag；② tarball 逐文件 sha256 与
`git -c core.autocrlf=false archive` 的 tag 树比对（取原始提交字节，避免本机
autocrlf 假阳性）；③ tarball 内 package.json 的 name/version 自检。输出分级：

- `✓ IDENTICAL` — 字节级一致
- `⚠ EOL-ONLY` — 仅行尾差异（历史工作区 CRLF 产物；v1.1.6–1.1.9 的
  `docs/ARCHITECTURE.md` 属此类，内容零漂移），**通过但显著标注**
- `✗ DRIFT / MISSING-TAG` — 真实漂移或缺 tag，exit 1

CI（`.github/workflows/ci.yml` 的 audit job）在每次 push 时自动跑此审计
（需要 `fetch-depth: 0` 拿全量 tag）。

## 5. 历史坑档案（为什么有这些规矩）

| 坑 | 后果 | 防线 |
| --- | --- | --- |
| client.js 注册 id 写旧内层包名（v1.1.7） | `loaded without registering` → DSH 启动致命屏，桌面壳进安全模式全树注释 | verify.mjs id 闸门（v1.1.9） |
| 热修时 test 版本断言漏 bump（v1.1.8） | `npm test` 必挂，但 prepack 不跑测试所以漏到 npm | prepack = verify + npm test（v1.1.9） |
| npm 先发、git 后补（v1.1.8） | tarball 与 tag 树漂移风险 | SOP §0.3 顺序铁律 + audit 脚本 + CI audit job |
| 工作区 CRLF 文件（ARCHITECTURE.md 等） | tarball（工作区字节）与 blob（LF）行尾不一致 | `.gitattributes`（`* text=auto eol=lf`）+ audit EOL-ONLY 分级 |
| Node 直连 registry CDN（undici fetch） | `terminated`（响应流被截断） | 脚本统一走 npm CLI 传输（自动重试）+ 镜像兜底 + shasum 校验 |
| Windows 下 Node spawn `npm` | ENOENT（.cmd shim 不可直接 spawn） | 脚本内置 npm-cli.js 解析（`dirname(process.execPath)/node_modules/npm/bin/npm-cli.js`） |
| `git archive` 默认走 autocrlf | 全文件假阳性「内容不同」 | audit 用 `-c core.autocrlf=false` 取原始字节 |

## 6. 仓库与包的关键坐标

| 项 | 值 |
| --- | --- |
| 工作区 | `C:\Users\lcl\Desktop\codebuddy-bridge` |
| GitHub | https://github.com/new-256/codebuddy-bridge |
| npm 包 | `codebuddy-first-bridge`（npm 账号 `luchenglong`） |
| MCP server bin | `codebuddy-mcp-server`（零依赖，与 dsh 版本无关） |
| 姊妹仓库 | https://github.com/new-256/agy-first-bridge（同构整改已完成 1.6.1，含同样的 verify 闸门） |
