import type { StudioIssue } from '../../lib/studio/issues';
import { describeCron } from '../../lib/studio/describe';
import { executionLamp, formatDuration, isExecution, pendingApprovals } from '../../lib/studio/execution';
import { relativeDate } from '../../lib/presentation';
import type { Execution, ExecutionDetail, LiveTriggers, WorkflowGraph, WorkflowRecord, WorkflowSettings } from '../../lib/types';
import { Button, Lamp } from '../../components/ui';

/** The right-hand column when no step is selected, and the list of runs. */

type WorkflowPanelProps = {
  workflow: WorkflowRecord;
  graph: WorkflowGraph;
  settings: WorkflowSettings;
  issues: readonly StudioIssue[];
  titles: ReadonlyMap<string, string>;
  live: LiveTriggers | undefined;
  readOnly: boolean;
  onShowIssue: (issue: StudioIssue) => void;
  onSettings: (settings: WorkflowSettings) => void;
};

const countSteps = (graph: WorkflowGraph): number => graph.nodes.reduce((sum, node) => sum + 1 + (node.kind === 'loop' ? countSteps(node.body) : 0), 0);

export const WorkflowPanel = ({ workflow, graph, settings, issues, titles, live, readOnly, onShowIssue, onSettings }: WorkflowPanelProps) => {
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const triggers = graph.nodes.filter((node) => node.kind === 'trigger');
  return (
    <div className="inspector-body">
      <header className="insp-head">
        <div>
          <h2>This workflow</h2>
          <p>
            {countSteps(graph)} {countSteps(graph) === 1 ? 'step' : 'steps'}, editing version {workflow.currentVersion}
          </p>
        </div>
      </header>
      <section className="insp-section">
        <div className="insp-section-head">
          <h3>Before it can run</h3>
        </div>
        {issues.length === 0 ? <p className="lamp" data-tone="ready">Nothing to fix</p> : null}
        {[...errors, ...warnings].map((issue, index) => (
          <button key={`${issue.nodeId ?? 'workflow'}-${index}`} type="button" className="problem" data-severity={issue.severity} onClick={() => onShowIssue(issue)} disabled={!issue.nodeId}>
            <strong>{issue.nodeId ? (titles.get(issue.nodeId) ?? issue.nodeId) : 'Workflow'}</strong>
            <span>{issue.message}</span>
          </button>
        ))}
        {errors.length > 0 ? <p className="hint">Red problems stop saving. Amber ones would stop the step when it runs.</p> : null}
      </section>
      <section className="insp-section">
        <div className="insp-section-head">
          <h3>Live</h3>
        </div>
        {workflow.active && workflow.activeVersion !== undefined ? (
          <Lamp lamp={{ tone: 'ready', label: `Live on version ${workflow.activeVersion}` }} />
        ) : (
          <Lamp lamp={{ tone: 'off', label: 'Not live. Runs only start from Studio.' }} />
        )}
        {triggers.map((trigger) => {
          const webhook = live?.webhooks.find((hook) => hook.triggerNodeId === trigger.id);
          const schedule = live?.schedules.find((entry) => entry.triggerNodeId === trigger.id);
          return (
            <div key={trigger.id} className="live-trigger">
              <strong>{titles.get(trigger.id) ?? trigger.id}</strong>
              {webhook ? <code className="copyable">{webhook.url}</code> : null}
              {schedule ? (
                <span className="hint">
                  {describeCron(schedule.cron)} ({schedule.timezone}). Next {new Date(schedule.nextRunAt).toLocaleString()}.
                </span>
              ) : null}
              {!webhook && !schedule ? <span className="hint">{trigger.kind === 'trigger' && trigger.trigger === 'manual' ? 'Started by hand.' : 'Starts once live.'}</span> : null}
            </div>
          );
        })}
      </section>
      <section className="insp-section">
        <div className="insp-section-head">
          <h3>Settings</h3>
        </div>
        <div className="field">
          <label>
            <span className="label">Steps at the same time</span>
            <input
              type="number"
              min={1}
              max={50}
              value={settings.concurrency ?? 4}
              disabled={readOnly}
              onChange={(event) => {
                const value = Math.round(Number(event.target.value));
                if (value >= 1 && value <= 50) onSettings({ ...settings, concurrency: value });
              }}
            />
          </label>
          <small>Parallel branches run together up to this number.</small>
        </div>
      </section>
    </div>
  );
};

