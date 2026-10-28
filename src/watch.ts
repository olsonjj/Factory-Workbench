/**
 * `wb watch` — live change feed with a compact status card.
 *
 * This module holds all rendering/diffing logic as pure, exported functions
 * (for tests) plus a thin polling loop. Strictly read-only with respect to the
 * factory: everything here only *reads* through a `FactoryDb` handle (opened
 * read-only by the CLI) and never takes the factory lock or writes anywhere.
 *
 * Event rendering keys off the DB `history.event` strings (`claimed`,
 * `resurrected`, `stage-gate-fail`, …), not the task-prose names.
 */

import { spawn } from "node:child_process";
import type { FactoryDb, HistoryFeedRow } from "./db.js";
import type { ItemRecord } from "./types.js";
import { ACTIONABLE_STATUSES, TERMINAL_STATUSES } from "./types.js";

export interface WatchEventRow {
  id: number;
  itemId: number;
  ts: string;
  event: string;
  stage: string | null;
  detail: Record<string, unknown>;
}

export interface WatchItem {
  id: number;
  slug: string;
  stage: string;
  status: string;
  parkedReason: string | null;
}

export interface WatchState {
  lastEventId: number;
  lastCard: string | null;
  first: boolean;
  /** Consecutive DB-read failures (error-tolerance counter; not diff state). */
  consecutiveReadFailures?: number;
}

export interface WatchOutcome {
  lines: string[];
  /** One entry per parked history row, in row order (fix hint excluded). */
  notificationTexts: string[];
  state: WatchState;
}

const BEL = "\x07";
const CARD_RULE = "─".repeat(50);
/** From the 5th consecutive failing DB read, surface once per failing poll. */
const READ_FAILURE_NOTICE_THRESHOLD = 5;

/**
 * Truncate to a total length of `max` *including* the `…` (repo idiom, see
 * `src/kb.ts` / `src/pipeline.ts`).
 */
export function ellipsize(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** `undefined` → 5; non-numeric → 1; otherwise clamped to ≥ 1, floored. */
export function parseIntervalSeconds(raw: string | undefined): number {
  if (raw === undefined) return 5;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.floor(n));
}

/**
 * Operator fix hint for a parked reason. Both the derived event reason and the
 * item's `parked_reason` are consulted for the malformed rule: re-parse
 * parking writes `detail.reason = parsed.reason` (not malformed-prefixed)
 * while the item's `parked_reason` starts with "malformed front-matter".
 */
export function parkedFixHint(reason: string, parkedReason: string | null, slug: string): string | null {
  if (reason.startsWith("malformed") || (parkedReason ?? "").startsWith("malformed")) {
    return `wb retry ${slug}  # fix front-matter first`;
  }
  switch (reason) {
    case "awaiting-approval":
      return `wb approve ${slug}`;
    case "needs-human":
      return `wb answer ${slug}`;
    case "human-rejected":
      return null;
    case "exhausted-rework":
    case "infrastructure-failure":
      return `wb retry ${slug}`;
    default:
      // Includes free-form infra messages ("infrastructure failure after …")
      // and unhandled-error: do not substring-match those.
      return `wb resume ${slug}`;
  }
}

/** Parked reason for an event: `detail.reason` if a non-empty string, else the item's parked_reason. */
function parkedReason(row: WatchEventRow, item: WatchItem | undefined): string {
  const d = row.detail;
  if (typeof d.reason === "string" && d.reason.length > 0) return d.reason;
  return item?.parkedReason ?? "unknown";
}

function stageLabel(row: WatchEventRow): string {
  return row.stage ?? "(unknown)";
}

/**
 * The `<event-text>` segment of a history line (everything after the slug).
 * `maxGateAttempts === null` means "unknown budget" — gate suffixes are omitted.
 */
