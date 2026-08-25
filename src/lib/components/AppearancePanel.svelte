<script lang="ts">
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import X from "@lucide/svelte/icons/x";
  import type { ViewerAppearance } from "$lib/viewerAppearance";

  let {
    appearance,
    onChange,
    onReset,
    onClose,
  }: {
    appearance: ViewerAppearance;
    onChange: (patch: Partial<ViewerAppearance>) => void;
    onReset: () => void;
    onClose: () => void;
  } = $props();

  function value(event: Event) {
    return (event.currentTarget as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
  }
</script>

<aside class="appearance" aria-labelledby="appearance-title">
  <header>
    <div>
      <h2 id="appearance-title">Appearance</h2>
      <p>Changes apply immediately and stay on this browser.</p>
    </div>
    <button class="close" aria-label="Close appearance settings" title="Close" onclick={onClose}>
      <X size={16} strokeWidth={1.8} />
    </button>
  </header>

  <div class="settings scroll">
    <section>
      <h3>Diff</h3>
      <div class="fields two-col">
        <label>
          <span>Theme</span>
          <select value={appearance.diffTheme} onchange={(event) => onChange({ diffTheme: value(event) as ViewerAppearance["diffTheme"] })}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </label>
        <label>
          <span>Overflow</span>
          <select value={appearance.diffOverflow} onchange={(event) => onChange({ diffOverflow: value(event) as ViewerAppearance["diffOverflow"] })}>
            <option value="scroll">Scroll</option>
            <option value="wrap">Wrap</option>
          </select>
        </label>
        <label>
          <span>Indicators</span>
          <select value={appearance.diffIndicators} onchange={(event) => onChange({ diffIndicators: value(event) as ViewerAppearance["diffIndicators"] })}>
            <option value="classic">Classic</option>
            <option value="bars">Bars</option>
            <option value="none">None</option>
          </select>
        </label>
        <label>
          <span>Word highlighting</span>
          <select value={appearance.diffLineHighlight} onchange={(event) => onChange({ diffLineHighlight: value(event) as ViewerAppearance["diffLineHighlight"] })}>
            <option value="word-alt">Word, alternate</option>
            <option value="word">Word</option>
            <option value="char">Character</option>
            <option value="none">None</option>
          </select>
        </label>
      </div>

      <label>
        <span>Hunk separators</span>
        <select value={appearance.diffHunkSeparators} onchange={(event) => onChange({ diffHunkSeparators: value(event) as ViewerAppearance["diffHunkSeparators"] })}>
          <option value="line-info">Line information</option>
          <option value="line-info-basic">Basic line information</option>
          <option value="metadata">Metadata</option>
          <option value="simple">Simple</option>
        </select>
      </label>

      <label class="range">
        <span>Font size <output>{appearance.diffFontSize}px</output></span>
        <input type="range" min="10" max="18" step="1" value={appearance.diffFontSize} oninput={(event) => onChange({ diffFontSize: Number(value(event)) })} />
      </label>

      <div class="checks">
        <label><input type="checkbox" checked={appearance.diffLineNumbers} onchange={(event) => onChange({ diffLineNumbers: event.currentTarget.checked })} /> Line numbers</label>
        <label><input type="checkbox" checked={appearance.diffBackground} onchange={(event) => onChange({ diffBackground: event.currentTarget.checked })} /> Background colors</label>
      </div>
    </section>

    <section>
      <h3>File tree</h3>
      <div class="fields two-col">
        <label>
          <span>Density</span>
          <select value={appearance.treeDensity} onchange={(event) => onChange({ treeDensity: value(event) as ViewerAppearance["treeDensity"] })}>
            <option value="compact">Compact</option>
            <option value="default">Default</option>
            <option value="relaxed">Relaxed</option>
          </select>
        </label>
        <label class="range compact-range">
          <span>Font size <output>{appearance.treeFontSize}px</output></span>
          <input type="range" min="10" max="18" step="1" value={appearance.treeFontSize} oninput={(event) => onChange({ treeFontSize: Number(value(event)) })} />
        </label>
      </div>

      <div class="colors">
        <label><input type="color" value={appearance.treeForeground} oninput={(event) => onChange({ treeForeground: value(event) })} /><span>Text</span></label>
        <label><input type="color" value={appearance.treeAccent} oninput={(event) => onChange({ treeAccent: value(event) })} /><span>Accent</span></label>
        <label><input type="color" value={appearance.treeSelection} oninput={(event) => onChange({ treeSelection: value(event) })} /><span>Selection</span></label>
        <label><input type="color" value={appearance.treeBorder} oninput={(event) => onChange({ treeBorder: value(event) })} /><span>Border</span></label>
      </div>
    </section>

    <section>
      <details>
        <summary>Advanced CSS</summary>
        <p>Injected inside each library's shadow root. Changes apply as you type.</p>
        <label>
          <span>Diff CSS</span>
          <textarea spellcheck="false" rows="8" value={appearance.diffCSS} oninput={(event) => onChange({ diffCSS: value(event) })} placeholder="Enter diff CSS"></textarea>
        </label>
        <label>
          <span>Tree CSS</span>
          <textarea spellcheck="false" rows="8" value={appearance.treeCSS} oninput={(event) => onChange({ treeCSS: value(event) })} placeholder="Enter tree CSS"></textarea>
        </label>
      </details>
    </section>
  </div>

  <footer>
    <button class="reset" onclick={onReset}><RotateCcw size={14} strokeWidth={1.8} /> Reset defaults</button>
    <button class="done" onclick={onClose}>Done</button>
  </footer>
</aside>

<style>
  .appearance {
    position: fixed;
    top: var(--header-h);
    right: 0;
    bottom: 0;
    z-index: 30;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    width: min(420px, 100vw);
    border-left: 1px solid var(--border-strong);
    background: var(--bg-raised);
    box-shadow: -14px 0 40px rgb(0 0 0 / 35%);
  }

  header,
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
  }

  header {
    border-bottom: 1px solid var(--border);
  }

  footer {
    border-top: 1px solid var(--border);
  }

  h2 {
    margin: 0;
    font-size: 14px;
  }

  header p,
  details p {
    margin: 3px 0 0;
    color: var(--text-faint);
    font-size: 11px;
  }

  .close {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 4px;
    color: var(--text-muted);
  }

  .close:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .settings {
    padding: 0 14px 32px;
  }

  section {
    padding: 16px 0;
    border-bottom: 1px solid var(--border);
  }

  section:last-child {
    border-bottom: 0;
  }

  h3 {
    margin: 0 0 11px;
    color: var(--text-faint);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .fields {
    display: grid;
    gap: 10px;
    margin-bottom: 10px;
  }

  .two-col {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  label > span,
  .range > span {
    display: flex;
    justify-content: space-between;
    margin-bottom: 5px;
    color: var(--text-muted);
    font-size: 11px;
  }

  select,
  textarea {
    width: 100%;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    background: var(--bg-inset);
    color: var(--text);
    font: inherit;
  }

  select {
    height: 30px;
    padding: 0 7px;
    font-size: 11.5px;
  }

  textarea {
    margin-bottom: 10px;
    padding: 8px;
    resize: vertical;
    font: 11px/1.45 var(--mono);
  }

  .range {
    display: block;
    margin-top: 10px;
  }

  .range output {
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  input[type="range"] {
    width: 100%;
    accent-color: var(--accent);
  }

  .compact-range {
    margin-top: 0;
  }

  .checks {
    display: flex;
    gap: 18px;
    margin-top: 12px;
  }

  .checks label {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-muted);
    font-size: 11.5px;
  }

  input[type="checkbox"] {
    accent-color: var(--accent);
  }

  .colors {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    margin-top: 12px;
  }

  .colors label {
    display: grid;
    justify-items: center;
    gap: 4px;
    color: var(--text-faint);
    font-size: 10px;
  }

  input[type="color"] {
    width: 100%;
    height: 30px;
    padding: 2px;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    background: var(--bg-inset);
  }

  summary {
    cursor: pointer;
    color: var(--text-muted);
    font-size: 11.5px;
  }

  details p {
    margin-bottom: 12px;
  }

  footer button {
    min-height: 30px;
    padding: 5px 10px;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    color: var(--text-muted);
    font-size: 11.5px;
  }

  footer .reset {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  footer button:hover {
    border-color: var(--text-faint);
    color: var(--text);
  }

  footer .done {
    border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
    background: var(--accent-dim);
    color: var(--text);
  }

  @media (max-width: 480px) {
    .two-col {
      grid-template-columns: 1fr;
    }
  }
</style>
