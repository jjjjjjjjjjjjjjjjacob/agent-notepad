/* eslint-disable @typescript-eslint/no-require-imports -- Plain Node security tests. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reviewedEntries, assessImage, summary } = require('./image-policy.cjs');
const NOW = Date.parse('2026-09-06T12:00:00Z');
const entry = { distro: 'debian:13.6', package: 'libc6', version: '2.41-12+deb13u3', cve: 'CVE-2026-5435', maximumSeverity: 'MEDIUM',
  source: 'https://security-tracker.debian.org/tracker/CVE-2026-5435', rationale: 'Reviewed temporary residual risk; native reachability is not proven absent.', reviewedAt: '2026-09-06', expiresAt: '2026-10-06' };
const baseline = entries => ({ schemaVersion: 1, entries: entries ?? [{ ...entry }] });
const finding = overrides => ({ PkgName: entry.package, InstalledVersion: entry.version, VulnerabilityID: entry.cve, Severity: 'MEDIUM', ...overrides });
const report = (findings, type = 'debian', distro = '13.6') => ({ Metadata: { OS: { Family: 'debian', Name: distro } }, Results: [
  { Type: 'debian', Packages: [{ Name: entry.package, Version: entry.version }], Vulnerabilities: type === 'debian' ? findings : [] },
  ...(type === 'debian' ? [] : [{ Type: type, Vulnerabilities: findings }]),
] });

test('exact reviewed image finding remains visible with counts and expiry', () => {
  const assessment = assessImage(report([finding()]), baseline(), NOW);
  assert.equal(assessment.accepted, 1); assert.equal(assessment.rejected, 0); assert.equal(assessment.rows.length, 1);
  assert.match(summary(assessment), /CVE-2026-5435/); assert.match(summary(assessment), /2026-10-06/);
  assert.match(summary(assessment), /1 total; 1 temporarily accepted; 0 rejected/);
});
test('new CVE/package/version/distribution and non-OS findings cannot use the baseline', () => {
  for (const overrides of [{ VulnerabilityID: 'CVE-2026-99999' }, { PkgName: 'other' }, { InstalledVersion: '2.41-new' }]) {
    assert.equal(assessImage(report([finding(overrides)]), baseline(), NOW).rejected, 1);
  }
  assert.equal(assessImage(report([finding()], 'debian', '13.7'), baseline(), NOW).rejected, 1);
  assert.equal(assessImage(report([finding()], 'python-pkg'), baseline(), NOW).rejected, 1);
});
test('fixable, high, critical, unknown and increased severity are rejected', () => {
  for (const overrides of [{ FixedVersion: '2.42' }, { FixedVersion: null }, { Severity: 'HIGH' }, { Severity: 'CRITICAL' }, { Severity: 'UNKNOWN' }, { Severity: null }]) {
    assert.equal(assessImage(report([finding(overrides)]), baseline(), NOW).rejected, 1);
  }
  assert.equal(assessImage(report([finding()]), baseline([{ ...entry, maximumSeverity: 'LOW' }]), NOW).rejected, 1);
  assert.equal(assessImage(report([finding({ Severity: 'LOW' })]), baseline(), NOW).accepted, 1);
});
test('expiry is exclusive UTC midnight; invalid policies never hide findings', () => {
  assert.equal(assessImage(report([finding()]), baseline(), Date.parse('2026-10-05T23:59:59Z')).accepted, 1);
  const expired = assessImage(report([finding()]), baseline(), Date.parse('2026-10-06T00:00:00Z'));
  assert.equal(expired.rejected, 1); assert.ok(expired.policyError); assert.match(summary(expired), /CVE-2026-5435/);
  assert.ok(assessImage(report([]), baseline(), Date.parse('2026-10-06T00:00:00Z')).policyError);
});
test('duplicate, malformed, future, inverted and overlong review records fail closed', () => {
  const bad = [
    baseline([entry, entry]), null, { entries: [entry] },
    ...[{ maximumSeverity: 'HIGH' }, { rationale: '' }, { source: 'https://example.invalid' }, { expiresAt: '2026-02-30' },
      { expiresAt: '2026-10-07' }, { expiresAt: '2026-09-06' }, { reviewedAt: '2026-09-07' }, { reviewedAt: '2026-09-6' }, { extra: true }].map(overrides => baseline([{ ...entry, ...overrides }])),
  ];
  for (const policy of bad) {
    assert.throws(() => reviewedEntries(policy, NOW));
    const assessment = assessImage(report([finding(), finding({ VulnerabilityID: 'CVE-2026-99999' })]), policy, NOW);
    assert.equal(assessment.rows.length, 2); assert.equal(assessment.rejected, 2);
  }
});
test('committed baseline retains all 21 findings and rejects any new or fixable row', () => {
  const policy = require('./image-advisories.json');
  assert.equal(reviewedEntries(policy, NOW).size, 21);
  const rows = policy.entries.map(e => ({ PkgName: e.package, InstalledVersion: e.version, VulnerabilityID: e.cve, Severity: e.maximumSeverity }));
  const reviewed = assessImage(report(rows), policy, NOW);
  assert.equal(reviewed.accepted, 21); assert.equal(reviewed.rows.length, 21);
  assert.equal(rows.filter(r => r.Severity === 'MEDIUM').length, 14);
  assert.equal(rows.filter(r => r.Severity === 'LOW').length, 7);
  assert.equal(assessImage(report([...rows, finding({ VulnerabilityID: 'CVE-2026-99999' })]), policy, NOW).rejected, 1);
  assert.equal(assessImage(report([{ ...rows[0], FixedVersion: 'new' }, ...rows.slice(1)]), policy, NOW).rejected, 1);
});

test('complete Python coverage cannot substitute for absent or empty OS inventory', () => {
  const python = { Type: 'python-pkg', Packages: Array.from({ length: 36 }, (_, n) => ({ Name: `package-${n}`, Version: '1' })) };
  for (const os of [[], [{ Type: 'debian' }], [{ Type: 'debian', Packages: [] }]]) {
    assert.throws(() => assessImage({ Metadata: { OS: { Family: 'debian', Name: '13.6' } }, Results: [...os, python] }, baseline(), NOW), /Missing Debian package inventory/);
  }
});
