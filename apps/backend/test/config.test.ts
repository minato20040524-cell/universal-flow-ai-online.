import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://u:p@db:5432/universal', MASTER_KEY: randomBytes(32).toString('base64') };

describe('configuration on a hosting platform', () => {
  it('uses the address Render gives the service when PUBLIC_BASE_URL is not set', () => {
    const config = loadConfig({ ...base, RENDER_EXTERNAL_URL: 'https://universal-flow-ai.onrender.com', PORT: '10000' });
    assert.equal(config.publicBaseUrl, 'https://universal-flow-ai.onrender.com');
    assert.equal(config.port, 10000);
  });

  it('prefers PUBLIC_BASE_URL, for a custom domain', () => {
    const config = loadConfig({ ...base, RENDER_EXTERNAL_URL: 'https://universal-flow-ai.onrender.com', PUBLIC_BASE_URL: 'https://flow.example.id' });
    assert.equal(config.publicBaseUrl, 'https://flow.example.id');
  });

  it('accepts a generated 256-bit base64 master key and still demands an address somewhere', () => {
    assert.equal(loadConfig({ ...base, PUBLIC_BASE_URL: 'http://localhost:8080' }).masterKey.length, 32);
    assert.throws(() => loadConfig(base), /PUBLIC_BASE_URL/);
  });
});
