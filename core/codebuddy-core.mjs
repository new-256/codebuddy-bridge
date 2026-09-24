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
export const LIMIT_RE = /rate.?limit|ratelimit|\b429\b|too many|quota|insufficient|credit|balance|exhausted|exceed|\bnetwork\b|offline|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|\btimeouts?\b|timed out|unavailable|\b50[023]\b|\b40[13]\b|unauthorized|invalid api|api key|proxy|socket|tls|ssl|\bdns\b|网络|超时|限流|流量|受限|配额|金额|余额|额度|认证|连接|断开/i

export const MAX_TRAIL = 12
export const MAX_ARG_LEN = 120
export const MAX_PROJECTS = 12
export const MAX_SESSIONS = 256

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
export const BACKENDS = ['codebuddy', 'codebuddy-en', 'workbuddy']

// 各后端的 product 端点（来自 product.json 的 endpoint，补 /v2 —— resolveModelBaseURL
// 只给 product 端点补 /v2，env 覆盖值按原样使用，故覆盖值必须自带 /v2）。
export const BACKEND_ENDPOINTS = {
  'codebuddy': 'https://www.codebuddy.ai/v2',
  'codebuddy-en': 'https://www.workbuddy.ai/v2',
  'workbuddy': 'https://copilot.tencent.com/v2'
}

// 登录域（auth 库 auth.domain，明文）→ 该域可用的 API 端点。三个产品面的登录域
// 与端点已逐一实测：cn 域在 npm CLI / WorkBuddyAI 上均返回 PONG。
export const AUTH_DOMAIN_ENDPOINTS = {
  'www.codebuddy.cn': 'https://www.codebuddy.cn/v2',
  'www.codebuddy.ai': 'https://www.codebuddy.ai/v2',
  'www.workbuddy.ai': 'https://www.workbuddy.ai/v2',
  'copilot.tencent.com': 'https://copilot.tencent.com/v2'
}

// 各后端的 authentication.id（product.json），用于定位 auth 库中的凭据文件。
export const BACKEND_AUTH_IDS = {
  'codebuddy': 'Tencent-Cloud.coding-copilot',
  'codebuddy-en': 'workbuddy-desktop-ai',
  'workbuddy': 'workbuddy-desktop'
}

