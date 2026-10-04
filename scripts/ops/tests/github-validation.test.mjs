import test from 'node:test';
import assert from 'node:assert/strict';
import { requireGithubValidation, selectSuccessfulRun } from '../github-validation.mjs';

const commit = 'a'.repeat(40);
const config = {github: {repository: 'owner/project', workflow: 'frontend-ci.yml'}};
const success = {id: 4, head_sha: commit, event: 'push', status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/project/actions/runs/4'};
const artifact = {id: 7, name: `validation-${commit}`, expired: false, workflow_run: {head_sha: commit}, size_in_bytes: 123};

test('deployment requires success for the exact commit, not another branch head or PR', () => {
  for (const runs of [[], [{...success, head_sha: 'b'.repeat(40)}], [{...success, event: 'pull_request'}],
    [{...success, conclusion: 'failure'}], [{...success, status: 'in_progress', conclusion: null}]]) {
    assert.throws(() => selectSuccessfulRun(runs, commit), /required/);
  }
  assert.equal(selectSuccessfulRun([success], commit), success);
});
test('newer failed or pending runs cannot be masked by an older success', () => {
  for (const newer of [{...success, id: 5, conclusion: 'failure'}, {...success, id: 5, status: 'queued'}]) {
    assert.throws(() => selectSuccessfulRun([success, newer], commit), /required/);
  }
});
test('requires a retained proof artifact from the successful run', () => {
  const request = artifacts => endpoint => endpoint.includes('/artifacts?') ? {artifacts} : {workflow_runs: [success]};
  for (const artifacts of [[], [{...artifact, expired: true}], [{...artifact, workflow_run: {head_sha: 'b'.repeat(40)}}], [{...artifact, size_in_bytes: 0}]]) {
    assert.throws(() => requireGithubValidation(config, commit, request(artifacts)), /artifact/);
  }
  assert.deepEqual(requireGithubValidation(config, commit, request([artifact])), {
    runId: 4, url: success.html_url, artifactId: 7, commit,
  });
});
test('network/authentication failures cannot authorize deployment', () => {
  assert.throws(() => requireGithubValidation(config, commit, () => {throw Error('offline')}), /offline/);
  assert.throws(() => requireGithubValidation({}, commit), /required/);
  assert.throws(() => requireGithubValidation(config, 'HEAD'), /Invalid/);
});
