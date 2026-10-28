import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { DEFAULT_CONFIG, promptSection } from '../config/index.mjs'

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

const WALKTHROUGH = `## Step 3: Walk through the change

The reviewer will not read every line. The walkthrough is how they understand
the change without doing so: what happens now, in the order it happens, and the
choices behind it. Summarising the diff is the point here, unlike elsewhere —
but describe, do not judge. Problems go in findings.

- \`walkthrough[]\`: 3–8 steps, in the order things happen — from what a user,
  caller, or job does, through each piece of code it reaches, to the result.
  Not file order and not slice order. For a change with no runtime flow (a
  refactor, docs, config), walk the structure instead: what was there, what
  replaced it, what now depends on it.
  - \`title\`: 8 words. The step as an event: "Reviewer marks a file read".
  - \`body\`: 45 words. What happens at this step and which code does it. Name
    functions here — this is where the reader maps behavior onto code.
  - \`paths\`: the files doing the work at this step.
- \`decisions[]\`: up to 5. Choices a reviewer would want to agree with: an
  approach taken where another was plausible, a trade-off accepted, a
  constraint worked around. Skip anything with only one sensible option.
  - \`title\`: 10 words. The choice, stated: "Read marks cached outside the
    repo".
  - \`why\`: 35 words. What it buys, what it costs, and the alternative it
    rules out. If nothing in the change says why, infer it and say so.
  - \`paths\`: where the choice is made.
`

const findingsSection = (severities) => `## Step 4: Report findings

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
  "walkthrough": [ { "title": "...", "body": "...", "paths": ["exact/path"] } ],
  "decisions": [ { "title": "...", "why": "...", "paths": ["exact/path"] } ],
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

const alsoSection = (instructions) => (instructions?.trim() ? `\n## Also\n\n${instructions.trim()}\n` : '')

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
    const template = readFileSync(path, 'utf8')
    const filled = fillTemplate(template, {
      patchPath,
      filesPath,
      conventionFiles: conventionFiles.map((file) => `- \`${file}\``).join('\n'),
      severities: taxonomyList(severities),
      sliceKinds: taxonomyList(sliceKinds),
      outputSchema: schema,
      instructions: review.instructions?.trim() ?? '',
      'target.title': target.title,
      'target.author': target.author,
      'target.repo': target.repo,
      'target.number': target.number == null ? '' : String(target.number),
      'target.baseRef': target.baseRef,
      'target.headRef': target.headRef,
    })
    // A replaced prompt still has to honour the instructions — `-p` lands
    // there, and a flag that silently does nothing is worse than no flag.
    // Where they go is the template's call if it names `{{instructions}}`;
    // otherwise they go last, as they do in the built-in prompt.
    return template.includes('{{instructions}}') ? filled : filled + alsoSection(review.instructions)
  }

  const provenance =
    target.kind === 'pr'
      ? `PR #${target.number} in ${target.repo}`
      : target.kind === 'worktree'
        ? `Uncommitted work in the working tree, on ${target.baseRef}`
        : `Local branch ${target.headRef}`

  // What the checkout on disk is, relative to the diff, differs by mode: for a
  // PR it is usually the base, but for uncommitted work it is the change
  // itself. A model that assumes the wrong one reports a change as not made
  // yet, or asks for a fix that is already sitting in front of it.
  const checkout =
    target.kind === 'worktree'
      ? `You have the repo checked out at the current working directory, and it already
contains this change — opening a changed file shows the new version, not the
committed one. It is unfinished by definition, so say what is missing rather
than what a reviewer should have caught.`
      : 'You have the repo checked out at the current working directory.'

  const framing = `You are producing a structured code review of ${target.kind === 'worktree' ? 'a change in progress' : 'a pull request'}. Your output
is consumed by a viewer application, not read as prose.

## The change under review

- Title: ${target.title}
- Author: ${target.author}
- ${provenance}
- Base: ${target.baseRef}

The full unified diff is at \`${patchPath}\`. Read it.

The exact list of changed files, already parsed, is at \`${filesPath}\`. Every
path you emit MUST come from that list, character for character. Never invent,
abbreviate, or reconstruct a path.

${checkout}

Read beyond the diff whenever a judgment depends on it — callers of a changed
method, the sibling implementation a new file should have matched, the factory
a spec relies on. Use Grep to find callers before claiming a change breaks them.

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
    promptSection(review.walkthrough, WALKTHROUGH),
    promptSection(review.findings, findingsSection(severities)),
    promptSection(review.anchoring, ANCHORING),
    schema,
    alsoSection(review.instructions),
  ]

  return sections.filter((section) => section.trim()).join('\n')
}
