# slice

[![CI](https://github.com/gavinomelia/slice/actions/workflows/ci.yml/badge.svg)](https://github.com/gavinomelia/slice/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A terminal PR/diff viewer that groups changed files by behavioral slice
(the migration, model, controller, view, and spec that make one feature
work) instead of by directory. Optionally adds an AI-generated review:
slices, a walkthrough of how the change works and why, and findings, with
the ability to comment and post back to GitHub.

## Usage

```
slice 1679        # browse the diff for PR #1679
slice my-branch   # that branch's PR, or diff the branch if it has none
slice             # the PR for the current branch, or the branch diff
slice --branch    # local branch vs its base, before a PR exists
slice -w          # what you have not committed yet (--wip)
slice 1679 --ai   # add the AI-analyzed review: slices, walkthrough, findings
slice -p "..."    # analyze, with something extra to say about how
```

By default slice just opens the diff — no model runs. Pass `--ai` for the
analyzed review; once a review has been analyzed, running `slice` again
reopens it without re-running the model. `--refresh` redoes it.

`-p "..."` adds a one-off note to the review prompt and implies `--ai`. For
rules that should apply every time, put them in `.slice.jsonc` instead.

`slice -w` stays live: it watches the working tree and updates as files are
edited, created, staged, or committed, keeping your place in the diff. It
opens on a clean tree too, so it can sit beside an agent from the start.
`r` reloads by hand.

## Install

```
npm install -g @gavinomelia/slice
```

Requires Node 20+, macOS or Linux, the [GitHub CLI](https://cli.github.com)
(`gh`, authenticated), and [Claude Code](https://claude.com/claude-code)
(`claude`) for `--ai`. No API key needed — analysis runs through your
existing Claude Code session. Windows is not supported directly; it works
under WSL.

## How the AI review works

Claude Code reads your repo (read-only: `Read`, `Grep`, `Glob`) to produce
the analysis, rather than working from the diff text alone, so it can
follow callers, sibling implementations, and your own conventions
(`.github/instructions/*.md`, `docs/CONVENTIONS.md`). Every finding is
validated against the actual patch — a finding on a line or file outside
the diff is dropped or demoted rather than trusted outright.

Because the diff is attacker-controlled input (it's someone else's PR), the
analysis never gets write, execute, or network tools by default, and a
repo's own config cannot widen its toolset — only yours can (see
[Configuration](#configuration)).

## Keys

| | |
|---|---|
| `1` `2` `3` `tab` | focus slices / diff / findings |
| `j` `k` `↑` `↓` | move within the focused panel |
| `space` `b` | page within the focused panel |
| `h` `l` `←` `→` | scroll the diff sideways, `0` back to the left |
| `v` | switch the diff between unified and split |
| `H` `L` | in split, which column `c` comments on |
| `z` | zoom the diff to the full terminal |
| `[` `]` | previous / next slice |
| `n` `p` | next / previous finding, anywhere in the review |
| `x` | mark the selected file — or whole slice — read, and move on |
| `r` | reload the diff (`-w` only; it also reloads on its own) |
| `y` `Y` | copy the findings here — or the whole review's — as a fix prompt |
| `c` | comment on the diff's cursor line |
| `s` `A` `R` | submit as comment / approve / request changes |
| `q` `ctrl-c` | quit |

`escape` dismisses the status line without quitting (so you don't lose
unposted drafts). `c` opens `$EDITOR` to draft a line comment; `s`/`A`/`R`
open `$EDITOR` for the review body and post the whole batch as one PR
review — saving empty cancels. `y`/`Y` copy findings as a fix prompt (to
`pbcopy`/`wl-copy`/`xclip`/`xsel`, or a file if none are available) to hand
to any coding agent.

## Configuration

```
slice --init-config        # .slice.jsonc in the repo, how it reviews
slice --init-config user   # ~/.config/slice/config.jsonc, how it looks
slice --print-config       # the resolved result, and which files produced it
```

How the code is reviewed belongs in the repo's `.slice.jsonc`; how the
viewer looks, and what the AI is *allowed* to do, belong in your own
`~/.config/slice/config.jsonc`. `--config <path>` replaces both layers.
The format is JSONC (JSON with comments/trailing commas), not
JavaScript — reviewing a PR means checking out its branch, and an
executable config would let that branch run code.

```jsonc
// .slice.jsonc — committed to the repo
{
  "review": {
    "slicing": "Treat anything under db/migrate as its own slice, always.",
    "findings": { "append": "A controller action with no Pundit policy check is a bug, not a risk." },
    "instructions": "Ignore anything under vendor/.",
    "severities": { "nit": null },
    "conventionFiles": ["docs/CONVENTIONS.md"]
  }
}
```

```jsonc
// ~/.config/slice/config.jsonc — yours only
{
  "review": {
    "allowedTools": ["Read", "Grep", "Glob"],
    "model": "opus",
    "effort": "medium"   // low is the default and much faster
  },
  "theme": { "preset": "dark", "syntax": "tokyo-night" },
  "layout": { "diffView": "unified", "treeWidth": 38 }
}
```

For safety, a small set of settings (`allowedTools`, `promptFile`,
`provider`, `model`, `effort`) can only be set in your own config, never
the repo's — otherwise a PR could hand itself `Bash`/`Write` on your
machine. slice warns if a repo tries.

## Caching

Artifacts, drafts, and read marks are cached in
`$XDG_CACHE_HOME/slice/<repo>/` (or `~/.cache/slice/`), outside the repo.
`slice --clear-cache` drops it all. Reopen a cached review directly:

```
slice --open ~/.cache/slice/<repo>/pr-1692.review.json
```

## Layout

```
bin/slice.mjs           resolve target, capture patch, run analysis, open the viewer
src/pipeline/           the only code that talks to gh, git, or the model
src/viewer/             the terminal UI (ink)
src/config/             defaults, presets, and the JSONC loader
test/                   node:test, no dependencies
```

## Development

```
npm install
npm test                       # node:test, no dependencies
npm run format                 # prettier
node bin/slice.mjs --open <review.json>
```

`SLICE_DEBUG=1` keeps the stack trace on an unexpected failure. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how the pieces are tested.

## License

MIT, see [LICENSE](LICENSE).
