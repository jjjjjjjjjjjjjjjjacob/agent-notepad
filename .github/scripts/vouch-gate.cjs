/* eslint-disable @typescript-eslint/no-require-imports -- Plain Node/GitHub Actions CommonJS entry point. */
// Executed only from the canonical main commit, never a pull request checkout.
const CONTEXT = 'Vouch / trusted contributor';
const MAINTAINER = 'jjjjjjjjjjjjjjjjacob';
const REPOSITORY = `${MAINTAINER}/agent-notepad`;

function trust(text) {
  const entries = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Deliberately restricted Trustdown: explicit GitHub accounts, one per line.
    const match = /^(-?)github:([a-z\d](?:[a-z\d-]*[a-z\d])?(?:\[bot\])?)(?:\s+.*)?$/i.exec(line);
    if (!match) throw new Error('Unsupported Trustdown entry');
    const login = match[2].toLowerCase();
    if (entries.has(login)) throw new Error('Duplicate Trustdown account');
    entries.set(login, !match[1]);
  }
  if (!entries.size) throw new Error('Trust list is empty');
  return entries;
}

function decision(prs, entries, actionStatus) {
  if (!prs.length) return false;
  if (!['vouched', 'collaborator', 'bot'].includes(actionStatus)) return false;
  // The canonical explicit list is mandatory even when upstream exempts bots
  // or collaborators. Shared head commits get the most restrictive decision.
  return prs.every(pr => !pr.draft && entries.get(pr.user.login.toLowerCase()) === true);
}

async function finalize({ github, context, core, snapshot, actionStatus, triggeringActor }) {
  if (`${context.repo.owner}/${context.repo.repo}` !== REPOSITORY) throw new Error('Unexpected repository');
  const repo = context.repo;
  const target = snapshot.target ?? 'main';
  const status = (sha, state, description) => github.rest.repos.createCommitStatus({
    ...repo, sha, state, context: CONTEXT, description,
    target_url: `https://github.com/${REPOSITORY}/actions/runs/${context.runId}`,
  });
  const head = async () => (await github.rest.repos.getBranch({ ...repo, branch: 'main' })).data.commit.sha;
  let currentSha = snapshot.sha;
  try {
    const pr = (await github.rest.pulls.get({ ...repo, pull_number: snapshot.number })).data;
    currentSha = pr.head.sha;
    if (pr.state !== 'open') return;
    if (!['main', 'dev'].includes(target) || currentSha !== snapshot.sha || pr.base.ref !== target || pr.user.login !== snapshot.author || await head() !== snapshot.base) {
      await status(currentSha, 'pending', 'PR head or main changed; rerun Vouch on current state');
      throw new Error('PR or trust snapshot changed');
    }
    const file = (await github.rest.repos.getContent({ ...repo, path: '.github/VOUCHED.td', ref: snapshot.base })).data;
    if (file.type !== 'file' || file.encoding !== 'base64') throw new Error('Trust file unavailable');
    const entries = trust(Buffer.from(file.content, 'base64').toString('utf8'));
    const all = await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', per_page: 100 });
    const sameHead = all.filter(p => ['main', 'dev'].includes(p.base.ref) && p.head.sha === currentSha);
    const eligible = decision(sameHead, entries, actionStatus);
    // Re-read both mutable inputs immediately before AND after publishing.
    const latest = (await github.rest.pulls.get({ ...repo, pull_number: snapshot.number })).data;
    if (latest.head.sha !== currentSha || latest.base.ref !== target || latest.draft !== pr.draft || latest.state !== 'open' || await head() !== snapshot.base) throw new Error('State changed before publication');
    await status(currentSha, eligible ? 'success' : 'failure', eligible
      ? 'Explicitly vouched author; Jacob alone may merge'
      : 'Draft, unknown, denounced, or unavailable Vouch result');
    const after = (await github.rest.pulls.get({ ...repo, pull_number: snapshot.number })).data;
    if (after.head.sha !== currentSha || after.base.ref !== target || after.draft !== pr.draft || after.state !== 'open' || await head() !== snapshot.base) {
      await status(currentSha, 'pending', 'Snapshot changed; recheck required');
      if (after.head.sha !== currentSha) await status(after.head.sha, 'pending', 'New PR head requires Vouch');
      throw new Error('State changed after publication');
    }
    if (!eligible) {
      const message = 'This PR is not eligible for merge under the Vouch policy.';
      // A maintainer refresh can successfully record a policy denial. This
      // changes the job outcome only; the PR's failure status remains intact.
      // Use the current triggering actor, not the original actor of a rerun.
      if (triggeringActor === MAINTAINER &&
          ['vouched', 'collaborator', 'bot', 'unknown', 'denounced'].includes(actionStatus)) {
        core.notice(message);
      } else {
        core.setFailed(message);
      }
    }
  } catch (error) {
    await status(currentSha, 'error', 'Vouch unavailable or state changed; maintainer recheck required');
    throw error;
  }
}
// Read at most a tiny regular scalar file; never load evaluator code or paths.
function readEvaluation(file, succeeded) {
  if (!succeeded) return 'unavailable';
  try {
    const fs = require('node:fs');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 16) return 'unavailable';
    const value = fs.readFileSync(file, 'utf8');
    return ['vouched', 'collaborator', 'bot', 'unknown', 'denounced'].includes(value) ? value : 'unavailable';
  } catch { return 'unavailable'; }
}
module.exports = { readEvaluation, CONTEXT, MAINTAINER, REPOSITORY, trust, decision, finalize };
