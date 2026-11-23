export type AgentId = 'claude-01' | 'claude-02' | 'claude-03';
export type ArtifactKind = 'document' | 'image' | 'video' | 'audio' | 'code' | 'model3d' | 'dataset' | 'folder';
export type Lane = 'research' | 'visual' | 'technical' | 'revision' | 'final';
export type Stage = 'input' | 'processing' | 'collaboration' | 'building' | 'review' | 'complete';
export type RunStatus = 'idle' | 'running' | 'paused' | 'waiting_approval' | 'completed' | 'failed' | 'stopped';
export type CollabPhase = 'proposal' | 'review' | 'critique' | 'revision' | 'reeval' | 'consensus' | 'decision' | 'system';

export type GraphEdge = { id: string; source: string; sourceHandle: string; target: string; targetHandle: string };
export type Graph = { positions: Record<string, { x: number; y: number }>; edges: GraphEdge[] };
export type Project = { id: string; name: string; graph: Graph; createdAt: number; updatedAt: number };

export type RunStep = {
  id: string; stage: Stage; agent: string; title: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; error?: string;
};
export type Run = {
  id: string; projectId: string; instruction: string; status: RunStatus; stage: Stage;
  steps: RunStep[]; startedAt: number; endedAt?: number; error?: string;
};
export type Artifact = {
  id: string; runId: string; name: string; kind: ArtifactKind; mime: string; size: number;
  producer: string; lane: Lane; demo: boolean; createdAt: number; version: number;
};
export type Transfer = {
  id: string; runId: string; artifactId: string; artifactName: string; kind: ArtifactKind; lane: Lane;
  edgeId: string; from: string; to: string; size: number; status: 'moving' | 'done' | 'failed';
  startedAt: number; endedAt?: number; durationMs: number; error?: string;
};
export type ActivityEntry = { id: number; ts: number; agent: string; activity: string; file: string | null; status: 'info' | 'ok' | 'warn' | 'error' };
export type Message = { id: string; runId: string; ts: number; sender: string; phase: CollabPhase; text: string; artifactId: string | null; demo: boolean };
export type Approval = {
  id: string; runId: string; kind: 'final_review' | 'consensus_stalled'; title: string; detail: string;
  status: 'pending' | 'approved' | 'rejected'; createdAt: number; decidedAt?: number; note?: string;
};
export type Skill = { id: string; name: string; description: string; agent: AgentId | 'all'; enabled: boolean };
export type Connector = {
  agent: AgentId; mode: 'demo' | 'browser';
  state: 'demo' | 'not_connected' | 'manual_login_required' | 'connected' | 'error';
  note: string; takeover: boolean; profileDir: string;
};
export type Agent = {
  id: AgentId; name: string; role: string; color: string;
  status: 'idle' | 'working' | 'waiting' | 'error'; task: string | null; since: number | null;
  connector: Connector; skills: Skill[];
};
export type Snapshot = {
  serverTime: number; mode: 'on-demand'; busy: boolean; project: Project;
  projects: { id: string; name: string; updatedAt: number }[];
  run: Run | null; agents: Agent[]; artifacts: Artifact[]; transfers: Transfer[];
  activity: ActivityEntry[]; messages: Message[]; approvals: Approval[]; skills: Skill[]; connectors: Connector[];
  stats: { activeAgents: number; files: number; totalBytes: number; durationMs: number; tasksDone: number; tasksTotal: number };
  settings: { maxRounds: number; hopMs: number };
};

export const STAGES: { id: Stage; title: string; sub: string }[] = [
  { id: 'input', title: 'Input', sub: 'Berikan perintah' },
  { id: 'processing', title: 'Processing', sub: 'Riset & rencana' },
  { id: 'collaboration', title: 'Collaboration', sub: 'Kolaborasi AI' },
  { id: 'building', title: 'Building', sub: 'Pembuatan aset' },
  { id: 'review', title: 'Review', sub: 'Pemeriksaan akhir' },
  { id: 'complete', title: 'Complete', sub: 'Hasil siap' },
];

export const LANE_COLOR: Record<Lane, string> = {
  research: '#2196F3',
  visual: '#A855F7',
  technical: '#10B981',
  revision: '#F59E0B',
  final: '#22D3EE',
};
export const AGENT_COLOR: Record<string, string> = { 'claude-01': '#2196F3', 'claude-02': '#A855F7', 'claude-03': '#10B981' };
export const NODE_LABEL: Record<string, string> = {
  'claude-01': 'Claude 01', 'claude-02': 'Claude 02', 'claude-03': 'Claude 03', hub: 'Collaboration Hub', output: 'Final Output',
  'builder-doc': 'Document Builder', 'builder-image': 'Image Builder', 'builder-video': 'Video Builder',
  'builder-3d': '3D Builder', 'builder-code': 'Code Builder', 'builder-audio': 'Audio Builder', user: 'Pengguna', system: 'Sistem',
};
export const BUILDERS = [
  { id: 'builder-doc', name: 'Document Builder', kinds: ['document', 'folder'] },
  { id: 'builder-image', name: 'Image Builder', kinds: ['image'] },
  { id: 'builder-video', name: 'Video Builder', kinds: ['video'] },
  { id: 'builder-3d', name: '3D Builder', kinds: ['model3d'] },
  { id: 'builder-code', name: 'Code Builder', kinds: ['code', 'dataset'] },
  { id: 'builder-audio', name: 'Audio Builder', kinds: ['audio'] },
] as const;

export const BUILDER_COLOR: Record<string, string> = {
  'builder-doc': '#2196F3', 'builder-image': '#A855F7', 'builder-video': '#A855F7',
  'builder-3d': '#A855F7', 'builder-code': '#10B981', 'builder-audio': '#A855F7',
};
/** Warna dasar kabel saat diam (tanpa animasi). */
export const edgeBaseColor = (source: string, target: string): string =>
  AGENT_COLOR[source] ?? (BUILDER_COLOR[target] ?? (target === 'hub' ? '#22D3EE' : AGENT_COLOR[target] ?? '#22D3EE'));
