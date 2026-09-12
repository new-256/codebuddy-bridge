#!/usr/bin/env node
// scripts/dsh-compat.mjs — dsh 全版本兼容性回测 + 支持矩阵生成（v1.1.10 引入）
//
// 目的：对 npm 上【每一个】已发布的 @deepseek-ai/dsh 版本，静态探测本插件
// 依赖的平台契约点，并可选用沙箱真实安装做功能回测，产出支持声明（见
// docs/COMPATIBILITY.md）。
//
// 探测的契约点（各自对应一次真实事故或已知约束）：
//   C1 plugin CLI        dsh 是否有 `dsh plugin --profile <p> add <pkg>` 命令
//   C2 pnpm 转发          plugin 命令是否以 pnpm 转发器实现（依赖 pnpm 在 PATH）
//   C3 bundle patch 声明  是否读取依赖包 package.json 的 dsh.bundle.patch 并挂载
//   C4 bundles 对账       是否维护 dsh.profile.bundles 层列表
//   C5 persona schema     dsh-persona 是否要求 prefix/suffix（v1.1.6 迁移的根因）
//   C6 注册名校验         dsh-client-modules arrive() 的
//                         `loaded without registering "<pkgName>"`（v1.1.8 事故的根因）
//   C7 graph id 定位      client-modules host 侧 locatePkgJson（graph id = 包名的机制）
//
// 用法：
//   node scripts/dsh-compat.mjs                # Phase 1 静态探测（全部 dsh 版本）
//   node scripts/dsh-compat.mjs --full         # + Phase 2 沙箱安装回测（需 pnpm + 网络）
//   node scripts/dsh-compat.mjs --full --only 0.1.5-rc.2   # 只测一个版本（调试用）
//
// 输出：markdown 矩阵到 stdout；详细 JSON 到 dsh-compat-result.json。
// 传输：经 npm CLI（自动重试 + shasum 校验 + npmmirror 镜像兜底，理由见
// scripts/audit-npm-sync.mjs 头注）。

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(tmpdir(), 'dsh-compat-cache')
const MIRROR = 'https://registry.npmmirror.com'

const DSH = '@deepseek-ai/dsh'
const PERSONA = '@deepseek-ai/dsh-persona'
const CLIENT_MODULES = '@deepseek-ai/dsh-client-modules'
const PROBE_PKG = 'codebuddy-first-bridge'
const PROBE_VER = '1.1.9'

// ── npm CLI 解析与传输（Windows .cmd shim 不可直接 spawn，见 audit 脚本） ──
function resolveNpmCli() {
  const dir = dirname(process.execPath)
  const cands = [
    join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const c of cands) if (existsSync(c)) return c
  return null
}
const NPM_CLI = resolveNpmCli()

function runNpm(args, opts = {}) {
  if (NPM_CLI) {
    return execFileSync(process.execPath, [NPM_CLI, ...args], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts,
    })
  }
  return execFileSync('npm', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts })
}

function npmJson(args, cwd) {
  return JSON.parse(runNpm(args, { cwd }))
}

