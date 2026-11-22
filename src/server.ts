import type { MemoryStore } from './store.js';
import type { IndexEntry, Memory, SearchResult } from './types.js';
import { pkgInfo } from './pkg.js';

/*
 * A minimal MCP server over stdio. MCP's stdio transport is newline-delimited
 * JSON-RPC 2.0, and this server only needs `initialize`, `ping`, `tools/list`
 * and `tools/call`. Speaking it directly (instead of through the official SDK,
 * which pulls in a web-server stack and a JSON Schema validator) keeps the
 * idle process at roughly Node's own baseline — it matters because every agent
 * session spawns its own copy.
 */

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const INSTRUCTIONS =
  'Shared project memory. Use these tools to remember durable facts, ' +
  'decisions, conventions, and context across sessions and tools. ' +
  'Memories are markdown files committed in the repo under .memory/. ' +
  'Search before creating to avoid duplicates; tag memories so they are ' +
  'easy to recall.';

// --- tool result helpers ----------------------------------------------------

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] };
}

function json(value: unknown): ToolResult {
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

// --- input schemas (JSON Schema subset) + validation --------------------------

type Prop =
  | { type: 'string'; description?: string; minLength?: number; default?: string }
  | { type: 'integer'; description?: string; exclusiveMinimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string; default?: boolean }
  | { type: 'array'; items: { type: 'string' }; description?: string };

export interface InputSchema {
  type: 'object';
  properties: Record<string, Prop>;
  required?: string[];
  additionalProperties?: boolean;
}

const str = (description?: string, extra: { minLength?: number; default?: string } = {}): Prop => ({
  type: 'string',
  ...(description ? { description } : {}),
  ...extra,
});
const strList = (description?: string): Prop => ({
  type: 'array',
  items: { type: 'string' },
  ...(description ? { description } : {}),
});
const posInt = (max: number, description: string): Prop => ({
  type: 'integer',
  exclusiveMinimum: 0,
  maximum: max,
  description,
});

function schema(properties: Record<string, Prop>, required: string[] = []): InputSchema {
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  };
}

/** Validate tool arguments against a schema and apply defaults. Throws a readable message. */
export function validateArgs(s: InputSchema, input: unknown): Record<string, unknown> {
  const args = input ?? {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
  const src = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(s.properties)) {
    let v = src[key];
    if (v === undefined || v === null) {
      if ('default' in prop && prop.default !== undefined) v = prop.default;
      else if (s.required?.includes(key)) throw new Error(`"${key}" is required`);
      else continue;
    }
    switch (prop.type) {
      case 'string':
        if (typeof v !== 'string') throw new Error(`"${key}" must be a string`);
        if (prop.minLength && v.length < prop.minLength) throw new Error(`"${key}" must not be empty`);
        break;
      case 'integer':
        if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`"${key}" must be an integer`);
        if (prop.exclusiveMinimum !== undefined && v <= prop.exclusiveMinimum) throw new Error(`"${key}" must be positive`);
        if (prop.maximum !== undefined && v > prop.maximum) throw new Error(`"${key}" must be at most ${prop.maximum}`);
        break;
      case 'boolean':
        if (typeof v !== 'boolean') throw new Error(`"${key}" must be true or false`);
        break;
      case 'array':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`"${key}" must be an array of strings`);
        break;
    }
    out[key] = v;
  }
  return out;
}

// --- tools ------------------------------------------------------------------

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: InputSchema;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: Record<string, any>) => ToolResult;
}

