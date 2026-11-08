import { existsSync, statSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseApprovalsInput, slugForTitle, validateItemDraft,
  type ItemDraft,
} from "./frontmatter.js";
import { APPROVAL_STAGES, type StageName } from "./types.js";
import type { FactoryDb } from "./db.js";
import type { FactoryPaths } from "./paths.js";

export interface AuthoringIO {
  isInteractive: boolean;
  out(msg: string): void;
  err(msg: string): void;
  prompt(question: string): Promise<string>;
  openEditor(template: string): Promise<string>; // returns comment-stripped body, "" = abort
  readPipedStdin(): Promise<string>;             // returns stdin content, "" if none
}

export interface NewOptions {
  title?: string;
  repo?: string;
  base?: string;
  approvals?: string;        // raw comma-separated (--approvals)
  description?: string;      // positional [description]
  descriptionFile?: string;  // --description-file
}

export type NewResult =
  | { ok: true; file: string; slug: string; markdown: string }
  | { ok: false; reason: string; aborted?: boolean };

export interface KnownRepo { repo: string; count: number }

/** Expand a raw repo input (CLI `--repo`, interactive answer, or composer
 *  field) into the absolute candidate path that `validateRepoPath` checks.
 *  Rules, applied in order:
 *  1. trim;
 *  2. `~` / `~/sub` expand against the operator's home directory
 *     (`os.homedir()` read lazily on every call, so env overrides work);
 *  3. a bare name equal to a known repo's basename resolves to that repo's
 *     stored path, resolved to ABSOLUTE (hand-written items can persist a
 *     relative `repo:`) — the FIRST match wins, and `knownRepos` arrive in
 *     `knownReposNewestFirst` order, so an ambiguous basename deterministically
 *     resolves to the newest repo;
 *  4. anything else resolves against `baseDir` (the factory root, never the
 *     process CWD); absolute inputs pass through unchanged. `~otheruser/x` is
 *  deliberately NOT tilde-expanded: it falls through to rules 3–4 and fails
 *  validation with a clear reason.
 *  The result is only ever fed to path validation — it is never persisted raw. */
export function expandRepoInput(
  raw: string,
  opts: { baseDir: string; knownRepos?: KnownRepo[] },
): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return path.resolve(os.homedir());
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  const known = opts.knownRepos;
  if (known) {
    for (const k of known) {
      if (path.basename(k.repo) === trimmed) {
        // Hand-written items persist `repo:` verbatim, so a stored entry can be
        // relative — resolve it (absolute entries are untouched) so expansion
        // never returns a CWD-dependent path.
        return path.resolve(k.repo);
      }
    }
  }
  return path.resolve(opts.baseDir, trimmed);
}

export function validateRepoPath(repo: string): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(repo)) return { ok: false, reason: `repo path does not exist: ${repo}` };
  if (!statSync(repo).isDirectory()) return { ok: false, reason: `repo path is not a directory: ${repo}` };
  if (!existsSync(path.join(repo, ".git")))
    return { ok: false, reason: `not a git repository (no .git): ${repo}` };
  return { ok: true };
}

export function buildEditorTemplate(d: { title: string; repo: string; base: string; approvals: StageName[] }): string {
  return [
    "<!--",
    "Write the work-item description below the closing marker. The description",
    "is the item's source of truth; this generated block is stripped on save",
    "(your own markdown — including '#'-prefixed lines — inside it is kept).",
    "",
    "Front-matter generated from your answers:",
    `  title: ${d.title}`,
    `  repo: ${d.repo}`,
    `  base: ${d.base}`,
    `  approvals: [${d.approvals.join(", ")}]`,
    "",
    "Leaving an empty body aborts: nothing is written.",
    "-->",
    "",
    "",
  ].join("\n");
}

/** Strip only the generated instruction block (an HTML comment), never user content. */
export function stripEditorComments(text: string): string {
  const lines = text.split("\n");
  // Tolerate leading blank lines before the generated block.
  let open = 0;
  while (open < lines.length && lines[open]!.trim() === "") open++;
  if (lines[open]?.trimStart().startsWith("<!--")) {
    // The closer must be a bare "-->" line — a title-interpolated "-->"
    // (e.g. "Convert A --> B") mid-line never matches.
    const close = lines.findIndex((l, i) => i > open && l.trim() === "-->");
    if (close !== -1) return lines.slice(close + 1).join("\n").trim();
  }
  return text.trim(); // generated block was deleted or not opened
}

