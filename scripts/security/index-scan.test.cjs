/* eslint-disable @typescript-eslint/no-require-imports -- Plain Node security validation. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { indexEntries, materializeIndex, materializeWorktree } = require('./scan.cjs');

async function repository(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-notepad-index-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repository'); await fs.mkdir(root);
  const git = (args, input) => {
    const result = spawnSync('git', args, { cwd: root, input, encoding: 'utf8' });
    assert.equal(result.status, 0);
    return result.stdout;
  };
  git(['init', '-q']);
  git(['-c', 'user.name=Security fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Clean fixture']);
  return { dir, root, git };
}

test('index snapshot preserves staged bytes after worktree overwrite/deletion and supports unusual safe paths', async t => {
  const { dir, root, git } = await repository(t);
  const names = ['--leading option.txt', 'sub directory/tab\tand newline\nfile.txt'];
  const original = Buffer.from([0, 1, 127, 255]);
  for (const name of names) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), original);
  }
  await fs.chmod(path.join(root, names[0]), 0o755);
  git(['add', '--', ...names]);
  await fs.writeFile(path.join(root, names[0]), 'Changed worktree');
  await fs.rm(path.join(root, names[1]));
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await fs.writeFile(path.join(root, 'ignored.txt'), 'Ignored fixture');
  await fs.writeFile(path.join(root, 'untracked.txt'), 'Untracked fixture');
  const index = path.join(dir, 'index'), current = path.join(dir, 'current');
  await materializeIndex(root, index);
  await materializeWorktree(root, current);
  for (const name of names) assert.deepEqual(await fs.readFile(path.join(index, name)), original);
  assert.equal(await fs.readFile(path.join(current, names[0]), 'utf8'), 'Changed worktree');
  await assert.rejects(fs.stat(path.join(current, names[1])), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(current, 'untracked.txt'), 'utf8'), 'Untracked fixture');
  await assert.rejects(fs.stat(path.join(current, 'ignored.txt')), { code: 'ENOENT' });
});

test('symlink blobs are plain text, worktree symlinks and ancestors are not followed, and gitlinks are skipped', async t => {
  const { dir, root, git } = await repository(t);
  const outside = path.join(dir, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'document.txt'), 'Outside fixture must not be copied');
  const folder = path.join(root, 'folder'); await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'document.txt'), 'Staged fixture');
  await fs.symlink(outside, path.join(root, 'link'));
  git(['add', '--', 'folder/document.txt', 'link']);
  git(['update-index', '--add', '--cacheinfo', `160000,${git(['rev-parse', 'HEAD']).trim()},submodule`]);
  await fs.rm(folder, { recursive: true });
  await fs.symlink(outside, folder);
  const index = path.join(dir, 'index'), current = path.join(dir, 'current');
  await materializeIndex(root, index);
  await materializeWorktree(root, current);
  assert.equal(await fs.readFile(path.join(index, 'link'), 'utf8'), outside);
  assert.equal((await fs.lstat(path.join(index, 'link'))).isFile(), true);
  assert.equal(await fs.readFile(path.join(index, 'folder/document.txt'), 'utf8'), 'Staged fixture');
  for (const name of ['link', 'folder', 'submodule']) await assert.rejects(fs.stat(path.join(current, name)), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(index, 'submodule')), { code: 'ENOENT' });
});

test('actual unmerged index fails before materialization', async t => {
  const { dir, root, git } = await repository(t);
  const oid = git(['hash-object', '-w', '--stdin'], 'Harmless merge fixture').trim();
  git(['update-index', '--index-info'], `100644 ${oid} 1\tconflict.txt\n100644 ${oid} 2\tconflict.txt\n100644 ${oid} 3\tconflict.txt\n`);
  const destination = path.join(dir, 'index');
  await assert.rejects(materializeIndex(root, destination), /unmerged/);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});

test('invalid modes, stages and escaping index paths fail closed', () => {
  const oid = 'a'.repeat(40);
  for (const row of [
    `040000 ${oid} 0\tdirectory`, `100644 ${oid} 1\tconflict`,
    `100644 ${oid} 0\t../outside`, `100644 ${oid} 0\t/absolute`,
    `100644 ${oid} 0\ta/../outside`, `100644 ${oid} 0\ta//b`,
    `100644 ${oid} 0\ta\\b`, `100644 invalid 0\tfile`,
    `100644 ${oid} 0\tduplicate\0` + `100644 ${oid} 0\tduplicate`,
  ]) assert.throws(() => indexEntries(row + '\0'));
});
