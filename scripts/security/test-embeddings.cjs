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
    docker(['exec', name, 'python', '-c', `
import hashlib, importlib.metadata, json, math, os, pathlib, re, sys, tempfile
from contextlib import ExitStack
from unittest.mock import patch
from fastembed.common.model_management import ModelManagement
from huggingface_hub.errors import LocalEntryNotFoundError
assert os.getuid() == 65532 and sys.version_info[:2] == (3, 12)
assert not pathlib.Path('/usr/local/lib/python3.12/ensurepip').exists()
normalize = lambda name: re.sub(r'[-_.]+', '-', name.lower())
expected = {normalize(name): version for name, version in re.findall(r'^([a-zA-Z0-9_.-]+)==([^\\s\\\\]+)', pathlib.Path('/app/requirements.txt').read_text(), re.M)}
actual = {normalize(item.metadata['Name']): item.version for item in importlib.metadata.distributions()}
assert actual == expected and 'pip' not in actual
manifest = json.loads(pathlib.Path('/usr/share/agent-notepad/runtime-packages.json').read_text())
assert {item['name'] for item in manifest['packages']} == {'libffi8', 'libbz2-1.0', 'liblzma5'}
for item in manifest['packages']:
    status = pathlib.Path('/var/lib/dpkg/status.d', item['name']).read_text()
    assert 'Version: ' + item['version'] in status
    for record in item['files']:
        file = pathlib.Path(record['path'])
        if 'sha256' in record: assert hashlib.sha256(file.read_bytes()).hexdigest() == record['sha256']
        else: assert str(file.readlink()) == record['symlink']
assert os.environ.get('HF_HUB_OFFLINE') == '1'
with ExitStack() as stack:
    guards = [stack.enter_context(patch.object(ModelManagement, method, side_effect=AssertionError('Unexpected FastEmbed download/archive helper'))) for method in (
        'decompress_to_cache', 'retrieve_model_gcs', 'download_file_from_gcs', 'download_files_from_huggingface',
    )]
    from engine import Engine
    vector = Engine().embed(['Harmless cached-model verification.'], 'document')['embeddings'][0]
    assert len(vector) == 384 and all(math.isfinite(value) for value in vector)
    assert abs(math.sqrt(sum(value * value for value in vector)) - 1) < 1e-5
    with tempfile.TemporaryDirectory(prefix='missing-model-') as empty_cache:
        with patch.dict(os.environ, {'MODEL_CACHE': empty_cache, 'HF_HUB_OFFLINE': '1'}):
            try:
                Engine()
            except LocalEntryNotFoundError:
                pass
            else:
                raise AssertionError('Missing offline model did not fail closed')
    # Also detect a helper invocation whose exception was swallowed upstream.
    for guard in guards:
        guard.assert_not_called()
`]);
    const output = docker(['exec', name, 'python', 'test_service.py']);
    // The service test prints no credentials; preserve only a fixed success summary.
    if (output.includes(token)) throw new Error('Unexpected credential in test output');
    console.log('Embedding tests passed: offline startup, exact package/provenance checks, no pip, download/archive bypass, missing-cache rejection, real vectors, auth, batch/model bounds, complete windows.');
  } finally { spawnSync('docker', ['rm', '-f', name], { stdio: 'pipe', timeout: 30000 }); }
})().catch(() => { console.error('Embedding image validation failed; no credentials or container logs printed.'); process.exitCode = 1; });