export async function authorItem(opts: NewOptions, db: FactoryDb, paths: FactoryPaths, io: AuthoringIO): Promise<NewResult> {
  const canPrompt = io.isInteractive;

  // 1. title — required
  let title = (opts.title ?? "").trim();
  if (!title) {
    if (!canPrompt) return fail("--title is required when stdin is not a TTY");
    title = (await io.prompt("Title")).trim();
    if (!title) return fail("title is required");
  }

  // 2. repo — prompt with known-repos default, or validate --repo once.
  // Persist the absolute path: a relative path would otherwise be resolved
  // against whatever CWD the `wb run` happens to have later.
  const known = db.knownReposNewestFirst();
  let repo = (opts.repo ?? "").trim();
  if (!repo) {
    if (!canPrompt) return fail("--repo is required when stdin is not a TTY");
    repo = await promptRepo(io, known, paths.root);
  } else {
    repo = expandRepoInput(repo, { baseDir: paths.root, knownRepos: known });
    const v = validateRepoPath(repo);
    if (!v.ok) return fail(`--repo ${repo}: ${v.reason}`);
  }

  // 3. base — default "main"
  let base = (opts.base ?? "").trim() || "main";
  if (!opts.base && canPrompt) {
    const answer = (await io.prompt("Base branch [default: main]")).trim();
    if (answer) base = answer;
  }

  // 4. approvals — default [] (fully autonomous)
  let approvals: StageName[];
  if (opts.approvals !== undefined) {
    const r = parseApprovalsInput(opts.approvals);
    if (!r.ok) return fail(`--approvals: ${r.reason}`);
    approvals = r.approvals;
  } else if (canPrompt) {
    approvals = await promptApprovals(io);
  } else {
    approvals = [];
  }

  // 5. description
  const desc = await collectDescription(opts, io, canPrompt, { title, repo, base, approvals });
  if (desc.kind === "abort") return { ok: false, reason: desc.reason, aborted: true };
  const body = desc.body;

  // 6. slug + serialize + validate + write
  const slug = slugForTitle(title);
  const fileName = `${slug}.md`;
  const draft: ItemDraft = { title, repo, base, approvals, body };
  const v = validateItemDraft(draft);
  if (!v.ok) return fail(`refusing to write: ${v.reason}`);

  // A claimed/rejected item's inbox file is gone, so the inbox-file check
  // alone cannot catch a title whose slug is already taken: the re-dropped
  // file would then sit in the inbox skipped by every future scan. Check the
  // stored slugs too. (A *rejected* item is allowed: writing its file again
  // is the documented resurrect-by-re-drop flow.)
  const existing = db.findBySlug(slug);
  if (existing && existing.status !== "rejected") {
    return fail(
      `slug "${slug}" is already held by item #${existing.id} (${existing.status}) — ` +
      "pick a different title, or edit the existing item",
    );
  }

  const dest = path.join(paths.inbox, fileName);
  mkdirSync(paths.inbox, { recursive: true });
  // Exclusive create: a concurrent `wb new` with the same title loses
  // cleanly instead of silently clobbering the first item's content.
  try {
    writeFileSync(dest, v.markdown, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return fail(`inbox already has ${fileName} — run \`wb run\` to claim it first`);
    }
    throw err;
  }
  return { ok: true, file: path.relative(paths.root, dest), slug, markdown: v.markdown };
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

async function promptRepo(io: AuthoringIO, known: KnownRepo[], root: string): Promise<string> {
  for (;;) {
    if (known.length > 0) {
      io.out("Known repos (newest first):");
      known.forEach((k, i) =>
        io.out(`  ${i + 1}. ${k.repo}${k.count > 0 ? ` (${k.count} item${k.count === 1 ? "" : "s"})` : ""}`));
    }
    const def = known[0]?.repo;
    const raw = (
      await io.prompt(def ? `Repo [default: ${def}; enter a number above or a path]` : "Repo path")
    ).trim();
    let candidate: string | undefined;
    if (raw === "") candidate = def;
    else if (/^\d+$/.test(raw)) candidate = known[Number(raw) - 1]?.repo;
    else candidate = raw;
    if (!candidate) {
      io.err("No known repo to default to — enter a repository path.");
      continue;
    }
    const expanded = expandRepoInput(candidate, { baseDir: root, knownRepos: known });
    const v = validateRepoPath(expanded);
    if (!v.ok) { io.err(`${v.reason} — try again.`); continue; }
    return expanded;
  }
}

async function promptApprovals(io: AuthoringIO): Promise<StageName[]> {
  for (;;) {
    const raw = (
      await io.prompt(`Approval stages — comma-separated from: ${APPROVAL_STAGES.join(", ")} [default: none]`)
    ).trim();
    const r = parseApprovalsInput(raw);
    if (r.ok) return r.approvals;
    io.err(`${r.reason} — try again.`);
  }
}

type DescResult = { kind: "ok"; body: string } | { kind: "abort"; reason: string };

async function collectDescription(
  opts: NewOptions,
  io: AuthoringIO,
  canPrompt: boolean,
  fm: { title: string; repo: string; base: string; approvals: StageName[] },
): Promise<DescResult> {
  // `description` (positional) and `--description-file` are mutually exclusive.
  // Precedence: positional → --description-file → piped stdin (non-TTY) → $EDITOR.
  if (opts.description !== undefined && opts.descriptionFile !== undefined) {
    return { kind: "abort", reason: "specify the description either as an argument or with --description-file, not both" };
  }
  let body: string;
  if (opts.description !== undefined) {
    body = opts.description.trim();
  } else if (opts.descriptionFile !== undefined) {
    try {
      body = readFileSync(opts.descriptionFile, "utf8").trim();
    } catch (err) {
      return { kind: "abort", reason: `cannot read --description-file ${opts.descriptionFile}: ${err instanceof Error ? err.message : String(err)}` };
    }
  } else if (!canPrompt) {
    body = (await io.readPipedStdin()).trim();
  } else {
    body = (await io.openEditor(buildEditorTemplate(fm))).trim();
  }
  if (!body) return { kind: "abort", reason: "description is empty — nothing written" };
  return { kind: "ok", body };
}
