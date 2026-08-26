/**
 * Renders the prompt a repo-aware stage WOULD send today, for a real project.
 *
 * No model is called and nothing is spent: a capturing provider stands in for
 * the CLI, so what comes back is the exact bytes the stage assembled.
 *
 *   ts-node --transpile-only scripts/render-prompt.ts <projectRoot> <goal>
 */

import * as path from 'path';
import { attach, evidenceLogPath } from '../src/graph/access';
import { compileOracle, critiqueOracle } from '../src/mission/compile';

const [projectRoot, goal] = process.argv.slice(2);
if (!projectRoot || !goal) {
  console.error('usage: render-prompt.ts <projectRoot> <goal>');
  process.exit(2);
}

const stateRoot = path.join(projectRoot, '.zeus', 'state');
const prompts: Record<string, string> = {};
const capture = (id: string, reply: unknown) => ({
  id, async available() { return { ok: true, detail: 'render-only' }; },
  async invoke(req: any) {
    prompts[id] = req.prompt;
    return { ok: true, role: req.role, structured: reply as any, text: '',
      raw: '{"type":"turn.completed"}', exitCode: 0, durationMs: 0,
      outcome: 'COMPLETED', infrastructureFailure: null };
  },
});

async function main(): Promise<void> {
  const att = attach({
    projectId: path.basename(projectRoot), sourceDir: projectRoot,
    providerId: 'codex', stateRoot,
    logPath: evidenceLogPath(stateRoot, `render-${process.pid}`),
    execPath: process.execPath,
    cliPath: path.resolve(__dirname, '..', 'src', 'cli.ts'),
  });

  const supervisor: any = { run: async () => ({ outcome: 'COMPLETED', stdout: '',
    exitCode: 0, durationMs: 0, productSignal: true, violations: [] }) };
  const policy: any = { worktreeRoot: projectRoot, network: false, allowedCommands: [] };
  const context = { commands: { install: 'npm --prefix api ci' },
    failingChecks: [], findings: [] };
  const criterion: any = {
    criterionId: 'x/M-0000/C-0001', type: 'EXECUTABLE', statement: 'the suite passes',
    evaluator: { kind: 'command', command: 'npm --prefix api ci', expect: 'PASSED' },
    affectedBy: [], required: true, requiresAuthority: [], derivedFrom: [],
  };
  const common: any = { missionId: 'x/M-0000', projectId: path.basename(projectRoot),
    goal, context, supervisor, policy, baseSha: 'render',
    intel: att.section, repoGraph: att.access };

  await compileOracle({ ...common, provider: capture('oracle', { criteria: [] }) });
  await critiqueOracle({ ...common, criteria: [criterion],
    provider: capture('oracle-critic', { findings: [], modeOpinion: 'AUTO' }) });

  for (const stage of ['oracle', 'oracle-critic']) {
    const p = prompts[stage] ?? '';
    console.log(`\n${'='.repeat(70)}\n${stage}  ${Buffer.byteLength(p)} bytes`);
    console.log('='.repeat(70));
    const i = p.indexOf('GRAPH-FIRST INVESTIGATION');
    console.log(i < 0 ? '  !! GRAPH-FIRST NOT PRESENT !!'
      : p.slice(i, p.indexOf('\n\n', p.indexOf('the graph disagreed'))));
    const stop = p.match(/Investigate only as far[\s\S]{0,180}/);
    console.log(`\n--- stopping rule ---\n${stop ? stop[0] : '  !! ABSENT !!'}`);
  }
  await att.access?.stop?.();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
