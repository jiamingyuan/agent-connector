// Codex CLI arguments: workspace sandbox, no approval prompts, exact-session resume.
export function codexArgs(config, sessionId, outputFile) {
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write',
    '--enable', 'skip_host_skill_discovery',
    '-c', 'approval_policy="never"', '-C', config.workspace, '-o', outputFile];
  if (sessionId) args.push('resume', sessionId, '-');
  else args.push('-');
  return args;
}
