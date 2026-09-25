// dynamic/host.js — 【生成文件，勿手改】
// 由 scripts/build.mjs 从本模板（dynamic/host.template.mjs）+
// core/codebuddy-core.mjs 拼装生成。修改共享逻辑 → 改 core；修改动态适配 →
// 改本模板；然后 `node scripts/build.mjs` 重新生成并提交。
//
// Cordis 动态插件沙箱禁止 import/require，故共享核心以文本注入到本文件中
// 段的 CORE 占位标记处（见下方独立一行的标记）。
// 沙箱内无 process/env/ctx.emit：node 可执行文件经 subprocess.resolveExecutable
// 解析，状态经家级收集器（codebuddyCollector.mergeSnapshot）汇入状态灯。
// core/codebuddy-core.mjs — 共享核心（单一事实来源）。
//
// 三种交付形态（preset / dynamic / MCP）都从本文件派生：
//   - MCP server 直接 import 本模块（仓库内运行）；
//   - preset 通过 scripts/build.mjs 生成的同目录副本（'./codebuddy-core.mjs'）
//     导入 —— 安装到 .agent-presets/codebuddy-first/ 的目录因此自包含；
//   - dynamic/host.js 由 scripts/build.mjs 从本文件文本生成（Cordis 动态插件
//     沙箱禁止 import，故用生成 + 同步测试锁住一致性）。
// 约束：本文件不使用 process / env / fs（preset 与 dynamic 沙箱内不可用）；
// 不使用 import（生成器只剥离开头的 export 关键字）。
//
// 纯函数 + 状态引擎 + 执行编排均为零依赖纯 JS（Node >= 18）。

// ── 常量 ──────────────────────────────────────────────────────────────────────

// 限流/网络/认证失败判定。仅匹配 stderr + status（不匹配回复全文——排查网络类
// 任务的答复里几乎必然出现 connection/dns/timeout 字样，会误判成限流）；数字码
// 加词边界（避免 "1500" 命中 500、"4013" 命中 401）。
const LIMIT_RE = /rate.?limit|ratelimit|\b429\b|too many|quota|insufficient|credit|balance|exhausted|exceed|\bnetwork\b|offline|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|\btimeouts?\b|timed out|unavailable|\b50[023]\b|\b40[13]\b|unauthorized|invalid api|api key|proxy|socket|tls|ssl|\bdns\b|网络|超时|限流|流量|受限|配额|金额|余额|额度|认证|连接|断开/i

const MAX_TRAIL = 12
const MAX_ARG_LEN = 120
const MAX_PROJECTS = 12
const MAX_SESSIONS = 256

// ── 后端注册表（v1.3.1：端点按登录域自动对齐）─────────────────────────────────
// 三个产品面各有**独立安装包与独立 product.json**（v1.3.0 的「同一 CLI + 端点 env」
// 说法已实测推翻，见 docs/ROOT-CAUSE-codebuddy-en.md）：
//   codebuddy     CodeBuddy 国内版 —— npm @tencent-ai/codebuddy-code
//                 productName "CodeBuddy"，product 端点 www.codebuddy.ai
//   codebuddy-en  WorkBuddy AI 国际版 —— C:\Program Files\WorkBuddyAI\...
//                 productName "WorkBuddy AI"，product 端点 www.workbuddy.ai
//   workbuddy     WorkBuddy 国内版桌面 —— C:\Program Files\WorkBuddy\...
//                 productName "WorkBuddy"，product 端点 copilot.tencent.com
// 协议（stream-json、-p、--permission-mode）三面完全一致。
//
// **端点必须与登录域一致**（实测矩阵）：
//   - npm CLI 的登录 token 域是 www.codebuddy.cn，而其 product 端点是
//     www.codebuddy.ai → 域不匹配 → 401。注入 CODEBUDDY_BASE_URL=www.codebuddy.cn/v2
//     即恢复（这正是用户日志中 312 次 www.codebuddy.ai + 116 次 Authentication
//     required 的根因，即默认后端 codebuddy 此前是坏的）。
//   - CODEBUDDY_AUTH_TOKEN 本身**不决定端点**：token 只在其登录域对应的端点上生效。
//   - www.workbuddy.ai 属 product.json 的 externalDomain（不是 cloudHostedDomain），
//     故 v1.3.0 无条件注入 CODEBUDDY_INTERNET_ENVIROMENT=cloudhosted 语义错误，已删。
// 因此：登录域由宿主侧读 auth 库得到（纯逻辑不碰 fs），端点按域推导；仅当推导出的
// 端点与后端 product 端点不同才注入覆盖，避免无谓覆盖。
// 会话存储：CLI 按端点归档会话（~/.codebuddy 单一目录），但各产品面登录互斥——
// 同一 sessionId 只在其登录域内有效，sessions 表照旧按 backend 记录归属即可。
const BACKENDS = ['codebuddy', 'codebuddy-intl', 'codebuddy-en', 'workbuddy']

// 各后端的 product 端点（来自 product.json 的 endpoint，补 /v2 —— resolveModelBaseURL
// 只给 product 端点补 /v2，env 覆盖值按原样使用，故覆盖值必须自带 /v2）。
// codebuddy-intl（v1.4.0）：同一个 npm CLI 跑国际产品面（product.ioa.json），
// 端点与 codebuddy 国内面不同（ioa 面走国际网关）。
const BACKEND_ENDPOINTS = {
  'codebuddy': 'https://www.codebuddy.ai/v2',
  'codebuddy-intl': 'https://www.codebuddy.ai/v2',
  'codebuddy-en': 'https://www.workbuddy.ai/v2',
  'workbuddy': 'https://copilot.tencent.com/v2'
}

// 登录域（auth 库 auth.domain，明文）→ 该域可用的 API 端点。三个产品面的登录域
// 与端点已逐一实测：cn 域在 npm CLI / WorkBuddyAI 上均返回 PONG。
const AUTH_DOMAIN_ENDPOINTS = {
  'www.codebuddy.cn': 'https://www.codebuddy.cn/v2',
  'www.codebuddy.ai': 'https://www.codebuddy.ai/v2',
  'www.workbuddy.ai': 'https://www.workbuddy.ai/v2',
  'copilot.tencent.com': 'https://copilot.tencent.com/v2'
}

// 各后端的 authentication.id（product.json），用于定位 auth 库中的凭据文件。
// codebuddy-intl 与 codebuddy 共用同一个 npm CLI 安装，authentication.id 相同
// （同一份 product.json 的 authentication.id 决定凭据文件名），故本地凭据与国内面一致。
const BACKEND_AUTH_IDS = {
  'codebuddy': 'Tencent-Cloud.coding-copilot',
  'codebuddy-intl': 'Tencent-Cloud.coding-copilot',
  'codebuddy-en': 'workbuddy-desktop-ai',
  'workbuddy': 'workbuddy-desktop'
}

/** 取 URL 的 hostname（容错：非法 URL 返回空串）。 */
function endpointHost(url) {
  const s = String(url || '').trim()
  if (!s) return ''
  try { return new URL(s).hostname.toLowerCase() } catch (e) { }
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(s)
  return m ? m[1].toLowerCase() : ''
}

/**
 * 推导本次调用应使用的端点。
 * 优先级：用户显式 baseUrl 覆盖 > 登录域推导 > null（沿用 CLI 自身 product 端点）。
 * @param {string} [explicitBaseUrl] 设置面板里的端点覆盖
 * @param {string} [authDomain] 宿主侧从 auth 库读到的 auth.domain
 * @returns {string|null}
 */
function resolveEndpoint(explicitBaseUrl, authDomain) {
  const explicit = String(explicitBaseUrl || '').trim()
  if (explicit) return explicit
  const d = String(authDomain || '').trim().toLowerCase()
  if (d && AUTH_DOMAIN_ENDPOINTS[d]) return AUTH_DOMAIN_ENDPOINTS[d]
  return null
}

const DEFAULT_BACKEND = 'codebuddy'

