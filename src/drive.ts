/**
 * Drive-exit markers (specs/wb-interrupted-drives.spec.md §Exit markers).
 *
 * Every drive loop (`wb run`, `wb resume`, the web Start Processing drive)
 * ends its run log with exactly one terminal line, so a truncated log is
 * itself distinguishable from a cleanly-ended one: a SIGKILL (or any death
 * that runs no handler) leaves the marker missing, and the log's abrupt end
 * right after a stage transition IS the crash signature — documented as
 * such, not detectable at emit-time.
 *
 * Pure renderer, no I/O — testable without the CLI.
 */

export type DriveExit = "completed" | "capped" | "interrupted";

/**
 * The one canonical line per drive end-state:
 *
 * | case                                        | line                                                    |
 * |---------------------------------------------|---------------------------------------------------------|
 * | `wb run` natural end                        | `drive exited: completed (one stage per item)`          |
 * | resume (CLI + web drive) natural end        | `drive exited: completed (nothing actionable left)`    |
 * | resume safety cap                           | `drive exited: capped — run `wb resume` again to continue` |
 * | throw out of the drive body                 | `drive exited: interrupted — <error message>` (stderr)  |
 * | SIGTERM during the drive                    | `drive exited: interrupted (SIGTERM)` (stderr)           |
 *
 * `detail` is the error message on the throw path; the detail-less
 * interrupted call is the SIGTERM signature.
 */
export function driveExitLine(mode: "run" | "resume", exit: DriveExit, detail?: string): string {
  switch (exit) {
    case "completed":
      return mode === "run"
        ? "drive exited: completed (one stage per item)"
        : "drive exited: completed (nothing actionable left)";
    case "capped":
      return "drive exited: capped — run `wb resume` again to continue";
    case "interrupted":
      return detail !== undefined && detail.length > 0
        ? `drive exited: interrupted — ${detail}`
        : "drive exited: interrupted (SIGTERM)";
  }
}
