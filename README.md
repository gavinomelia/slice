# pr-review

A local review surface for GitHub pull requests: the diff on one side, AI
analysis on the other, and the changed files **grouped by behavioral slice**
rather than by directory.

```
pr-review 1679        # review PR #1679
pr-review             # the PR for the current branch, or the branch diff
pr-review --branch    # local branch vs its base, before a PR exists
```

## How it works

The analysis is produced by Claude Code running **in your repo**, not by an API
call against the diff alone. That matters: it can read the callers of a changed
method, the sibling implementation a new file should have matched, and your
own conventions. There is no API key to manage.

Convention sources are discovered per repo and named in the prompt:
`.github/instructions/*.md` (the Copilot convention — `claude` does *not* load
these on its own, unlike `AGENTS.md`) and `docs/CONVENTIONS.md`. Each run
prints what it judged against, and findings cite the convention by name.

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

Everything the model returns is then validated against the patch in
`packages/core/lib/merge.mjs`:

- A finding on a path that isn't in the diff is dropped.
- A finding on a line that isn't in the diff is **demoted to file level**, not
  discarded, so a real bug with a bad anchor still reaches you.
- Files the analysis forgot to slice get their own `Unsliced` bucket.

Corrections are printed after each run. A run with many of them is a signal the
analysis was sloppy, not something to ignore.

## Slices

The core idea. A slice is the set of files that together deliver one behavioral
change — a migration, the model, the controller, the view, and the spec that
make "admins can archive a form" work are *one* slice, not five files in five
directories.

`@pierre/trees` builds its hierarchy from a flat path list, so each file is
prefixed with its slice (`1 · Archive forms/app/models/form.rb`) and slices
render as the top-level folders, in review order rather than alphabetically.

## Two viewers

The terminal viewer is the default. `--web` opens the browser one.

They share the analysis pipeline and the `review.json` it produces, and nothing
else — the terminal viewer renders diffs as ANSI, the browser one as DOM.

| | terminal | browser |
|---|---|---|
| slices, findings, diffs | ✓ | ✓ |
| syntax highlighting | ✓ | ✓ |
| markdown in summaries and fixes | ✓ | ✓ |
| themeable colours | ✓ | ✓ |
| split diff | | ✓ |
| line comments, posting a review | ✓ | ✓ |

### Terminal keys

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
the side panels and gives the diff the whole terminal, which is usually the
faster way to read a wide file.

Selecting a slice shows its card — the walkthrough, its files, and every
finding it covers — instead of a diff. The last row of the tree is the draft
review: what is staged and what will happen to it on submit.

`c` opens `$EDITOR`, seeded with any finding anchored to that line. Save to
stage the draft, save it empty to discard. Drafts persist beside the review in
the cache, and drafted lines carry a green bar in the gutter.

### Browser keys

| | |
|---|---|
| `j` `k` | file down / up |
| `[` `]` | previous / next slice |
| `n` `p` | next / previous finding |
| `r` | mark current file reviewed |
| `h` | hide reviewed files |
| `d` | split / unified diff |
| `1` `2` `3` | analysis / findings / comments |
| `?` | help |

Progress, dismissed findings, and comment drafts persist to `localStorage` per
PR, so closing the tab mid-review doesn't lose your place.

## Posting back to GitHub

Draft a comment from any finding (it's seeded with the title, reasoning, and
fix), edit it, then post the batch as a single PR review. `gh pr review` can't
attach line comments, so this goes through
`POST /repos/{owner}/{repo}/pulls/{n}/reviews` with all comments in one request.

The repo and PR number come from the manifest server-side — never from the
browser — so a stray page can't aim a review at a different repository.

Two constraints worth knowing:

- GitHub rejects a comment on any line not in the diff, and 422s the **whole
  batch** without saying which one. Drafts with no valid line anchor are
  appended to the review body instead.
- GitHub rejects `APPROVE` and `REQUEST_CHANGES` on your own PR. The UI detects
  this and offers plain comments only.

## Configuration

Two things are configurable, and they belong in different places.

```
pr-review --init-config        # .pr-review.jsonc in the repo — how it reviews
pr-review --init-config user   # ~/.config/pr-review/config.jsonc — how it looks
pr-review --print-config       # the resolved result, and which files produced it
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
one thing that cannot be changed: `merge.mjs` and both viewers are built
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
missing. `syntax` is the one setting that recolours the code rather than the
chrome — and because both viewers highlight from the same Shiki tokens, it is
the same theme the browser would use.

## Layout

Four workspace packages. `core` knows nothing about either viewer's rendering;
the viewers know nothing about `gh`, `git`, or the model; `config` is a leaf
both sides depend on.

```
packages/config/        defaults, presets, and the JSONC loader
  defaults.mjs          severities, slice kinds, everything with a default
  themes.mjs            the dark and light presets

packages/core/          the pipeline, and the only thing that talks to gh/claude
  bin/pr-review.mjs     resolve target, capture patch, run analysis, launch a viewer
  lib/patch.mjs         split a unified diff into per-file patches
  lib/prompt.mjs        the analysis prompt, assembled from overridable sections
  lib/merge.mjs         validate model output against the patch

packages/tui/           terminal viewer (ink)
  bin/pr-review-tui.mjs layout, keys, state
  src/render.mjs        @pierre/diffs hast -> styled segments
  src/markdown.mjs      markdown -> styled, pre-wrapped line segments
  src/theme.mjs         config + manifest -> what the viewer draws with

packages/web/           browser viewer (sveltekit)
  src/lib/              viewer state, types, components
  src/routes/           page + the review-posting endpoint
```

`review.json` is the contract between them, so either viewer can be opened
against a cached review without re-running the analysis:

```
npm run tui -- ~/.cache/pr-review/<repo>/pr-1692.review.json
```

## Browser appearance

The browser viewer keeps its own appearance controls rather than reading the
config file — open **Appearance** in its toolbar for diff layout, highlighting,
font size, tree density, tree width, and tree colors. Settings persist in the
current browser. The Advanced CSS section accepts CSS injected into each
library's shadow root for styling beyond the built-in controls.

## Caching

Artifacts are cached in `~/.cache/pr-review/<repo>/`, outside the repo, so
reviewing never dirties your working tree. Re-run with `--refresh` to redo the
analysis, or `--no-analyze` to just browse the diff.

## Notes

- In `packages/web`, `react` and `react-dom` are dev dependencies only.
  `@pierre/diffs` declares them as required peers, but the browser viewer uses
  its vanilla (non-React) API and never imports them, so they aren't bundled.
  `packages/tui` depends on `react` for real — Ink is React.
- The terminal viewer uses `@pierre/diffs` **headlessly**: `getSingularPatch`
  parses and `renderDiffWithHighlighter` returns hast with Shiki's colors
  inline, which `src/render.mjs` walks into styled segments. Only the
  web-component layer needs a DOM, and the terminal viewer never touches it —
  so both viewers highlight from identical tokens.
- Diff lines are kept as addressable segments rather than pre-rendered ANSI.
  A flat escape-laden string can be printed but not manipulated; keeping the
  pieces is what makes horizontal scrolling, full-width add/delete bands, and
  recolouring from config possible without re-parsing the diff.
- Hunk expansion beyond the context in the patch is not wired up; it needs
  `loadDiffFiles` to fetch full file contents.
