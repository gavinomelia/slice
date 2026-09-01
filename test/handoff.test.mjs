/**
 * Handing findings over to be fixed. The two things worth guarding: a
 * deletion-side finding must never go out as a bare `path:line`, and a machine
 * with no clipboard program must still produce a handoff.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { copyToClipboard, fixPathFor, fixPrompt, handOff } from '../src/viewer/handoff.mjs'

const dir = mkdtempSync(join(tmpdir(), 'slice-handoff-'))
const reviewPath = join(dir, 'pr-7.review.json')
after(() => rmSync(dir, { recursive: true, force: true }))

const missing = { bin: 'slice-no-such-clipboard-program', args: [] }
/** Stands in for pbcopy, so the text lands somewhere readable. */
const spool = (file) => ({ bin: 'sh', args: ['-c', `cat > ${file}`] })

const finding = (over = {}) => ({
  id: 'f1',
  severity: 'bug',
  confidence: 'confirmed',
  path: 'app/models/form.rb',
  line: 42,
  endLine: null,
  side: 'additions',
  title: 'Archive skips the audit hook',
  why: '`update_column` bypasses callbacks.',
  fix: 'Use `update!`.',
  ...over,
})

const review = (over = {}) => ({
  target: {
    kind: 'pr',
    number: 7,
    repo: 'acme/app',
    title: 'Admins can archive forms',
    headRef: 'archive-forms',
    baseRef: 'main',
  },
  taxonomy: { severities: { bug: {}, risk: {}, cleanup: {}, nit: {} } },
  files: {},
  slices: [],
  findings: [],
  ...over,
})

test("the prompt leads with the worst findings, in the review's own taxonomy order", () => {
  const findings = [
    finding({ severity: 'nit', title: 'Stray blank line' }),
    finding({ severity: 'bug', title: 'Archive skips the audit hook' }),
    finding({ severity: 'risk', title: 'N+1 on the index' }),
  ]
  const prompt = fixPrompt({ review: review(), findings })

  assert.deepEqual(
    [...prompt.matchAll(/^## \d+\. (\w+) /gm)].map((m) => m[1]),
    ['bug', 'risk', 'nit'],
  )
  assert.match(prompt, /## 1\. bug · app\/models\/form\.rb:42\n/)
})

test('an unrecognised severity sorts last rather than dropping out of the handoff', () => {
  const findings = [finding({ severity: 'invented' }), finding({ severity: 'nit' })]
  const prompt = fixPrompt({ review: review(), findings })
  assert.match(prompt, /## 1\. nit /)
  assert.match(prompt, /## 2\. invented /)
})

test('a deletion-side finding is not handed over as path:line', () => {
  const prompt = fixPrompt({ review: review(), findings: [finding({ line: 88, side: 'deletions' })] })
  assert.doesNotMatch(prompt, /form\.rb:88/)
  assert.match(prompt, /app\/models\/form\.rb \(at line 88 of the version this change edits\)/)
})

test('a file-level finding names the file and no line at all', () => {
  const prompt = fixPrompt({ review: review(), findings: [finding({ line: null })] })
  assert.match(prompt, /## 1\. bug · app\/models\/form\.rb\n/)
})

test('a multi-line finding carries its whole range', () => {
  const prompt = fixPrompt({ review: review(), findings: [finding({ line: 42, endLine: 48 })] })
  assert.match(prompt, /app\/models\/form\.rb:42-48/)
})

test('a suspected finding is marked as one, and a confirmed finding is not', () => {
  const suspected = fixPrompt({ review: review(), findings: [finding({ confidence: 'suspected' })] })
  assert.match(suspected, /\(suspected\)/)
  assert.match(suspected, /Confirm it\s+first/, 'and the prompt says what to do about it')

  assert.doesNotMatch(fixPrompt({ review: review(), findings: [finding()] }), /\(suspected\)/)
})

test('a finding with no suggested fix omits the line rather than offering an empty one', () => {
  const prompt = fixPrompt({ review: review(), findings: [finding({ fix: '' })] })
  assert.match(prompt, /Why: `update_column` bypasses callbacks\./)
  assert.doesNotMatch(prompt, /Suggested fix:/)
})

test('the prompt says which ref the findings were made against', () => {
  const prompt = fixPrompt({ review: review(), findings: [finding()] })
  assert.match(prompt, /PR #7 in acme\/app/)
  assert.match(prompt, /made against `archive-forms`/)
})

test('uncommitted work is described as already on disk, because it is', () => {
  const target = {
    kind: 'worktree',
    number: null,
    title: 'Uncommitted changes',
    headRef: 'working tree',
    baseRef: 'main',
  }
  const prompt = fixPrompt({ review: review({ target }), findings: [finding()] })
  assert.match(prompt, /uncommitted work on main/)
  assert.match(prompt, /already in the working tree/)
  assert.doesNotMatch(prompt, /checked out/, 'there is no branch to check out — the code is right there')
})

test('the handoff goes to the first clipboard tool that is actually installed', () => {
  const file = join(dir, 'clipboard.txt')
  const result = handOff({
    review: review(),
    findings: [finding()],
    reviewPath,
    tools: [missing, spool(file)],
  })

  assert.deepEqual({ ok: result.ok, count: result.count, via: result.via }, { ok: true, count: 1, via: 'sh' })
  assert.match(readFileSync(file, 'utf8'), /Fix these code review findings\./)
  assert.equal(existsSync(fixPathFor(reviewPath)), false, 'a copy that worked leaves no file behind')
})

test('with no clipboard tool at all, the prompt is written beside the review', () => {
  const result = handOff({ review: review(), findings: [finding(), finding()], reviewPath, tools: [missing] })

  assert.equal(result.via, undefined)
  assert.equal(result.path, join(dir, 'pr-7.fix.md'))
  assert.equal(result.count, 2)
  assert.match(readFileSync(result.path, 'utf8'), /## 2\. bug/)
})

test('nothing to hand over is reported, not copied as an empty prompt', () => {
  const file = join(dir, 'unwritten.txt')
  const result = handOff({ review: review(), findings: [], reviewPath, tools: [spool(file)] })

  assert.deepEqual(result, { ok: false, count: 0 })
  assert.equal(existsSync(file), false)
})

test('copyToClipboard says nothing took the text rather than throwing', () => {
  assert.equal(copyToClipboard('hello', { tools: [missing] }), null)
})

test('the fix prompt lives beside the review, like drafts and read marks', () => {
  assert.equal(fixPathFor('/tmp/x/pr-9.review.json'), '/tmp/x/pr-9.fix.md')
})
