// test/helpers/mockdsh.mjs — DSH 宿主形状的测试替身（preset / dynamic 适配层共用）。
// 覆盖适配层实际消费的 ctx/harness/subprocess 面：
//   ctx: get/interval/timeout/effect/emit/tools.register/systemPrompt.section
//   harness: defineTool/registerTool/handle（动态沙箱注入的全局）
//   subprocess: resolveExecutable/spawn（伪句柄：可脚本化 stdout 分片/stderr/exitCode）

export function createMockCtx(opts) {
  const o = opts || {}
  const services = {}
  if (o.userQuestions) services.userQuestions = o.userQuestions
  if (o.jobs) services.jobs = o.jobs
  if (o.sandboxPolicy) services.sandboxPolicy = o.sandboxPolicy
  if (o.planMode) services.planMode = o.planMode
  if (o.collector) services.codebuddyCollector = o.collector
  const registeredTools = []
  const sections = []
  const events = []
  const intervalTicks = []
  const timeouts = []
  const disposers = []
  const ctx = {
    get: (name) => services[name],
    // preset 的 announceMode 只在 ctx.setInterval 存在时续期；测试不提供 → 只发一次。
    interval(fn, ms) { intervalTicks.push(fn); return () => {} },
    timeout(fn, ms) { timeouts.push(fn); return () => {} },
    effect(fn) { try { const d = fn(); if (typeof d === 'function') disposers.push(d) } catch (e) {} },
    emit(ev, payload) { events.push({ ev, payload }) },
    tools: { register(def) { registeredTools.push(def); return () => {} } },
    systemPrompt: { section(s) { sections.push(s); return () => {} } }
  }
  return { ctx, registeredTools, sections, events, intervalTicks, timeouts, disposers, services }
}

export function createMockHarness() {
  const tools = []
  const handles = {}
  const harness = {
    defineTool(def) { return def },
    registerTool(ctx, def) { tools.push(def) },
    handle(name, fn) { handles[name] = fn }
  }
  return { harness, tools, handles }
}

// 伪 subprocess。onSpawn(spec, nth) 返回一次运行的脚本：
//   { stdout, stderr, exitCode }               —— 一次性写入
//   { chunks: [c1, c2, ...], chunkDelayMs }    —— 分片写入（测半行拼接）
//   { delayMs }                                —— done 延迟
// resolveImpl(name) 自定义可执行文件解析（默认全找不到 → 走 node+bin 回退）。
export function createMockSubprocess(onSpawn, resolveImpl) {
  const spawns = []
  const subprocess = {
    async resolveExecutable(name) {
      if (resolveImpl) return resolveImpl(name)
      throw new Error(name + ' was not found on PATH (mock)')
    },
    spawn(spec) {
      spawns.push(spec)
      const cfg = (onSpawn && onSpawn(spec, spawns.length)) || {}
      let stdoutText = ''
      let stderrText = ''
      const handle = {
        collected: {
          stdout: { readFrom: () => ({ get text() { return stdoutText } }) },
          stderr: { readFrom: () => ({ get text() { return stderrText } }) }
        },
        terminated: false,
        terminate() { handle.terminated = true },
        done: (async () => {
          await new Promise((r) => setTimeout(r, cfg.delayMs || 5))
          if (cfg.chunks) {
            for (const c of cfg.chunks) {
              stdoutText += c
              await new Promise((r) => setTimeout(r, cfg.chunkDelayMs !== undefined ? cfg.chunkDelayMs : 15))
            }
          } else {
            stdoutText = cfg.stdout || ''
            stderrText = cfg.stderr || ''
          }
          return { exitCode: cfg.exitCode !== undefined ? cfg.exitCode : 0 }
        })()
      }
      return handle
    }
  }
  return { subprocess, spawns }
}

// userQuestions 替身：script 是应答序列（{ selected: [label] }），耗尽后返回空选。
export function createUserQuestions(script) {
  const asks = []
  const uq = {
    ask(q) {
      asks.push(q)
      const next = script.length ? script.shift() : { selected: [] }
      return Promise.resolve({ answers: [{ selected: next.selected || [] }] })
    }
  }
  return { uq, asks }
}

// 模拟 DSH 250ms 轮询：每 tickMs 驱动一次所有已注册的 interval 回调。
export function driveTicks(intervalTicks, tickMs) {
  const timer = setInterval(() => {
    for (const t of intervalTicks.slice()) { try { t() } catch (e) {} }
  }, tickMs)
  return () => clearInterval(timer)
}

// codebuddy stream-json 成功输出（result 行可自定义字段）。
export function successStream(overrides) {
  const r = Object.assign({ type: 'result', subtype: 'success', is_error: false, result: 'mock answer', session_id: 'sess-1', duration_ms: 1200, num_turns: 1, usage: { input_tokens: 30, output_tokens: 20 } }, overrides || {})
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: r.session_id }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } }),
    JSON.stringify(r)
  ].join('\n') + '\n'
}
