import type { AgentId, Artifact, CollabPhase } from '../types.js';

/**
 * Mesin kolaborasi:
 * PROPOSAL → REVIEW → CRITIQUE → REVISION → RE-EVALUATION → CONSENSUS → USER APPROVAL.
 * Bila tidak sepakat setelah `maxRounds`, keputusan diserahkan kepada pengguna.
 */
export interface CollabHost {
  say(sender: string, phase: CollabPhase, text: string, artifactId?: string | null): Promise<void>;
  discuss(agent: AgentId, phase: CollabPhase, round: number): Promise<string>;
  produceRevisionPlan(round: number): Promise<Artifact>;
  deliverToHub(artifact: Artifact): Promise<void>;
  setTask(text: string): void;
  requestDecision(title: string, detail: string): Promise<'approved' | 'rejected'>;
  gate(): Promise<void>;
}

const PEERS: AgentId[] = ['claude-02', 'claude-03'];

export async function runCollaboration(
  host: CollabHost,
  opts: { maxRounds: number; plan: Artifact },
): Promise<'consensus' | 'user_accepted'> {
  host.setTask('Proposal rencana');
  await host.say('claude-01', 'proposal', await host.discuss('claude-01', 'proposal', 1), opts.plan.id);

  for (let round = 1; round <= opts.maxRounds; round++) {
    await host.gate();
    host.setTask(`Review (ronde ${round})`);
    for (const a of PEERS) await host.say(a, 'review', await host.discuss(a, 'review', round));

    await host.gate();
    host.setTask(`Kritik (ronde ${round})`);
    for (const a of PEERS) await host.say(a, 'critique', await host.discuss(a, 'critique', round));

    await host.gate();
    host.setTask(`Revisi (ronde ${round})`);
    const rev = await host.produceRevisionPlan(round);
    await host.say('claude-01', 'revision', await host.discuss('claude-01', 'revision', round), rev.id);
    await host.deliverToHub(rev);

    await host.gate();
    host.setTask(`Evaluasi ulang (ronde ${round})`);
    let allAgree = true;
    for (const a of PEERS) {
      const text = await host.discuss(a, 'reeval', round);
      await host.say(a, 'reeval', text);
      if (/belum setuju/i.test(text)) allAgree = false;
    }
    if (allAgree) {
      await host.say('system', 'consensus', await host.discuss('claude-01', 'consensus', round));
      return 'consensus';
    }
  }

  host.setTask('Menunggu keputusan pengguna');
  const decision = await host.requestDecision(
    'Agen belum sepakat',
    `Tidak ada konsensus setelah ${opts.maxRounds} ronde. Setujui untuk melanjutkan dengan rencana Director, atau tolak untuk menghentikan workflow.`,
  );
  if (decision === 'rejected') throw new Error('Pengguna menolak melanjutkan setelah konsensus tidak tercapai.');
  await host.say('user', 'decision', 'Pengguna memutuskan melanjutkan dengan rencana Director.');
  return 'user_accepted';
}
