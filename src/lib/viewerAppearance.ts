import type { FileDiffOptions } from '@pierre/diffs'
import type { FileTreeDensity, FileTreeOptions } from '@pierre/trees'

export interface ViewerAppearance {
  diffTheme: 'system' | 'light' | 'dark'
  diffOverflow: 'scroll' | 'wrap'
  diffIndicators: 'classic' | 'bars' | 'none'
  diffHunkSeparators: 'simple' | 'metadata' | 'line-info' | 'line-info-basic'
  diffLineHighlight: 'word-alt' | 'word' | 'char' | 'none'
  diffLineNumbers: boolean
  diffBackground: boolean
  diffFontSize: number
  diffCSS: string
  treeDensity: FileTreeDensity
  treeFontSize: number
  treeWidth: number
  treeForeground: string
  treeAccent: string
  treeSelection: string
  treeBorder: string
  treeCSS: string
}

export const DEFAULT_VIEWER_APPEARANCE: ViewerAppearance = {
  diffTheme: 'dark',
  diffOverflow: 'scroll',
  diffIndicators: 'classic',
  diffHunkSeparators: 'line-info',
  diffLineHighlight: 'word-alt',
  diffLineNumbers: true,
  diffBackground: true,
  diffFontSize: 12,
  diffCSS: '',
  treeDensity: 'compact',
  treeFontSize: 12,
  treeWidth: 270,
  treeForeground: '#9aa4b2',
  treeAccent: '#5b9dff',
  treeSelection: '#1d2127',
  treeBorder: '#262b33',
  treeCSS: '',
}

const STORAGE_KEY = 'pr-review:appearance'

export function loadViewerAppearance(): ViewerAppearance {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_VIEWER_APPEARANCE }
  try {
    return { ...DEFAULT_VIEWER_APPEARANCE, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') }
  } catch {
    return { ...DEFAULT_VIEWER_APPEARANCE }
  }
}

export function saveViewerAppearance(appearance: ViewerAppearance) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance))
}

export function diffAppearanceOptions<T = unknown>(appearance: ViewerAppearance): Partial<FileDiffOptions<T>> {
  return {
    themeType: appearance.diffTheme,
    disableFileHeader: true,
    overflow: appearance.diffOverflow,
    diffIndicators: appearance.diffIndicators,
    hunkSeparators: appearance.diffHunkSeparators,
    lineDiffType: appearance.diffLineHighlight,
    disableLineNumbers: !appearance.diffLineNumbers,
    disableBackground: !appearance.diffBackground,
    unsafeCSS: String.raw`
    :host {
      --diffs-font-family: var(--mono);
      --diffs-font-size: ${appearance.diffFontSize}px;
    }
    ${appearance.diffCSS}
  `,
  }
}

export function treeAppearanceOptions(appearance: ViewerAppearance): Partial<FileTreeOptions> {
  return {
    density: appearance.treeDensity,
    unsafeCSS: String.raw`
    :host {
      --trees-font-size: ${appearance.treeFontSize}px;
      --trees-accent-override: ${appearance.treeAccent};
      --trees-fg-override: ${appearance.treeForeground};
      --trees-selected-bg-override: ${appearance.treeSelection};
      --trees-border-color-override: ${appearance.treeBorder};
    }
    ${appearance.treeCSS}
  `,
  }
}
