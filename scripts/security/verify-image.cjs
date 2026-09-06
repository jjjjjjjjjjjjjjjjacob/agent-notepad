/* eslint-disable @typescript-eslint/no-require-imports -- Plain Node security entry point. */
const fs = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { install } = require('./tool.cjs');
(async () => {
  const dockerfile = await fs.readFile('services/embeddings/Dockerfile', 'utf8');
  const matches = [...dockerfile.matchAll(/^FROM (gcr\.io\/distroless\/cc-debian13:nonroot@sha256:[a-f0-9]{64})$/gm)];
  if (matches.length !== 1) throw new Error('Expected one pinned Distroless runtime');
  const tool = await install('cosign');
  try {
    const result = spawnSync(tool.bin, ['verify', matches[0][1],
      '--certificate-oidc-issuer', 'https://accounts.google.com',
      '--certificate-identity', 'keyless@distroless.iam.gserviceaccount.com'], { encoding: 'utf8', timeout: 180000 });
    if (result.status !== 0) throw new Error('Distroless signature verification failed');
    const verified = JSON.parse(result.stdout);
    const digest = matches[0][1].split('@')[1];
    if (!Array.isArray(verified) || !verified.some(x => x.critical?.image?.['docker-manifest-digest'] === digest)) throw new Error('Verified digest mismatch');
    console.log(`Verified Distroless signature: ${digest}; documented Google identity and issuer.`);
  } finally { await fs.rm(tool.dir, { recursive: true, force: true }); }
})().catch(() => { console.error('Base signature verification failed (download, signature, identity, transparency, or network error).'); process.exitCode = 1; });
