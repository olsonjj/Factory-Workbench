import type { FactoryDb } from "./db.js";
import type { ItemRecord } from "./types.js";

/** Short filesystem-safe timestamp: 20260113-142530-123. */
export function stamp(d = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `-${pad(d.getMilliseconds(), 3)}`
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Park an item as malformed front-matter: persist the parked state on the
 *  item row and emit the `parked` history row. Single shared implementation
 *  for both park sites — the claim path (`scanInbox`, src/inbox.ts) and the
 *  re-parse path (`refreshFromSource`, src/pipeline.ts) — so `wb watch`
 *  renders the parked line, fix hint, and OS notification for malformed
 *  items the same way regardless of where parking happened. The row's stage
 *  is `item.stage`: the stage the item was inserted with (claim path) or was
 *  working in (re-parse path). */
export function parkMalformed(db: FactoryDb, item: ItemRecord, reason: string): void {
  db.updateItem(item.id, {
    status: "malformed",
    parkedReason: `malformed front-matter: ${reason}`,
    parkedDetail: null,
  });
  db.appendHistory(item.id, "parked", item.stage, { reason });
}
