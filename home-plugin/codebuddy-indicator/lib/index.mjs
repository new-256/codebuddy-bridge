// codebuddy-indicator — host half.
//
// 收集各会话 codebuddy-first-bridge 插件（preset 或动态形态）推送的 codebuddy 运行快照，
// 维护一张按项目（工作目录 cwd）索引的全局表，并通过 webServer 注册
// GET /codebuddy-indicator/status 路由暴露给浏览器。
//
// 两个数据入口：
//   1. preset 形态（真 Node 模块，codebuddy-first-bridge preset）：apply 时
//      ctx.emit('codebuddy/mode', { active: true }) 宣告 codebuddy 优先模式，此后每
//      30s 心跳续期；每次状态变化 ctx.emit('codebuddy/status', { snapshot }) 推送快照。
//   2. 动态形态（当前会话的 cordis 动态插件，沙箱无 ctx.emit）：通过
//      ctx.provide 暴露的 codebuddyCollector 服务调用 mergeSnapshot(snapshot) 推入。
//
// presetActive 是「心跳租约」而非粘滞标志（v1.1.1 修复）：preset 每 30s 宣告一次
// active:true，TTL 75s（≈两拍容差，容忍事件循环抖动）；最后一个 codebuddy-first
// 会话关闭后心跳停止，租约到期自动熄灭——否则任何会话加载过一次 preset 之后，
// 所有会话（含非 codebuddy-first 模式）的标题栏都会常驻「CB 就绪」灯。
//
// 按会话判定（v1.1.3）：端点返回 presetSessions —— 当前组合了 codebuddy-first
// preset 的会话 id 名单。客户端只需判断「我的 sessionId 在不在名单里」，在/不在
// 都是确定答案，不必去猜 DSH 客户端会话摘要里 agentPreset 字段的位置（0.3.14 刚
// 把它移进 projectionValues，v1.1.2 的判定就此失效；默认会话更是根本没有该字段
// → 判定「未知」→ 回退全局租约 → 普通会话仍亮灯）。
//
// 名单有两个来源，取并集：
//   A. 实时枚举（首选，权威）：agents.list() 遍历活着的 agent，用
//      agentPresets.composedPreset(agent.ctx) 读它实际组合的 preset id。
//      每次请求现算，对已经开着的会话立即生效，不依赖任何上报。
//   B. preset 上报（兜底）：preset 在 codebuddy/mode 事件里带上自己的 sessionId
//      并按会话记租约。A 不可用时（服务缺失/DSH 内部 API 变动）仍能工作。
// 两源都失灵时退回全局租约 presetActive（老语义）。
//
// 家级（cordis.patch.yml）插件运行在 host 组合的 root realm；会话内插件的
// ctx.emit 事件是 app 级广播，不受 isolate realm（只隔离服务）影响。
//
// 路由返回 JSON：{ state, running, projects[], presetActive, presetSessions[], lastModeAt }。

export const PRESET_TTL_MS = 75000
export const PRESET_ID = 'codebuddy-first'

// MCP 子进程快照文件（v1.1.5）。标准（非 codebuddy-first）模式下 codebuddy 经全局
// MCP 行调用，那是**独立子进程**：没有 ctx.emit，也拿不到 codebuddyCollector 服务，
// 所以此前家级插件收不到任何 MCP 路径数据 —— 状态灯在整个调用过程中完全不出现。
// 现在 MCP 把快照原子写进 dsh-home/<MCP_BRIDGE_FILE>，这里在响应请求时读取合并。
// 不走 HTTP 反推：webServer.register 不暴露端口，且端口实测会变。
export const MCP_BRIDGE_FILE = 'codebuddy-indicator-mcp.json'
export const MCP_BRIDGE_STALE_MS = 90000

// 同时在线的 codebuddy-first 会话上限（防御异常上报导致的无界增长）。
const MAX_SESSIONS = 64

// 过期快照里仍在 running 的项目降级为已结束：子进程可能被强杀而来不及写收尾
// 快照，否则灯会永久转圈。纯函数，便于独立测试。
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
  return { source: 'mcp', updatedAt: updatedAt, stale: stale, projects: out }
}