// 各后端的可选模型。
//
// ── 修正历史（重要）──────────────────────────────────────────────────────────
// v1.3.x 的清单是错的（抄了国内版 product.internal.json）。
// v1.4.0 改成读各安装的 product.json —— **仍然不对**：product.json 的
// `agents.cli.models` 是**发行版内置的候选表**，不等于**该账号实际可用**的模型。
// 真机把 product.json 里的 id 逐个喂给 CLI 实测，结果 `default-model` /
// `primary-model` / `gpt-6-astra` 全部返回
//   400 model [...] service info not found
// 即这些型号对该账号根本不存在。
//
// ── 权威来源（真机实测，本版起）──────────────────────────────────────────────
// 给 CLI 传一个**不存在的 model** 时，服务端会在报错里回一行
//   `Currently supported models for your account:`
// 后跟逐行 `  - <id>` —— 这是**按账号实时返回**的权威清单，远优于任何静态文件。
// 实测（同一账号）：codebuddy 与 workbuddy 清单几乎一致（workbuddy 多一个 `auto`），
// 且 CLI 的 `--help` 静态表（glm-5.2/kimi-k2.6/…）对三个安装**完全相同**——所以
// 「按安装读 product.json」这条思路本身就是错的：差异在**账号**，不在安装。
//
// 实测该账号支持（2026-09-25，codebuddy / workbuddy 共同支持）：
//   hy4-preview, hy3, hy3-x, deepseek-v4.1-flash, glm-5.3, glm-5.3-flash, glm-5.2,
//   glm-5.1, glm-5v-turbo, minimax-m3, kimi-k3-1, kimi-k2.8-preview, kimi-k2.7,
//   kimi-k2.6, deepseek-v4-pro（workbuddy 另有 auto；minimax-m2.7 实测也可用）
//
// 下面的静态表 = 上表（离线/无凭据时的回退）。需要精确清单时用
// `probeBackendModels()`（见下）实时问服务端。
// 各后端的可选模型。
//
// ── 修正历史（重要，三次迭代才对）──────────────────────────────────────────────
// v1.3.x：抄了国内版 product.internal.json → 错（含本机没有的型号）。
// v1.4.0：改成读各安装的 product.json → 仍错。那是**发行版内置候选表**，不等于
//         **账号可用**；实测 default-model / primary-model / gpt-6-astra 全部报
//         `400 model [...] service info not found`。
// v1.4.1：改为「按账号」为准，并写出解析服务端 `Currently supported models for
//         your account:` 的 parseAccountModels()。但对 `codebuddy-en` 仍有一处
//         错：那份清单是**照 WorkBuddyAI 的 product.json 拼的**，而用户实际看到的
//         「Hy4 preview / Hy3 / Deepseek-V4.1-Flash 免费」是 **npm CLI 面**的目录。
//
// ── v1.4.2：区分「谁提供模型」──────────────────────────────────────────────
// 关键事实（真机读 product.json 的 `credits` 字段实测）：
//   * npm CLI（codebuddy / codebuddy-intl）：目录里有三件免费套件
//       hy3                  credits=x0.00   ← 免费
//       deepseek-v4.1-flash  credits=x0.00   ← 免费
//       hy4-preview          credits=x0.29
//   * WorkBuddyAI（codebuddy-en）：自己的 product.json **没有** hy4-preview，
//     也没有 deepseek-v4.1-flash，只有 hy3（x0.00）；agents.cli.models 仅 4 个
//     角色别名（fast/balanced/primary/deep-model）。
//   * 两个桌面版（codebuddy-en / workbuddy）自带完整清单，**不应**把 npm 面的
//     型号并进来 —— 那是另一个产品面的权限，列出来只会让用户选了报错。
// 因此：npm 两个后端用账号实测清单；两个桌面后端**严格以自己安装的目录为准**
// （见 BACKEND_STRICT_CATALOG）。
//
// 需要精确清单时用 parseAccountModels() 解析服务端实时返回的账号清单。
const BACKEND_MODEL_IDS = {
  'codebuddy': ['hy4-preview', 'hy3', 'hy3-x', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3', 'minimax-m2.7', 'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro'],
  'codebuddy-intl': ['claude-sonnet-5', 'claude-sonnet-5-1m', 'claude-opus-5', 'claude-opus-4.8', 'claude-opus-4.8-1m', 'gemini-3.1-pro', 'gemini-3.5-flash', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'glm-5.3-ioa', 'glm-5.3-flash-ioa', 'glm-5.2-ioa', 'kimi-k3-ioa', 'kimi-k2.8-preview', 'kimi-k2.6-ioa', 'minimax-m3-ioa', 'minimax-m2.7-ioa', 'deepseek-v4.1-flash', 'deepseek-v4-pro-ioa'],
  // WorkBuddyAI 自制目录（product.json 顶层 37 项，按其 credits 排序：免费的在前）
  'codebuddy-en': ['hy3', 'gpt-5.1-codex-mini', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'minimax-m3', 'gemini-3.0-flash', 'fast-model', 'deepseek-v3-2-volc', 'balanced-model', 'kimi-k2.5', 'kimi-k2.6', 'default-model-lite', 'glm-5.3', 'glm-5.2', 'glm-5.0', 'gpt-5.1-codex', 'gemini-2.5-pro', 'gemini-3.5-flash', 'gpt-5.3-codex', 'gemini-3.1-pro', 'gpt-5.6-terra', 'kimi-k3', 'gpt-5.4', 'primary-model', 'default-model', 'deep-model', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-luna'],
  // WorkBuddy 国内桌面自制目录（product.json：applicationName=WorkBuddy）
  'workbuddy': ['auto', 'hy4-preview', 'hy3', 'hy3-x', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3', 'minimax-m2.7', 'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro']
}

// 这两个后端的候选**严格以自己安装的 product 描述文件为准**，不与静态表做并集。
// 原因见上：并集会把另一个产品面的型号混进来（如把 npm 面的 hy4-preview /
// deepseek-v4.1-flash 塞给 WorkBuddyAI，而后者根本没有这两个型号）。
const BACKEND_STRICT_CATALOG = { 'codebuddy-en': true, 'workbuddy': true }

// 各后端 product 描述文件的位置。
//
// ⚠ v1.4.0 的教训：**不要用 product 描述文件当权威清单**。它的 agents.cli.models
// 是发行版内置候选，含大量该账号不存在的 id（实测 default-model / primary-model /
// gpt-6-astra 均报 "service info not found"）。此处保留读取能力仅为：
//   1) `backendModelCatalog()` 的**兜底**（静态表也读不到时）；
//   2) 用户自定义 product 面（CODEBUDDY_*_MODELS_FILE 覆盖）时仍能生效。
// workbuddy 的 rel 已从 product.cloudhosted.json 修正为 product.json —— 后者才是
// 该安装真正的产品面（applicationName=WorkBuddy / auth.id=workbuddy-desktop /
// endpoint=copilot.tencent.com），cloudhosted 那份的 endpoint 与 auth.id 均为空。
const // 各后端真正生效的 product 描述文件。
//
// ★ v1.6.0 关键修正：CLI 运行时读的不是 `product.json`，而是 **`product.${env}.json`**。
//   证据（npm CLI dist/codebuddy.js，ClientInternetEnviromentProductProvider）：
//     let em = eg.toLowerCase();
//     let eE = `product.${em}.json`;
//   其中 eg 依次取 settings.env / CODEBUDDY_INTERNET_ENVIRONMENT / networkEnvironment /
//   productConfigEnv.code。该分支失败才回退到内嵌的 product.json。
//
//   实测本机各安装（顶层 models[] 项数）：
//     npm codebuddy-code : product.json=22, product.ioa.json=53, product.internal.json=32
//     WorkBuddy 国内版   : product.json=48, product.ioa.json=93, product.internal.json=46
//     WorkBuddyAI 国际版 : product.json=37（无 ioa/internal 变体）
//
//   这正是用户反馈「模型获取错误」的根因：国内版真实菜单（Claude-Opus-4.8 / GPT-5.4 /
//   GLM-5.2 / MiniMax-M2.7 / Deepseek-V4-Pro / default）全在 product.ioa.json 里，
//   而此前四个后端一律读 product.json，所以既缺型号又近乎重复。
//
//   rel 按「先 ioa 变体、后裸 product.json 兜底」排列：若某安装没有 ioa 变体
//   （如 WorkBuddyAI），候选链会自然落到 product.json。
PRODUCT_DESCRIPTOR_ENV = {
  'codebuddy': { env: 'CODEBUDDY_MODELS_FILE', rel: 'product.ioa.json', fallbackRel: 'product.json', accountDir: null },
  'codebuddy-intl': { env: 'CODEBUDDY_INTL_MODELS_FILE', rel: 'product.ioa.json', fallbackRel: 'product.json', accountDir: null },
  'codebuddy-en': { env: 'CODEBUDDY_EN_MODELS_FILE', rel: 'product.ioa.json', fallbackRel: 'product.json', accountDir: '.workbuddy-ai' },
  'workbuddy': { env: 'WORKBUDDY_MODELS_FILE', rel: 'product.ioa.json', fallbackRel: 'product.json', accountDir: '.workbuddy' }
}

/**
 * 各后端的 product 描述文件的候选路径（按序尝试，返回第一个能读到的）。
 *
 * ★ v1.6.1 关键修正：安装目录里的 product.json 只是**产品面默认值**，不是用户菜单。
 *   用户实际看到的菜单来自**账号级配置**，它在桌面客户端的数据目录里：
 *     ~/.workbuddy-ai/cache/acc-product-config-v3.json   （WorkBuddy AI 国际版，
 *        applicationName=workbuddy-ai, endpoint=www.workbuddy.ai, networkEnvironment=external）
 *     ~/.workbuddy/cache/acc-product-config-v3.json      （WorkBuddy 国内版，
 *        applicationName=WorkBuddy, endpoint=copilot.tencent.com, networkEnvironment=internal）
 *   账号配置才带 `modelPromotions` —— 用户菜单里的「Free now / 夜间免费 / 限时免费」
 *   全部出自这里，而安装目录的 product.json 里**根本没有该字段**。
 *   实测（用户贴图逐条吻合）：
 *     国内版 hy4-preview：基础 x0.29 + promotion「夜间免费」factor=0
 *     国内版 hy3        ：基础 x0.00 + promotion「限时免费」factor=0
 *     国际版 hy3 / hy4-preview / deepseek-v4.1-flash：promotion「Free now」factor=0
 *   候选链因此改为「账号配置在前、产品面描述文件兜底」。
 *
 * `rel` 仍是安装目录内的相对路径（v1.6.0 修正：CLI 读的是 `product.${env}.json`，
 * 见上方注释）；`accountDir` 是该后端的账号配置目录（相对用户主目录），
 * 由上方的 PRODUCT_DESCRIPTOR_ENV 统一声明，此处不再重复定义。
 */

/**
 * 账号级配置文件的候选路径（v1.6.1 新增）。
 * 顺序：cache/acc-product-config-v3.json（客户端缓存）→ local_storage 快照。
 * npm 面（codebuddy / codebuddy-intl）走 CodeBuddy 桌面，无账号配置文件，返回空。
 */
function accountConfigCandidates(backend) {
  const env = (globalThis.process && globalThis.process.env) || {}
  const spec = PRODUCT_DESCRIPTOR_ENV[backend]
  const path = builtinPath()
  if (!spec || !spec.accountDir || !path) return []
  const rel = spec.accountDir.split('/').join(path.sep)
  // 用户主目录：优先 USERPROFILE（Windows），退化 HOME（跨平台/测试注入）
  const home = env.USERPROFILE || env.HOME
  if (!home) return []
  const base = path.join(home, rel)
  return [
    path.join(base, 'cache', 'acc-product-config-v3.json'),
    path.join(base, 'local_storage', 'entry_d43e96994f944cfb77961c2ea7d04605.info'),
    path.join(base, 'local_storage', 'wb_entry_d43e96994f944cfb77961c2ea7d04605.info')
  ]
}

/** 各后端 product 描述文件的候选路径（按序尝试，返回第一个存在的）。 */
function productDescriptorCandidates(backend) {
  const env = (globalThis.process && globalThis.process.env) || {}
  const spec = PRODUCT_DESCRIPTOR_ENV[backend]
  if (!spec) return []
  const out = []
  // 账号级配置优先（带 modelPromotions，与用户菜单一致）
  for (const p of accountConfigCandidates(backend)) out.push(p)
  if (env[spec.env]) out.push(env[spec.env])
  const path = builtinPath()
  const join = path ? path.join : null
  const rels = spec.fallbackRel ? [spec.rel, spec.fallbackRel] : [spec.rel]
  const push = (root) => { if (root && join) for (const r of rels) out.push(join(root, ...r.split('/'))) }
  if (backend === 'codebuddy' || backend === 'codebuddy-intl') {
    push(join && env.APPDATA ? join(env.APPDATA, 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code') : null)
  } else if (backend === 'codebuddy-en') {
    push('C:\\Program Files\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli')
  } else if (backend === 'workbuddy') {
    push('C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli')
  }
  return out
}

/** 取 node:path（不可用时返回 null，调用方自行兜底）。 */
function builtinPath() {
  const proc = globalThis.process
  try {
    return (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule('node:path') : null
  } catch (e) { return null }
}

/**
 * 从 product 描述文件里抽取 CLI 主 agent 的模型清单。
 * 结构：{ agents: [ { name:'cli', models:[...] }, ... ], models: [ {id} | 'id' ] }
 *
 * 取「两处里更完整的那份」而不是死认 agents.cli：真机实测两张表的语义不同 ——
 *   - npm CLI product.json      : agents.cli.models = 21 个真实 id（顶层 models 22 个）
 *   - WorkBuddyAI product.json  : agents.cli.models = 4 个**角色别名**
 *                                 (fast/balanced/primary/deep-model)，真实 37 个 id 在顶层 models
 *   - WorkBuddy cloudhosted     : agents.cli.models = 10 个（顶层 models 23 个）
 * 因此对两份候选取**去重后元素更多**的那份；并列时优先 agents.cli（它才是 --model 的取值域）。
 * 只做容错解析，任何异常返回 null（调用方回退静态表）。
 * @returns {string[]|null}
 */
function extractModelIds(productJson) {
  try {
    const obj = normalizeProductConfig(productJson)
    if (!obj || typeof obj !== 'object') return null
    const pick = (arr) => {
      if (!Array.isArray(arr) || !arr.length) return null
      const ids = arr.map((m) => (typeof m === 'string' ? m : m && m.id)).filter((s) => typeof s === 'string' && s.trim())
      return ids.length ? [...new Set(ids)] : null
    }
    const agents = Array.isArray(obj.agents) ? obj.agents : []
    const cli = agents.find((a) => a && a.name === 'cli')
    const fromCli = cli ? pick(cli.models) : null
    const fromTop = pick(obj.models)
    if (fromCli && fromTop) return fromTop.length > fromCli.length ? fromTop : fromCli
    return fromCli || fromTop || null
  } catch (e) { return null }
}

/**
 * 归一化账号配置：可能是**单个** product 对象，也可能是**数组**。
 *
 * 实测（v1.6.1）：桌面客户端的 `local_storage/entry_*.info` 顶层是
 *   [ { userId, data: <product 对象> }, { userId, data: <product 对象> }, ... ]
 * 每个 userId 一份独立配置（本机国际版文件里有 527fed08 与 dc632238 两个账号）。
 * 取**最后一份**（最新的写入在末尾）。而 `cache/acc-product-config-v3.json`
 * 是裸的单个 product 对象。两种形态都要能解析。
 *
 * @returns {object|null} 归一化后的 product 对象
 */
function normalizeProductConfig(raw) {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!obj) return null
    if (Array.isArray(obj)) {
      // 数组形态：从后往前找第一个带 data 的条目（末尾最新）
      for (let i = obj.length - 1; i >= 0; i--) {
        const e = obj[i]
        if (e && typeof e === 'object' && e.data && typeof e.data === 'object') return e.data
      }
      return null
    }
    if (typeof obj !== 'object') return null
    // 单个对象：若本身是 { data: {...} } 形态也剥一层
    if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.models) && !Array.isArray(obj.agents)) return obj.data
    return obj
  } catch (e) { return null }
}

/**
 * 从 product 描述文件里解析**每个模型的倍率**（credits 字段）。
 *
 * 真机实测字段形态（三种安装一致）：
 *   "credits": "x0.29 credits"   ← 常见形态
 *   "credits": "x0.00"           ← 偶尔省略 " credits" 后缀
 *   "credits": ""                ← 缺失/空串（如 npm 的 default-model、国内版 39 项）
 * 因此只认 `x<数字>` 前缀，其余一律视为**无倍率数据**（返回 null），
 * 绝不猜 0 —— 0 表示「免费」，与「未知」是两回事，混淆会让用户误判成本。
 *
 * @returns {Map<string, number>|null} id → 倍率（数字）。无任何倍率数据时返回 null。
 */
function extractModelCredits(productJson) {
  try {
    const obj = normalizeProductConfig(productJson)
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.models)) return null
    const map = new Map()
    for (const m of obj.models) {
      if (!m || typeof m !== 'object') continue
      const id = typeof m.id === 'string' ? m.id.trim() : ''
      if (!id) continue
      const n = parseCreditValue(m.credits)
      if (n !== null) map.set(id, n)
    }
    return map.size ? map : null
  } catch (e) { return null }
}

/**
 * 解析单个倍率字符串。`"x0.29 credits"` → 0.29；`"x0.00"` → 0；无效/空 → null。
 * 兼容全角 x/大写 X，以及小数点前后无数字的写法。
 */
function parseCreditValue(raw) {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  // 形态一（描述文件/账号配置的 models[].credits）：`x0.29 credits`、`x0.00`
  let m = s.match(/^[xX×]\s*([0-9]+(?:\.[0-9]+)?)/)
  // 形态二（账号配置 modelPromotions[].discount.discountedCredits）：`0.00x`、`0x`
  // —— 数字在前、x 在后，与形态一恰好相反，不兼容会漏掉「Free now」这类促销价。
  if (!m) m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*[xX×]/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/**
 * 把倍率格式化成面板/描述里挂的短标签。
 *   0      → '免费'
 *   0.29   → 'x0.29'
 *   1.2    → 'x1.20'（统一两位小数，便于竖排对齐）
 *   null   → ''（无数据，调用方直接不挂）
 */
function formatCreditLabel(credits) {
  if (typeof credits !== 'number' || !Number.isFinite(credits)) return ''
  if (credits === 0) return '免费'
  return `x${credits.toFixed(2)}`
}

/**
 * 某后端的模型候选清单（面板下拉用）。
 *
 * **优先级（v1.4.1 修正）**：内置静态表（= 真机按账号实测的可用清单）**为主**，
 * product 描述文件里的发行版候选表**只做并集补充**。v1.4.0 反了 —— 那时以
 * product.json 为主，结果把该账号根本不存在的 id（default-model / primary-model /
 * gpt-6-astra）当成了候选项。静态表在前也保证下拉里最靠谱的排前面。
 *
 * 永不抛错；文件读不到就用静态表。
 * @param {string} backend
 * @param {{readFileSync?:Function}} [io] 测试注入
 * @returns {string[]}
 */
function backendModelCatalog(backend, io) {
  const known = BACKEND_MODEL_IDS[backend] || []
  const read = (io && io.readFileSync) || ((p, enc) => {
    const proc = globalThis.process
    const fs = (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule('node:fs') : null
    if (!fs) throw new Error('no fs')
    return fs.readFileSync(p, enc)
  })
  let fromFile = null
  let fromFileRich = null
  // ★ v1.6.1：账号配置排在候选链最前（见 productDescriptorCandidates），
  //   所以这里取到的就是用户菜单实际使用的清单。
  //
  //   但**不能只认第一份**：实测国际版 cache/acc-product-config-v3.json 停在
  //   旧时间点（37 项、无促销、且**没有 hy4-preview / deepseek-v4.1-flash**），
  //   而更新的 local_storage 快照（26 项）才带这三条 Free now 促销 ——
  //   后者才是用户菜单看到的。因此同时记录「第一份有内容的」与「第一份带促销的」，
  //   优先取后者：modelPromotions 是账号级配置独有的字段，有它说明该文件更新。
  for (const p of productDescriptorCandidates(backend)) {
    let txt = null
    try { txt = read(p, 'utf8') } catch (e) { continue }
    const ids = extractModelIds(txt)
    if (ids && ids.length) {
      if (!fromFile) fromFile = ids
      if (!fromFileRich && extractModelPromotions(txt)) fromFileRich = ids
    }
    if (fromFileRich) break
  }
  if (!fromFile) return known
  const fromFileIds = fromFileRich || fromFile
  // ★ v1.6.0：四个后端一律**以自己安装的描述文件为准**，不再对 npm 面做静态表并集。
  //
  // 理由：v1.5.0 之前把「静态实测表」排在前、文件内容追加在后，结果是两处都不准 ——
  // 静态表是 2026-09 某一时刻的账号快照，既缺 CLI 真实菜单里的型号
  // （claude-opus-4.8、gpt-5.4、default…），又会把 CLI 已下架的 id 一直留着。
  // 而 `product.${env}.json` 是 CLI **运行时真正加载**的那份，是唯一权威。
  // 静态表降级为「读不到文件时的兜底」，只在 fromFile 为 null 时生效（见上方 return known）。
  //
  // 账号级授权仍由服务端实时裁决（parseAccountModels / 400 报文），与本表无关。
  return fromFileIds
}

/** 兼容旧名（v1.4.0 引入时的函数名）。 */
const readBackendModelCatalog = backendModelCatalog

/**
 * 从账号级配置里抽取**促销**规则（v1.6.1 新增）。
 *
 * 用户菜单里的「Free now / 夜间免费 / 限时免费」全部出自账号配置的
 * `modelPromotions` 数组，而安装目录的 product.json **没有该字段** —— 这正是
 * 此前「模型获取错误」的最后一层：基础倍率读对了，促销一律看不到。
 *
 * 单条结构（实测）：
 *   { badge: { label:'夜间免费', color:'#1E90FF' },
 *     discount: { discountedCredits:'0.00x', factor:0, displayMode:'strikethrough' },
 *     enabled: true,
 *     modelIds: ['hy4-preview','hy4-preview-dev'],
 *     schedule: { daily:[{start:'23:00',end:'8:00'}], timezone:'Asia/Shanghai',
 *                 validFrom:'2026-09-11T00:00:00+08:00', validUntil:'2026-11-01T00:00:00+08:00' } }
 *
 * 同一型号可能有多条（一条负责时段内、一条负责时段外显示角标），调用方按优先级取。
 *
 * @returns {Array<{id:string,label:string,color:string,factor:number|null,
 *                  discountedCredits:string|null,priority:number,schedule:object|null}>|null}
 */
function extractModelPromotions(configJson) {
  try {
    const obj = normalizeProductConfig(configJson)
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.modelPromotions)) return null
    const out = []
    for (const p of obj.modelPromotions) {
      if (!p || typeof p !== 'object' || p.enabled === false) continue
      const label = (p.badge && typeof p.badge.label === 'string') ? p.badge.label.trim() : ''
      const ids = Array.isArray(p.modelIds) ? p.modelIds : []
      if (!label || !ids.length) continue
      const d = (p.discount && typeof p.discount === 'object') ? p.discount : null
      const factor = (d && typeof d.factor === 'number' && Number.isFinite(d.factor)) ? d.factor : null
      const raw = (d && typeof d.discountedCredits === 'string') ? d.discountedCredits.trim() : null
      for (const id of ids) {
        if (typeof id !== 'string' || !id.trim()) continue
        out.push({
          id: id.trim(),
          label,
          color: (p.badge && typeof p.badge.color === 'string') ? p.badge.color : '',
          factor,
          discountedCredits: raw,
          priority: Number.isFinite(p.priority) ? p.priority : 0,
          schedule: (p.schedule && typeof p.schedule === 'object') ? p.schedule : null
        })
      }
    }
    return out.length ? out : null
  } catch (e) { return null }
}

/**
 * 判断一条促销在给定时刻是否**正在生效**（v1.6.1 新增）。
 *
 * 判定分两段，都要过：
 *   1. 有效期 validFrom/validUntil（闭区间外即失效）；
 *   2. 时段：schedule.daily 是一组 {start,end} 的 'HH:MM' 区间，可跨零点
 *      （实测「夜间免费」为 [{start:'23:00',end:'8:00'}]，跨零点）；
 *      无 daily 字段表示全天有效（如「限时免费」validFrom 7/6–validUntil 11/01）。
 *
 * 时区按 schedule.timezone 处理，但为避免依赖 Intl 的时区数据库（preset/dynamic
 * 沙箱里不可用），这里用**本地时间**近似：本机即 Asia/Shanghai，实测一致。
 * 这是有意的取舍 —— 宁可时段判定在跨时区机器上偏保守，也不要因缺失 API 而抛错。
 *
 * @param {object} promo extractModelPromotions 的单项
 * @param {Date} [now] 注入当前时间（测试用）
 */
