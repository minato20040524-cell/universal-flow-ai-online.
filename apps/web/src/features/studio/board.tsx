import { memo, type CSSProperties, type MouseEvent } from 'react';
import type { NodeRunView } from '../../lib/studio/execution';
import { BOARD_LIFT_PX, BOARD_THICKNESS_PX, type BoardLayout, type JackKind, type JackLayout } from '../../lib/studio/layout';
import type { StudioIssue } from '../../lib/studio/issues';
import type { WorkflowNode } from '../../lib/types';
import { Icon } from './icons';

export type BoardIssue = { severity: StudioIssue['severity']; message: string; count: number };

export type BoardProps = {
  node: WorkflowNode;
  layout: BoardLayout;
  /** Top-left corner on the floor, in stage pixels. */
  x: number;
  y: number;
  /** Extra height while being dragged. */
  lift: number;
  title: string;
  summary: string;
  appTitle: string;
  icon: string;
  color: string;
  missing: boolean;
  selected: boolean;
  run: NodeRunView | undefined;
  issue: BoardIssue | undefined;
  /** `side:key` of every jack with a cable. */
  connected: string;
  /** Inputs of this kind light up while a cable looks for a home. */
  seeking: JackKind | undefined;
  seekingFrom: string | undefined;
  hoveredJack: string | undefined;
  bodySteps: number | undefined;
  readOnly: boolean;
  /** `byKeyboard` is true for Enter or Space, which never end a mouse drag. */
  onJack: (nodeId: string, jack: JackLayout, byKeyboard: boolean) => void;
  onSelectByKey: (nodeId: string) => void;
  onFocusBoard: (nodeId: string) => void;
  onOpenLoop: (nodeId: string) => void;
  onReview: (nodeId: string) => void;
};

const jackName = (jack: JackLayout, title: string): string => {
  const direction = jack.side === 'in' ? 'input' : 'output';
  return `${title}: ${jack.label} ${jack.kind === 'data' ? 'data ' : ''}${direction}`;
};

const statusLine = (props: BoardProps) => {
  if (props.run) return { tone: props.run.tone, text: props.run.label };
  if (props.issue) return { tone: props.issue.severity === 'error' ? 'fault' : 'attention', text: props.issue.count > 1 ? `${props.issue.message} (+${props.issue.count - 1})` : props.issue.message };
  if (props.missing) return { tone: 'fault', text: 'Module not installed' };
  return undefined;
};

const BoardView = (props: BoardProps) => {
  const { node, layout, title, summary, appTitle, run, readOnly } = props;
  const connected = new Set(props.connected.split(' '));
  const status = statusLine(props);
  const waitingForApproval = run?.run?.status === 'waiting' && run.run.waitingFor === 'approval';
  const style = {
    width: layout.width,
    height: layout.height,
    transform: `translate3d(${props.x}px, ${props.y}px, ${BOARD_LIFT_PX + props.lift}px)`,
    ['--module-color' as string]: props.color,
    ['--thickness' as string]: `${BOARD_THICKNESS_PX}px`,
  } satisfies CSSProperties;

  const description = [title, summary, status?.text].filter(Boolean).join('. ');
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Pointer presses select on pointerdown (that is where dragging starts); this is the keyboard path.
    if (event.detail === 0) props.onSelectByKey(node.id);
  };

  return (
    <div className="board" data-node-id={node.id} data-selected={props.selected || undefined} data-lifted={props.lift > 0 || undefined} data-run={run?.tone} style={style}>
      <div className="board-side board-side-front" />
      <div className="board-side board-side-back" />
      <div className="board-side board-side-left" />
      <div className="board-side board-side-right" />
      <div className="board-top" role="group" aria-label={`${title} step`}>
        <span className="board-screw left" aria-hidden="true" />
        <span className="board-screw right" aria-hidden="true" />
        <button
          type="button"
          className="board-handle"
          data-board-handle={node.id}
          aria-pressed={props.selected}
          aria-label={description}
          aria-keyshortcuts={readOnly ? undefined : 'ArrowLeft ArrowRight ArrowUp ArrowDown Delete'}
          onClick={handleClick}
          onFocus={() => props.onFocusBoard(node.id)}
        >
          <span className="board-icon" aria-hidden="true">
            <Icon name={props.icon} size={16} />
          </span>
          <span className="board-titles">
            <strong>{title}</strong>
            <span>{summary || appTitle}</span>
          </span>
          <span className="board-lamp" data-tone={run?.tone ?? (props.issue?.severity === 'error' || props.missing ? 'fault' : props.issue ? 'attention' : 'idle')} aria-hidden="true" />
        </button>
        {layout.jacks.map((jack) => {
          const key = `${jack.side}:${jack.key}`;
          const seekable = props.seeking === jack.kind && jack.side === 'in' && props.seekingFrom !== node.id;
          return (
            <button
              key={key}
              type="button"
              className="board-jack"
              data-jack={key}
              data-node={node.id}
              data-kind={jack.kind}
              data-side={jack.side}
              data-port={jack.key}
              data-connected={connected.has(key) || undefined}
              data-seekable={seekable || undefined}
              data-hovered={props.hoveredJack === key || undefined}
              disabled={readOnly}
              style={{ top: jack.y - 13 }}
              aria-label={jackName(jack, title)}
              onClick={(event) => props.onJack(node.id, jack, event.detail === 0)}
            >
              <span className="board-socket" aria-hidden="true" />
              <span className="board-jack-label">{jack.label}</span>
            </button>
          );
        })}
        {status || props.bodySteps !== undefined || waitingForApproval ? (
          <div className="board-foot">
            {status ? (
              <span className="board-status" data-tone={status.tone}>
                {status.text}
              </span>
            ) : (
              <span />
            )}
            {waitingForApproval ? (
              <button type="button" className="board-action" data-board-action onClick={() => props.onReview(node.id)}>
                Review
              </button>
            ) : props.bodySteps !== undefined ? (
              <button type="button" className="board-action" data-board-action onClick={() => props.onOpenLoop(node.id)}>
                Open loop ({props.bodySteps})
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export const Board = memo(BoardView);
