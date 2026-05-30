#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryStore } from './store.js';
import { serveStdio } from './server.js';
import { resolveStoreDir } from './util.js';
import {
  ALL_CLIENTS,
  CLIENT_LABELS,
  configPathFor,
  defaultInvocation,
  installClients,
  type ClientId,
  type InstallOptions,
} from './config.js';

const VERSION = '0.1.0';

function storeFor(opts: { root?: string }): MemoryStore {
  return new MemoryStore(resolveStoreDir(opts.root));
}

/** Read piped stdin if available, else return ''. */
function readStdin(): string {
  try {
    if (process.stdin.isTTY) return '';
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function splitList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const program = new Command();

program
  .name('memory-mcp')
  .description('Portable, local-first, markdown-based project memory (MCP server + CLI).')
  .version(VERSION);

// --- serve (MCP over stdio) -------------------------------------------------
program
  .command('serve')
  .description('Run the MCP server over stdio (for Claude Code, Copilot, Cursor, Codex).')
  .option('-r, --root <dir>', 'Path to the project or .memory directory.')
  .action(async (opts) => {
    const store = storeFor(opts);
    store.init();
    // NOTE: stdout is reserved for the MCP protocol; log to stderr only.
    process.stderr.write(`[memory-mcp] serving store at ${store.root}\n`);
    await serveStdio(store);
  });

// --- init -------------------------------------------------------------------
program
  .command('init')
  .description('Create the .memory store in the current (or given) directory.')
  .option('-r, --root <dir>', 'Path to the project or .memory directory.')
  .action((opts) => {
    const store = storeFor(opts);
    store.init();
    console.log(`Initialized memory store at ${store.root}`);
  });

// --- add --------------------------------------------------------------------
program
  .command('add')
  .description('Add a memory. Content comes from --content, --file, or piped stdin.')
  .argument('<title>', 'Title of the memory.')
  .option('-c, --content <text>', 'Memory body text.')
  .option('-f, --file <path>', 'Read the body from a file.')
  .option('-t, --tags <list>', 'Comma-separated tags.')
  .option('-l, --links <list>', 'Comma-separated related memory ids.')
  .option('-s, --source <source>', 'Provenance label.', 'cli')
  .option('-r, --root <dir>', 'Path to the project or .memory directory.')
  .action((title: string, opts) => {
    let content = opts.content as string | undefined;
    if (!content && opts.file) content = readFileSync(resolve(opts.file), 'utf8');
    if (!content) content = readStdin();
    if (!content || !content.trim()) {
      console.error('No content provided. Use --content, --file, or pipe via stdin.');
      process.exit(1);
    }
    const store = storeFor(opts);
    const mem = store.create({
      title,
      content,
      tags: splitList(opts.tags),
      links: splitList(opts.links),
      source: opts.source,
    });
    console.log(`Added memory ${mem.id}\n${mem.file}`);
  });

// --- list -------------------------------------------------------------------
program
  .command('list')
  .description('List memories, newest first.')
  .option('-t, --tag <tag>', 'Filter by tag.')
  .option('-n, --limit <n>', 'Max results.', (v) => parseInt(v, 10))
  .option('--json', 'Output JSON.')
  .option('-r, --root <dir>', 'Path to the project or .memory directory.')
  .action((opts) => {
    const store = storeFor(opts);
    const entries = store.list({ tag: opts.tag, limit: opts.limit });
    if (opts.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }
    if (entries.length === 0) {
      console.log('No memories yet.');
      return;
    }
    for (const e of entries) {
      const tags = e.tags.length ? ` [${e.tags.join(', ')}]` : '';
      console.log(`${e.id}  ${e.title}${tags}`);
      console.log(`    ${e.excerpt}`);
    }
  });

// --- search -----------------------------------------------------------------
program
  .command('search')
  .description('Search memories by text and/or tags.')
  .argument('[query...]', 'Search terms.')
  .option('-t, --tag <list>', 'Comma-separated tags that must all match.')
  .option('-n, --limit <n>', 'Max results.', (v) => parseInt(v, 10))
  .option('--json', 'Output JSON.')
  .option('-r, --root <dir>', 'Path to the project or .memory directory.')
  .action((query: string[], opts) => {
    const store = storeFor(opts);
    const results = store.search((query ?? []).join(' '), {
      tags: splitList(opts.tag),
      limit: opts.limit,
    });
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    if (results.length === 0) {
      console.log('No matching memories.');
      return;
    }
    for (const r of results) {
      const tags = r.entry.tags.length ? ` [${r.entry.tags.join(', ')}]` : '';
      console.log(`${r.entry.id}  ${r.entry.title}${tags}  (score ${r.score}; ${r.matchedOn.join(', ')})`);
      console.log(`    ${r.entry.excerpt}`);
    }
  });

// --- get --------------------------------------------------------------------
program
  .command('get')
  .description('Show a memory in full by id.')
  .argument('<id>', 'Memory id.')
  .option('--json', 'Output JSON.')
  .option('-r, --root <dir>', 'Path to the project or .memory directory.')
  .action((id: string, opts) => {
    const store = storeFor(opts);
    const mem = store.get(id);
    if (!mem) {
      console.error(`No memory found with id "${id}".`);
      process.exit(1);
    }
    console.log(opts.json ? JSON.stringify(mem, null, 2) : readFileSync(resolve(store.root, mem.file), 'utf8'));
  });

// --- update -----------------------------------------------------------------
program
  .command('update')
  .description('Update fields of an existing memory.')
  .argument('<id>', 'Memory id.')
  .option('--title <title>', 'New title.')
  .option('-c, --content <text>', 'New body.')
  .option('-f, --file <path>', 'Read new body from a file.')
  .option('-t, --tags <list>', 'Replace tags (comma-separated).')
  .option('-l, --links <list>', 'Replace links (comma-separated).')
  .option('-r, --root <dir>', 'Path to the project or .memory directory.')
  .action((id: string, opts) => {
    const store = storeFor(opts);
    let content = opts.content as string | undefined;
    if (!content && opts.file) content = readFileSync(resolve(opts.file), 'utf8');
    try {
      const mem = store.update(id, {
        title: opts.title,
        content,
        tags: opts.tags !== undefined ? splitList(opts.tags) : undefined,
        links: opts.links !== undefined ? splitList(opts.links) : undefined,
      });
      console.log(`Updated memory ${mem.id}\n${mem.file}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// --- delete -----------------------------------------------------------------
program
  .command('delete')
  .alias('rm')
  .description('Delete a memory by id.')
  .argument('<id>', 'Memory id.')
  .option('-r, --root <dir>', 'Path to the project or .memory directory.')
  .action((id: string, opts) => {
    const store = storeFor(opts);
    console.log(store.delete(id) ? `Deleted ${id}.` : `No memory found with id "${id}".`);
  });

// --- tags -------------------------------------------------------------------
program
  .command('tags')
  .description('List all tags with usage counts.')
  .option('--json', 'Output JSON.')
  .option('-r, --root <dir>', 'Path to the project or .memory directory.')
  .action((opts) => {
    const store = storeFor(opts);
    const tags = store.tags();
    if (opts.json) {
      console.log(JSON.stringify(tags, null, 2));
      return;
    }
    if (tags.length === 0) {
      console.log('No tags yet.');
      return;
    }
    for (const { tag, count } of tags) console.log(`${String(count).padStart(4)}  ${tag}`);
  });

// --- reindex ----------------------------------------------------------------
program
  .command('reindex')
  .description('Rebuild the search index from the markdown files.')
  .option('-r, --root <dir>', 'Path to the project or .memory directory.')
  .action((opts) => {
    const store = storeFor(opts);
    const index = store.reindex();
    console.log(`Reindexed ${index.memories.length} memories at ${store.indexPath}`);
  });

// --- path -------------------------------------------------------------------
program
  .command('path')
  .description('Print the resolved .memory store directory.')
  .option('-r, --root <dir>', 'Path to the project or .memory directory.')
  .action((opts) => {
    console.log(resolveStoreDir(opts.root));
  });

// --- install ----------------------------------------------------------------
program
  .command('install')
  .description('Configure MCP clients to use this memory server.')
  .argument('[clients...]', `Clients to configure: ${ALL_CLIENTS.join(', ')} (default: all).`)
  .option('--all', 'Configure all supported clients.')
  .option('--name <name>', 'Server name/key in the client config.', 'memory')
  .option('--command <cmd>', 'Override the launch command.')
  .option('--arg <arg>', 'Append a launch argument (repeatable).', (v: string, acc: string[]) => [...acc, v], [])
  .option('--local', 'Use this installed binary directly instead of "npx -y project-memory-mcp".')
  .option('--root <dir>', 'Bind the server to a specific .memory store (sets MEMORY_MCP_ROOT).')
  .option('--project <dir>', 'Project directory to write client configs into.', process.cwd())
  .option('--print', 'Show what would be written without modifying files.')
  .action((clientsArg: string[], opts) => {
    const requested = opts.all || clientsArg.length === 0 ? ALL_CLIENTS : (clientsArg as ClientId[]);
    const invalid = requested.filter((c) => !ALL_CLIENTS.includes(c));
    if (invalid.length) {
      console.error(`Unknown client(s): ${invalid.join(', ')}. Valid: ${ALL_CLIENTS.join(', ')}`);
      process.exit(1);
    }

    const storeRoot = opts.root ? resolveStoreDir(opts.root) : undefined;
    const base = defaultInvocation(storeRoot);
    let command = base.command;
    let args = base.args;
    if (opts.local) {
      command = process.execPath; // node
      args = [resolve(process.argv[1]), 'serve'];
    }
    if (opts.command) {
      command = opts.command;
      args = [];
    }
    if (opts.arg && opts.arg.length) args = [...args, ...opts.arg];

    const installOpts: InstallOptions = {
      projectDir: resolve(opts.project),
      serverName: opts.name,
      command,
      args,
      env: base.env,
    };

    if (opts.print) {
      console.log('Would configure:');
      for (const client of requested) {
        console.log(`  ${CLIENT_LABELS[client]} → ${configPathFor(client, installOpts.projectDir)}`);
      }
      console.log('\nServer invocation:');
      console.log(`  command: ${command}`);
      console.log(`  args: ${JSON.stringify(args)}`);
      if (base.env) console.log(`  env: ${JSON.stringify(base.env)}`);
      return;
    }

    const results = installClients(requested as ClientId[], installOpts);
    for (const r of results) {
      console.log(`${r.action.padEnd(9)} ${CLIENT_LABELS[r.client].padEnd(28)} ${r.file}`);
    }
    console.log('\nDone. Restart your AI tools to pick up the new MCP server.');
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
