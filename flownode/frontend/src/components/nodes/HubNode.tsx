import { Handle, Position } from 'reactflow';
import { HubPanel } from '../collaboration/HubPanel';
import { Icon } from '../Icon';

const pair = (n: number, top: number) => (
  <>
    <Handle type="target" position={Position.Left} id={`in-c${n}`} style={{ top: `${top}%`, background: ['#2196F3', '#A855F7', '#10B981'][n - 1] }} title="Masuk dari agen" />
    <Handle type="source" position={Position.Left} id={`out-c${n}`} style={{ top: `${top + 6}%`, background: '#0B1120', borderColor: ['#2196F3', '#A855F7', '#10B981'][n - 1] }} title="Keluar ke agen" />
  </>
);

export function HubNode() {
  return (
    <div className="flex h-[430px] w-[380px] flex-col rounded-[28px] border-2 border-fin/80 bg-panel/95 p-3"
      style={{ boxShadow: '0 0 0 1px #22d3ee33, 0 0 36px #22d3ee33' }}>
      <div className="mb-2 flex items-center justify-center gap-2 text-base font-semibold text-white">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-fin/15 text-fin"><Icon name="chat" size={18} /></span>
        Collaboration Hub
      </div>
      <HubPanel />
      {pair(1, 12)}
      {pair(2, 46)}
      {pair(3, 80)}
      <Handle type="source" position={Position.Right} id="out" style={{ top: '50%', background: '#22D3EE' }} />
    </div>
  );
}
