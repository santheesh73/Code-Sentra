/**
 * Five-field cron (minute hour day-of-month month day-of-week), evaluated in UTC, for
 * recurring Pulses (Section 6 `schedules`). Supports `*`, numbers, ranges `a-b`, lists
 * `a,b` and steps `*\/n` / `a-b/n`. Day-of-week is 0-6 (0 = Sunday; 7 is accepted as
 * Sunday). As in classic cron, when both day fields are restricted, a day matches if
 * either does. Pure, so schedule timing is unit-tested.
 */
export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

export class CronError extends Error {
  override name = "CronError";
}

function parseField(text: string, f: (typeof FIELDS)[number]): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new CronError(`invalid ${f.name} "${part}"`);
    const step = m[4] === undefined ? 1 : Number(m[4]);
    let lo: number = f.min;
    let hi: number = f.max;
    if (m[1] !== "*") {
      lo = Number(m[2]);
      hi = m[3] === undefined ? (m[4] === undefined ? lo : f.max) : Number(m[3]);
    }
    if (step < 1) throw new CronError(`invalid ${f.name} step in "${part}"`);
    if (lo < f.min || hi > f.max || lo > hi)
      throw new CronError(`${f.name} "${part}" is outside ${f.min}-${f.max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new CronError("a cron expression has 5 fields: minute hour day month weekday");
  const [mi, h, d, mo, w] = parts.map((p, i) =>
    parseField(p, FIELDS[i] as (typeof FIELDS)[number]),
  );
  const weekdays = new Set([...(w as Set<number>)].map((x) => x % 7));
  return {
    minutes: mi as Set<number>,
    hours: h as Set<number>,
    days: d as Set<number>,
    months: mo as Set<number>,
    weekdays,
    dayRestricted: parts[2] !== "*",
    weekdayRestricted: parts[4] !== "*",
  };
}

function dayMatches(c: Cron, t: Date): boolean {
  const dom = c.days.has(t.getUTCDate());
  const dow = c.weekdays.has(t.getUTCDay());
  if (c.dayRestricted && c.weekdayRestricted) return dom || dow;
  if (c.dayRestricted) return dom;
  if (c.weekdayRestricted) return dow;
  return true;
}

/** The first matching minute strictly after `after` (UTC). Throws if none within 5 years. */
export function nextCronRun(expr: string | Cron, after: Date): Date {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const t = new Date(after.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 86_400_000;
  while (t.getTime() <= limit) {
    if (!c.months.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0);
      continue;
    }
    if (!dayMatches(c, t)) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0);
      continue;
    }
    if (!c.hours.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0);
      continue;
    }
    if (!c.minutes.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1);
      continue;
    }
    return t;
  }
  throw new CronError("the expression never matches (e.g. February 30)");
}

/** The shortest gap between consecutive runs over the next `samples` runs, in minutes. */
export function minCronIntervalMinutes(expr: string, from: Date, samples = 50): number {
  const c = parseCron(expr);
  let prev = nextCronRun(c, from);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < samples; i++) {
    const next = nextCronRun(c, prev);
    min = Math.min(min, (next.getTime() - prev.getTime()) / 60_000);
    prev = next;
  }
  return min;
}