/** 取 URL 的 hostname（容错：非法 URL 返回空串）。 */
export function endpointHost(url) {
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
export function resolveEndpoint(explicitBaseUrl, authDomain) {
  const explicit = String(explicitBaseUrl || '').trim()
  if (explicit) return explicit
  const d = String(authDomain || '').trim().toLowerCase()
  if (d && AUTH_DOMAIN_ENDPOINTS[d]) return AUTH_DOMAIN_ENDPOINTS[d]
  return null
}

export const DEFAULT_BACKEND = 'codebuddy'

// 各后端的可选模型（来自两个已装 CLI `--help` 实测，v1.3.0/v1.3.1 的模型清单）：
// 国内面（codebuddy，npm 包）与国际面（codebuddy-en / workbuddy）列表不同。
// 设置面板据此渲染下拉候选；留空 = 各 CLI 自己的默认。
export const BACKEND_MODEL_IDS = {
  'codebuddy': ['hy4-preview', 'hy3', 'hy3-x', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3', 'minimax-m2.7', 'kimi-k3-1', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro', 'deepseek-v4-flash'],
  'codebuddy-en': ['auto', 'glm-5v-turbo', 'glm-5.1', 'glm-5.0-turbo', 'glm-5.0', 'glm-4.7', 'kimi-k2.5', 'minimax-m2.7', 'deepseek-v3-2-volc'],
  'workbuddy': ['auto', 'glm-5v-turbo', 'glm-5.1', 'glm-5.0-turbo', 'glm-5.0', 'glm-4.7', 'kimi-k2.5', 'minimax-m2.7', 'deepseek-v3-2-volc']
}

// 各后端的用户可见名（面板下拉标签；产品面与登录域互斥，故按面分列）。
// v1.3.3 正名：国际面安装目录就叫 WorkBuddyAI（`C:\Program Files\WorkBuddyAI`），
// 旧标签「CodeBuddy 国际版」让人误以为 WorkBuddy 国际版另有一个后端。规范 id
// 保持 codebuddy-en（历史会话按其归档，不可改），别名见 BACKEND_ALIASES。
export const BACKEND_LABELS = {
  'codebuddy': 'CodeBuddy 国内版（npm CLI）',
  'codebuddy-en': 'WorkBuddy 国际版（WorkBuddyAI 桌面 CLI）',
  'workbuddy': 'WorkBuddy 国内版（桌面 CLI）'
}

// 后端参数别名（v1.3.3）：workbuddy-en / workbuddy-ai 规范化到 codebuddy-en。
export const BACKEND_ALIASES = { 'workbuddy-en': 'codebuddy-en', 'workbuddy-ai': 'codebuddy-en' }

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
export function readDshWorkbuddyToken() {
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
export function resolveEnToken(settingToken) {
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
export function isBackend(v) {
  return BACKENDS.indexOf(v) >= 0
}

/**
 * 后端名规范化（v1.3.3）：接受别名 workbuddy-en / workbuddy-ai → codebuddy-en
 * （WorkBuddy 国际版就是 WorkBuddyAI 桌面自带 CLI，规范 id 不动以保证历史会话
 * 归档路由）；大小写不敏感；非后端名原样返回（由调用方的 isBackend 兜底）。
 */
export function normalizeBackend(v) {
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
export const SETTINGS_FILE_NAME = 'codebuddy-bridge-settings.json'
export const SETTINGS_KEYS = ['preferredBackend', 'defaultModel', 'codebuddyEnToken', 'endpointOverride']

function builtinModule(name) {
  try {
    const proc = globalThis.process
    return (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule(name) : null
  } catch (e) { return null }
}

/** 设置文件绝对路径（定位失败 → null；CODEBUDDY_SETTINGS_FILE 优先）。 */
export function bridgeSettingsPath() {
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
export function readBridgeSettingsFile(io) {
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
export function normalizeBridgeSettings(raw) {
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
export function readBackendAuthDomain(backend, io) {
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
export function backendSettingsMeta(backend) {
  return {
    id: backend,
    label: BACKEND_LABELS[backend] || backend,
    models: BACKEND_MODEL_IDS[backend] || [],
    productEndpoint: BACKEND_ENDPOINTS[backend] || null,
    needsToken: backend === 'codebuddy-en'
  }
}

/** 全后端元数据（面板渲染下拉与提示用）。 */
export function allBackendSettingsMeta() {
  return BACKENDS.map(backendSettingsMeta)
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
export function diagnoseBackend(backend, settings, io) {
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
export function defaultBridgeSettings() {
  return normalizeBridgeSettings(null)
}

/** 面板 POST 的原始 JSON → 完整快照（只接受四个已知字段，全清洗）。 */
export function sanitizeBridgeSettings(raw) {
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
export function writeBridgeSettingsFile(value, io) {
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
export function resolveBackend(args, target, preferredBackend) {
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
export function endpointEnv(backend, explicitBaseUrl, authDomain, authToken) {
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
export function endpointMismatchHint(backend, authDomain, hasToken) {
  if (backend === 'codebuddy-en' && !hasToken) {
    return 'codebuddy-en（WorkBuddy AI 国际版）没有可用凭据。国际版的登录 token 被桌面 App 的 protector key 封装，该密钥不落盘、headless CLI 无法自行读取（CLI 自身报 category:"missing-key"）。桥接会依次尝试：插件设置 codebuddyEnToken → 环境变量 CODEBUDDY_AUTH_TOKEN → DSH 凭据库（.credentials.yaml / .env 里的 WORKBUDDY_TOKEN）——三者皆空。请在 DSH 里配好 workbuddy provider 的 key，或把国际版 token 填入插件设置；也可直接用 backend="workbuddy"（国内版桌面 CLI，免配置）。'
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
export const MCP_BRIDGE_FILE = 'codebuddy-indicator-mcp.json'

// 快照被认为「新鲜」的时长。超时后仍在 running 的项目按「进程已死」处理：
// 子进程可能被强杀而来不及写收尾快照，否则灯会永久转圈。
export const MCP_BRIDGE_STALE_MS = 90000

// 把 engine.statusSnapshot() 收窄成可无损 JSON 化的上报载荷（只取叶子字段）。
export function buildMcpBridgePayload(snap, pid, nowMs) {
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
export function normalizeMcpBridge(payload, nowMs, staleMs) {
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

export function isLimited(res) {
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
export function isTransientCliError(res) {
  if (!res || res.ok) return false
  if (isLimited(res)) return false
  return res.status === 'ERROR_DURING_EXECUTION'
}

// 失败结果的可行动指引（v1.1.4）。此前失败只回一行 head（status/mode/tokens），
// 没有 body、没有指引：模型无从判断该重试、该换模型还是该放弃，实测会白耗一次
// codebuddy_status 再靠猜换模型。这里按失败类型给出明确下一步。
export function failureHint(res) {
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

export function clampInt(v, def, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  const i = Math.floor(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

export function shortLabel(prompt) {
  const s = String(prompt || '').replace(/\s+/g, ' ').trim()
  return s.length > 80 ? s.slice(0, 77) + '...' : s
}

// 工具入参摘要（用于状态灯/活动面板）。返回值必须是可无损 JSON 化的数据：
// undefined 值直接跳过（DSH tool 渲染层不接受 undefined）。
export function summarizeArgs(parameters) {
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
export function parseCodebuddyJson(stdoutText) {
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
export function buildResult(parsed, outcome, mode, stderrText, stdoutText, backend) {
  const bk = backend || 'codebuddy'
  const exitCode = outcome ? outcome.exitCode : null
  const errText = parsed && typeof parsed.error === 'string' && parsed.error ? parsed.error : ''
  const stderr = (stderrText ? String(stderrText).slice(-2000) : '') + (errText ? (stderrText ? ' ' : '') + errText : '')
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
export function buildArgv(prefix, args, opts) {
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
export function fallbackResult(res, mode) {
  return { ok: false, fallback: true, status: 'FALLBACK_TO_DSH', response: '', sessionId: (res && res.sessionId) || null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: res ? res.exitCode : null, mode: mode, backend: (res && res.backend) || 'codebuddy', stderr: res ? res.stderr : '', reason: res ? res.status : 'unknown' }
}

export function projectName(cwd) {
  const s = String(cwd || '')
  const parts = s.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : s
}

// ── 半行安全的行流（跨 chunk 的 NDJSON 行拼接）───────────────────────────────
// stdout chunk 可能在行中间截断；只处理到最后一个换行，剩余半行留到下一轮
// 拼接（否则跨 chunk 的行会被 JSON.parse 失败后永久丢弃）。
export function createLineStream(consumeLine) {
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
export function createStatusEngine(opts) {
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

export function renderResult(value) {
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

export function renderStatus(value) {
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

export const FALLBACK_LABEL = '使用 DSH 本地 API 配置（回退）'
export const RETRY_LABEL = '重试 codebuddy 一次'
export const CANCEL_LABEL = '不回退（返回错误）'

export const POLICY_TEXT = [
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
  'Model selection: codebuddy_run takes an optional model. When unspecified, the CLI default applies unless the user set a preferred default model in the plugin settings (then that is injected automatically per call). Supported models differ per backend: "codebuddy" (domestic npm CLI): hy4-preview, hy3, hy3-x, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, minimax-m3, minimax-m2.7, kimi-k3-1, kimi-k2.7, kimi-k2.6, deepseek-v4-pro, deepseek-v4-flash; "codebuddy-en" and "workbuddy" (desktop-bundled CLIs, shared list): auto, glm-5v-turbo, glm-5.1, glm-5.0-turbo, glm-5.0, glm-4.7, kimi-k2.5, minimax-m2.7, deepseek-v3-2-volc. Pass a model only when the task clearly benefits from a specific one; the default is usually right. Optional effort: minimal/low/medium/high/xhigh/max. Optional maxTurns caps agentic turns (default unlimited).',
  '',
  'Backends: codebuddy_run/codebuddy_continue take an optional backend parameter choosing which CLI face of the same engine (Tencent CodeBuddy Code) runs the task. "codebuddy" is the domestic CodeBuddy (npm CLI @tencent-ai/codebuddy-code, product endpoint www.codebuddy.ai) — default for coding work. "codebuddy-en" is the WorkBuddy INTERNATIONAL edition — the CLI bundled with the WorkBuddyAI desktop app (C:\\Program Files\\WorkBuddyAI, product endpoint www.workbuddy.ai); the aliases "workbuddy-en" and "workbuddy-ai" are also accepted and normalized to codebuddy-en. "workbuddy" is the CLI bundled with the domestic WorkBuddy desktop app (product endpoint copilot.tencent.com, zero config) — the office-scenario face: documents, slides, spreadsheets, knowledge-base lookups, image/video generation, WeChat/WeCom replies. When the user asks for office/document/IM work, dispatch with backend="workbuddy"; for international accounts use "codebuddy-en" (a.k.a. WorkBuddy 国际版 / WorkBuddyAI). Sessions are kept per backend (login domains are exclusive), and continuing a session automatically routes back to the backend that owns it (explicit backend wins). A user-preferred default backend (plugin settings) applies when a call is new (no session) and no explicit backend is given.'
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
export function createRunner(o) {
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
