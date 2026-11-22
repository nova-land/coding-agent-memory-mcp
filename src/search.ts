import type { Memory, SearchResult, IndexEntry } from './types.js';
import { tokenize } from './util.js';

export interface SearchOptions {
  /** Only include memories that carry every one of these tags. */
  tags?: string[];
  /** Max results to return. */
  limit?: number;
}

/**
 * Score and rank memories against a free-text query.
 *
 * Scoring is intentionally simple and explainable (no external search engine):
 *  - whole-token title match ....... 6
 *  - title substring ............... 3
 *  - exact tag match ............... 5
 *  - whole-token body match ........ 1 (capped per token)
 *
 * An empty query with a tag filter returns all matching memories ranked by
 * recency, which makes `search(tags=[...])` a useful "browse by tag" call.
 */
export function searchMemories(
  memories: Memory[],
  query: string,
  opts: SearchOptions = {},
): SearchResult[] {
  const filterTags = (opts.tags ?? []).map((t) => t.toLowerCase());
  const limit = opts.limit ?? 20;
  const qTokens = tokenize(query);
  // One case-insensitive matcher per query token, reused across every memory.
  const qMatchers = qTokens.map((t) => new RegExp(t, 'gi'));

  const candidates = memories.filter((m) =>
    filterTags.every((t) => m.tags.includes(t)),
  );

  if (qTokens.length === 0) {
    // No text query: browse mode, newest first.
    return candidates
      .sort((a, b) => b.updated.localeCompare(a.updated))
      .slice(0, limit)
      .map((m) => ({ entry: toEntry(m), score: 1, matchedOn: filterTags.length ? ['tag'] : ['all'] }));
  }

  // Score every candidate without building per-memory token lists; only the
  // returned top `limit` hits get an entry (with its excerpt) built.
  const hits: { m: Memory; score: number; matchedOn: Set<string> }[] = [];
  for (const m of candidates) {
    let matchedOn: Set<string> | undefined;
    let score = 0;

    for (let qi = 0; qi < qTokens.length; qi++) {
      const qt = qTokens[qi];
      const re = qMatchers[qi];
      if (countWholeToken(m.title, re, qt.length, 1)) {
        score += 6;
        (matchedOn ??= new Set()).add('title');
      } else if (containsToken(m.title, re)) {
        score += 3;
        (matchedOn ??= new Set()).add('title');
      }
      if (m.tags.includes(qt)) {
        score += 5;
        (matchedOn ??= new Set()).add('tag');
      }
      const bodyHits = countWholeToken(m.content, re, qt.length, 3);
      if (bodyHits) {
        score += bodyHits;
        (matchedOn ??= new Set()).add('body');
      }
    }

    if (score > 0 && matchedOn) hits.push({ m, score, matchedOn });
  }

  return hits
    .sort((a, b) => b.score - a.score || b.m.updated.localeCompare(a.m.updated))
    .slice(0, limit)
    .map((h) => ({ entry: toEntry(h.m), score: h.score, matchedOn: [...h.matchedOn] }));
}

const ALNUM = /[a-z0-9]/i;

/** True if `re` (a global, case-insensitive token matcher) matches anywhere in `text`. */
function containsToken(text: string, re: RegExp): boolean {
  re.lastIndex = 0;
  return re.test(text);
}

/**
 * Count whole-token occurrences of a query token (`re` matches it, `len` is its length) in
 * `text`, case-insensitively, stopping at `cap`. Equivalent to counting it in
 * `tokenize(text)` but without lowercasing or splitting the whole body, so a
 * search over every memory creates almost no garbage.
 */
function countWholeToken(text: string, re: RegExp, len: number, cap: number): number {
  re.lastIndex = 0;
  let hits = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = m.index > 0 ? text[m.index - 1] : '';
    const after = text[m.index + len] ?? '';
    if (!(before && ALNUM.test(before)) && !(after && ALNUM.test(after))) {
      if (++hits >= cap) break;
    }
  }
  return hits;
}

export function toEntry(m: Memory): IndexEntry {
  return {
    id: m.id,
    title: m.title,
    tags: m.tags,
    created: m.created,
    updated: m.updated,
    file: m.file,
    excerpt: makeExcerpt(m.content),
  };
}

export function makeExcerpt(content: string, max = 200): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
