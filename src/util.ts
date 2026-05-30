import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { STORE_DIR_NAME } from './types.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generate a lexicographically sortable, URL-safe id (ULID-like).
 * The first 10 chars encode the millisecond timestamp, the last 16 are random,
 * so ids sort by creation time without leaking a sequential counter.
 */
export function generateId(now = Date.now()): string {
  let time = now;
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = CROCKFORD[time % 32];
    time = Math.floor(time / 32);
  }
  const rnd = randomBytes(16);
  let rndStr = '';
  for (let i = 0; i < 16; i++) {
    rndStr += CROCKFORD[rnd[i] % 32];
  }
  return timeChars.join('') + rndStr;
}

/** Turn a title into a filesystem-friendly slug. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

/** Normalize tags: trim, lower-case, drop empties, de-duplicate, keep order. */
export function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = String(raw).trim().toLowerCase().replace(/^#/, '');
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the store directory (the `.memory` folder).
 *
 * Precedence:
 *  1. An explicit path (CLI flag / function arg).
 *  2. The `MEMORY_MCP_ROOT` environment variable.
 *  3. The nearest existing `.memory` directory walking up from `cwd`.
 *  4. `<cwd>/.memory` (created on first write).
 */
export function resolveStoreDir(explicit?: string, cwd = process.cwd()): string {
  if (explicit) {
    // Allow pointing either at the store dir itself or its parent.
    const abs = resolve(cwd, explicit);
    if (abs.endsWith(STORE_DIR_NAME)) return abs;
    const nested = join(abs, STORE_DIR_NAME);
    if (isDir(nested)) return nested;
    return abs;
  }

  const env = process.env.MEMORY_MCP_ROOT;
  if (env) {
    const abs = resolve(cwd, env);
    return abs.endsWith(STORE_DIR_NAME) ? abs : join(abs, STORE_DIR_NAME);
  }

  let dir = resolve(cwd);
  while (true) {
    const candidate = join(dir, STORE_DIR_NAME);
    if (isDir(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return join(resolve(cwd), STORE_DIR_NAME);
}

export function pathExists(p: string): boolean {
  return existsSync(p);
}

/** Tokenize text into lower-case word tokens for the search index. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1);
}
