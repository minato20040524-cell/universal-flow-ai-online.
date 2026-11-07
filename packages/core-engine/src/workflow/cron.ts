import { ValidationError } from '../errors.js';

/**
 * Standard 5-field cron: minute hour day-of-month month day-of-week.
 * Supports `*`, lists `1,15`, ranges `1-5`, steps `*\/15` and `10-40/10`,
 * month and weekday names (`jan`, `mon`), and 0 or 7 for Sunday.
 * As in classic cron, when both day fields are restricted a day matches
 * if either one does. Times are evaluated in an IANA time zone.
 */
export type CronSchedule = {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

type FieldSpec = { name: string; min: number; max: number; names?: readonly string[]; namesStartAt?: number };

const FIELDS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, namesStartAt: 1 },
  { name: 'day of week', min: 0, max: 7, names: DAY_NAMES, namesStartAt: 0 },
];

const invalid = (expression: string, message: string) => new ValidationError('Invalid cron expression', [{ path: expression, message }]);

const parseValue = (text: string, spec: FieldSpec, expression: string): number => {
  const nameIndex = spec.names?.indexOf(text.toLowerCase()) ?? -1;
  const value = nameIndex >= 0 ? nameIndex + (spec.namesStartAt ?? 0) : /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
    throw invalid(expression, `${spec.name} value "${text}" must be between ${spec.min} and ${spec.max}`);
  }
  return value;
};

const parseField = (field: string, spec: FieldSpec, expression: string): Set<number> => {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [rangeText = '', stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw invalid(expression, `${spec.name} step "${stepText ?? ''}" must be a positive integer`);
    let start = spec.min;
    let end = spec.max;
    if (rangeText !== '*') {
      const [startText = '', endText] = rangeText.split('-');
      start = parseValue(startText, spec, expression);
      end = endText === undefined ? (stepText === undefined ? start : spec.max) : parseValue(endText, spec, expression);
      if (end < start) throw invalid(expression, `${spec.name} range "${rangeText}" is reversed`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
};

export const parseCron = (expression: string): CronSchedule => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw invalid(expression, 'must have 5 fields: minute hour day-of-month month day-of-week');
  const [minute = '', hour = '', dayOfMonth = '', month = '', dayOfWeek = ''] = fields;
  const parsed = [minute, hour, dayOfMonth, month, dayOfWeek].map((field, index) => {
    const spec = FIELDS[index];
    if (!spec) throw invalid(expression, 'unexpected field');
    return parseField(field, spec, expression);
  });
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parsed;
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) throw invalid(expression, 'could not be parsed');
  if (daysOfWeek.has(7)) daysOfWeek.add(0);
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthRestricted: dayOfMonth !== '*',
    dayOfWeekRestricted: dayOfWeek !== '*',
  };
};

type LocalTime = { month: number; day: number; hour: number; minute: number; weekday: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, formatter);
    return formatter;
  } catch {
    throw new ValidationError('Invalid time zone', [{ path: 'timezone', message: `"${timeZone}" is not an IANA time zone` }]);
  }
};

export const isValidTimeZone = (timeZone: string): boolean => {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
};

const localTime = (epochMs: number, timeZone: string): LocalTime => {
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
  return {
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: DAY_NAMES.indexOf(String(parts.weekday).toLowerCase().slice(0, 3)),
  };
};

const dayMatches = (schedule: CronSchedule, time: LocalTime): boolean => {
  const byMonthDay = schedule.daysOfMonth.has(time.day);
  const byWeekday = schedule.daysOfWeek.has(time.weekday);
  if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) return byMonthDay || byWeekday;
  return byMonthDay && byWeekday;
};

const MINUTE_MS = 60_000;
const MAX_STEPS = 200_000;

/** The first time strictly after `afterMs` that matches the expression, as epoch milliseconds. */
export const nextCronRun = (expression: string, afterMs: number, timeZone = 'UTC'): number => {
  const schedule = parseCron(expression);
  let candidate = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const time = localTime(candidate, timeZone);
    if (!schedule.months.has(time.month) || !dayMatches(schedule, time)) {
      candidate += ((23 - time.hour) * 60 + (60 - time.minute)) * MINUTE_MS;
    } else if (!schedule.hours.has(time.hour)) {
      candidate += (60 - time.minute) * MINUTE_MS;
    } else if (!schedule.minutes.has(time.minute)) {
      candidate += MINUTE_MS;
    } else {
      return candidate;
    }
  }
  throw invalid(expression, 'never matches a real date');
};
