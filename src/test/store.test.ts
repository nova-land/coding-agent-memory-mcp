import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../store.js';
import { serializeMemory, parseMemory } from '../markdown.js';
import { slugify, normalizeTags, generateId } from '../util.js';

function freshStore(): { store: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'memtest-'));
  const store = new MemoryStore(join(dir, '.memory'));
  store.init();
  return { store, dir };
}

test('create + get round-trips content and metadata', () => {
  const { store, dir } = freshStore();
  try {
    const mem = store.create({
      title: 'Use Postgres for persistence',
      content: 'We chose Postgres over SQLite for concurrent writes.',
      tags: ['Architecture', 'database', 'architecture'],
    });
    assert.ok(mem.id);
    assert.deepEqual(mem.tags, ['architecture', 'database']); // normalized + deduped
    const got = store.get(mem.id);
    assert.equal(got?.title, 'Use Postgres for persistence');
    assert.match(got!.content, /concurrent writes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('timestamps survive disk round-trip as ISO strings', () => {
  const { store, dir } = freshStore();
  try {
    const mem = store.create({ title: 'T', content: 'c' });
    const reloaded = store.get(mem.id)!;
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
    assert.match(reloaded.created, iso);
    assert.match(reloaded.updated, iso);
    assert.equal(reloaded.created, mem.created);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('search ranks title and tag matches above body matches', () => {
  const { store, dir } = freshStore();
  try {
    store.create({ title: 'Postgres setup', content: 'connection pooling notes', tags: ['database'] });
    store.create({ title: 'Frontend routing', content: 'we briefly mention postgres here', tags: ['ui'] });
    const results = store.search('postgres');
    assert.equal(results.length, 2);
    assert.equal(results[0].entry.title, 'Postgres setup');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tag filter browse mode returns all matching, newest first', () => {
  const { store, dir } = freshStore();
  try {
    store.create({ title: 'A', content: 'x', tags: ['keep'] });
    store.create({ title: 'B', content: 'y', tags: ['keep'] });
    store.create({ title: 'C', content: 'z', tags: ['other'] });
    const results = store.search('', { tags: ['keep'] });
    assert.equal(results.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('update changes fields and bumps updated timestamp', () => {
  const { store, dir } = freshStore();
  try {
    const mem = store.create({ title: 'Old', content: 'a', tags: ['t1'] });
    const updated = store.update(mem.id, { title: 'New title', tags: ['t2'] });
    assert.equal(updated.title, 'New title');
    assert.deepEqual(updated.tags, ['t2']);
    assert.equal(store.get(mem.id)?.title, 'New title');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delete removes the memory', () => {
  const { store, dir } = freshStore();
  try {
    const mem = store.create({ title: 'Temp', content: 'a' });
    assert.equal(store.delete(mem.id), true);
    assert.equal(store.get(mem.id), undefined);
    assert.equal(store.delete(mem.id), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reads hand-dropped files from nested subfolders; id is the path', () => {
  const { store, dir } = freshStore();
  try {
    const nested = join(store.memoriesDir, 'architecture', 'db');
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, 'choice.md'),
      '---\ntitle: DB choice\ntags: [db]\n---\nPostgres, nested deep.\n',
    );
    // The id is derived from the path under memories/, using forward slashes.
    const got = store.get('architecture/db/choice');
    assert.equal(got?.title, 'DB choice');
    assert.ok(got?.file.includes('architecture'));
    assert.equal(store.search('postgres').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('create --folder yields a path id; update keeps path and id stable', () => {
  const { store, dir } = freshStore();
  try {
    const mem = store.create({ title: 'Routing rules', content: 'x', folder: 'Frontend/UI' });
    assert.equal(mem.id, 'frontend/ui/routing-rules');
    assert.equal(mem.file, 'memories/frontend/ui/routing-rules.md');
    const updated = store.update(mem.id, { title: 'New routing rules' });
    assert.equal(updated.id, mem.id); // id unchanged despite new title
    assert.equal(updated.file, mem.file); // file not renamed
    assert.equal(store.get(mem.id)?.title, 'New routing rules');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate titles get distinct path ids, never colliding', () => {
  const { store, dir } = freshStore();
  try {
    const a = store.create({ title: 'Setup', content: 'first' });
    const b = store.create({ title: 'Setup', content: 'second' });
    assert.equal(a.id, 'setup');
    assert.equal(b.id, 'setup-2');
    assert.equal(store.get('setup')?.content, 'first');
    assert.equal(store.get('setup-2')?.content, 'second');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no-frontmatter files get a path-based id and a title from the H1', () => {
  const { store, dir } = freshStore();
  try {
    writeFileSync(join(store.memoriesDir, 'runbook.md'), '# Deploy runbook\n\nk8s rolling.\n');
    writeFileSync(join(store.memoriesDir, 'note.md'), 'just a redis caching thought\n');
    const all = store.readAll();
    const ids = all.map((m) => m.id).sort();
    assert.deepEqual(ids, ['note', 'runbook']); // ids are the paths, unique
    // Title from first H1; addressable by path id.
    assert.equal(store.get('runbook')?.title, 'Deploy runbook');
    assert.equal(store.get('note')?.title, 'Note'); // from filename (no H1)
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalize backfills frontmatter in place without renaming', () => {
  const { store, dir } = freshStore();
  try {
    const p = join(store.memoriesDir, 'raw-note.md');
    writeFileSync(p, '# Caching strategy\n\nUse redis with TTL.\n');
    const preview = store.normalize({ write: false });
    assert.equal(preview.length, 1);
    assert.deepEqual(preview[0].filledFields.sort(), ['created', 'title', 'updated']);
    assert.equal(preview[0].id, 'raw-note'); // id is the path, reported as-is
    // Dry run did not touch the file.
    assert.equal(readFileSync(p, 'utf8').startsWith('# Caching'), true);

    store.normalize({ write: true });
    const after = readFileSync(p, 'utf8');
    assert.match(after, /^---/); // now has frontmatter
    assert.match(after, /title: Caching strategy/);
    assert.equal(existsSync(p), true); // same path, not renamed
    // Second pass is a no-op now that it's canonical.
    assert.equal(store.normalize({ write: false }).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reindex rebuilds from markdown files', () => {
  const { store, dir } = freshStore();
  try {
    store.create({ title: 'One', content: 'a' });
    store.create({ title: 'Two', content: 'b' });
    const index = store.reindex();
    assert.equal(index.memories.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markdown serialize/parse is stable', () => {
  const mem = parseMemory(
    serializeMemory({
      id: generateId(),
      title: 'Title: with colon',
      tags: ['a', 'b'],
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      content: 'Body line.\n\nSecond paragraph.',
      file: 'x.md',
    }),
    'x.md',
  );
  assert.equal(mem.title, 'Title: with colon');
  assert.deepEqual(mem.tags, ['a', 'b']);
  assert.match(mem.content, /Second paragraph/);
});

test('slugify and tag normalization', () => {
  assert.equal(slugify('Héllo, World! 123'), 'hello-world-123');
  assert.deepEqual(normalizeTags([' Foo', 'foo', '#Bar', '']), ['foo', 'bar']);
});