/** npm pack + 解包（官方→镜像兜底 + shasum 校验），按 <pkg>@<ver> 缓存 */
function packExtractCached(spec, shasum) {
  const key = spec.replace(/[^a-zA-Z0-9.@-]/g, '_')
  const out = join(CACHE, key)
  if (existsSync(join(out, 'package'))) return join(out, 'package')
  mkdirSync(out, { recursive: true })
  const attempts = [
    ['--fetch-retries=5'],
    ['--fetch-retries=5', '--registry=' + MIRROR],
  ]
  let lastErr = null
  for (const extra of attempts) {
    try {
      runNpm(['pack', spec, '--silent', ...extra, '--pack-destination', out], {
        cwd: out, stdio: ['ignore', 'ignore', 'pipe'],
      })
      const tgz = readdirSync(out).find((f) => f.endsWith('.tgz'))
      if (!tgz) throw new Error('未产出 tgz')
      if (shasum) {
        const actual = createHash('sha1').update(readFileSync(join(out, tgz))).digest('hex')
        if (actual !== shasum) throw new Error(`shasum 校验失败: 期望 ${shasum} 实际 ${actual}`)
      }
      execFileSync('tar', ['-xf', join(out, tgz), '-C', out])
      if (!existsSync(join(out, 'package'))) throw new Error('无 package/ 根')
      // 清掉 tgz 节省缓存空间
      rmSync(join(out, tgz), { force: true })
      return join(out, 'package')
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

/** 完整 semver 比较（含 prerelease；dsh 全版本均带 -alpha/-rc 后缀） */
function cmpSemver(a, b) {
  const P = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v)
    if (!m) return null
    return { n: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] }
  }
  const pa = P(a), pb = P(b)
  if (!pa || !pb) return a < b ? -1 : 1
  for (let i = 0; i < 3; i++) if (pa.n[i] !== pb.n[i]) return pa.n[i] - pb.n[i]
  if (!pa.pre.length && !pb.pre.length) return 0
  if (!pa.pre.length) return 1
  if (!pb.pre.length) return -1
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i], y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    if (nx && ny) { if (+x !== +y) return +x - +y }
    else if (nx) return -1
    else if (ny) return 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** 拼接包内全部 JS 文本用于字符串探针 */
function readJsBlob(pkgRoot) {
  const parts = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && /\.(js|mjs|cjs)$/.test(e.name)) parts.push(readFileSync(p, 'utf8'))
    }
  }
  walk(pkgRoot)
  return parts.join('\n')
}

// ── Phase 1：静态契约探测 ─────────────────────────────────────────────────
function staticProbe(v, manifest) {
  const row = { version: v, published: null, bin: null, probes: {}, persona: {}, clientModules: {}, note: '' }

  const dshRoot = packExtractCached(`${DSH}@${v}`, manifest.dist && manifest.dist.shasum)
  const blob = readJsBlob(dshRoot)
  row.bin = typeof manifest.bin === 'string' ? manifest.bin : (manifest.bin && manifest.bin.dsh) || null
  row.probes = {
    pluginCmd: blob.includes('command("plugin")') || blob.includes("command('plugin')"),
    pnpmFwd: blob.includes('pnpm'),
    bundlePatchDecl: /dsh\??\.bundle\??\.patch/.test(blob) || blob.includes('cordis.patch.yml'),
    bundlesList: blob.includes('profile.bundles'),
  }

  // 锁步同名版本探测 dsh-persona / dsh-client-modules
  try {
    const pb = readJsBlob(packExtractCached(`${PERSONA}@${v}`, null))
    row.persona.prefixSchema = pb.includes('prefix: z.string().required()')
    row.persona.legacyText = /text:\s*z\.string\(\)/.test(pb)
  } catch (e) {
    row.persona.error = e.message.slice(0, 120)
  }
  try {
    const cb = readJsBlob(packExtractCached(`${CLIENT_MODULES}@${v}`, null))
    row.clientModules.regCheck = cb.includes('loaded without registering')
    row.clientModules.locatePkgJson = cb.includes('locatePkgJson')
  } catch (e) {
    row.clientModules.error = e.message.slice(0, 120)
  }
  return row
}

