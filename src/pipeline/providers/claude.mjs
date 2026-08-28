/**
 * Claude Code, driven as a non-interactive analysis run.
 *
 * Everything Claude-specific about the analysis lives here: the binary name,
 * the flag vocabulary, and the shape of what it prints. `runAnalysis` in the
 * CLI knows none of it — it spawns whatever `command` says, hands the argv over
 * to `buildArgs`, and asks `extractReply` where the model's text is.
 */

/**
 * MCP tools are named `mcp__server__tool` and are not `--tools` entries, so the
 * list is split before it reaches the flags.
 */
const isMcp = (tool) => tool.startsWith('mcp__')

export const claude = {
  id: 'claude',
  name: 'Claude Code',
  command: 'claude',
  docsUrl: 'https://claude.com/claude-code',
  versionArgs: ['--version'],

  buildArgs({ prompt, review }) {
    const allowedTools = review.allowedTools ?? []
    const builtinTools = allowedTools.filter((tool) => !isMcp(tool))

    return [
      '-p',
      prompt,
      '--output-format',
      'json',
      ...(review.model ? ['--model', review.model] : []),
      ...(review.effort ? ['--effort', review.effort] : []),
      // An empty string is how --tools spells "nothing at all", so a config
      // that grants no tools is honoured rather than quietly granting every
      // one of them.
      '--tools',
      builtinTools.join(','),
      ...(allowedTools.length ? ['--allowed-tools', ...allowedTools] : []),
      ...(allowedTools.some(isMcp) ? [] : ['--strict-mcp-config']),
    ]
  },

  /**
   * `--output-format json` wraps the reply in an envelope whose `result` holds
   * the text. A run that dies before it can print one leaves something else on
   * stdout, so the raw stream is the fallback rather than an error — the
   * analysis may still be in there, and `extractJson` is built to find it.
   */
  extractReply(stdout) {
    let envelope = null
    try {
      envelope = JSON.parse(stdout)
    } catch {
      // Not the envelope; fall through to the raw stream.
    }
    return typeof envelope?.result === 'string' ? envelope.result : stdout
  },
}
