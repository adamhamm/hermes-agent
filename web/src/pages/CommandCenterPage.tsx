import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "react-router";
import {
  Activity,
  Clock,
  Cpu,
  ExternalLink,
  FileText,
  Newspaper,
  Package,
  Pause,
  Play,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Stethoscope,
  Terminal,
  Zap,
} from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Switch } from "@nous-research/ui/ui/components/switch";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { api } from "@/lib/api";
import type {
  CronJob,
  NewsResponse,
  SessionInfo,
  StatusResponse,
  SystemStats,
} from "@/lib/api";
import { classifyLine } from "@/lib/log-classify";
import {
  COMMAND_PREFS_KEY,
  COMMAND_WIDGETS,
  REFRESH_INTERVALS,
  filterJobs,
  filterNews,
  formatAgo,
  formatCountdown,
  formatUptime,
  greetingKey,
  jobHealth,
  parseCommandPrefs,
  sortJobsByNextRun,
  type CommandPrefs,
  type CommandWidget,
  type JobFilter,
  type JobHealth,
} from "@/lib/command-center";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { en } from "@/i18n/en";
import { usePageHeader } from "@/contexts/usePageHeader";
import { PluginSlot } from "@/plugins";

type Strings = NonNullable<typeof en.command>;

const NEWS_POLL_MS = 5 * 60_000;

const HEALTH_COLOR: Record<JobHealth, string> = {
  running: "text-sky-400",
  active: "text-success",
  paused: "text-text-tertiary",
  failing: "text-destructive",
  done: "text-text-secondary",
};

const LOG_COLOR: Record<string, string> = {
  error: "text-destructive",
  warning: "text-warning",
  info: "text-text-secondary",
  debug: "text-text-tertiary",
};

function jobProfile(job: CronJob): string {
  return (job.profile || job.profile_name || "default").trim() || "default";
}

