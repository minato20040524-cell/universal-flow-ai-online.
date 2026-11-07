import type { ComparisonOp, Condition, NodeDefinition, WorkflowNode } from '../types.js';
import { soleReference } from './data.js';

/** Plain-language labels for boards, so a workflow reads like a sentence. */

export const nodeTitle = (node: WorkflowNode, definition: NodeDefinition): string => {
  if (node.name?.trim()) return node.name.trim();
  if (node.kind === 'action' || (node.kind === 'trigger' && node.trigger === 'plugin')) return definition.subtitle || definition.title;
  if (node.kind === 'trigger') return { manual: 'Manual Trigger', webhook: 'Webhook', schedule: 'Schedule', plugin: definition.title }[node.trigger];
  return definition.title;
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (value: string) => value.padStart(2, '0');

/** Common cron shapes in words; anything else is shown as written. */
export const describeCron = (expression: string): string => {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [minute = '', hour = '', day = '', month = '', weekday = ''] = parts;
  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyMinutes && hour === '*' && day === '*' && month === '*' && weekday === '*') return everyMinutes[1] === '1' ? 'Every minute' : `Every ${everyMinutes[1]} minutes`;
  if (minute === '*' && hour === '*' && day === '*' && month === '*' && weekday === '*') return 'Every minute';
  const fixedMinute = /^\d{1,2}$/.test(minute);
  if (fixedMinute && hour === '*' && day === '*' && month === '*' && weekday === '*') return minute === '0' ? 'Every hour' : `Every hour at :${pad(minute)}`;
  if (!fixedMinute || !/^\d{1,2}$/.test(hour) || month !== '*') return expression;
  const time = `${pad(hour)}:${pad(minute)}`;
  if (day === '*' && weekday === '*') return `Every day at ${time}`;
  if (day === '*' && weekday === '1-5') return `Weekdays at ${time}`;
  if (day === '*' && /^[0-6]$/.test(weekday)) return `Every ${WEEKDAYS[Number(weekday)] ?? weekday} at ${time}`;
  if (/^\d{1,2}$/.test(day) && weekday === '*') return `Day ${day} of every month at ${time}`;
  return expression;
};

export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at 09:00', cron: '0 9 * * *' },
  { label: 'Weekdays at 09:00', cron: '0 9 * * 1-5' },
  { label: 'Mondays at 08:00', cron: '0 8 * * 1' },
];

const OP_WORDS: Record<ComparisonOp, string> = {
  eq: 'is',
  neq: 'is not',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  contains: 'contains',
  startsWith: 'starts with',
  exists: 'has a value',
  empty: 'is empty',
};

export const COMPARISON_OPS: readonly ComparisonOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'exists', 'empty'];
export const opWords = (op: ComparisonOp): string => OP_WORDS[op];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Same rule as the engine's isCondition, for JSON typed into the advanced editor. */
export const isCondition = (value: unknown): value is Condition => {
  if (!isRecord(value)) return false;
  if (Array.isArray(value.all)) return value.all.every(isCondition);
  if (Array.isArray(value.any)) return value.any.every(isCondition);
  if (value.not !== undefined) return isCondition(value.not);
  return COMPARISON_OPS.some((op) => op === value.op) && 'left' in value;
};
export const opNeedsRight = (op: ComparisonOp): boolean => op !== 'exists' && op !== 'empty';

/** `{{nodes.claude.output.text}}` reads as `claude text`; plain values are quoted. */
export const shortValue = (value: unknown): string => {
  const reference = soleReference(value);
  if (reference) {
    const node = /^nodes\.([\w-]+)\.output\.?(.*)$/.exec(reference);
    if (node) return [node[1], node[2]].filter(Boolean).join(' ');
    return reference.replace(/^trigger\.?/, 'trigger ').trim();
  }
  if (typeof value === 'string') return value === '' ? '(empty)' : `"${value.length > 18 ? `${value.slice(0, 17)}…` : value}"`;
  return JSON.stringify(value) ?? '';
};

export const describeCondition = (condition: Condition): string => {
  if ('all' in condition) return condition.all.length === 1 && condition.all[0] ? describeCondition(condition.all[0]) : `All of ${condition.all.length} checks`;
  if ('any' in condition) return condition.any.length === 1 && condition.any[0] ? describeCondition(condition.any[0]) : `Any of ${condition.any.length} checks`;
  if ('not' in condition) return `Not: ${describeCondition(condition.not)}`;
  return opNeedsRight(condition.op) ? `If ${shortValue(condition.left)} ${OP_WORDS[condition.op]} ${shortValue(condition.right)}` : `If ${shortValue(condition.left)} ${OP_WORDS[condition.op]}`;
};

export const DELAY_UNITS = [
  { key: 'seconds', label: 'seconds', ms: 1000 },
  { key: 'minutes', label: 'minutes', ms: 60_000 },
  { key: 'hours', label: 'hours', ms: 3_600_000 },
  { key: 'days', label: 'days', ms: 86_400_000 },
] as const;

/** The largest unit that divides the wait exactly, so 90 000 ms shows as 90 seconds, not 1.5 minutes. */
export const splitDelay = (ms: number): { amount: number; unit: (typeof DELAY_UNITS)[number] } => {
  const unit = [...DELAY_UNITS].reverse().find((candidate) => ms >= candidate.ms && ms % candidate.ms === 0) ?? DELAY_UNITS[0];
  return { amount: ms / unit.ms, unit };
};

export const describeDelay = (ms: number): string => {
  if (ms === 0) return 'Continues at once';
  const { amount, unit } = splitDelay(ms);
  return `Waits ${amount} ${amount === 1 ? unit.label.replace(/s$/, '') : unit.label}`;
};

/** The second line on a board. */
export const nodeSummary = (node: WorkflowNode, definition: NodeDefinition): string => {
  switch (node.kind) {
    case 'trigger':
      if (node.trigger === 'manual') return 'Run by hand or from Studio';
      if (node.trigger === 'webhook') return 'When a request arrives';
      if (node.trigger === 'schedule') return node.schedule ? `${describeCron(node.schedule)}${node.timezone ? `, ${node.timezone}` : ''}` : 'No schedule yet';
      return definition.title;
    case 'action':
      return definition.title;
    case 'condition':
      return describeCondition(node.when);
    case 'loop': {
      const reference = soleReference(node.items);
      return reference ? `For each of ${shortValue(node.items)}` : 'Choose a list to go through';
    }
    case 'delay':
      return describeDelay(node.ms);
    case 'approval':
      return 'Asks someone before it continues';
    case 'transform': {
      const count = Object.keys(node.output).length;
      return count === 0 ? 'No fields yet' : `Builds ${count} ${count === 1 ? 'field' : 'fields'}`;
    }
  }
};
