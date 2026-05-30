# project-memory-mcp

> Portable, local-first, **markdown-based project memory** — one shared memory
> store used across **Claude Code, GitHub Copilot, Cursor, and Codex** via the
> Model Context Protocol (MCP).

Memories are plain markdown files committed alongside your code under
`.memory/`. Every AI tool on the project reads and writes the **same** memory,
so context, decisions, and conventions are shared by the whole team — and
versioned in git like everything else.

- 🧠 **Unified memory** across every MCP-capable AI coding tool
- 📝 **Markdown + YAML frontmatter** — human-readable, diff-friendly, git-native
- 🏷️ **Tagging + full-text search** with a rebuildable JSON index
- 💻 **Cross-platform CLI** (macOS / Linux / Windows, Node ≥ 18)
- 🔌 **One-command install** into Claude Code, Copilot, Cursor, and Codex
- 🚫 **No server, no database, no cloud** — 100% local files

---

## Install

```bash
npm install -g project-memory-mcp
# binaries: `memory-mcp` and the short alias `pmem`
```

Or run without installing:

```bash
npx -y project-memory-mcp <command>
```

## Quick start

```bash
# 1. Initialize a store in your repo (creates ./.memory/)
memory-mcp init

# 2. Wire it into your AI tools (writes each tool's MCP config)
memory-mcp install            # all four clients
memory-mcp install claude cursor   # or pick specific ones

# 3. Add a memory from the CLI…
memory-mcp add "Use Postgres for persistence" \
  --content "Chosen over SQLite for concurrent writes." \
  --tags architecture,database

# …or let your AI assistant call the MCP tools automatically.

# 4. Search / browse
memory-mcp search postgres
memory-mcp list --tag architecture
memory-mcp tags
```

Restart your AI tool after `install` so it picks up the new MCP server.

## How it's stored

```
your-repo/
└── .memory/
    ├── index.json                 # derived search index (rebuildable)
    └── memories/
        ├── use-postgres-for-persistence-01jabcd.md
        └── prefer-feature-flags-01jefgh.md
```

Each memory file:

```markdown
---
id: 01JABCD2EF3GH4JK5MN6PQ7RS8
title: Use Postgres for persistence
tags: [architecture, database]
created: 2026-05-30T18:00:00.000Z
updated: 2026-05-30T18:00:00.000Z
source: claude-code
---

We chose Postgres over SQLite for concurrent writes and richer indexing.
```

The markdown files are the **source of truth**; `index.json` is a cache you can
rebuild anytime with `memory-mcp reindex`. Commit `.memory/` to git to share
memory with your team.

## MCP tools exposed

When connected, the server exposes these tools to the AI agent:

| Tool | Purpose |
| --- | --- |
| `memory_create` | Store a new memory (title, content, tags, links) |
| `memory_search` | Ranked full-text + tag search |
| `memory_get` | Fetch one memory in full by id |
| `memory_update` | Edit an existing memory |
| `memory_delete` | Remove a memory |
| `memory_list` | List memories, optionally by tag |
| `memory_tags` | List all tags with counts |
| `memory_reindex` | Rebuild the search index |

## Client configuration

`memory-mcp install` writes the right config for each tool. You can also do it
by hand:

**Claude Code** — `.mcp.json` (project root):
```json
{
  "mcpServers": {
    "memory": { "command": "npx", "args": ["-y", "project-memory-mcp", "serve"] }
  }
}
```

**Cursor** — `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "memory": { "command": "npx", "args": ["-y", "project-memory-mcp", "serve"] }
  }
}
```

**GitHub Copilot (VS Code)** — `.vscode/mcp.json`:
```json
{
  "servers": {
    "memory": { "type": "stdio", "command": "npx", "args": ["-y", "project-memory-mcp", "serve"] }
  }
}
```

**Codex CLI** — `~/.codex/config.toml`:
```toml
[mcp_servers.memory]
command = "npx"
args = ["-y", "project-memory-mcp", "serve"]
```

Useful `install` flags:

- `memory-mcp install --print` — preview without writing anything
- `memory-mcp install --local` — point clients at your locally-built binary
- `memory-mcp install --root ./path/to/repo` — bind the server to a specific store (sets `MEMORY_MCP_ROOT`)
- `memory-mcp install --name projmem` — change the server key

## Store location resolution

The active `.memory` store is resolved in this order:

1. `--root <dir>` CLI flag
2. `MEMORY_MCP_ROOT` environment variable
3. Nearest `.memory/` directory walking up from the working directory
4. `./.memory` (created on first write)

## CLI reference

```
memory-mcp serve                 Run the MCP server over stdio
memory-mcp init                  Create the .memory store
memory-mcp add <title> [opts]    Add a memory (--content/--file/stdin, --tags, --links)
memory-mcp list [--tag --limit --json]
memory-mcp search [query...] [--tag --limit --json]
memory-mcp get <id> [--json]
memory-mcp update <id> [--title --content --file --tags --links]
memory-mcp delete <id>           (alias: rm)
memory-mcp tags [--json]
memory-mcp reindex
memory-mcp path                  Print resolved store directory
memory-mcp install [clients...]  Configure MCP clients
```

All commands accept `-r, --root <dir>`.

## Programmatic API

```ts
import { MemoryStore, resolveStoreDir } from 'project-memory-mcp';

const store = new MemoryStore(resolveStoreDir());
store.init();
const mem = store.create({ title: 'Hello', content: '...', tags: ['demo'] });
console.log(store.search('hello'));
```

## Develop & publish

```bash
npm install
npm run build       # tsc → dist/, makes the CLI executable
npm test            # node:test suite
npm run release     # build, pack, and npm publish (see scripts/publish.sh)

# preview a publish without pushing:
DRY_RUN=1 npm run release
# bump + publish:
scripts/publish.sh patch   # or minor / major
```

## License

MIT © chrisleebizz
