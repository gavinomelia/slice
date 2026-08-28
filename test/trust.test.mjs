/**
 * The config trust boundary.
 *
 * A repo's .slice.jsonc arrives with the branch under review, so it is
 * attacker-controlled input in exactly the case this tool exists for. It may
 * say how the code should be reviewed; it may not say what the analysis is
 * allowed to do.
 *
 * These tests hit the real filesystem rather than a fake, because the boundary
 * is enforced by which file a setting came out of — mocking that away would
 * test the wrong thing.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

import { DEFAULT_CONFIG, loadConfig, PRIVILEGED_REVIEW_KEYS } from '../src/config/index.mjs'

const root = mkdtempSync(join(tmpdir(), 'slice-trust-'))
const repoDir = join(root, 'repo')
const userDir = join(root, 'xdg')
mkdirSync(repoDir, { recursive: true })

const priorXdg = process.env.XDG_CONFIG_HOME
const priorSliceConfig = process.env.SLICE_CONFIG
process.env.XDG_CONFIG_HOME = userDir
delete process.env.SLICE_CONFIG

after(() => {
  rmSync(root, { recursive: true, force: true })
  if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = priorXdg
  if (priorSliceConfig !== undefined) process.env.SLICE_CONFIG = priorSliceConfig
})

const writeRepo = (config) => writeFileSync(join(repoDir, '.slice.jsonc'), JSON.stringify(config))
const writeUser = (config) => {
  mkdirSync(join(userDir, 'slice'), { recursive: true })
  writeFileSync(join(userDir, 'slice', 'config.jsonc'), JSON.stringify(config))
}
const load = () => loadConfig({ cwd: repoDir })

beforeEach(() => {
  rmSync(join(repoDir, '.slice.jsonc'), { force: true })
  rmSync(join(userDir, 'slice'), { recursive: true, force: true })
})

test('a repo cannot grant the analysis tools it was not given', () => {
  writeRepo({ review: { allowedTools: ['Read', 'Bash', 'Write'] } })
  const { config, warnings } = load()

  assert.deepEqual(config.review.allowedTools, DEFAULT_CONFIG.review.allowedTools)
  assert.ok(!config.review.allowedTools.includes('Bash'))
  assert.match(warnings.join('\n'), /ignoring "review\.allowedTools"/)
})

test('a repo cannot choose which program the analysis runs in', () => {
  writeRepo({ review: { provider: 'something-else' } })
  const { config, warnings } = load()

  assert.equal(config.review.provider, DEFAULT_CONFIG.review.provider)
  assert.match(warnings.join('\n'), /ignoring "review\.provider"/)
})

test('a repo cannot point the prompt at a file of its choosing', () => {
  writeRepo({ review: { promptFile: '/etc/passwd' } })
  const { config, warnings } = load()

  assert.equal(config.review.promptFile, null)
  assert.match(warnings.join('\n'), /ignoring "review\.promptFile"/)
})

test('every privileged key is refused, and the warning says where to set it', () => {
  writeRepo({
    review: { provider: 'something-else', model: 'opus', effort: 'max', allowedTools: ['Bash'], promptFile: 'evil.md' },
  })
  const { config, warnings } = load()

  assert.deepEqual(
    { ...config.review, severities: null, sliceKinds: null },
    { ...DEFAULT_CONFIG.review, severities: null, sliceKinds: null },
    'no privileged key survived',
  )
  for (const key of PRIVILEGED_REVIEW_KEYS) {
    assert.match(warnings.join('\n'), new RegExp(`ignoring "review\\.${key}"`), `${key} warned about`)
  }
  assert.match(warnings.join('\n'), /config\.jsonc/, 'names the file that may set it')
})

test('a repo may still say how it wants to be reviewed', () => {
  writeRepo({
    review: {
      slicing: 'Migrations are their own slice.',
      instructions: 'Ignore vendor/.',
      severities: { nit: null },
    },
  })
  const { config } = load()

  assert.equal(config.review.slicing, 'Migrations are their own slice.')
  assert.equal(config.review.instructions, 'Ignore vendor/.')
  assert.ok(!('nit' in config.review.severities), 'a repo may still edit the taxonomy')
})

test('a repo may only name convention files inside itself', () => {
  writeRepo({
    review: { conventionFiles: ['docs/CONVENTIONS.md', '../../../etc/passwd', '/etc/hosts', 'a/../b.md'] },
  })
  const { config, warnings } = load()

  assert.deepEqual(config.review.conventionFiles, ['docs/CONVENTIONS.md', 'a/../b.md'])
  assert.match(warnings.join('\n'), /etc\/passwd/)
  assert.match(warnings.join('\n'), /etc\/hosts/)
})

test('a repo does not get to repaint a terminal whose owner has an opinion', () => {
  writeUser({ theme: { preset: 'dark' } })
  writeRepo({ theme: { preset: 'light' } })

  assert.equal(load().config.theme.preset, 'dark')
})

test('but it may suggest one to somebody who has none', () => {
  writeRepo({ theme: { preset: 'light' } })

  assert.equal(load().config.theme.preset, 'light')
})

test('layout follows the same rule as theme', () => {
  writeUser({ layout: { treeWidth: 50 } })
  writeRepo({ layout: { treeWidth: 20 } })

  assert.equal(load().config.layout.treeWidth, 50)
})

test('for how the code is reviewed, the repo wins over your own preference', () => {
  writeUser({ review: { slicing: 'my house rule' } })
  writeRepo({ review: { slicing: 'the project rule' } })

  assert.equal(load().config.review.slicing, 'the project rule')
})

test('your privileged settings survive a repo config that tried to change them', () => {
  writeUser({ review: { model: 'opus', allowedTools: ['Read', 'Grep'] } })
  writeRepo({ review: { model: 'haiku', allowedTools: ['Bash'] } })

  const { config } = load()
  assert.equal(config.review.model, 'opus')
  assert.deepEqual(config.review.allowedTools, ['Read', 'Grep'])
})

test('a file you named yourself is trusted in full', () => {
  const explicit = join(root, 'mine.jsonc')
  writeFileSync(explicit, JSON.stringify({ review: { allowedTools: ['Bash'], model: 'opus' } }))

  // --config replaces the discovered layers rather than stacking on them, and
  // you typed the path, so nothing in it is withheld.
  const { config, warnings } = loadConfig({ cwd: repoDir, explicit })
  assert.deepEqual(config.review.allowedTools, ['Bash'])
  assert.equal(config.review.model, 'opus')
  assert.deepEqual(warnings, [])
})

test('a repo config that sets nothing privileged produces no warnings', () => {
  writeRepo({ review: { slicing: 'fine' } })
  assert.deepEqual(load().warnings, [])
})
