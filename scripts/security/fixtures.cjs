/* eslint-disable @typescript-eslint/no-require-imports -- Plain Node security validation. */
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { install } = require('./tool.cjs');
(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-notepad-fixtures-'));
  const tools = [];
  try {
    const gitleaks = await install('gitleaks'); tools.push(gitleaks);
    const secret = ['gh', 'p_'].join('') + randomBytes(18).toString('hex');
    const input = path.join(dir, 'secret'); await fs.mkdir(input);
    await fs.writeFile(path.join(input, 'example.txt'), `token=${secret}\n`, { mode: 0o600 });
    const output = path.join(dir, 'redacted.json');
    const result = spawnSync(gitleaks.bin, ['dir', '--redact=100', '--no-banner', '--report-format=json', `--report-path=${output}`, input], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    const report = await fs.readFile(output, 'utf8');
    assert.ok(JSON.parse(report).length > 0);
    assert.ok(![report, result.stdout, result.stderr].some(text => text.includes(secret)));
    const trivy = await install('trivy'); tools.push(trivy);
    const dependencies = path.join(dir, 'dependencies'); await fs.mkdir(dependencies);
    await fs.writeFile(path.join(dependencies, 'requirements.txt'), 'requests==2.19.1\n');
    const vulnerable = path.join(dir, 'vulnerable.json');
    const scan = spawnSync(trivy.bin, ['fs', '--scanners=vuln', '--exit-code=1', '--format=json', `--output=${vulnerable}`, dependencies], { encoding: 'utf8', timeout: 600000 });
    assert.equal(scan.status, 1);
    assert.ok(JSON.parse(await fs.readFile(vulnerable, 'utf8')).Results.some(r => r.Vulnerabilities?.length));
    console.log('Live fixtures passed: synthetic secret detected/redacted; known vulnerable dependency rejected.');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    for (const tool of tools) await fs.rm(tool.dir, { recursive: true, force: true });
  }
})().catch(() => { console.error('Security fixture validation failed; no fixture values logged.'); process.exitCode = 1; });
