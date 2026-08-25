<script lang="ts">
  import { onMount } from "svelte";
  import type { ReviewSession } from "$lib/state.svelte";
  import type { AnnotationSide } from "$lib/types";

  let {
    path,
    line,
    side,
    session,
    onClose,
  }: {
    path: string;
    line: number;
    side: AnnotationSide;
    session: ReviewSession;
    onClose: () => void;
  } = $props();

  let body = $state("");
  let textarea = $state<HTMLTextAreaElement | null>(null);

  onMount(() => textarea?.focus());

  function submit() {
    const comment = body.trim();
    if (!comment) return;
    session.addDraft({ path, line, side, body: comment, findingId: null });
    onClose();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  }
</script>

<form
  class="composer"
  onsubmit={(event) => {
    event.preventDefault();
    submit();
  }}
>
  <label for="line-comment-{line}">
    Comment on {side === "deletions" ? "old" : "new"} line {line}
  </label>
  <textarea
    id="line-comment-{line}"
    bind:this={textarea}
    bind:value={body}
    onkeydown={onKeydown}
    rows="3"
    placeholder="Add a review comment"
  ></textarea>
  <div class="actions">
    <button type="button" onclick={onClose}>Cancel</button>
    <button class="primary" type="submit" disabled={!body.trim()}>Add comment</button>
  </div>
</form>

<style>
  .composer {
    padding: 10px 12px;
    border-left: 2px solid var(--accent);
    background: var(--bg-raised);
  }

  label {
    display: block;
    margin-bottom: 6px;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 600;
  }

  textarea {
    display: block;
    width: 100%;
    resize: vertical;
    padding: 8px 9px;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    background: var(--bg-inset);
    color: var(--text);
    font: 12px/1.5 var(--sans);
  }

  textarea:focus-visible {
    border-color: var(--accent);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 7px;
  }

  button {
    min-height: 28px;
    padding: 4px 9px;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    color: var(--text-muted);
    font-size: 11px;
  }

  button:hover:not(:disabled) {
    border-color: var(--text-faint);
    color: var(--text);
  }

  button.primary {
    border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
    background: var(--accent-dim);
    color: var(--text);
  }

  button:disabled {
    opacity: 0.45;
  }
</style>