function isPromotionActive(promo, now) {
  if (!promo) return false
  const t = (now instanceof Date) ? now : new Date()
  const ms = t.getTime()
  if (!Number.isFinite(ms)) return false
  const sch = promo.schedule
  if (!sch) return true
  const vf = Date.parse(sch.validFrom)
  const vu = Date.parse(sch.validUntil)
  if (Number.isFinite(vf) && ms < vf) return false
  if (Number.isFinite(vu) && ms >= vu) return false
  const daily = Array.isArray(sch.daily) ? sch.daily : null
  if (!daily || !daily.length) return true
  const cur = t.getHours() * 60 + t.getMinutes()
  const toMin = (s) => {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})/)
    if (!m) return null
    const v = Number(m[1]) * 60 + Number(m[2])
    return Number.isFinite(v) ? v : null
  }
  for (const w of daily) {
    if (!w || typeof w !== 'object') continue
    const st = toMin(w.start)
    const en = toMin(w.end)
    if (st === null || en === null) continue
    // 跨零点：start > end 时区间为 [start, 1440) ∪ [0, end)
    if (st <= en) { if (cur >= st && cur < en) return true } else if (cur >= st || cur < en) return true
  }
  return false
}

/**
 * 取某型号**当前生效**的促销标签（多条命中时取 priority 最大者）。
 * @returns {{label:string,color:string,factor:number|null,discountedCredits:string|null}|null}
 */
function activePromotionFor(promotions, id, now) {
  if (!Array.isArray(promotions) || !id) return null
  let best = null
  for (const p of promotions) {
    if (!p || p.id !== id) continue
    if (!isPromotionActive(p, now)) continue
    if (!best || (p.priority || 0) > (best.priority || 0)) best = p
  }
  if (!best) return null
  return { label: best.label, color: best.color, factor: best.factor, discountedCredits: best.discountedCredits }
}

/**
 * 从 CLI 报错里解析服务端返回的「该账号当前支持的模型」清单。
 *
 * 真机实测：给 CLI 传一个不存在的 model，服务端会在 400 里回
 *   400 model [xxx] service info not found (…)
 *   Currently supported models for your account:
 *     - hy4-preview
 *     - hy3
 *     …
 * 这是**按账号实时**的权威清单，比任何静态文件/内置表都准。
 * @param {string} text CLI 的 stderr/stdout
 * @returns {string[]|null} 解析失败返回 null
 */
function parseAccountModels(text) {
  const s = String(text || '')
  const anchor = s.indexOf('Currently supported models for your account')
  if (anchor < 0) return null
  const tail = s.slice(anchor)
  const ids = []
  for (const line of tail.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+(\S+)\s*$/.exec(line)
    if (!m) {
      // 遇到非列表行且已收集到条目 → 清单结束
      if (ids.length) break
      continue
    }
    if (!ids.includes(m[1])) ids.push(m[1])
  }
  return ids.length ? ids : null
}

/**
 * 某后端模型候选的**详细清单**：每个模型带上倍率与展示标签（v1.5.0）。
 *
 * 倍率来源与 id 来源同源 —— 都读该后端自己的 product 描述文件，所以**用户升级
 * CLI 后重启即自动同步**，无需改插件。倍率取自顶层 `models[].credits`
 * （`agents.cli.models` 只是字符串数组，不带倍率，故必须读顶层）。
 *
 * 返回项：
 *   { id, credits, free, label, hasCredits }
 *   label = `id · 免费` 或 `id · x0.29`；无倍率数据时不挂后缀（只留 id）。
 * 排序：**有倍率数据的在前并按倍率升序**（用户一眼看出哪个便宜），无数据的殿后
 * 且保持原有相对顺序（稳定排序）。这样「免费」的模型总是排在最前面。
 *
 * 永不抛错；读不到文件时全部项 hasCredits=false，仍返回完整 id 列表。
 * @param {string} backend
 * @param {{readFileSync?:Function}} [io] 测试注入
 * @returns {Array<{id:string,credits:number|null,free:boolean,label:string,hasCredits:boolean}>}
 */
/**
 * 倍率查找：把「账号清单里的 id」映射到「描述文件里的 id」。
 *
 * v1.6.0 实测：两处命名不一致，必须跨命名匹配，否则绝大多数型号挂不上倍率 ——
 *   账号清单（服务端实时，可用）：glm-5.3      / minimax-m2.7 / kimi-k2.6
 *   描述文件（CLI 目录，带后缀）：glm-5.3-ioa  / minimax-m2.7-ioa / kimi-k2.6-ioa
 * 匹配顺序：精确同名 → 去/加 `-ioa` 后缀 → 已知别名表。
 */
const CREDIT_ID_ALIASES = {
  // 账号清单里的 id → 描述文件里的 id（实测比对得出）
  'kimi-k3-1': ['kimi-k3', 'kimi-k3-ioa'],   // 同一个 Kimi-K3，倍率 x1.62
  'hy3-x': ['hy3', 'hy3-ioa'],               // Hy3 的变体，同为免费
  'default': ['codewise-default-model-v2'],  // default 是别名
  'auto': ['hy3', 'hy3-ioa']                 // auto 由服务端决定，展示上按最便宜的免费档
}

function lookupModelCredits(creditsMap, id) {
  if (!creditsMap || typeof id !== 'string') return null
  const norm = id.trim()
  const cands = [norm]
  if (norm.endsWith('-ioa')) cands.push(norm.slice(0, -4))
  else cands.push(norm + '-ioa')
  if (CREDIT_ID_ALIASES[norm]) cands.push(...CREDIT_ID_ALIASES[norm])
  for (const c of cands) {
    if (creditsMap.has(c)) {
      const v = creditsMap.get(c)
      if (typeof v === 'number') return v
    }
  }
  return null
}

/**
 * 该后端的「服务端账号清单」缓存（进程内）。由 run/continue 的真实调用回填：
 * CLI 报 400 时会回吐 Currently supported models，那是**唯一权威的可用清单**。
 * 面板打开时若已有缓存就直接用，否则退化为描述文件全量。
 */
const ACCOUNT_CATALOG_CACHE = new Map()

/** 记录一次服务端回吐的账号清单（供后续面板/描述使用）。 */
function rememberAccountCatalog(backend, ids) {
  if (Array.isArray(ids) && ids.length) ACCOUNT_CATALOG_CACHE.set(backend, ids.slice())
}

/** 读取已缓存的账号清单（无则 null）。 */
function getAccountCatalog(backend) {
  const v = ACCOUNT_CATALOG_CACHE.get(backend)
  return v && v.length ? v.slice() : null
}

/**
 * 生成某后端的模型详细清单（含倍率与授权状态）。
 *
 * 数据来源按可靠性排序：
 *   1) 服务端账号清单 —— 实测可用，最准（由 rememberAccountCatalog 回填，
 *      或经 io.accountModels 显式传入，供宿主层做一次 `--model <不存在>` 探测后注入）；
 *   2) 描述文件 product.${env}.json —— CLI 运行时真正加载的目录（含未授权型号）。
 * 两者合并：账号清单里的标 authorized:true 且排在前，描述文件独有的标 authorized:false。
 * 倍率一律从描述文件取，并跨 `-ioa` 命名匹配（见 lookupModelCredits）。
 *
 * @param {string} backend
 * @param {{readFileSync?:Function, accountModels?:string[]}} [io] 测试/宿主注入
 * @returns {Array<{id,credits,free,label,hasCredits,authorized}>}
 */
