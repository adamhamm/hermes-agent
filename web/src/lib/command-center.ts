import type { CronJob, NewsItem } from "@/lib/api";

/** Widgets the Command Center can show; order is the default layout order. */
export const COMMAND_WIDGETS = [
  "vitals",
  "jobs",
  "news",
  "sessions",
  "activity",
  "actions",
] as const;
export type CommandWidget = (typeof COMMAND_WIDGETS)[number];

export const REFRESH_INTERVALS = [0, 15, 30, 60] as const;
export type RefreshInterval = (typeof REFRESH_INTERVALS)[number];

export interface CommandPrefs {
  hidden: CommandWidget[];
  refresh: RefreshInterval;
  effects: boolean;
}

export const DEFAULT_COMMAND_PREFS: CommandPrefs = {
  hidden: [],
  refresh: 30,
  effects: true,
};

export const COMMAND_PREFS_KEY = "hermes-command-center-prefs";

/** Parse stored prefs defensively — unknown widgets / intervals are dropped. */
export function parseCommandPrefs(raw: string | null): CommandPrefs {
  if (!raw) return { ...DEFAULT_COMMAND_PREFS };
  try {
    const data = JSON.parse(raw) as Partial<Record<keyof CommandPrefs, unknown>>;
    const hidden = Array.isArray(data.hidden)
      ? data.hidden.filter((w): w is CommandWidget =>
          (COMMAND_WIDGETS as readonly unknown[]).includes(w),
        )
      : [];
    const refresh = (REFRESH_INTERVALS as readonly unknown[]).includes(data.refresh)
      ? (data.refresh as RefreshInterval)
      : DEFAULT_COMMAND_PREFS.refresh;
    const effects =
      typeof data.effects === "boolean" ? data.effects : DEFAULT_COMMAND_PREFS.effects;
    return { hidden, refresh, effects };
  } catch {
    return { ...DEFAULT_COMMAND_PREFS };
  }
}

export type JobFilter = "all" | "active" | "paused" | "failing";

export type JobHealth = "running" | "active" | "paused" | "failing" | "done";

export function jobHealth(job: CronJob): JobHealth {
  const state = (job.state ?? "").toLowerCase();
  if (state === "running") return "running";
  if (job.last_error || job.last_fire_error?.detail || job.last_status === "error") {
    return "failing";
  }
  if (!job.enabled || state === "paused") return "paused";
  if (state === "completed" || (!job.next_run_at && job.last_run_at)) return "done";
  return "active";
}

export function filterJobs(jobs: CronJob[], filter: JobFilter): CronJob[] {
  if (filter === "all") return jobs;
  return jobs.filter((job) => {
    const health = jobHealth(job);
    if (filter === "active") return health === "active" || health === "running";
    return health === filter;
  });
}

/** Running first, then soonest next run; jobs without a next run sink to the end. */
export function sortJobsByNextRun(jobs: CronJob[]): CronJob[] {
  const ts = (job: CronJob) => {
    const t = job.next_run_at ? Date.parse(job.next_run_at) : NaN;
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  return [...jobs].sort((a, b) => {
    const ra = jobHealth(a) === "running" ? 0 : 1;
    const rb = jobHealth(b) === "running" ? 0 : 1;
    return ra - rb || ts(a) - ts(b);
  });
}

/** Compact countdown: "now", "42s", "7m 05s", "3h 12m", "2d 4h". */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** "just now", "5m ago", "3h ago", "2d ago" from a unix-seconds timestamp. */
export function formatAgo(unixSeconds: number | null | undefined, nowMs = Date.now()): string {
  if (!unixSeconds) return "";
  const diff = Math.max(0, nowMs / 1000 - unixSeconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86_400)}d ago`;
}

export function formatUptime(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) return "—";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function filterNews(
  items: NewsItem[],
  source: string | null,
  query: string,
): NewsItem[] {
  const q = query.trim().toLowerCase();
  return items.filter(
    (item) =>
      (!source || item.source === source) &&
      (!q ||
        item.title.toLowerCase().includes(q) ||
        item.summary.toLowerCase().includes(q)),
  );
}

export function greetingKey(hour: number): "morning" | "afternoon" | "evening" | "night" {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}
