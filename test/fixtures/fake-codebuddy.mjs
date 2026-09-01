// test/fixtures/fake-codebuddy.mjs — 伪 codebuddy CLI（MCP e2e 夹具）。
// 模拟 stream-json 输出：init → assistant tool_use → user tool_result → result。
// result 文本带 process.cwd()，供断言「会话感知 cwd 回落」与白名单护栏。
// 退出码可通过环境变量 FAKE_CB_EXIT 控制（默认 0）。
const lines = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-s1' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'x.ts' } }] } }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } }),
  JSON.stringify({
    type: 'result',
    subtype: process.env.FAKE_CB_SUBTYPE || 'success',
    is_error: process.env.FAKE_CB_SUBTYPE ? true : false,
    result: 'cwd=' + process.cwd(),
    session_id: 'fake-s1',
    duration_ms: 1234,
    num_turns: 2,
    usage: { input_tokens: 10, output_tokens: 5 }
  })
]
process.stdout.write(lines.join('\n') + '\n')
if (process.env.FAKE_CB_STDERR) process.stderr.write(process.env.FAKE_CB_STDERR + '\n')
process.exit(Number(process.env.FAKE_CB_EXIT || 0))
