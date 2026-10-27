import { existsSync, statSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function validateRepoPath(repo: string): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(repo)) return { ok: false, reason: `repo path does not exist: ${repo}` };
  if (!statSync(repo).isDirectory()) return { ok: false, reason: `repo path is not a directory: ${repo}` };
  if (!existsSync(path.join(repo, ".git")))
    return { ok: false, reason: `not a git repository (no .git): ${repo}` };
  return { ok: true };
}

export function buildEditorTemplate(d: { title: string; repo: string; base: string; approvals: StageName[] }): string {
  return [
    "# Write the work-item description below this line. The description is the",
    "# item's source of truth. Lines starting with '#' are comments and ignored.",
    "#",
    "# Front-matter that will be generated from your answers:",
    `#   title: ${d.title}`,
    `#   repo: ${d.repo}`,
    `#   base: ${d.base}`,
    `#   approvals: [${d.approvals.join(", ")}]`,
    "#",
    "# Leaving this file empty (or only comments) aborts: nothing is written.",
    "",
    "",
  ].join("\n");
}

export function stripEditorComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .trim();
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

  // 2. repo — prompt with known-repos default, or validate --repo once
  const known = db.knownReposNewestFirst();
  let repo = (opts.repo ?? "").trim();
  if (!repo) {
    if (!canPrompt) return fail("--repo is required when stdin is not a TTY");
    repo = await promptRepo(io, known);
  } else {
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

  const dest = path.join(paths.inbox, fileName);
  if (existsSync(dest)) {
    return fail(`inbox already has ${fileName} — run \`wb run\` to claim it first`);
  }
  mkdirSync(paths.inbox, { recursive: true });
  writeFileSync(dest, v.markdown, "utf8");
  return { ok: true, file: path.relative(paths.root, dest), slug, markdown: v.markdown };
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

async function promptRepo(io: AuthoringIO, known: { repo: string; count: number }[]): Promise<string> {
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
    const v = validateRepoPath(candidate);
    if (!v.ok) { io.err(`${v.reason} — try again.`); continue; }
    return candidate;
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
