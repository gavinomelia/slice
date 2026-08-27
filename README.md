# slice

A pull request is not a pile of files. It's a few behavioral changes that
happen to touch a lot of directories. `slice` reads it that way: the diff in
your terminal, optionally with AI analysis beside it, and the changed files
**grouped by behavioral slice** rather than by path.

```
slice 1679        # browse the diff for PR #1679
slice my-branch   # that branch's PR, or diff the branch if it has none
slice             # the PR for the current branch, or the branch diff
slice --branch    # local branch vs its base, before a PR exists
slice 1679 --ai   # the same, with the AI-analyzed review — slices, summaries, findings
slice -p "..."    # analyze, with something extra to say about how
```

The positional argument is a PR number or a branch name — `gh` resolves either,
so `slice ccc-642-implement-posts-on-portal` finds that branch's PR and falls
back to diffing the branch when there isn't one. A branch you have fetched but
never checked out works too.

By default `slice` just opens the diff — no model runs, nothing to wait on.
Pass `--ai` when you want the analyzed review. Without it, files aren't grouped
into slices, but they are still ordered by when they were first committed
rather than alphabetically — usually close to the order the change was built
in, and a reasonable one to review in.

## Saying something about this review

`-p` adds to the review prompt for one run, and implies `--ai`:

```
slice -p "Group things by file type alphabetically, and review for security in particular"
slice 1679 -p "The migration is the risky part — check it against the backfill job"
slice -p "Ignore the CSS" -p "Be harsh about the API contract"
```

It lands in the same place as `review.instructions` in a config file: the
catch-all at the end of the prompt, after the sections that decide slicing,
summaries, and findings. It **adds to** whatever the repo's config already
said rather than replacing it — a one-off note should not silently drop your
team's standing rules. Repeating the flag adds another line, so a shell alias
can carry a standing rule and the call still gets to say something of its own.

A prompted run is cached separately from a plain one, so the two never
overwrite each other's answer: repeating the same `-p` costs nothing, and
dropping it gives you the unprompted review back rather than a stale one
shaped by a flag you are no longer passing.

If a rule turns out to be one you want every time, move it into `.slice.jsonc`
— either `review.instructions`, or the specific section it belongs to.

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
| `v` | switch the diff between unified and split |
| `H` `L` | in split, which column `c` comments on |
| `z` | zoom the diff to the full terminal |
| `[` `]` | previous / next slice |
| `n` `p` | next / previous finding, anywhere in the review |
| `c` | comment on the diff's cursor line |
| `s` `A` `R` | submit as comment / approve / request changes |
| `q` | quit |

Code is never wrapped — a wrapped diff line is a lie about the code — so long
lines are truncated with a `›` at the edge and reached with `h` `l`. `z` hides
the side panels and gives the diff the whole terminal.

`v` switches between unified and split. Split pairs each run of deletions with
the additions that follow it, old on the left under the old line numbers, new on
the right — the same guess every side-by-side viewer makes, since a diff records
that three lines became two and not which became which. It costs half the width
per column, so `z` and `v` go together on anything but a wide terminal. `H` and
`L` pick the column `c` comments on; a line that exists in only one of them
takes the cursor regardless.

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
    "instructions": "Ignore anything under vendor/.",   // `slice -p` adds to this

    "severities": { "nit": null },        // stop reporting nits entirely
    "allowedTools": ["Read", "Grep", "Glob", "mcp__linear__get_issue"],
    "model": "opus",
    "effort": "medium"                    // more reasoning, ~3x the wall-clock
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
against its shape. `{{instructions}}` places `review.instructions` and anything
from `-p`; leave it out and they are appended at the end, so the flag still
works against a replaced prompt.

`allowedTools` is worth knowing about. It is read-only by default because the
analysis runs non-interactively, so a tool that triggers a permission prompt
hangs forever with nobody to answer it — which also means an instruction file
that asks the review to check a ticket is silently a no-op until you add the
MCP server here. It is also the entire toolset rather than a list of
pre-approved tools, so adding `Bash` really does mean the review can run your
test suite, and given the chance it will.

`effort` is the speed dial, and `low` is the default. On a seven-file diff that
is 46s against 166s at `medium`, because the extra thinking goes into widening
the search rather than sharpening the verdict — the expensive runs wander off
into the CI config and the README. Raise it for a diff whose correctness turns
on reasoning rather than reading.

### Appearance

```jsonc
{
  "theme": {
    "preset": "dark",          // or "light", or just "theme": "light"
    "syntax": "tokyo-night",   // any Shiki theme, plus pierre-dark / pierre-light
    "ui": { "accent": "magenta", "borderFocus": "magenta" },
    "diff": { "addBg": "#0b2c18", "delBg": "#3a1114" }
  },
  "layout": {
    "diffView": "unified",   // or "split" — which one a diff opens in; v switches
    "treeWidth": 38, "findingsWidth": 58, "tabWidth": 4, "hScrollStep": 8
  }
}
```

Colours are terminal palette names or hex. Palette names follow your terminal
theme, hex does not, and both downsample automatically where truecolour is
missing.

## Caching

Artifacts are cached in `~/.cache/slice/<repo>/`, outside the repo, so reviewing
never dirties your working tree. Re-run with `--ai --refresh` to redo the
analysis; plain `--ai` reuses the cached one if there is one. A run with `-p`
gets its own entry, keyed by a hash of the instructions, so it neither reads
nor clobbers the plain review of the same diff.

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
