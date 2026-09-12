#!/usr/bin/env node
// scripts/audit-npm-sync.mjs — npm ↔ git 双侧版本一致性审计（v1.1.10 引入）
//
// 背景：v1.1.8 热修曾出现「npm 已发、git 未提交」的窗口期——npm tarball 与
// git tag 树存在漂移风险。本脚本把「npm 上每个已发布版本 == git tag v<ver>
// 的树（按 files 白名单裁剪后的内容）」做成逐文件 sha256 比对：
//
//   1. 每个 npm 版本必须有对应的 git tag v<version>；
//   2. tarball 内每个文件（package/ 前缀剥离后）必须存在于 tag 树且哈希一致；
//   3. tarball 内 package.json 的 version/name 必须与发布规格一致。
//
// 任何缺失/漂移 → exit 1（接入 CI，发布后忘推 tag 或改文件未重发即红）。
//
// 用法：node scripts/audit-npm-sync.mjs
// 传输：全部经 npm CLI（npm view / npm pack）——自动重试 + tarball shasum
// 校验 + 尊重 .npmrc registry/代理配置；不直接用 fetch（registry CDN 直连
// 易被截断，见 v1.1.10 开发记录）。
// 依赖：git、系统 tar（Windows bsdtar / Linux tar 均可）、npm、网络。

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const NAME = pkg.name

// 轻量 semver 比较（本包均为三段式，无需完整实现）
function cmpVer(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

function git(args, opts = {}) {
  // maxBuffer 提高到 64MB：git archive 输出整棵 tag 树（含未进 npm 白名单的
  // test/、.github/ 等），需留足余量。
  return execFileSync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, ...opts })
}

// Windows 上 npm 是 .cmd shim，Node ≥18.20 出于安全不允许直接 spawn；
// 统一解析到随 Node 附带的 npm-cli.js 用 node 执行（CI 的 setup-node 布局相同）。
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

/**
 * npm pack <spec> 到独立目录并解包，返回 package/ 根路径。
 * 网络策略：官方 registry 优先（npm 自带 --fetch-retries 重试），失败后以
 * npmmirror 镜像兜底；无论从哪个源下载，都用【官方元数据】的 dist.shasum
 * 做本地 SHA-1 校验，确保镜像内容与官方发布逐字节一致。
 */
function packExtract(spec, work, shasum) {
  const dest = join(work, 'dl')
  const attempts = [
    ['--fetch-retries=5'],
    ['--fetch-retries=5', '--fetch-retry-mintimeout=5000', '--registry=https://registry.npmmirror.com'],
  ]
  let lastErr = null
  for (const extra of attempts) {
    try {
      rmSync(dest, { recursive: true, force: true })
      mkdirSync(dest, { recursive: true })
      runNpm(['pack', spec, '--silent', ...extra, '--pack-destination', dest], {
        cwd: dest, stdio: ['ignore', 'ignore', 'pipe'],
      })
      const tgz = readdirSync(dest).find((f) => f.endsWith('.tgz'))
      if (!tgz) throw new Error(`npm pack ${spec} 未产出 tgz`)
      if (shasum) {
        const actual = createHash('sha1').update(readFileSync(join(dest, tgz))).digest('hex')
        if (actual !== shasum) {
          throw new Error(`shasum 校验失败: 期望 ${shasum} 实际 ${actual}（${extra.includes('--registry') ? '镜像源' : '官方源'}）`)
        }
      }
      const out = join(work, 'x')
      rmSync(out, { recursive: true, force: true })
      mkdirSync(out)
      execFileSync('tar', ['-xf', join(dest, tgz), '-C', out])
      const pkgRoot = join(out, 'package')
      if (!existsSync(pkgRoot)) throw new Error(`tarball ${spec} 无 package/ 根`)
      return pkgRoot
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

function walk(dir, base = dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, base))
    else if (e.isFile()) out.push(relative(base, p).replaceAll('\\', '/'))
  }
  return out.sort()
}

