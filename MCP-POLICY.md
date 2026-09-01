# codebuddy-first policy (codebuddy-first-bridge MCP)

English | [中文](MCP-POLICY.zh.md) — canonical copy; also installed into
`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` on the authoring machine.

The local **`codebuddy`** agent CLI is available to this host through the MCP server
`codebuddy`, exposed as the tools **`codebuddy_run`**, **`codebuddy_continue`** and **`codebuddy_status`**
(here they appear server-qualified as `mcp__codebuddy__codebuddy_run` /
`mcp__codebuddy__codebuddy_continue` / `mcp__codebuddy__codebuddy_status`).
codebuddy runs **fully non-interactively under host control** — permissions are
auto-approved (`--permission-mode bypassPermissions`), it never prompts, and it can
edit files, run builds, and investigate multi-file code.

## Priority rule — disclose and prefer

- For **real work** — implementing features, editing/refactoring code,
  debugging, running builds, multi-file investigation — **prefer dispatching the
  task to `codebuddy_run` first**, with a complete, self-contained prompt.
- Use your own native read/write/shell tools mainly for **quick read-only
  lookups** and for the **final build/test verification** of what codebuddy produced.
- When the task must not write files yet, call `codebuddy_run` with `mode: "plan"`.
- For follow-ups on an existing task, use `codebuddy_continue` with the
  `sessionId` from the previous result (or `latest: true`).
- When you delegate to a sub-agent, tell it to also prefer `codebuddy_run`.
- While `codebuddy_run`/`codebuddy_continue` is running, you may call `codebuddy_status` any time
  to see what codebuddy is doing right now — reported per project (working
  directory), each with its current tool/step and recent trail — without
  waiting for it to finish.

## Fallback — never loop

When codebuddy is **rate-limited or the network is down**, the tool result text says
so explicitly. **Do NOT retry codebuddy in a loop.** Finish the task with your own
tools, or ask the user whether to fall back to the local model / API config.
Never ask codebuddy to call back into this host.
