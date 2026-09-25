import { describe, expect, it } from "vitest";
import type { CronJob, NewsItem } from "@/lib/api";
import {
  DEFAULT_COMMAND_PREFS,
  filterJobs,
  filterNews,
  formatAgo,
  formatCountdown,
  greetingKey,
  jobHealth,
  parseCommandPrefs,
  sortJobsByNextRun,
} from "./command-center";

const job = (over: Partial<CronJob>): CronJob => ({ id: "j", enabled: true, ...over });

describe("parseCommandPrefs", () => {
  it("falls back to defaults on garbage", () => {
    expect(parseCommandPrefs(null)).toEqual(DEFAULT_COMMAND_PREFS);
    expect(parseCommandPrefs("{not json")).toEqual(DEFAULT_COMMAND_PREFS);
  });

  it("drops unknown widgets and intervals", () => {
    expect(
      parseCommandPrefs(JSON.stringify({ hidden: ["news", "bogus"], refresh: 7, effects: false })),
    ).toEqual({ hidden: ["news"], refresh: 30, effects: false });
  });
});

describe("jobs", () => {
  it("classifies health", () => {
    expect(jobHealth(job({ state: "running" }))).toBe("running");
    expect(jobHealth(job({ last_error: "x" }))).toBe("failing");
    expect(jobHealth(job({ enabled: false }))).toBe("paused");
    expect(jobHealth(job({ next_run_at: "2026-01-01T00:00:00Z" }))).toBe("active");
    expect(jobHealth(job({ last_run_at: "2026-01-01T00:00:00Z" }))).toBe("done");
  });

  it("filters and sorts", () => {
    const a = job({ id: "a", next_run_at: "2026-01-02T00:00:00Z" });
    const b = job({ id: "b", next_run_at: "2026-01-01T00:00:00Z" });
    const c = job({ id: "c", enabled: false });
    const r = job({ id: "r", state: "running", next_run_at: "2027-01-01T00:00:00Z" });
    expect(sortJobsByNextRun([a, c, b, r]).map((j) => j.id)).toEqual(["r", "b", "a", "c"]);
    expect(filterJobs([a, c, r], "active").map((j) => j.id)).toEqual(["a", "r"]);
    expect(filterJobs([a, c, r], "paused").map((j) => j.id)).toEqual(["c"]);
  });
});

describe("formatting", () => {
  it("formats countdowns", () => {
    expect(formatCountdown(-5)).toBe("now");
    expect(formatCountdown(42_000)).toBe("42s");
    expect(formatCountdown(425_000)).toBe("7m 05s");
    expect(formatCountdown(3 * 3600_000 + 12 * 60_000)).toBe("3h 12m");
    expect(formatCountdown(2 * 86_400_000 + 4 * 3600_000)).toBe("2d 4h");
  });

  it("formats relative time", () => {
    const now = 1_000_000_000;
    expect(formatAgo(null, now)).toBe("");
    expect(formatAgo(now / 1000 - 10, now)).toBe("just now");
    expect(formatAgo(now / 1000 - 600, now)).toBe("10m ago");
  });

  it("greets by hour", () => {
    expect(greetingKey(8)).toBe("morning");
    expect(greetingKey(14)).toBe("afternoon");
    expect(greetingKey(20)).toBe("evening");
    expect(greetingKey(2)).toBe("night");
  });
});

describe("filterNews", () => {
  const items: NewsItem[] = [
    { title: "GPU prices", link: "https://a", summary: "", published: 1, source: "A" },
    { title: "New model", link: "https://b", summary: "agents everywhere", published: 2, source: "B" },
  ];
  it("filters by source and query", () => {
    expect(filterNews(items, "A", "")).toHaveLength(1);
    expect(filterNews(items, null, "AGENTS")[0].link).toBe("https://b");
    expect(filterNews(items, "A", "agents")).toHaveLength(0);
  });
});
