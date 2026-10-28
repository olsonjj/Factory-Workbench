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
