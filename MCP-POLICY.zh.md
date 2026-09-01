# codebuddy-first 策略（codebuddy-first-bridge MCP）

[English](MCP-POLICY.md) · 中文 —— 权威副本；同时安装到 `~/.claude/CLAUDE.md` 与 `~/.codex/AGENTS.md`。

本机 **`codebuddy`** 代理 CLI 通过 MCP 服务器 `codebuddy` 对当前宿主可用，工具为 **`codebuddy_run`**、**`codebuddy_continue`** 与 **`codebuddy_status`**（在本宿主中显示为服务器限定名 `mcp__codebuddy__codebuddy_run` / `mcp__codebuddy__codebuddy_continue` / `mcp__codebuddy__codebuddy_status`）。codebuddy **在宿主的完全控制下全自动运行** —— 权限自动批准（`--permission-mode bypassPermissions`）、从不弹提示，可改文件、跑构建、做跨文件排查。

## 优先规则 —— 披露并优先

- 对于**实际工作** —— 实现功能、编辑/重构代码、调试、跑构建、跨文件排查 —— **优先把任务交给 `codebuddy_run`**，给出完整、自包含的提示词。
- 自身原生读写/Shell 工具主要用于**快速只读查询**，以及对 codebuddy 产物的**最终构建/测试验证**。
- 任务尚不允许写文件时，用 `codebuddy_run` 且 `mode: "plan"`。
- 同一任务的后续跟进用 `codebuddy_continue`，带上一次结果的 `sessionId`（或 `latest: true`）。
- 委派给子代理时，同样指示其优先调用 `codebuddy_run`。
- `codebuddy_run`/`codebuddy_continue` 运行期间，可随时调用 `codebuddy_status` 查看 codebuddy 此刻在干什么（**按项目（工作目录）分节**，各含当前工具/步骤、最近轨迹），无需等待其结束。

## 回退 —— 禁止循环

当 codebuddy **被限流或网络不通**时，工具结果文本会明确说明。**不要循环重试 codebuddy**：用自身工具完成，或询问用户是否回退到本地模型 / API 配置。绝不让 codebuddy 回调当前宿主。