function buildTools(store: MemoryStore): ToolDef[] {
  return [
    {
      name: 'memory_create',
      title: 'Create memory',
      description:
        'Store a durable project memory (a fact, decision, convention, or piece ' +
        'of context) as a markdown file. Returns the created memory id. Search ' +
        'first to avoid duplicates.',
      inputSchema: schema(
        {
          title: str('Short, descriptive title.', { minLength: 1 }),
          content: str('Markdown body of the memory.'),
          tags: strList('Tags for recall, e.g. ["architecture","api"].'),
          links: strList('Ids of related memories.'),
          folder: str('Subfolder under .memory/memories/ to organize the file into, e.g. "architecture".'),
          source: str('Optional provenance (tool, url, file path).'),
        },
        ['title', 'content'],
      ),
      handler: (args) => {
        const mem = store.create({
          title: args.title,
          content: args.content,
          tags: args.tags,
          links: args.links,
          folder: args.folder,
          source: args.source ?? 'mcp',
        });
        return text(`Created memory ${mem.id} → ${mem.file}`);
      },
    },
    {
      name: 'memory_search',
      title: 'Search memories',
      description:
        'Full-text + tag search over project memories. Returns ranked matches ' +
        'with ids and excerpts. Pass an empty query with tags to browse by tag.',
      inputSchema: schema({
        query: str('Free-text query.', { default: '' }),
        tags: strList('Restrict to memories having all these tags.'),
        limit: posInt(100, 'Max results (default 20).'),
      }),
      handler: (args) => {
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
    },
    {
      name: 'memory_get',
      title: 'Get memory',
      description: 'Fetch a single memory in full by its id.',
      inputSchema: schema({ id: str('The memory id.') }, ['id']),
      handler: (args) => {
        const mem = store.get(args.id);
        if (!mem) return text(`No memory found with id "${args.id}".`);
        return text(fullMemory(mem));
      },
    },
    {
      name: 'memory_update',
      title: 'Update memory',
      description:
        'Update an existing memory by id. Only provided fields change. ' +
        'Tags and links replace the previous values when supplied.',
      inputSchema: schema(
        {
          id: str('The memory id to update.'),
          title: str(),
          content: str(),
          tags: strList(),
          links: strList(),
          source: str(),
        },
        ['id'],
      ),
      handler: (args) => {
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
    },
    {
      name: 'memory_delete',
      title: 'Delete memory',
      description: 'Delete a memory by id. This removes the markdown file.',
      inputSchema: schema({ id: str('The memory id to delete.') }, ['id']),
      handler: (args) => {
        const ok = store.delete(args.id);
        return text(ok ? `Deleted memory ${args.id}.` : `No memory found with id "${args.id}".`);
      },
    },
    {
      name: 'memory_list',
      title: 'List memories',
      description: 'List memories (most recently updated first), optionally filtered by a tag.',
      inputSchema: schema({
        tag: str('Only memories with this tag.'),
        limit: posInt(200, 'Max results (default all).'),
      }),
      handler: (args) => {
        const entries = store.list({ tag: args.tag, limit: args.limit });
        if (entries.length === 0) return text('No memories yet.');
        return text(entries.map(entryLine).join('\n\n'));
      },
    },
    {
      name: 'memory_tags',
      title: 'List tags',
      description: 'List all tags in the store with their usage counts.',
      inputSchema: schema({}),
      handler: () => {
        const tags = store.tags();
        if (tags.length === 0) return text('No tags yet.');
        return json(tags);
      },
    },
    {
      name: 'memory_normalize',
      title: 'Normalize',
      description:
        'Adopt hand-dropped markdown files that lack proper frontmatter: backfill ' +
        'missing id/title/created/updated in place (no renaming). Pass write=false ' +
        'for a dry run.',
      inputSchema: schema({
        write: { type: 'boolean', default: true, description: 'Apply changes (true) or preview only (false).' },
      }),
      handler: (args) => {
        const report = store.normalize({ write: args.write });
        if (report.length === 0) return text('All memories already canonical. Nothing to do.');
        const verb = args.write ? 'Normalized' : 'Would normalize';
        const lines = report.map((r) => `${r.file} → id ${r.id} (+${r.filledFields.join(', ')})`);
        return text(`${verb} ${report.length} file(s):\n${lines.join('\n')}`);
      },
    },
    {
      name: 'memory_reindex',
      title: 'Reindex',
      description: 'Rebuild the search index from the markdown files. Rarely needed.',
      inputSchema: schema({}),
      handler: () => {
        const index = store.reindex();
        return text(`Reindexed ${index.memories.length} memories.`);
      },
    },
  ];
}

// --- JSON-RPC dispatch ------------------------------------------------------

type JsonRpcId = string | number;
interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: any;
}
export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId | null; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId | null; error: { code: number; message: string } };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export interface MemoryServer {
  readonly tools: ToolDef[];
  /** Handle one decoded JSON-RPC message; returns the response, or undefined for notifications. */
  handle(message: unknown): JsonRpcResponse | undefined;
  /** Handle one raw line from the transport; returns the serialized response, if any. */
  handleLine(line: string): string | undefined;
}

/**
 * Build an MCP server exposing the memory store as tools. Transport-agnostic:
 * feed it messages with `handle`/`handleLine`, or use `serveStdio`.
 */
export function createServer(store: MemoryStore): MemoryServer {
  const { name, version } = pkgInfo();
  const tools = buildTools(store);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const ok = (id: JsonRpcId | null, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
  const fail = (id: JsonRpcId | null, code: number, message: string): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });

  function handle(message: unknown): JsonRpcResponse | undefined {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return fail(null, INVALID_REQUEST, 'Invalid request');
    }
    const req = message as JsonRpcRequest;
    const isNotification = req.id === undefined;
    // Notifications (notifications/initialized, notifications/cancelled, …) and
    // client responses need no reply.
    if (isNotification) return undefined;
    const id = req.id ?? null;
    if (typeof req.method !== 'string') return fail(id, INVALID_REQUEST, 'Invalid request');

    switch (req.method) {
      case 'initialize': {
        const requested = req.params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
        return ok(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, {
          tools: tools.map(({ name: n, title, description, inputSchema }) => ({ name: n, title, description, inputSchema })),
        });
      case 'tools/call': {
        const tool = byName.get(req.params?.name);
        if (!tool) return fail(id, INVALID_PARAMS, `Tool ${String(req.params?.name)} not found`);
        let args: Record<string, unknown>;
        try {
          args = validateArgs(tool.inputSchema, req.params?.arguments);
        } catch (err) {
          return ok(id, {
            content: [{ type: 'text', text: `Invalid arguments for tool ${tool.name}: ${(err as Error).message}` }],
            isError: true,
          });
        }
        try {
          return ok(id, tool.handler(args));
        } catch (err) {
          return ok(id, { content: [{ type: 'text', text: (err as Error).message }], isError: true });
        }
      }
      default:
        return fail(id, METHOD_NOT_FOUND, `Method not found: ${req.method}`);
    }
  }

  function handleLine(line: string): string | undefined {
    if (!line.trim()) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return JSON.stringify(fail(null, PARSE_ERROR, 'Parse error'));
    }
    if (Array.isArray(parsed)) {
      const responses = parsed.map(handle).filter((r): r is JsonRpcResponse => r !== undefined);
      return responses.length ? JSON.stringify(responses) : undefined;
    }
    const res = handle(parsed);
    return res ? JSON.stringify(res) : undefined;
  }

  return { tools, handle, handleLine };
}

/** Start the MCP server over stdio and resolve when stdin closes. */
export function serveStdio(store: MemoryStore): Promise<void> {
  const server = createServer(store);
  const { stdin, stdout } = process;
  stdin.setEncoding('utf8');
  let buffer = '';
  return new Promise((resolve) => {
    stdin.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        const out = server.handleLine(line);
        if (out !== undefined) stdout.write(`${out}\n`);
      }
    });
    stdin.on('end', () => resolve());
    stdin.on('close', () => resolve());
  });
}
