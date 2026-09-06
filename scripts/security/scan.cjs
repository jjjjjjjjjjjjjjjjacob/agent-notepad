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
function noAdvisories(report, requirePython = false) {
  if (!report || !Array.isArray(report.Results)) throw new Error('Invalid vulnerability report');
  if (requirePython && !report.Results.some(r => r.Type === 'pip' && r.Packages?.length >= 3)) throw new Error('Python dependency graph was not scanned');
  if (report.Results.some(r => r.Vulnerabilities?.length)) throw new Error('Dependency advisories require review');
}
async function scan(mode, image) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-notepad-security-scan-'));
  let tool;
  try {
    if (mode === 'secrets') {
      tool = await install('gitleaks');
      const args = ['--redact=100', '--no-banner', '--exit-code=1', '--report-format=json', `--report-path=${path.join(dir, 'report.json')}`];
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
        checked(tool.bin, ['image', ...args, image]);
      } else checked(tool.bin, ['fs', ...args, 'services/embeddings']);
      noAdvisories(JSON.parse(await fs.readFile(output, 'utf8')), true);
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
module.exports = { checked, noAdvisories };
