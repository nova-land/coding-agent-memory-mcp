import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { MemoryStore } from './store.js';
import type { IndexEntry, Memory, SearchResult } from './types.js';

const PKG_NAME = 'project-memory-mcp';
const PKG_VERSION = '0.1.0';

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

function json(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}

function entryLine(e: IndexEntry): string {
  const tags = e.tags.length ? ` [${e.tags.join(', ')}]` : '';
  return `• (${e.id}) ${e.title}${tags}\n  ${e.excerpt}`;
}

function fullMemory(m: Memory): string {
  const tags = m.tags.length ? m.tags.join(', ') : '(none)';
  const links = m.links?.length ? m.links.join(', ') : '(none)';
  return [
    `id: ${m.id}`,
    `title: ${m.title}`,
    `tags: ${tags}`,
    `links: ${links}`,
    `created: ${m.created}`,
    `updated: ${m.updated}`,
    m.source ? `source: ${m.source}` : undefined,
    `file: ${m.file}`,
    '',
    m.content,
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

/**
 * Build an MCP server exposing the memory store as tools. Transport-agnostic:
 * callers connect it to stdio (CLI `serve`) or any other transport.
 */
export function createServer(store: MemoryStore): McpServer {
  const server = new McpServer(
    { name: PKG_NAME, version: PKG_VERSION },
    {
      instructions:
        'Shared project memory. Use these tools to remember durable facts, ' +
        'decisions, conventions, and context across sessions and tools. ' +
        'Memories are markdown files committed in the repo under .memory/. ' +
        'Search before creating to avoid duplicates; tag memories so they are ' +
        'easy to recall.',
    },
  );

  server.registerTool(
    'memory_create',
    {
      title: 'Create memory',
      description:
        'Store a durable project memory (a fact, decision, convention, or piece ' +
        'of context) as a markdown file. Returns the created memory id. Search ' +
        'first to avoid duplicates.',
      inputSchema: {
        title: z.string().min(1).describe('Short, descriptive title.'),
        content: z.string().describe('Markdown body of the memory.'),
        tags: z.array(z.string()).optional().describe('Tags for recall, e.g. ["architecture","api"].'),
        links: z.array(z.string()).optional().describe('Ids of related memories.'),
        source: z.string().optional().describe('Optional provenance (tool, url, file path).'),
      },
    },
    async (args) => {
      const mem = store.create({
        title: args.title,
        content: args.content,
        tags: args.tags,
        links: args.links,
        source: args.source ?? 'mcp',
      });
      return text(`Created memory ${mem.id} → ${mem.file}`);
    },
  );

  server.registerTool(
    'memory_search',
    {
      title: 'Search memories',
      description:
        'Full-text + tag search over project memories. Returns ranked matches ' +
        'with ids and excerpts. Pass an empty query with tags to browse by tag.',
      inputSchema: {
        query: z.string().default('').describe('Free-text query.'),
        tags: z.array(z.string()).optional().describe('Restrict to memories having all these tags.'),
        limit: z.number().int().positive().max(100).optional().describe('Max results (default 20).'),
      },
    },
    async (args) => {
      const results: SearchResult[] = store.search(args.query ?? '', {
        tags: args.tags,
        limit: args.limit,
      });
      if (results.length === 0) return text('No matching memories.');
      const body = results
        .map((r) => `${entryLine(r.entry)}\n  ↳ score ${r.score} (${r.matchedOn.join(', ')})`)
        .join('\n\n');
      return text(body);
    },
  );

  server.registerTool(
    'memory_get',
    {
      title: 'Get memory',
      description: 'Fetch a single memory in full by its id.',
      inputSchema: {
        id: z.string().describe('The memory id.'),
      },
    },
    async (args) => {
      const mem = store.get(args.id);
      if (!mem) return text(`No memory found with id "${args.id}".`);
      return text(fullMemory(mem));
    },
  );

  server.registerTool(
    'memory_update',
    {
      title: 'Update memory',
      description:
        'Update an existing memory by id. Only provided fields change. ' +
        'Tags and links replace the previous values when supplied.',
      inputSchema: {
        id: z.string().describe('The memory id to update.'),
        title: z.string().optional(),
        content: z.string().optional(),
        tags: z.array(z.string()).optional(),
        links: z.array(z.string()).optional(),
        source: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const mem = store.update(args.id, {
          title: args.title,
          content: args.content,
          tags: args.tags,
          links: args.links,
          source: args.source,
        });
        return text(`Updated memory ${mem.id} → ${mem.file}`);
      } catch (err) {
        return text((err as Error).message);
      }
    },
  );

  server.registerTool(
    'memory_delete',
    {
      title: 'Delete memory',
      description: 'Delete a memory by id. This removes the markdown file.',
      inputSchema: {
        id: z.string().describe('The memory id to delete.'),
      },
    },
    async (args) => {
      const ok = store.delete(args.id);
      return text(ok ? `Deleted memory ${args.id}.` : `No memory found with id "${args.id}".`);
    },
  );

  server.registerTool(
    'memory_list',
    {
      title: 'List memories',
      description: 'List memories (most recently updated first), optionally filtered by a tag.',
      inputSchema: {
        tag: z.string().optional().describe('Only memories with this tag.'),
        limit: z.number().int().positive().max(200).optional().describe('Max results (default all).'),
      },
    },
    async (args) => {
      const entries = store.list({ tag: args.tag, limit: args.limit });
      if (entries.length === 0) return text('No memories yet.');
      return text(entries.map(entryLine).join('\n\n'));
    },
  );

  server.registerTool(
    'memory_tags',
    {
      title: 'List tags',
      description: 'List all tags in the store with their usage counts.',
      inputSchema: {},
    },
    async () => {
      const tags = store.tags();
      if (tags.length === 0) return text('No tags yet.');
      return json(tags);
    },
  );

  server.registerTool(
    'memory_reindex',
    {
      title: 'Reindex',
      description: 'Rebuild the search index from the markdown files. Rarely needed.',
      inputSchema: {},
    },
    async () => {
      const index = store.reindex();
      return text(`Reindexed ${index.memories.length} memories.`);
    },
  );

  return server;
}

/** Start the MCP server over stdio and block until the transport closes. */
export async function serveStdio(store: MemoryStore): Promise<void> {
  const server = createServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay alive; the transport drives the lifecycle over stdin/stdout.
}