function sha256(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

async function main() {
  // --prefer-online：刚发布的版本若命中 npm 本地缓存会看不到（实测发布后立即审计
  // 仍显示旧版本列表），CI 里同样是新 tag 刚推、需要最新元数据。
  const versions = npmJson(['view', NAME, 'versions', '--json', '--prefer-online'], root)
  if (!Array.isArray(versions) || versions.length === 0) throw new Error('npm view 未返回版本列表')

  console.log(`audit: ${NAME} npm 已发布 ${versions.length} 个版本`)
  let fail = 0
  for (const v of versions.sort(cmpVer)) {
    const tag = `v${v}`
    const diffs = []
    const eolOnly = []
    let files = 0

    // ① git tag 必须存在
    let haveTag = true
    try {
      git(['rev-parse', '--verify', '-q', `refs/tags/${tag}^{commit}`])
    } catch {
      haveTag = false
    }
    if (!haveTag) {
      console.log(`  ${tag.padEnd(8)} ✗ MISSING-TAG   npm 有 ${v} 但 git 无 ${tag}`)
      fail++
      continue
    }

    // ② tarball 与 tag 树逐文件 sha256 比对
    const work = mkdtempSync(join(tmpdir(), 'audit-'))
    try {
      // 官方元数据取 dist.shasum（小请求，稳定），用于本地校验下载内容
      let shasum = null
      try {
        const dist = npmJson(['view', `${NAME}@${v}`, 'dist', '--json', '--registry=https://registry.npmjs.org'], root)
        shasum = dist && dist.shasum ? dist.shasum : null
      } catch { /* 元数据失败则跳过 shasum 校验，仅比对内容 */ }
      const npmRoot = packExtract(`${NAME}@${v}`, work, shasum)

      const gitDir = join(work, 'git')
      mkdirSync(gitDir)
      const tarPath = join(work, 'tag.tar')
      // core.autocrlf=false：取原始提交字节（LF）。本机 autocrlf=true 时
      // git archive 会做 CRLF 转换，而 npm tarball 打包自 LF 工作区，
      // 不关闭会导致全文件假阳性「内容不同」。
      writeFileSync(tarPath, git(['-c', 'core.autocrlf=false', 'archive', '--format=tar', tag]))
      execFileSync('tar', ['-xf', tarPath, '-C', gitDir])

      files = walk(npmRoot).length
      for (const f of walk(npmRoot)) {
        const inGit = join(gitDir, f)
        if (!existsSync(inGit)) {
          diffs.push(`仅 npm 有: ${f}`)
          continue
        }
        const a = readFileSync(join(npmRoot, f))
        const b = readFileSync(inGit)
        if (!a.equals(b)) {
          // 字节不同但换行归一后相同 → 仅行尾差异（历史工作区 CRLF 产物，
          // npm tarball 打包自工作区而 blob 为 LF）。内容一致，判 EOL-ONLY
          // 通过，但显著标注，防止真差异借道蒙混。
          const na = a.toString('utf8').replaceAll('\r\n', '\n')
          const nb = b.toString('utf8').replaceAll('\r\n', '\n')
          if (na === nb) eolOnly.push(f)
          else diffs.push(`内容不同: ${f}`)
        }
      }

      // ③ tarball 内规格自检
      const pj = JSON.parse(readFileSync(join(npmRoot, 'package.json'), 'utf8'))
      if (pj.version !== v) diffs.push(`tarball package.json version=${pj.version} ≠ ${v}`)
      if (pj.name !== NAME) diffs.push(`tarball package.json name=${pj.name} ≠ ${NAME}`)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }

    if (diffs.length) {
      console.log(`  ${tag.padEnd(8)} ✗ DRIFT (${files} files)`)
      for (const d of diffs) console.log(`      - ${d}`)
      fail++
    } else if (eolOnly.length) {
      console.log(`  ${tag.padEnd(8)} ⚠ EOL-ONLY (${files} files; 仅行尾差异: ${eolOnly.join(', ')})`)
    } else {
      console.log(`  ${tag.padEnd(8)} ✓ IDENTICAL (${files} files)`)
    }
  }

  if (fail === 0) {
    console.log(`audit: 全部 ${versions.length} 个版本 npm ↔ git 一致`)
  } else {
    console.log(`audit: ${fail}/${versions.length} 个版本漂移或缺失`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('audit: 运行失败 -', e.message)
  process.exit(1)
})
