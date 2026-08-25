/**
 * The analysis prompt. Runs via `claude -p` with the repo as cwd, so the model
 * can read callers, conventions, and sibling implementations — context a bare
 * API call against the diff alone would not have.
 */
export function analysisPrompt({ patchPath, filesPath, target, hasConventions }) {
  const conventions = hasConventions
    ? `
## Project conventions

This repo documents its own conventions in \`docs/CONVENTIONS.md\`, with an index
of files and the path globs each applies to. Before judging a file, read the
convention entries whose globs match it. Cite the convention by name in the
finding. A generic best practice asserted against a project that documents the
opposite is worse than saying nothing.
`
    : ''

  return `You are producing a structured code review of a pull request. Your output
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
${conventions}
## Step 1: Slice the change

Group the changed files into slices. A slice is the set of files that together
deliver **one behavioral change** — a migration, the model, the controller, the
view, and the spec that make "admins can archive a form" work are ONE slice,
not five.

Rules:
- Slice by behavior, never by directory. Do not produce slices named "Models",
  "Views", or "Specs".
- Order slices so understanding accumulates: data layer, then domain, then
  boundary, then UI, then anything standalone.
- Within a slice, order \`paths\` in the order a reviewer should read them —
  the thing that defines the behavior first, its tests last.
- Every file in the list belongs to exactly one slice. No file appears twice.
- Give each slice a short title naming the behavior ("Archive forms",
  "Country code prefix on phone display"), not a restatement of the file names.

Two special slice kinds:
- \`kind: "skim"\` — lockfiles, generated output, vendored assets, bulk
  translation dumps. One slice, reviewed as a lump.
- \`kind: "unaccounted"\` — files that fit no behavioral slice, or that the PR
  description does not explain. Scope creep and leftover debugging live here,
  so surface them rather than burying them in a related slice.

Everything else is \`kind: "behavior"\`.

## Step 2: Write summaries

- \`overview.intent\` — what this change sets out to do, in one or two
  sentences, based on the diff and the PR description.
- \`overview.assessment\` — your verdict, one short paragraph: is it sound, and
  what is the single most important thing to change.
- \`overview.risk\` — "low", "medium", or "high".
- \`slices[].summary\` — what this slice does and how its files fit together.
  Two or three sentences. Explain the mechanism, do not list the files.
- \`notes[]\` — one entry per file, \`summary\` being a single sentence on what
  changed in it and why. Skip files in a "skim" slice.

Never narrate the diff line by line. The viewer shows the diff next to your
text; restating it wastes the reader's attention.

## Step 3: Report findings

For each real problem, emit a finding. Severities, and the evidence each
requires:

- \`bug\` — wrong behavior now, on a reachable path. You can name the input
  that breaks it.
- \`risk\` — breaks callers, data, or performance under load. You have read the
  callers or considered the row count.
- \`cleanup\` — correct but poorly built: antipattern, duplication, logic at the
  wrong altitude, business logic in a template. You can point at the local
  pattern it should have followed.
- \`nit\` — taste. At most two or three in the entire review.
- \`question\` — you cannot resolve it without author intent, and you looked
  first.

Set \`confidence\` to "confirmed" when you verified the claim by reading the
relevant code, and "suspected" when you did not. Never state a suspicion as a
confirmed fact — a "suspected" finding that turns out wrong is a small cost, a
"confirmed" one that turns out wrong makes the whole review untrustworthy.

Discipline — these matter more than volume:
- Report nothing a linter, formatter, or type checker would catch. No style,
  spacing, import order, or unused-variable findings.
- A file with no problems gets no findings. Most files in most PRs are fine.
  Do not manufacture a finding so a file feels covered.
- The same mistake in five files is ONE finding about the pattern, on the
  clearest instance — not five findings.
- Do not report the absence of tests for a file that has a corresponding spec
  in the diff. Check first.

### Anchoring findings to lines

- \`line\` is a line number in the **new** version of the file, and \`side\` is
  "additions". This is what you want in almost every case.
- Use \`side: "deletions"\` with a line number from the **old** file only when
  the finding is about a line the PR removes.
- The line MUST appear in that file's hunks in the patch. Verify it against the
  hunk headers before emitting it.
- If a finding is about the file as a whole, or about something outside the
  diff, set \`line\` to null. It renders at the top of the file. This is always
  safe — prefer it over guessing a line number.
- \`endLine\` spans a range; set it to null for a single line.

## Output

Your final message must be a single JSON object and nothing else — no prose
before or after it, no code fence. It must match this shape exactly:

\`\`\`json
{
  "overview": { "intent": "...", "assessment": "...", "risk": "low|medium|high" },
  "slices": [
    { "id": "kebab-case-id", "title": "...", "kind": "behavior|skim|unaccounted",
      "summary": "...", "paths": ["exact/path/from/files.json"] }
  ],
  "notes": [ { "path": "exact/path", "summary": "..." } ],
  "findings": [
    { "severity": "bug|risk|cleanup|nit|question",
      "confidence": "confirmed|suspected",
      "path": "exact/path", "line": 42, "endLine": null, "side": "additions",
      "title": "One line naming what is wrong.",
      "why": "The concrete failure: the input or state, and the wrong result.",
      "fix": "The change to make. Markdown; use a fenced code block when code is shorter than prose." }
  ]
}
\`\`\`

Include NO diff text, patch text, or file contents in the JSON. The viewer
already has the diff and renders it alongside your analysis.`
}
