/**
 * The provider seam.
 *
 * Argv construction used to live inside the `spawn` call, where the only way to
 * check it was to run a review and watch what happened. Pulling it into a
 * descriptor makes the flags a value, and a value can be asserted on — which
 * matters most for the two cases that fail silently in the wrong direction: an
 * empty toolset that becomes "every tool", and MCP entries leaking into
 * `--tools`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_CONFIG } from '../src/config/index.mjs'
import { claude } from '../src/pipeline/providers/claude.mjs'
import { DEFAULT_PROVIDER_ID, PROVIDER_IDS, resolveProvider } from '../src/pipeline/providers/index.mjs'

/** The values following a flag, up to the next flag. */
const after = (argv, flag) => {
  const at = argv.indexOf(flag)
  if (at === -1) return null
  const rest = argv.slice(at + 1)
  const end = rest.findIndex((entry) => entry.startsWith('--'))
  return end === -1 ? rest : rest.slice(0, end)
}

const build = (review) => claude.buildArgs({ prompt: 'PROMPT', review: { ...DEFAULT_CONFIG.review, ...review } })

test('the default provider is one the registry actually has', () => {
  assert.ok(PROVIDER_IDS.includes(DEFAULT_PROVIDER_ID))
  assert.equal(resolveProvider(DEFAULT_PROVIDER_ID).id, DEFAULT_PROVIDER_ID)
  assert.equal(resolveProvider().id, DEFAULT_PROVIDER_ID)
})

test('the config default names a provider that resolves', () => {
  assert.equal(resolveProvider(DEFAULT_CONFIG.review.provider).id, DEFAULT_CONFIG.review.provider)
})

test('an unknown provider is refused, and the error says what there is', () => {
  assert.throws(() => resolveProvider('gpt'), /unknown review\.provider "gpt"/)
  assert.throws(() => resolveProvider('gpt'), new RegExp(PROVIDER_IDS.join(', ')))
})

test('a provider supplies everything the CLI spawns it with', () => {
  for (const id of PROVIDER_IDS) {
    const provider = resolveProvider(id)
    for (const key of ['id', 'name', 'command', 'docsUrl']) {
      assert.equal(typeof provider[key], 'string', `${id}.${key}`)
    }
    assert.ok(Array.isArray(provider.versionArgs), `${id}.versionArgs`)
    assert.equal(typeof provider.buildArgs, 'function', `${id}.buildArgs`)
    assert.equal(typeof provider.extractReply, 'function', `${id}.extractReply`)
  }
})

test('the prompt is passed as the argument to -p, not on stdin', () => {
  const argv = build({})
  assert.deepEqual(after(argv, '-p'), ['PROMPT'])
})

test('model and effort are only sent when the config has them', () => {
  assert.deepEqual(after(build({ model: 'opus' }), '--model'), ['opus'])
  assert.deepEqual(after(build({ effort: 'medium' }), '--effort'), ['medium'])

  const bare = build({ model: null, effort: null })
  assert.ok(!bare.includes('--model'))
  assert.ok(!bare.includes('--effort'))
})

test('granting no tools sends an empty --tools rather than omitting the flag', () => {
  // Omitting it is how you accidentally grant every tool, which is the whole
  // reason the flag is unconditional.
  const argv = build({ allowedTools: [] })
  assert.ok(argv.includes('--tools'))
  assert.deepEqual(argv[argv.indexOf('--tools') + 1], '')
  assert.ok(!argv.includes('--allowed-tools'))
})

test('built-in tools go to --tools and --allowed-tools alike', () => {
  const argv = build({ allowedTools: ['Read', 'Grep'] })
  assert.deepEqual(after(argv, '--tools'), ['Read,Grep'])
  assert.deepEqual(after(argv, '--allowed-tools'), ['Read', 'Grep'])
})

test('an MCP tool is kept out of --tools but still allowed, and unlocks MCP config', () => {
  const argv = build({ allowedTools: ['Read', 'mcp__linear__get_issue'] })

  assert.deepEqual(after(argv, '--tools'), ['Read'], 'mcp__ is not a --tools entry')
  assert.deepEqual(after(argv, '--allowed-tools'), ['Read', 'mcp__linear__get_issue'])
  assert.ok(!argv.includes('--strict-mcp-config'), 'a config asking for MCP is not then denied it')
})

test('without an MCP tool the MCP config is locked down', () => {
  assert.ok(build({ allowedTools: ['Read'] }).includes('--strict-mcp-config'))
})

test('the reply is dug out of the json envelope', () => {
  assert.equal(claude.extractReply(JSON.stringify({ result: '{"slices":[]}' })), '{"slices":[]}')
})

test('a run that never printed an envelope falls back to the raw stream', () => {
  // The analysis may still be in there, and extractJson is built to find it.
  assert.equal(claude.extractReply('noise {"slices":[]} more'), 'noise {"slices":[]} more')
  assert.equal(claude.extractReply(''), '')
  assert.equal(claude.extractReply(JSON.stringify({ result: { not: 'a string' } })), '{"result":{"not":"a string"}}')
})
