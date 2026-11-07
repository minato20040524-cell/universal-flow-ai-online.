import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FLOW_OUTPUT_PORTS,
  builtinNodeDefinitions,
  connectionStatusFor,
  generateNodeDefinition,
  generateNodeDefinitions,
  labelize,
  parseManifest,
  portCompatibility,
} from '../src/index.js';
import { customAiManifest } from './helpers.js';

describe('Universal Node Generator', () => {
  const manifest = parseManifest(
    customAiManifest({
      triggers: [{ key: 'jobDone', name: 'Job finished', type: 'webhook', outputSchema: { type: 'object', properties: { jobId: { type: 'string' } } } }],
    }),
  );

  it('builds a complete node for MY CUSTOM AI from its metadata', () => {
    const node = generateNodeDefinition(manifest, 'generate');
    assert.equal(node.type, 'com.example.my-custom-ai@1.0.0:generate');
    assert.equal(node.title, 'MY CUSTOM AI');
    assert.equal(node.subtitle, 'Generate Text');
    assert.equal(node.icon, 'brain');
    assert.deepEqual(node.dataInputs.map((port) => [port.key, port.type, port.required]), [
      ['prompt', 'string', true],
      ['model', 'string', true],
      ['lang', 'string', false],
      ['maxTokens', 'integer', false],
    ]);
    assert.deepEqual(node.dataOutputs.map((port) => port.key), ['text', 'tokens']);
    assert.deepEqual(node.flowOutputs, ['out', 'error']);
    assert.deepEqual(node.auth, { type: 'bearer', required: true });
    assert.deepEqual(node.limitations, ['Rate limit 60 requests per minute']);
  });

  it('derives the configuration panel from the input schema', () => {
    const fields = generateNodeDefinition(manifest, 'generate').configFields;
    const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));
    assert.equal(byKey.prompt?.widget, 'textarea');
    assert.equal(byKey.prompt?.label, 'Prompt');
    assert.equal(byKey.model?.widget, 'select');
    assert.deepEqual(byKey.model?.options, ['small', 'large']);
    assert.equal(byKey.maxTokens?.widget, 'number');
    assert.equal(byKey.maxTokens?.defaultValue, 256);
    assert.equal(byKey.maxTokens?.label, 'Max Tokens');
  });

  it('creates trigger nodes and grows geometry with the number of ports', () => {
    const definitions = generateNodeDefinitions(manifest);
    const trigger = definitions.find((definition) => definition.source.kind === 'plugin' && definition.source.role === 'trigger');
    const action = generateNodeDefinition(manifest, 'generate');
    assert.ok(trigger);
    assert.deepEqual(trigger.flowInputs, []);
    assert.deepEqual(trigger.dataOutputs.map((port) => port.key), ['jobId']);
    assert.ok(action.geometry.height > trigger.geometry.height);
    assert.equal(action.geometry.dataInputs.length, 4);
    assert.ok(action.geometry.dataInputs.every((anchor) => anchor.x < 0));
  });

  it('ships builtin control nodes whose ports match the engine', () => {
    const condition = builtinNodeDefinitions().find((definition) => definition.type === 'builtin:condition');
    assert.deepEqual(condition?.flowOutputs, [...FLOW_OUTPUT_PORTS.condition]);
    const approval = builtinNodeDefinitions().find((definition) => definition.type === 'builtin:approval');
    assert.deepEqual(approval?.flowOutputs, ['approved', 'rejected']);
    assert.deepEqual(approval?.dataOutputs.map((port) => port.key), ['approved', 'by', 'comment']);
    const trigger = builtinNodeDefinitions().find((definition) => definition.type === 'builtin:trigger');
    assert.deepEqual(trigger?.dataOutputs.map((port) => port.key), ['payload']);
    assert.equal(trigger?.geometry.dataOutputs.length, 1, 'the payload gets a jack');
  });

  it('reports connection status and port compatibility', () => {
    const node = generateNodeDefinition(manifest, 'generate');
    assert.equal(connectionStatusFor(node, undefined), 'not_connected');
    assert.equal(portCompatibility('integer', 'number'), 'ok');
    assert.equal(portCompatibility('number', 'string'), 'convertible');
    assert.equal(portCompatibility('array', 'boolean'), 'incompatible');
    assert.equal(labelize('video_url'), 'Video url');
  });
});
