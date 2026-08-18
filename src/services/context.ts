import type { GoogleHealthClient } from "./google-health-client.js";
import { buildWeeklySummary, type DailySummaryOptions } from "./summary.js";

type ContextOptions = DailySummaryOptions & { days?: number; soreness?: string[]; injury_flags?: string[]; notes?: string };
type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function loadFromActiveMinutes(activeMinutes?: number): "low" | "normal" | "high" | "unknown" {
  if (activeMinutes === undefined) return "unknown";
  if (activeMinutes >= 90) return "high";
  if (activeMinutes <= 20) return "low";
  return "normal";
}

export async function buildWellnessContext(client: Pick<GoogleHealthClient, "dailyRollup" | "reconcileDataPoints">, options: ContextOptions) {
  const days = Math.min(30, Math.max(1, Math.trunc(options.days ?? 7)));
  const summary = await buildWeeklySummary(client, { days, compare_days: 0, timezone: options.timezone });
  const scorecard = record(record(summary.scorecard).current);
  const activeZoneMinutes = num(scorecard.avg_active_zone_minutes);
  const sleepHours = num(scorecard.avg_sleep_hours);
  const recentTrainingLoad = loadFromActiveMinutes(activeZoneMinutes);

  return {
    source: "google_health" as const,
    generated_at: summary.generated_at,
    lookback_days: days,
    sleep_hours: sleepHours === undefined ? undefined : Math.round(sleepHours * 100) / 100,
    recent_training_load: recentTrainingLoad,
    soreness: options.soreness ?? [],
    injury_flags: options.injury_flags ?? [],
    notes: [options.notes, "Google Health API v4 beta connector; use as trend context, not diagnosis."].filter((note): note is string => Boolean(note)),
    data_quality: summary.data_quality,
    telegram_summary: [
      "Google Health wellness context",
      sleepHours !== undefined ? `Sleep (${days}-day average): ${Math.round(sleepHours * 10) / 10}h` : undefined,
      `Load (${days}-day average): ${recentTrainingLoad}`
    ].filter(Boolean).join(" | ")
  };
}

export function formatWellnessContextMarkdown(context: Record<string, unknown>): string {
  return ["# Google Health Wellness Context", "", JSON.stringify(context, null, 2)].join("\n");
}
