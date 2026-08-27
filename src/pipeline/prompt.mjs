/**
 * The analysis prompt. Runs via `claude -p` with the repo as cwd, so the model
 * can read callers, conventions, and sibling implementations — context a bare
 * API call against the diff alone would not have.
 *
 * The prompt is assembled from named sections so a repo can bend any of them
 * without forking the whole thing. Two parts are deliberately not
 * configurable: the framing that tells the model where the patch is, and the
 * output schema. `merge.mjs` and both viewers are built against that schema,
 * so a repo that changed it would produce a review nothing could read.
 *
 * The taxonomies are the exception that proves the rule — severities and slice
 * kinds ARE configurable, and flow from config into the prompt, the schema,
 * and the viewer's glyphs together, so they can never drift apart.
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { DEFAULT_CONFIG, promptSection } from '../config/index.mjs'

/** `- \`bug\` — wrong behavior now…`, one per configured severity. */
const taxonomyList = (entries) =>
  Object.entries(entries ?? {})
    .map(([name, meta]) => `- \`${name}\` — ${meta?.description ?? ''}`.trimEnd())
    .join('\n')

const enumList = (entries) => Object.keys(entries ?? {}).join('|')

const conventionsSection = (conventionFiles) =>
  conventionFiles.length === 0
    ? ''
    : `## Project conventions

Read these before reviewing:

${conventionFiles.map((path) => `- \`${path}\``).join('\n')}

Follow referenced files and cite the relevant convention in any finding.
`

const slicingSection = (sliceKinds) => `## Slice the change

Group changed files by behavior, not directory. Put files that implement one
change in the same slice, and put every file in exactly one slice.

Order slices from core behavior to boundaries and UI. Order paths for reading,
with tests last. Use short behavior-based titles, never directory names.

Set \`kind\` to one of:

${taxonomyList(sliceKinds)}
`

const SUMMARIES = `## Step 2: Write summaries

Lead with behavior, then mechanism. Avoid code names until the behavior is
clear. For non-user-facing work, say what it unblocks or protects.

Word counts are ceilings. Going over is a failure; coming in well under is not.

- \`overview.intent\`: 25 words. Who does what, and what is different for them
  afterwards. If the diff carries several unrelated changes, name the theme —
  do not enumerate the slices, the reviewer is about to read them.
- \`overview.assessment\`: 20 words. The single most important thing to change,
  stated as an instruction. If there is nothing to change, name the riskiest
  part of the diff instead. Do not grade the change.
- \`overview.risk\`: \"low\", \"medium\", or \"high\".
- \`slices[].summary\`: 35 words. The behavior, then the mechanism delivering
  it. Never list the files.
- \`notes[]\`: 15 words. A clause naming what changed in the file — "adds the
  archived scope and its index", not "This file adds…". Omit \"skim\" slices.
`

const findingsSection = (severities) => `## Step 3: Report findings

Report only real problems. Available severities:

${taxonomyList(severities)}

Use \`confirmed\` only after checking the relevant code; otherwise use
\`suspected\`.

- \`title\`: 10 words. A statement, not a question, and never "consider…". "Nil
  author crashes the header", not "Should we handle nil here?"
- \`why\`: 25 words. The input or state, and the wrong result it produces.
- \`fix\`: the change, imperative. A code block beats describing code in prose;
  no code block at all beats restating the obvious.

Skip lint/style issues, healthy files, duplicate instances of one problem, and
missing-test findings when the diff includes a corresponding spec.
`

const ANCHORING = `### Anchoring findings to lines

Use new-file lines with \`side: "additions"\`; use old-file lines and
\`side: "deletions"\` only for removed code. Lines must be in the patch hunks.
Use \`line: null\` for file-wide or out-of-diff findings, and \`endLine: null\`
for a single line.
`

/** The one section nothing may override — both viewers are built against it. */
const outputSchema = ({ severities, sliceKinds }) => `## Output

Your final message must be a single JSON object and nothing else — no prose
before or after it, no code fence. It must match this shape exactly:

\`\`\`json
{
  "overview": { "intent": "...", "assessment": "...", "risk": "low|medium|high" },
  "slices": [
    { "id": "kebab-case-id", "title": "...", "kind": "${enumList(sliceKinds)}",
      "summary": "...", "paths": ["exact/path/from/files.json"] }
  ],
  "notes": [ { "path": "exact/path", "summary": "..." } ],
  "findings": [
    { "severity": "${enumList(severities)}",
      "confidence": "confirmed|suspected",
      "path": "exact/path", "line": 42, "endLine": null, "side": "additions",
      "title": "The defect, under ten words.",
      "why": "One sentence: the input or state, and the wrong result.",
      "fix": "The change, imperative. Markdown; a fenced code block beats prose about code." }
  ]
}
\`\`\`

Include NO diff text, patch text, or file contents in the JSON. The viewer
already has the diff and renders it alongside your analysis.`

