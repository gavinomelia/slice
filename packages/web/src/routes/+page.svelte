<script lang="ts">
  import CircleHelp from '@lucide/svelte/icons/circle-help'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import Settings2 from '@lucide/svelte/icons/settings-2'
  import { onMount } from 'svelte'
  import AnalysisPanel from '$lib/components/AnalysisPanel.svelte'
  import AppearancePanel from '$lib/components/AppearancePanel.svelte'
  import CommentsPanel from '$lib/components/CommentsPanel.svelte'
  import DiffFile from '$lib/components/DiffFile.svelte'
  import SliceTree from '$lib/components/SliceTree.svelte'
  import TriagePanel from '$lib/components/TriagePanel.svelte'
  import { ReviewSession } from '$lib/state.svelte'
  import { SEVERITY_META, SEVERITY_ORDER } from '$lib/types'
  import {
    DEFAULT_VIEWER_APPEARANCE,
    loadViewerAppearance,
    saveViewerAppearance,
  } from '$lib/viewerAppearance'
  import type { ViewerAppearance } from '$lib/viewerAppearance'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  const session = new ReviewSession(data.review)
  const target = data.review.target

  let diffStyle = $state<'split' | 'unified'>('split')
  let showHelp = $state(false)
  let showAppearance = $state(false)
  let refs = $state<Record<string, DiffFile | undefined>>({})
  let appearance = $state<ViewerAppearance>({ ...DEFAULT_VIEWER_APPEARANCE })
  let appearanceReady = $state(false)
  let treeResizeStart: { x: number; width: number } | null = null

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

  function isTyping(event: KeyboardEvent) {
    return event.composedPath().some(
      (target) =>
        target instanceof HTMLElement &&
        (target.matches('input, textarea, select, [role="textbox"]') || target.isContentEditable),
    )
  }

  function clampTreeWidth(width: number) {
    return Math.min(420, Math.max(190, width))
  }

  function beginTreeResize(event: PointerEvent) {
    if (event.button !== 0) return
    treeResizeStart = { x: event.clientX, width: appearance.treeWidth }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function resizeTree(event: PointerEvent) {
    if (!treeResizeStart) return
    updateAppearance({ treeWidth: clampTreeWidth(treeResizeStart.width + event.clientX - treeResizeStart.x) })
  }

  function endTreeResize(event: PointerEvent) {
    treeResizeStart = null
    const handle = event.currentTarget as HTMLElement
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
  }

  function resizeTreeWithKeyboard(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const direction = event.key === 'ArrowLeft' ? -1 : 1
    updateAppearance({ treeWidth: clampTreeWidth(appearance.treeWidth + direction * (event.shiftKey ? 32 : 16)) })
    event.preventDefault()
  }

  function updateAppearance(patch: Partial<ViewerAppearance>) {
    appearance = { ...appearance, ...patch }
  }

  function resetAppearance() {
    appearance = { ...DEFAULT_VIEWER_APPEARANCE }
  }

  function onKeydown(event: KeyboardEvent) {
    if (isTyping(event)) return
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
        showAppearance = false
        break
      default:
        return
    }
    event.preventDefault()
  }

  $effect(() => {
    refs[session.activePath]?.scrollIntoView()
  })

  $effect(() => {
    if (appearanceReady) saveViewerAppearance(appearance)
  })

  onMount(() => {
    appearance = loadViewerAppearance()
    appearanceReady = true
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

  <div
    class="progress"
    role="progressbar"
    aria-label="Files reviewed"
    aria-valuemin="0"
    aria-valuemax={progress.total}
    aria-valuenow={progress.done}
    title="{progress.done} of {progress.total} files reviewed"
  >
    <div class="bar"><div class="fill" style="width: {(progress.done / Math.max(1, progress.total)) * 100}%"></div></div>
    <span class="mono">{progress.done}/{progress.total}</span>
  </div>

  <div class="tools">
    <button
      class="icon-tool hide-reviewed"
      class:on={session.hideReviewed}
      aria-pressed={session.hideReviewed}
      aria-label={session.hideReviewed ? 'Show reviewed files' : 'Hide reviewed files'}
      title={session.hideReviewed ? 'Show reviewed files (h)' : 'Hide reviewed files (h)'}
      onclick={() => (session.hideReviewed = !session.hideReviewed)}
    >
      {#if session.hideReviewed}<Eye size={15} strokeWidth={1.8} />{:else}<EyeOff size={15} strokeWidth={1.8} />{/if}
    </button>
    <div class="mode" role="group" aria-label="Diff layout">
      <button class:on={diffStyle === 'split'} aria-pressed={diffStyle === 'split'} onclick={() => (diffStyle = 'split')}>
        Split
      </button>
      <button class:on={diffStyle === 'unified'} aria-pressed={diffStyle === 'unified'} onclick={() => (diffStyle = 'unified')}>
        Unified
      </button>
    </div>
    <button
      class="icon-tool"
      aria-label="Keyboard shortcuts"
      aria-expanded={showHelp}
      title="Keyboard shortcuts (?)"
      onclick={() => (showHelp = !showHelp)}><CircleHelp size={15} strokeWidth={1.8} /></button>
    <button
      class="icon-tool"
      class:on={showAppearance}
      aria-pressed={showAppearance}
      aria-label="Appearance settings"
      title="Appearance settings"
      onclick={() => (showAppearance = !showAppearance)}
    >
      <Settings2 size={15} strokeWidth={1.8} />
    </button>
  </div>
</header>

<div class="cols" style="--tree-width: {appearance.treeWidth}px">
  <aside class="left">
    <SliceTree {session} {appearance} />
    <button
      class="tree-resizer"
      aria-label="Resize file tree, currently {appearance.treeWidth} pixels wide"
      onpointerdown={beginTreeResize}
      onpointermove={resizeTree}
      onpointerup={endTreeResize}
      onpointercancel={endTreeResize}
      onkeydown={resizeTreeWithKeyboard}
    ></button>
  </aside>

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
        <DiffFile bind:this={refs[path]} file={session.review.files[path]} {session} {diffStyle} {appearance} />
      {/if}
    {/each}

    {#if paths.length === 0}
      <p class="done-msg">Every file in this slice is marked reviewed. Press <kbd>]</kbd> for the next slice.</p>
    {/if}
  </main>

  <aside class="right">
    <nav class="tabs">
      <button aria-pressed={session.panel === 'analysis'} class:on={session.panel === 'analysis'} onclick={() => (session.panel = 'analysis')}>Analysis</button>
      <button aria-pressed={session.panel === 'findings'} class:on={session.panel === 'findings'} onclick={() => (session.panel = 'findings')}>
        Findings
        {#if session.liveFindings.length}<span class="badge">{session.liveFindings.length}</span>{/if}
      </button>
      <button aria-pressed={session.panel === 'comments'} class:on={session.panel === 'comments'} onclick={() => (session.panel = 'comments')}>
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
  <div class="help" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
    <h3 id="shortcuts-title">Keyboard shortcuts</h3>
    <dl>
      <div><kbd>j</kbd><kbd>k</kbd><span>file down / up</span></div>
      <div><kbd>[</kbd><kbd>]</kbd><span>previous / next slice</span></div>
      <div><kbd>n</kbd><kbd>p</kbd><span>next / previous finding</span></div>
      <div><kbd>r</kbd><span>toggle reviewed and collapse</span></div>
      <div><kbd>h</kbd><span>hide reviewed files</span></div>
      <div><kbd>d</kbd><span>split / unified diff</span></div>
      <div><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><span>analysis / findings / comments</span></div>
    </dl>
  </div>
{/if}

{#if showAppearance}
  <AppearancePanel
    {appearance}
    onChange={updateAppearance}
    onReset={resetAppearance}
    onClose={() => (showAppearance = false)}
  />
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
    position: relative;
    z-index: 10;
    box-shadow: 0 1px 8px rgb(0 0 0 / 18%);
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
    align-items: center;
    gap: 4px;
  }

  .tools button {
    min-height: 28px;
    padding: 4px 9px;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    font-size: 11px;
    color: var(--text-muted);
    transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
  }

  .tools button:hover {
    color: var(--text);
    border-color: var(--text-faint);
  }

  .tools button.on {
    border-color: color-mix(in srgb, var(--accent) 65%, var(--border));
    background: color-mix(in srgb, var(--accent-dim) 55%, transparent);
    color: var(--text);
  }

  .mode {
    display: flex;
    padding: 2px;
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    background: var(--bg-inset);
  }

  .mode button {
    min-height: 22px;
    border: 0;
    padding: 2px 7px;
  }

  .mode button.on {
    background: var(--bg-hover);
    color: var(--text);
  }

  .icon-tool {
    display: grid;
    place-items: center;
    width: 28px;
    padding-inline: 0 !important;
  }

  .cols {
    display: grid;
    grid-template-columns: var(--tree-width) minmax(0, 1fr) clamp(320px, 25vw, 380px);
    height: calc(100vh - var(--header-h));
  }

  .left {
    border-right: 1px solid var(--border);
    background: var(--bg-raised);
    overflow: hidden;
    position: relative;
  }

  .tree-resizer {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 4;
    width: 8px;
    padding: 0;
    border: 0;
    border-radius: 0;
    cursor: col-resize;
    touch-action: none;
  }

  .tree-resizer::after {
    content: '';
    position: absolute;
    top: 0;
    right: 3px;
    bottom: 0;
    width: 1px;
    background: transparent;
    transition: background-color 0.15s ease;
  }

  .tree-resizer:hover::after,
  .tree-resizer:focus-visible::after {
    background: var(--accent);
  }

  .center {
    padding: 16px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--bg-raised) 35%, var(--bg)) 0, var(--bg) 150px);
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
    background: var(--bg-inset);
  }

  .tabs button {
    flex: 1;
    padding: 9px 4px;
    font-size: 11.5px;
    color: var(--text-faint);
    border-bottom: 2px solid transparent;
    transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
  }

  .tabs button:hover {
    color: var(--text-muted);
    background: var(--bg-hover);
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
    z-index: 20;
    box-shadow: 0 18px 48px rgb(0 0 0 / 45%);
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

  @media (max-width: 1100px) {
    .totals {
      display: none;
    }
  }

  @media (max-width: 860px) {
    .cols {
      grid-template-columns: minmax(0, 1fr) 330px;
    }

    .left {
      display: none;
    }

    .meta .dim:last-child,
    .meta .mono:last-child {
      display: none;
    }
  }

  @media (max-width: 680px) {
    .top {
      gap: 8px;
      padding-inline: 10px;
    }

    .meta,
    .progress,
    .hide-reviewed {
      display: none;
    }

    .cols {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(52%, 1fr) minmax(280px, 42%);
    }

    .center {
      padding: 10px;
    }

    .right {
      border-top: 1px solid var(--border);
      border-left: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .fill,
    .tools button,
    .tabs button {
      transition: none;
    }
  }
</style>