export function formatEventText(
  row: WatchEventRow,
  item: WatchItem | undefined,
  maxGateAttempts: number | null,
): string {
  const detail = row.detail;
  const slug = item?.slug ?? "(unknown)";
  switch (row.event) {
    case "claimed":
    case "resurrected": {
      const label = row.event === "claimed" ? "claim" : "claim-resurrect";
      return label + (row.stage ? ` → ${row.stage}` : "");
    }
    case "stage-start": {
      let text = `${stageLabel(row)} → start`;
      const attempt = detail.attempt;
      // First attempt has no suffix; lockConflict rows carry no `attempt`.
      if (typeof attempt === "number" && attempt > 1 && maxGateAttempts !== null) {
        text += ` (gate ${attempt}/${maxGateAttempts})`;
      }
      return text;
    }
    case "stage-pass": {
      let text = `${stageLabel(row)} → pass`;
      if (typeof detail.nextStage === "string" && detail.nextStage.length > 0) {
        text += ` → ${detail.nextStage}`;
      }
      if (typeof detail.rounds === "number") {
        text += ` (r${detail.rounds})`;
      }
      return text;
    }
    case "stage-gate-fail": {
      let text = `${stageLabel(row)} → fail`;
      const attempt = detail.attempt;
      if (typeof attempt === "number" && maxGateAttempts !== null) {
        text += ` (gate ${attempt}/${maxGateAttempts})`;
      }
      return text;
    }
    case "parked": {
      const reason = parkedReason(row, item);
      let text = "parked" + (row.stage ? ` at ${row.stage}` : "") + ` — ${ellipsize(reason, 60)}`;
      const hint = parkedFixHint(reason, item?.parkedReason ?? null, slug);
      if (hint) text += ` → \`${hint}\``;
      return text;
    }
    case "unparked": {
      let text = "unparked" + (row.stage ? ` → ${row.stage}` : "");
      const via = typeof detail.via === "string" && detail.via.length > 0 ? detail.via : null;
      if (via) {
        const text2 =
          typeof detail.feedback === "string"
            ? detail.feedback
            : typeof detail.note === "string"
              ? detail.note
              : null;
        if (text2 !== null) {
          return `${text} (${via}: ${ellipsize(text2, 60)})`;
        }
        text += ` (${via})`;
      }
      return text;
    }
    case "answered":
      return "questions answered" + (row.stage ? ` → ${row.stage}` : "");
    case "pr-created":
      if (typeof detail.url === "string") {
        return `PR created → ${detail.url}`;
      }
      break; // no url: fall through to the unknown-event rule
    case "rejected-by-human": {
      const feedback = typeof detail.reason === "string" ? detail.reason : "";
      return "rejected" + (row.stage ? ` at ${row.stage}` : "") + ` — ${ellipsize(feedback, 60)}`;
    }
  }
  // Unknown/other events (stage-retry, approved, archived, anything new).
  let text = row.event + (row.stage ? ` ${row.stage}` : "");
  const keys = Object.keys(detail);
  if (keys.length > 0) text += ` (${keys.join(", ")})`;
  return text;
}

/** `HH:MM:SS` local time from a history `ts`; `00:00:00` when unparseable. */
function formatClock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "00:00:00";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Full history line, including the parked-line `⚠`/`(!)`/bell decoration. */
export function formatEventLine(
  row: WatchEventRow,
  item: WatchItem | undefined,
  maxGateAttempts: number | null,
): string {
  const clock = formatClock(row.ts);
  const slug = item?.slug ?? "(unknown)";
  const text = formatEventText(row, item, maxGateAttempts);
  if (row.event === "parked") {
    return `⚠ [${clock}] (!) #${row.itemId} ${slug} ${text}${BEL}`;
  }
  return `[${clock}] #${row.itemId} ${slug} ${text}`;
}

/** OS-notification text for a parked row (fix hint excluded, stage omitted when null). */
function parkedNotificationText(row: WatchEventRow, item: WatchItem | undefined): string {
  const slug = item?.slug ?? "(unknown)";
  const reason = ellipsize(parkedReason(row, item), 60);
  return `#${row.itemId} ${slug} parked` + (row.stage ? ` at ${row.stage}` : "") + ` — ${reason}`;
}

/** The compact status card: two content lines between 50-char rules. */
export function renderCard(items: WatchItem[]): string {
  const run = items
    .filter((i) => (ACTIONABLE_STATUSES as readonly string[]).includes(i.status))
    .map((i) => `#${i.id} ${i.slug} ${i.stage}`);
  const parked = items
    .filter(
      (i) =>
        !(ACTIONABLE_STATUSES as readonly string[]).includes(i.status) &&
        !(TERMINAL_STATUSES as readonly string[]).includes(i.status),
    )
    .map((i) => `#${i.id} ${i.slug} (${ellipsize(i.parkedReason ?? "?", 60)})`);
  const runLine = run.length > 0 ? `RUN: ${run.join(" · ")}` : "RUN: none";
  const parkedLine = parked.length > 0 ? `PARKED: ${parked.join(" · ")}` : "PARKED: none";
  return [CARD_RULE, `  ${ellipsize(runLine, 80)}`, `  ${ellipsize(parkedLine, 80)}`, CARD_RULE].join("\n");
}

/**
 * One watch step over already-fetched rows + items snapshot.
 * - First poll primes silently: consume everything, print nothing, store the card.
 * - Later polls: render only rows with id > lastEventId, then the card iff it changed.
 */
