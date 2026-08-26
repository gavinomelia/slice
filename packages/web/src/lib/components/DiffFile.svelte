<script lang="ts">
  import { FileDiff, processPatch } from "@pierre/diffs";
  import type {
    DiffLineAnnotation,
    FileDiffMetadata,
    SelectedLineRange,
  } from "@pierre/diffs";
  import { mount, unmount, untrack } from "svelte";
  import FindingCard from "./FindingCard.svelte";
  import LineCommentComposer from "./LineCommentComposer.svelte";
  import type { AnnotationSide, Finding, PatchFile } from "$lib/types";
  import type { ReviewSession } from "$lib/state.svelte";
  import { diffAppearanceOptions } from "$lib/viewerAppearance";
  import type { ViewerAppearance } from "$lib/viewerAppearance";

  let {
    file,
    session,
    appearance,
    diffStyle = "split",
  }: {
    file: PatchFile;
    session: ReviewSession;
    appearance: ViewerAppearance;
    diffStyle?: "split" | "unified";
  } = $props();

  let codeHost = $state<HTMLElement | null>(null);
  let article = $state<HTMLElement | null>(null);
  type LineAnchor = { line: number; side: AnnotationSide };
  type AnnotationMetadata = { findings: Finding[]; composer: boolean };

  let instance: FileDiff<AnnotationMetadata> | null = null;
  let commentAnchor = $state<LineAnchor | null>(null);

  /** Svelte components mounted into the library's annotation elements, keyed by
   *  side:line so they survive the library's own re-renders. */
  const hosts = new Map<
    string,
    { el: HTMLElement; apps: ReturnType<typeof mount>[] }
  >();

  const findings = $derived(session.findingsFor(file.path));
  const note = $derived(session.review.notes[file.path] ?? "");
  const isReviewed = $derived(Boolean(session.reviewed[file.path]));
  const isActive = $derived(session.activePath === file.path);

  // Parse result and error travel together: a derived may not write to $state.
  const parsed = $derived.by<{
    file: FileDiffMetadata | null;
    error: string | null;
  }>(() => {
    try {
      return { file: processPatch(file.patch).files[0] ?? null, error: null };
    } catch (cause) {
      return { file: null, error: (cause as Error).message };
    }
  });

  const annotations = $derived.by<DiffLineAnnotation<AnnotationMetadata>[]>(() => {
    const groups = new Map<string, DiffLineAnnotation<AnnotationMetadata>>();
    for (const finding of findings) {
      // A null line means "about the file as a whole"; line 0 is the library's
      // file-level slot above the first hunk.
      const lineNumber = finding.line ?? 0;
      const side = lineNumber === 0 ? "additions" : finding.side;
      const key = `${side}:${lineNumber}`;
      const existing = groups.get(key);
      if (existing) existing.metadata.findings.push(finding);
      else groups.set(key, { side, lineNumber, metadata: { findings: [finding], composer: false } });
    }
    if (commentAnchor) {
      const key = `${commentAnchor.side}:${commentAnchor.line}`;
      const existing = groups.get(key);
      if (existing) existing.metadata.composer = true;
      else {
        groups.set(key, {
          side: commentAnchor.side,
          lineNumber: commentAnchor.line,
          metadata: { findings: [], composer: true },
        });
      }
    }
    return [...groups.values()];
  });

  function releaseHosts() {
    for (const { apps } of hosts.values()) for (const app of apps) unmount(app);
    hosts.clear();
  }

  function renderAnnotation(
    annotation: DiffLineAnnotation<AnnotationMetadata>,
  ): HTMLElement {
    const key = `${annotation.side}:${annotation.lineNumber}`;
    const cached = hosts.get(key);
    if (cached) return cached.el;

    const el = document.createElement("div");
    el.className = "annotation-host";
    const apps = annotation.metadata.findings.map((finding) =>
      mount(FindingCard, { target: el, props: { finding, session } }),
    );
    if (annotation.metadata.composer) {
      apps.push(
        mount(LineCommentComposer, {
          target: el,
          props: {
            path: file.path,
            line: annotation.lineNumber,
            side: annotation.side,
            session,
            onClose: closeComment,
          },
        }),
      );
    }
    hosts.set(key, { el, apps });
    return el;
  }

  function openComment(range: SelectedLineRange) {
    commentAnchor = {
      line: range.end,
      side: range.endSide ?? range.side ?? "additions",
    };
    session.selectPath(file.path);
  }

  function closeComment() {
    commentAnchor = null;
    instance?.setSelectedLines(null);
  }

  function toggleReviewed() {
    if (!isReviewed) closeComment();
    session.toggleReviewed(file.path);
  }

  // Only the container and parsed diff force a rebuild. Appearance, layout,
  // and annotations patch the mounted renderer through its supported APIs.
  $effect(() => {
    const fileDiff = parsed.file;
    if (!codeHost || !fileDiff) return;

    instance = new FileDiff<AnnotationMetadata>({
      ...untrack(() => diffAppearanceOptions<AnnotationMetadata>(appearance)),
      diffStyle: untrack(() => diffStyle),
      enableGutterUtility: true,
      lineHoverHighlight: "number",
      onGutterUtilityClick: openComment,
      renderAnnotation,
    });
    instance.render({
      fileDiff,
      fileContainer: codeHost,
      lineAnnotations: untrack(() => annotations),
    });

    return () => {
      releaseHosts();
      instance?.cleanUp();
      instance = null;
    };
  });

  // Dismissing a finding changes the annotation set; the mounted cards are
  // rebuilt rather than patched, since mount() props are not reactive.
  $effect(() => {
    void annotations;
    if (!instance) return;
    releaseHosts();
    instance.setLineAnnotations(annotations);
    instance.rerender();
  });

  $effect(() => {
    const nextDiffStyle = diffStyle;
    const nextAppearance = diffAppearanceOptions<AnnotationMetadata>(appearance);
    if (!instance) return;
    instance.setOptions({ ...instance.options, ...nextAppearance, diffStyle: nextDiffStyle });
    instance.rerender();
  });

  $effect(() => {
    const anchor = commentAnchor;
    if (!instance) return;
    instance.setSelectedLines(
      anchor ? { start: anchor.line, end: anchor.line, side: anchor.side } : null,
      { activeLineSide: anchor?.side, lineNumberOnly: true },
    );
  });

  export function scrollIntoView() {
    article?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  export function revealLine(line: number) {
    instance?.revealLine(line);
  }
</script>

<article
  bind:this={article}
  class="file"
  class:reviewed={isReviewed}
  class:active={isActive}
  data-path={file.path}
>
  <header>
    <button
      class="check"
      class:on={isReviewed}
      onclick={toggleReviewed}
      aria-label={isReviewed
        ? "Mark file as not reviewed and expand"
        : "Mark file as reviewed and collapse"}
      aria-pressed={isReviewed}
      aria-expanded={!isReviewed}
      title={isReviewed
        ? "Mark as not reviewed and expand (r)"
        : "Mark reviewed and collapse (r)"}
    >
      {isReviewed ? "✓" : ""}
    </button>

    <span class="path mono">
      {#if file.prevPath}<span class="prev">{file.prevPath} →</span
        >{/if}{file.path}
    </span>

    {#if isReviewed}<span class="reviewed-label">Reviewed</span>{/if}
    <span class="chip status status-{file.status}">{file.status}</span>
    <span class="counts mono">
      <span class="add">+{file.additions}</span><span class="del"
        >−{file.deletions}</span
      >
    </span>
  </header>

  {#if !isReviewed}
    {#if note}
      <p class="note">{note}</p>
    {/if}

    {#if file.status === "binary"}
      <p class="empty">Binary file — no diff to show.</p>
    {:else if parsed.error}
      <p class="empty">Could not parse this file's diff: {parsed.error}</p>
    {:else if !parsed.file}
      <p class="empty">No renderable hunks in this file's diff.</p>
    {:else}
      <diffs-container class="code" bind:this={codeHost}></diffs-container>
    {/if}
  {/if}
</article>

<style>
  .file {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-raised);
    margin-bottom: 14px;
    overflow: hidden;
    transition: border-color 0.15s ease, background-color 0.15s ease;
  }

  .file.active {
    border-color: var(--border-strong);
  }

  .file.reviewed {
    background: var(--bg-inset);
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 38px;
    padding: 8px 10px;
    background: var(--bg-inset);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 2;
  }

  .file.reviewed header {
    border-bottom: 0;
  }

  .check {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    font-size: 11px;
    line-height: 1;
    color: #07110a;
    flex: 0 0 auto;
    transition: border-color 0.15s ease, background-color 0.15s ease;
  }

  .check:hover {
    border-color: var(--text-muted);
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

  .reviewed-label {
    color: var(--ok);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
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

  .code :global(.annotation-host) {
    padding: 2px 10px 8px;
    background: var(--bg-inset);
  }
</style>
