import type { DraftComment, Finding, Review, Severity } from './types'
import { SEVERITY_ORDER } from './types'

interface Persisted {
  reviewed: Record<string, boolean>
  dismissed: Record<string, boolean>
  drafts: DraftComment[]
}

const EMPTY: Persisted = { reviewed: {}, dismissed: {}, drafts: [] }

/**
 * Review session state. Progress, dismissals, and comment drafts persist to
 * localStorage per review, so closing the tab mid-review doesn't lose the
 * reviewer's place.
 */
export class ReviewSession {
  review: Review
  storageKey: string

  reviewed = $state<Record<string, boolean>>({})
  dismissed = $state<Record<string, boolean>>({})
  drafts = $state<DraftComment[]>([])

  activeSliceId = $state<string>('')
  activePath = $state<string>('')
  activeFindingId = $state<string | null>(null)
  panel = $state<'analysis' | 'findings' | 'comments'>('analysis')
  severityFilter = $state<Record<Severity, boolean>>({
    bug: true,
    risk: true,
    cleanup: true,
    nit: true,
    question: true,
  })
  hideReviewed = $state(false)

  constructor(review: Review) {
    this.review = review
    this.storageKey = `pr-review:${review.target.repo}:${review.target.number ?? review.target.headRef}`
    this.activeSliceId = review.slices[0]?.id ?? ''
    this.activePath = review.slices[0]?.paths[0] ?? ''
    this.restore()
  }

  private restore() {
    if (typeof localStorage === 'undefined') return
    try {
      const saved: Persisted = { ...EMPTY, ...JSON.parse(localStorage.getItem(this.storageKey) ?? '{}') }
      this.reviewed = saved.reviewed ?? {}
      this.dismissed = saved.dismissed ?? {}
      this.drafts = saved.drafts ?? []
    } catch {
      // A corrupt entry shouldn't block the review; start clean.
    }
  }

  persist() {
    if (typeof localStorage === 'undefined') return
    const payload: Persisted = { reviewed: this.reviewed, dismissed: this.dismissed, drafts: this.drafts }
    localStorage.setItem(this.storageKey, JSON.stringify(payload))
  }

  // ---- slices and files ----

  get activeSlice() {
    return this.review.slices.find((s) => s.id === this.activeSliceId) ?? this.review.slices[0]
  }

  /** Paths in the active slice, honoring the hide-reviewed toggle. */
  get visiblePaths(): string[] {
    const paths = this.activeSlice?.paths ?? []
    return this.hideReviewed ? paths.filter((p) => !this.reviewed[p]) : paths
  }

  sliceOf(path: string) {
    return this.review.slices.find((s) => s.paths.includes(path))
  }

  selectSlice(id: string) {
    if (this.activeSliceId === id) return
    this.activeSliceId = id
    this.activePath = this.review.slices.find((s) => s.id === id)?.paths[0] ?? ''
  }

  selectPath(path: string) {
    const slice = this.sliceOf(path)
    if (slice) this.activeSliceId = slice.id
    this.activePath = path
  }

  // ---- progress ----

  toggleReviewed(path: string) {
    this.reviewed = { ...this.reviewed, [path]: !this.reviewed[path] }
    this.persist()
  }

  sliceProgress(sliceId: string) {
    const slice = this.review.slices.find((s) => s.id === sliceId)
    if (!slice) return { done: 0, total: 0 }
    return { done: slice.paths.filter((p) => this.reviewed[p]).length, total: slice.paths.length }
  }

  get overallProgress() {
    const total = Object.keys(this.review.files).length
    const done = Object.keys(this.review.files).filter((p) => this.reviewed[p]).length
    return { done, total }
  }

  // ---- findings ----

  findingsFor(path: string): Finding[] {
    return this.review.findings.filter((f) => f.path === path && !this.dismissed[f.id])
  }

  /** Every finding still in play, ordered by severity then by slice reading order. */
  get liveFindings(): Finding[] {
    const sliceRank = new Map(this.review.slices.flatMap((s, i) => s.paths.map((p) => [p, i * 1000])))
    return this.review.findings
      .filter((f) => !this.dismissed[f.id] && this.severityFilter[f.severity])
      .sort((a, b) => {
        const severity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
        if (severity !== 0) return severity
        return (sliceRank.get(a.path) ?? 0) - (sliceRank.get(b.path) ?? 0)
      })
  }

  countsBySeverity(paths?: string[]): Record<Severity, number> {
    const scope = paths ? new Set(paths) : null
    const counts = { bug: 0, risk: 0, cleanup: 0, nit: 0, question: 0 }
    for (const finding of this.review.findings) {
      if (this.dismissed[finding.id]) continue
      if (scope && !scope.has(finding.path)) continue
      counts[finding.severity]++
    }
    return counts
  }

  dismiss(id: string) {
    this.dismissed = { ...this.dismissed, [id]: true }
    this.persist()
  }

  restoreFinding(id: string) {
    const next = { ...this.dismissed }
    delete next[id]
    this.dismissed = next
    this.persist()
  }

  focusFinding(finding: Finding) {
    this.selectPath(finding.path)
    this.activeFindingId = finding.id
  }

  // ---- comment drafts ----

  draftFor(findingId: string) {
    return this.drafts.find((d) => d.findingId === findingId)
  }

  addDraft(draft: Omit<DraftComment, 'id'>) {
    const id = `d${this.drafts.length + 1}-${Date.now()}`
    this.drafts = [...this.drafts, { ...draft, id }]
    this.persist()
    return id
  }

  /** Seed a draft from a finding, so the reviewer edits rather than retypes. */
  draftFromFinding(finding: Finding) {
    const existing = this.draftFor(finding.id)
    if (existing) return existing.id
    const body = [`**${finding.title}**`, '', finding.why, finding.fix ? `\n${finding.fix}` : '']
      .filter(Boolean)
      .join('\n')
    return this.addDraft({
      path: finding.path,
      line: finding.line ?? 0,
      side: finding.side,
      body,
      findingId: finding.id,
    })
  }

  updateDraft(id: string, body: string) {
    this.drafts = this.drafts.map((d) => (d.id === id ? { ...d, body } : d))
    this.persist()
  }

  removeDraft(id: string) {
    this.drafts = this.drafts.filter((d) => d.id !== id)
    this.persist()
  }

  /** Drafts anchored to a real line can be posted as GitHub line comments;
   *  the rest have to ride along in the review body. */
  get postableDrafts() {
    return this.drafts.filter((d) => d.line > 0)
  }

  get bodyOnlyDrafts() {
    return this.drafts.filter((d) => d.line <= 0)
  }
}
