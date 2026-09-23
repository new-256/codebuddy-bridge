#!/usr/bin/env node
// scripts/verify.mjs — 发布元数据一致性校验（CI / npm run check 调用）。
// 三处版本号锁死：package.json ↔ mcp/server VERSION ↔ docs/CHANGELOG.md 顶部条目。
// 另校验 preset 组合的结构要素（bridge 行存在且指向正确文件、preset.yml 有名称描述），
// 防止「YAML 宽容 loader 连 id/name 写错也放行」的漂移。

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = false
function check(label, cond) {
  if (cond) { console.log('ok: ' + label) } else { console.error('FAIL: ' + label); failed = true }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const mcpSrc = readFileSync(join(root, 'mcp', 'codebuddy-mcp-server.mjs'), 'utf8')
const changelog = readFileSync(join(root, 'docs', 'CHANGELOG.md'), 'utf8')

const mcpMatch = mcpSrc.match(/^const VERSION = '([^']+)'/m)
const logMatch = changelog.match(/^## \[([^\]]+)\]/m)

check('mcp server declares VERSION', !!mcpMatch)
check('CHANGELOG has a top version entry', !!logMatch)
if (mcpMatch && logMatch) {
  check('version sync package.json == MCP VERSION (' + pkg.version + ')', pkg.version === mcpMatch[1])
  check('version sync package.json == CHANGELOG top (' + pkg.version + ')', pkg.version === logMatch[1])
}

const cordis = readFileSync(join(root, 'preset', 'codebuddy-first', 'agent.cordis.yml'), 'utf8')
check("agent.cordis.yml has bridge row (id: codebuddy-first-bridge)", /^- id: codebuddy-first-bridge$/m.test(cordis))
check("agent.cordis.yml bridge row points to './codebuddy-first-bridge.mjs'", /name:\s*'\.\/codebuddy-first-bridge\.mjs'/.test(cordis))

// persona 配置结构（v1.1.6）：DSH 后端 0.1.3-alpha.2 起 @deepseek-ai/dsh-persona 的
// Schemastery schema 升级为 prefix: z.string().required() + suffix: z.string()
// .default("")，旧 `text:` 字段被校验器拒绝挂载（恢复会话抛 invalid config:
// $.prefix missing required value）。钉死新结构，禁止回退旧字段。
const personaBlock = cordis.split('\n').findIndex((l) => l.includes("name: '@deepseek-ai/dsh-persona'"))
const personaSlice = personaBlock >= 0 ? cordis.split('\n').slice(personaBlock).join('\n') : ''
check('agent.cordis.yml has persona row', personaBlock >= 0)
check('agent.cordis.yml persona uses prefix (required since dsh 0.1.3-alpha.2)', /^\s+prefix:/m.test(personaSlice))
check('agent.cordis.yml persona declares suffix', /^\s+suffix:/m.test(personaSlice))
check('agent.cordis.yml persona has NO legacy text: field', !/^\s+text:/m.test(personaSlice))

// v1.2.0：preset 声明式注册的结构闸门。新 DSH（≥0.1.7-alpha.1）Form-A 走声明制，
// 声明定义在 home-plugin/codebuddy-indicator/lib/preset-definition.mjs（由 indicator
// 自注册），本节锁住它的结构要素：存在、id 一致、桥接行裸说明符、__jsExpr 等价、
// 官方行数、exports 子路径存在。
const defSrc = readFileSync(join(root, 'home-plugin', 'codebuddy-indicator', 'lib', 'preset-definition.mjs'), 'utf8')
check('preset-definition.mjs exists', defSrc.length > 0)
check('preset-definition declares PRESET_ID codebuddy-first', /export const PRESET_ID = 'codebuddy-first'/.test(defSrc))
check('preset-definition bridge row uses bare specifier', /codebuddy-first-bridge\/preset-bridge/.test(defSrc))
check('preset-definition has no relative bridge anchor (registry baseUrl pitfall)', !/name:\s*['"]\.\//.test(defSrc))
const jsExprCount = (defSrc.match(/__jsExpr/g) || []).length
check('preset-definition carries 2 __jsExpr nodes (tool-bash/tool-pwsh platform gates)', jsExprCount >= 2)
const defRowIds = [...defSrc.matchAll(/\{ id: '([a-z0-9-]+)'/g)].map((m) => m[1])
check('preset-definition ports official standard rows (>= 27 rows incl. groups/bridge)', defRowIds.length >= 27)
check('preset-definition has bridge row last', defRowIds[defRowIds.length - 1] === 'codebuddy-first-bridge')
check('package.json exports ./preset-bridge subpath', pkg.exports && pkg.exports['./preset-bridge'] === './preset/codebuddy-first/codebuddy-first-bridge.mjs')
check('bridge preset entry exists on disk', existsSync(join(root, 'preset', 'codebuddy-first', 'codebuddy-first-bridge.mjs')))

const presetYml = readFileSync(join(root, 'preset', 'codebuddy-first', 'preset.yml'), 'utf8')
check('preset.yml declares name', /^name:\s*\S+/m.test(presetYml))
check('preset.yml declares description', /^description:\s*\S+/m.test(presetYml))

// 标准 npm 分发形态（v1.1.7，对齐 agy-first-bridge v1.6.0）：
// 主包 package.json main 直指 indicator 的 lib/index.mjs（host 真入口），
// dsh.bundle.patch 指向 bundle 补丁层，家级插件由裸包名一行加载，不再有
// file:// 行 / client-entry 占位。钉死该结构，防止退回旧式安装。
const hpPkg = JSON.parse(readFileSync(join(root, 'home-plugin', 'codebuddy-indicator', 'package.json'), 'utf8'))
check('main package main points to indicator lib/index.mjs', pkg.main === './home-plugin/codebuddy-indicator/lib/index.mjs')
check('main package dsh.bundle.patch declared', /^[^/].*"patch"\s*:\s*"\.\/home-plugin\/codebuddy-indicator\/cordis\.patch\.yml"/m.test(JSON.stringify(pkg.dsh || {})))
check('main package exports ./client points to client.js', pkg.exports && pkg.exports['./client'] === './home-plugin/codebuddy-indicator/lib/client.js')
check('indicator package main points to lib/index.mjs (no client-entry placeholder)', hpPkg.main === './lib/index.mjs')
check('indicator package has bundle patch layer', hpPkg.dsh && hpPkg.dsh.bundle && hpPkg.dsh.bundle.patch === './cordis.patch.yml')
check('bundle patch layer exists', readFileSync(join(root, 'home-plugin', 'codebuddy-indicator', 'cordis.patch.yml'), 'utf8').includes('- insert:'))

// client 注册 id 闸门（v1.1.9，事故回归）：client-modules 的 graph row 以【包名】
// 为 id（exports["./client"] 归属包），bundle 脚本执行后按
// `loaded without registering "<packageName>"` 校验注册名。client.js 的
// __ModuleLoader__.load({ id }) 必须与包名严格一致，否则整个 client combo
// 加载失败 → DSH 启动致命屏（v1.1.7 写成旧独立包名 codebuddy-indicator 即此事故）。
// 从 exports["./client"] 解析实际文件，提取 load() 调用后的首个 id:，与 pkg.name 比对。
const clientPath = pkg.exports && pkg.exports['./client']
check('main package declares exports["./client"]', typeof clientPath === 'string' && clientPath.length > 0)
if (clientPath) {
  const clientSrc = readFileSync(join(root, clientPath), 'utf8')
  const loadIdx = clientSrc.indexOf('__ModuleLoader__.load(')
  check('client.js has __ModuleLoader__.load call', loadIdx >= 0)
  if (loadIdx >= 0) {
    // 取 load( 后首个 {…} 窗口，剥掉 // 行注释（注释里也会出现 id 字样），再提 id。
    const window = clientSrc.slice(loadIdx, loadIdx + 1500).replace(/\/\/[^\n]*/g, '')
    const idMatch = window.match(/\bid:\s*["']([^"']+)["']/)
    check('client.js load id extracted', !!idMatch)
    check('client.js load id == package name (' + pkg.name + ')', idMatch && idMatch[1] === pkg.name)
  }
}

process.exit(failed ? 1 : 0)
