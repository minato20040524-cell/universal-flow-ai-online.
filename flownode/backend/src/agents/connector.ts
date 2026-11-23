import type { AgentId, ArtifactKind, CollabPhase, ConnectorInfo, ConnectorMode } from '../types.js';

export type AgentTaskKind = 'plan' | 'visuals' | 'engineering' | 'review' | 'revision';

export type AgentTask = {
  agent: AgentId;
  kind: AgentTaskKind;
  instruction: string;
  context?: string;
};

export type ArtifactDraft = {
  name: string;
  kind: ArtifactKind;
  mime: string;
  data: Buffer;
};

export type DiscussInput = {
  agent: AgentId;
  phase: CollabPhase;
  instruction: string;
  round: number;
  disagree: boolean;
};

/**
 * Agent Connector Interface (Tahap B).
 * - DemoConnector: data lokal, SELALU diberi label DEMO.
 * - BrowserConnector: kerangka untuk sesi browser terisolasi (Tahap C/D).
 * Connector tidak boleh mengklaim "connected" kecuali benar-benar terhubung.
 */
export interface AgentConnector {
  readonly mode: ConnectorMode;
  status(): Pick<ConnectorInfo, 'state' | 'note'>;
  run(task: AgentTask, signal: AbortSignal): Promise<ArtifactDraft[]>;
  discuss(input: DiscussInput, signal: AbortSignal): Promise<string>;
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Dibatalkan', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Dibatalkan', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
