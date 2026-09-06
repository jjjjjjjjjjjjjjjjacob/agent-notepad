/* eslint-disable @typescript-eslint/no-require-imports -- Plain Node/GitHub Actions CommonJS entry point. */
// Release asset SHA-256 values verified against the official repositories.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const manifest = require('./tools.json');

function verify(bytes, expected) {
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Security tool checksum mismatch');
}
async function install(name) {
  const spec = manifest[name];
  const asset = spec?.[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error('Unsupported security tool or platform');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `agent-notepad-${name}-`));
  try {
    const response = await fetch(`https://github.com/${spec.repository}/releases/download/${spec.tag}/${asset[0]}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('Security tool download failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    verify(bytes, asset[1]);
    const archive = path.join(dir, 'tool.tar.gz');
    await fs.writeFile(archive, bytes, { mode: 0o600 });
    const extracted = spawnSync('tar', ['-xzf', archive, '-C', dir, asset[2]], { stdio: 'pipe' });
    if (extracted.status !== 0) throw new Error('Security tool extraction failed');
    return { bin: path.join(dir, asset[2]), dir };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}
if (require.main === module) {
  (async () => {
    const tool = await install(process.argv[2]);
    try {
      const result = spawnSync(tool.bin, process.argv.slice(3), { stdio: 'inherit' });
      process.exitCode = result.status ?? 1;
    } finally { await fs.rm(tool.dir, { recursive: true, force: true }); }
  })().catch(() => { console.error('Security tool unavailable (download, checksum, or execution error).'); process.exitCode = 1; });
}
module.exports = { install, verify };
