export type AgentId = 'claude-01' | 'claude-02' | 'claude-03';
export type ArtifactKind = 'document' | 'image' | 'video' | 'audio' | 'code' | 'model3d' | 'dataset' | 'folder';
export type Lane = 'research' | 'visual' | 'technical' | 'revision' | 'final';
export type Stage = 'input' | 'processing' | 'collaboration' | 'building' | 'review' | 'complete';
export type RunStatus = 'idle' | 'running' | 'paused' | 'waiting_approval' | 'completed' | 'failed' | 'stopped';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'error';
export type ConnectorMode = 'demo' | 'browser';
export type CollabPhase = 'proposal' | 'review' | 'critique' | 'revision' | 'reeval' | 'consensus' | 'decision' | 'system';

export type GraphEdge = {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
};
export type Graph = {
  positions: Record<string, { x: number; y: number }>;
  edges: GraphEdge[];
};
export type Project = {
  id: string;
  name: string;
  graph: Graph;
  createdAt: number;
  updatedAt: number;
};

export type RunOptions = { simulateDisagreement?: boolean };
export type RunStep = {
  id: string;
  stage: Stage;
  agent: AgentId | 'system' | 'user' | 'all';
  title: string;
  status: StepStatus;
  error?: string;
  startedAt?: number;
  endedAt?: number;
};
export type RunState = {
  produced: Record<string, string[]>;
  delivered: Record<string, true>;
  revisions: number;
};
export type Run = {
  id: string;
  projectId: string;
  instruction: string;
  status: RunStatus;
  stage: Stage;
  options: RunOptions;
  steps: RunStep[];
  state: RunState;
  startedAt: number;
  endedAt?: number;
  error?: string;
};

export type Artifact = {
  id: string;
  projectId: string;
  runId: string;
  name: string;
  kind: ArtifactKind;
  mime: string;
  size: number;
  producer: string;
  lane: Lane;
  demo: boolean;
  createdAt: number;
  version: number;
};
export type Transfer = {
  id: string;
  projectId: string;
  runId: string;
  artifactId: string;
  artifactName: string;
  kind: ArtifactKind;
  lane: Lane;
  edgeId: string;
  from: string;
  to: string;
  size: number;
  status: 'moving' | 'done' | 'failed';
  startedAt: number;
  endedAt?: number;
  durationMs: number;
  error?: string;
};
export type ActivityEntry = {
  id: number;
  projectId: string;
  runId: string | null;
  ts: number;
  agent: string;
  activity: string;
  file: string | null;
  status: 'info' | 'ok' | 'warn' | 'error';
};
export type Message = {
  id: string;
  projectId: string;
  runId: string;
  ts: number;
  sender: string;
  phase: CollabPhase;
  text: string;
  artifactId: string | null;
  demo: boolean;
};
export type Approval = {
  id: string;
  projectId: string;
  runId: string;
  kind: 'final_review' | 'consensus_stalled';
  title: string;
  detail: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  decidedAt?: number;
  note?: string;
};
export type Skill = {
  id: string;
  name: string;
  description: string;
  agent: AgentId | 'all';
  enabled: boolean;
};
export type ConnectorInfo = {
  agent: AgentId;
  mode: ConnectorMode;
  state: 'demo' | 'not_connected' | 'manual_login_required' | 'connected' | 'error';
  note: string;
  takeover: boolean;
  profileDir: string;
};

export const AGENTS: { id: AgentId; name: string; role: string; color: string }[] = [
  { id: 'claude-01', name: 'CLAUDE 01', role: 'DIRECTOR', color: '#2196F3' },
  { id: 'claude-02', name: 'CLAUDE 02', role: 'CREATOR', color: '#A855F7' },
  { id: 'claude-03', name: 'CLAUDE 03', role: 'ENGINEER', color: '#10B981' },
];

export const BUILDERS: { id: string; name: string; kinds: ArtifactKind[] }[] = [
  { id: 'builder-doc', name: 'Document Builder', kinds: ['document', 'folder'] },
  { id: 'builder-image', name: 'Image Builder', kinds: ['image'] },
  { id: 'builder-video', name: 'Video Builder', kinds: ['video'] },
  { id: 'builder-3d', name: '3D Builder', kinds: ['model3d'] },
  { id: 'builder-code', name: 'Code Builder', kinds: ['code', 'dataset'] },
  { id: 'builder-audio', name: 'Audio Builder', kinds: ['audio'] },
];

export const builderFor = (kind: ArtifactKind): string =>
  BUILDERS.find((b) => b.kinds.includes(kind))?.id ?? 'builder-doc';

export type AgentRuntime = {
  id: AgentId;
  name: string;
  role: string;
  color: string;
  status: AgentStatus;
  task: string | null;
  since: number | null;
};
