import { randomBytes } from 'node:crypto';
import { loadDatabaseConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPgClient } from './db/pg-client.js';
import { hashPassword, passwordProblem } from './auth/passwords.js';
import { createPgUserRepository } from './repositories/user-repository.js';
import { createPgWorkspaceRepository } from './repositories/workspace-repository.js';

const USAGE = `Usage:
  node dist/src/cli.js migrate
  node dist/src/cli.js create-workspace "<name>" [--platform-admin]       (prints an owner API token)
  PASSWORD=... node dist/src/cli.js create-user <email> "<name>" "<workspace>" [--platform-admin]
  node dist/src/cli.js generate-master-key`;

const flagValues = (rest: string[]) => rest.filter((arg) => !arg.startsWith('--'));

const run = async (args: string[]): Promise<void> => {
  const [command, ...rest] = args;
  if (command === 'generate-master-key') {
    console.log(randomBytes(32).toString('base64'));
    return;
  }
  if (command !== 'migrate' && command !== 'create-workspace' && command !== 'create-user') {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
    return;
  }

  const config = loadDatabaseConfig();
  const sql = await createPgClient({ connectionString: config.databaseUrl, ssl: config.databaseSsl });
  try {
    if (command === 'migrate') {
      const applied = await migrate(sql);
      console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
      return;
    }
    if (command === 'create-user') {
      const [email, userName, workspaceName] = flagValues(rest);
      const password = process.env.PASSWORD ?? '';
      if (!email || !userName || !workspaceName) throw new Error('Usage: create-user <email> "<name>" "<workspace>"');
      const problem = passwordProblem(password);
      if (problem) throw new Error(`PASSWORD ${problem}`);
      const now = Date.now();
      const users = createPgUserRepository(sql);
      const user = await users.create({ email, name: userName, passwordHash: await hashPassword(password), isPlatformAdmin: rest.includes('--platform-admin'), now });
      const workspace = await createPgWorkspaceRepository(sql).createWorkspace(workspaceName, now);
      await users.addMembership(user.id, workspace.id, 'owner', now);
      console.log(JSON.stringify({ userId: user.id, email: user.email, workspaceId: workspace.id }, null, 2));
      return;
    }
    const [name] = flagValues(rest);
    if (!name) throw new Error('Give the workspace a name');
    const workspaces = createPgWorkspaceRepository(sql);
    const workspace = await workspaces.createWorkspace(name, Date.now());
    const { token } = await workspaces.createToken({
      workspaceId: workspace.id,
      name: 'owner (cli)',
      role: 'owner',
      isPlatformAdmin: rest.includes('--platform-admin'),
      now: Date.now(),
    });
    console.log(JSON.stringify({ workspaceId: workspace.id, ownerToken: token, note: 'Store the token now; it is not shown again.' }, null, 2));
  } finally {
    await sql.close?.();
  }
};

run(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
