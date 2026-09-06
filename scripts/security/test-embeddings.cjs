/* eslint-disable @typescript-eslint/no-require-imports -- Plain Node/GitHub Actions CommonJS entry point. */
// Local Docker only. Ephemeral credential stays in child environment, never argv/logs.
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const image = process.argv[2];
const name = `agent-notepad-test-${randomBytes(8).toString('hex')}`;
const token = randomBytes(32).toString('hex');
function docker(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 180000, ...options });
  if (result.status !== 0) throw new Error('Embedding container check failed');
  return result.stdout;
}
(async () => {
  if (!image || !/^[a-zA-Z0-9][a-zA-Z0-9/_.:@-]+$/.test(image)) throw new Error('Invalid image');
  try {
    // No external network: both HTTP tests and model load run inside this container.
    docker(['run', '-d', '--name', name, '--platform', 'linux/amd64', '--network=none',
      '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--memory=2g', '--cpus=2',
      '-e', 'EMBEDDING_SERVICE_TOKEN', image], { env: { ...process.env, EMBEDDING_SERVICE_TOKEN: token } });
    let ready = false;
    for (let n = 0; n < 60; n++) {
      const result = spawnSync('docker', ['exec', name, 'python', '-c', "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2)"], { stdio: 'pipe', timeout: 5000 });
      if (result.status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error('Offline startup failed');
    const output = docker(['exec', name, 'python', 'test_service.py']);
    // The service test prints no credentials; preserve only a fixed success summary.
    if (output.includes(token)) throw new Error('Unexpected credential in test output');
    console.log('Embedding tests passed: offline startup, real vectors, auth, batch/model bounds, complete windows.');
  } finally { spawnSync('docker', ['rm', '-f', name], { stdio: 'pipe', timeout: 30000 }); }
})().catch(() => { console.error('Embedding image validation failed; no credentials or container logs printed.'); process.exitCode = 1; });