function loadPrefs(): CommandPrefs {
  try {
    return parseCommandPrefs(localStorage.getItem(COMMAND_PREFS_KEY));
  } catch {
    return parseCommandPrefs(null);
  }
}

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export default function CommandCenterPage() {
  const { t } = useI18n();
  const s: Strings = useMemo(() => ({ ...en.command!, ...t.command }), [t]);
  const navigate = useNavigate();
  const { setAfterTitle, setEnd } = usePageHeader();
  const { toast, showToast } = useToast();

  const [prefs, setPrefs] = useState<CommandPrefs>(loadPrefs);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const updatePrefs = useCallback((patch: Partial<CommandPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(COMMAND_PREFS_KEY, JSON.stringify(next));
      } catch { /* storage unavailable — prefs stay in memory */ }
      return next;
    });
  }, []);
  const shown = (w: CommandWidget) => !prefs.hidden.includes(w);

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [logLines, setLogLines] = useState<string[] | null>(null);
  const [news, setNews] = useState<NewsResponse | null>(null);
  const [newsError, setNewsError] = useState(false);
  const [newsLoading, setNewsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const busyRef = useRef(false);

  const refreshCore = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    await Promise.allSettled([
      api.getStatus().then(setStatus),
      api.getSystemStats().then(setStats),
      api.getCronJobs("all").then(setJobs),
      api.getSessions(8, 0, undefined, "recent").then((r) => setSessions(r.sessions)),
      api.getLogs({ file: "agent", lines: 40 }).then((r) => setLogLines(r.lines)),
    ]);
    busyRef.current = false;
    setLoading(false);
    setLastSync(Date.now());
  }, []);

  const refreshNews = useCallback((force = false) => {
    setNewsLoading(true);
    api
      .getNews({ refresh: force, limit: 60 })
      .then((r) => {
        setNews(r);
        setNewsError(false);
      })
      .catch(() => setNewsError(true))
      .finally(() => setNewsLoading(false));
  }, []);

  const refreshAll = useCallback(() => {
    void refreshCore();
    refreshNews(true);
  }, [refreshCore, refreshNews]);

  useEffect(() => {
    void refreshCore();
    refreshNews();
    const id = setInterval(() => refreshNews(), NEWS_POLL_MS);
    return () => clearInterval(id);
  }, [refreshCore, refreshNews]);

  useEffect(() => {
    if (!prefs.refresh) return;
    const id = setInterval(() => void refreshCore(), prefs.refresh * 1000);
    return () => clearInterval(id);
  }, [prefs.refresh, refreshCore]);

  // "r" refreshes everything (ignored while typing in an input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.key === "r" && !e.metaKey && !e.ctrlKey && !e.altKey) refreshAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refreshAll]);

  const runJobAction = useCallback(
    async (job: CronJob, action: "trigger" | "pause" | "resume") => {
      const profile = jobProfile(job);
      try {
        if (action === "trigger") await api.triggerCronJob(job.id, profile);
        else if (action === "pause") await api.pauseCronJob(job.id, profile);
        else await api.resumeCronJob(job.id, profile);
        showToast(`${job.name || job.id}: ${action === "trigger" ? s.runNow : action === "pause" ? s.pause : s.resume}`, "success");
      } catch (err) {
        showToast(`${s.actionFailed}: ${String(err)}`, "error");
      }
      void refreshCore();
    },
    [refreshCore, s, showToast],
  );

  useLayoutEffect(() => {
    setAfterTitle(
      <Button
        type="button"
        ghost
        size="icon"
        onClick={refreshAll}
        disabled={loading}
        aria-label={s.refreshAll}
        title={`${s.refreshAll} (R)`}
        className="text-muted-foreground hover:text-foreground"
      >
        {loading ? <Spinner /> : <RefreshCw />}
      </Button>,
    );
    setEnd(
      <Button
        type="button"
        ghost
        size="sm"
        onClick={() => setCustomizeOpen((v) => !v)}
        aria-expanded={customizeOpen}
        aria-controls="cc-customize"
      >
        <SlidersHorizontal className="h-4 w-4" />
        {s.customize}
      </Button>,
    );
    return () => {
      setAfterTitle(null);
      setEnd(null);
    };
  }, [customizeOpen, loading, refreshAll, s, setAfterTitle, setEnd]);

  const activeJobs = (jobs ?? []).filter((j) => {
    const h = jobHealth(j);
    return h === "active" || h === "running";
  }).length;
  const failingJobs = (jobs ?? []).filter((j) => jobHealth(j) === "failing").length;
  const degraded =
    (status !== null && !status.gateway_running) ||
    failingJobs > 0 ||
    status?.memory?.pressure === "critical" ||
    status?.disk?.pressure === "critical";

  const widgetLabels: Record<CommandWidget, string> = {
    vitals: s.vitals,
    jobs: s.jobs,
    news: s.news,
    sessions: s.sessions,
    activity: s.activity,
    actions: s.actions,
  };

  return (
    <div
      className="cc-root flex flex-col gap-4"
      data-effects={prefs.effects ? "on" : "off"}
    >
      <PluginSlot name="command:top" />

      <HeroBar
        s={s}
        status={status}
        stats={stats}
        activeJobs={activeJobs}
        degraded={degraded}
        lastSync={lastSync}
      />

      {customizeOpen && (
        <section id="cc-customize" className="hud-panel p-4" aria-label={s.customize}>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="flex flex-col gap-2">
              <span className="hud-title">{s.widgets}</span>
              <div className="flex flex-wrap gap-2">
                {COMMAND_WIDGETS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    className="hud-chip"
                    data-active={shown(w)}
                    aria-pressed={shown(w)}
                    onClick={() =>
                      updatePrefs({
                        hidden: shown(w)
                          ? [...prefs.hidden, w]
                          : prefs.hidden.filter((x) => x !== w),
                      })
                    }
                  >
                    {widgetLabels[w]}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <span className="hud-title">{s.autoRefresh}</span>
              <div className="flex flex-wrap gap-2">
                {REFRESH_INTERVALS.map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    className="hud-chip"
                    data-active={prefs.refresh === sec}
                    aria-pressed={prefs.refresh === sec}
                    onClick={() => updatePrefs({ refresh: sec })}
                  >
                    {sec === 0 ? s.refreshOff : `${sec}s`}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center justify-between gap-3 md:justify-start">
              <span className="hud-title">{s.effects}</span>
              <Switch
                checked={prefs.effects}
                onCheckedChange={(v) => updatePrefs({ effects: v })}
              />
            </label>
          </div>
        </section>
      )}

      {shown("news") && news && news.items.length > 0 && prefs.effects && (
        <NewsTicker items={news.items.slice(0, 12)} />
      )}

      <div className="grid gap-4 xl:grid-cols-12">
        {shown("vitals") && (
          <Panel title={s.vitals} icon={<Cpu />} className="xl:col-span-4">
            <Vitals s={s} stats={stats} />
          </Panel>
        )}
        {shown("jobs") && (
          <Panel
            title={s.jobs}
            icon={<Clock />}
            className="xl:col-span-8"
            actions={
              <Link to="/cron" className="hud-chip hover:text-midground">
                <Plus className="h-3 w-3" /> {s.createJob}
              </Link>
            }
          >
            <JobsPanel s={s} jobs={jobs} onAction={runJobAction} />
          </Panel>
        )}
        {shown("news") && (
          <Panel
            title={s.news}
            icon={<Newspaper />}
            className="xl:col-span-7"
            actions={
              <button
                type="button"
                className="hud-chip hover:text-midground"
                onClick={() => refreshNews(true)}
                disabled={newsLoading}
                aria-label={t.common.refresh}
              >
                <RefreshCw className={cn("h-3 w-3", newsLoading && "animate-spin")} />
              </button>
            }
          >
            <NewsPanel s={s} news={news} error={newsError} />
          </Panel>
        )}
        {shown("sessions") && (
          <Panel
            title={s.sessions}
            icon={<Activity />}
            className="xl:col-span-5"
            actions={
              <Link to="/sessions" className="hud-chip hover:text-midground">
                {s.viewAll}
              </Link>
            }
          >
            <SessionsPanel
              s={s}
              sessions={sessions}
              onResume={(id) => navigate(`/chat?resume=${encodeURIComponent(id)}`)}
            />
          </Panel>
        )}
        {shown("activity") && (
          <Panel
            title={s.activity}
            icon={<FileText />}
            className="xl:col-span-7"
            actions={
              <Link to="/logs" className="hud-chip hover:text-midground">
                {s.viewAll}
              </Link>
            }
          >
            <ActivityPanel s={s} lines={logLines} />
          </Panel>
        )}
        {shown("actions") && (
          <Panel title={s.actions} icon={<Zap />} className="xl:col-span-5">
            <QuickActions s={s} />
          </Panel>
        )}
      </div>

      <PluginSlot name="command:bottom" />
      <Toast toast={toast} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Panel({
  title,
  icon,
  actions,
  className,
  children,
}: {
  title: string;
  icon: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("hud-panel flex min-w-0 flex-col", className)} aria-label={title}>
      <span aria-hidden className="hud-scan" />
      <header className="flex items-center justify-between gap-2 border-b border-current/10 px-4 py-3">
        <h2 className="hud-title">
          <span aria-hidden className="text-midground [&>svg]:h-3.5 [&>svg]:w-3.5">
            {icon}
          </span>
          {title}
        </h2>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div className="min-h-0 flex-1 p-4">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="py-6 text-center font-mono text-xs uppercase tracking-[0.15em] text-text-tertiary">
      {children}
    </p>
  );
}

function Loading() {
  return (
    <div className="flex justify-center py-6">
      <Spinner />
    </div>
  );
}

function HeroBar({
  s,
  status,
  stats,
  activeJobs,
  degraded,
  lastSync,
}: {
  s: Strings;
  status: StatusResponse | null;
  stats: SystemStats | null;
  activeJobs: number;
  degraded: boolean;
  lastSync: number | null;
}) {
  const now = useNow();
  const date = new Date(now);
  const greeting = {
    morning: s.greetingMorning,
    afternoon: s.greetingAfternoon,
    evening: s.greetingEvening,
    night: s.greetingNight,
  }[greetingKey(date.getHours())];

  return (
    <section className="hud-panel flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between md:p-6">
      <span aria-hidden className="hud-scan" />
      <div className="flex items-center gap-4">
        <ArcReactor degraded={degraded} />
        <div className="min-w-0">
          <p className="hud-mono text-xs uppercase tracking-[0.3em] text-text-tertiary">
            J.A.R.V.I.S. // {s.title}
          </p>
          <p className="hud-glow text-2xl font-bold text-midground md:text-3xl">{greeting}</p>
          <p
            className={cn(
              "hud-mono mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs uppercase tracking-[0.15em] [&>span]:whitespace-nowrap",
              degraded ? "text-warning" : "text-success",
            )}
          >
            <span className="hud-dot hud-pulse" />
            <span>{degraded ? s.systemsDegraded : s.systemsNominal}</span>
            {status && (
              <span className={status.gateway_running ? "text-success" : "text-destructive"}>
                · {status.gateway_running ? s.gatewayOnline : s.gatewayOffline}
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 md:text-right">
        <Stat label={date.toLocaleDateString()} value={date.toLocaleTimeString()} />
        <Stat label={s.activeSessions} value={status ? status.active_sessions : "—"} />
        <Stat label={s.activeJobs} value={activeJobs} />
        <Stat
          label={s.uptime}
          value={formatUptime(stats?.uptime_seconds)}
          hint={
            lastSync ? `${s.lastSync}: ${new Date(lastSync).toLocaleTimeString()}` : undefined
          }
        />
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0">
      <div className={cn("hud-mono hud-glow truncate text-xl text-midground", tone)}>{value}</div>
      <div className="truncate font-mono text-[0.65rem] uppercase tracking-[0.15em] text-text-tertiary">
        {label}
      </div>
      {hint && (
        <div className="truncate font-mono text-[0.6rem] uppercase tracking-[0.1em] text-text-tertiary/70">
          {hint}
        </div>
      )}
    </div>
  );
}

function ArcReactor({ degraded }: { degraded: boolean }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn("h-16 w-16 shrink-0", degraded ? "text-warning" : "text-midground")}
      aria-hidden
    >
      <circle cx="32" cy="32" r="29" fill="none" stroke="currentColor" strokeOpacity="0.25" />
      <g className="hud-spin">
        <circle
          cx="32"
          cy="32"
          r="24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="10 6"
        />
      </g>
      <circle cx="32" cy="32" r="15" fill="none" stroke="currentColor" strokeOpacity="0.6" />
      <circle
        cx="32"
        cy="32"
        r="8"
        fill="currentColor"
        className="hud-pulse"
        style={{ filter: "drop-shadow(0 0 6px currentColor)" }}
      />
    </svg>
  );
}

function Gauge({ label, value, sub }: { label: string; value: number | null; sub?: string }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  const r = 30;
  const c = 2 * Math.PI * r;
  const tone =
    value === null ? "text-text-tertiary" : pct >= 90 ? "text-destructive" : pct >= 75 ? "text-warning" : "text-midground";
  return (
    <div className="flex flex-col items-center gap-1">
      <svg viewBox="0 0 80 80" className={cn("h-24 w-24", tone)} role="img" aria-label={`${label} ${value === null ? "—" : `${pct.toFixed(0)}%`}`}>
        <circle cx="40" cy="40" r={r} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="6" />
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          transform="rotate(-90 40 40)"
          style={{ transition: "stroke-dasharray 600ms ease", filter: "drop-shadow(0 0 4px currentColor)" }}
        />
        <text x="40" y="44" textAnchor="middle" className="hud-mono" fill="currentColor" fontSize="14">
          {value === null ? "—" : `${pct.toFixed(0)}%`}
        </text>
      </svg>
      <span className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-text-secondary">{label}</span>
      {sub && <span className="font-mono text-[0.6rem] text-text-tertiary">{sub}</span>}
    </div>
  );
}

function gb(bytes?: number) {
  return bytes === undefined ? "" : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function Vitals({ s, stats }: { s: Strings; stats: SystemStats | null }) {
  if (!stats) return <Loading />;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-2">
        <Gauge label={s.cpu} value={stats.cpu_percent ?? null} sub={stats.cpu_count ? `${stats.cpu_count} cores` : undefined} />
        <Gauge
          label={s.memory}
          value={stats.memory?.percent ?? null}
          sub={stats.memory ? `${gb(stats.memory.used)} / ${gb(stats.memory.total)}` : undefined}
        />
        <Gauge
          label={s.disk}
          value={stats.disk?.percent ?? null}
          sub={stats.disk ? `${gb(stats.disk.free)} free` : undefined}
        />
      </div>
      {!stats.psutil && <p className="text-xs text-text-tertiary">{s.statsUnavailable}</p>}
      <dl className="hud-mono grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-text-tertiary">HOST</dt>
        <dd className="truncate text-right">{stats.hostname}</dd>
        <dt className="text-text-tertiary">OS</dt>
        <dd className="truncate text-right">{stats.os} {stats.arch}</dd>
        {stats.load_avg && (
          <>
            <dt className="text-text-tertiary">{s.load.toUpperCase()}</dt>
            <dd className="text-right">{stats.load_avg.map((n) => n.toFixed(2)).join(" · ")}</dd>
          </>
        )}
        <dt className="text-text-tertiary">HERMES</dt>
        <dd className="text-right">v{stats.hermes_version}</dd>
      </dl>
    </div>
  );
}

function JobsPanel({
  s,
  jobs,
  onAction,
}: {
  s: Strings;
  jobs: CronJob[] | null;
  onAction: (job: CronJob, action: "trigger" | "pause" | "resume") => void;
}) {
  const [filter, setFilter] = useState<JobFilter>("all");
  const now = useNow();
  if (!jobs) return <Loading />;
  const filters: Array<[JobFilter, string]> = [
    ["all", s.filterAll],
    ["active", s.filterActive],
    ["paused", s.filterPaused],
    ["failing", s.filterFailing],
  ];
  const healthLabel: Record<JobHealth, string> = {
    running: s.healthRunning,
    active: s.healthActive,
    paused: s.healthPaused,
    failing: s.healthFailing,
    done: s.healthDone,
  };
  const visible = sortJobsByNextRun(filterJobs(jobs, filter));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2" role="group">
        {filters.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="hud-chip"
            data-active={filter === key}
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            {label} · {filterJobs(jobs, key).length}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <Empty>{s.jobsEmpty}</Empty>
      ) : (
        <ul className="max-h-80 overflow-y-auto">
          {visible.map((job) => {
            const health = jobHealth(job);
            const next = job.next_run_at ? Date.parse(job.next_run_at) : NaN;
            const paused = health === "paused";
            return (
              <li key={`${jobProfile(job)}:${job.id}`} className="hud-row flex items-center gap-3 px-1 py-2">
                <span className={cn("hud-dot", HEALTH_COLOR[health], health === "running" && "hud-pulse")} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-text-primary">
                    {job.name || job.prompt?.slice(0, 60) || job.id}
                  </div>
                  <div className="hud-mono truncate text-[0.7rem] text-text-tertiary">
                    {healthLabel[health]} · {job.schedule_display || job.schedule?.display || job.schedule?.expr || "—"}
                    {jobProfile(job) !== "default" && ` · ${jobProfile(job)}`}
                    {health === "failing" && (job.last_error || job.last_fire_error?.detail) && (
                      <span className="text-destructive"> · {job.last_error || job.last_fire_error?.detail}</span>
                    )}
                  </div>
                </div>
                <div className="hud-mono hidden w-24 text-right sm:block">
                  <div className="text-sm text-midground">
                    {Number.isFinite(next) && !paused ? formatCountdown(next - now) : "—"}
                  </div>
                  <div className="text-[0.6rem] uppercase tracking-[0.1em] text-text-tertiary">{s.nextRun}</div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    ghost
                    size="icon"
                    title={s.runNow}
                    aria-label={`${s.runNow}: ${job.name || job.id}`}
                    onClick={() => onAction(job, "trigger")}
                    disabled={health === "running"}
                  >
                    <Zap className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    ghost
                    size="icon"
                    title={paused ? s.resume : s.pause}
                    aria-label={`${paused ? s.resume : s.pause}: ${job.name || job.id}`}
                    onClick={() => onAction(job, paused ? "resume" : "pause")}
                  >
                    {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function NewsTicker({ items }: { items: NewsResponse["items"] }) {
  // Duplicated once so the -50% translate loops seamlessly.
  const loop = [...items, ...items];
  return (
    <div className="hud-panel overflow-hidden py-2" aria-hidden>
      <div className="hud-ticker">
        {loop.map((item, i) => (
          <a
            key={`${item.link}-${i}`}
            href={item.link}
            target="_blank"
            rel="noopener noreferrer"
            tabIndex={-1}
            className="hud-mono flex shrink-0 items-center gap-2 text-xs text-text-secondary hover:text-midground"
          >
            <span className="text-midground">▲ {item.source}</span>
            {item.title}
          </a>
        ))}
      </div>
    </div>
  );
}

function NewsPanel({
  s,
  news,
  error,
}: {
  s: Strings;
  news: NewsResponse | null;
  error: boolean;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const now = useNow(60_000);
  if (!news && !error) return <Loading />;
  const items = news?.items ?? [];
  const sources = (news?.feeds ?? []).filter((f) => f.ok && f.count > 0).map((f) => f.name);
  const failed = (news?.feeds ?? []).filter((f) => !f.ok);
  const visible = filterNews(items, source, query);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={s.newsSearch}
          aria-label={s.newsSearch}
          className="hud-mono min-w-0 flex-1 rounded border border-current/20 bg-transparent px-3 py-1.5 text-xs outline-none focus:border-midground"
        />
      </div>
      {sources.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="hud-chip"
            data-active={source === null}
            aria-pressed={source === null}
            onClick={() => setSource(null)}
          >
            {s.newsAllSources}
          </button>
          {sources.map((name) => (
            <button
              key={name}
              type="button"
              className="hud-chip"
              data-active={source === name}
              aria-pressed={source === name}
              onClick={() => setSource(source === name ? null : name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      {items.length === 0 ? (
        <Empty>{error || failed.length ? s.newsUnavailable : s.newsEmpty}</Empty>
      ) : visible.length === 0 ? (
        <Empty>{s.newsEmpty}</Empty>
      ) : (
        <ul className="max-h-[28rem] overflow-y-auto">
          {visible.map((item) => (
            <li key={item.link} className="hud-row">
              <a
                href={item.link}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex gap-3 px-1 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="hud-mono flex items-center gap-2 text-[0.65rem] uppercase tracking-[0.12em] text-text-tertiary">
                    <span className="text-midground">{item.source}</span>
                    {item.published && <span>{formatAgo(item.published, now)}</span>}
                  </div>
                  <div className="text-sm text-text-primary group-hover:text-midground">{item.title}</div>
                  {item.summary && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-text-secondary">{item.summary}</p>
                  )}
                </div>
                <ExternalLink className="mt-1 h-3.5 w-3.5 shrink-0 text-text-tertiary group-hover:text-midground" />
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="font-mono text-[0.6rem] text-text-tertiary">
        {failed.length > 0 && `⚠ ${failed.map((f) => f.name).join(", ")} · `}
        {s.newsFeedsHint}
      </p>
    </div>
  );
}

function SessionsPanel({
  s,
  sessions,
  onResume,
}: {
  s: Strings;
  sessions: SessionInfo[] | null;
  onResume: (id: string) => void;
}) {
  const now = useNow(30_000);
  if (!sessions) return <Loading />;
  if (sessions.length === 0) return <Empty>{s.sessionsEmpty}</Empty>;
  return (
    <ul>
      {sessions.map((session) => (
        <li key={session.id} className="hud-row flex items-center gap-3 px-1 py-2">
          <span
            className={cn(
              "hud-dot",
              session.is_active ? "hud-pulse text-success" : "text-text-tertiary",
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{session.title || session.preview || session.id}</div>
            <div className="hud-mono truncate text-[0.7rem] text-text-tertiary">
              {[session.source, session.model, `${session.message_count} msg`, formatAgo(session.last_active, now)]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
          <Button type="button" ghost size="sm" onClick={() => onResume(session.id)}>
            <Terminal className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{s.resumeSession}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

function ActivityPanel({ s, lines }: { s: Strings; lines: string[] | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  if (!lines) return <Loading />;
  const recent = lines.filter((l) => l.trim()).slice(-40);
  if (recent.length === 0) return <Empty>{s.activityEmpty}</Empty>;
  return (
    <div ref={ref} className="hud-mono max-h-72 overflow-y-auto text-[0.7rem] leading-relaxed">
      {recent.map((line, i) => (
        <div key={i} className={cn("whitespace-pre-wrap break-all", LOG_COLOR[classifyLine(line)])}>
          <span className="select-none text-midground/60">› </span>
          {line}
        </div>
      ))}
    </div>
  );
}

function QuickActions({ s }: { s: Strings }) {
  const actions: Array<{ to: string; label: string; icon: ReactNode }> = [
    { to: "/chat", label: s.actionChat, icon: <Terminal /> },
    { to: "/cron", label: s.actionJob, icon: <Clock /> },
    { to: "/models", label: s.actionModels, icon: <Cpu /> },
    { to: "/skills", label: s.actionSkills, icon: <Package /> },
    { to: "/logs", label: s.actionLogs, icon: <FileText /> },
    { to: "/system", label: s.actionSystem, icon: <Stethoscope /> },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {actions.map((a) => (
        <Link key={a.to} to={a.to} className="hud-action">
          <span className="text-midground [&>svg]:h-5 [&>svg]:w-5">{a.icon}</span>
          <span className="font-mono text-[0.7rem] uppercase tracking-[0.15em]">{a.label}</span>
        </Link>
      ))}
    </div>
  );
}
