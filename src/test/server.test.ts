import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../store.js';
import { createServer } from '../server.js';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'memsrv-'));
  const store = new MemoryStore(join(dir, '.memory'));
  store.init();
  return { dir, store, server: createServer(store) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(server: ReturnType<typeof createServer>, name: string, args?: unknown): any {
  const res = server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `expected a result for ${name}`);
  return res.result;
}

test('initialize negotiates the protocol and announces tools', () => {
  const { dir, server } = fresh();
  try {
    const res = server.handle({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    assert.ok(res && 'result' in res);
    const r = res.result as { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } };
    assert.equal(r.protocolVersion, '2025-06-18');
    assert.ok(r.capabilities.tools);
    assert.equal(r.serverInfo.name, 'coding-agent-memory-mcp');

    const unknown = server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    assert.ok(unknown && 'result' in unknown);
    assert.equal((unknown.result as { protocolVersion: string }).protocolVersion, '2025-11-25');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools/list exposes all nine tools with JSON schemas', () => {
  const { dir, server } = fresh();
  try {
    const res = server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(res && 'result' in res);
    const tools = (res.result as { tools: { name: string; inputSchema: { type: string; required?: string[] } }[] }).tools;
    assert.deepEqual(
      tools.map((t) => t.name),
      [
        'memory_create',
        'memory_search',
        'memory_get',
        'memory_update',
        'memory_delete',
        'memory_list',
        'memory_tags',
        'memory_normalize',
        'memory_reindex',
      ],
    );
    for (const t of tools) assert.equal(t.inputSchema.type, 'object');
    assert.deepEqual(tools[0].inputSchema.required, ['title', 'content']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools/call creates, searches, gets, updates and deletes', () => {
  const { dir, server } = fresh();
  try {
    const created = call(server, 'memory_create', {
      title: 'Job queues retry with backoff',
      content: 'The workflow queue retries failed jobs. Queue depth is watched.',
      tags: ['workflow'],
    });
    const id = /Created memory (\S+)/.exec(created.content[0].text)![1];

    const found = call(server, 'memory_search', { query: 'queue' });
    assert.match(found.content[0].text, new RegExp(id.replace(/[/.]/g, '\\$&')));
    // Title "queues" is a substring hit (3), body has two whole-token "queue"/"Queue" hits (2).
    assert.match(found.content[0].text, /score 5 \(title, body\)/);

    assert.match(call(server, 'memory_search', { query: 'queu' }).content[0].text, /score 3 \(title\)/);
    assert.match(call(server, 'memory_search', { query: 'nothing-like-this' }).content[0].text, /No matching memories/);

    assert.match(call(server, 'memory_get', { id }).content[0].text, /title: Job queues retry with backoff/);
    assert.match(call(server, 'memory_update', { id, tags: ['ops'] }).content[0].text, /Updated memory/);
    assert.match(call(server, 'memory_search', { query: '', tags: ['ops'] }).content[0].text, /Job queues/);
    assert.match(call(server, 'memory_delete', { id }).content[0].text, /Deleted memory/);
    assert.match(call(server, 'memory_list', {}).content[0].text, /No memories yet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid tool arguments come back as a tool error, not a crash', () => {
  const { dir, server } = fresh();
  try {
    const missing = call(server, 'memory_create', { content: 'no title' });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /"title" is required/);

    const badLimit = call(server, 'memory_search', { query: 'x', limit: 0 });
    assert.equal(badLimit.isError, true);

    const badType = call(server, 'memory_normalize', { write: 'yes' });
    assert.equal(badType.isError, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON-RPC edge cases: notifications, unknown methods, bad JSON, unknown tool', () => {
  const { dir, server } = fresh();
  try {
    assert.equal(server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
    assert.equal(server.handleLine(''), undefined);

    const unknown = server.handle({ jsonrpc: '2.0', id: 9, method: 'resources/list' });
    assert.ok(unknown && 'error' in unknown);
    assert.equal(unknown.error.code, -32601);

    const parse = JSON.parse(server.handleLine('{not json')!);
    assert.equal(parse.error.code, -32700);

    const noTool = server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } });
    assert.ok(noTool && 'error' in noTool);
    assert.equal(noTool.error.code, -32602);

    const pong = JSON.parse(server.handleLine('{"jsonrpc":"2.0","id":"a","method":"ping"}')!);
    assert.deepEqual(pong, { jsonrpc: '2.0', id: 'a', result: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cached memories pick up edits made by another process', () => {
  const { dir, store } = fresh();
  try {
    const mem = store.create({ title: 'Cache me', content: 'first version' });
    assert.equal(store.search('first').length, 1);

    const abs = join(store.root, mem.file);
    writeFileSync(abs, `---\ntitle: Cache me\ntags: []\n---\n\nsecond version, longer body\n`, 'utf8');
    const later = new Date(Date.now() + 5000);
    utimesSync(abs, later, later);

    assert.equal(store.search('first').length, 0);
    assert.equal(store.search('second').length, 1);

    rmSync(abs);
    assert.equal(store.search('second').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
