import { useMemo, useState } from 'react';
import { executionLamp } from '../../lib/studio/execution';
import { TEMPLATES, buildTemplate, type TemplateId } from '../../lib/studio/templates';
import { relativeDate } from '../../lib/presentation';
import type { Execution, NodeDefinition, WorkflowRecord } from '../../lib/types';
import { Button, Dialog, Empty, ErrorNotice, Field, Lamp, Loading } from '../../components/ui';
import { canEdit, canManage, messageOf, useResource, useSignedIn } from '../../state/app-state';
import { Link, navigate } from '../../state/navigation';
import { Icon } from './icons';

type Overview = { workflows: WorkflowRecord[]; executions: Execution[]; palette: NodeDefinition[] };

export const WorkflowsPage = () => {
  const { api, role, notify } = useSignedIn();
  const resource = useResource(async (): Promise<Overview> => {
    const [workflows, executions, palette] = await Promise.all([api.workflows(), api.executions({ limit: 200 }), api.nodes()]);
    return { workflows, executions, palette };
  }, []);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<WorkflowRecord | undefined>(undefined);

  const lastRun = useMemo(() => {
    const map = new Map<string, Execution>();
    for (const execution of resource.data?.executions ?? []) if (!map.has(execution.workflowId)) map.set(execution.workflowId, execution);
    return map;
  }, [resource.data]);

  const remove = async (workflow: WorkflowRecord) => {
    try {
      await api.deleteWorkflow(workflow.id);
      notify(`${workflow.name} was deleted.`);
      resource.reload();
    } catch (error) {
      notify(messageOf(error), 'error');
    } finally {
      setRemoving(undefined);
    }
  };

  const workflows = [...(resource.data?.workflows ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Workflows</h1>
          <p>Each workflow is a set of modules patched together in Spatial Studio. Saved versions never change, so a live workflow keeps working while you edit the next one.</p>
        </div>
        {canEdit(role) ? (
          <div className="actions">
            <Button variant="primary" onClick={() => setCreating(true)}>
              New workflow
            </Button>
          </div>
        ) : null}
      </div>
      {resource.error ? <ErrorNotice error={resource.error} onRetry={resource.reload} /> : null}
      {resource.loading && !resource.data ? <Loading /> : null}
      {resource.data && workflows.length === 0 ? (
        <Empty
          title="No workflows yet"
          actions={
            canEdit(role) ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                New workflow
              </Button>
            ) : undefined
          }
        >
          Start from a blank stage or from the content pipeline example, which uses the apps you have installed.
        </Empty>
      ) : null}
      {workflows.length > 0 ? (
        <ul className="rack-rows" aria-label="Workflows">
          {workflows.map((workflow) => {
            const run = lastRun.get(workflow.id);
            return (
              <li key={workflow.id} className="rack-row workflow-row">
                <span className="jacks in" aria-hidden="true">
                  <Icon name="cube" size={18} />
                </span>
                <span className="name">
                  <Link to={`/workflows/${encodeURIComponent(workflow.id)}`}>{workflow.name}</Link>
                  <span>Edited {relativeDate(workflow.updatedAt, Date.now())}</span>
                </span>
                <span className="version">v{workflow.currentVersion}</span>
                <span className="lamp-cell">
                  <Lamp lamp={workflow.active && workflow.activeVersion !== undefined ? { tone: 'ready', label: `Live, v${workflow.activeVersion}` } : { tone: 'off', label: 'Not live' }} />
                </span>
                <span className="meta">{run ? <Lamp lamp={{ ...executionLamp(run), label: `Last run ${executionLamp(run).label.toLowerCase()}, ${relativeDate(run.startedAt, Date.now())}` }} /> : 'Never run'}</span>
                <span className="jacks out">
                  {canManage(role) ? (
                    <Button size="small" variant="quiet" onClick={() => setRemoving(workflow)} aria-label={`Delete ${workflow.name}`}>
                      Delete
                    </Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {resource.data ? <CreateDialog open={creating} palette={resource.data.palette} onClose={() => setCreating(false)} /> : null}
      <Dialog
        open={removing !== undefined}
        title={`Delete ${removing?.name ?? ''}?`}
        onClose={() => setRemoving(undefined)}
        actions={
          <>
            <Button variant="danger" onClick={() => removing && void remove(removing)}>
              Delete workflow
            </Button>
            <Button onClick={() => setRemoving(undefined)}>Keep it</Button>
          </>
        }
      >
        <p>All its versions, webhooks and schedules are removed. Past runs stay in the history.</p>
      </Dialog>
    </>
  );
};

const CreateDialog = ({ open, palette, onClose }: { open: boolean; palette: NodeDefinition[]; onClose: () => void }) => {
  const { api, notify } = useSignedIn();
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<TemplateId>('blank');
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => buildTemplate(template, palette), [template, palette]);
  const create = async () => {
    setBusy(true);
    try {
      const record = await api.createWorkflow({ name: name.trim() || (template === 'blank' ? 'Untitled workflow' : 'Content pipeline'), graph: preview.graph });
      onClose();
      navigate(`/workflows/${encodeURIComponent(record.id)}`);
    } catch (error) {
      notify(messageOf(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      title="New workflow"
      onClose={onClose}
      actions={
        <>
          <Button variant="primary" disabled={busy} onClick={() => void create()}>
            Create and open Studio
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <Field label="Name">{(props) => <input type="text" {...props} value={name} placeholder={template === 'blank' ? 'Untitled workflow' : 'Content pipeline'} onChange={(event) => setName(event.target.value)} />}</Field>
      <fieldset className="template-choice">
        <legend className="label">Start from</legend>
        {TEMPLATES.map((option) => (
          <label key={option.id} className="template-option" data-checked={template === option.id || undefined}>
            <input type="radio" name="template" value={option.id} checked={template === option.id} onChange={() => setTemplate(option.id)} />
            <span>
              <strong>{option.title}</strong>
              <span>{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {template === 'content-pipeline' && preview.missing.length > 0 ? (
        <div className="notice">
          <p>
            Not in this workspace yet, so left out: {preview.missing.map((entry) => entry.name).join(', ')}. The cables are joined around them. Install them from the{' '}
            <Link to="/marketplace">Marketplace</Link> and add them in Studio, if they are available there.
          </p>
        </div>
      ) : null}
      {template === 'content-pipeline' ? <p className="hint">{preview.graph.nodes.length} steps. Accounts and sheet details are chosen in Studio.</p> : null}
    </Dialog>
  );
};
