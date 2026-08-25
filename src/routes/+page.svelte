<script lang="ts">
  import AnalysisPanel from '$lib/components/AnalysisPanel.svelte'
  import CommentsPanel from '$lib/components/CommentsPanel.svelte'
  import DiffFile from '$lib/components/DiffFile.svelte'
  import SliceTree from '$lib/components/SliceTree.svelte'
  import TriagePanel from '$lib/components/TriagePanel.svelte'
  import { ReviewSession } from '$lib/state.svelte'
  import { SEVERITY_META, SEVERITY_ORDER } from '$lib/types'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  const session = new ReviewSession(data.review)
  const target = data.review.target

  let diffStyle = $state<'split' | 'unified'>('split')
  let showHelp = $state(false)
  let refs = $state<Record<string, DiffFile | undefined>>({})

  const paths = $derived(session.visiblePaths)
  const progress = $derived(session.overallProgress)
  const totals = $derived(session.countsBySeverity())

  function step<T>(list: T[], current: T, delta: number): T | undefined {
    if (list.length === 0) return undefined
    const index = list.indexOf(current)
    if (index === -1) return list[0]
    return list[Math.min(list.length - 1, Math.max(0, index + delta))]
  }

  function moveFile(delta: number) {
    const next = step(paths, session.activePath, delta)
    if (next) session.selectPath(next)
  }

  function moveSlice(delta: number) {
    const ids = session.review.slices.map((s) => s.id)
    const next = step(ids, session.activeSliceId, delta)
    if (next) session.selectSlice(next)
  }

  function moveFinding(delta: number) {
    const live = session.liveFindings
    if (live.length === 0) return
    const index = live.findIndex((f) => f.id === session.activeFindingId)
    const next = live[index === -1 ? 0 : Math.min(live.length - 1, Math.max(0, index + delta))]
    if (!next) return
    session.focusFinding(next)
    session.panel = 'findings'
    if (next.line) requestAnimationFrame(() => refs[next.path]?.revealLine(next.line as number))
  }

  function onKeydown(event: KeyboardEvent) {
    const el = event.target as HTMLElement
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable) return
    if (event.metaKey || event.ctrlKey || event.altKey) return

    switch (event.key) {
      case 'j':
        moveFile(1)
        break
      case 'k':
        moveFile(-1)
        break
      case ']':
        moveSlice(1)
        break
      case '[':
        moveSlice(-1)
        break
      case 'n':
        moveFinding(1)
        break
      case 'p':
        moveFinding(-1)
        break
      case 'r':
        if (session.activePath) session.toggleReviewed(session.activePath)
        break
      case 'd':
        diffStyle = diffStyle === 'split' ? 'unified' : 'split'
        break
      case 'h':
        session.hideReviewed = !session.hideReviewed
        break
      case '1':
        session.panel = 'analysis'
        break
      case '2':
        session.panel = 'findings'
        break
      case '3':
        session.panel = 'comments'
        break
      case '?':
        showHelp = !showHelp
        break
      case 'Escape':
        showHelp = false
        break
      default:
        return
    }
    event.preventDefault()
  }

  $effect(() => {
    refs[session.activePath]?.scrollIntoView()
  })
</script>

<svelte:window onkeydown={onKeydown} />

<svelte:head>
  <title>{target.kind === 'pr' ? `#${target.number}` : target.headRef} · {target.title}</title>
</svelte:head>

