/**
 * Fuzzy subsequence matching for the finder. Characters of the query must
 * appear in order somewhere in the text (like fzf / Telescope); the score
 * rewards matches at word boundaries, camel-case humps, and consecutive runs,
 * and penalizes how deep into the string the match starts. Returns `null` when
 * the query is not an ordered subsequence.
 */
export interface FuzzyMatch {
  readonly score: number
  /** Character indices in the original text that matched the query. */
  readonly positions: ReadonlyArray<number>
}

export const fuzzyMatch = (query: string, text: string): FuzzyMatch | null => {
  const needle = query.trim().toLowerCase()
  if (!needle) return { score: 0, positions: [] }
  const source = text.toLowerCase()

  let qi = 0
  let streak = 0
  let last = -2
  let score = 0
  const positions: number[] = []

  for (let i = 0; i < source.length && qi < needle.length; i++) {
    if (source[i] !== needle[qi]) continue
    qi++
    positions.push(i)
    const before = text[i - 1] ?? ""
    const after = text[i + 1] ?? ""
    const char = text[i] ?? ""
    const wordBoundary = i === 0 || /[\s._\-/]/.test(before)
    const camelHump = /[a-z]/.test(before) && /[A-Z]/.test(char)
    if (wordBoundary) score += 8
    if (camelHump) score += 6
    streak = i === last + 1 ? streak + 1 : 1
    score += streak + (after ? 1 : 3)
    last = i
  }

  if (qi < needle.length) return null
  /* Prefer matches that start earlier and stay compact. */
  score -= positions[0]!
  return { score, positions }
}

/** Split a string into matched/unmatched segments for accent-tinted display. */
export const splitByPositions = (
  text: string,
  positions: ReadonlyArray<number>
): ReadonlyArray<{ readonly text: string; readonly matched: boolean }> => {
  const matched = new Set(positions)
  const parts: Array<{ text: string; matched: boolean }> = []
  let current = ""
  let currentMatched = matched.has(0)
  for (let i = 0; i < text.length; i++) {
    const isMatched = matched.has(i)
    if (i > 0 && isMatched !== currentMatched) {
      if (current) parts.push({ text: current, matched: currentMatched })
      current = ""
      currentMatched = isMatched
    }
    current += text[i]
  }
  if (current) parts.push({ text: current, matched: currentMatched })
  return parts
}