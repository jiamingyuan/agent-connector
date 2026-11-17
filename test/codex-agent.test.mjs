import test from 'node:test';
import assert from 'node:assert/strict';
import { codexArgs } from '../codex-agent/index.mjs';
import { modelCheckArgs, modelVerdict } from '../codex-agent/cli.mjs';

const config = { workspace: '/tmp/workspace' };
test('resume targets the exact chat session and keeps workspace sandbox', () => {
  const args = codexArgs(config, 'session-1', '/tmp/result.txt');
  assert.deepEqual(args.slice(-3), ['resume', 'session-1', '-']);
  assert(args.includes('workspace-write'));
  assert(args.includes('approval_policy="never"'));
  assert(args.includes('skip_host_skill_discovery'));
  assert(!args.includes('--last'));
});

test('Codex gets the chat model and effort as -m and model_reasoning_effort, before the resume subcommand', async () => {
  const { codexArgs, createAgent } = await import('../codex-agent/index.mjs');
  const args = codexArgs({ workspace: '/w' }, 's1', '/o.txt', { model: 'gpt-5-codex', effort: 'high' });
  assert.deepEqual(args.slice(args.indexOf('-m'), args.indexOf('resume')), ['-m', 'gpt-5-codex', '-c', 'model_reasoning_effort="high"']);
  assert(!codexArgs({ workspace: '/w' }, null, '/o.txt').includes('-m'));
  const agent = createAgent({ codexBin: '/bin/codex', workspace: '/w' }, { env: {}, runtime: '/tmp' });
  assert.equal(agent.models.find('gpt-5-codex'), 'gpt-5-codex');
  assert.equal(agent.models.find('bad name; rm'), null);
  assert.deepEqual([agent.efforts.find('HIGH'), agent.efforts.find('max'), agent.models.resolve(), agent.efforts.resolve('low')], ['high', null, undefined, 'low']);
});

test('the Codex /model check is one ephemeral read-only run, and an unknown model is told apart from other failures', () => {
  const args = modelCheckArgs(config, 'gpt-nope');
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-nope');
  for (const flag of ['--ephemeral', '--json']) assert(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args.at(-1), '-');
  const notFound = 'The model `gpt-nope` does not exist or you do not have access to it.';
  assert.deepEqual(modelVerdict({ code: 1, events: [{ type: 'error', message: notFound }, { type: 'turn.failed', error: { message: notFound } }] }).ok, false);
  assert.deepEqual(modelVerdict({ code: 1, events: [{ type: 'turn.failed', error: { message: 'model_not_found' } }] }).ok, false);
  assert.deepEqual(modelVerdict({ code: 0, events: [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.completed', usage: {} }] }), { ok: true });
  assert.deepEqual(modelVerdict({ code: 1, events: [{ type: 'error', message: 'stream disconnected before completion' }] }).ok, null);
});
