/* eslint-disable @typescript-eslint/no-require-imports -- Plain Node/GitHub Actions CommonJS entry point. */
// Do not print tool stdout/stderr: secret scanners may include matched values.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { install } = require('./tool.cjs');

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 600000, ...options });
  if (result.error || result.status !== 0) throw new Error('Security scan found an issue or could not complete');
  return result.stdout;
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
function noAdvisories(report, expected, image = false) {
  if (!report || !Array.isArray(report.Results)) throw new Error('Invalid vulnerability report');
  if (expected) {
    const results = report.Results.filter(r => r.Type === (image ? 'python-pkg' : 'pip'));
    const actual = new Map(results.flatMap(r => r.Packages ?? []).map(p => [p.Name.toLowerCase().replaceAll('_', '-').replaceAll('.', '-'), p.Version]));
    if (!actual.size || [...expected].some(([name, version]) => actual.get(name) !== version) || (!image && actual.size !== expected.size)) {
      throw new Error('Incomplete or inconsistent Python dependency coverage');
    }
  }
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
      // Include staged, unstaged, and new non-ignored files without ever reading .env/ignored files.
      const files = checked('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
      const current = path.join(dir, 'current');
      await fs.mkdir(current);
      for (const file of new Set(files)) {
        const stat = await fs.lstat(file).catch(() => null);
        if (!stat?.isFile()) continue;
        const destination = path.join(current, file);
        if (!destination.startsWith(current + path.sep)) throw new Error('Invalid tracked path');
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(file, destination);
      }
      checked(tool.bin, ['dir', ...args, current]);
    } else if (mode === 'dependencies' || mode === 'image') {
      if (mode === 'dependencies') {
        const report = JSON.parse(checked('bun', ['audit', '--json']));
        if (!report || Array.isArray(report) || Object.keys(report).length) throw new Error('Bun advisories require review');
      }
      tool = await install('trivy');
      const output = path.join(dir, 'dependencies.json');
      const args = ['--scanners=vuln', '--exit-code=1', '--list-all-pkgs', '--format=json', `--output=${output}`, '--ignorefile=/dev/null'];
      if (mode === 'image') {
        if (!image || !/^[a-zA-Z0-9][a-zA-Z0-9/_.:@-]+$/.test(image)) throw new Error('Invalid image reference');
        const saved = path.join(dir, 'image.tar');
        checked('docker', ['image', 'save', '--output', saved, image]);
        checked(tool.bin, ['image', ...args, '--input', saved]);
      } else checked(tool.bin, ['fs', ...args, 'services/embeddings']);
      const expected = lockedPackages(await fs.readFile('services/embeddings/requirements.txt', 'utf8'));
      noAdvisories(JSON.parse(await fs.readFile(output, 'utf8')), expected, mode === 'image');
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
module.exports = { checked, noAdvisories, lockedPackages };
