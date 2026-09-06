/* eslint-disable @typescript-eslint/no-require-imports -- Plain Node/GitHub Actions CommonJS entry point. */
// Do not print tool stdout/stderr: secret scanners may include matched values.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { install } = require('./tool.cjs');
const { assessImage, summary } = require('./image-policy.cjs');

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 600000, ...options });
  if (result.error || result.status !== 0) throw new Error('Security scan found an issue or could not complete');
  return result.stdout;
}
function safePath(file) {
  if (!file || path.isAbsolute(file) || file.includes('\\') || file.includes('\0') || file.includes('\ufffd') || file.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid scan path');
  }
  return file;
}
function indexEntries(text) {
  const seen = new Set();
  return text.split('\0').filter(Boolean).map(row => {
    const match = /^([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/.exec(row);
    if (!match || match[3] !== '0' || !['100644', '100755', '120000', '160000'].includes(match[1])) throw new Error('Unsupported or unmerged Git index entry');
    const file = safePath(match[4]);
    if (seen.has(file)) throw new Error('Duplicate Git index path');
    seen.add(file);
    return { mode: match[1], oid: match[2], file };
  });
}
async function materializeIndex(root, destination) {
  const entries = indexEntries(checked('git', ['ls-files', '--stage', '-z'], { cwd: root }));
  await fs.mkdir(destination);
  for (const entry of entries) {
    // Gitlinks name commits, not source blobs. Symlink blobs are scanned as plain text.
    if (entry.mode === '160000') continue;
    const bytes = checked('git', ['cat-file', 'blob', entry.oid], { cwd: root, encoding: null });
    const target = path.join(destination, entry.file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  }
}
async function materializeWorktree(root, destination) {
  const files = checked('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root }).split('\0').filter(Boolean);
  await fs.mkdir(destination);
  for (const file of new Set(files)) {
    const parts = safePath(file).split('/');
    let source = root, readable = true;
    for (let i = 0; i < parts.length; i++) {
      source = path.join(source, parts[i]);
      const stat = await fs.lstat(source).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; });
      if (!stat || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) { readable = false; break; }
    }
    if (!readable) continue;
    const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Working-tree file changed during scan');
      const target = path.join(destination, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, await handle.readFile(), { flag: 'wx', mode: 0o600 });
    } finally { await handle.close(); }
  }
}
function lockedPackages(text) {
  const expected = new Map();
  for (const match of text.matchAll(/^([a-zA-Z0-9_.-]+)==([^\s\\]+)\s*(?:\\)?$/gm)) {
    const name = match[1].toLowerCase().replaceAll('_', '-').replaceAll('.', '-');
    if (expected.has(name)) throw new Error('Duplicate locked package');
    expected.set(name, match[2]);
  }
  if (!expected.size) throw new Error('Missing locked Python dependency graph');
  return expected;
}
function coverage(report, expected, image = false) {
  if (!report || !Array.isArray(report.Results)) throw new Error('Invalid vulnerability report');
  if (report.Results.some(result => !result || (result.Vulnerabilities !== undefined && !Array.isArray(result.Vulnerabilities)) || (result.Packages !== undefined && !Array.isArray(result.Packages)))) throw new Error('Malformed dependency inventory');
  if (expected) {
    const results = report.Results.filter(r => r.Type === (image ? 'python-pkg' : 'pip'));
    const actual = new Map(results.flatMap(r => r.Packages ?? []).map(p => [p.Name.toLowerCase().replaceAll('_', '-').replaceAll('.', '-'), p.Version]));
    if (!actual.size || [...expected].some(([name, version]) => actual.get(name) !== version) || actual.size !== expected.size) {
      throw new Error('Incomplete or inconsistent Python dependency coverage');
    }
  }
}
function noAdvisories(report, expected, image = false) {
  coverage(report, expected, image);
  if (report.Results.some(r => r.Vulnerabilities?.length)) throw new Error('Dependency advisories require review');
}
async function scan(mode, image) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-notepad-security-scan-'));
  let tool;
  try {
    if (mode === 'secrets') {
      tool = await install('gitleaks');
      const args = ['--redact=100', '--ignore-gitleaks-allow', '--no-banner', '--exit-code=1', '--report-format=json', `--report-path=${path.join(dir, 'report.json')}`];
      checked(tool.bin, ['git', ...args, '--log-opts=--all', '.']);
      const root = await fs.realpath('.');
      const index = path.join(dir, 'index');
      await materializeIndex(root, index);
      checked(tool.bin, ['dir', ...args, index]);
      const current = path.join(dir, 'current');
      await materializeWorktree(root, current);
      checked(tool.bin, ['dir', ...args, current]);
    } else if (mode === 'dependencies' || mode === 'image') {
      if (mode === 'dependencies') {
        const report = JSON.parse(checked('bun', ['audit', '--json']));
        if (!report || Array.isArray(report) || Object.keys(report).length) throw new Error('Bun advisories require review');
      }
      tool = await install('trivy');
      const output = path.join(dir, 'dependencies.json');
      // Trivy errors still fail; findings are evaluated from the complete JSON below.
      const args = ['--scanners=vuln', '--exit-code=0', '--list-all-pkgs', '--format=json', `--output=${output}`];
      // Run outside the checkout so repository .trivyignore/config files cannot hide findings.
      const trivyOptions = { cwd: dir, env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('TRIVY_'))), TRIVY_CACHE_DIR: path.join(dir, 'cache') } };
      if (mode === 'image') {
        if (!image || !/^[a-zA-Z0-9][a-zA-Z0-9/_.:@-]+$/.test(image)) throw new Error('Invalid image reference');
        const saved = path.join(dir, 'image.tar');
        checked('docker', ['image', 'save', '--output', saved, image]);
        checked(tool.bin, ['image', ...args, '--input', saved], trivyOptions);
      } else checked(tool.bin, ['fs', ...args, path.resolve('services/embeddings')], trivyOptions);
      const expected = lockedPackages(await fs.readFile('services/embeddings/requirements.txt', 'utf8'));
      const report = JSON.parse(await fs.readFile(output, 'utf8'));
      if (mode === 'image') {
        let policy;
        try { policy = JSON.parse(await fs.readFile(path.join(__dirname, 'image-advisories.json'), 'utf8')); } catch { policy = null; }
        const assessment = assessImage(report, policy);
        const visible = summary(assessment);
        console.log(visible);
        if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, visible + '\n');
        coverage(report, expected, true);
        if (assessment.policyError || assessment.rejected) throw new Error('Image findings require review');
      } else noAdvisories(report, expected);
    } else throw new Error('Unknown security scan');
    console.log(`${mode}: security scan passed`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    if (tool) await fs.rm(tool.dir, { recursive: true, force: true });
  }
}
if (require.main === module) scan(process.argv[2], process.argv[3]).catch(() => {
  console.error('Security scan failed: finding, invalid report, or tool/network error. No matched values were logged.');
  process.exitCode = 1;
});
module.exports = { checked, noAdvisories, lockedPackages, coverage, indexEntries, materializeIndex, materializeWorktree };
