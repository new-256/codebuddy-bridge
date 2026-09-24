# codebuddy-en / codebuddy 端点与凭据根因报告

## 1. 三个 CLI 产品面（product.json 实测）

| 后端 | 二进制 | productName | product 端点 | authentication.id |
|---|---|---|---|---|
| `codebuddy` | `%APPDATA%\npm\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy` | CodeBuddy | `www.codebuddy.ai` | `Tencent-Cloud.coding-copilot` |
| `codebuddy-en` | `C:\Program Files\WorkBuddyAI\resources\app.asar.unpacked\cli\bin\codebuddy` | WorkBuddy AI | `www.workbuddy.ai` | `workbuddy-desktop-ai` |
| `workbuddy` | `C:\Program Files\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy` | WorkBuddy | `copilot.tencent.com` | `workbuddy-desktop` |

`C:\Users\lcl\AppData\Local\Programs\CodeBuddy`（CodeBuddy IDE）**不附带** headless CLI，
`resources/app.asar.unpacked/cli` 不存在 —— 不可作为二进制来源。

## 2. 凭据库（`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\`）

| 文件 | auth.domain | token |
|---|---|---|
| `Tencent-Cloud.coding-copilot.info` | `www.codebuddy.cn` | **明文** 1322 字符 |
| `workbuddy-desktop.info` | `www.codebuddy.cn` | 明文 |
| `workbuddy-desktop-ai.info` | `www.workbuddy.ai` | **`$wbEncrypted`**（keyId `9127dea1b44020a7`） |

**关键**：`auth.domain` 三个文件**都是明文**，可直接用于端点自动推导。

## 3. 实测运行矩阵（node 作为 runtime）

| 组合 | apiKeySource | 结果 |
|---|---|---|
| npm CLI 无 env | www.codebuddy.ai | **失败 401** |
| npm CLI `+BASE_URL=cn/v2` | www.codebuddy.ai | **ok PONG** |
| npm CLI `+BASE_URL=copilot/v2` | www.codebuddy.ai | **ok PONG** |
| npm CLI `+TOKEN`（无 BASE_URL） | www.codebuddy.ai | **失败** |
| WorkBuddy(国内) 无 env | copilot.tencent.com | **ok PONG** |
| WorkBuddy(国内) `+cn/v2` | copilot.tencent.com | **ok PONG** |
| WorkBuddyAI 无 env | www.workbuddy.ai | **失败** |
| WorkBuddyAI `+BASE_URL=wb.ai/v2` | www.workbuddy.ai | **失败** |
| WorkBuddyAI `+TOKEN(国内)+copilot/v2` | www.workbuddy.ai | **ok PONG** |
| WorkBuddyAI `+TOKEN(国内)+wb.ai/v2` | www.workbuddy.ai | **失败 401** |
| WorkBuddyAI `+TOKEN(国内)+cn/v2` | www.workbuddy.ai | **ok PONG** |

### 结论 A：`CODEBUDDY_AUTH_TOKEN` 不决定端点
token 只在**与其登录域匹配**的端点上生效。国内 token 打 `workbuddy.ai` 必然 401。

### 结论 B：默认后端 `codebuddy` 当前是坏的
npm CLI 的 product 端点是 `www.codebuddy.ai`，但其登录 token 域是 `www.codebuddy.cn`
→ 域不匹配 → 401。注入 `CODEBUDDY_BASE_URL=https://www.codebuddy.cn/v2` 即恢复。
这解释了用户日志里 312 次 `www.codebuddy.ai` 与 116 次 `Authentication required`。

### 结论 C：`codebuddy-en` 无法独立工作
```
[CredentialBootstrap] CBC early {"event":"gate-failed","route":"standalone",
  "policy":"off","readyConfig":"disabled","reason":"config-incomplete","configured":false}
[CredentialBootstrap] startup failed: WorkBuddy credential bootstrap configuration is incomplete
```
protector key `9127dea1b44020a7` **不存在于磁盘任何位置**（51612 个文件全盘扫描、
所有 DPAPI blob 解包尝试 = 0 次命中）。它只经
`CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET` 由运行中的桌面 App 下发。
`at-rest-failures-v1.json` 中 CLI 自己（`processRole:"cbc"`）也以
`category:"missing-key"` 失败 21 次 —— 证明这不是探针造成的假象。

## 4. 修复设计

1. **端点按登录域自动推导**（host 侧读 `auth.domain`，纯函数映射端点）。
   - `www.codebuddy.cn` → `https://www.codebuddy.cn/v2`
   - `www.codebuddy.ai` → `https://www.codebuddy.ai/v2`
   - `www.workbuddy.ai` → `https://www.workbuddy.ai/v2`
   - `copilot.tencent.com` → `https://copilot.tencent.com/v2`
2. **仅当登录域与 product 端点不一致时注入** `CODEBUDDY_BASE_URL`（避免无谓覆盖）。
3. **`codebuddy-en` 新增可选凭据设置** `codebuddyEnToken` → `CODEBUDDY_AUTH_TOKEN`，
   并在缺失时给出可操作的明确错误（而非静默 401）。
4. **删除错误的硬编码默认** `https://www.workbuddy.ai/v2` 与
   无条件的 `CODEBUDDY_INTERNET_ENVIROMENT=cloudhosted`
   （`www.workbuddy.ai` 属于 `externalDomain`，不是 `cloudHostedDomain`）。
