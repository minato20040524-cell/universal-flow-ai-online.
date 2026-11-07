-- User accounts for the web app. API tokens stay for machines and scripts.

CREATE TABLE users (
  id                 text PRIMARY KEY,
  email              text NOT NULL UNIQUE CHECK (email = lower(email)),
  name               text NOT NULL,
  password_hash      text NOT NULL,
  is_platform_admin  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL
);

CREATE TABLE memberships (
  user_id       text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id  text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);
CREATE INDEX memberships_workspace_idx ON memberships (workspace_id);

-- The cookie carries a random token; only its hash is stored.
CREATE TABLE sessions (
  id            text PRIMARY KEY,
  token_hash    text NOT NULL UNIQUE,
  user_id       text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id  text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Failed sign-in counter per key (email, client address); shared by all API instances.
CREATE TABLE auth_throttle (
  key                text PRIMARY KEY,
  failures           integer NOT NULL,
  window_started_at  timestamptz NOT NULL,
  locked_until       timestamptz
);
