import test from 'node:test';
import assert from 'node:assert/strict';
import { codexArgs } from '../codex-agent/index.mjs';

const config = { workspace: '/tmp/workspace' };
test('resume targets the exact chat session and keeps workspace sandbox', () => {
  const args = codexArgs(config, 'session-1', '/tmp/result.txt');
  assert.deepEqual(args.slice(-3), ['resume', 'session-1', '-']);
  assert(args.includes('workspace-write'));
  assert(args.includes('approval_policy="never"'));
  assert(args.includes('skip_host_skill_discovery'));
  assert(!args.includes('--last'));
});