function modelCatalogDetailed(backend, io) {
  const fromFile = backendModelCatalog(backend, io)
  const acct = (io && Array.isArray(io.accountModels) && io.accountModels.length)
    ? io.accountModels
    : getAccountCatalog(backend)
  const ids = []
  const authorized = new Set()
  if (acct) for (const id of acct) { if (!ids.includes(id)) ids.push(id); authorized.add(id) }
  for (const id of fromFile) if (!ids.includes(id)) ids.push(id)
  const read = (io && io.readFileSync) || ((p, enc) => {
    const proc = globalThis.process
    const fs = (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule('fs') : null
    if (!fs) throw new Error('no fs')
    return fs.readFileSync(p, enc)
  })
  let creditsMap = null
  let promotions = null
  // ★ v1.6.1：倍率与促销都从**同一个**候选链取，但各自独立扫描 ——
  //   账号配置（带 modelPromotions）排在最前，若它不含 credits 字段
  //   （实测国际版 local_storage 有 credits、国内版 acc-product-config 也有），
  //   则继续往下找到能提供该字段的那份，两种数据可来自不同文件。
  //
  //   注意：**不能读到一份就 break**。实测国际版的 cache/acc-product-config-v3.json
  //   可能停在很旧的时间点（本机为 01:33，无 modelPromotions、无 hy4-preview），
  //   而它在候选链里排第一，会遮蔽后面更新的 local_storage 快照。因此这里扫完
  //   整条链、按字段各自取第一个「有内容」的结果，而不是取第一个能读到的文件。
  for (const p of productDescriptorCandidates(backend)) {
    let txt = null
    try { txt = read(p, 'utf8') } catch (e) { continue }
    if (!creditsMap) {
      const map = extractModelCredits(txt)
      if (map) creditsMap = map
    }
    if (!promotions) {
      const promo = extractModelPromotions(txt)
      if (promo) promotions = promo
    }
    if (creditsMap && promotions) break
  }
  const now = (io && io.now instanceof Date) ? io.now : new Date()
  const items = ids.map((id) => {
    // 促销优先参与倍率计算：命中时以促销价为实付（factor=0 即免费），
    // 这样「夜间免费」「Free now」的型号会正确落到免费段。
    const promo = activePromotionFor(promotions, id, now)
    const base = lookupModelCredits(creditsMap, id)
    let credits = base
    if (promo) {
      if (promo.factor !== null) {
        // factor 是折扣系数（0=免费，0.5=五折）。基价缺失时无法相乘，退回促销标注值。
        credits = (typeof base === 'number') ? base * promo.factor : parseCreditValue(promo.discountedCredits || '')
      } else {
        const d = parseCreditValue(promo.discountedCredits || '')
        if (d !== null) credits = d
      }
    }
    const hasCredits = typeof credits === 'number'
    const suffix = formatCreditLabel(credits)
    const marks = []
    if (suffix) marks.push(suffix)
    // ★ v1.6.1：促销标签紧跟倍率之后（用户菜单里的「Free now / 夜间免费 / 限时免费」）
    if (promo) marks.push(promo.label)
    if (acct && !authorized.has(id)) marks.push('未授权')
    return {
      id,
      credits,
      baseCredits: base,
      free: hasCredits && credits === 0,
      hasCredits,
      authorized: acct ? authorized.has(id) : null,
      promotion: promo,
      label: marks.length ? `${id} · ${marks.join(' · ')}` : id
    }
  })
  // 排序：已授权在前 → 有倍率在前且升序 → 无倍率殿后（各段内部保持稳定）
  const rank = (x) => (x.authorized === false ? 1 : 0)
  const withC = items.filter((x) => x.hasCredits).sort((a, b) => rank(a) - rank(b) || a.credits - b.credits)
  const withoutC = items.filter((x) => !x.hasCredits).sort((a, b) => rank(a) - rank(b))
  return [...withC, ...withoutC]
}

/**
 * 详细清单的紧凑文本形式，供工具描述/提示词挂载（`id · 倍率` 逗号分隔）。
 * 倍率数据缺失时退化为纯 id 列表。
 */
function formatModelCatalogText(backend, io) {
  return modelCatalogDetailed(backend, io).map((x) => x.label).join(', ')
}

// 各后端的用户可见名（面板下拉标签；产品面与登录域互斥，故按面分列）。
// v1.3.3 正名：国际面安装目录就叫 WorkBuddyAI（`C:\Program Files\WorkBuddyAI`），
// 旧标签「CodeBuddy 国际版」让人误以为 WorkBuddy 国际版另有一个后端。规范 id
// 保持 codebuddy-en（历史会话按其归档，不可改），别名见 BACKEND_ALIASES。
const BACKEND_LABELS = {
  'codebuddy': 'CodeBuddy 国内版（npm CLI）',
  'codebuddy-intl': 'CodeBuddy 国际版（npm CLI · 国际面）',
  'codebuddy-en': 'WorkBuddy 国际版（WorkBuddyAI 桌面 CLI）',
  'workbuddy': 'WorkBuddy 国内版（桌面 CLI）'
}

// 后端参数别名（v1.3.3 起）：workbuddy-en / workbuddy-ai 规范化到 codebuddy-en。
// v1.4.0 起：codebuddy-intl 也接受 codebuddy-ioa / codebuddy-international 写法。
const BACKEND_ALIASES = {
  'workbuddy-en': 'codebuddy-en',
  'workbuddy-ai': 'codebuddy-en',
  'codebuddy-ioa': 'codebuddy-intl',
  'codebuddy-international': 'codebuddy-intl',
  'codebuddy-oversea': 'codebuddy-intl'
}

// ── codebuddy-en 凭据的第三条通道：DSH 自己的凭据库 ─────────────────────────────
//
// 国际版 token 被桌面 App 的 protector key 封装、密钥不落盘，headless CLI 读不到；
// 但**用户往往已经在 DSH 里配好了同一个 token** —— DSH 的 provider 配置里有一个
// 指向 https://www.workbuddy.ai/v2 的 workbuddy provider（apiKeyEnv: WORKBUDDY_TOKEN），
// 其值就存在 dsh-home 的 .credentials.yaml / .env 里。
//
// 实测（真机）：把该 token 经 CODEBUDDY_AUTH_TOKEN 下发给 WorkBuddyAI 自带 CLI，
// 无 BASE_URL 即返回 PONG —— 所以「自动复用 DSH 已配好的 workbuddy token」能让
// codebuddy-en 开箱即用，用户无需手工粘贴。
//
// 优先级：设置面板 codebuddyEnToken > 环境变量 CODEBUDDY_AUTH_TOKEN > DSH 凭据库。
// 读取失败一律 null（退回「让用户填」的提示路径），不抛错。
const CREDENTIAL_KEYS = ['WORKBUDDY_TOKEN', 'WORKBUDDY_AI_TOKEN', 'CODEBUDDY_EN_TOKEN']

/** 取 dsh-home 根（与 MCP/动态形态的设置文件同源逻辑，此处只用于读凭据）。 */
function dshHomeDir() {
  const proc = globalThis.process
  if (!proc || !proc.env) return null
  return proc.env.DSH_HOME || null
}

/**
 * 从 dsh-home 的 .credentials.yaml / .env 里取一个可用的 workbuddy token。
 * 只做最小解析（不引 YAML 依赖）：按行匹配 `KEY:` 或 `KEY=`，去掉引号。
 * CODEBUDDY_CREDENTIALS_DIR 可覆盖（测试夹具目录，使用例与真机凭据解耦）。
 * @returns {string|null}
 */
function readDshWorkbuddyToken() {
  const proc = globalThis.process
  const overrideDir = proc && proc.env ? proc.env.CODEBUDDY_CREDENTIALS_DIR : null
  const home = overrideDir || dshHomeDir()
  if (!home) return null
  let nodeFs = null
  try {
    nodeFs = (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule('node:fs') : null
  } catch (e) { nodeFs = null }
  if (!nodeFs) return null
  const files = [home + '\\.credentials.yaml', home + '\\.env']
  for (const f of files) {
    let text = ''
    try { text = nodeFs.readFileSync(f, 'utf8') } catch (e) { continue }
    for (const key of CREDENTIAL_KEYS) {
      // 匹配 `KEY:` / `KEY =` / `KEY=`，值到行尾（去掉引号与注释）
      const m = text.match(new RegExp('^[ \\t]*' + key + '[ \\t]*[:=][ \\t]*(.+)$', 'm'))
      if (!m) continue
      const v = m[1].trim().replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '').trim()
      // 只接受看起来是真实 token 的值（避免把 $VAR 引用或占位符当凭据）
      if (v.length >= 40 && !v.startsWith('$') && !/^<.*>$/.test(v)) return v
    }
  }
  return null
}

/**
 * 解析 codebuddy-en 的最终凭据。
 * @param {string} [settingToken] 设置面板 codebuddyEnToken
 * @returns {{token:string|null, source:'setting'|'env'|'dsh-store'|null}}
 */
function resolveEnToken(settingToken) {
  const s = String(settingToken || '').trim()
  if (s) return { token: s, source: 'setting' }
  const proc = globalThis.process
  const envTok = (proc && proc.env && proc.env.CODEBUDDY_AUTH_TOKEN) || ''
  if (String(envTok).trim()) return { token: String(envTok).trim(), source: 'env' }
  const fromStore = readDshWorkbuddyToken()
  if (fromStore) return { token: fromStore, source: 'dsh-store' }
  return { token: null, source: null }
}

/** 是否为已注册后端名。 */
function isBackend(v) {
  return BACKENDS.indexOf(v) >= 0
}

/**
 * 后端名规范化（v1.3.3）：接受别名 workbuddy-en / workbuddy-ai → codebuddy-en
 * （WorkBuddy 国际版就是 WorkBuddyAI 桌面自带 CLI，规范 id 不动以保证历史会话
 * 归档路由）；大小写不敏感；非后端名原样返回（由调用方的 isBackend 兜底）。
 */
function normalizeBackend(v) {
  if (typeof v !== 'string') return v
  const lower = v.trim().toLowerCase()
  const aliased = BACKEND_ALIASES[lower] || lower
  return BACKENDS.indexOf(aliased) >= 0 ? aliased : v
}

// ── 桥接设置文件（v1.3.2 可视化配置界面的持久层）─────────────────────────────
// 单一事实来源：<dsh-home>/codebuddy-bridge-settings.json
//   { "preferredBackend": "...", "defaultModel": "...",
//     "codebuddyEnToken": "...", "endpointOverride": "...", "updatedAt": <ms> }
// 写入方：codebuddy-indicator 的 POST /codebuddy-indicator/settings 路由（唯一写者，
// 原子写 tmp+rename）。读取方：preset 桥接（每次读取，面板改完下一次调用即生效）、
// 动态形态（apply 时一次）、MCP server（5s 缓存）。三种运行形态与设置面板从此一致。
// 环境变量：DSH_HOME 定位；CODEBUDDY_SETTINGS_FILE 整体覆盖（测试注入任意路径）。
const SETTINGS_FILE_NAME = 'codebuddy-bridge-settings.json'
const SETTINGS_KEYS = ['preferredBackend', 'defaultModel', 'codebuddyEnToken', 'endpointOverride']

function builtinModule(name) {
  try {
    const proc = globalThis.process
    return (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule(name) : null
  } catch (e) { return null }
}

/** 设置文件绝对路径（定位失败 → null；CODEBUDDY_SETTINGS_FILE 优先）。 */
function bridgeSettingsPath() {
  const proc = globalThis.process
  const env = (proc && proc.env) || null
  try {
    if (env && env.CODEBUDDY_SETTINGS_FILE) return env.CODEBUDDY_SETTINGS_FILE
    const nodePath = builtinModule('node:path')
    const home = env ? (env.DSH_HOME || null) : null
    if (nodePath && home) return nodePath.join(home, SETTINGS_FILE_NAME)
  } catch (e) { }
  return null
}

/**
 * 读设置文件。文件缺失/损坏/无法定位 → null（调用方据此回退到行 config）；
 * 读取成功 → 归一化后的完整快照（垃圾值/缺字段一律清洗为默认值，不抛错）。
 * @param {{readFileSync?:Function, path?:string|null}} [io] 测试注入用读取替身
 */
function readBridgeSettingsFile(io) {
  const o = io || {}
  try {
    const nodeFs = o.readFileSync || (builtinModule('node:fs') || {}).readFileSync
    const p = ('path' in o) ? o.path : bridgeSettingsPath()
    if (!nodeFs || !p) return null
    return normalizeBridgeSettings(JSON.parse(nodeFs(p, 'utf8')))
  } catch (e) { return null }
}

/**
 * 清洗任意来源的设置对象 → 完整快照（垃圾值/缺字段一律落默认值，不抛错）。
 * @param {object|null} raw
 */
function normalizeBridgeSettings(raw) {
  const snap = { preferredBackend: DEFAULT_BACKEND, defaultModel: '', codebuddyEnToken: '', endpointOverride: '' }
  if (!raw || typeof raw !== 'object') return snap
  if (typeof raw.preferredBackend === 'string') {
    // 别名清洗（v1.3.3）：workbuddy-en → codebuddy-en
    const nb = normalizeBackend(raw.preferredBackend)
    if (typeof nb === 'string' && BACKENDS.indexOf(nb) >= 0) snap.preferredBackend = nb
  }
  if (typeof raw.defaultModel === 'string') snap.defaultModel = raw.defaultModel.trim()
  if (typeof raw.codebuddyEnToken === 'string') snap.codebuddyEnToken = raw.codebuddyEnToken.trim()
  if (typeof raw.endpointOverride === 'string') snap.endpointOverride = raw.endpointOverride.trim()
  // 写入时间戳透传（面板可显示"上次保存"；非数字丢弃）。
  if (typeof raw.updatedAt === 'number' && raw.updatedAt > 0) snap.updatedAt = raw.updatedAt
  return snap
}

/**
 * 从 auth 库读取某后端的登录域（auth.domain，明文；v1.3.1 实测三处均明文）。
 * 与 preset/dynamic/MCP 形态各自的本地副本同语义；本版本供 indicator 设置路由
 * 的诊断区使用。CODEBUDDY_AUTH_DIR 可覆盖（测试夹具）。失败返回 null。
 * 命名注意：不叫 readAuthDomain —— 该名字已在 dynamic/host.js 的模板体内有本地
 * 副本，而 core 是以文本注入同一函数作用域的重名函数声明会静默互相覆盖。
 * @param {string} backend
 * @param {{readFileSync?:Function, dir?:string}} [io]
 */
function readBackendAuthDomain(backend, io) {
  const o = io || {}
  const id = BACKEND_AUTH_IDS[backend]
  if (!id) return null
  try {
    const nodeFs = o.readFileSync || (builtinModule('node:fs') || {})
    const read = nodeFs.readFileSync
    if (typeof read !== 'function') return null
    const env = (globalThis.process && globalThis.process.env) || {}
    let dir = o.dir
    if (!dir) {
      const nodePath = builtinModule('node:path')
      dir = env.CODEBUDDY_AUTH_DIR ||
        (nodePath ? nodePath.join(env.LOCALAPPDATA || 'C:\\Users\\lcl\\AppData\\Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
          : (env.LOCALAPPDATA || 'C:\\Users\\lcl\\AppData\\Local') + '\\CodeBuddyExtension\\Data\\Public\\auth')
    }
    const sep = dir.indexOf('\\') >= 0 ? '\\' : '/'
    const raw = JSON.parse(read(dir + sep + id + '.info', 'utf8'))
    const d = raw && raw.auth && raw.auth.domain
    return typeof d === 'string' && d.trim() ? d.trim() : null
  } catch (e) { return null }
}

/**
 * 后端设置元数据（可视化配置界面渲染用）：候选模型、可见名、product 端点、
 * 凭据是否必需。纯数据 + 只读环境，不触发任何 IO。
 */
function backendSettingsMeta(backend, io) {
  const detailed = modelCatalogDetailed(backend, io)
  return {
    id: backend,
    label: BACKEND_LABELS[backend] || backend,
    models: detailed.map((x) => x.id),
    // v1.5.0：带倍率的详细清单，面板下拉直接渲染 x.label（`id · 免费` / `id · x0.29`）
    // v1.6.0：附带 authorized —— true=账号已授权（实测可用）、false=目录里有但本账号无权限、
    //         null=尚未探测过。面板据此把不可用的型号挡在下拉之外并单列「未授权」。
    modelOptions: detailed.map((x) => ({
      id: x.id, label: x.label, credits: x.credits, free: x.free, hasCredits: x.hasCredits, authorized: x.authorized,
      // v1.6.1：把当前生效的促销透传给面板（用于「限时优惠」一览那一行）
      promotion: x.promotion || null, baseCredits: typeof x.baseCredits === 'number' ? x.baseCredits : null
    })),
    productEndpoint: BACKEND_ENDPOINTS[backend] || null,
    needsToken: backend === 'codebuddy-en'
  }
}

/** 全后端元数据（面板渲染下拉与提示用）。 */
function allBackendSettingsMeta(io) {
  return BACKENDS.map((b) => backendSettingsMeta(b, io))
}

/**
 * 诊断一个后端的当前有效配置（不落盘、不联网，纯推导）：
 * 登录域、生效端点、凭据来源、端点/登录域是否一致、下一步可操作提示。
 * @param {string} backend
 * @param {object} settings 已清洗的完整设置快照
 * @param {{readFileSync?:Function,dir?:string,env?:object}} [io] 测试注入
 * @returns {{backend:string,authDomain:string|null,endpoint:string|null,endpointSource:string,
 *            tokenSource:string|null,tokenHint:string,mismatch:boolean,defaultModel:string}}
 */
function diagnoseBackend(backend, settings, io) {
  const o = io || {}
  const env = o.env || (globalThis.process && globalThis.process.env) || {}
  const s = settings || defaultBridgeSettings()
  const authDomain = readBackendAuthDomain(backend, o)
  const override = String(s.endpointOverride || '').trim()
  const byDomain = resolveEndpoint(null, authDomain)
  const endpoint = override || byDomain || BACKEND_ENDPOINTS[backend] || null
  const endpointSource = override ? 'override' : (byDomain ? 'auth-domain' : 'product')
  const tok = resolveEnToken(backend === 'codebuddy-en' ? s.codebuddyEnToken : null)
  return {
    backend: backend,
    authDomain: authDomain,
    endpoint: endpoint,
    endpointSource: endpointSource,
    tokenSource: backend === 'codebuddy-en' ? tok.source : 'not-needed',
    tokenHint: tok.source === 'setting' ? '来自设置面板'
      : tok.source === 'env' ? '来自环境变量 CODEBUDDY_AUTH_TOKEN'
        : tok.source === 'dsh-store' ? '来自 DSH 凭据库（自动复用 WORKBUDDY_TOKEN）'
          : backend === 'codebuddy-en' ? '缺失：国际版 token 不落盘，需在设置面板填写或先在 DSH 配 workbuddy provider'
            : '无需填写（国内版由 CLI 自行登录）',
    mismatch: endpointMismatchHint(backend, authDomain, !!tok.token) !== null,
    hint: endpointMismatchHint(backend, authDomain, !!tok.token) || null,
    defaultModel: String(s.defaultModel || '').trim() || '(CLI 默认)'
  }
}

/** 默认设置快照（设置文件与行 config 都不可用时的最终回退）。 */
function defaultBridgeSettings() {
  return normalizeBridgeSettings(null)
}

/** 面板 POST 的原始 JSON → 完整快照（只接受四个已知字段，全清洗）。 */
function sanitizeBridgeSettings(raw) {
  if (!raw || typeof raw !== 'object') return null
  const picked = {}
  for (const k of SETTINGS_KEYS) if (raw[k] !== undefined) picked[k] = raw[k]
  return normalizeBridgeSettings(picked)
}

/**
 * 原子写设置文件（tmp + rename；目录不存在则创建）。
 * 仅 host 半（codebuddy-indicator 路由）调用 —— 单一写者。
 * @param {object} value 已清洗的完整快照
 * @param {{writeFileSync?:Function, renameSync?:Function, mkdirSync?:Function, path?:string|null}} [io] 测试注入
 * @returns {{ok:boolean, path?:string, error?:string}}
 */
function writeBridgeSettingsFile(value, io) {
  const o = io || {}
  const snap = normalizeBridgeSettings(value)
  snap.updatedAt = Date.now()
  const p = ('path' in o) ? o.path : bridgeSettingsPath()
  if (!p) return { ok: false, error: 'dsh-home not resolved (set DSH_HOME or CODEBUDDY_SETTINGS_FILE)' }
  const nodeFs = o.writeFileSync ? { writeFileSync: o.writeFileSync, renameSync: o.renameSync, mkdirSync: o.mkdirSync, rmSync: o.rmSync } : builtinModule('node:fs')
  if (!nodeFs || typeof nodeFs.writeFileSync !== 'function') return { ok: false, error: 'fs unavailable' }
  try {
    const nodePath = builtinModule('node:path')
    const dir = nodePath ? nodePath.dirname(p) : p.replace(/[\\/][^\\/]+$/, '')
    if (dir && typeof nodeFs.mkdirSync === 'function') { try { nodeFs.mkdirSync(dir, { recursive: true }) } catch (e) { } }
    const text = JSON.stringify(snap, null, 2)
    if (typeof nodeFs.renameSync === 'function') {
      const tmp = p + '.' + ((globalThis.process && globalThis.process.pid) || 0) + '.tmp'
      try {
        nodeFs.writeFileSync(tmp, text, 'utf8')
        nodeFs.renameSync(tmp, p)
      } catch (e) {
        try { if (typeof nodeFs.rmSync === 'function') nodeFs.rmSync(tmp, { force: true }) } catch (e2) { }
        throw e
      }
    } else {
      nodeFs.writeFileSync(p, text, 'utf8')
    }
    return { ok: true, path: p }
  } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
}

/**
 * 解析本次调用的后端：显式 args.backend > 会话/项目归属（resolveTarget 给出）>
 * 用户偏好 preferredBackend > DEFAULT_BACKEND。cwd 兜底由调用方传。
 * @param {{backend?:string}} args 工具入参
 * @param {{backend?:string|null}} target resolveTarget 的会话路由结果
 * @param {string} [preferredBackend] 设置面板里的用户偏好（默认 CLI）
 */
function resolveBackend(args, target, preferredBackend) {
  if (args && isBackend(normalizeBackend(args.backend))) return normalizeBackend(args.backend)
  if (target && target.backend && isBackend(normalizeBackend(target.backend))) return normalizeBackend(target.backend)
  if (preferredBackend && isBackend(normalizeBackend(preferredBackend))) return normalizeBackend(preferredBackend)
  return DEFAULT_BACKEND
}

/**
 * 后端对应的端点/凭据环境变量注入（随 spawn spec.env 下发，DSH subprocess 服务
 * 会在 scrub 后的父环境上合并该表）。
 *
 * 三条规则（全部由实测矩阵支撑，见 docs/ROOT-CAUSE-codebuddy-en.md）：
 *  1. 端点：仅当解析出的端点与后端 product 端点**不同**时才注入 CODEBUDDY_BASE_URL。
 *     默认后端 codebuddy 的 product 端点是 www.codebuddy.ai，而其登录 token 域是
 *     www.codebuddy.cn —— 不注入覆盖就必然 401，所以这条覆盖是**功能修复**而非优化。
 *  2. 凭据：codebuddy-en 的国际 token 被 protector key 封装，该密钥只经桌面 App 的
 *     sidecar 通道下发、不落盘（全盘 51612 文件扫描 + 全部 DPAPI blob 解包均未命中，
 *     CLI 自身亦以 category:"missing-key" 失败）。故国际后端只能由用户提供 token，
 *     经 CODEBUDDY_AUTH_TOKEN 下发；缺省时不注入，交由 CLI 报错并转成可操作提示。
 *  3. 不再注入 CODEBUDDY_INTERNET_ENVIROMENT：www.workbuddy.ai 属 product.json 的
 *     externalDomain，声明 cloudhosted 语义错误（v1.3.0 的该行为已删除）。
 *
 * @param {string} backend 已解析的后端名
 * @param {string} [explicitBaseUrl] 用户显式端点覆盖（设置面板）
 * @param {string} [authDomain] 宿主侧读到的登录域
 * @param {string} [authToken] 用户提供的凭据（仅 codebuddy-en 使用）
 * @returns {object|null} 需要注入的环境变量表；无需注入时返回 null
 */
function endpointEnv(backend, explicitBaseUrl, authDomain, authToken) {
  const env = {}
  const endpoint = resolveEndpoint(explicitBaseUrl, authDomain)
  const product = BACKEND_ENDPOINTS[backend]
  if (endpoint && endpointHost(endpoint) !== endpointHost(product)) {
    env.CODEBUDDY_BASE_URL = endpoint
  }
  if (backend === 'codebuddy-en') {
    const tok = String(authToken || '').trim()
    if (tok) env.CODEBUDDY_AUTH_TOKEN = tok
  }
  return Object.keys(env).length ? env : null
}

/**
 * 判断某后端在给定登录域/凭据下是否可能认证失败，返回可操作提示（无问题返回 null）。
 * 只做确定性判断，不猜测网络状况。
 */
function endpointMismatchHint(backend, authDomain, hasToken) {
  if (backend === 'codebuddy-en' && !hasToken) {
    return 'codebuddy-en（WorkBuddy 国际版）没有可用凭据。国际版的登录 token 被桌面 App 的 protector key 封装，该密钥不落盘、headless CLI 无法自行读取（CLI 自身报 category:"missing-key"）。桥接会依次尝试：插件设置 codebuddyEnToken → 环境变量 CODEBUDDY_AUTH_TOKEN → DSH 凭据库（.credentials.yaml / .env 里的 WORKBUDDY_TOKEN）——三者皆空。请在 DSH 里配好 workbuddy provider 的 key，或把国际版 token 填入插件设置；也可直接用 backend="workbuddy"（国内版桌面 CLI，免配置）。'
  }
  if (backend === 'codebuddy-intl') {
    // 真机实测（v1.4.0）：同一个 npm CLI 会接受国际面模型 id，但服务端按账号授权放行 ——
    // `--model claude-sonnet-5` 返回 400 "model [...] is only available for authorized users"，
    // 而国内面 `--model hy4-preview` 正常返回 PONG。故此处提示与「端点/凭据」无关，
    // 是账号授权问题，必须明确区分，避免用户误以为是配置错误。
    return 'codebuddy-intl（CodeBuddy 国际版）使用同一个 npm CLI，但国际面模型由服务端按账号授权放行：未授权时 CLI 返回 400「model [...] is only available for authorized users」。若你用的是国内账号，请改用 backend="codebuddy"（国内面模型清单）或 backend="codebuddy-en"（WorkBuddy 国际版）。'
  }
  const d = String(authDomain || '').trim().toLowerCase()
  if (d && endpointHost(resolveEndpoint(null, d)) !== endpointHost(BACKEND_ENDPOINTS[backend])) {
    return backend + ' 的登录域是 ' + d + '，与产品端点 ' + BACKEND_ENDPOINTS[backend] + ' 不一致；桥接层已自动注入 CODEBUDDY_BASE_URL=' + AUTH_DOMAIN_ENDPOINTS[d] + '。若仍 401，请重新登录对应客户端。'
  }
  return null
}

// MCP 子进程 → 家级插件的快照文件通道（v1.1.5）。
//
// 为什么要文件：codebuddy 在标准（非 codebuddy-first）模式下经**全局 MCP 行**调用，
// 而 MCP 服务器是独立子进程，自己 createStatusEngine，既没有 ctx.emit 也拿不到
// codebuddyCollector 服务 —— 所以家级插件从来收不到 MCP 路径的运行数据，标题栏
// 状态灯在整个调用过程中完全不出现（v1.1.4 及以前）。
// 为什么不走 HTTP 反推：webServer.register 不暴露端口（客户端能工作是因为同源
// 相对 URL），子进程无从发现端口；且端口实测会变（49301 → 58199）。
// 文件通道两端都只需从自身模块位置推导 dsh-home，无需端口、无需服务。
const MCP_BRIDGE_FILE = 'codebuddy-indicator-mcp.json'

// 快照被认为「新鲜」的时长。超时后仍在 running 的项目按「进程已死」处理：
// 子进程可能被强杀而来不及写收尾快照，否则灯会永久转圈。
const MCP_BRIDGE_STALE_MS = 90000

// 把 engine.statusSnapshot() 收窄成可无损 JSON 化的上报载荷（只取叶子字段）。
function buildMcpBridgePayload(snap, pid, nowMs) {
  const s = snap && typeof snap === 'object' ? snap : {}
  const src = Array.isArray(s.projects) ? s.projects : []
  const projects = []
  for (const p of src) {
    if (!p || !p.cwd) continue
    projects.push({
      cwd: String(p.cwd),
      name: p.name ? String(p.name) : '',
      state: p.state ? String(p.state) : 'idle',
      running: Number(p.running) || 0,
      current: p.current ? { stepIndex: Number(p.current.stepIndex) || 0, tool: String(p.current.tool || ''), args: p.current.args || null } : null,
      trail: Array.isArray(p.trail) ? p.trail.slice(-MAX_TRAIL).map(function (e) {
        return { stepIndex: Number(e && e.stepIndex) || 0, tool: String((e && e.tool) || ''), state: String((e && e.state) || ''), args: (e && e.args) || null }
      }) : [],
      lastStatus: p.lastStatus ? String(p.lastStatus) : null,
      lastAt: Number(p.lastAt) || 0,
      lastSessionId: p.lastSessionId ? String(p.lastSessionId) : null,
      lastBackend: p.lastBackend ? String(p.lastBackend) : null,
      fallbackActive: !!p.fallbackActive,
      runs: Number(p.runs) || 0,
      totalTokens: Number(p.totalTokens) || 0,
      updatedAt: Number(p.updatedAt) || 0
    })
  }
  return { source: 'mcp', pid: Number(pid) || 0, updatedAt: Number(nowMs) || 0, projects: projects }
}

// 读侧校验：过期快照里仍在 running 的项目降级为已结束（进程可能被强杀）。
function normalizeMcpBridge(payload, nowMs, staleMs) {
  if (!payload || typeof payload !== 'object') return null
  const projects = Array.isArray(payload.projects) ? payload.projects : []
  const updatedAt = Number(payload.updatedAt) || 0
  const stale = (Number(nowMs) || 0) - updatedAt > (Number(staleMs) || MCP_BRIDGE_STALE_MS)
  const out = []
  for (const p of projects) {
    if (!p || !p.cwd) continue
    if (stale && (Number(p.running) || 0) > 0) {
      out.push(Object.assign({}, p, { running: 0, current: null, state: p.state === 'running' ? 'idle' : p.state }))
    } else out.push(p)
  }
  return { source: 'mcp', pid: Number(payload.pid) || 0, updatedAt: updatedAt, stale: stale, projects: out }
}

// ── 纯函数 ────────────────────────────────────────────────────────────────────

function isLimited(res) {
  if (!res || res.ok) return false
  // 前置凭据缺失（v1.3.1）：配置问题，不是限流。弹「回退/重试」三选一没有意义
  // （重试不会让 token 出现），应直接把可操作指引交回调用方。
  if (res.status === 'AUTH_REQUIRED') return false
  if (res.status === 'SPAWN_ERROR' || res.status === 'CODEBUDDY_UNAVAILABLE' || res.status === 'HUNG_TIMEOUT') return true
  const hay = String(res.stderr || '') + ' ' + String(res.status || '')
  // 401/认证失败（v1.3.0）：endpoint 域与登录域不匹配（如国际端点 + 国内 token）时
  // CLI 报 401 Authentication failed。重试与回退都无济于事 —— 需要用户换登录域，
  // 不应归入限流类（避免弹「回退/重试」三选一误导）。
  if (/401 authentication failed|differs from the current product endpoint/i.test(hay)) return false
  return LIMIT_RE.test(hay)
}

// CLI 侧瞬时错误（v1.1.4）：codebuddy 自己的 result 事件报 subtype=error_during_execution
// 一类失败 —— CLI/服务端跑一半崩了，且**不带任何原因**（result/stderr 全空）。
// 实测同一任务同一默认模型（hy4-preview）重跑即成功，所以这是瞬时故障而非配置问题。
// 与 isLimited 区分：限流/网络类要问用户（可能是额度耗尽，重试无意义且烧钱），
// 这类则重试一次就大概率过，不值得打断用户。
function isTransientCliError(res) {
  if (!res || res.ok) return false
  if (isLimited(res)) return false
  return res.status === 'ERROR_DURING_EXECUTION'
}

// 失败结果的可行动指引（v1.1.4）。此前失败只回一行 head（status/mode/tokens），
// 没有 body、没有指引：模型无从判断该重试、该换模型还是该放弃，实测会白耗一次
// codebuddy_status 再靠猜换模型。这里按失败类型给出明确下一步。
function failureHint(res) {
  if (!res || res.ok) return ''
  // 前置凭据缺失（v1.3.1）：codebuddy-en 需要用户提供 token（见 endpointMismatchHint）。
  // res.stderr 已带完整可操作指引，直接透传，避免被下面更泛的分支覆盖。
  if (res.status === 'AUTH_REQUIRED') return '[诊断] ' + String(res.stderr || '')
  if (isTransientCliError(res)) {
    return res.retried
      ? '[诊断] codebuddy CLI 侧瞬时错误（error_during_execution，CLI 未给出原因），已自动重试 1 次仍失败。可换 model 再试一次；若仍失败请改用原生工具完成，或告知用户。'
      : '[诊断] codebuddy CLI 侧瞬时错误（error_during_execution，CLI 未给出原因）。直接重试同一请求通常即可通过；也可显式指定 model。不要据此认为任务本身有问题。'
  }
  if (res.status === 'PARSE_ERROR') {
    return '[诊断] 未能从 codebuddy 输出解析出 result 事件（进程可能被中断或输出被截断）。可重试；持续出现请检查 codebuddy CLI 版本。'
  }
  // 认证/端点域不匹配（v1.3.0 真机实测文案）：国际端点 + 国内 token → 401。
  // 给出明确可行动指引（换登录域），不要让调用方误判为限流去回退。
  if (/401 authentication failed|differs from the current product endpoint/i.test(String(res.stderr || ''))) {
    return '[诊断] 认证失败（401）：请求被送到的端点与当前 CLI 登录域不匹配（国际/国内登录互斥）。请让用户在对应产品域完成 `codebuddy` CLI 登录后重试；这不是限流，重试与回退都无效。'
  }
  return ''
}

function clampInt(v, def, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  const i = Math.floor(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

function shortLabel(prompt) {
  const s = String(prompt || '').replace(/\s+/g, ' ').trim()
  return s.length > 80 ? s.slice(0, 77) + '...' : s
}

// 工具入参摘要（用于状态灯/活动面板）。返回值必须是可无损 JSON 化的数据：
// undefined 值直接跳过（DSH tool 渲染层不接受 undefined）。
function summarizeArgs(parameters) {
  if (!parameters || typeof parameters !== 'object') return null
  const out = {}
  for (const k of Object.keys(parameters)) {
    let v = parameters[k]
    if (v === undefined) continue
    if (typeof v === 'string' && v.length > MAX_ARG_LEN) v = v.slice(0, MAX_ARG_LEN) + '…'
    out[k] = v
  }
  return out
}

// 从 codebuddy stream-json 输出里解析最终 result 事件（自后向前找第一行
// type==='result' 的完整 JSON 行；整体 JSON 兜底）。
function parseCodebuddyJson(stdoutText) {
  const trimmed = String(stdoutText || '').trim()
  if (!trimmed) return null
  const lines = trimmed.split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim()
    if (!ln.startsWith('{')) continue
    try {
      const obj = JSON.parse(ln)
      if (obj && obj.type === 'result') return obj
    } catch (e) {}
  }
  try { return JSON.parse(trimmed) } catch (e) {}
  return null
}

// result 事件 → 统一结果对象（ok/status/response/sessionId/tokens/…）。
// backend 记录本次调用走的是哪个 CLI（'codebuddy' | 'codebuddy-en' | 'workbuddy'）。
function buildResult(parsed, outcome, mode, stderrText, stdoutText, backend) {
  const bk = backend || 'codebuddy'
  const exitCode = outcome ? outcome.exitCode : null
  const errText = parsed && typeof parsed.error === 'string' && parsed.error ? parsed.error : ''
  const stderr = (stderrText ? String(stderrText).slice(-2000) : '') + (errText ? (stderrText ? ' ' : '') + errText : '')
  // v1.6.0：顺手收割服务端回吐的「本账号可用模型」清单。
  // CLI 报 `400 model [xxx] service info not found` 时会附上
  // `Currently supported models for your account:` + 逐行 `- <id>`，
  // 那是**唯一权威的可用清单**（描述文件里的 -ioa 型号实测大多未授权）。
  // 解析成功即缓存，面板下次刷新就能显示真实可用型号。失败静默忽略。
  try {
    const harvest = parseAccountModels(stderr) || parseAccountModels(String(stdoutText || ''))
    if (harvest && harvest.length) rememberAccountCatalog(bk, harvest)
  } catch (e) { /* 收割失败不影响主流程 */ }
  if (parsed && parsed.type === 'result') {
    const isOk = exitCode === 0 && parsed.is_error === false && parsed.subtype === 'success'
    // 实际使用的模型（v1.1.4）：result 事件的 modelUsage 是 { <model>: {...} } 映射。
    // 只取键名（字符串），不保留其下的实时对象。此前结果不含模型信息，用户排查
    // 「默认模型是不是不稳」只能靠猜着换 model 试。
    let modelUsed = null
    try {
      if (parsed.modelUsage && typeof parsed.modelUsage === 'object') {
        const names = Object.keys(parsed.modelUsage)
        if (names.length) modelUsed = names.join('+')
      }
    } catch (e) { }
    return {
      ok: isOk,
      status: String(parsed.subtype || (isOk ? 'SUCCESS' : 'ERROR')).toUpperCase(),
      response: typeof parsed.result === 'string' ? parsed.result : '',
      sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
      durationSeconds: typeof parsed.duration_ms === 'number' ? parsed.duration_ms / 1000 : null,
      numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : null,
      totalTokens: (parsed.usage && typeof parsed.usage.input_tokens === 'number' && typeof parsed.usage.output_tokens === 'number')
        ? (parsed.usage.input_tokens + parsed.usage.output_tokens) : null,
      exitCode: exitCode,
      mode: mode,
      backend: bk,
      modelUsed: modelUsed,
      stderr: stderr
    }
  }
  return {
    ok: false,
    status: 'PARSE_ERROR',
    response: '',
    sessionId: null,
    durationSeconds: null,
    numTurns: null,
    totalTokens: null,
    exitCode: exitCode,
    mode: mode,
    backend: bk,
    stderr: stderr,
    rawStdout: String(stdoutText || '').slice(-2000)
  }
}

// 统一 argv 构造。prefix 是命令头数组（['codebuddy'] 或 ['node', <bin>]）。
// mode 解析：'auto' → 由 planActive 决定 plan/bypassPermissions（DSH preset）；
// 'plan' → 只读；其余（'accept-edits' 等）→ bypassPermissions（MCP 默认）。
// opts.env（可选）：随本次调用注入子进程的环境变量表（如端点覆盖/凭据），
// 由调用方通过 endpointEnv() 生成；preset/dynamic/MCP 三形态的 spawn 都会带上。
// 返回 { argv, timeoutSec, mode, env }（mode 为解析后的规范值）。
//
// plan 模式为何额外预批 Bash（--allowedTools，v1.1.3 修复）：
// CLI 在 -p 非交互 + plan 模式下默认拒绝 Bash（该档需交互授权，非交互下无人可授），
// codebuddy 于是报「Bash 工具在无交互模式下未获授权（被拒绝）」并绕道 PowerShell
// ——同样是 shell，却因门禁不一致白耗回合，有时干脆放弃调查。预批 Bash 后只读
// shell 调查恢复可用；写入仍被 plan 模式独立禁止（CLI 侧策略，实测：预批 Bash 后
// 仍拒绝创建文件并说明「该约束优先级高于本次请求」），只读保证不受影响。
function buildArgv(prefix, args, opts) {
  const o = opts || {}
  const argv = [prefix[0], ...prefix.slice(1), '-p', String(args.prompt), '--output-format', 'stream-json']
  let mode = args.mode || o.defaultMode || 'auto'
  if (mode === 'auto') mode = o.planActive ? 'plan' : 'bypassPermissions'
  if (mode === 'plan') {
    argv.push('--permission-mode', 'plan')
    argv.push('--allowedTools', 'Bash')
  } else {
    mode = 'bypassPermissions'
    argv.push('--permission-mode', 'bypassPermissions')
  }
  // 模型优先级：显式 args.model > 用户偏好 defaultModel（设置面板，v1.3.0）> CLI 自己的默认。
  const model = args.model || o.defaultModel
  if (model) argv.push('--model', String(model))
  if (args.effort) argv.push('--effort', String(args.effort))
  if (args.maxTurns !== undefined && args.maxTurns !== null) argv.push('--max-turns', String(clampInt(args.maxTurns, 50, 1, 500)))
  if (Array.isArray(args.addDirs)) for (const d of args.addDirs) { if (d) argv.push('--add-dir', String(d)) }
  if (args.sessionId) argv.push('--resume', String(args.sessionId))
  else if (args.continueLatest) argv.push('--continue')
  const timeoutSec = clampInt(args.timeoutSec, 300, 10, 3600)
  return { argv: argv, timeoutSec: timeoutSec, mode: mode, env: o.env || null }
}

// 回退结果（用户在弹窗选择「使用 DSH 本地 API 配置」后返回给调用方的标记）。
function fallbackResult(res, mode) {
  return { ok: false, fallback: true, status: 'FALLBACK_TO_DSH', response: '', sessionId: (res && res.sessionId) || null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: res ? res.exitCode : null, mode: mode, backend: (res && res.backend) || 'codebuddy', stderr: res ? res.stderr : '', reason: res ? res.status : 'unknown' }
}

function projectName(cwd) {
  const s = String(cwd || '')
  const parts = s.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : s
}

// ── 半行安全的行流（跨 chunk 的 NDJSON 行拼接）───────────────────────────────
// stdout chunk 可能在行中间截断；只处理到最后一个换行，剩余半行留到下一轮
// 拼接（否则跨 chunk 的行会被 JSON.parse 失败后永久丢弃）。
function createLineStream(consumeLine) {
  let pending = ''
  function pushChunk(text) {
    if (typeof text !== 'string' || !text) return
    const lines = (pending + text).split(/\r?\n/)
    pending = lines.pop() || ''
    for (const ln of lines) consumeLine(ln)
  }
  function flush() {
    const rest = pending
    pending = ''
    if (rest) consumeLine(rest)
  }
  return { pushChunk, flush }
}

// ── 状态引擎（按项目目录聚合的运行状态表）────────────────────────────────────
// opts.publish(snapshot) —— 每次状态变化后回调（preset: ctx.emit 事件；
// dynamic: 推给家级收集器；MCP: 传 null，按需构建）。
function createStatusEngine(opts) {
  const publish = (opts && typeof opts.publish === 'function') ? opts.publish : null
  const projects = Object.create(null)
  // sessionId → { cwd, backend }。会话按后端归档（国内版 ~/.codebuddy 单一目录，
  // 但国内/国际登录域互斥——同一 sessionId 只在其登录域内有效）；且同一项目可先后
  // 跑多个后端（项目级 lastSessionId 只记最后一个）。续接时按此表一次解析出
  // cwd 与后端。容量上限 MAX_SESSIONS，FIFO 淘汰。
  const sessions = Object.create(null)

  function ensureProject(cwd) {
    const key = String(cwd || '')
    let p = projects[key]
    if (!p) {
      if (Object.keys(projects).length >= MAX_PROJECTS) {
        // MRU 淘汰：优先淘汰空闲项目；全忙时淘汰最久未活跃的。
        const idle = Object.keys(projects).filter(function (k) { return projects[k].running === 0 })
        const pool = idle.length ? idle : Object.keys(projects)
        const victim = pool.sort(function (a, b) { return projects[a].updatedAt - projects[b].updatedAt })[0]
        delete projects[victim]
      }
      p = { cwd: key, name: projectName(key), state: 'idle', running: 0, lastStatus: null, lastAt: 0, lastSessionId: null, lastBackend: null, lastOk: false, lastFailed: false, fallbackActive: false, current: null, trail: [], runs: 0, totalTokens: 0, updatedAt: 0 }
      projects[key] = p
    }
    return p
  }

  function globalStatus() {
    const list = Object.keys(projects).map(function (k) { return projects[k] })
    let running = 0, lastStatus = null, lastAt = 0, lastSessionId = null, lastBackend = null, fallbackActive = false, current = null, trail = [], updatedAt = 0, runs = 0, totalTokens = 0
    for (const p of list) {
      running += p.running
      if (p.updatedAt > updatedAt) updatedAt = p.updatedAt
      if (p.running > 0 && !current && p.current) current = p.current
      if (p.lastAt > lastAt) { lastAt = p.lastAt; lastStatus = p.lastStatus; lastSessionId = p.lastSessionId; lastBackend = p.lastBackend }
      if (p.fallbackActive) fallbackActive = true
      runs += p.runs || 0
      totalTokens += p.totalTokens || 0
      for (const e of p.trail) trail.push(e)
    }
    trail.sort(function (a, b) { return (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) })
    trail = trail.slice(-MAX_TRAIL)
    const state = running > 0 ? 'running' : (fallbackActive ? 'fallback' : (lastStatus ? (lastStatus === 'SUCCESS' ? 'ok' : 'failed') : 'idle'))
    return { state: state, running: running, lastStatus: lastStatus, lastAt: lastAt, lastSessionId: lastSessionId, lastBackend: lastBackend, fallbackActive: fallbackActive, current: current, trail: trail, runs: runs, totalTokens: totalTokens, updatedAt: updatedAt }
  }

  function statusSnapshot() {
    const g = globalStatus()
    const list = Object.keys(projects).map(function (k) { return projects[k] }).sort(function (a, b) { return b.updatedAt - a.updatedAt })
    return {
      state: g.state, running: g.running, lastStatus: g.lastStatus, lastAt: g.lastAt, lastSessionId: g.lastSessionId, lastBackend: g.lastBackend, fallbackActive: g.fallbackActive, current: g.current, trail: g.trail, runs: g.runs, totalTokens: g.totalTokens, updatedAt: g.updatedAt,
      projects: list.map(function (p) { return { cwd: p.cwd, name: p.name, state: p.state, running: p.running, current: p.current, trail: p.trail.slice(-MAX_TRAIL), lastStatus: p.lastStatus, lastAt: p.lastAt, lastSessionId: p.lastSessionId, lastBackend: p.lastBackend, fallbackActive: p.fallbackActive, runs: p.runs || 0, totalTokens: p.totalTokens || 0, updatedAt: p.updatedAt } })
    }
  }

  function emit() { if (publish) { try { publish(statusSnapshot()) } catch (e) {} } }

  function begin(cwd) {
    const p = ensureProject(cwd)
    p.running += 1
    p.state = 'running'
    p.updatedAt = Date.now()
    emit()
  }

  function end(res, cwd) {
    const p = ensureProject(cwd)
    p.running = Math.max(0, p.running - 1)
    p.lastStatus = res ? res.status : null
    p.lastAt = Date.now()
    if (res && res.sessionId) {
      p.lastSessionId = res.sessionId
      // 记录该会话的 cwd 与后端：续接（--resume）时按 sessionId 一次查表，
      // 即可同时得到正确的工作目录与正确的 CLI（显式参数优先）。
      sessions[res.sessionId] = { cwd: p.cwd, backend: res.backend || 'codebuddy' }
      const keys = Object.keys(sessions)
      if (keys.length > MAX_SESSIONS) delete sessions[keys[0]]
    }
    if (res) p.lastBackend = res.backend || 'codebuddy'
    // 用量累计（无套餐额度 API，以按项目 token 计量作替代观察）
    p.runs = (p.runs || 0) + 1
    if (res && typeof res.totalTokens === 'number' && res.totalTokens > 0) p.totalTokens = (p.totalTokens || 0) + res.totalTokens
    if (res && res.fallback) { p.fallbackActive = true; p.state = 'fallback' }
    else if (p.running > 0) { p.state = 'running' }
    else { p.state = res && res.ok ? 'ok' : 'failed'; p.lastOk = !!(res && res.ok); p.lastFailed = !(res && res.ok) }
    p.current = null
    p.updatedAt = Date.now()
    emit()
  }

  // 流事件折叠为实时状态（current 步骤 + trail）。
  function foldEvent(ev, cwd) {
    const p = ensureProject(cwd)
    p.updatedAt = Date.now()
    if (!ev || !ev.type) return
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block.type === 'tool_use') {
          p._stepCounter = (p._stepCounter || 0) + 1
          const stepIndex = p._stepCounter
          if (!p._toolMap) p._toolMap = {}
          p._toolMap[block.id] = { stepIndex: stepIndex, name: block.name }
          const args = summarizeArgs(block.input)
          p.trail.push({ stepIndex: stepIndex, state: 'ACTIVE', tool: block.name, args: args, at: new Date().toISOString() })
          if (p.trail.length > MAX_TRAIL) p.trail.shift()
          p.current = { tool: block.name, args: args, stepIndex: stepIndex, since: new Date().toISOString() }
        } else if (block.type === 'thinking') {
          p.current = { tool: 'thinking', args: { text: String(block.thinking || '').slice(0, MAX_ARG_LEN) }, stepIndex: 0, since: new Date().toISOString() }
        } else if (block.type === 'text') {
          p.current = { tool: 'typing', args: { text: String(block.text || '').slice(0, MAX_ARG_LEN) }, stepIndex: 0, since: new Date().toISOString() }
        }
      }
    } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block.type === 'tool_result' && p._toolMap && p._toolMap[block.tool_use_id]) {
          const rec = p._toolMap[block.tool_use_id]
          p.trail.push({ stepIndex: rec.stepIndex, state: block.is_error ? 'ERROR' : 'DONE', tool: rec.name, args: null, at: new Date().toISOString() })
          if (p.trail.length > MAX_TRAIL) p.trail.shift()
          if (p.current && p.current.stepIndex === rec.stepIndex) p.current = null
        }
      }
    }
    emit()
  }

  // 会话路由（cwd + backend 一次解析）。CLI 会话按项目目录（cwd）归档，且
  // 各后端登录域互斥（国内 ~/.codebuddy / 国际同目录但登录域不同 / workbuddy
  // ~/.workbuddy）：同一 sessionId 只在其登录域内有效：
  //   - 显式 cwd 优先；未给 cwd 的续接（--resume/--continue）回落到该 session
  //     所在项目的 cwd（否则换目录报 "No conversation found"）。
  //   - backend：显式 args.backend 由 runner 层处理（此处不越权）；否则按
  //     sessionId 查该会话的后端；continueLatest 用最近项目的后端；都没有则
  //     返回 null（调用方按 用户偏好 > 默认 codebuddy 兜底）。
  function resolveTarget(args, fallbackCwd) {
    const a = args || {}
    let backend = null
    let cwd = null
    if (a.sessionId) {
      const hit = sessions[a.sessionId]
      if (hit) { backend = hit.backend; cwd = hit.cwd }
    }
    if (a.cwd) {
      cwd = String(a.cwd)
    } else if (!cwd && (a.sessionId || a.continueLatest)) {
      // 会话表未命中（容量淘汰 / 跨进程）时回落项目级匹配。
      const list = Object.keys(projects).map(function (k) { return projects[k] }).sort(function (a, b) { return b.updatedAt - a.updatedAt })
      if (a.sessionId) {
        const projHit = list.find(function (p) { return p.lastSessionId === a.sessionId })
        if (projHit) { cwd = projHit.cwd; if (!backend) backend = projHit.lastBackend }
      } else if (list.length && list[0].lastSessionId) {
        cwd = list[0].cwd
        if (!backend) backend = list[0].lastBackend
      }
    }
    return { cwd: cwd || fallbackCwd, backend: backend }
  }

  // 兼容旧签名：只取 cwd。
  function resolveCwd(args, fallbackCwd) {
    return resolveTarget(args, fallbackCwd).cwd
  }

  return { projects: projects, ensureProject: ensureProject, globalStatus: globalStatus, statusSnapshot: statusSnapshot, begin: begin, end: end, foldEvent: foldEvent, resolveCwd: resolveCwd, resolveTarget: resolveTarget, sessions: sessions }
}

