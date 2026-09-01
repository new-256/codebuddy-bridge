// test/mcp.test.mjs — MCP server 端到端（真实 stdio 子进程 + 伪 codebuddy 夹具）。
// 覆盖：协议握手/工具列表、成功运行与会话感知 cwd 回落、
// 按项目用量统计、ENOENT 失败不破坏状态、
// CODEBUDDY_MCP_ALLOWED_ROOTS 白名单护栏。

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve as resolvePath } from 'node:path'

const SERVER = fileURLToPath(new URL('../mcp/codebuddy-mcp-server.mjs', import.meta.url))
const FAKE_BIN = fileURLToPath(new URL('./fixtures/fake-codebuddy.mjs', import.meta.url))
const FIXTURES_DIR = dirname(FAKE_BIN)
const REPO_ROOT = resolvePath(FIXTURES_DIR, '..', '..')

class McpClient {
  constructor(child) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    this.buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      this.buf += d
      let idx
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx)
        this.buf = this.buf.slice(idx + 1)
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            this.pending.get(msg.id)(msg)
          }
        } catch (e) {}
      }
    })
  }
  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP request timeout: ' + method)), 20000)
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
  close() {
    try { this.child.stdin.end() } catch (e) {}
    this.child.kill()
  }
}

async function startServer(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, { CODEBUDDY_BIN: FAKE_BIN }, env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const client = new McpClient(child)
  const init = await client.request('initialize', { protocolVersion: '2024-11-05' })
  client.notify('notifications/initialized', {})
  return { child, client, init }
}

test('协议握手 + 工具列表', async () => {
  const { child, client, init } = await startServer({})
  try {
    assert.equal(init.result.serverInfo.name, 'codebuddy-mcp-server')
    assert.equal(init.result.serverInfo.version, '1.1.0')
    const tools = await client.request('tools/list', {})
    assert.deepEqual(tools.result.tools.map((t) => t.name).sort(), ['codebuddy_continue', 'codebuddy_run', 'codebuddy_status'])
    const ping = await client.request('ping', {})
    assert.deepEqual(ping.result, {})
    const unknown = await client.request('no/such/method', {})
    assert.ok(unknown.error)
  } finally {
    client.close()
  }
})

test('成功运行：tokens/session 正确 + 按项目用量统计', async () => {
  const { child, client } = await startServer({ CODEBUDDY_MCP_CWD: FIXTURES_DIR })
  try {
    const run = await client.request('tools/call', { name: 'codebuddy_run', arguments: { prompt: 'hi', cwd: FIXTURES_DIR } })
    const text = run.result.content[0].text
    assert.ok(text.includes('codebuddy OK'), text)
    assert.ok(text.includes('tokens=15'))
    assert.ok(text.includes('session=fake-s1'))
    assert.ok(text.includes('cwd=' + FIXTURES_DIR), '伪 bin 应回报其 cwd')
    // 实时折叠 + 用量统计
    const status = await client.request('tools/call', { name: 'codebuddy_status', arguments: {} })
    const st = status.result.content[0].text
    assert.ok(st.includes('Σ 1 runs · 15 tokens'), st)
    assert.ok(st.includes('fake-s1'.slice(0, 8)))
  } finally {
    client.close()
  }
})

test('续接不带 cwd 回落到 session 所在项目（而非 CWD_FALLBACK 错目录）', async () => {
  // CWD_FALLBACK 指向 repo 根（≠ fixtures）：若会话感知回落失效，伪 bin 的
  // result cwd 将变成 repo 根 → 断言失败。这正是 CWD_FALLBACK 巧合掩盖的分支。
  const { child, client } = await startServer({ CODEBUDDY_MCP_CWD: REPO_ROOT })
  try {
    await client.request('tools/call', { name: 'codebuddy_run', arguments: { prompt: 'hi', cwd: FIXTURES_DIR } })
    const cont = await client.request('tools/call', { name: 'codebuddy_continue', arguments: { prompt: 'again', sessionId: 'fake-s1' } })
    const text = cont.result.content[0].text
    assert.ok(text.includes('codebuddy OK'), text)
    assert.ok(text.includes('cwd=' + FIXTURES_DIR), '续接应回到 session 所在项目目录: ' + text.slice(0, 120))
  } finally {
    client.close()
  }
})

