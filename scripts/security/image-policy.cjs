const DAY = 86400000;
const SEVERITY = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const FIELDS = ['cve', 'distro', 'expiresAt', 'maximumSeverity', 'package', 'rationale', 'reviewedAt', 'source', 'version'];
const key = entry => [entry.distro, entry.package, entry.version, entry.cve].join('\0');
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid advisory review date');
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error('Invalid calendar date');
  return time;
}
function reviewedEntries(policy, now = Date.now()) {
  if (!Number.isFinite(now) || !policy || Object.keys(policy).sort().join(',') !== 'entries,schemaVersion' || policy.schemaVersion !== 1 || !Array.isArray(policy.entries)) throw new Error('Malformed image advisory policy');
  const entries = new Map();
  for (const entry of policy.entries) {
    if (!entry || Object.keys(entry).sort().join(',') !== FIELDS.join(',') ||
        !/^debian:\d+(?:\.\d+)?$/.test(entry.distro) ||
        typeof entry.package !== 'string' || !/^[a-z0-9][a-z0-9+.-]*$/.test(entry.package) ||
        typeof entry.version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:~+.\-]*$/.test(entry.version) ||
        !/^CVE-\d{4}-\d{4,}$/.test(entry.cve) ||
        !['LOW', 'MEDIUM'].includes(entry.maximumSeverity) ||
        entry.source !== `https://security-tracker.debian.org/tracker/${entry.cve}` ||
        typeof entry.rationale !== 'string' || entry.rationale.trim().length < 40 || entry.rationale.length > 3000) {
      throw new Error('Malformed or unsupported image advisory entry');
    }
    const reviewed = date(entry.reviewedAt), expires = date(entry.expiresAt);
    // Expiry is exclusive at midnight UTC. A later review is never inferred.
    if (reviewed > now || expires <= reviewed || expires - reviewed > 30 * DAY || expires <= now) throw new Error('Image advisory review is future-dated, expired, or exceeds 30 days');
    if (entries.has(key(entry))) throw new Error('Duplicate image advisory entry');
    entries.set(key(entry), entry);
  }
  return entries;
}
function assessImage(report, policy, now = Date.now()) {
  if (!report || !Array.isArray(report.Results) || typeof report.Metadata?.OS?.Family !== 'string' || typeof report.Metadata?.OS?.Name !== 'string') throw new Error('Missing image distribution inventory');
  if (!report.Results.some(result => result.Type === 'debian' && Array.isArray(result.Packages) && result.Packages.length > 0)) throw new Error('Missing Debian package inventory');
  // Even a stale unused exception requires review/removal; no silent renewals.
  let reviewed, policyError;
  try { reviewed = reviewedEntries(policy, now); } catch (error) { reviewed = new Map(); policyError = error.message; }
  const distro = `${report.Metadata.OS.Family}:${report.Metadata.OS.Name}`;
  const rows = [];
  for (const result of report.Results) {
    if (result.Vulnerabilities !== undefined && !Array.isArray(result.Vulnerabilities)) throw new Error('Malformed image vulnerability inventory');
    for (const finding of result.Vulnerabilities ?? []) {
      const row = { distro, package: finding.PkgName, version: finding.InstalledVersion, cve: finding.VulnerabilityID, severity: finding.Severity, accepted: false, reason: 'Unreviewed finding' };
      const entry = reviewed.get(key(row));
      if (policyError) row.reason = 'Advisory policy invalid or expired; review required';
      else if (result.Type !== 'debian') row.reason = 'Python and other ecosystems remain strict';
      else if (!['LOW', 'MEDIUM'].includes(row.severity)) row.reason = 'Unknown, high, or critical severity cannot be excepted';
      else if (finding.FixedVersion !== undefined && (typeof finding.FixedVersion !== 'string' || finding.FixedVersion.trim())) row.reason = 'A fixed version is available or fix metadata is malformed';
      else if (entry && SEVERITY[row.severity] > SEVERITY[entry.maximumSeverity]) row.reason = 'Severity exceeds the reviewed maximum';
      else if (entry) { row.accepted = true; row.reason = `Temporary residual risk accepted until ${entry.expiresAt} 00:00 UTC`; }
      rows.push(row);
    }
  }
  return { rows, policyError, accepted: rows.filter(row => row.accepted).length, rejected: rows.filter(row => !row.accepted).length };
}
function summary(assessment) {
  const safe = value => String(value ?? 'missing').replace(/[^a-zA-Z0-9 :./+_~()-]/g, '?').slice(0, 250);
  return [
    `Image advisories: ${assessment.rows.length} total; ${assessment.accepted} temporarily accepted; ${assessment.rejected} rejected.`,
    '', '| Distribution | Package | Version | CVE | Severity | Decision |', '|---|---|---|---|---|---|',
    ...assessment.rows.map(row => `| ${[row.distro, row.package, row.version, row.cve, row.severity, row.reason].map(safe).join(' | ')} |`),
    ...(assessment.policyError ? ['', 'Advisory policy is invalid or expired; the check fails even if no findings remain.'] : []),
    '', 'Accepted rows remain findings. They are not proven unreachable or false positives.',
  ].join('\n');
}
module.exports = { reviewedEntries, assessImage, summary };