// ── Phase 2：沙箱功能回测（真实 `dsh plugin --profile web add`） ──────────
function functionalProbe(row) {
  const sb = mkdtempSync(join(tmpdir(), 'dsh-fn-'))
  const checks = {}
  try {
    // ① npm install 该版本 dsh（自带依赖树；tarball 不含 node_modules）。
    //    安装失败（如 E404 依赖包已从 registry 下架）分类为 skipped —— 这是
    //    「该 dsh 版本今日已不可安装」的平台事实，不是本插件的兼容性问题。
    const envDir = join(sb, 'env')
    mkdirSync(envDir)
    // 安装失败时取错误尾部（execFileSync 的 message 以超长命令行开头，取尾部才能
    // 看到 npm 的真实错误：E404 缺包 / ERESOLVE / ECONNRESET 等）
    const errTail = (e) => String(e.stderr || '').slice(-500) || String(e.message || '').slice(-400)
    // 瞬时网络/超时类错误与「依赖树真的缺包」区分开：前者可重试，后者是平台事实
    const isTransient = (s) => /ETIMEDOUT|timed out|timeout|ECONNRESET|socket hang up|terminated|EAI_AGAIN/i.test(s)
    let installErr = null
    let installErrText = ''
    // 镜像优先：国内直连官方 CDN 会间歇 stall/ECONNRESET（本项目历史上反复踩到），
    // npmmirror 是官方镜像、包内容经 integrity/shasum 校验逐字节等价，仅传输更快。
    // --legacy-peer-deps 放第一顺位：2026-08 上半月的 rc 版本 peer 依赖组合在今天
    // 的 npm 下会解析卡死（实测 0.1.0-rc.2/rc.3 前两次尝试各 480s 超时），该标志
    // 只放宽 peer 冲突判定，不影响实际装出的包内容。后两次为常规兜底。
    const installAttempts = [
      ['--fetch-retries=5', `--registry=${MIRROR}`, '--legacy-peer-deps'],
      ['--fetch-retries=5', `--registry=${MIRROR}`],
      ['--fetch-retries=5'],
    ]
    for (const extra of installAttempts) {
      try {
        // 不加 --silent：npm 的报错详情（E404 缺包等）要进 stderr 供证据归档；
        // 输出经 pipe 捕获，不会打到终端。480s 超时足够镜像装完 ~150 包依赖树，
        // 超时即判定该源 stall 并切下一个源。
        runNpm(['install', `${DSH}@${row.version}`, '--no-audit', '--no-fund',
          ...extra, `--prefix=${envDir}`], { cwd: envDir, stdio: ['ignore', 'ignore', 'pipe'], timeout: 480000 })
        installErr = null
        break
      } catch (e) {
        installErr = e
        installErrText = errTail(e)
      }
    }
    if (installErr) {
      const transient = isTransient(installErrText) || isTransient(String(installErr.message || ''))
      row.functional = {
        ok: false,
        skipped: true,
        transient,
        reason: transient ? 'dsh-install-timeout' : 'dsh-install-failed',
        error: installErrText,
      }
      return row
    }
    const dshDir = join(envDir, 'node_modules', '@deepseek-ai', 'dsh')
    if (!existsSync(dshDir)) throw new Error('dsh 未安装到沙箱')
    if (!row.bin) throw new Error('该版本无 bin 入口')

    // ② 沙箱 DSH_HOME 里跑 plugin add。
    //    环境全隔离：USERPROFILE/HOME/APPDATA/LOCALAPPDATA 全部重定向进沙箱——
    //    老版本若忽略 DSH_HOME（home 解析机制可能不同）也不会污染真实 ~/.dsh；
    //    pnpm 的 store/缓存/用户 .npmrc 也落在沙箱内。沙箱 .npmrc 指向镜像源，
    //    防官方 CDN 间歇性 ECONNRESET 造成假失败（内容经 integrity 校验等价）。
    const home = join(sb, 'home')
    const sbUser = join(sb, 'userhome')
    mkdirSync(home)
    mkdirSync(sbUser)
    writeFileSync(join(sbUser, '.npmrc'), `registry=${MIRROR}\n`)
    const sandboxEnv = {
      ...process.env,
      DSH_HOME: home,
      USERPROFILE: sbUser,
      HOME: sbUser,
      APPDATA: join(sb, 'AppDataRoaming'),
      LOCALAPPDATA: join(sb, 'AppDataLocal'),
    }
    const binPath = resolve(dshDir, row.bin)
    let stderr = ''
    try {
      // pnpm 参数透传：plugin 命令把剩余参数原样转发给 pnpm（plugin-*.js 的
      // 官方文档语义 "every other pnpm argument passes through"），--registry
      // 指定镜像源，防官方 CDN 间歇性 ECONNRESET 造成假失败（实测沙箱
      // userhome/.npmrc 对 pnpm 用户配置不生效，仍走官方源，故必须显式传参）。
      execFileSync(process.execPath, [binPath, 'plugin', '--profile', 'web', 'add', `${PROBE_PKG}@${PROBE_VER}`, `--registry=${MIRROR}`], {
        cwd: sb,
        env: sandboxEnv,
        timeout: 300000,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    } catch (e) {
      stderr = (e.stderr && e.stderr.toString() || '').slice(-800)
      throw new Error('plugin add 失败: ' + stderr)
    }

    // ③ 验证安装结果
    const prof = join(home, 'profiles', 'web')
    const profPjPath = join(prof, 'package.json')
    checks.profileCreated = existsSync(profPjPath)
    if (!checks.profileCreated) throw new Error('profiles/web/package.json 未生成')
    const profPj = JSON.parse(readFileSync(profPjPath, 'utf8'))
    checks.depListed = !!(profPj.dependencies && profPj.dependencies[PROBE_PKG])
    checks.bundleListed = !!(profPj.dsh && profPj.dsh.profile && Array.isArray(profPj.dsh.profile.bundles)
      && profPj.dsh.profile.bundles.includes(PROBE_PKG))

    const nmPkgPath = join(prof, 'node_modules', PROBE_PKG, 'package.json')
    checks.packageInstalled = existsSync(nmPkgPath)
    if (checks.packageInstalled) {
      const nmPkg = JSON.parse(readFileSync(nmPkgPath, 'utf8'))
      checks.version = nmPkg.version
      checks.bundlePatchDeclared = !!(nmPkg.dsh && nmPkg.dsh.bundle && nmPkg.dsh.bundle.patch)
      const clientRel = nmPkg.exports && nmPkg.exports['./client']
      const clientPath = clientRel ? join(prof, 'node_modules', PROBE_PKG, clientRel) : null
      checks.clientExported = !!(clientPath && existsSync(clientPath))
      if (checks.clientExported) {
        const src = readFileSync(clientPath, 'utf8')
        const m = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]*?id:\s*["']([^"']+)["']/.exec(src)
        checks.clientRegId = m ? m[1] : null
        checks.clientIdMatchesPkg = m ? m[1] === PROBE_PKG : false
      }
    }

    const failed = Object.entries(checks).filter(([k, v]) => v === false)
    if (failed.length) throw new Error('检查未过: ' + failed.map(([k]) => k).join(', '))
    row.functional = { ok: true, checks }
  } catch (e) {
    row.functional = { ok: false, error: e.message.slice(0, 300), checks }
  } finally {
    rmSync(sb, { recursive: true, force: true })
  }
  return row
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
async function main() {
  const full = process.argv.includes('--full')
  const onlyIdx = process.argv.indexOf('--only')
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null
  const onlySet = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : null

  const versions = npmJson(['view', DSH, 'versions', '--json'], root).sort(cmpSemver)
  const times = npmJson(['view', DSH, 'time', '--json'], root)
  console.log(`compat: ${DSH} 已发布 ${versions.length} 个版本（${versions[0]} → ${versions[versions.length - 1]}）`)

  // 结果合并：读取既有 JSON，本次未覆盖的版本沿用旧行；纯静态刷新时把旧的
  // 功能回测结果带过来。这样 `--only a,b` 分批回测可以组合出完整矩阵，
  // 中途被杀也只丢当前版本。
  const resultPath = join(CACHE, 'dsh-compat-result.json')
  let prior = []
  try {
    prior = JSON.parse(readFileSync(resultPath, 'utf8'))
  } catch {
    prior = []
  }
  const priorByVersion = new Map(prior.map((r) => [r.version, r]))

  const rows = []
  const saveRows = () => {
    const merged = versions.map((v) => {
      const fresh = rows.find((r) => r.version === v)
      const old = priorByVersion.get(v)
      if (fresh && old && fresh.functional === undefined && old.functional !== undefined) {
        fresh.functional = old.functional // 纯静态刷新保留既有回测结论
      }
      return fresh || old
    }).filter(Boolean)
    writeFileSync(resultPath, JSON.stringify(merged, null, 2))
  }
  for (const v of versions) {
    if (onlySet && !onlySet.includes(v)) continue
    const manifest = npmJson(['view', `${DSH}@${v}`, '--json'], root)
    const row = staticProbe(v, manifest)
    row.published = times[v] ? String(times[v]).slice(0, 10) : '?'
    if (full && row.probes.pluginCmd) {
      process.stdout.write(`  回测 ${v} … `)
      functionalProbe(row)
      console.log(row.functional.ok
        ? 'PASS'
        : (row.functional.skipped
          ? `SKIP/${row.functional.transient ? '瞬时' : '不可安装'}（${row.functional.reason}: ${String(row.functional.error || '').slice(0, 100)}）`
          : 'FAIL — ' + String(row.functional.error || '').slice(0, 120)))
    }
    rows.push(row)
    saveRows()
  }

  // 矩阵基于合并后的全量行（分批回测也能看到完整矩阵）
  const finalRows = versions.map((v) => rows.find((r) => r.version === v) || priorByVersion.get(v)).filter(Boolean)

  // 矩阵输出
  console.log('\n## 兼容矩阵（静态探测' + (full ? ' + 沙箱安装回测' : '') + '）\n')
  console.log('| dsh 版本 | 发布 | plugin CLI | pnpm 转发 | bundle.patch | bundles 对账 | persona prefix/suffix | 注册名校验 | graph id=包名 | 沙箱安装 ' + PROBE_VER + ' |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of finalRows) {
    const p = r.probes
    const yn = (b) => (b === true ? '✓' : b === false ? '—' : '?')
    const personaCell = r.persona.error ? '✗' : (r.persona.prefixSchema ? '✓' : (r.persona.legacyText ? 'text:' : '?'))
    const cmCell = r.clientModules.error ? '✗' : yn(r.clientModules.regCheck)
    const gidCell = r.clientModules.error ? '✗' : yn(r.clientModules.locatePkgJson)
    const fnCell = r.functional
      ? (r.functional.ok ? '✅ PASS'
        : r.functional.skipped
          ? (r.functional.transient ? '⏱ 瞬时失败，待重跑' : '⏭ 依赖树缺失，今日不可安装')
          : '❌ ' + String(r.functional.error).slice(0, 40))
      : (full ? '(未回测)' : '')
    console.log(`| ${r.version} | ${r.published} | ${yn(p.pluginCmd)} | ${yn(p.pnpmFwd)} | ${yn(p.bundlePatchDecl)} | ${yn(p.bundlesList)} | ${personaCell} | ${cmCell} | ${gidCell} | ${fnCell} |`)
  }

  const pass = finalRows.filter((r) => r.functional && r.functional.ok).length
  const failed = finalRows.filter((r) => r.functional && !r.functional.ok && !r.functional.skipped).length
  const skip = finalRows.filter((r) => r.functional && r.functional.skipped && !r.functional.transient).length
  const pending = finalRows.filter((r) => r.functional && r.functional.skipped && r.functional.transient).length
  const untested = finalRows.length - pass - failed - skip - pending
  console.log(`\ncompat: 明细已写入 ${resultPath}（${finalRows.length} 行）`)
  console.log(`compat: 回测汇总 PASS ${pass} / 功能失败 ${failed} / 不可安装 ${skip} / 待重跑 ${pending} / 未回测 ${untested}`)
}

main().catch((e) => {
  console.error('compat: 运行失败 -', e.message)
  process.exit(1)
})