test('双结算回归：spawn ENOENT 后 running 归零、status 不损坏', async () => {
  // CODEBUDDY_BIN 指向缺失路径时 existsSync=false 会回退 npm 全局 bin（本机
  // 存在）；同时把 APPDATA 指到空目录让 npm bin 回退也失效 → 前缀退化为裸
  // 'codebuddy'（不在 PATH）→ 子进程 error(ENOENT) → settled 单次结算。
  const { child, client } = await startServer({
    CODEBUDDY_BIN: 'C:\\definitely\\missing\\cb.mjs',
    APPDATA: 'C:\\definitely\\missing\\appdata',
    CODEBUDDY_MCP_CWD: FIXTURES_DIR
  })
  try {
    const run = await client.request('tools/call', { name: 'codebuddy_run', arguments: { prompt: 'hi' } })
    const text = run.result.content[0].text
    assert.ok(text.includes('CODEBUDDY_UNAVAILABLE'), text)
    const status = await client.request('tools/call', { name: 'codebuddy_status', arguments: {} })
    const st = status.result.content[0].text
    assert.ok(st.includes('failed'), st)
    assert.ok(!st.includes('×'), 'running 计数不应残留: ' + st)
  } finally {
    client.close()
  }
})

test('白名单护栏：CODEBUDDY_MCP_ALLOWED_ROOTS 外的 cwd 被拒绝', async () => {
  const { child, client } = await startServer({ CODEBUDDY_MCP_ALLOWED_ROOTS: FIXTURES_DIR, CODEBUDDY_MCP_CWD: FIXTURES_DIR })
  try {
    const blocked = await client.request('tools/call', { name: 'codebuddy_run', arguments: { prompt: 'hi', cwd: REPO_ROOT } })
    const text = blocked.result.content[0].text
    assert.ok(text.includes('CWD_BLOCKED'), text)
    assert.ok(text.includes('CODEBUDDY_MCP_ALLOWED_ROOTS'), text)
    // 白名单内放行
    const allowed = await client.request('tools/call', { name: 'codebuddy_run', arguments: { prompt: 'hi', cwd: FIXTURES_DIR } })
    assert.ok(allowed.result.content[0].text.includes('codebuddy OK'))
  } finally {
    client.close()
  }
})

test('backend 参数：workbuddy 经 WORKBUDDY_BIN 夹具真跑 + 会话路由回所属后端', async () => {
  // WORKBUDDY_BIN 指向伪夹具：server 的 commandFor('workbuddy') 应采用它，
  // 结果 backend=workbuddy；随后不带 backend 的 continue 按 sessionId 路由回去。
  const { child, client } = await startServer({ WORKBUDDY_BIN: FAKE_BIN, CODEBUDDY_MCP_CWD: FIXTURES_DIR })
  try {
    const run = await client.request('tools/call', { name: 'codebuddy_run', arguments: { prompt: 'hi', backend: 'workbuddy', cwd: FIXTURES_DIR } })
    const text = run.result.content[0].text
    assert.ok(text.startsWith('workbuddy OK [status=SUCCESS'), text.slice(0, 80))
    assert.ok(text.includes('session=fake-s1'))
    const cont = await client.request('tools/call', { name: 'codebuddy_continue', arguments: { prompt: 'again', sessionId: 'fake-s1' } })
    const ctext = cont.result.content[0].text
    assert.ok(ctext.startsWith('workbuddy OK'), '续接应自动路由回 workbuddy: ' + ctext.slice(0, 80))
    const status = await client.request('tools/call', { name: 'codebuddy_status', arguments: {} })
    const st = status.result.content[0].text
    assert.ok(st.includes('[workbuddy]'), st)
  } finally {
    client.close()
  }
})

test('workbuddy 后端不可用：明确报 WorkBuddy 未安装（而非裸 ENOENT）', async () => {
  const { child, client } = await startServer({
    WORKBUDDY_BIN: 'C:\\definitely\\missing\\workbuddy-cli',
    CODEBUDDY_MCP_CWD: FIXTURES_DIR
  })
  try {
    const run = await client.request('tools/call', { name: 'codebuddy_run', arguments: { prompt: 'hi', backend: 'workbuddy' } })
    const text = run.result.content[0].text
    assert.ok(text.includes('CODEBUDDY_UNAVAILABLE'), text)
    assert.ok(text.includes('WorkBuddy'), text)
    assert.ok(text.includes('WORKBUDDY_BIN'), text)
  } finally {
    client.close()
  }
})

test('isLimited 收窄：stderr 干净但答复含网络词 → 不加限流注记', async () => {
  const { child, client } = await startServer({ CODEBUDDY_MCP_CWD: FIXTURES_DIR })
  try {
    const run = await client.request('tools/call', { name: 'codebuddy_run', arguments: { prompt: 'hi', cwd: FIXTURES_DIR } })
    assert.ok(!run.result.content[0].text.includes('rate-limit'))
  } finally {
    client.close()
  }
})