<header class="top">
  <div class="title">
    <h1>{target.title}</h1>
    <span class="meta">
      {#if target.kind === 'pr'}
        <a href={target.url} target="_blank" rel="noreferrer">#{target.number}</a>
      {:else}
        <span class="mono">{target.headRef}</span>
      {/if}
      <span class="dim">·</span>
      <span>{target.author}</span>
      <span class="dim">·</span>
      <span class="mono dim">{target.baseRef} ← {target.headRef}</span>
    </span>
  </div>

  <div class="totals">
    {#each SEVERITY_ORDER as severity (severity)}
      {#if totals[severity] > 0}
        <span class="tot" style="--sev: {SEVERITY_META[severity].color}" title={SEVERITY_META[severity].label}>
          {SEVERITY_META[severity].glyph}{totals[severity]}
        </span>
      {/if}
    {/each}
  </div>

  <div class="progress" title="{progress.done} of {progress.total} files reviewed">
    <div class="bar"><div class="fill" style="width: {(progress.done / Math.max(1, progress.total)) * 100}%"></div></div>
    <span class="mono">{progress.done}/{progress.total}</span>
  </div>

  <div class="tools">
    <button class:on={session.hideReviewed} onclick={() => (session.hideReviewed = !session.hideReviewed)}>
      hide done
    </button>
    <button onclick={() => (diffStyle = diffStyle === 'split' ? 'unified' : 'split')}>{diffStyle}</button>
    <button onclick={() => (showHelp = !showHelp)}>?</button>
  </div>
</header>

<div class="cols">
  <aside class="left"><SliceTree {session} /></aside>

  <main class="center scroll">
    {#if session.activeSlice}
      <div class="slice-head">
        <span class="n">{session.review.slices.indexOf(session.activeSlice) + 1}</span>
        <div>
          <h2>{session.activeSlice.title}</h2>
          <p>{session.activeSlice.summary}</p>
        </div>
      </div>
    {/if}

    {#each paths as path (path)}
      {#if session.review.files[path]}
        <DiffFile bind:this={refs[path]} file={session.review.files[path]} {session} {diffStyle} />
      {/if}
    {/each}

    {#if paths.length === 0}
      <p class="done-msg">Every file in this slice is marked reviewed. Press <kbd>]</kbd> for the next slice.</p>
    {/if}
  </main>

  <aside class="right">
    <nav class="tabs">
      <button class:on={session.panel === 'analysis'} onclick={() => (session.panel = 'analysis')}>Analysis</button>
      <button class:on={session.panel === 'findings'} onclick={() => (session.panel = 'findings')}>
        Findings
        {#if session.liveFindings.length}<span class="badge">{session.liveFindings.length}</span>{/if}
      </button>
      <button class:on={session.panel === 'comments'} onclick={() => (session.panel = 'comments')}>
        Comments
        {#if session.drafts.length}<span class="badge">{session.drafts.length}</span>{/if}
      </button>
    </nav>

    {#if session.panel === 'analysis'}
      <AnalysisPanel {session} />
    {:else if session.panel === 'findings'}
      <TriagePanel {session} />
    {:else}
      <CommentsPanel {session} />
    {/if}
  </aside>
</div>

{#if showHelp}
  <button class="scrim" onclick={() => (showHelp = false)} aria-label="Close help"></button>
  <div class="help">
    <h3>Keys</h3>
    <dl>
      <div><kbd>j</kbd><kbd>k</kbd><span>file down / up</span></div>
      <div><kbd>[</kbd><kbd>]</kbd><span>previous / next slice</span></div>
      <div><kbd>n</kbd><kbd>p</kbd><span>next / previous finding</span></div>
      <div><kbd>r</kbd><span>mark current file reviewed</span></div>
      <div><kbd>h</kbd><span>hide reviewed files</span></div>
      <div><kbd>d</kbd><span>split / unified diff</span></div>
      <div><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><span>analysis / findings / comments</span></div>
    </dl>
  </div>
{/if}

<style>
  .top {
    height: var(--header-h);
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 0 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-raised);
  }

  .title {
    min-width: 0;
    flex: 1;
  }

  h1 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta {
    display: flex;
    gap: 6px;
    font-size: 11px;
    color: var(--text-muted);
  }

  .dim {
    color: var(--text-faint);
  }

  .totals {
    display: flex;
    gap: 8px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .tot {
    color: var(--sev);
  }

  .progress {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11px;
    color: var(--text-muted);
  }

  .bar {
    width: 90px;
    height: 4px;
    border-radius: 2px;
    background: var(--bg-inset);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    background: var(--ok);
    transition: width 0.2s;
  }

  .tools {
    display: flex;
    gap: 4px;
  }

  .tools button {
    padding: 3px 8px;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    font-size: 11px;
    color: var(--text-muted);
  }

  .tools button.on {
    border-color: var(--accent);
    color: var(--accent);
  }

  .cols {
    display: grid;
    grid-template-columns: 270px minmax(0, 1fr) 380px;
    height: calc(100vh - var(--header-h));
  }

  .left {
    border-right: 1px solid var(--border);
    background: var(--bg-raised);
    overflow: hidden;
  }

  .center {
    padding: 14px;
    background: var(--bg);
  }

  .right {
    border-left: 1px solid var(--border);
    background: var(--bg-raised);
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    overflow: hidden;
  }

  .tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
  }

  .tabs button {
    flex: 1;
    padding: 9px 4px;
    font-size: 11.5px;
    color: var(--text-faint);
    border-bottom: 2px solid transparent;
  }

  .tabs button.on {
    color: var(--text);
    border-bottom-color: var(--accent);
  }

  .badge {
    display: inline-block;
    margin-left: 3px;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--bg-inset);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  .slice-head {
    display: flex;
    gap: 10px;
    margin-bottom: 14px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }

  .slice-head .n {
    flex: 0 0 22px;
    height: 22px;
    border-radius: 4px;
    background: var(--accent-dim);
    color: var(--text);
    display: grid;
    place-items: center;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  h2 {
    margin: 0 0 3px;
    font-size: 14px;
    font-weight: 600;
  }

  .slice-head p {
    margin: 0;
    color: var(--text-muted);
    font-size: 12.5px;
    line-height: 1.55;
    max-width: 78ch;
  }

  .done-msg {
    color: var(--text-faint);
    font-size: 12.5px;
  }

  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    border: none;
    cursor: default;
  }

  .help {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    padding: 16px 20px;
    min-width: 300px;
  }

  .help h3 {
    margin: 0 0 10px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-faint);
  }

  .help dl {
    margin: 0;
    display: grid;
    gap: 7px;
  }

  .help dl div {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--text-muted);
  }

  .help span {
    margin-left: 6px;
  }

  kbd {
    font-family: var(--mono);
    font-size: 10.5px;
    padding: 1px 5px;
    border: 1px solid var(--border-strong);
    border-bottom-width: 2px;
    border-radius: 3px;
    background: var(--bg-inset);
    color: var(--text);
  }
</style>
