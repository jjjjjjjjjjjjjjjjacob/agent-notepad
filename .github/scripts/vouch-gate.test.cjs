/* eslint-disable @typescript-eslint/no-require-imports -- Plain Node/GitHub Actions CommonJS entry point. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { trust, decision, finalize, REPOSITORY, MAINTAINER } = require('./vouch-gate.cjs');
const pr = (login = 'alice', overrides = {}) => ({ number: 1, state: 'open', draft: false, base: { ref: 'main' }, user: { login }, head: { sha: 'head-a' }, ...overrides });

test('explicit vouch, denial, draft, bot and collaborator exemptions', () => {
  const entries = trust('# policy\ngithub:alice\n-github:bob reason\n');
  assert.equal(decision([pr()], entries, 'vouched'), true);
  assert.equal(decision([pr('stranger')], entries, 'vouched'), false);
  assert.equal(decision([pr('bob')], entries, 'collaborator'), false);
  assert.equal(decision([pr('automation[bot]')], entries, 'bot'), false);
  assert.equal(decision([pr('alice', { draft: true })], entries, 'vouched'), false);
  assert.equal(decision([pr()], entries, ''), false);
  assert.equal(decision([pr()], entries, 'unknown'), false);
  assert.equal(decision([pr()], entries, 'denounced'), false);
  assert.equal(decision([pr(), pr('stranger')], entries, 'vouched'), false);
});
test('malformed, duplicate and empty lists fail closed', () => {
  for (const text of ['', '# empty', 'github:alice\n-github:ALICE', 'alice', 'github:bad/name']) {
    assert.throws(() => trust(text));
  }
});

function fixture({ contents = 'github:alice', fileError = false, prs, heads = [], bases = [], drafts = [], targets = [] } = {}) {
  const statuses = [], contentRequests = [], failures = [], notices = [];
  let headCalls = 0, baseCalls = 0;
  const github = {
    paginate: async () => prs ?? [pr()],
    rest: {
      repos: {
        createCommitStatus: async data => statuses.push(data),
        getBranch: async () => ({ data: { commit: { sha: bases[baseCalls++] ?? 'base-a' } } }),
        getContent: async data => {
          contentRequests.push(data);
          if (fileError) throw new Error('API unavailable');
          return { data: { type: 'file', encoding: 'base64', content: Buffer.from(contents).toString('base64') } };
        },
      },
      pulls: {
        get: async () => {
          const index = headCalls++;
          return { data: pr('alice', { head: { sha: heads[index] ?? 'head-a' }, base: { ref: targets[index] ?? 'main' }, draft: drafts[index] ?? false }) };
        },
        list: () => {},
      },
    },
  };
  const [owner, repo] = REPOSITORY.split('/');
  const args = { github, context: { repo: { owner, repo }, runId: 7 }, core: { setFailed: msg => failures.push(msg), notice: msg => notices.push(msg) },
    snapshot: { number: 1, author: 'alice', sha: 'head-a', base: 'base-a' }, actionStatus: 'vouched' };
  return { args, statuses, contentRequests, failures, notices };
}
test('reads canonical base only, ignoring any fork self-vouch', async () => {
  const f = fixture(); await finalize(f.args);
  assert.equal(f.contentRequests[0].ref, 'base-a');
  assert.equal(`${f.contentRequests[0].owner}/${f.contentRequests[0].repo}`, REPOSITORY);
  assert.equal(f.statuses.at(-1).sha, 'head-a');
  assert.equal(f.statuses.at(-1).state, 'success');
});
test('canonical trust removal overrides successful upstream output', async () => {
  const f = fixture({ contents: 'github:someone-else' }); await finalize(f.args);
  assert.equal(f.statuses.at(-1).state, 'failure');
  assert.equal(f.failures.length, 1);
});
test('maintainer-triggered refreshes succeed while denied PRs retain failing trust statuses', async () => {
  for (const actionStatus of ['vouched', 'collaborator', 'bot', 'unknown', 'denounced']) {
    const f = fixture({ contents: 'github:someone-else' });
    f.args.triggeringActor = MAINTAINER;
    f.args.actionStatus = actionStatus;
    await finalize(f.args);
    assert.equal(f.statuses.at(-1).state, 'failure');
    assert.equal(f.failures.length, 0);
    assert.equal(f.notices.length, 1);
  }
  const draft = fixture({ drafts: [true, true, true], prs: [pr('alice', { draft: true })] });
  draft.args.triggeringActor = MAINTAINER;
  await finalize(draft.args);
  assert.equal(draft.statuses.at(-1).state, 'failure');
  assert.equal(draft.failures.length, 0);
});
test('the original actor of a rerun cannot stand in for the current triggering actor', async () => {
  for (const triggeringActor of [undefined, '', 'someone-else']) {
    const f = fixture({ contents: 'github:someone-else' });
    f.args.context.actor = MAINTAINER;
    f.args.triggeringActor = triggeringActor;
    await finalize(f.args);
    assert.equal(f.statuses.at(-1).state, 'failure');
    assert.equal(f.failures.length, 1);
    assert.equal(f.notices.length, 0);
  }
});
test('maintainer refreshes still fail on unavailable evaluations, API errors and publication races', async () => {
  const unavailable = fixture();
  unavailable.args.triggeringActor = MAINTAINER;
  unavailable.args.actionStatus = 'unavailable';
  await finalize(unavailable.args);
  assert.equal(unavailable.statuses.at(-1).state, 'failure');
  assert.equal(unavailable.failures.length, 1);
  assert.equal(unavailable.notices.length, 0);
  for (const options of [{ fileError: true }, { bases: ['base-a', 'base-b'] }, { heads: ['head-a', 'head-a', 'head-b'] }]) {
    const f = fixture(options);
    f.args.triggeringActor = MAINTAINER;
    await assert.rejects(finalize(f.args));
    assert.equal(f.statuses.at(-1).state, 'error');
    assert.equal(f.notices.length, 0);
  }
});
test('dev PRs use canonical main trust and include same-head main PRs', async () => {
  const devPr = pr('alice', { base: { ref: 'dev' } });
  const f = fixture({ targets: ['dev', 'dev', 'dev'], prs: [devPr, pr('stranger')] });
  f.args.snapshot.target = 'dev';
  await finalize(f.args);
  assert.equal(f.contentRequests[0].ref, 'base-a');
  assert.equal(f.statuses.at(-1).state, 'failure');
  const trusted = fixture({ targets: ['dev', 'dev', 'dev'], prs: [devPr] });
  trusted.args.snapshot.target = 'dev';
  await finalize(trusted.args);
  assert.equal(trusted.statuses.at(-1).state, 'success');
});
test('retargeting between release and development branches invalidates the snapshot', async () => {
  for (const targets of [['main'], ['dev', 'main'], ['dev', 'dev', 'main']]) {
    const f = fixture({ targets });
    f.args.snapshot.target = 'dev';
    await assert.rejects(finalize(f.args));
    assert.equal(f.statuses.at(-1).state, 'error');
  }
});
test('missing file or API error publishes error', async () => {
  const f = fixture({ fileError: true }); await assert.rejects(finalize(f.args));
  assert.equal(f.statuses.at(-1).state, 'error');
});
test('head changes before validation fail on current head', async () => {
  const f = fixture({ heads: ['head-b'] }); await assert.rejects(finalize(f.args));
  assert.equal(f.statuses.at(-1).sha, 'head-b');
  assert.equal(f.statuses.at(-1).state, 'error');
});
test('trust version changes before publication never succeed', async () => {
  const f = fixture({ bases: ['base-a', 'base-b'] }); await assert.rejects(finalize(f.args));
  assert.equal(f.statuses.some(s => s.state === 'success'), false);
});
test('head race after publication invalidates old and new heads', async () => {
  const f = fixture({ heads: ['head-a', 'head-a', 'head-b'] }); await assert.rejects(finalize(f.args));
  assert.ok(f.statuses.some(s => s.sha === 'head-b' && s.state === 'pending'));
  assert.equal(f.statuses.at(-1).state, 'error');
});
test('trust race after publication invalidates success', async () => {
  const f = fixture({ bases: ['base-a', 'base-a', 'base-b'] }); await assert.rejects(finalize(f.args));
  assert.equal(f.statuses.at(-1).state, 'error');
});
test('conversion to draft before publication never succeeds', async () => {
  const f = fixture({ drafts: [false, true] }); await assert.rejects(finalize(f.args));
  assert.equal(f.statuses.some(s => s.state === 'success'), false);
  assert.equal(f.statuses.at(-1).state, 'error');
});
test('conversion to draft after publication invalidates success', async () => {
  const f = fixture({ drafts: [false, false, true] }); await assert.rejects(finalize(f.args));
  assert.equal(f.statuses.at(-1).state, 'error');
});
test('retargeted PR fails before validation or publication', async () => {
  for (const targets of [['other'], ['main', 'other']]) {
    const f = fixture({ targets }); await assert.rejects(finalize(f.args));
    assert.equal(f.statuses.some(s => s.state === 'success'), false);
    assert.equal(f.statuses.at(-1).state, 'error');
  }
});
test('retargeting after publication invalidates success', async () => {
  const f = fixture({ targets: ['main', 'main', 'other'] }); await assert.rejects(finalize(f.args));
  assert.equal(f.statuses.at(-1).state, 'error');
});
test('workflow pins actions and never checks out the PR head', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../workflows/vouch.yml'), 'utf8');
  const uses = [...source.matchAll(/^\s*(?:- )?uses:\s+(\S+)/gm)].map(match => match[1]);
  assert.ok(uses.length >= 3);
  assert.ok(uses.every(value => /@[a-f0-9]{40}$/.test(value)));
  assert.match(source, /ref: \$\{\{ matrix.base \}\}/);
  assert.doesNotMatch(source, /contents: write|pull-requests: write|issues: write|secrets\./);
  assert.equal([...source.matchAll(/^      pull-requests: read$/gm)].length, 3);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /types: \[[^\]]*\bedited\b/);
});

test('evaluation boundary accepts only bounded regular scalar data', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { readEvaluation } = require('./vouch-gate.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vouch-boundary-'));
  const file = path.join(dir, 'status.txt');
  try {
    for (const value of ['vouched', 'collaborator', 'bot', 'unknown', 'denounced']) {
      fs.writeFileSync(file, value);
      assert.equal(readEvaluation(file, true), value);
      assert.equal(readEvaluation(file, false), 'unavailable');
    }
    for (const value of ['vouched\n', '{"status":"vouched"}', 'vouched; process.exit(0)', 'x'.repeat(1000)]) {
      fs.writeFileSync(file, value); assert.equal(readEvaluation(file, true), 'unavailable');
    }
    fs.unlinkSync(file); fs.symlinkSync(__filename, file);
    assert.equal(readEvaluation(file, true), 'unavailable');
    assert.equal(readEvaluation(dir, true), 'unavailable');
    assert.equal(readEvaluation(path.join(dir, 'missing'), true), 'unavailable');
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('third-party evaluation has no write credential or publisher code', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../workflows/vouch.yml'), 'utf8');
  const evaluate = source.split('  evaluate:\n')[1].split('  publish:\n')[0];
  const publish = source.split('  publish:\n')[1];
  assert.doesNotMatch(evaluate, /: write|actions\/checkout|finalize/);
  assert.match(evaluate, /mitchellh\/vouch\/action\/check-user@/);
  assert.doesNotMatch(publish, /mitchellh|hustcer|\brun:/);
  assert.match(publish, /readEvaluation/);
  assert.match(publish, /needs.evaluate.result == 'success'/);
  assert.match(publish, /ref: \$\{\{ matrix.base \}\}/);
  assert.match(publish, /VOUCH_TRIGGERING_ACTOR: \$\{\{ github.triggering_actor \}\}/);
  assert.match(publish, /triggeringActor: process\.env\.VOUCH_TRIGGERING_ACTOR/);
});
