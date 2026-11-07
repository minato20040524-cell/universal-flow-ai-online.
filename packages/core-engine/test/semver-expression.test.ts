import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compareSemver,
  evaluateCondition,
  isValidRange,
  listReferences,
  readJsonPath,
  renderTemplate,
  satisfies,
  validateValue,
} from '../src/index.js';
import { expectCode } from './helpers.js';

describe('semver', () => {
  it('compares versions including prereleases', () => {
    assert.ok(compareSemver('1.10.0', '1.9.9') > 0);
    assert.ok(compareSemver('1.0.0-beta.2', '1.0.0') < 0);
    assert.ok(compareSemver('1.0.0-beta.10', '1.0.0-beta.2') > 0);
    assert.equal(compareSemver('2.0.0', '2.0.0'), 0);
  });

  it('checks ranges', () => {
    assert.ok(satisfies('1.4.2', '^1.0.0'));
    assert.ok(!satisfies('2.0.0', '^1.0.0'));
    assert.ok(satisfies('0.2.9', '^0.2.3'));
    assert.ok(!satisfies('0.3.0', '^0.2.3'));
    assert.ok(satisfies('1.2.9', '~1.2.3'));
    assert.ok(!satisfies('1.3.0', '~1.2.3'));
    assert.ok(satisfies('1.5.0', '>=1.0.0 <2.0.0'));
    assert.ok(satisfies('3.1.0', '^1.0.0 || ^3.0.0'));
    assert.ok(satisfies('9.9.9', '*'));
    assert.ok(!isValidRange('^banana'));
  });
});

describe('templates', () => {
  const scope = {
    trigger: { message: { text: 'Halo', tags: ['a', 'b'] } },
    nodes: { claude: { output: { text: 'Hasil', score: 0.9 } } },
  };

  it('keeps the type of a single placeholder and stringifies inside text', () => {
    assert.deepEqual(renderTemplate('{{trigger.message.tags}}', scope), ['a', 'b']);
    assert.equal(renderTemplate('{{ nodes.claude.output.score }}', scope), 0.9);
    assert.equal(renderTemplate('Teks: {{nodes.claude.output.text}} ({{trigger.message.tags[1]}})', scope), 'Teks: Hasil (b)');
    assert.deepEqual(renderTemplate({ a: ['{{trigger.message.text}}'], b: 3 }, scope), { a: ['Halo'], b: 3 });
  });

  it('renders missing values as empty or undefined', () => {
    assert.equal(renderTemplate('{{nodes.missing.output}}', scope), undefined);
    assert.equal(renderTemplate('x{{nodes.missing.output}}y', scope), 'xy');
  });

  it('encodes interpolated values when asked', () => {
    assert.equal(renderTemplate('/files/{{trigger.message.text}}/{{x}}', { trigger: { message: { text: 'a b/c' } }, x: '?' }, { encode: encodeURIComponent }), '/files/a%20b%2Fc/%3F');
  });

  it('rejects anything that is not a plain data path', () => {
    assert.throws(() => renderTemplate('{{process.exit()}}', scope), expectCode('VALIDATION'));
    assert.throws(() => renderTemplate('{{trigger.__proto__}}', scope), expectCode('VALIDATION'));
    assert.throws(() => renderTemplate('{{a + b}}', scope), expectCode('VALIDATION'));
  });

  it('lists references for drawing data links', () => {
    assert.deepEqual(listReferences({ p: 'Use {{nodes.claude.output.text}}', q: ['{{trigger.x}}'] }), ['nodes.claude.output.text', 'trigger.x']);
  });

  it('reads JSON paths', () => {
    const body = { choices: [{ text: 'hi' }], 'odd key': { v: 1 } };
    assert.equal(readJsonPath(body, '$.choices[0].text'), 'hi');
    assert.equal(readJsonPath(body, '$["odd key"].v'), 1);
    assert.equal(readJsonPath([5, 6], '$[1]'), 6);
    assert.equal(readJsonPath(body, '$.nope[3]'), undefined);
    assert.equal(readJsonPath(body, 'choices'), undefined);
  });
});

describe('conditions', () => {
  const scope = { trigger: { amount: '150', tags: ['vip'], note: '' } };

  it('compares numbers, strings and collections', () => {
    assert.ok(evaluateCondition({ op: 'gt', left: '{{trigger.amount}}', right: 100 }, scope));
    assert.ok(!evaluateCondition({ op: 'lt', left: '{{trigger.amount}}', right: 100 }, scope));
    assert.ok(!evaluateCondition({ op: 'gt', left: '{{trigger.missing}}', right: 1 }, scope));
    assert.ok(evaluateCondition({ op: 'contains', left: '{{trigger.tags}}', right: 'vip' }, scope));
    assert.ok(evaluateCondition({ op: 'empty', left: '{{trigger.note}}' }, scope));
    assert.ok(evaluateCondition({ op: 'eq', left: '{{trigger.tags}}', right: ['vip'] }, scope));
  });

  it('combines with all, any and not', () => {
    const vip = { op: 'contains', left: '{{trigger.tags}}', right: 'vip' } as const;
    const small = { op: 'lt', left: '{{trigger.amount}}', right: 10 } as const;
    assert.ok(evaluateCondition({ all: [vip, { not: small }] }, scope));
    assert.ok(evaluateCondition({ any: [small, vip] }, scope));
    assert.ok(!evaluateCondition({ all: [vip, small] }, scope));
  });
});

describe('schema validation', () => {
  it('reports every problem with a path', () => {
    const issues = validateValue(
      { type: 'object', required: ['prompt'], properties: { model: { type: 'string', enum: ['a', 'b'] }, n: { type: 'integer', maximum: 5 } } },
      { model: 'c', n: 9 },
    );
    assert.deepEqual(
      issues.map((issue) => issue.path),
      ['$.prompt', '$.model', '$.n'],
    );
  });
});
