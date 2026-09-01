#!/usr/bin/env node
// scripts/verify.mjs — 发布元数据一致性校验（CI / npm run check 调用）。
// 三处版本号锁死：package.json ↔ mcp/server VERSION ↔ docs/CHANGELOG.md 顶部条目。
// 另校验 preset 组合的结构要素（bridge 行存在且指向正确文件、preset.yml 有名称描述），
// 防止「YAML 宽容 loader 连 id/name 写错也放行」的漂移。

import { readFileSync } from 'node:fs'
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

const presetYml = readFileSync(join(root, 'preset', 'codebuddy-first', 'preset.yml'), 'utf8')
check('preset.yml declares name', /^name:\s*\S+/m.test(presetYml))
check('preset.yml declares description', /^description:\s*\S+/m.test(presetYml))

process.exit(failed ? 1 : 0)
