# slice

A pull request is not a pile of files. It's a few behavioral changes that
happen to touch a lot of directories. `slice` reads it that way: the diff in
your terminal, AI analysis beside it, and the changed files **grouped by
behavioral slice** rather than by path.

```
slice 1679        # review PR #1679
slice my-branch   # that branch's PR, or diff the branch if it has none
slice             # the PR for the current branch, or the branch diff
slice --branch    # local branch vs its base, before a PR exists
```

The positional argument is a PR number or a branch name — `gh` resolves either,
so `slice ccc-642-implement-posts-on-portal` finds that branch's PR and falls
back to diffing the branch when there isn't one. A branch you have fetched but
never checked out works too.

<!-- demo: record an asciinema cast or GIF of a real sliced review and embed it here -->

## Slices

The core idea. A slice is the set of files that together deliver one behavioral
change — a migration, the model, the controller, the view, and the spec that
make "admins can archive a form" work are *one* slice, not five files in five
directories.

So instead of reviewing `app/models/`, then `app/controllers/`, then `spec/`,
and reassembling the feature in your head, you read one complete change at a
time, in the order that makes each one make sense.

## Install

```
npm install -g @gavinomelia/slice
```

Requires **Node 20+**, the [GitHub CLI](https://cli.github.com) (`gh`,
authenticated), and [Claude Code](https://claude.com/claude-code) (`claude`).
There is no API key to manage — the analysis runs through your existing Claude
Code session.

## How it works

The analysis is produced by Claude Code running **in your repo**, not by an API
call against the diff alone. That matters: it can read the callers of a changed
method, the sibling implementation a new file should have matched, and your own
conventions.

Convention sources are discovered per repo and named in the prompt:
`.github/instructions/*.md` (the Copilot convention — `claude` does *not* load
these on its own, unlike `AGENTS.md`) and `docs/CONVENTIONS.md`. Each run prints
what it judged against, and findings cite the convention by name.

```
gh pr diff ──▶ split per file (deterministic, in JS)
                     │
                     ├──▶ claude -p ──▶ analysis.json   (slices, summaries, findings)
                     │
                     └──▶ merge + validate ──▶ review.json ──▶ viewer
```

The split between those two paths is deliberate. **The model never reproduces
diff text** — it only refers to files by path and lines by number. Diff content
comes from `git`, so the code you review is always exactly what the PR contains.

Everything the model returns is validated against the patch in
`src/pipeline/merge.mjs`:

- A finding on a path that isn't in the diff is dropped.
- A finding on a line that isn't in the diff is **demoted to file level**, not
  discarded, so a real bug with a bad anchor still reaches you.
- Files the analysis forgot to slice get their own `Unsliced` bucket.

Corrections are printed after each run. A run with many of them is a signal the
analysis was sloppy, not something to ignore.

## Keys

`1` `2` `3` jump straight to a panel and `tab` cycles; the focused one is drawn
with a heavy accent border. `j` `k` then move within it — the tree's selection,
the diff's line cursor, or the findings pane's scroll.

| | |
|---|---|
| `1` `2` `3` `tab` | focus slices / diff / findings |
| `j` `k` `↑` `↓` | move within the focused panel |
| `space` `b` | page within the focused panel |
| `h` `l` `←` `→` | scroll the diff sideways · `0` back to the left |
| `z` | zoom the diff to the full terminal |
| `[` `]` | previous / next slice |
| `n` `p` | next / previous finding, anywhere in the review |
| `c` | comment on the diff's cursor line |
| `s` `A` `R` | submit as comment / approve / request changes |
| `q` | quit |

Code is never wrapped — a wrapped diff line is a lie about the code — so long
lines are truncated with a `›` at the edge and reached with `h` `l`. `z` hides
the side panels and gives the diff the whole terminal.

Selecting a slice shows its card — the walkthrough, its files, and every finding
it covers — instead of a diff. The last row of the tree is the draft review:
what is staged and what will happen to it on submit.

## Commenting and posting back to GitHub

`c` opens `$EDITOR`, seeded with any finding anchored to that line and with the
surrounding diff carried in as comment lines, the way `git commit --verbose`
does. Save to stage the draft, save it empty to discard. Drafts persist beside
the review in the cache, and drafted lines carry a bar in the gutter.

`s` `A` `R` post the whole batch as one PR review. `gh pr review` can't attach
line comments, so this goes through
`POST /repos/{owner}/{repo}/pulls/{n}/reviews` with all comments in one request.

Two constraints worth knowing:

- GitHub rejects a comment on any line not in the diff, and 422s the **whole
  batch** without saying which one. Drafts with no valid line anchor are
  appended to the review body instead.
- GitHub rejects `APPROVE` and `REQUEST_CHANGES` on your own PR. Both are
  downgraded to a plain comment rather than failing the post.

## Configuration

Two things are configurable, and they belong in different places.

```
slice --init-config        # .slice.jsonc in the repo — how it reviews
slice --init-config user   # ~/.config/slice/config.jsonc — how it looks
slice --print-config       # the resolved result, and which files produced it
```

Layers, weakest first: built-in defaults, your file, the repo's file. A repo
states how it wants to be reviewed; you state how you want it to look, and the
repo does not get to override your colour scheme unless it says so explicitly.
`--config <path>` replaces both discovered layers rather than stacking on them.

The format is JSON with comments and trailing commas allowed. Not JavaScript,
deliberately: reviewing a PR means having its branch checked out, and a config
format that executes would let a branch you are reviewing run code the moment
you open it.

### Reviewing

Every section of the prompt is overridable. A bare string appends to the
built-in instructions; `{ "replace": "..." }` swaps the section out.

```jsonc
{
  "review": {
    "slicing": "Treat anything under db/migrate as its own slice, always.",
    "findings": { "append": "A controller action with no Pundit policy check is a bug, not a risk." },
    "instructions": "Ignore anything under vendor/.",

    "severities": { "nit": null },        // stop reporting nits entirely
    "allowedTools": ["Read", "Grep", "Glob", "mcp__linear__get_issue"],
    "model": "opus"
  }
}
```

`severities` and `sliceKinds` define a taxonomy in one place, and it flows into
the prompt, the output schema, the validator, and the viewer's glyphs together
so they cannot drift apart. They deep-merge with the defaults: set one field to
recolour, set a key to `null` to remove it, add a key to invent one. Both are
ordered, and both fall back safely — an unrecognised severity becomes the least
serious one, an unrecognised slice kind becomes ordinary behavior.

The taxonomy is written into `review.json`, so re-opening a cached review draws
the severities it was actually produced under rather than whatever config says
today.

`promptFile` replaces the prompt entirely, with `{{patchPath}}`,
`{{outputSchema}}` and friends substituted in. The output schema itself is the
one thing that cannot be changed: `merge.mjs` and the viewer are both built
against its shape.

`allowedTools` is worth knowing about. It is read-only by default because the
analysis runs non-interactively, so a tool that triggers a permission prompt
hangs forever with nobody to answer it — which also means an instruction file
that asks the review to check a ticket is silently a no-op until you add the
MCP server here.

### Appearance

```jsonc
{
  "theme": {
    "preset": "dark",          // or "light", or just "theme": "light"
    "syntax": "tokyo-night",   // any Shiki theme, plus pierre-dark / pierre-light
    "ui": { "accent": "magenta", "borderFocus": "magenta" },
    "diff": { "addBg": "#0b2c18", "delBg": "#3a1114" }
  },
  "layout": { "treeWidth": 38, "findingsWidth": 58, "tabWidth": 4, "hScrollStep": 8 }
}
```

Colours are terminal palette names or hex. Palette names follow your terminal
theme, hex does not, and both downsample automatically where truecolour is
missing.

## Caching

Artifacts are cached in `~/.cache/slice/<repo>/`, outside the repo, so reviewing
never dirties your working tree. Re-run with `--refresh` to redo the analysis,
or `--no-analyze` to just browse the diff.

Re-open a cached review for free, without touching git, `gh`, or the model:

```
slice --open ~/.cache/slice/<repo>/pr-1692.review.json
```

## Layout

```
bin/slice.mjs           resolve target, capture patch, run analysis, open the viewer
src/pipeline/           the only code that talks to gh, git, or the model
  patch.mjs             split a unified diff into per-file patches
  prompt.mjs            the analysis prompt, assembled from overridable sections
  merge.mjs             validate model output against the patch
src/viewer/             the terminal UI (ink)
  app.mjs               layout, keys, state
  render.mjs            @pierre/diffs hast -> styled segments
  markdown.mjs          markdown -> styled, pre-wrapped line segments
  compose.mjs           $EDITOR composition and draft persistence
  github.mjs            posting a review back
  theme.mjs             config + manifest -> what the viewer draws with
src/config/             defaults, presets, and the JSONC loader
test/                   node:test, no dependencies
```

`review.json` is the contract between the pipeline and the viewer, which is why
`--open` works at all.

## Notes

- The viewer uses `@pierre/diffs` **headlessly**: `getSingularPatch` parses and
  `renderDiffWithHighlighter` returns hast with Shiki's colors inline, which
  `render.mjs` walks into styled segments. Only the web-component layer needs a
  DOM, and the viewer never touches it.
- Diff lines are kept as addressable segments rather than pre-rendered ANSI. A
  flat escape-laden string can be printed but not manipulated; keeping the
  pieces is what makes horizontal scrolling, full-width add/delete bands, and
  recolouring from config possible without re-parsing the diff.
- `react` is a real dependency here — Ink is React. There is no build step and
  no JSX; the layout is written with `createElement`.
- Hunk expansion beyond the context in the patch is not wired up; it needs
  `loadDiffFiles` to fetch full file contents.

## Development

```
npm install
npm test                       # node:test, ~100ms, no dependencies
node bin/slice.mjs --open <review.json>
```

## License

MIT
