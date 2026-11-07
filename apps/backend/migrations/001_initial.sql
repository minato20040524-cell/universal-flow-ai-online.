-- UNIVERSAL FLOW AI: initial schema.
-- Every statement relies on search_path, so the same file installs into any schema.

CREATE TABLE workspaces (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL
);

-- API tokens are stored only as SHA-256 hashes.
CREATE TABLE api_tokens (
  id                 text PRIMARY KEY,
  workspace_id       text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name               text NOT NULL,
  token_hash         text NOT NULL UNIQUE,
  role               text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  is_platform_admin  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL,
  last_used_at       timestamptz,
  revoked_at         timestamptz
);
CREATE INDEX api_tokens_workspace_idx ON api_tokens (workspace_id);

CREATE TABLE categories (
  slug        text PRIMARY KEY,
  name        text NOT NULL,
  icon        text,
  sort_order  integer NOT NULL,
  is_system   boolean NOT NULL
);

CREATE TABLE plugin_versions (
  plugin_id           text NOT NULL,
  version             text NOT NULL,
  source              text NOT NULL CHECK (source IN ('official', 'community', 'custom')),
  status              text NOT NULL CHECK (status IN ('testing', 'pending_review', 'active', 'rejected', 'revoked')),
  owner_workspace_id  text REFERENCES workspaces (id) ON DELETE CASCADE,
  name                text NOT NULL,
  provider            text NOT NULL,
  category            text NOT NULL REFERENCES categories (slug),
  manifest            jsonb NOT NULL,
  checksum            text NOT NULL,
  review_note         text,
  registered_at       timestamptz NOT NULL,
  PRIMARY KEY (plugin_id, version),
  CHECK ((source = 'custom') = (owner_workspace_id IS NOT NULL))
);
CREATE INDEX plugin_versions_category_idx ON plugin_versions (category);

CREATE TABLE installations (
  workspace_id         text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  plugin_id            text NOT NULL,
  version              text NOT NULL,
  enabled              boolean NOT NULL,
  granted_permissions  jsonb NOT NULL,
  installed_at         timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, plugin_id),
  FOREIGN KEY (plugin_id, version) REFERENCES plugin_versions (plugin_id, version)
);
CREATE INDEX installations_plugin_idx ON installations (plugin_id);

-- Encrypted with a per-credential data key; the data key is wrapped by the KMS master key.
CREATE TABLE credentials (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  plugin_id     text NOT NULL,
  auth_type     text NOT NULL,
  key_id        text NOT NULL,
  wrapped_key   text NOT NULL,
  iv            text NOT NULL,
  auth_tag      text NOT NULL,
  ciphertext    text NOT NULL,
  field_names   jsonb NOT NULL,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  expires_at    timestamptz,
  errored       boolean NOT NULL DEFAULT false
);
CREATE INDEX credentials_workspace_idx ON credentials (workspace_id);

CREATE TABLE workflows (
  id               text PRIMARY KEY,
  workspace_id     text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name             text NOT NULL,
  current_version  integer NOT NULL,
  active           boolean NOT NULL DEFAULT false,
  active_version   integer,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  CHECK (NOT active OR active_version IS NOT NULL)
);
CREATE INDEX workflows_workspace_idx ON workflows (workspace_id);

-- Versions are immutable; executions pin the version they ran.
CREATE TABLE workflow_versions (
  workflow_id  text NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  version      integer NOT NULL,
  graph        jsonb NOT NULL,
  settings     jsonb NOT NULL,
  plugin_ids   jsonb NOT NULL,
  created_at   timestamptz NOT NULL,
  PRIMARY KEY (workflow_id, version)
);

CREATE TABLE executions (
  id                text PRIMARY KEY,
  workflow_id       text NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  workflow_version  integer NOT NULL,
  workspace_id      text NOT NULL,
  status            text NOT NULL CHECK (status IN ('running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  trigger           jsonb NOT NULL,
  nodes             jsonb NOT NULL,
  edges             jsonb NOT NULL,
  error             jsonb,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz,
  revision          integer NOT NULL
);
CREATE INDEX executions_workflow_idx ON executions (workflow_id, started_at DESC);
CREATE INDEX executions_workspace_idx ON executions (workspace_id, started_at DESC);
CREATE INDEX executions_waiting_idx ON executions (status) WHERE status = 'waiting';

CREATE TABLE execution_steps (
  id            bigserial PRIMARY KEY,
  execution_id  text NOT NULL REFERENCES executions (id) ON DELETE CASCADE,
  node_id       text NOT NULL,
  attempt       integer NOT NULL,
  status        text NOT NULL,
  port          text,
  input         jsonb,
  output        jsonb,
  error         jsonb,
  started_at    timestamptz NOT NULL,
  duration_ms   integer NOT NULL
);
CREATE INDEX execution_steps_execution_idx ON execution_steps (execution_id, id);

CREATE TABLE webhooks (
  id               text PRIMARY KEY,
  workspace_id     text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  workflow_id      text NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  trigger_node_id  text NOT NULL,
  credential_id    text NOT NULL REFERENCES credentials (id),
  created_at       timestamptz NOT NULL,
  UNIQUE (workflow_id, trigger_node_id)
);

CREATE TABLE schedules (
  workflow_id      text NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  trigger_node_id  text NOT NULL,
  workspace_id     text NOT NULL,
  workflow_version integer NOT NULL,
  cron             text NOT NULL,
  timezone         text NOT NULL,
  next_run_at      timestamptz NOT NULL,
  lease_until      timestamptz,
  PRIMARY KEY (workflow_id, trigger_node_id)
);
CREATE INDEX schedules_due_idx ON schedules (next_run_at);

-- Job queue: workers claim rows with FOR UPDATE SKIP LOCKED.
CREATE TABLE jobs (
  id               text PRIMARY KEY,
  seq              bigserial NOT NULL,
  type             text NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),
  dedupe_key       text UNIQUE,
  concurrency_key  text,
  run_at           timestamptz NOT NULL,
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL,
  locked_by        text,
  locked_until     timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);
CREATE INDEX jobs_ready_idx ON jobs (run_at, seq) WHERE status = 'queued';
CREATE INDEX jobs_running_idx ON jobs (locked_until) WHERE status = 'running';
CREATE INDEX jobs_concurrency_idx ON jobs (concurrency_key) WHERE status = 'running';
CREATE INDEX jobs_execution_idx ON jobs ((payload ->> 'executionId'));

-- Mutex per concurrency key: one upsert decides which job may advance an execution.
CREATE TABLE job_locks (
  key           text PRIMARY KEY,
  owner_job_id  text NOT NULL,
  locked_until  timestamptz NOT NULL
);
CREATE INDEX job_locks_owner_idx ON job_locks (owner_job_id);

CREATE TABLE oauth_states (
  state           text PRIMARY KEY,
  workspace_id    text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  plugin_id       text NOT NULL,
  plugin_version  text NOT NULL,
  credential_id   text NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
  redirect_uri    text NOT NULL,
  created_at      timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL
);

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  workspace_id  text,
  actor         text NOT NULL,
  action        text NOT NULL,
  target        text NOT NULL,
  details       jsonb NOT NULL,
  created_at    timestamptz NOT NULL
);
CREATE INDEX audit_log_workspace_idx ON audit_log (workspace_id, id DESC);
