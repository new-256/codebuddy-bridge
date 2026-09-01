// codebuddy-indicator — host half.
//
// 收集各会话 codebuddy-first-bridge 插件（preset 或动态形态）推送的 codebuddy 运行快照，
// 维护一张按项目（工作目录 cwd）索引的全局表，并通过 webServer 注册
// GET /codebuddy-indicator/status 路由暴露给浏览器。
//
// 两个数据入口：
//   1. preset 形态（真 Node 模块，codebuddy-first-bridge preset）：apply 时
//      ctx.emit('codebuddy/mode', { active: true }) 宣告 codebuddy 优先模式；每次状态
//      变化 ctx.emit('codebuddy/status', { snapshot }) 推送快照。
//   2. 动态形态（当前会话的 cordis 动态插件，沙箱无 ctx.emit）：通过
//      ctx.provide 暴露的 codebuddyCollector 服务调用 mergeSnapshot(snapshot) 推入。
//
// 家级（cordis.patch.yml）插件运行在 host 组合的 root realm；会话内插件的
// ctx.emit 事件是 app 级广播，不受 isolate realm（只隔离服务）影响。
//
// 路由返回 JSON：{ state, running, projects[], presetActive }。

export const name = 'codebuddy-indicator'
export const inject = []
export function apply(ctx) {
  const projects = Object.create(null)
  const MAX_PROJECTS = 24
  let presetActive = false

  function projectName(cwd) {
    const s = String(cwd || '')
    const parts = s.split(/[\\/]/).filter(Boolean)
    return parts.length ? parts[parts.length - 1] : s
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

  ctx.on('codebuddy/mode', (payload) => {
    try {
      presetActive = !!(payload && payload.active)
    } catch (e) { }
  })

  ctx.on('codebuddy/status', (payload) => {
    try {
      const snap = payload && typeof payload === 'object' && payload.snapshot ? payload.snapshot : payload
      mergeSnapshot(snap)
    } catch (e) { }
  })

  try {
    ctx.provide('codebuddyCollector', { mergeSnapshot })
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
            const now = Date.now()
            const OK_HOLD_MS = presetActive ? 10 * 60 * 1000 : 8000
            const STALE_MS = 10 * 60 * 1000
            const list = Object.keys(projects)
              .map((k) => projects[k])
              .filter((p) => {
                const age = now - (Number(p.updatedAt) || 0)
                if (p.running > 0 || p.fallbackActive) return true
                if (p.state === 'running') return true
                if (p.state === 'ok' || p.state === 'failed') return age < OK_HOLD_MS
                return age < STALE_MS
              })
              .sort((a, b) => b.updatedAt - a.updatedAt)
            const running = list.reduce((n, p) => n + p.running, 0)
            const state = running > 0 ? 'running' : (list.some((p) => p.fallbackActive) ? 'fallback' : (list.length ? 'ok' : 'idle'))
            const body = JSON.stringify({ state, running, projects: list, presetActive })
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
