import matter from 'gray-matter';
import type { Memory, MemoryFrontmatter } from './types.js';
import { normalizeTags } from './util.js';

/**
 * Serialize a memory to a markdown document with YAML frontmatter.
 * We write the frontmatter by hand (rather than via a YAML lib) to keep the
 * output stable, diff-friendly, and dependency-light.
 */
export function serializeMemory(mem: Memory): string {
  const fm: string[] = ['---'];
  fm.push(`id: ${yamlScalar(mem.id)}`);
  fm.push(`title: ${yamlScalar(mem.title)}`);
  fm.push(`tags: ${yamlList(mem.tags)}`);
  // Quote timestamps so the YAML loader keeps them as strings (not Date objects).
  fm.push(`created: ${JSON.stringify(mem.created)}`);
  fm.push(`updated: ${JSON.stringify(mem.updated)}`);
  if (mem.links && mem.links.length) fm.push(`links: ${yamlList(mem.links)}`);
  if (mem.source) fm.push(`source: ${yamlScalar(mem.source)}`);
  fm.push('---');
  const body = mem.content.trimEnd();
  return `${fm.join('\n')}\n\n${body}\n`;
}

/**
 * Parse a markdown document into a memory. `file` is the store-relative path,
 * recorded on the returned object for round-tripping.
 */
export function parseMemory(raw: string, file: string): Memory {
  const { data, content } = matter(raw);
  const fm = data as Partial<MemoryFrontmatter>;
  const now = new Date().toISOString();
  return {
    id: String(fm.id ?? ''),
    title: String(fm.title ?? 'Untitled'),
    tags: normalizeTags(Array.isArray(fm.tags) ? fm.tags.map(String) : []),
    created: toIso(fm.created, now),
    updated: toIso(fm.updated, toIso(fm.created, now)),
    links: Array.isArray(fm.links) ? fm.links.map(String) : undefined,
    source: fm.source ? String(fm.source) : undefined,
    content: content.trim(),
    file,
  };
}

/** Coerce a frontmatter timestamp (string or YAML-parsed Date) to an ISO string. */
function toIso(value: unknown, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value;
  return fallback;
}

function yamlScalar(value: string): string {
  // Quote when the value could be misread as YAML structure.
  if (value === '') return '""';
  if (/^[\w./@: +-]+$/.test(value) && !/^[-?:&*!|>%@`"']/.test(value) && !/: /.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function yamlList(items: string[]): string {
  if (!items.length) return '[]';
  return `[${items.map(yamlScalar).join(', ')}]`;
}
