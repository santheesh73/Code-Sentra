import { describe, expect, it } from "vitest";
import { CronError, minCronIntervalMinutes, nextCronRun, parseCron } from "./cron.js";

const at = (iso: string) => new Date(iso);
const next = (expr: string, iso: string) => nextCronRun(expr, at(iso)).toISOString();

describe("cron", () => {
  it("steps minutes and hours, strictly after the given time", () => {
    expect(next("*/15 * * * *", "2026-10-22T10:07:30Z")).toBe("2026-10-22T10:15:00.000Z");
    expect(next("*/15 * * * *", "2026-10-22T10:15:00Z")).toBe("2026-10-22T10:30:00.000Z");
    expect(next("0 */6 * * *", "2026-10-22T19:00:00Z")).toBe("2026-10-23T00:00:00.000Z");
  });

  it("handles ranges, lists, months and year rollover", () => {
    expect(next("30 9 * * 1-5", "2026-10-23T10:00:00Z")).toBe("2026-10-26T09:30:00.000Z"); // Fri → Mon
    expect(next("0 0 1 1,7 *", "2026-10-22T00:00:00Z")).toBe("2027-01-01T00:00:00.000Z");
    expect(next("5 4 * * 7", "2026-10-22T00:00:00Z")).toBe("2026-10-25T04:05:00.000Z"); // 7 = Sunday
  });

  it("matches either day field when both are restricted (classic cron)", () => {
    // The 1st of the month or any Monday.
    expect(next("0 12 1 * 1", "2026-10-22T13:00:00Z")).toBe("2026-10-26T12:00:00.000Z");
    expect(next("0 12 1 * 1", "2026-10-27T13:00:00Z")).toBe("2026-11-01T12:00:00.000Z");
  });

  it("rejects malformed and impossible expressions", () => {
    for (const bad of [
      "* * * *",
      "60 * * * *",
      "* 24 * * *",
      "5-1 * * * *",
      "*/0 * * * *",
      "a * * * *",
    ])
      expect(() => parseCron(bad), bad).toThrow(CronError);
    expect(() => nextCronRun("0 0 30 2 *", at("2026-01-01T00:00:00Z"))).toThrow(CronError);
  });

  it("measures the minimum interval", () => {
    expect(minCronIntervalMinutes("*/5 * * * *", at("2026-10-22T00:00:00Z"))).toBe(5);
    expect(minCronIntervalMinutes("0,1 * * * *", at("2026-10-22T00:00:00Z"))).toBe(1);
    expect(minCronIntervalMinutes("0 3 * * *", at("2026-10-22T00:00:00Z"))).toBe(1440);
  });
});
