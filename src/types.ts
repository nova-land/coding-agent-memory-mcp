/**
 * Core domain types for the project memory store.
 *
 * Every memory is a single markdown file with YAML frontmatter. The markdown
 * file is the source of truth; the JSON index is a derived cache that can be
 * rebuilt at any time from the markdown files.
 */

export interface MemoryFrontmatter {
  /** Stable, sortable identifier (see {@link generateId}). */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Lower-cased, de-duplicated tags. */
  tags: string[];
  /** ISO-8601 creation timestamp. */
  created: string;
  /** ISO-8601 last-updated timestamp. */
  updated: string;
  /** IDs of related memories (free-form cross-links). */
  links?: string[];
  /** Optional provenance, e.g. "claude-code", "cursor", a URL, or a file path. */
  source?: string;
}

export interface Memory extends MemoryFrontmatter {
  /** The markdown body (everything after the frontmatter). */
  content: string;
  /** Path to the backing file, relative to the store root. */
  file: string;
}

/** A lightweight record kept in the on-disk index for fast listing/search. */
export interface IndexEntry {
  id: string;
  title: string;
  tags: string[];
  created: string;
  updated: string;
  file: string;
  /** First ~200 chars of the body, used for previews. */
  excerpt: string;
}

export interface IndexFile {
  version: number;
  /** ISO timestamp of the last full reindex. */
  generated: string;
  memories: IndexEntry[];
}

export interface SearchResult {
  entry: IndexEntry;
  score: number;
  /** Why this matched (title/tag/body), useful for debugging and previews. */
  matchedOn: string[];
}

export interface CreateMemoryInput {
  title: string;
  content: string;
  tags?: string[];
  links?: string[];
  source?: string;
  /** Optional subfolder under .memory/memories/ to organize the file into. */
  folder?: string;
}

export interface UpdateMemoryInput {
  title?: string;
  content?: string;
  tags?: string[];
  links?: string[];
  source?: string;
}

export const INDEX_VERSION = 1;
export const STORE_DIR_NAME = '.memory';
export const MEMORIES_SUBDIR = 'memories';
export const INDEX_FILE_NAME = 'index.json';
