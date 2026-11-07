import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError, createCategoryRegistry, parseManifest } from '../src/index.js';
import { OTHER_WORKSPACE, WORKSPACE, createRegistry, customAiManifest, expectCode, nativeManifest } from './helpers.js';

describe('plugin manifest', () => {
  it('parses a valid Custom API manifest with defaults', () => {
    const manifest = parseManifest(customAiManifest());
    assert.equal(manifest.runtime, 'http');
    assert.equal(manifest.actions[0]?.request?.method, 'POST');
    assert.deepEqual(manifest.triggers, []);
    assert.equal(manifest.ui.icon, undefined);
  });

  it('reports all problems at once', () => {
    try {
      parseManifest(
        customAiManifest({
          id: 'Bad ID!',
          baseUrl: 'http://api.example.com',
          permissions: ['network:other.example.com', 'root:everything'],
          auth: { type: 'magic' },
        }),
      );
      assert.fail('expected a ValidationError');
    } catch (error) {
      assert.ok(error instanceof ValidationError);
      const paths = error.issues.map((issue) => issue.path);
      for (const expected of ['$.id', '$.baseUrl', '$.permissions', '$.permissions[1]', '$.auth.type']) {
        assert.ok(paths.includes(expected), `missing issue for ${expected}: ${paths.join(', ')}`);
      }
    }
  });

  it('refuses private hosts and unknown categories', async () => {
    assert.throws(
      () => parseManifest(customAiManifest({ baseUrl: 'https://169.254.169.254', permissions: ['network:169.254.169.254'] })),
      expectCode('VALIDATION'),
    );
    const slugs = new Set((await createCategoryRegistry().list()).map((category) => category.slug));
    assert.throws(() => parseManifest(customAiManifest({ category: 'time-travel' }), { categoryExists: (slug) => slugs.has(slug) }), /unknown category/);
  });
});