// ── 工具渲染（preset 与 dynamic 共用的纯展示层）─────────────────────────────

function renderResult(value) {
  const v = value || {}
  const bk = v.backend || 'codebuddy'
  if (v.background) {
    return [{ type: 'text', text: bk + ' dispatched in background (mode=' + v.mode + '). jobId=' + v.jobId + '. Collect with job_output.' }]
  }
  if (v.fallback) {
    return [{ type: 'text', text: bk + ' 回退：用户选择使用 DSH 本地 API 配置（原因 ' + v.reason + '）。请改用原生工具/本地模型完成本任务，不要再调 ' + bk + '。' }]
  }
  const head = bk + ' ' + (v.ok ? 'OK' : 'FAILED') + ' [status=' + v.status + ' mode=' + v.mode + (v.modelUsed ? ' model=' + v.modelUsed : '') + (v.retried ? ' retried=1' : '') + (v.sessionId ? ' session=' + v.sessionId : '') + (v.totalTokens != null ? ' tokens=' + v.totalTokens : '') + (v.durationSeconds != null ? ' ' + v.durationSeconds + 's' : '') + ']'
  const hint = failureHint(v)
  let body = v.response ? v.response : (v.stderr ? '[stderr] ' + v.stderr : (v.rawStdout ? '[raw] ' + v.rawStdout : ''))
  if (hint) body = (body ? body + '\n\n' : '') + hint
  return [{ type: 'text', text: head + (body ? '\n\n' + body : '') }]
}