export const SelectionPanel = ({ count, readOnly, onDelete }: { count: number; readOnly: boolean; onDelete: () => void }) => (
  <div className="inspector-body">
    <header className="insp-head">
      <div>
        <h2>{count} steps selected</h2>
        <p>Drag any of them to move them together. Shift-click adds or removes a step.</p>
      </div>
    </header>
    {readOnly ? null : (
      <div className="insp-danger">
        <Button variant="danger" size="small" onClick={onDelete}>
          Remove {count} steps
        </Button>
      </div>
    )}
  </div>
);

type RunsPanelProps = {
  executions: readonly Execution[];
  shown: ExecutionDetail | undefined;
  shownId: string | undefined;
  titles: ReadonlyMap<string, string>;
  canRun: boolean;
  onRun: () => void;
  onShow: (executionId: string | undefined) => void;
  onCancel: (executionId: string) => void;
  onReview: (nodeId: string) => void;
};

const startedLabel = (execution: Execution) => `${relativeDate(execution.startedAt, Date.now())}, ${new Date(execution.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

export const RunsPanel = ({ executions, shown, shownId, titles, canRun, onRun, onShow, onCancel, onReview }: RunsPanelProps) => {
  const current = shown?.execution;
  const approvals = pendingApprovals(current);
  return (
    <div className="inspector-body">
      <header className="insp-head">
        <div>
          <h2>Runs</h2>
          <p>Choose a run to see it on the boards.</p>
        </div>
        {canRun ? (
          <Button size="small" onClick={onRun}>
            Run now
          </Button>
        ) : null}
      </header>
      {current && shownId ? (
        <section className="insp-section run-card">
          <div className="insp-section-head">
            <h3>Shown on the boards</h3>
            <Button size="small" variant="quiet" onClick={() => onShow(undefined)}>
              Hide
            </Button>
          </div>
          <Lamp lamp={executionLamp(current)} />
          {isExecution(current) ? (
            <dl className="run-facts">
              <dt>Version</dt>
              <dd>{current.workflowVersion}</dd>
              <dt>Started by</dt>
              <dd>{titles.get(current.trigger.nodeId) ?? current.trigger.nodeId}</dd>
              <dt>Took</dt>
              <dd>{current.finishedAt ? formatDuration(current.finishedAt - current.startedAt) : 'Still going'}</dd>
            </dl>
          ) : (
            <p className="hint">Waiting for a worker to pick it up.</p>
          )}
          {isExecution(current) && current.error ? (
            <p className="error-text">
              {titles.get(current.error.nodeId) ?? current.error.nodeId}: {current.error.message}
            </p>
          ) : null}
          {approvals.map((nodeId) => (
            <div key={nodeId} className="approval-callout">
              <span>{titles.get(nodeId) ?? nodeId} is waiting for a decision.</span>
              <Button size="small" variant="primary" onClick={() => onReview(nodeId)}>
                Review
              </Button>
            </div>
          ))}
          {current.status === 'running' || current.status === 'waiting' ? (
            <Button size="small" variant="danger" onClick={() => onCancel(shownId)}>
              Cancel this run
            </Button>
          ) : null}
        </section>
      ) : null}
      <section className="insp-section">
        <div className="insp-section-head">
          <h3>History</h3>
        </div>
        {executions.length === 0 ? <p className="hint">No runs yet.</p> : null}
        <ul className="run-list">
          {executions.map((execution) => (
            <li key={execution.id}>
              <button type="button" aria-pressed={execution.id === shownId} onClick={() => onShow(execution.id)}>
                <Lamp lamp={executionLamp(execution)} />
                <span className="run-when">
                  {startedLabel(execution)}, v{execution.workflowVersion}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
};
