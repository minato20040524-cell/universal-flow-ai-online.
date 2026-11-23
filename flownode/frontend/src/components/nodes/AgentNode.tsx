import { Handle, Position, type NodeProps } from 'reactflow';
import { clock, useNow } from '../../lib/hooks';
import { useApp } from '../../store';
import type { Agent } from '../../types';
import { CreatorScreen, DirectorScreen, EngineerScreen } from '../agents/Workstation';
import { Icon } from '../Icon';

export function ConnectorPill({ agent }: { agent: Agent }) {
  const c = agent.connector;
  const demo = c.state === 'demo';
  return (
    <span
      title={c.note}
      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${demo ? 'border-warn/60 text-warn' : c.state === 'connected' ? 'border-c3/60 text-c3' : 'border-red-400/60 text-red-300'}`}
    >
      {demo ? 'DEMO' : c.state === 'connected' ? 'Terhubung' : 'Belum terhubung'}
    </span>
  );
}

export function AgentNode({ data }: NodeProps<{ id: string }>) {
  const { s, setExpanded } = useApp();
  const agent = s?.agents.find((a) => a.id === data.id);
  const now = useNow(agent?.status === 'working');
  if (!s || !agent) return null;
  const working = agent.status === 'working';
  const Screen = agent.id === 'claude-01' ? DirectorScreen : agent.id === 'claude-02' ? CreatorScreen : EngineerScreen;
  const statusText =
    agent.status === 'idle' ? 'IDLE' : agent.status === 'waiting' ? 'Menunggu persetujuan' : agent.task ?? agent.status;

  return (
    <div
      className="w-[300px] rounded-2xl bg-panel p-3"
      style={{
        border: `1.5px solid ${agent.color}`,
        boxShadow: working ? `0 0 0 1px ${agent.color}55, 0 0 28px ${agent.color}55` : `0 0 14px ${agent.color}22`,
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full" style={{ background: `${agent.color}33`, color: agent.color }}>
          <Icon name="agents" size={16} />
        </span>
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-white">
          {agent.name} <span className="text-slate-400">– {agent.role[0]}{agent.role.slice(1).toLowerCase()}</span>
        </div>
        <ConnectorPill agent={agent} />
        <button className="nodrag rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white" title="Buka workspace" onClick={() => setExpanded(agent.id)}>
          <Icon name="expand" size={15} />
        </button>
      </div>

      <div className={`h-[104px] overflow-hidden rounded-lg border border-line bg-[#0a1020] p-2 ${agent.status === 'idle' ? 'opacity-70' : ''}`}>
        <Screen s={s} agent={agent} />
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {agent.skills.filter((k) => k.enabled).slice(0, 3).map((k) => (
          <span key={k.id} className="rounded-full border px-2 py-0.5 text-[10px]" style={{ borderColor: `${agent.color}66`, color: agent.color }}>
            {k.name}
          </span>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className={`h-2 w-2 shrink-0 rounded-full ${working ? 'pulse-ring' : ''}`}
          style={{ background: agent.status === 'error' ? '#f87171' : agent.status === 'idle' ? '#475569' : agent.color, ['--glow' as string]: `${agent.color}88` }} />
        <span className={`min-w-0 flex-1 truncate ${agent.status === 'error' ? 'text-red-300' : agent.status === 'idle' ? 'text-slate-500' : 'text-slate-200'}`} title={statusText}>
          {statusText}
        </span>
        {working && agent.since && <span className="font-mono text-slate-400">{clock(now - agent.since)}</span>}
      </div>

      <Handle type="source" position={Position.Right} id="out" style={{ top: '38%', background: agent.color }} title="Output" />
      <Handle type="target" position={Position.Right} id="in" style={{ top: '68%', background: '#0B1120', borderColor: agent.color }} title="Input" />
    </div>
  );
}