function renderStatus(value) {
  const v = value || {}
  const lines = []
  lines.push('codebuddy status: ' + v.state + (v.running > 0 ? ' (' + v.running + ' running)' : '') + (v.projects && v.projects.length > 1 ? ' across ' + v.projects.length + ' projects' : '') + (v.totalTokens ? ' | total ' + v.runs + ' runs, ' + v.totalTokens + ' tokens' : ''))
  const projList = (v.projects && v.projects.length) ? v.projects : null
  if (projList) {
    for (const p of projList) {
      const cur = p.current ? (' step ' + p.current.stepIndex + ' → ' + p.current.tool + (p.current.args ? ' ' + JSON.stringify(p.current.args) : '')) : (p.running > 0 ? ' (starting / thinking)' : '')
      const usage = (p.runs ? ' | total ' + p.runs + ' runs, ' + (p.totalTokens || 0) + ' tokens' : '')
      const bkTag = (p.lastBackend && p.lastBackend !== 'codebuddy') ? ' [' + p.lastBackend + ']' : ''
      lines.push('· ' + p.name + ' [' + p.state + (p.running > 0 ? ' ×' + p.running : '') + ']' + bkTag + cur + (p.lastStatus ? ' | last=' + p.lastStatus + (p.lastSessionId ? ' ' + p.lastSessionId.slice(0, 8) : '') : '') + usage)
      if (p.trail && p.trail.length) {
        lines.push('    steps:')
        for (const e of p.trail.slice(-3)) { const a = e.args ? ' ' + JSON.stringify(e.args) : ''; lines.push('      [' + e.state + '] step ' + e.stepIndex + ' ' + e.tool + a) }
      }
    }
  } else {
    if (v.current) { const c = v.current; lines.push('current: step ' + c.stepIndex + ' → ' + c.tool + (c.args ? ' ' + JSON.stringify(c.args) : '')) }
    else if (v.state === 'running') { lines.push('current: (starting / thinking)') }
    if (v.trail && v.trail.length) {
      lines.push('recent steps:')
      for (const e of v.trail.slice(-6)) { const a = e.args ? ' ' + JSON.stringify(e.args) : ''; lines.push('  [' + e.state + '] step ' + e.stepIndex + ' ' + e.tool + a) }
    }
    if (v.lastStatus) lines.push('last: ' + v.lastStatus + (v.lastSessionId ? ' session=' + v.lastSessionId : '') + (v.lastAt ? ' @ ' + new Date(v.lastAt).toISOString() : ''))
  }
  if (v.updatedAt) lines.push('updatedAt: ' + new Date(v.updatedAt).toISOString())
  return [{ type: 'text', text: lines.join('\n') }]
}

// ── preset/dynamic 共享的文案 ────────────────────────────────────────────────

const FALLBACK_LABEL = '使用 DSH 本地 API 配置（回退）'
const RETRY_LABEL = '重试 codebuddy 一次'
const CANCEL_LABEL = '不回退（返回错误）'