/**
 * Substitute `{{placeholder}}` values into a repo-supplied prompt file.
 *
 * An unrecognised placeholder is left as written rather than blanked, so a
 * typo shows up in the prompt instead of quietly removing an instruction.
 */
function fillTemplate(template, values) {
  return template.replace(/\{\{([\w.]+)\}\}/g, (whole, key) => values[key] ?? whole)
}

export function analysisPrompt({
  patchPath,
  filesPath,
  target,
  repoRoot = process.cwd(),
  conventionFiles = [],
  config = DEFAULT_CONFIG,
}) {
  const review = config.review ?? DEFAULT_CONFIG.review
  const { severities, sliceKinds } = review

  const schema = outputSchema({ severities, sliceKinds })

  if (review.promptFile) {
    const path = isAbsolute(review.promptFile) ? review.promptFile : join(repoRoot, review.promptFile)
    return fillTemplate(readFileSync(path, 'utf8'), {
      patchPath,
      filesPath,
      conventionFiles: conventionFiles.map((file) => `- \`${file}\``).join('\n'),
      severities: taxonomyList(severities),
      sliceKinds: taxonomyList(sliceKinds),
      outputSchema: schema,
      'target.title': target.title,
      'target.author': target.author,
      'target.repo': target.repo,
      'target.number': target.number == null ? '' : String(target.number),
      'target.baseRef': target.baseRef,
      'target.headRef': target.headRef,
    })
  }

  const framing = `You are producing a structured code review of a pull request. Your output
is consumed by a viewer application, not read as prose.

## The change under review

- Title: ${target.title}
- Author: ${target.author}
- ${target.kind === 'pr' ? `PR #${target.number} in ${target.repo}` : `Local branch ${target.headRef}`}
- Base: ${target.baseRef}

The full unified diff is at \`${patchPath}\`. Read it.

The exact list of changed files, already parsed, is at \`${filesPath}\`. Every
path you emit MUST come from that list, character for character. Never invent,
abbreviate, or reconstruct a path.

You have the repo checked out at the current working directory. Read beyond the
diff whenever a judgment depends on it — callers of a changed method, the
sibling implementation a new file should have matched, the factory a spec
relies on. Use Grep to find callers before claiming a change breaks them.

Let the diff decide what you open. Every read should be answering a question
some line of this patch actually raised; a reviewer is waiting on this, so
reading the whole repo to feel thorough costs them minutes and tells them
nothing. In particular: do not go looking for the project's own settings — CI
config, engine and version constraints, lockfiles, the README — unless the diff
touches them. If a question needs more than two or three reads to settle,
report it as a \`question\` finding and move on rather than chasing it.

## Register

Every prose field is read by someone mid-review who wants the point. The
sentence budgets below are limits, not targets — come in under them.

- No preamble and no filler. Never open with "This change", "This PR", "This
  slice", "The author", or "It is worth noting".
- Do not hedge and do not soften. "Breaks on empty input" beats "may
  potentially cause issues with certain inputs". Uncertainty belongs in
  \`confidence\`, not in adverbs.
- No praise, no reassurance, no summing up. "Sound overall" tells the reviewer
  nothing they cannot get from the absence of findings.
- Cut every word that does not change what the reader understands. Sentence
  fragments are fine. Drop "in order to", "simply", "just", "essentially".
- Never restate what the diff already shows — the viewer renders it beside your
  text. Say what is not visible in the lines themselves.
`

  const sections = [
    framing,
    promptSection(review.conventions, conventionsSection(conventionFiles)),
    promptSection(review.slicing, slicingSection(sliceKinds)),
    promptSection(review.summaries, SUMMARIES),
    promptSection(review.findings, findingsSection(severities)),
    promptSection(review.anchoring, ANCHORING),
    schema,
    review.instructions?.trim() ? `\n## Also\n\n${review.instructions.trim()}` : '',
  ]

  return sections.filter((section) => section.trim()).join('\n')
}
