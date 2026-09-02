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
// 家级（cordis.patch.yml）插件运行在 host 组合的 root realm；会话内插件的
// ctx.emit 事件是 app 级广播，不受 isolate realm（只隔离服务）影响。
//
// 路由返回 JSON：{ state, running, projects[], presetActive }。

export const PRESET_TTL_MS = 75000

// 可独立于 Cordis 测试的纯状态机：注入 now（时钟）与 ttlMs（租约时长）即可。
export function createIndicatorState(opts) {
  const o = opts || {}
  const now = typeof o.now === 'function' ? o.now : Date.now
  const ttlMs = o.ttlMs != null ? o.ttlMs : PRESET_TTL_MS
  const projects = Object.create(null)
  const MAX_PROJECTS = 24
  let presetActiveUntil = 0
  let lastModeAt = 0

  function projectName(cwd) {
    const s = String(cwd || '')
    const parts = s.split(/[\\/]/).filter(Boolean)
    return parts.length ? parts[parts.length - 1] : s
  }

  // codebuddy/mode 事件：active:true 续租；active:false 立即熄灭（preset 当前
  // 不主动发 false——依赖租约到期——但收到即尊重，面向未来语义完整）。
  function onMode(payload) {
    try {
      if (payload && payload.active) {
        presetActiveUntil = now() + ttlMs
        lastModeAt = now()
      } else {
        presetActiveUntil = 0
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
    const presetActive = t < presetActiveUntil
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
    return { state, running, projects: list, presetActive, lastModeAt }
  }

  return { onMode, mergeSnapshot, snapshot }
}

export const name = 'codebuddy-indicator'
export const inject = []

export function apply(ctx) {
  const st = createIndicatorState()

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

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const ws = webCtx.get('webServer')
      if (!ws || typeof ws.register !== 'function') return
      webCtx.effect(() => ws.register({
        kind: 'exact',
        path: '/codebuddy-indicator/status',
        handler: (req, res) => {
          try {
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
