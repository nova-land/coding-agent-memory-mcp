#!/usr/bin/env node
// Ensure the compiled CLI entry is executable and has a shebang.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'dist', 'index.js');

if (!existsSync(bin)) {
  console.error(`postbuild: expected ${bin} to exist`);
  process.exit(1);
}

const SHEBANG = '#!/usr/bin/env node\n';
let src = readFileSync(bin, 'utf8');
if (!src.startsWith('#!')) {
  writeFileSync(bin, SHEBANG + src, 'utf8');
}
chmodSync(bin, 0o755);
console.log('postbuild: dist/index.js is executable');
