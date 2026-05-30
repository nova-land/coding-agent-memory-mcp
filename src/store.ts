import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import {
  INDEX_FILE_NAME,
  INDEX_VERSION,
  MEMORIES_SUBDIR,
  type CreateMemoryInput,
  type IndexEntry,
  type IndexFile,
  type Memory,
  type SearchResult,
  type UpdateMemoryInput,
} from './types.js';
import { generateId, normalizeTags, slugify } from './util.js';
import { parseMemory, serializeMemory } from './markdown.js';
import { searchMemories, toEntry, type SearchOptions } from './search.js';

/**
 * File-backed memory store. The `.memory/memories/*.md` files are the source of
 * truth; `.memory/index.json` is a derived cache kept in sync on every write and
 * fully rebuildable via {@link reindex}.
 */
export class MemoryStore {
  readonly root: string;
  readonly memoriesDir: string;
  readonly indexPath: string;

  constructor(root: string) {
    this.root = root;
    this.memoriesDir = join(root, MEMORIES_SUBDIR);
    this.indexPath = join(root, INDEX_FILE_NAME);
  }

  /** Create the store directories and a fresh index if they don't exist. */
  init(): { created: boolean } {
    const created = !existsSync(this.root);
    mkdirSync(this.memoriesDir, { recursive: true });
    if (!existsSync(this.indexPath)) {
      this.writeIndex(this.buildIndex(this.readAll()));
    }
    return { created };
  }

  private ensureDirs(): void {
    mkdirSync(this.memoriesDir, { recursive: true });
  }

  /** Read every memory from disk (source of truth). */
  readAll(): Memory[] {
    if (!existsSync(this.memoriesDir)) return [];
    const files = readdirSync(this.memoriesDir).filter((f) => f.endsWith('.md'));
    const out: Memory[] = [];
    for (const f of files) {
      const abs = join(this.memoriesDir, f);
      try {
        const raw = readFileSync(abs, 'utf8');
        out.push(parseMemory(raw, relative(this.root, abs)));
      } catch {
        // Skip unreadable/corrupt files rather than failing the whole store.
      }
    }
    return out;
  }

  get(id: string): Memory | undefined {
    return this.readAll().find((m) => m.id === id);
  }

  /** Resolve a file path for a memory, namespacing the slug with a short id. */
  private fileFor(id: string, title: string): string {
    const shortId = id.slice(0, 8).toLowerCase();
    return join(this.memoriesDir, `${slugify(title)}-${shortId}.md`);
  }

  create(input: CreateMemoryInput): Memory {
    this.ensureDirs();
    const now = new Date().toISOString();
    const id = input.id?.trim() || generateId();
    if (this.get(id)) {
      throw new Error(`A memory with id "${id}" already exists`);
    }
    const mem: Memory = {
      id,
      title: input.title.trim() || 'Untitled',
      tags: normalizeTags(input.tags),
      created: now,
      updated: now,
      links: input.links && input.links.length ? input.links : undefined,
      source: input.source,
      content: input.content ?? '',
      file: '',
    };
    const abs = this.fileFor(id, mem.title);
    mem.file = relative(this.root, abs);
    writeFileSync(abs, serializeMemory(mem), 'utf8');
    this.touchIndex(mem, 'upsert');
    return mem;
  }

  update(id: string, patch: UpdateMemoryInput): Memory {
    const existing = this.get(id);
    if (!existing) throw new Error(`No memory found with id "${id}"`);

    const updated: Memory = {
      ...existing,
      title: patch.title?.trim() ?? existing.title,
      content: patch.content ?? existing.content,
      tags: patch.tags ? normalizeTags(patch.tags) : existing.tags,
      links: patch.links ?? existing.links,
      source: patch.source ?? existing.source,
      updated: new Date().toISOString(),
    };

    // If the title changed, the slug-based filename changes too; move the file.
    const newAbs = this.fileFor(id, updated.title);
    const oldAbs = join(this.root, existing.file);
    updated.file = relative(this.root, newAbs);
    writeFileSync(newAbs, serializeMemory(updated), 'utf8');
    if (oldAbs !== newAbs && existsSync(oldAbs)) {
      rmSync(oldAbs);
    }
    this.touchIndex(updated, 'upsert');
    return updated;
  }

  delete(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    const abs = join(this.root, existing.file);
    if (existsSync(abs)) rmSync(abs);
    this.touchIndex(existing, 'remove');
    return true;
  }

  list(opts: { tag?: string; limit?: number } = {}): IndexEntry[] {
    let mems = this.readAll();
    if (opts.tag) {
      const t = opts.tag.toLowerCase();
      mems = mems.filter((m) => m.tags.includes(t));
    }
    mems.sort((a, b) => b.updated.localeCompare(a.updated));
    const limited = opts.limit ? mems.slice(0, opts.limit) : mems;
    return limited.map(toEntry);
  }

  search(query: string, opts: SearchOptions = {}): SearchResult[] {
    return searchMemories(this.readAll(), query, opts);
  }

  /** All tags across the store with their usage counts, most-used first. */
  tags(): { tag: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const m of this.readAll()) {
      for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  // --- index management ---------------------------------------------------

  readIndex(): IndexFile {
    if (!existsSync(this.indexPath)) {
      return { version: INDEX_VERSION, generated: new Date(0).toISOString(), memories: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as IndexFile;
      if (parsed.version !== INDEX_VERSION) return this.reindex();
      return parsed;
    } catch {
      return this.reindex();
    }
  }

  private buildIndex(memories: Memory[]): IndexFile {
    return {
      version: INDEX_VERSION,
      generated: new Date().toISOString(),
      memories: memories
        .map(toEntry)
        .sort((a, b) => b.updated.localeCompare(a.updated)),
    };
  }

  private writeIndex(index: IndexFile): void {
    this.ensureDirs();
    writeFileSync(this.indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  }

  /** Incrementally update the index for a single memory. */
  private touchIndex(mem: Memory, op: 'upsert' | 'remove'): void {
    const index = this.readIndex();
    index.memories = index.memories.filter((e) => e.id !== mem.id);
    if (op === 'upsert') index.memories.unshift(toEntry(mem));
    index.memories.sort((a, b) => b.updated.localeCompare(a.updated));
    index.generated = new Date().toISOString();
    this.writeIndex(index);
  }

  /** Rebuild the index from scratch by scanning all markdown files. */
  reindex(): IndexFile {
    const index = this.buildIndex(this.readAll());
    this.writeIndex(index);
    return index;
  }
}