const POLICY_TEXT = [
  'codebuddy-first execution policy (local codebuddy CLI bridge, with fallback + live indicator + live status tool).',
  '',
  'A local sub-agent CLI named "codebuddy" (Tencent CodeBuddy Code) is available through the codebuddy_run and codebuddy_continue tools. DSH fully controls codebuddy: every invocation runs non-interactively with permissions auto-approved (--permission-mode bypassPermissions), so codebuddy never prompts and DSH decides all of its work. A header status light shows when codebuddy is working — one light per project (working directory), so parallel runs in different projects are tracked separately; call codebuddy_status any time to see what codebuddy is doing right now (per project: current tool/step, recent trail, and cumulative usage).',
  '',
  'Priority rule for EVERY mode (normal, plan, accept-edits, subagent/workflow/ralph delegation, and goal rounds):',
  '- For any real work — implementing features, editing/refactoring code, debugging, running builds, or multi-file investigation — prefer dispatching the task to codebuddy_run FIRST with a complete, self-contained prompt.',
  '- Use native read/write/shell tools mainly for quick read-only lookups and for the final build/test verification of what codebuddy produced.',
  '- In plan mode, call codebuddy_run with mode=auto (or mode=plan); in accept-edits/normal mode codebuddy_run applies edits directly.',
  '- When you delegate to a DSH subagent or workflow, instruct that delegate to also prefer codebuddy_run.',
  '- For long-running tasks, call codebuddy_run with background=true and collect the result with job_output; use codebuddy_status to watch progress.',
  '',
  'Fallback protocol: when codebuddy is rate-limited or the network is down, codebuddy_run/codebuddy_continue automatically pop a confirmation dialog asking the user whether to use the DSH local API config. If the returned result has fallback=true (status FALLBACK_TO_DSH), the user chose to fall back: complete the task with native DSH tools / the local model and DO NOT call codebuddy again for this task. If ok=false without fallback, report the codebuddy error. Never loop codebuddy calls; never ask codebuddy to call back into DSH.',
  '',
  'Model selection: codebuddy_run takes an optional model. When unspecified, the CLI default applies unless the user set a preferred default model in the plugin settings (then that is injected automatically per call). Which models ACTUALLY WORK depends on the ACCOUNT, and the authoritative live list comes from the server: running the CLI with a nonexistent model returns 400 followed by "Currently supported models for your account:" and one "- <id>" per line (core exposes parseAccountModels for this; the plugin caches the result automatically and the settings panel shows exactly those ids, with the credit multiplier of each). Do NOT trust the bundled product descriptor as a menu of usable models: it lists ids with an "-ioa" suffix (glm-5.3-ioa) and expensive flagships (claude-opus-4.8, gpt-5.4, gpt-6-astra) that are present in the catalogue but NOT licensed for this account, and picking one fails with 400 "only available for authorized users". The four backends are also not one pool: "codebuddy" and "codebuddy-intl" are the npm CLI and offer its catalogue - including the free tier (hy3 and deepseek-v4.1-flash cost x0.00 credits; hy4-preview costs x0.29 but is frequently free on promotional accounts); "codebuddy-en" (WorkBuddyAI) has its OWN catalogue which does NOT contain hy4-preview or deepseek-v4.1-flash - it offers hy3 (free), gpt-5.1-codex-mini, gemini-3.1-flash-lite, gemini-2.5-flash, minimax-m3, gemini-3.0-flash, deepseek-v3-2-volc, kimi-k2.5/2.6, glm-5.0/5.2/5.3, gpt-5.3-codex, gpt-5.4/5.5, gpt-5.6-sol/terra/luna and the role aliases (fast/balanced/primary/deep-model); "workbuddy" (domestic desktop) has a further catalogue (auto, hy4-preview, hy3, deepseek-v4.1-flash, glm-5.x, kimi-k2.6/2.7/2.8-preview/k3-1, minimax-m3/m2.7, deepseek-v4-pro). Within a face availability is still gated per ACCOUNT: an id outside the account catalogue fails with "400 model [...] service info not found", and one inside it but unlicensed fails with "400 model [...] is only available for authorized users". International ids (claude-sonnet-5, claude-opus-5, gemini-3.1-pro, ...) are per-account gated and return the latter for a domestic account. COST: every id carries a credit multiplier in the credits field of its descriptor (x0.00 means free, x3.31 means 3.31x the base rate); the settings panel shows each candidate with its multiplier and reads it live from the CLI descriptor, so it stays in sync when the CLI is upgraded. Measured free (x0.00) models for this account: hy3 and deepseek-v4.1-flash (both npm faces) and hy3 for WorkBuddyAI; hy4-preview is x0.29 on npm faces. Prefer the cheapest model that can do the job and use a free one for routine work; do not silently upgrade to an expensive id when the task is simple. To get the exact live list for a CLI, run it with a deliberately invalid model id - the reply prints "Currently supported models for your account:" followed by one "- <id>" per line (core exposes parseAccountModels for this). Pass a model only when the task clearly benefits from a specific one; the default is usually right. Optional effort: minimal/low/medium/high/xhigh/max. Optional maxTurns caps agentic turns (default unlimited).',
  '',
  'Backends: codebuddy_run/codebuddy_continue take an optional backend parameter choosing which CLI face of the same engine (Tencent CodeBuddy Code) runs the task. "codebuddy" is the domestic CodeBuddy (npm CLI @tencent-ai/codebuddy-code, product endpoint www.codebuddy.ai) — default for coding work. "codebuddy-intl" is the INTERNATIONAL face of that SAME npm CLI (product.ioa.json catalogue: claude-sonnet-5, claude-opus-5, gemini-3.1-pro, gpt-6-astra, hy3-ioa …); use it when the account is an international CodeBuddy account. Its aliases "codebuddy-ioa" and "codebuddy-international" are accepted and normalized to codebuddy-intl. "codebuddy-en" is the WorkBuddy INTERNATIONAL edition — the CLI bundled with the WorkBuddyAI desktop app (C:\\Program Files\\WorkBuddyAI, product endpoint www.workbuddy.ai); the aliases "workbuddy-en" and "workbuddy-ai" are also accepted and normalized to codebuddy-en. "workbuddy" is the CLI bundled with the domestic WorkBuddy desktop app (product endpoint copilot.tencent.com, zero config) — the office-scenario face: documents, slides, spreadsheets, knowledge-base lookups, image/video generation, WeChat/WeCom replies. When the user asks for office/document/IM work, dispatch with backend="workbuddy"; for international accounts use "codebuddy-intl" (CodeBuddy 国际版) or "codebuddy-en" (WorkBuddy 国际版 / WorkBuddyAI). Sessions are kept per backend (login domains are exclusive), and continuing a session automatically routes back to the backend that owns it (explicit backend wins). A user-preferred default backend (plugin settings) applies when a call is new (no session) and no explicit backend is given.'
].join('\n')

// ── 执行编排（preset 与 dynamic 共用；MCP 的 stdio 编排见其适配层）──────────
// o: {
//   ctx,                     // Cordis ctx（interval/timeout/get）
//   subprocess,              // DSH subprocess 服务
//   engine,                  // createStatusEngine(...) 实例
//   resolveExe,              // async (backend, execSignal) => 'exe' | [nodeExe, binPath]
//   getCwdFallback,          // () => 默认 cwd（DSH workspaceRoot || 常量）
//   defaultMode              // 'auto'（DSH preset/dynamic）
// }
function createRunner(o) {
  const ctx = o.ctx
  const subprocess = o.subprocess
  const engine = o.engine
  const stdio = {
    stdin: 'ignore',
    stdout: { maxBytes: 4000000, spill: { maxBytes: 40000000 } },
    stderr: { maxBytes: 1000000, spill: { maxBytes: 8000000 } }
  }

  function readStreams(handle) {
    const stdoutText = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
    const stderrText = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
    return { stdoutText: stdoutText, stderrText: stderrText }
  }

  // spawn spec 组装：统一挂上本次调用的 env 注入（国际端点覆盖等；null 时无操作）。
  function spawnSpec(argv, cwd, callerSignal) {
    const spec = { argv: argv, cwd: cwd, stdio: stdio, graceMs: 5000 }
    if (callerSignal) spec.signal = callerSignal
    if (built_env && typeof built_env === 'object') spec.env = built_env
    return spec
  }
  let built_env = null

  // 半行安全的实时解析：250ms 轮询读增量，行边界由 createLineStream 保证。
  function startLiveParser(handle, cwd) {
    let cursor = 0
    const stream = createLineStream(function (ln) {
      const t = ln.trim()
      if (!t.startsWith('{')) return
      try { const obj = JSON.parse(t); engine.foldEvent(obj, cwd) } catch (e) {}
    })
    const tick = function () {
      try {
        const full = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
        if (full.length <= cursor) return
        const fresh = full.slice(cursor)
        cursor = full.length
        stream.pushChunk(fresh)
      } catch (e) {}
    }
    const disposeInterval = ctx.interval(tick, 250)
    // 结束时冲刷残余半行（末行可能无换行符）。
    return function disposeLive() {
      try { stream.flush() } catch (e) {}
      disposeInterval()
    }
  }

  async function runSync(argv, cwd, timeoutSec, callerSignal, extraEnv) {
    const spec = spawnSpec(argv, cwd, callerSignal)
    if (extraEnv && typeof extraEnv === 'object') spec.env = Object.assign({}, spec.env, extraEnv)
    const handle = subprocess.spawn(spec)
    let lastEventSummary = '(no events yet)'
    let timedOut = false
    const disposeTimer = ctx.timeout(function () {
      timedOut = true
      try {
        const p = engine.ensureProject(cwd)
        lastEventSummary = (p.current ? ('last step ' + p.current.stepIndex + ' -> ' + p.current.tool) : '') +
          ' | trail=' + (p.trail.length ? p.trail.slice(-2).map(function (e) { return '[' + e.state + ']' + e.tool }).join(',') : 'empty') +
          ' | elapsed=' + Math.round((Date.now() - (p.updatedAt || Date.now())) / 1000) + 's since last activity'
      } catch (e) {}
      try { handle.terminate() } catch (e) {}
    }, (timeoutSec + 60) * 1000)
    const disposeLive = startLiveParser(handle, cwd)
    try {
      const outcome = await handle.done
      const s = readStreams(handle)
      return { outcome: outcome, stdoutText: s.stdoutText, stderrText: s.stderrText, timedOut: timedOut, lastEventSummary: lastEventSummary }
    } finally {
      disposeLive()
      disposeTimer()
    }
  }

  async function askFallback(exec, res, canRetry) {
    const uq = ctx.get('userQuestions')
    if (!uq || !exec || !exec.agent) return 'error'
    const bk = (res && res.backend) || 'codebuddy'
    const detail = String(res.stderr || res.response || res.status || '').slice(-600)
    // canRetry=false 时不再提供「重试」选项（已达 2 次上限），避免死选项。
    const opts = [ { label: FALLBACK_LABEL, description: '本次改由 DSH 本地模型/原生工具完成，不再走 ' + bk } ]
    if (canRetry) opts.push({ label: RETRY_LABEL, description: '再调用一次 ' + bk + '（网络抖动时可用）' })
    opts.push({ label: CANCEL_LABEL, description: '不回退，直接返回 ' + bk + ' 错误' })
    try {
      const ans = await uq.ask({ agent: exec.agent, signal: exec.signal, questions: [{ id: 'codebuddy-fallback', header: bk + ' 受限', question: bk + ' 调用失败（疑似流量受限/网络不通，状态=' + String(res.status) + '）。是否改用 DSH 本地 API 配置继续？', detail: detail, options: opts }] })
      const sel = (ans && ans.answers && ans.answers[0] && ans.answers[0].selected) || []
      if (sel.indexOf(FALLBACK_LABEL) >= 0) return 'fallback'
      if (sel.indexOf(RETRY_LABEL) >= 0) return 'retry'
      return 'error'
    } catch (e) { return 'error' }
  }

  async function coreExecute(rawArgs, exec) {
    const args = rawArgs || {}
    built_env = null
    if (!args.prompt || !String(args.prompt).trim()) {
      return { ok: false, status: 'BAD_ARGS', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: 'auto', backend: normalizeBackend(args.backend) || null, stderr: 'prompt is required' }
    }
    // 后端路由（v1.3.0：三后端 + 用户偏好默认）：显式 args.backend 最优先；否则按
    // 会话归属（各后端登录域互斥，同一 sessionId 只在一个后端有效），都没有则用
    // 用户偏好（设置面板 preferredBackend），最后默认 codebuddy。cwd 与 backend 一次解析。
    const target = engine.resolveTarget(args, o.getCwdFallback())
    const backend = resolveBackend(args, target, o.getPreferredBackend ? o.getPreferredBackend() : null)
    const cwd = target.cwd
    // 前置凭据检查（v1.3.1）：codebuddy-en 的 token 被桌面 App 的 protector key 封装，
    // 密钥不落盘、headless CLI 读不到（CLI 自身报 category:"missing-key"）。没有用户
    // 提供的 token 时必然 401 —— 提前给出可操作提示，胜过让 CLI 报一句无从下手的
    // "Authentication required"。这是**确定性**判断，不涉及网络猜测。
    const authDomain = o.getAuthDomain ? o.getAuthDomain(backend) : null
    // 凭据三通道解析（v1.3.1）：设置面板 > CODEBUDDY_AUTH_TOKEN 环境变量 > DSH 凭据库。
    // 第三条是关键——用户通常已在 DSH 里配好指向 workbuddy.ai/v2 的 token，自动复用
    // 即可让 codebuddy-en 开箱即用（真机实测该 token 下发给 WorkBuddyAI CLI 返回 PONG）。
    const enTok = backend === 'codebuddy-en'
      ? resolveEnToken(o.getAuthToken ? o.getAuthToken(backend) : null)
      : { token: null, source: null }
    const authToken = enTok.token
    const credentialHint = endpointMismatchHint(backend, authDomain, !!authToken)
    if (backend === 'codebuddy-en' && !authToken) {
      engine.begin(cwd)
      const res = {
        ok: false, status: 'AUTH_REQUIRED', response: '', sessionId: null, durationSeconds: null,
        numTurns: null, totalTokens: null, exitCode: null, mode: 'auto', backend: backend, stderr: credentialHint
      }
      engine.end(res, cwd)
      return res
    }
    let exePrefix = ['codebuddy']
    let exeOk = true
    let resolveErr = ''
    try {
      const resExe = await o.resolveExe(backend, exec ? exec.signal : undefined)
      exePrefix = Array.isArray(resExe) ? resExe : [resExe]
    } catch (e) { exeOk = false; resolveErr = String(e && e.message || e) }
    const built = buildArgv(exePrefix, args, {
      planActive: o.planActiveFor ? o.planActiveFor(exec) : false,
      defaultMode: o.defaultMode || 'auto',
      // 用户偏好默认模型（设置面板 defaultModel）：仅当调用未显式指定 model 时注入。
      defaultModel: (!args.model && o.getDefaultModel) ? o.getDefaultModel() : null,
      // 端点/凭据环境注入（v1.3.1）：按登录域对齐端点（修默认后端 codebuddy 的 401），
      // 并下发用户为 codebuddy-en 提供的 token。登录域由宿主侧读取（本文件不碰 fs）。
      env: endpointEnv(
        backend,
        o.getEndpointOverride ? o.getEndpointOverride(backend) : null,
        authDomain,
        authToken
      )
    })
    built_env = (built.env && typeof built.env === 'object') ? built.env : null

    if (!exeOk) {
      engine.begin(cwd)
      let res = { ok: false, status: 'CODEBUDDY_UNAVAILABLE', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, backend: backend, stderr: backend + ' executable not found: ' + resolveErr }
      if (await askFallback(exec, res, true) === 'fallback') res = fallbackResult(res, built.mode)
      engine.end(res, cwd)
      return res
    }

    const jobs = ctx.get('jobs')
    if (args.background && jobs && exec && exec.agent) {
      try {
        engine.begin(cwd)
        const jobId = jobs.start({
          kind: 'bash',
          label: backend + ': ' + shortLabel(args.prompt),
          owner: exec.agent,
          run() {
            const handle = subprocess.spawn(spawnSpec(built.argv, cwd))
            const disposeLive = startLiveParser(handle, cwd)
            // 后台路径同样有挂起守卫（timeoutSec+60s 强杀），与前台 runSync 一致。
            let bgKilled = false
            const disposeGuard = ctx.timeout(function () { bgKilled = true; try { handle.terminate() } catch (e) {} }, (built.timeoutSec + 60) * 1000)
            const done = handle.done.then(function (outcome) {
              disposeLive(); disposeGuard()
              const s = readStreams(handle)
              const res = buildResult(parseCodebuddyJson(s.stdoutText), outcome, built.mode, s.stderrText, s.stdoutText, backend)
              if (bgKilled && !res.ok) {
                res.status = 'HUNG_TIMEOUT'
                res.stderr = (res.stderr ? res.stderr + ' ' : '') + '[killed by timeout guard after ' + built.timeoutSec + 's; if this was a long-running script (build/test) raise timeoutSec]'
              }
              engine.end(res, cwd)
              return { status: res.ok ? 'completed' : 'failed', detail: backend + ' ' + res.status, output: JSON.stringify(res) }
            }).catch(function (err) {
              disposeLive(); disposeGuard()
              engine.end({ ok: false, status: 'JOB_ERROR', backend: backend }, cwd)
              return { status: 'failed', detail: String(err && err.message || err) }
            })
            return { cancel: function () { try { handle.terminate() } catch (e) {} }, done: done }
          }
        })
        return { ok: true, background: true, jobId: String(jobId), mode: built.mode, backend: backend, note: backend + ' running in background; collect with job_output ' + String(jobId) + '. Background failures do NOT open the fallback dialog; on failure re-run in foreground to be prompted.' }
      } catch (e) {
        // jobs.start 失败必须 return，否则会静默落到下面的前台路径再跑一遍。
        const res = { ok: false, status: 'JOB_START_ERROR', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, backend: backend, stderr: 'failed to start background job: ' + String(e && e.message || e) }
        engine.end(res, cwd)
        return res
      }
    }

    engine.begin(cwd)
    try {
      let attempt = 0
      let cliRetried = false
      let res
      while (true) {
        attempt += 1
        const r = await runSync(built.argv, cwd, built.timeoutSec, exec ? exec.signal : undefined, built.env)
        if (r.timedOut) {
          res = { ok: false, status: 'HUNG_TIMEOUT', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: r.outcome ? r.outcome.exitCode : null, mode: built.mode, backend: backend, stderr: backend + ' did not finish within ' + built.timeoutSec + 's (DSH hard timeout). Last activity: ' + r.lastEventSummary + '. NOTE: if the task was a long-running script (build/test), raise timeoutSec; this was a hang guard, not necessarily a failure of codebuddy.' }
          break
        }
        res = buildResult(parseCodebuddyJson(r.stdoutText), r.outcome, built.mode, r.stderrText, r.stdoutText, backend)
        if (res.ok) break
        // CLI 侧瞬时错误（error_during_execution，CLI 不给原因）：静默自动重试一次
        // 后再交还结果。实测同一请求重跑即过；此前把这行无原因失败原样交给模型，
        // 模型只能白耗一次 status 再靠猜换模型。计数独立于 attempt，避免占用下面
        // 限流弹窗的重试额度。
        if (isTransientCliError(res)) {
          if (!cliRetried) { cliRetried = true; attempt -= 1; continue }
          res.retried = true
          break
        }
        if (!isLimited(res)) break
        // 限流/网络类失败：每次失败弹一次三选一；「重试」仅在还有次数时提供。
        // （不再有循环外的第二次弹窗 —— 修复旧版「双弹窗 + 死选项」。）
        const decision = await askFallback(exec, res, attempt < 2)
        if (decision === 'fallback') { res = fallbackResult(res, built.mode); break }
        if (decision === 'retry' && attempt < 2) continue
        break
      }
      engine.end(res, cwd)
      return res
    } catch (e) {
      const res = { ok: false, status: 'SPAWN_ERROR', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode: built.mode, backend: backend, stderr: String(e && e.message || e) }
      const out = (await askFallback(exec, res, true) === 'fallback') ? fallbackResult(res, built.mode) : res
      engine.end(out, cwd)
      return out
    }
  }

  return { coreExecute: coreExecute, runSync: runSync, askFallback: askFallback }
}

