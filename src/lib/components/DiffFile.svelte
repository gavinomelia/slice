<script lang="ts">
  import { FileDiff, processPatch } from '@pierre/diffs'
  import type { DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs'
  import { mount, unmount, untrack } from 'svelte'
  import FindingCard from './FindingCard.svelte'
  import type { Finding, PatchFile } from '$lib/types'
  import type { ReviewSession } from '$lib/state.svelte'

  let {
    file,
    session,
    diffStyle = 'split',
  }: { file: PatchFile; session: ReviewSession; diffStyle?: 'split' | 'unified' } = $props()

  let codeHost = $state<HTMLDivElement | null>(null)
  let article = $state<HTMLElement | null>(null)
  let instance: FileDiff<Finding[]> | null = null

  /** Svelte components mounted into the library's annotation elements, keyed by
   *  side:line so they survive the library's own re-renders. */
  const hosts = new Map<string, { el: HTMLElement; apps: ReturnType<typeof mount>[] }>()

  const findings = $derived(session.findingsFor(file.path))
  const note = $derived(session.review.notes[file.path] ?? '')
  const isReviewed = $derived(Boolean(session.reviewed[file.path]))

  // Parse result and error travel together: a derived may not write to $state.
  const parsed = $derived.by<{ file: FileDiffMetadata | null; error: string | null }>(() => {
    try {
      return { file: processPatch(file.patch).files[0] ?? null, error: null }
    } catch (cause) {
      return { file: null, error: (cause as Error).message }
    }
  })

  const annotations = $derived.by<DiffLineAnnotation<Finding[]>[]>(() => {
    const groups = new Map<string, DiffLineAnnotation<Finding[]>>()
    for (const finding of findings) {
      // A null line means "about the file as a whole"; line 0 is the library's
      // file-level slot above the first hunk.
      const lineNumber = finding.line ?? 0
      const side = lineNumber === 0 ? 'additions' : finding.side
      const key = `${side}:${lineNumber}`
      const existing = groups.get(key)
      if (existing) existing.metadata.push(finding)
      else groups.set(key, { side, lineNumber, metadata: [finding] })
    }
    return [...groups.values()]
  })

  function releaseHosts() {
    for (const { apps } of hosts.values()) for (const app of apps) unmount(app)
    hosts.clear()
  }

  function renderAnnotation(annotation: DiffLineAnnotation<Finding[]>): HTMLElement {
    const key = `${annotation.side}:${annotation.lineNumber}`
    const cached = hosts.get(key)
    if (cached) return cached.el

    const el = document.createElement('div')
    el.className = 'annotation-host'
    const apps = annotation.metadata.map((finding) =>
      mount(FindingCard, { target: el, props: { finding, session } }),
    )
    hosts.set(key, { el, apps })
    return el
  }

  // Only the container and the parsed diff should force a rebuild. Style and
  // annotations are read untracked here and applied by the effects below, so a
  // dismissed finding patches the instance instead of recreating it.
  $effect(() => {
    const fileDiff = parsed.file
    if (!codeHost || !fileDiff) return

    instance = new FileDiff<Finding[]>({
      diffStyle: untrack(() => diffStyle),
      themeType: 'dark',
      disableFileHeader: true,
      overflow: 'scroll',
      renderAnnotation,
    })
    instance.render({ fileDiff, fileContainer: codeHost, lineAnnotations: untrack(() => annotations) })

    return () => {
      releaseHosts()
      instance?.cleanUp()
      instance = null
    }
  })

  // Dismissing a finding changes the annotation set; the mounted cards are
  // rebuilt rather than patched, since mount() props are not reactive.
  $effect(() => {
    void annotations
    if (!instance) return
    releaseHosts()
    instance.setLineAnnotations(annotations)
  })

  $effect(() => {
    if (instance) instance.setOptions({ diffStyle })
  })

  export function scrollIntoView() {
    article?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  export function revealLine(line: number) {
    instance?.revealLine(line)
  }
</script>

<article bind:this={article} class="file" class:reviewed={isReviewed} data-path={file.path}>
  <header>
    <button class="check" class:on={isReviewed} onclick={() => session.toggleReviewed(file.path)} title="Mark reviewed (r)">
      {isReviewed ? '✓' : ''}
    </button>

    <span class="path mono">
      {#if file.prevPath}<span class="prev">{file.prevPath} →</span>{/if}{file.path}
    </span>

    <span class="chip status status-{file.status}">{file.status}</span>
    <span class="counts mono">
      <span class="add">+{file.additions}</span><span class="del">−{file.deletions}</span>
    </span>
  </header>

  {#if note}
    <p class="note">{note}</p>
  {/if}

  {#if file.status === 'binary'}
    <p class="empty">Binary file — no diff to show.</p>
  {:else if parsed.error}
    <p class="empty">Could not parse this file's diff: {parsed.error}</p>
  {:else if !parsed.file}
    <p class="empty">No renderable hunks in this file's diff.</p>
  {:else}
    <div class="code" bind:this={codeHost}></div>
  {/if}
</article>

<style>
  .file {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-raised);
    margin-bottom: 14px;
    overflow: hidden;
  }

  .file.reviewed {
    opacity: 0.55;
  }

  .file.reviewed:hover {
    opacity: 1;
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    background: var(--bg-inset);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 2;
  }

  .check {
    width: 16px;
    height: 16px;
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    font-size: 11px;
    line-height: 1;
    color: var(--bg);
    flex: 0 0 auto;
  }

  .check.on {
    background: var(--ok);
    border-color: var(--ok);
  }

  .path {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .prev {
    color: var(--text-faint);
  }

  .status {
    flex: 0 0 auto;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .status-added {
    color: var(--ok);
  }
  .status-deleted {
    color: var(--sev-bug);
  }

  .counts {
    margin-left: auto;
    font-size: 11px;
    display: flex;
    gap: 6px;
    flex: 0 0 auto;
  }

  .add {
    color: var(--ok);
  }
  .del {
    color: var(--sev-bug);
  }

  .note {
    margin: 0;
    padding: 8px 11px;
    color: var(--text-muted);
    font-size: 12px;
    line-height: 1.5;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--accent-dim) 18%, transparent);
  }

  .empty {
    margin: 0;
    padding: 14px;
    color: var(--text-faint);
    font-size: 12px;
  }

  .code {
    font-size: 12px;
  }

  .code :global(.annotation-host) {
    padding: 2px 10px 8px;
    background: var(--bg-inset);
  }
</style>
