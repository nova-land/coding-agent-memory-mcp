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

  const results: SearchResult[] = [];
  for (const m of candidates) {
    const titleLower = m.title.toLowerCase();
    const titleTokens = new Set(tokenize(m.title));
    const bodyTokens = countTokens(m.content);
    const matchedOn = new Set<string>();
    let score = 0;

    for (const qt of qTokens) {
      if (titleTokens.has(qt)) {
        score += 6;
        matchedOn.add('title');
      } else if (titleLower.includes(qt)) {
        score += 3;
        matchedOn.add('title');
      }
      if (m.tags.includes(qt)) {
        score += 5;
        matchedOn.add('tag');
      }
      const bodyHits = bodyTokens.get(qt);
      if (bodyHits) {
        score += Math.min(bodyHits, 3);
        matchedOn.add('body');
      }
    }

    if (score > 0) {
      results.push({ entry: toEntry(m), score, matchedOn: [...matchedOn] });
    }
  }

  return results
    .sort((a, b) => b.score - a.score || b.entry.updated.localeCompare(a.entry.updated))
    .slice(0, limit);
}

function countTokens(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tokenize(text)) {
    map.set(t, (map.get(t) ?? 0) + 1);
  }
  return map;
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
