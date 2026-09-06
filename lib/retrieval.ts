import { fromMarkdown } from "mdast-util-from-markdown"
import type { RootContent } from "mdast"
import { headingId } from "./content"

export const SEARCH_CANDIDATES = 80
export const MAX_SEARCH_CHUNKS = 256
export const INDEX_VERSION = 3

export function keywordTerms(query: string) {
  const stopwords = new Set(
    "a an and are as at be before by can could did do does for from had has have how i in into is it me of on or should that the their there these they this to was were what when where which who why will with would you your".split(
      " "
    )
  )
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])]
    .filter((term) => !stopwords.has(term))
    .slice(0, 12)
}

export type PassageRange = {
  start: number
  end: number
  heading: string | null
  section: string | null
}

function headingText(node: RootContent): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value
  return "children" in node ? node.children.map(headingText).join("") : ""
}

/** Exact UTF-16 body offsets; overlapping windows retain claims at boundaries. */
export function chunkMarkdown(body: string): PassageRange[] {
  const blocks = fromMarkdown(body).children
  const headings = blocks.flatMap((node) =>
    node.type === "heading"
      ? [
          {
            start: node.position!.start.offset!,
            depth: node.depth,
            text: headingText(node),
          },
        ]
      : []
  )
  const boundaries = blocks.map((node) => node.position!.end.offset!)
  const chunks: PassageRange[] = []
  let start = 0
  while (start < body.length) {
    const maximum = Math.min(start + 1200, body.length)
    let end = maximum
    if (maximum < body.length) {
      const nextHeading = headings.find(
        (h) => h.start >= start + 600 && h.start <= maximum
      )
      const boundary = boundaries
        .filter((n) => n >= start + 600 && n <= maximum)
        .at(-1)
      end = nextHeading?.start ?? boundary ?? maximum
      if (end === maximum) {
        const whitespace = body.slice(start + 600, maximum).search(/\s+\S*$/)
        if (whitespace >= 0) end = start + 600 + whitespace
      }
    }
    const path: typeof headings = []
    for (const heading of headings) {
      if (heading.start > start) break
      while (path.length && path.at(-1)!.depth >= heading.depth) path.pop()
      path.push(heading)
    }
    chunks.push({
      start,
      end,
      heading: path.map((h) => h.text).join(" > ") || null,
      section: path.length ? headingId(path.at(-1)!.text) : null,
    })
    if (end === body.length) break
    // A new section is already a clean boundary. Long sections get overlap.
    start = headings.some((h) => h.start === end) ? end : end - 120
  }
  return chunks
}

/** Search small passages, then return neighboring evidence from the same section. */
export function contextWindow(body: string) {
  const headings = [
    0,
    ...fromMarkdown(body).children.flatMap((node) =>
      node.type === "heading" ? [node.position!.start.offset!] : []
    ),
    body.length,
  ]
  return (start: number, end: number) => {
    const sectionStart = headings.findLast((offset) => offset <= start) ?? 0
    const sectionEnd = headings.find((offset) => offset >= end) ?? body.length
    const maximum = Math.max(2800, end - start)
    const expandedStart = Math.max(
      sectionStart,
      Math.min(
        start - Math.floor((maximum - (end - start)) / 2),
        sectionEnd - maximum
      )
    )
    return {
      start: expandedStart,
      end: Math.min(sectionEnd, expandedStart + maximum),
    }
  }
}

/** Keep the answer-bearing region even for legacy 6,000-character chunks. */
export function excerptRange(text: string, queries: string[], maximum: number) {
  if (text.length <= maximum) return { start: 0, end: text.length }
  const terms = [...new Set(queries.flatMap(keywordTerms))]
  const lower = text.toLowerCase()
  let best = 0,
    bestScore = -1
  const starts = new Set([0])
  for (const term of terms) {
    let offset = lower.indexOf(term),
      count = 0
    while (offset >= 0 && count++ < 30) {
      starts.add(
        Math.max(
          0,
          Math.min(text.length - maximum, offset - Math.floor(maximum / 3))
        )
      )
      offset = lower.indexOf(term, offset + term.length)
    }
  }
  for (const start of starts) {
    const window = lower.slice(start, start + maximum)
    const score = terms.reduce(
      (sum, term) => sum + (window.includes(term) ? 1 : 0),
      0
    )
    if (score > bestScore) {
      best = start
      bestScore = score
    }
  }
  return { start: best, end: best + maximum }
}

/** Rank passages, preserving the strongest text instead of overwriting by resource. */
export function fuseRanks<T extends { id: string }>(lists: T[][]) {
  const scores = new Map<string, { item: T; score: number }>()
  for (const list of lists) {
    const seen = new Set<string>()
    list.forEach((item, rank) => {
      if (seen.has(item.id)) return
      seen.add(item.id)
      const previous = scores.get(item.id)
      scores.set(item.id, {
        item: previous?.item ?? item,
        score: (previous?.score ?? 0) + 1 / (60 + rank + 1),
      })
    })
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ item, score }) => ({ ...item, relevance: score }))
}

/** Prefer evidence in the body over a title repeated on every indexed chunk. */
export function rankPassages<T extends { text: string }>(
  passages: T[],
  queries: string[],
  title = ""
) {
  const stem = (word: string) =>
    word.length > 4 ? word.replace(/s$/, "") : word
  const queryTerms = queries.map((query) => [
    ...new Set(keywordTerms(query).map(stem)),
  ])
  const terms = [...new Set(queryTerms.flat())]
  const titleTerms = new Set(keywordTerms(title).map(stem))
  const counts = passages.map((passage) => {
    const words = (
      passage.text
        .toLowerCase()
        .replace(/\]\([^)]*\)/g, "]")
        .match(/[\p{L}\p{N}_-]{2,}/gu) ?? []
    ).map(stem)
    return new Map(
      terms.map((term) => [term, words.filter((word) => word === term).length])
    )
  })
  const weights = new Map(
    terms.map((term) => [
      term,
      Math.log(
        1 +
          passages.length /
            (1 + counts.filter((count) => count.get(term)! > 0).length)
      ),
    ])
  )
  return passages
    .map((passage, index) => ({
      passage,
      index,
      score: Math.max(
        0,
        ...queryTerms.map((terms) => {
          const score = terms.reduce(
            (sum, term) =>
              sum + weights.get(term)! * Math.min(2, counts[index].get(term)!),
            0
          )
          const available = terms.reduce(
            (sum, term) =>
              sum +
              (counts.some((count) => count.get(term)! > 0)
                ? weights.get(term)!
                : 0),
            0
          )
          const titleAffinity =
            !titleTerms.size || terms.some((term) => titleTerms.has(term))
              ? 1
              : 0.25
          return available ? (titleAffinity * score) / available : 0
        })
      ),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ passage }) => passage)
}