const CWD_FALLBACK = 'C:\\Users\\lcl\\Desktop\\codebuddy-bridge'

// 设置读数（动态形态无 Config 声明面）：v1.3.2 起统一走 core 的 readBridgeSettingsFile
// （与 preset 设置面板写入的 dsh-home/codebuddy-bridge-settings.json 同一份、同一实现）。
// 返回 null = 文件缺失/无法定位 → 用 defaultBridgeSettings()。
// 沙箱约束：new Function 求值 → 不可用 import.meta；dsh-home 定位靠 DSH_HOME。
const applySettings = readBridgeSettingsFile() || defaultBridgeSettings()

// 登录域读取（v1.3.1）：端点必须与登录域一致，否则 CLI 报 401。auth 库的
// auth.domain 是明文，无需解密 token。位置：
// %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\<authentication.id>.info
// 读取失败返回 null → 端点解析退化为「沿用 CLI 自身 product 端点」。
function readAuthDomain(backend) {
  const id = BACKEND_AUTH_IDS[backend]
  if (!id) return null
  try {
    const proc = globalThis.process
    const nodeFs = (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule('node:fs') : null
    const nodePath = (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule('node:path') : null
    if (!nodeFs || !nodePath) return null
    // CODEBUDDY_AUTH_DIR 可覆盖（测试夹具目录，使用例与真机登录状态解耦）。
    const local = (proc.env && proc.env.CODEBUDDY_AUTH_DIR) ||
      nodePath.join((proc.env && proc.env.LOCALAPPDATA) || 'C:\\Users\\lcl\\AppData\\Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
    const p = nodePath.join(local, id + '.info')
    const raw = JSON.parse(nodeFs.readFileSync(p, 'utf8'))
    const d = raw && raw.auth && raw.auth.domain
    return typeof d === 'string' && d.trim() ? d.trim() : null
  } catch (e) { return null }
}

return {
  inject: ['tools', 'subprocess', 'systemPrompt', 'timer'],
  apply(ctx) {
    const subprocess = ctx.subprocess
    const planMode = ctx.get('planMode')
    const sandboxPolicy = ctx.get('sandboxPolicy')

    // 动态沙箱无 ctx.emit：状态变化推给家级收集器（codebuddy-indicator 提供
    // codebuddyCollector 服务），由其 /codebuddy-indicator/status 路由统一暴露。
    const engine = createStatusEngine({
      publish: function (snap) {
        try {
          const collector = ctx.get('codebuddyCollector')
          if (collector && typeof collector.mergeSnapshot === 'function') collector.mergeSnapshot(snap)
        } catch (e) { }
      }
    })

    function planActiveFor(exec) {
      try {
        if (planMode && exec && exec.agent) {
          const st = planMode.get(exec.agent)
          return !!(st && st.active)
        }
      } catch (e) {}
      return false
    }

    // 沙箱内无 process/env：node 经 subprocess 解析；bin 路径为固定回退。
    // 三个后端各有独立安装包（v1.3.0 的「国际版复用同一 npm CLI」已实测推翻）：
    //   codebuddy    npm 全局包 @tencent-ai/codebuddy-code
    //   codebuddy-en WorkBuddy AI 国际版自带 CLI（C:\Program Files\WorkBuddyAI）
    //   workbuddy    WorkBuddy 国内版桌面自带 CLI（C:\Program Files\WorkBuddy）
    async function resolveExe(backend, execSignal) {
      let nodeExe = 'node'
      try { nodeExe = await subprocess.resolveExecutable('node', undefined, execSignal) } catch (e) {}
      if (backend === 'workbuddy') {
        return [nodeExe, 'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy']
      }
      if (backend === 'codebuddy-en') {
        return [nodeExe, 'C:\\Program Files\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy']
      }
      try {
        const exe = await subprocess.resolveExecutable('codebuddy', undefined, execSignal)
        // npm 安装的 codebuddy 只有 .cmd shim，Node 直接 spawn .cmd/.bat 会 EINVAL
        // （CVE-2024-27980 加固后）；命中 .cmd/.bat 时改走 node + bin 脚本。
        if (!/\.(cmd|bat)$/i.test(exe)) return exe
      } catch (e) {}
      return [nodeExe, 'C:\\Users\\lcl\\AppData\\Roaming\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy']
    }

    const runner = createRunner({
      ctx: ctx,
      subprocess: subprocess,
      engine: engine,
      resolveExe: resolveExe,
      getCwdFallback: function () {
        return (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) || CWD_FALLBACK
      },
      planActiveFor: planActiveFor,
      defaultMode: 'auto',
      // v1.3.2 可视化配置界面：getter 每次现读设置文件（面板经 POST 写入），缺失
      // 才回退 apply 时快照 —— 面板保存即时生效，无需重载插件。
      getPreferredBackend: function () { const f = readBridgeSettingsFile(); return f ? f.preferredBackend : applySettings.preferredBackend },
      getDefaultModel: function () { const f = readBridgeSettingsFile(); return f ? f.defaultModel : applySettings.defaultModel },
      // 端点/凭据（v1.3.1）：端点覆盖 > 登录域推导；凭据仅 codebuddy-en 需要。
      getEndpointOverride: function () { const f = readBridgeSettingsFile(); return f ? f.endpointOverride : applySettings.endpointOverride },
      getAuthDomain: function (backend) { return readAuthDomain(backend) },
      getAuthToken: function (backend) { const f = readBridgeSettingsFile(); return backend === 'codebuddy-en' ? (f ? f.codebuddyEnToken : applySettings.codebuddyEnToken) : null }
    })
    const coreExecute = runner.coreExecute

    // Client 可经包私有 JSON 方法读取快照。
    harness.handle('codebuddy_status', function () { return engine.statusSnapshot() })

    const OUT = { schema: { type: 'object', additionalProperties: true }, render: renderResult }
    const STATUS_OUT = { schema: { type: 'object', additionalProperties: true }, render: renderStatus }

    harness.registerTool(ctx, harness.defineTool({ name: 'codebuddy_run', description: 'Dispatch a coding/build/debug/investigation task to the local codebuddy agent CLI and return its final answer. DSH fully controls codebuddy (--permission-mode bypassPermissions; codebuddy never prompts). On rate-limit/network failure DSH pops a fallback dialog; fallback=true means finish with native tools. background=true returns a jobId. While it runs, call codebuddy_status to watch what codebuddy is doing live.', parameters: { prompt: { type: 'string', description: 'The full task/instruction for codebuddy. Be complete and self-contained.', required: true }, backend: { type: 'string', enum: ['codebuddy', 'codebuddy-intl', 'codebuddy-ioa', 'codebuddy-international', 'codebuddy-en', 'workbuddy-en', 'workbuddy-ai', 'workbuddy'], description: 'Which CLI face to dispatch to. codebuddy (default; domestic CodeBuddy npm CLI, product endpoint www.codebuddy.ai) for coding work; codebuddy-intl = CodeBuddy INTERNATIONAL face of the same npm CLI (product.ioa.json catalogue: claude-sonnet-5 / claude-opus-5 / gemini-3.1-pro / gpt-6-astra / hy3-ioa ...; aliases codebuddy-ioa / codebuddy-international) when the account is an international CodeBuddy account; codebuddy-en = WorkBuddy international edition (WorkBuddyAI desktop bundled CLI at C:\\Program Files\\WorkBuddyAI, product endpoint www.workbuddy.ai; aliases workbuddy-en / workbuddy-ai accepted; needs codebuddyEnToken unless DSH already holds a workbuddy key); workbuddy = WorkBuddy domestic desktop CLI (product endpoint copilot.tencent.com, zero config), the office-scenario face: documents/slides/spreadsheets, knowledge-base lookups, image/video generation, WeChat/WeCom replies. New calls without a backend follow the user-preferred default backend (plugin settings). Continuing a session routes back to its owning backend automatically.' }, mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'auto follows DSH plan state; plan = no writes; accept-edits = allow edits.' }, model: { type: 'string', description: 'Optional model id. When unspecified, the user-preferred default model (plugin settings) is used if set, else the CLI default. Two layers decide: the PRODUCT FACE decides whether the id exists in its catalogue, then the ACCOUNT decides whether it is licensed. The free tier (hy3, deepseek-v4.1-flash at x0.00 credits; hy4-preview at x0.29) belongs to the npm CLI faces codebuddy/codebuddy-intl: hy4-preview, hy3, hy3-x, deepseek-v4.1-flash, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, minimax-m3, minimax-m2.7, kimi-k3-1, kimi-k2.8-preview, kimi-k2.7, kimi-k2.6, deepseek-v4-pro. codebuddy-en (WorkBuddyAI) carries NO hy4-preview and NO deepseek-v4.1-flash; its only free model is hy3. International ids (claude-sonnet-5, gemini-3.1-pro, ...) are account-gated. Availability is per ACCOUNT: the CLI rejects an id outside the account catalogue with "400 service info not found" and one inside it but unlicensed with "400 only available for authorized users" (many catalogue flagships such as claude-opus-4.8, gpt-5.4 and gpt-6-astra are in this second group for a domestic account). Run the CLI with a deliberately invalid model id to print "Currently supported models for your account:" and get the authoritative list; the plugin caches that result and the settings panel lists exactly those ids with their credit multiplier (x0.00 = free), read live from the CLI descriptor so it stays in sync with CLI upgrades. Prefer the cheapest model that can do the job, and prefer a free (x0.00) one for routine work. Pass a model only when the task clearly benefits from a specific one.' }, effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' }, maxTurns: { type: 'integer', description: 'Optional max agentic turns (1-500).' }, cwd: { type: 'string', description: 'Working directory for codebuddy.' }, addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories to add to codebuddy workspace.' }, timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); a DSH-side hang guard force-terminates at timeout+60s.' }, background: { type: 'boolean', description: 'Run as a background job and return a jobId.' } }, output: OUT, execute: function (args, exec) { return coreExecute(args, exec) } }))

    harness.registerTool(ctx, harness.defineTool({ name: 'codebuddy_continue', description: 'Continue an existing codebuddy conversation with a follow-up prompt. Pass sessionId or set latest=true. Same DSH-controlled, no-prompt execution and same fallback dialog as codebuddy_run.', parameters: { prompt: { type: 'string', description: 'Follow-up instruction for the ongoing codebuddy conversation.', required: true }, sessionId: { type: 'string', description: 'codebuddy session id to resume.' }, latest: { type: 'boolean', description: 'Continue the most recent codebuddy conversation.' }, backend: { type: 'string', enum: ['codebuddy', 'codebuddy-intl', 'codebuddy-ioa', 'codebuddy-international', 'codebuddy-en', 'workbuddy-en', 'workbuddy-ai', 'workbuddy'], description: 'Which CLI face to resume on. codebuddy-en = WorkBuddy international (WorkBuddyAI desktop CLI; aliases workbuddy-en / workbuddy-ai accepted), workbuddy = WorkBuddy domestic desktop CLI. When omitted, the backend that owns the sessionId is used automatically; brand-new conversations follow the user-preferred default backend (plugin settings).' }, mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'Execution mode.' }, model: { type: 'string', description: 'Optional model id (two layers: product face carries it, account licenses it; the credit multiplier of each id comes from the CLI descriptor — see codebuddy_run).' }, effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' }, maxTurns: { type: 'integer', description: 'Optional max agentic turns.' }, cwd: { type: 'string', description: "Working directory for codebuddy; when resuming, defaults to the resumed session's project directory." }, timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); a DSH-side hang guard force-terminates at timeout+60s.' }, background: { type: 'boolean', description: 'Run as a background job and return a jobId.' } }, output: OUT, execute: function (args, exec) { const a = args || {}; const mapped = { prompt: a.prompt, backend: a.backend, mode: a.mode, model: a.model, effort: a.effort, maxTurns: a.maxTurns, cwd: a.cwd, timeoutSec: a.timeoutSec, background: a.background }; if (a.sessionId) mapped.sessionId = a.sessionId; else if (a.latest) mapped.continueLatest = true; return coreExecute(mapped, exec) } }))

    harness.registerTool(ctx, harness.defineTool({ name: 'codebuddy_status', description: 'Read a live snapshot of what the local codebuddy agent is currently doing. Returns one section per project (working directory): running count, current step (tool name + arguments being executed, or agent_response thinking/typing), recent step trail, last completed run status + session id, and per-project cumulative usage (runs + total tokens, since codebuddy exposes no quota API). Call this to check on an in-flight codebuddy_run/codebuddy_continue without waiting for it to finish.', parameters: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } }, output: STATUS_OUT, execute: function (args) { const a = args || {}; const snap = engine.statusSnapshot(); if (a.cwd) { const key = String(a.cwd); snap.projects = snap.projects.filter(function (p) { return p.cwd === key }); const g = snap.projects[0]; if (g) { snap.state = g.state; snap.running = g.running; snap.current = g.current; snap.trail = g.trail; snap.lastStatus = g.lastStatus; snap.lastAt = g.lastAt; snap.lastSessionId = g.lastSessionId; snap.lastBackend = g.lastBackend; snap.fallbackActive = g.fallbackActive; snap.runs = g.runs; snap.totalTokens = g.totalTokens; snap.updatedAt = g.updatedAt } } return snap } }))

    ctx.systemPrompt.section({ name: 'codebuddy:policy', order: 5, text: POLICY_TEXT })
  }
}