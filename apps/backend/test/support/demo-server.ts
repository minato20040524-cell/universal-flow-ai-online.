/**
 * Local demo: the real backend on a fresh PostgreSQL schema, serving the built
 * web app, with a seeded marketplace and fake external services
 * (api.example.com for MY CUSTOM AI, auth/drive.example.com for OAuth).
 * Used by the browser tests in apps/web/e2e. Stop it with Ctrl+C.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLocalKeyProvider } from '@universal-flow/core-engine';
import { createApp } from '../../src/app.js';
import { migrate } from '../../src/db/migrate.js';
import { createHttpServer } from '../../src/http/server.js';
import type { OfficialPlugin } from '../../src/context.js';
import { createFakeHttp, json } from './fakes.js';
import { createTestDatabase } from './psql-client.js';

const PORT = Number(process.env.DEMO_PORT ?? 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WEB_DIST = fileURLToPath(new URL('../../../../web/dist/', import.meta.url));
export const DEMO_API_TOKEN = 'sk-demo-123';

const native = (
  id: string,
  name: string,
  category: string,
  description: string,
  action: { key: string; name: string; inputs: Record<string, string>; outputs: Record<string, string>; required?: string[] },
  handler: (input: Record<string, unknown>) => unknown,
): OfficialPlugin => ({
  manifest: {
    id,
    name,
    version: '1.0.0',
    engine: '^1.0.0',
    provider: 'Universal Flow',
    category,
    description,
    runtime: 'native',
    actions: [
      {
        key: action.key,
        name: action.name,
        inputSchema: { type: 'object', required: action.required ?? [], properties: Object.fromEntries(Object.entries(action.inputs).map(([key, type]) => [key, { type }])) },
        outputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(action.outputs).map(([key, type]) => [key, { type }])) },
      },
    ],
  },
  handlers: { [action.key]: async ({ input }) => handler(input) },
});

const officialPlugins: OfficialPlugin[] = [
  native('io.universalflow.telegram', 'Telegram', 'messaging', 'Send messages to chats and channels through your bot.', { key: 'sendMessage', name: 'Send message', inputs: { chatId: 'string', text: 'string' }, outputs: { messageId: 'string' }, required: ['chatId', 'text'] }, () => ({ messageId: 'm1' })),
  native('io.universalflow.claude', 'Claude', 'ai-llm', 'Write, summarise and reason over text with Anthropic Claude models.', { key: 'chat', name: 'Generate text', inputs: { prompt: 'string', system: 'string' }, outputs: { text: 'string', tokens: 'integer' }, required: ['prompt'] }, (input) => ({ text: `claude: ${String(input.prompt)}`, tokens: 12 })),
  native('io.universalflow.openai', 'ChatGPT', 'ai-llm', 'Generate text and structured answers with OpenAI models.', { key: 'chat', name: 'Generate text', inputs: { prompt: 'string' }, outputs: { text: 'string' }, required: ['prompt'] }, (input) => ({ text: `gpt: ${String(input.prompt)}` })),
  native('io.universalflow.video', 'Video Generator', 'ai-video', 'Turn a script into a short video with narration.', { key: 'render', name: 'Render video', inputs: { script: 'string', style: 'string' }, outputs: { url: 'string', seconds: 'number' }, required: ['script'] }, () => ({ url: 'https://cdn.example.com/v.mp4', seconds: 42 })),
  native('io.universalflow.sheets', 'Google Sheets', 'office-documents', 'Append rows and read ranges in a spreadsheet.', { key: 'appendRow', name: 'Append row', inputs: { spreadsheetId: 'string', row: 'array' }, outputs: { updatedRange: 'string' }, required: ['spreadsheetId', 'row'] }, () => ({ updatedRange: 'A2:C2' })),
  native('io.universalflow.youtube', 'YouTube', 'social-media', 'Upload videos to your channel and set their details.', { key: 'publish', name: 'Publish video', inputs: { videoUrl: 'string', title: 'string', description: 'string' }, outputs: { postUrl: 'string' }, required: ['videoUrl', 'title'] }, () => ({ postUrl: 'https://youtube.example.com/v' })),
  native('io.universalflow.instagram', 'Instagram', 'social-media', 'Post reels and images to a business account.', { key: 'publish', name: 'Publish reel', inputs: { videoUrl: 'string', caption: 'string' }, outputs: { postUrl: 'string' }, required: ['videoUrl'] }, () => ({ postUrl: 'https://instagram.example.com/p' })),
  {
    manifest: {
      id: 'io.universalflow.gdrive',
      name: 'Google Drive',
      version: '1.0.0',
      engine: '^1.0.0',
      provider: 'Universal Flow',
      category: 'cloud-storage',
      description: 'Upload files and organise folders in Google Drive.',
      auth: { type: 'oauth2', authorizationUrl: 'https://auth.example.com/authorize', tokenUrl: 'https://auth.example.com/token', scopes: ['drive.file'] },
      baseUrl: 'https://drive.example.com',
      permissions: ['network:drive.example.com', 'network:auth.example.com'],
      actions: [
        {
          key: 'upload',
          name: 'Upload file',
          request: { method: 'POST', path: '/files', body: { name: '{{input.name}}', content: '{{input.content}}' } },
          inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, content: { type: 'string' } } },
          outputSchema: { type: 'object', properties: { fileId: { type: 'string' } } },
          responseMapping: { fileId: '$.id' },
        },
      ],
      limitations: ['Uploads up to 5 MB per file through this module'],
    },
  },
];

const outbound = createFakeHttp(async (request) => {
  const url = new URL(request.url);
  if (url.hostname === 'api.example.com') {
    if (request.headers.authorization !== `Bearer ${DEMO_API_TOKEN}`) return json(401, { error: 'invalid api key' });
    const body: unknown = request.body ? JSON.parse(request.body) : {};
    const prompt = typeof body === 'object' && body !== null && 'prompt' in body ? String(body.prompt) : '';
    return json(200, { choices: [{ text: `Here is a fresh take on "${prompt}".` }], usage: { total: 18 } });
  }
  if (url.hostname === 'auth.example.com') return json(200, { access_token: 'drive-access', refresh_token: 'drive-refresh', expires_in: 3600 });
  if (url.hostname === 'drive.example.com') return json(201, { id: 'file_1' });
  return json(404, {});
});

const db = await createTestDatabase();
await migrate(db);
const app = await createApp({
  sql: db,
  keyProvider: createLocalKeyProvider(randomBytes(32)),
  sessionSecret: randomBytes(32),
  outboundHttp: outbound.http,
  publicBaseUrl: BASE_URL,
  officialPlugins,
  webDistDir: WEB_DIST,
  worker: { pollIntervalMs: 250 },
});

// Another team already uses a few modules, so the marketplace has something to rank.
const now = Date.now();
const other = await app.context.workspaces.createWorkspace('Another team', now);
for (const pluginId of ['io.universalflow.claude', 'io.universalflow.telegram', 'io.universalflow.youtube']) {
  await app.context.plugins.install(other.id, pluginId, { grantPermissions: [] });
}
await app.context.plugins.register(
  {
    id: 'org.community.summarizer',
    name: 'Article Summarizer',
    version: '1.0.0',
    engine: '^1.0.0',
    provider: 'Rina Developer',
    category: 'ai-llm',
    description: 'Summarise any public article into five bullet points.',
    auth: { type: 'api_key', in: 'header', name: 'X-Key' },
    baseUrl: 'https://summarize.example.com',
    permissions: ['network:summarize.example.com'],
    actions: [{ key: 'summarize', name: 'Summarise article', request: { method: 'POST', path: '/v1/summary', body: { url: '{{input.url}}' } }, inputSchema: { type: 'object', properties: { url: { type: 'string' } } }, outputSchema: { type: 'object', properties: { bullets: { type: 'array' } } } }],
    limitations: ['English articles only'],
  },
  { source: 'community' },
);
await app.context.plugins.approve('org.community.summarizer', '1.0.0', 'demo');

const server = createHttpServer({ ...app.http, log: () => undefined });
server.listen(PORT, '127.0.0.1', () => console.log(`demo ready on ${BASE_URL} (schema ${db.schema})`));
app.worker.start();

const stop = async () => {
  server.close();
  await app.worker.stop();
  await db.drop();
  process.exit(0);
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