describe('plugin registry', () => {
  it('runs a custom integration only after Test API has passed', async () => {
    const registry = createRegistry();
    const record = await registry.register(customAiManifest(), { source: 'custom', ownerWorkspaceId: WORKSPACE });
    assert.equal(record.status, 'testing');
    assert.ok(await registry.getInstallation(WORKSPACE, 'com.example.my-custom-ai'), 'owner gets it installed');
    await assert.rejects(registry.resolveForExecution(WORKSPACE, 'com.example.my-custom-ai@1.0.0'), expectCode('PERMISSION'));
    await registry.markTested('com.example.my-custom-ai', '1.0.0');
    assert.equal((await registry.resolveForExecution(WORKSPACE, 'com.example.my-custom-ai@1.0.0')).name, 'MY CUSTOM AI');
  });

  it('keeps custom integrations private to their workspace', async () => {
    const registry = createRegistry();
    await registry.register(customAiManifest(), { source: 'custom', ownerWorkspaceId: WORKSPACE });
    await registry.markTested('com.example.my-custom-ai', '1.0.0');
    assert.equal((await registry.search({ workspaceId: OTHER_WORKSPACE })).length, 0);
    assert.equal((await registry.search({ workspaceId: WORKSPACE })).length, 1);
    await assert.rejects(registry.install(OTHER_WORKSPACE, 'com.example.my-custom-ai', { grantPermissions: ['network:api.example.com'] }), expectCode('NOT_FOUND'));
  });

  it('holds community plugins for review', async () => {
    const registry = createRegistry();
    const manifest = customAiManifest({ id: 'org.community.summarizer', name: 'Summarizer' });
    assert.equal((await registry.register(manifest, { source: 'community' })).status, 'pending_review');
    assert.equal((await registry.search()).length, 0);
    await registry.approve('org.community.summarizer', '1.0.0', 'scanned: ok');
    assert.equal((await registry.search({ text: 'summ' })).length, 1);
  });

  it('allows the native runtime only for official plugins', async () => {
    const registry = createRegistry();
    await assert.rejects(registry.register(nativeManifest('org.evil.native', 'automation', 'run'), { source: 'community' }), expectCode('SECURITY'));
    assert.equal((await registry.register(nativeManifest('io.universalflow.telegram', 'messaging', 'send'), { source: 'official' })).status, 'active');
  });

  it('checks engine compatibility and immutable versions', async () => {
    const registry = createRegistry();
    await assert.rejects(registry.register(customAiManifest({ engine: '^2.0.0' }), { source: 'official' }), /requires engine/);
    await registry.register(customAiManifest(), { source: 'official' });
    await assert.doesNotReject(registry.register(customAiManifest(), { source: 'official' }));
    await assert.rejects(registry.register(customAiManifest({ name: 'Changed' }), { source: 'official' }), expectCode('CONFLICT'));
    await assert.rejects(registry.register(customAiManifest({ version: '1.1.0' }), { source: 'community' }), expectCode('CONFLICT'));
  });

  it('asks again for new permissions on update and keeps pinned versions runnable', async () => {
    const registry = createRegistry();
    await registry.register(customAiManifest(), { source: 'official' });
    await registry.install(WORKSPACE, 'com.example.my-custom-ai', { grantPermissions: ['network:api.example.com'] });
    await registry.register(customAiManifest({ version: '1.1.0', permissions: ['network:api.example.com', 'network:upload.example.com'] }), { source: 'official' });

    const preview = await registry.previewUpdate(WORKSPACE, 'com.example.my-custom-ai');
    assert.deepEqual(preview, { from: '1.0.0', to: '1.1.0', permissions: { added: ['network:upload.example.com'], removed: [] } });
    await assert.rejects(registry.update(WORKSPACE, 'com.example.my-custom-ai', {}), expectCode('PERMISSION'));
    const updated = await registry.update(WORKSPACE, 'com.example.my-custom-ai', { grantPermissions: ['network:upload.example.com'] });
    assert.equal(updated.version, '1.1.0');
    assert.equal((await registry.resolveForExecution(WORKSPACE, 'com.example.my-custom-ai@1.0.0')).version, '1.0.0');
    assert.equal((await registry.resolveForExecution(WORKSPACE, 'com.example.my-custom-ai@1.1.0')).version, '1.1.0');
  });

  it('guards uninstall, disable and revoke', async () => {
    const inUse = new Set<string>(['com.example.my-custom-ai']);
    const registry = createRegistry({ isPluginInUse: (_workspace, pluginId) => inUse.has(pluginId) });
    await registry.register(customAiManifest(), { source: 'official' });
    await registry.install(WORKSPACE, 'com.example.my-custom-ai', { grantPermissions: ['network:api.example.com'] });
    await assert.rejects(registry.install(WORKSPACE, 'com.example.my-custom-ai', { grantPermissions: [] }), expectCode('CONFLICT'));

    await registry.setEnabled(WORKSPACE, 'com.example.my-custom-ai', false);
    await assert.rejects(registry.resolveForExecution(WORKSPACE, 'com.example.my-custom-ai@1.0.0'), /disabled/);
    await registry.setEnabled(WORKSPACE, 'com.example.my-custom-ai', true);

    await assert.rejects(registry.uninstall(WORKSPACE, 'com.example.my-custom-ai'), expectCode('CONFLICT'));
    await registry.revoke('com.example.my-custom-ai', 'leaked key');
    await assert.rejects(registry.resolveForExecution(WORKSPACE, 'com.example.my-custom-ai@1.0.0'), expectCode('PERMISSION'));
    await assert.rejects(registry.setEnabled(WORKSPACE, 'com.example.my-custom-ai', true), /revoked/);
    await registry.uninstall(WORKSPACE, 'com.example.my-custom-ai', { force: true });
    assert.equal(await registry.getInstallation(WORKSPACE, 'com.example.my-custom-ai'), undefined);
  });

  it('searches by name, category and provider', async () => {
    const registry = createRegistry();
    await registry.register(customAiManifest(), { source: 'official' });
    await registry.register(nativeManifest('io.universalflow.sheets', 'office-documents', 'append'), { source: 'official' });
    assert.deepEqual((await registry.search({ category: 'ai-llm' })).map((plugin) => plugin.id), ['com.example.my-custom-ai']);
    assert.deepEqual((await registry.search({ provider: 'universal flow' })).map((plugin) => plugin.id), ['io.universalflow.sheets']);
    assert.equal((await registry.search({ text: 'custom ai' })).at(0)?.limitations.length, 1);
  });
});

describe('category registry', () => {
  it('ships the 30 categories and lets admins manage their own', async () => {
    const categories = createCategoryRegistry();
    assert.equal((await categories.list()).length, 30);
    await categories.add({ slug: 'robotics', name: 'Robotics' });
    await assert.rejects(categories.add({ slug: 'robotics', name: 'Again' }), expectCode('CONFLICT'));
    await categories.update('ai-llm', { name: 'AI Models' });
    assert.equal((await categories.get('ai-llm'))?.name, 'AI Models');
    await assert.rejects(categories.remove('ai-llm', { isInUse: () => false }), /System category/);
    await assert.rejects(categories.remove('robotics', { isInUse: () => true }), /still used/);
    await categories.remove('robotics', { isInUse: () => false });
    assert.equal(await categories.has('robotics'), false);
  });
});
