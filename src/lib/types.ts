export type Severity = 'bug' | 'risk' | 'cleanup' | 'nit' | 'question'
export type Confidence = 'confirmed' | 'suspected'
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'binary'
export type SliceKind = 'behavior' | 'skim' | 'unaccounted'
export type AnnotationSide = 'additions' | 'deletions'

export interface ReviewTarget {
  kind: 'pr' | 'branch'
  repo: string
  number: number | null
  title: string
  author: string
  url: string | null
  baseRef: string
  headRef: string
  headSha: string
  viewerIsAuthor: boolean
}

/** A parsed file from the raw patch. Produced deterministically by the CLI,
 *  never by the model — the model only ever refers to files by path. */
export interface PatchFile {
  path: string
  prevPath: string | null
  status: FileStatus
  additions: number
  deletions: number
  /** Self-contained unified diff for this one file, ready for processPatch(). */
  patch: string
}

export interface Finding {
  id: string
  severity: Severity
  confidence: Confidence
  path: string
  /** null renders the finding at file level, above the first hunk. */
  line: number | null
  endLine: number | null
  side: AnnotationSide
  title: string
  why: string
  /** Markdown; may contain a fenced code block. */
  fix: string
}

export interface Slice {
  id: string
  title: string
  kind: SliceKind
  summary: string
  /** Paths into Review.files, in the order they should be read. */
  paths: string[]
}

export interface FileNote {
  path: string
  summary: string
}

export interface Review {
  version: 1
  generatedAt: string
  target: ReviewTarget
  overview: {
    intent: string
    assessment: string
    risk: 'low' | 'medium' | 'high'
  }
  slices: Slice[]
  files: Record<string, PatchFile>
  notes: Record<string, string>
  findings: Finding[]
}

/** What the model is asked to produce. Merged with parsed patch data to
 *  form a Review. Deliberately contains no diff text. */
export interface Analysis {
  overview: Review['overview']
  slices: Slice[]
  notes: FileNote[]
  findings: Omit<Finding, 'id'>[]
}

export interface DraftComment {
  id: string
  path: string
  line: number
  side: AnnotationSide
  body: string
  /** Set when the draft was seeded from a finding. */
  findingId: string | null
}

export const SEVERITY_ORDER: Severity[] = ['bug', 'risk', 'cleanup', 'nit', 'question']

export const SEVERITY_META: Record<Severity, { label: string; glyph: string; color: string }> = {
  bug: { label: 'Bug', glyph: '●', color: 'var(--sev-bug)' },
  risk: { label: 'Risk', glyph: '◆', color: 'var(--sev-risk)' },
  cleanup: { label: 'Cleanup', glyph: '▲', color: 'var(--sev-cleanup)' },
  nit: { label: 'Nit', glyph: '▪', color: 'var(--sev-nit)' },
  question: { label: 'Question', glyph: '?', color: 'var(--sev-question)' },
}