export function runWatchOnce(
  rows: WatchEventRow[],
  items: WatchItem[],
  state: WatchState,
  maxGateAttempts: number | null,
): WatchOutcome {
  const fresh = rows.filter((r) => r.id > state.lastEventId).sort((a, b) => a.id - b.id);
  const next: WatchState = { ...state };
  if (state.first) {
    next.first = false;
    next.lastEventId = fresh.length > 0 ? fresh[fresh.length - 1]!.id : state.lastEventId;
    // Prime the card silently — it is only compared against, never printed.
    next.lastCard = renderCard(items);
    return { lines: [], notificationTexts: [], state: next };
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  const lines: string[] = [];
  const notificationTexts: string[] = [];
  for (const row of fresh) {
    const item = byId.get(row.itemId);
    lines.push(formatEventLine(row, item, maxGateAttempts));
    if (row.event === "parked") notificationTexts.push(parkedNotificationText(row, item));
  }
  if (fresh.length > 0) next.lastEventId = fresh[fresh.length - 1]!.id;
  const card = renderCard(items);
  if (card !== state.lastCard) {
    lines.push(card);
    next.lastCard = card;
  }
  return { lines, notificationTexts, state: next };
}

function toWatchItem(item: ItemRecord): WatchItem {
  return { id: item.id, slug: item.slug, stage: item.stage, status: item.status, parkedReason: item.parkedReason };
}

function toWatchEventRow(r: HistoryFeedRow): WatchEventRow {
  return { id: r.id, itemId: r.item_id, ts: r.ts, event: r.event, stage: r.stage, detail: r.detail };
}

/**
 * One DB poll: query, then `runWatchOnce`. DB read errors are tolerated
 * ("no data yet"): a failing poll prints nothing and bumps a consecutive-
 * failure counter; from the 5th consecutive failure a short notice is printed
 * to stderr once per failing poll. Never crashes, never takes the lock.
 */
export function pollOnce(db: FactoryDb, state: WatchState, maxGateAttempts: number | null): WatchOutcome {
  try {
    const items = db.listItems().map(toWatchItem);
    if (state.first) {
      // Prime to the current max id so nothing existing is printed.
      const maxId = db.getMaxHistoryId() ?? 0;
      const outcome = runWatchOnce([], items, { ...state, lastEventId: maxId }, maxGateAttempts);
      return { ...outcome, state: { ...outcome.state, consecutiveReadFailures: 0 } };
    }
    const rows = db.getHistorySince(state.lastEventId).map(toWatchEventRow);
    const outcome = runWatchOnce(rows, items, state, maxGateAttempts);
    return { ...outcome, state: { ...outcome.state, consecutiveReadFailures: 0 } };
  } catch {
    const failures = (state.consecutiveReadFailures ?? 0) + 1;
    if (failures >= READ_FAILURE_NOTICE_THRESHOLD) {
      console.error("factory: db read failed (repeated) — still polling");
    }
    return { lines: [], notificationTexts: [], state: { ...state, consecutiveReadFailures: failures } };
  }
}

/** Schedules the next poll; injectable so tests never need real timers. */
export type WatchTick = (next: () => void) => void;

/**
 * The live loop: first poll immediately, then one chained (non-drifting)
 * `tick` per completed poll. Returns a stop function. `out` defaults to
 * stdout, `notify` to the OS notifier.
 */
export function startWatch(
  db: FactoryDb,
  state: WatchState,
  maxGateAttempts: number | null,
  intervalSec: number,
  out: (line: string) => void = console.log,
  notify: (text: string) => void = (text) => notifyParked(text),
  tick: WatchTick = (next) => {
    setTimeout(next, intervalSec * 1000);
  },
): () => void {
  let current = state;
  let stopped = false;
  const poll = () => {
    if (stopped) return;
    const outcome = pollOnce(db, current, maxGateAttempts);
    current = outcome.state;
    for (const line of outcome.lines) out(line);
    for (const text of outcome.notificationTexts) notify(text);
    if (!stopped) tick(poll);
  };
  poll();
  return () => {
    stopped = true;
  };
}

/** Minimal shape notifyParked needs from a spawn implementation. */
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { stdio: "ignore"; detached: boolean },
) => { unref?: () => void; on?: (event: "error", handler: () => void) => void };

/**
 * Escape a string for embedding inside an AppleScript double-quoted string
 * literal: backslash first, then double-quote, and flatten newlines (an
 * embedded `"` would otherwise close the literal and let a parked reason
 * inject script — e.g. `do shell script …` — into the osascript source).
 */
function escapeAppleScriptString(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
}

/**
 * Best-effort, fire-and-forget OS notification for a parked line. Never
 * throws: any spawn failure is swallowed, the child is detached and unref'd so
 * it can never block or crash `wb`. argv arrays prevent *shell* injection,
 * but the darwin payload is AppleScript source, so the text is escaped for
 * the AppleScript string literal too (see `escapeAppleScriptString`).
 */
export function notifyParked(text: string, platform: string = process.platform, spawnFn: SpawnFn = spawn): void {
  try {
    let child: ReturnType<SpawnFn> | undefined;
    if (platform === "darwin") {
      const safe = escapeAppleScriptString(text);
      child = spawnFn("osascript", ["-e", `display notification "${safe}" with title "Workbench"`], {
        stdio: "ignore",
        detached: true,
      });
    } else if (platform === "linux") {
      // notify-send <options> <summary> [body]: -t is the expire timeout (ms).
      child = spawnFn("notify-send", ["-t", "5000", "Workbench", text], { stdio: "ignore", detached: true });
    } else {
      return;
    }
    // Spawn failures like ENOENT (binary missing) are reported *asynchronously*
    // on the child's "error" event — a synchronous try/catch cannot catch them,
    // and an unhandled "error" would crash the process. Subscribe a no-op so
    // best-effort really is best-effort.
    child?.on?.("error", () => {});
    child?.unref?.();
  } catch {
    // Swallowed: notifications are best-effort only.
  }
}