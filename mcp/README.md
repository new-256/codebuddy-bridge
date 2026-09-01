# codebuddy MCP server — discoverable by any MCP-capable agent

[中文说明见下](#中文说明)

This directory ships a **standalone, dependency-free MCP (Model Context Protocol) server** that exposes the local `codebuddy` CLI as three MCP tools:

| Tool | Purpose |
| --- | --- |
| `codebuddy_run` | Dispatch a task to the local codebuddy CLI and return its final answer. Optional `backend` selects the CLI: `codebuddy` (default, coding) or `workbuddy` (Tencent WorkBuddy — same engine, office scenarios: docs/slides, knowledge base, media generation, WeChat/WeCom replies). Optional `model` / `effort` / `maxTurns` select the model and cap agentic turns. |
| `codebuddy_continue` | Continue an existing conversation (`sessionId`, or `latest: true`). Routes back to the backend owning the sessionId automatically. |
| `codebuddy_status` | **Live observation + usage accounting**: what the CLI is doing RIGHT NOW, **sectioned per project (working directory)** — each project's running count, current step (tool name + arguments or thinking/typing), recent step trail, last completed run, and cumulative usage (`runs` + `totalTokens`, since no quota API exists). Optional `cwd` filters to one project. Call it mid-flight to watch progress. |

**Why:** the DSH plugin (preset / dynamic form) only exists inside DSH sessions. With the MCP server, *any* MCP-capable host — Claude Code, Codex, Cherry Studio, Cline, etc. — **discovers the tools itself** (`tools/list`) and decides when to call them, even when no "codebuddy-first" preset is loaded. The agent stays in control of *whether* to delegate to codebuddy; the server guarantees *how* codebuddy runs.

## Live observation

codebuddy runs with `--output-format stream-json`; each assistant/user event
(`tool_use`, `tool_result`, `thinking`, `text`) is parsed on arrival and folded
into an in-memory snapshot **grouped by project (cwd)**.
Any agent can call `codebuddy_status` while `codebuddy_run`/`codebuddy_continue` is still in
flight — parallel runs in different projects appear as separate sections:

```
codebuddy status: running (2 running) across 2 projects
· DSH [running ×1] (starting / thinking)
· codebuddy-bridge [running ×1] (starting / thinking)
```

After the runs, each project keeps its own trail and last result:

```
codebuddy status: ok across 2 projects
· codebuddy-bridge [ok] | last=SUCCESS 3bd8f424
    steps:
      [DONE] step 6 PowerShell {"command":"Get-ChildItem -Force"}
      [DONE] step 8 Write {"file_path":"…\\implementation_plan.md"}
· DSH [ok] | last=SUCCESS 81ebb6ee
    steps:
      [DONE] step 4 PowerShell {"command":"Get-ChildItem -File | Measure-Object …"}
```

Pass `cwd` to `codebuddy_status` to see only one project. No polling loops needed —
the snapshot is owned by the server process and exposed on demand.

## Guarantees (same as the DSH plugin)

- **Full host control:** every invocation is non-interactive — `-p --output-format stream-json --permission-mode bypassPermissions`. codebuddy never prompts; edits are applied without asking (mode `plan` runs read-only instead). `codebuddy` does not even need to be on PATH: the server resolves `node + CODEBUDDY_BIN` → `node + npm global bin` → bare `codebuddy`.
- **Timeout guard:** codebuddy has no `--print-timeout`; a server-side kill timer at `timeoutSec + 60` guards hangs (foreground and background alike); results are parsed from codebuddy's stream-json output (tolerant to extra log lines, and to lines split across stdout chunks).
- **Rate-limit detection:** the tool result text is annotated when the failure matches the rate-limit/network regex (**stderr + status only** — the agent's answer text never triggers a false "rate-limited" verdict), telling the agent **not to retry in a loop** and finish with its own tools (MCP has no UI dialog, so the fallback decision is left to the calling agent / user).
- **Session-aware cwd:** codebuddy archives conversations per project directory; `codebuddy_continue` without an explicit `cwd` falls back to the resumed session's project directory.
- **Usage accounting:** each project accumulates `runs` (completed calls) and `totalTokens` (input+output). codebuddy has no plan/quota API, so token metering is the available substitute.
- **No dependencies:** one `.mjs` file + a shared core, Node ≥ 18. No `npm install`.

## Security — read this before exposing the server

This server launches codebuddy with **`--permission-mode bypassPermissions`**: any
caller can make it edit files and run commands **in whatever working directory the
call passes** (or the session-derived default). For single-user local setups that
is the intended convenience; for anything wider, restrict it:

- **`CODEBUDDY_MCP_ALLOWED_ROOTS`** — `;`- or `,`-separated list of absolute
  directories. When set, every call's `cwd` (including the session-derived
  default) **must** be inside one of them, otherwise the call is rejected with
  `CWD_BLOCKED`. Unset = allow all (backwards compatible).

```json
{
  "mcpServers": {
    "codebuddy": {
      "command": "node",
      "args": ["<repo>/mcp/codebuddy-mcp-server.mjs"],
      "env": {
        "CODEBUDDY_MCP_ALLOWED_ROOTS": "C:\\work\\projA;C:\\work\\projB"
      }
    }
  }
}
```

## Register the server

Server command: `node <repo>/mcp/codebuddy-mcp-server.mjs` (stdio transport).

### Claude Code

```bash
claude mcp add codebuddy -- node "<repo>/mcp/codebuddy-mcp-server.mjs"
# project scope default; add -s user to make it available in every project
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.codebuddy]
command = "node"
args = ["<repo>/mcp/codebuddy-mcp-server.mjs"]
```

### Generic MCP client (JSON)

```json
{
  "mcpServers": {
    "codebuddy": {
      "command": "node",
      "args": ["<repo>/mcp/codebuddy-mcp-server.mjs"]
    }
  }
}
```

### Environment

- `CODEBUDDY_MCP_CWD` — default working directory for codebuddy calls that do not pass `cwd` ((default: the repository workspace — set this explicitly in multi-project setups)).
- `CODEBUDDY_BIN` — explicit path to the codebuddy bin script (defaults to `%APPDATA%\npm\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy`).

### Disclose-and-prefer policy for external agents

Install [`MCP-POLICY.md`](../MCP-POLICY.md) (bilingual) into the global instruction
file of each MCP host so the agent **prefers** `mcp__codebuddy__*` for real work and never
loops on rate-limit failures:

```bash
copy MCP-POLICY.md %USERPROFILE%\.claude\CLAUDE.md   # Claude Code (global memory)
copy MCP-POLICY.md %USERPROFILE%\.codex\AGENTS.md    # Codex
```

On this development machine both files are already installed.

### DSH itself

Inside DSH the same bridge is registered natively in the `codebuddy-first` preset with one plugin row (`preset/codebuddy-first/codebuddy-first-bridge.mjs`), so the model sees the tools directly (`codebuddy_run` / `codebuddy_continue` / `codebuddy_status`) without any MCP hop. Alternatively, the MCP server itself can be registered through `@deepseek-ai/dsh-mcp-client`:

```yaml
- id: mcp-codebuddy
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: codebuddy
    transport: stdio
    command: node
    args: ['<stable copy>\codebuddy-mcp-server.mjs']
    toolCallTimeoutMs: 600000
    failOnStartupError: false
```

`failOnStartupError: false` keeps a missing `codebuddy` CLI from blocking session start; `toolCallTimeoutMs` covers long codebuddy runs.

## Self-test

```bash
node mcp/codebuddy-mcp-server.mjs --check   # prints tool schema summary, exits 0
```

A full end-to-end probe (initialize → tools/list → a real `codebuddy_run` executing a PowerShell command → `codebuddy_status` mid-flight snapshot → `codebuddy_continue` resuming the returned `sessionId`) was executed during development: codebuddy answered `status=SUCCESS` in ~11s (50k tokens), the trail showed the `PowerShell` tool step folding ACTIVE → DONE, and the resume completed in ~5s.

---

# 中文说明

本目录提供一个**独立的、零依赖的 MCP (Model Context Protocol) 服务器**，把本机 `codebuddy` CLI 暴露为三个 MCP 工具：

| 工具 | 用途 |
| --- | --- |
| `codebuddy_run` | 把编码/构建/调试/排查任务派发给本机 codebuddy CLI，返回最终答复 |
| `codebuddy_continue` | 继续已有的 codebuddy 会话（`sessionId` 或 `latest: true`） |
| `codebuddy_status` | **实时观察**：codebuddy 此刻在干什么，**按项目（工作目录）分节** —— 每个项目的运行计数、当前步骤（工具名+参数或思考/打字中）、最近步骤轨迹、最近完成运行。可选 `cwd` 只看某个项目。运行中随时可查，无需等待结束 |

**用途：** DSH 插件（preset / 动态形态）只在 DSH 会话内存在。有了 MCP 服务器，任何支持 MCP 的宿主（Claude Code、Codex、Cherry Studio、Cline 等）都能通过 `tools/list` **自行发现**这些工具，并**自主决定**何时调用——即使当前没有加载任何 "codebuddy-first" preset。是否委派给 codebuddy 由调用方代理决定；服务器只保证 codebuddy 的运行方式。

## 实时观察

codebuddy 以 `--output-format stream-json` 运行；每个 assistant/user 事件（`tool_use`、`tool_result`、`thinking`、`text`）到达即被解析并入内存快照，**按项目（cwd）分组**。`codebuddy_run`/`codebuddy_continue` 仍在进行时，任何代理都能调用 `codebuddy_status` —— 不同项目中的并行运行显示为独立分节：

```
codebuddy status: running (2 running) across 2 projects
· DSH [running ×1] (starting / thinking)
· codebuddy-bridge [running ×1] (starting / thinking)
```

运行结束后，每个项目保留各自的轨迹与最近结果：

```
codebuddy status: ok across 2 projects
· codebuddy-bridge [ok] | last=SUCCESS 3bd8f424
    steps:
      [DONE] step 6 PowerShell {"command":"Get-ChildItem -Force"}
      [DONE] step 8 Write {"file_path":"…\\implementation_plan.md"}
· DSH [ok] | last=SUCCESS 81ebb6ee
    steps:
      [DONE] step 4 PowerShell {"command":"Get-ChildItem -File | Measure-Object …"}
```

给 `codebuddy_status` 传 `cwd` 可只看某个项目。无需轮询——快照归服务器进程所有，按需返回。

## 保证（与 DSH 插件一致）

- **宿主完全控制：** 所有调用均非交互——`-p --output-format stream-json --permission-mode bypassPermissions`。codebuddy 绝不弹提示，直接改文件（`mode=plan` 时只读）。**codebuddy 无需在 PATH 里**：服务器依次解析 `node + CODEBUDDY_BIN` → `node + npm 全局 bin` → 裸 `codebuddy`。
- **超时守卫：** codebuddy 无 `--print-timeout`；服务器在 `timeoutSec + 60` 后强杀挂起进程；stream-json 输出解析容忍日志行干扰。
- **限流检测：** 失败命中限流/网络正则时，在工具结果文本中附加提示，要求调用方**不要循环重试**、改用自身工具完成（MCP 无 UI 弹窗，回退决策交给调用方代理/用户）。
- **零依赖：** 单个 `.mjs` 文件，Node ≥ 18，无需 `npm install`。

## 注册服务器

服务器命令：`node <repo>/mcp/codebuddy-mcp-server.mjs`（stdio 传输）。

### Claude Code

```bash
claude mcp add codebuddy -- node "<repo>/mcp/codebuddy-mcp-server.mjs"
# 默认项目级；加 -s user 对所有项目生效
```

### Codex（`~/.codex/config.toml`）

```toml
[mcp_servers.codebuddy]
command = "node"
args = ["<repo>/mcp/codebuddy-mcp-server.mjs"]
```

### 通用 MCP 客户端（JSON）

```json
{
  "mcpServers": {
    "codebuddy": {
      "command": "node",
      "args": ["<repo>/mcp/codebuddy-mcp-server.mjs"]
    }
  }
}
```

### 环境变量

- `CODEBUDDY_MCP_CWD` — 未传 `cwd` 时 codebuddy 的默认工作目录（默认为服务器内置的工作区路径；多项目环境请显式设置）。
- `CODEBUDDY_BIN` — 显式指定 codebuddy bin 脚本路径（默认 `%APPDATA%\npm\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy`）。
- `WORKBUDDY_BIN` — 显式指定 **WorkBuddy** CLI 路径（`backend="workbuddy"` 用；默认 `C:\Program Files\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy`，随 WorkBuddy 桌面版安装）。未安装 WorkBuddy 时该后端返回带安装指引的 `CODEBUDDY_UNAVAILABLE`。
- `CODEBUDDY_MCP_ALLOWED_ROOTS` — **安全护栏**：`;`/`,` 分隔的允许工作目录列表。设置后，每次调用的 `cwd`（含会话回落得到的默认值）都必须位于其中之一，否则返回 `CWD_BLOCKED`；未设置则放行（向后兼容）。本服务器以 bypassPermissions 运行 CLI，向其他用户提供时务必设置。

## 自检

```bash
node mcp/codebuddy-mcp-server.mjs --check   # 打印工具 schema 摘要，退出码 0
```
