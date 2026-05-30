import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

interface PkgInfo {
  name: string;
  version: string;
}

let cached: PkgInfo | undefined;

/**
 * Read this package's name/version from package.json at runtime so the CLI,
 * MCP server identity, and generated `npx <name>` client configs all stay in
 * sync with whatever the package is actually published as.
 */
export function pkgInfo(): PkgInfo {
  if (cached) return cached;
  try {
    // Compiled file lives in dist/; package.json is one level up.
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PkgInfo>;
    cached = {
      name: parsed.name ?? 'coding-agent-memory-mcp',
      version: parsed.version ?? '0.0.0',
    };
  } catch {
    cached = { name: 'coding-agent-memory-mcp', version: '0.0.0' };
  }
  return cached;
}