// 可独立于 Cordis 测试的纯状态机：注入 now（时钟）、ttlMs（租约时长）与
// listPresetSessions（实时枚举器，返回 codebuddy-first 会话 id 数组）即可。
export function createIndicatorState(opts) {
  const o = opts || {}
  const now = typeof o.now === 'function' ? o.now : Date.now
  const ttlMs = o.ttlMs != null ? o.ttlMs : PRESET_TTL_MS
  const listPresetSessions = typeof o.listPresetSessions === 'function' ? o.listPresetSessions : null
  const projects = Object.create(null)
  const MAX_PROJECTS = 24
  let presetActiveUntil = 0
  let lastModeAt = 0
  // sessionId -> 租约到期时间戳（按会话判定的权威来源）。
  const sessionLeases = Object.create(null)

  function projectName(cwd) {
    const s = String(cwd || '')
    const parts = s.split(/[\\/]/).filter(Boolean)
    return parts.length ? parts[parts.length - 1] : s
  }

  // codebuddy/mode 事件：active:true 续租；active:false 立即熄灭（preset 当前
  // 不主动发 false——依赖租约到期——但收到即尊重，面向未来语义完整）。
  function onMode(payload) {
    try {
      const sid = payload && typeof payload.sessionId === 'string' && payload.sessionId ? payload.sessionId : null
      if (payload && payload.active) {
        presetActiveUntil = now() + ttlMs
        lastModeAt = now()
        if (sid) {
          sessionLeases[sid] = now() + ttlMs
          // 上限保护：超出时丢掉最早到期的租约（正常情况过期项已被 snapshot 清掉）。
          const ids = Object.keys(sessionLeases)
          if (ids.length > MAX_SESSIONS) {
            ids.sort((a, b) => sessionLeases[a] - sessionLeases[b])
            for (let i = 0; i < ids.length - MAX_SESSIONS; i++) delete sessionLeases[ids[i]]
          }
        }
      } else {
        // 明确下线：带 sessionId 只熄灭该会话（最后一个走时顺带清全局租约，让仍
        // 读 presetActive 的旧客户端也立刻熄灭）；不带 sessionId 的旧版 preset
        // 按老语义视为全局下线。
        if (sid) {
          delete sessionLeases[sid]
          if (Object.keys(sessionLeases).length === 0) presetActiveUntil = 0
        } else {
          presetActiveUntil = 0
        }
      }
    } catch (e) { }
  }

  function mergeSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return
    const list = Array.isArray(snap.projects) ? snap.projects : (snap.cwd ? [snap] : [])
    for (const p of list) {
      if (!p || !p.cwd) continue
      projects[p.cwd] = {
        cwd: p.cwd,
        name: p.name || projectName(p.cwd),
        state: p.state || 'idle',
        running: Number(p.running) || 0,
        current: p.current || null,
        trail: Array.isArray(p.trail) ? p.trail.slice(-12) : [],
        lastStatus: p.lastStatus || null,
        lastAt: p.lastAt || 0,
        lastSessionId: p.lastSessionId || null,
        fallbackActive: !!p.fallbackActive,
        updatedAt: Number(p.updatedAt) || Date.now()
      }
    }
    const keys = Object.keys(projects)
    if (keys.length > MAX_PROJECTS) {
      const stale = keys
        .map((k) => projects[k])
        .filter((p) => p.running === 0 && !p.fallbackActive)
        .sort((a, b) => a.updatedAt - b.updatedAt)
      const drop = Math.max(0, keys.length - MAX_PROJECTS)
      for (let i = 0; i < drop && i < stale.length; i++) delete projects[stale[i].cwd]
    }
  }

  // 计算对外快照（纯函数式：不修改内部表）。
  function snapshot() {
    const t = now()
    // 会话名单 = 实时枚举（权威）∪ preset 上报租约（兜底）。
    const seen = Object.create(null)
    const presetSessions = []
    if (listPresetSessions) {
      try {
        const live = listPresetSessions()
        if (Array.isArray(live)) {
          for (const sid of live) {
            if (typeof sid === 'string' && sid && !seen[sid]) { seen[sid] = 1; presetSessions.push(sid) }
          }
        }
      } catch (e) { }
    }
    // 顺手清理过期上报租约。
    for (const sid of Object.keys(sessionLeases)) {
      if (t < sessionLeases[sid]) {
        if (!seen[sid]) { seen[sid] = 1; presetSessions.push(sid) }
      } else delete sessionLeases[sid]
    }
    const presetActive = t < presetActiveUntil || presetSessions.length > 0
    const OK_HOLD_MS = presetActive ? 10 * 60 * 1000 : 8000
    const STALE_MS = 10 * 60 * 1000
    const list = Object.keys(projects)
      .map((k) => projects[k])
      .filter((p) => {
        const age = t - (Number(p.updatedAt) || 0)
        if (p.running > 0 || p.fallbackActive) return true
        if (p.state === 'running') return true
        if (p.state === 'ok' || p.state === 'failed') return age < OK_HOLD_MS
        return age < STALE_MS
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const running = list.reduce((n, p) => n + p.running, 0)
    const state = running > 0 ? 'running' : (list.some((p) => p.fallbackActive) ? 'fallback' : (list.length ? 'ok' : 'idle'))
    return { state, running, projects: list, presetActive, presetSessions, lastModeAt }
  }

  return { onMode, mergeSnapshot, snapshot }
}

export const name = 'codebuddy-indicator'
export const inject = []

export function apply(ctx) {
  // 实时枚举器：遍历活着的 agent，读它实际组合的 preset id。全程防御——任一
  // 服务或字段缺失（DSH 内部 API 变动）都只是返回空数组，退回 preset 上报兜底。
  function listPresetSessions() {
    try {
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
      if (!agents || typeof agents.list !== 'function') return []
      if (!presets || typeof presets.composedPreset !== 'function') return []
      const out = []
      for (const agent of agents.list()) {
        try {
          if (!agent || !agent.ctx) continue
          if (presets.composedPreset(agent.ctx) !== PRESET_ID) continue
          const sid = agent.id || (agent.session && agent.session.id)
          if (typeof sid === 'string' && sid) out.push(sid)
        } catch (e) { }
      }
      return out
    } catch (e) { return [] }
  }

  const st = createIndicatorState({ listPresetSessions })

  ctx.on('codebuddy/mode', st.onMode)

  ctx.on('codebuddy/status', (payload) => {
    try {
      const snap = payload && typeof payload === 'object' && payload.snapshot ? payload.snapshot : payload
      st.mergeSnapshot(snap)
    } catch (e) { }
  })

  try {
    ctx.provide('codebuddyCollector', { mergeSnapshot: st.mergeSnapshot })
  } catch (e) { }

  // MCP 子进程快照文件的读取端。dsh-home 从本模块位置推导：
  // <dsh-home>/plugins/codebuddy-indicator/lib/index.mjs → 上溯三级目录。
  // 读取在响应请求时进行（客户端本就在轮询，天然限频），失败一律忽略。
  function builtin(name) {
    try {
      return (globalThis.process && typeof globalThis.process.getBuiltinModule === 'function')
        ? globalThis.process.getBuiltinModule(name)
        : null
    } catch (e) { return null }
  }
  const nodeFs = builtin('node:fs')
  const nodePath = builtin('node:path')
  const nodeUrl = builtin('node:url')

  let bridgePath = null
  try {
    const envDir = globalThis.process && globalThis.process.env
      ? (globalThis.process.env.CODEBUDDY_INDICATOR_DIR || globalThis.process.env.DSH_HOME)
      : null
    if (envDir && nodePath) {
      bridgePath = nodePath.join(envDir, MCP_BRIDGE_FILE)
    } else if (nodePath && nodeUrl && import.meta.url) {
      const libDir = nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url))     // .../lib
      const home = nodePath.resolve(libDir, '..', '..', '..')                     // dsh-home
      bridgePath = nodePath.join(home, MCP_BRIDGE_FILE)
    }
  } catch (e) { bridgePath = null }

  let lastBridgeStamp = 0
  function ingestMcpBridge() {
    if (!bridgePath || !nodeFs) return
    try {
      const stamp = Number(nodeFs.statSync(bridgePath).mtimeMs) || 0
      // 未变更就不重复合并：mergeSnapshot 会把缺失的 updatedAt 补成 now，重复
      // 合并会让过期数据一直显得很新，从而绕过快照的过期判定。
      if (stamp === lastBridgeStamp) return
      const norm = normalizeMcpBridge(JSON.parse(nodeFs.readFileSync(bridgePath, 'utf8')), Date.now(), MCP_BRIDGE_STALE_MS)
      if (norm && norm.projects.length) st.mergeSnapshot(norm)
      lastBridgeStamp = stamp
    } catch (e) { }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const ws = webCtx.get('webServer')
      if (!ws || typeof ws.register !== 'function') return
      webCtx.effect(() => ws.register({
        kind: 'exact',
        path: '/codebuddy-indicator/status',
        handler: (req, res) => {
          try {
            ingestMcpBridge()
            const body = JSON.stringify(st.snapshot())
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
            res.end(body)
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: String(e && e.message || e) }))
          }
        }
      }), 'codebuddy-indicator: status route')
    })
  }
}
