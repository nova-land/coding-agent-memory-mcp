import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pkgInfo } from './pkg.js';

export type ClientId = 'claude' | 'cursor' | 'copilot' | 'codex';

export const ALL_CLIENTS: ClientId[] = ['claude', 'cursor', 'copilot', 'codex'];

export interface InstallOptions {
  /** Project directory whose config files we write (defaults to cwd). */
  projectDir: string;
  /** Logical server name/key used in each client config. */
  serverName: string;
  /** The command to launch the server. */
  command: string;
  /** Arguments passed to the command. */
  args: string[];
  /** Optional env vars for the server process (e.g. MEMORY_MCP_ROOT). */
  env?: Record<string, string>;
}

export interface InstallResult {
  client: ClientId;
  file: string;
  action: 'created' | 'updated' | 'unchanged';
}

export const CLIENT_LABELS: Record<ClientId, string> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot (VS Code)',
  codex: 'Codex CLI',
};

/** Default invocation that works once the package is published to npm. */
export function defaultInvocation(storeRoot?: string): Pick<InstallOptions, 'command' | 'args' | 'env'> {
  return {
    command: 'npx',
    args: ['-y', pkgInfo().name, 'serve'],
    env: storeRoot ? { MEMORY_MCP_ROOT: storeRoot } : undefined,
  };
}

function readJson(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  } catch {
    return {};
  }
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function stdioEntry(opts: InstallOptions, withType: boolean): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (withType) entry.type = 'stdio';
  entry.command = opts.command;
  entry.args = opts.args;
  if (opts.env && Object.keys(opts.env).length) entry.env = opts.env;
  return entry;
}

function installJsonClient(
  client: ClientId,
  file: string,
  rootKey: 'mcpServers' | 'servers',
  withType: boolean,
  opts: InstallOptions,
): InstallResult {
  const existed = existsSync(file);
  const config = readJson(file);
  const before = JSON.stringify(config[rootKey]?.[opts.serverName] ?? null);
  config[rootKey] = config[rootKey] ?? {};
  config[rootKey][opts.serverName] = stdioEntry(opts, withType);
  const after = JSON.stringify(config[rootKey][opts.serverName]);
  writeJson(file, config);
  return {
    client,
    file,
    action: !existed ? 'created' : before === after ? 'unchanged' : 'updated',
  };
}

/** Render the codex TOML block for our server. */
function codexBlock(opts: InstallOptions): string {
  const lines = [`[mcp_servers.${opts.serverName}]`];
  lines.push(`command = ${JSON.stringify(opts.command)}`);
  lines.push(`args = [${opts.args.map((a) => JSON.stringify(a)).join(', ')}]`);
  if (opts.env && Object.keys(opts.env).length) {
    const envInline = Object.entries(opts.env)
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join(', ');
    lines.push(`env = { ${envInline} }`);
  }
  return lines.join('\n');
}

/**
 * Inject/replace our server block in codex's TOML config without a full TOML
 * parser. We match the `[mcp_servers.<name>]` table and replace up to the next
 * top-level `[` table header (or EOF).
 */
function installCodex(file: string, opts: InstallOptions): InstallResult {
  const existed = existsSync(file);
  const block = codexBlock(opts);
  let content = existed ? readFileSync(file, 'utf8') : '';

  const header = `[mcp_servers.${opts.serverName}]`;
  const idx = content.indexOf(header);
  let action: InstallResult['action'];

  if (idx === -1) {
    const sep = content.length && !content.endsWith('\n\n') ? (content.endsWith('\n') ? '\n' : '\n\n') : '';
    content = `${content}${sep}${block}\n`;
    action = existed ? 'updated' : 'created';
  } else {
    // Find the end of this table: next line starting with '[' after the header.
    const rest = content.slice(idx + header.length);
    const nextTable = rest.search(/\n\[/);
    const end = nextTable === -1 ? content.length : idx + header.length + nextTable + 1;
    const replaced = content.slice(0, idx) + block + '\n' + content.slice(end);
    action = replaced === content ? 'unchanged' : 'updated';
    content = replaced;
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return { client: 'codex', file, action };
}

/** Compute the config file path for a client. */
export function configPathFor(client: ClientId, projectDir: string): string {
  switch (client) {
    case 'claude':
      return join(projectDir, '.mcp.json');
    case 'cursor':
      return join(projectDir, '.cursor', 'mcp.json');
    case 'copilot':
      return join(projectDir, '.vscode', 'mcp.json');
    case 'codex':
      return join(homedir(), '.codex', 'config.toml');
  }
}

/** Install the MCP server into a single client's config. */
export function installClient(client: ClientId, opts: InstallOptions): InstallResult {
  const file = configPathFor(client, opts.projectDir);
  switch (client) {
    case 'claude':
      // Claude Code reads project-scoped .mcp.json (key: mcpServers, no type field).
      return installJsonClient('claude', file, 'mcpServers', false, opts);
    case 'cursor':
      return installJsonClient('cursor', file, 'mcpServers', false, opts);
    case 'copilot':
      // VS Code uses "servers" with an explicit "type": "stdio".
      return installJsonClient('copilot', file, 'servers', true, opts);
    case 'codex':
      return installCodex(file, opts);
  }
}

export function installClients(clients: ClientId[], opts: InstallOptions): InstallResult[] {
  return clients.map((c) => installClient(c, opts));
}
