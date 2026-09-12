# 开发纪律：开发-制品闭环（DEV DISCIPLINE）

> 制度化于 2026-09-12 —— 由姊妹仓 agy-first-bridge 的仓库迁移断链事故确立（见文末）。
> 本纪律适用于本机**所有 DSH 插件**的开发与部署。本文与 [RELEASE-SOP.md](RELEASE-SOP.md)
> 互补：SOP 管 **repo ↔ npm 侧**（版本锁、发布顺序、发布后审计），本文管
> **本机部署侧**（开发态接线的生命周期与制品化闭环）。

## 闭环流程（每版必走，缺一环不算完成）

```
开发 → 测试（npm run check）→ 提交仓库 → 发版（SOP §1：tag + push + publish + audit）
     → 卸载本地开发态接线
     → 从制品源安装（registry / 固定 tag）
     → 测试（含需要重启的运行时验证：状态灯 / 路由）
     → 对比一致性（已安装 ≡ 发布 tag）
     → 闭环备案（写入 HANDOVER / 交接文档并提交）
     → 等待下一次修订
```

## 七条纪律

1. **交付即制品**：版本发布并验证通过后，本机部署必须切换到**制品形态**（registry 安装，如 `^1.1.x`）。禁止让 `file:` 依赖 / junction 直连仓库工作副本的开发态接线跨会话存活。
2. **开发态是临时的**：开发态接线（`file:` + junction + `patchReload: live`）仅限活跃开发会话内使用；会话收尾时必须拆除，或在交接文档中显式标注「当前为开发态 + 接线位置」。
3. **路径解耦**：部署配置（`package.json` / `pnpm-lock.yaml` / `cordis.patch.yml`）中禁止出现指向**易变路径**（桌面、用户目录、可迁移的仓库位置）的引用。一律使用 registry 包名或长期稳定路径；确需本地引用（如 tgz），把 tgz 本身视为制品并放在稳定位置。
4. **完整性校验**：从制品源安装必须校验完整性——`npm pack` 下载后比对 tgz SHA512 与 `npm view <pkg>@<ver> dist.integrity`（SOP §4 的 audit 脚本管历史全版本，本条管当次安装）。
5. **一致性核验**：安装后对比「已安装文件 vs 发布 tag」：文件清单 + 内容哈希（行尾归一化后比对，避免 CRLF 假阳性——SOP §5 的历史坑同源）。任何差异必须逐项归因，不允许未解释的差异。
6. **交接文档反映真实形态**：交接 / 部署文档必须记录**当前真实部署形态**（制品态还是开发态）、各层版本、验证方法；「待重启验证」的变更要写明验证步骤（SOP §3 的本机回归即是其一）。
7. **闭环备案**：闭环执行记录（备份文件名、完整性校验值、对比结论、提交号）写入交接文档并提交进仓库。

## 本机部署形态速查（本仓三层）

| 层 | 载体 | 形态 |
| --- | --- | --- |
| 宿主 MCP 全局 | `dsh-home\cordis.patch.yml` 的 `mcp-codebuddy-global` 行 → `bin\codebuddy-mcp-server.mjs` | 稳定绝对路径 + 自包含拷贝（路径解耦 ✓） |
| Agent preset | `dsh-home\.agent-presets\codebuddy-first\codebuddy-core.mjs` 等 | 自包含拷贝（不依赖仓库位置 ✓；重大修复需手动同步） |
| Profile bundle | `dsh-home\profiles\web`（依赖 `^1.1.7` registry 安装） | **制品态**（✓） |

## 事故背景（为什么有这份纪律）

2026-09-12：姊妹仓 `agy-first-bridge` v1.6.2 发布验证通过后，本机 profile 层仍保留
`file:` 依赖 + junction 直连仓库工作副本的开发态接线。仓库目录迁移后 junction 悬空 →
**状态灯 bundle 静默失效**（宿主层与 preset 层因不依赖仓库位置而幸存，工具可用而灯不亮，
排查耗时远超开发本身）。当日闭环修复：拆死链 → registry 安装 → SHA512 校验 →
逐文件与 tag 核验 → lockfile 对齐 → 备案。

**教训：开发态接线是有保质期的债——发布之日就是还债之时。**
