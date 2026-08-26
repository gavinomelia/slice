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
| split diff, appearance settings | | ✓ |
| line comments, posting a review | | ✓ |

### Terminal keys

Every key means one thing everywhere — there is no focused pane and no mode.

| | |
|---|---|
| `j` `k` | move through slices and files |
| `[` `]` | previous / next slice |
| `n` `p` | next / previous finding, anywhere in the review |
| `↑` `↓` | scroll the diff |
| `space` `b` | page the diff |
| `q` | quit |

Selecting a slice shows its card — the walkthrough, its files, and every
finding it covers — instead of a diff.

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

## Layout

Three workspace packages. `core` knows nothing about either viewer's rendering;
the viewers know nothing about `gh`, `git`, or the model.

```
packages/core/          the pipeline, and the only thing that talks to gh/claude
  bin/pr-review.mjs     resolve target, capture patch, run analysis, launch a viewer
  lib/patch.mjs         split a unified diff into per-file patches
  lib/prompt.mjs        the analysis prompt
  lib/merge.mjs         validate model output against the patch

packages/tui/           terminal viewer (ink)
  bin/pr-review-tui.mjs layout, keys, state
  src/render.mjs        @pierre/diffs hast -> ANSI
  src/markdown.mjs      markdown -> styled, pre-wrapped line segments

packages/web/           browser viewer (sveltekit)
  src/lib/              viewer state, types, components
  src/routes/           page + the review-posting endpoint
```

`review.json` is the contract between them, so either viewer can be opened
against a cached review without re-running the analysis:

```
npm run tui -- ~/.cache/pr-review/<repo>/pr-1692.review.json
```

## Appearance

Open **Appearance** in the browser viewer's toolbar to customize diff layout, highlighting,
font size, tree density, tree width, and tree colors. Settings persist in the
current browser. The Advanced CSS section accepts CSS injected into each
library's shadow root for styling beyond the built-in controls.

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
  inline, which `src/render.mjs` walks into ANSI. Only the web-component layer
  needs a DOM, and the terminal viewer never touches it — so both viewers
  highlight from identical tokens.
- Hunk expansion beyond the context in the patch is not wired up; it needs
  `loadDiffFiles` to fetch full file contents.
