/* eslint-disable @typescript-eslint/no-require-imports -- Plain Node/GitHub Actions CommonJS entry point. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { checked, noAdvisories, lockedPackages } = require('./scan.cjs');
const { verify } = require('./tool.cjs');

test('tool checksums reject tampered downloads', () => {
  const bytes = Buffer.from('verified tool');
  verify(bytes, createHash('sha256').update(bytes).digest('hex'));
  assert.throws(() => verify(Buffer.from('tampered'), createHash('sha256').update(bytes).digest('hex')));
});
test('scanner failures and missing tools fail closed without reproducing stdout', () => {
  assert.throws(() => checked(process.execPath, ['-e', "console.log('sensitive-example'); process.exit(1)"]), error => !error.message.includes('sensitive-example'));
  assert.throws(() => checked('/nonexistent-security-scanner', []));
});
test('dependency findings, absent graphs, and malformed results fail closed', () => {
  const expected = lockedPackages('requests==2.34.2\nfastapi==0.141.1\n');
  const packages = [{ Name: 'requests', Version: '2.34.2' }, { Name: 'fastapi', Version: '0.141.1' }];
  noAdvisories({ Results: [{ Type: 'pip', Packages: packages }] }, expected);
  noAdvisories({ Results: [{ Type: 'python-pkg', Packages: packages }] }, expected, true);
  assert.throws(() => noAdvisories({ Results: [{ Type: 'pip', Packages: packages.slice(0, 1) }] }, expected));
  assert.throws(() => noAdvisories({ Results: [{ Type: 'pip', Packages: [{ Name: 'requests', Version: 'wrong' }, packages[1]] }] }, expected));
  assert.throws(() => noAdvisories({ Results: [{ Type: 'pip', Packages: packages }] }, expected, true));
  assert.throws(() => noAdvisories({ Results: [{ Vulnerabilities: [{ VulnerabilityID: 'synthetic' }] }] }));
  for (const value of [null, {}, { Results: [] }]) assert.throws(() => noAdvisories(value, expected));
  assert.throws(() => lockedPackages('# empty'));
});
test('application workflows have only read authority and immutable actions', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync('.github/workflows/security.yml', 'utf8');
  assert.doesNotMatch(source, /pull_request_target|: write|secrets\.|persist-credentials: true/);
  for (const use of source.matchAll(/uses: (\S+)/g)) assert.match(use[1], /@[a-f0-9]{40}$/);
  assert.match(source, /bun-version: 1\.3\.14/);
  assert.match(source, /--frozen-lockfile/);
  assert.match(source, /--maxWorkers=1/);
});
