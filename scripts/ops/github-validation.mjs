import { execFileSync } from 'node:child_process';

export function selectSuccessfulRun(runs, commit) {
  const run = runs.filter(r => r.head_sha === commit && r.event === 'push')
    .sort((a, b) => b.id - a.id)[0];
  if (!run || run.status !== 'completed' || run.conclusion !== 'success') {
    throw Error(`GitHub validation is required for ${commit}: ${run?.conclusion ?? run?.status ?? 'missing'}`);
  }
  return run;
}

/** Fail closed: only GitHub's latest push run of our workflow for this SHA counts. */
export function requireGithubValidation(config, commit, request = githubRequest) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Invalid Git commit');
  const { repository, workflow } = config.github ?? {};
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^[\w.-]+\.ya?ml$/.test(workflow ?? '')) {
    throw Error('Production GitHub repository/workflow is required');
  }
  const base = `repos/${repository}/actions`;
  const response = request(`${base}/workflows/${workflow}/runs?head_sha=${commit}&event=push&per_page=100`);
  const run = selectSuccessfulRun(response.workflow_runs ?? [], commit);
  const artifacts = request(`${base}/runs/${run.id}/artifacts?per_page=100`).artifacts ?? [];
  const artifact = artifacts.find(a => a.name === `validation-${commit}` && !a.expired
    && a.workflow_run?.head_sha === commit && a.size_in_bytes > 0);
  if (!artifact) throw Error('Successful GitHub run has no retained validation artifact for this commit');
  return { runId: run.id, url: run.html_url, artifactId: artifact.id, commit };
}

function githubRequest(endpoint) {
  try {
    return JSON.parse(execFileSync(process.env.GH_CLI ?? 'gh', ['api', endpoint], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 2 * 1024 * 1024,
    }));
  } catch {
    throw Error('Could not verify GitHub checks. Authenticate gh and retry; deployment is blocked.');
  }
}
