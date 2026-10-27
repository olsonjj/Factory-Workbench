import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import { mkdirSync, readdirSync, rmSync, mkdtempSync } from "node:fs";
import { createHarness, claim, type TestHarness } from "./helpers.js";
import {
  parseApprovalsInput,
  parseItemMarkdown,
  slugForTitle,
  validateItemDraft,
} from "../src/frontmatter.js";
import { authorItem, buildEditorTemplate, stripEditorComments, type AuthoringIO } from "../src/new.js";
import { splitCommand } from "../src/prompt.js";

class ScriptedIO implements AuthoringIO {
  readonly prompts: string[];
  promptCount = 0;
  questions: string[] = [];
  errCount = 0;
  editorBody: string;
  stdinBody: string;
  isInteractive: boolean;

  constructor(opts: {
    prompts?: string[];
    editorBody?: string;
    stdinBody?: string;
    isInteractive?: boolean;
  } = {}) {
    this.prompts = [...(opts.prompts ?? [])];
    this.editorBody = opts.editorBody ?? "";
    this.stdinBody = opts.stdinBody ?? "";
    this.isInteractive = opts.isInteractive ?? true;
  }

  out(_msg: string): void {}
  err(_msg: string): void {
    this.errCount += 1;
  }
  async prompt(question: string): Promise<string> {
    this.promptCount += 1;
    this.questions.push(question);
    return this.prompts.shift() ?? "";
  }
  async openEditor(_template: string): Promise<string> {
    return this.editorBody;
  }
  async readPipedStdin(): Promise<string> {
    return this.stdinBody;
  }
}

function makeGitRepo(dir: string): void {
  mkdirSync(path.join(dir, ".git"), { recursive: true });
}

const harnesses: TestHarness[] = [];
const tempDirs: string[] = [];

function newHarness(): TestHarness {
  const h = createHarness();
  harnesses.push(h);
  return h;
}

/** A standalone git repo (outside the factory root) usable by multiple flows. */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wb-new-repo-"));
  makeGitRepo(dir);
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const h of harnesses) h.cleanup();
  harnesses.length = 0;
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe("wb new", () => {
  it("interactive defaults: autonomous item with base main and the expected slug", async () => {
    const harness = newHarness();
    const repo = makeRepo();
    harness.db.insertItem({
      slug: "seed",
      title: "Seed",
      repo,
      base: "main",
      approvals: [],
      stage: "triage",
      status: "queued",
    });

    const io = new ScriptedIO({ prompts: ["Add dark mode", "", "", ""], editorBody: "Add a dark theme." });
    const result = await authorItem({}, harness.db, harness.paths, io);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slug).toBe("add-dark-mode");

    const file = path.join(harness.paths.inbox, "add-dark-mode.md");
    const parsed = parseItemMarkdown(harness.readFile(file));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.item.title).toBe("Add dark mode");
    expect(parsed.item.repo).toBe(repo);
    expect(parsed.item.base).toBe("main");
    expect(parsed.item.approvals).toEqual([]);
    expect(parsed.item.body).toBe("Add a dark theme.");
  });

  it("repo validation re-prompts rather than writing a bad path", async () => {
    const harness = newHarness();
    const repo = makeRepo();

    const io = new ScriptedIO({
      prompts: ["T", "/nonexistent", repo, "", ""],
      editorBody: "Body.",
    });
    const result = await authorItem({}, harness.db, harness.paths, io);

    expect(result.ok).toBe(true);
    // The repo step re-prompts: one bad path, then the valid path.
    expect(io.questions.filter((q) => q.startsWith("Repo")).length).toBe(2);
    // title + repo x2 + base + approvals
    expect(io.promptCount).toBe(5);

    const files = readdirSync(harness.paths.inbox).filter((f) => f.toLowerCase().endsWith(".md"));
    expect(files).toHaveLength(1);

    if (!result.ok) return;
    const parsed = parseItemMarkdown(harness.readFile(path.join(harness.paths.inbox, `${result.slug}.md`)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.item.repo).toBe(repo);
  });

  it("parses approval input (spaces, dedup, first-occurrence order) and round-trips", () => {
    expect(parseApprovalsInput("spec, review")).toEqual({ ok: true, approvals: ["spec", "review"] });
    expect(parseApprovalsInput(" review , spec ,spec ")).toEqual({ ok: true, approvals: ["review", "spec"] });
    expect(parseApprovalsInput("")).toEqual({ ok: true, approvals: [] });

    const bad = parseApprovalsInput("spec,bogus");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("bogus");

    const v = validateItemDraft({
      title: "T",
      repo: "/r",
      base: "main",
      approvals: ["spec", "review"],
      body: "Do it.",
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.parsed.approvals).toEqual(["spec", "review"]);
  });

  it("empty description aborts with a clear message and writes nothing", async () => {
    const harness = newHarness();
    const repo = makeRepo();
    const emptyFile = path.join(harness.root, "empty.md");
    harness.writeFile(emptyFile, "");

    const result = await authorItem(
      { title: "T", repo, descriptionFile: emptyFile },
      harness.db,
      harness.paths,
      new ScriptedIO({ isInteractive: false }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.aborted).toBe(true);
    expect(result.reason).toContain("empty");
    expect(readdirSync(harness.paths.inbox).filter((f) => f.toLowerCase().endsWith(".md"))).toHaveLength(0);
  });

  it("non-interactive flags produce the identical file the interactive flow would", async () => {
    const title = "Add dark mode";
    const repo = makeRepo();
    const base = "feature/dark";
    const approvals = "spec, review";
    const body = "Add a dark theme toggle.";

    const ha = newHarness();
    const io = new ScriptedIO({ prompts: [title, repo, base, approvals], editorBody: body });
    const resultA = await authorItem({}, ha.db, ha.paths, io);

    const hb = newHarness();
    const descFile = path.join(hb.root, "desc.md");
    hb.writeFile(descFile, body);
    const resultB = await authorItem(
      { title, repo, base, approvals, descriptionFile: descFile },
      hb.db,
      hb.paths,
      new ScriptedIO({ isInteractive: false }),
    );

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;
    expect(resultA.markdown).toBe(resultB.markdown);
    expect(resultA.slug).toBe(resultB.slug);
  });

  it("end-to-end: the authored file is claimed by wb run with the expected slug", async () => {
    const harness = newHarness();
    const repo = makeRepo();
    const descFile = path.join(harness.root, "desc.md");
    harness.writeFile(descFile, "Add a dark theme toggle.");

    const title = "Add dark mode";
    const result = await authorItem(
      { title, repo, base: "main", approvals: "spec,review", descriptionFile: descFile },
      harness.db,
      harness.paths,
      new ScriptedIO({ isInteractive: false }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slug).toBe(slugForTitle(title));

    const report = claim(harness);
    expect(report.claimed).toHaveLength(1);
    expect(report.malformed).toHaveLength(0);
    expect(report.claimed[0]!.slug).toBe(slugForTitle(title));

    const item = harness.db.findBySlug(result.slug);
    expect(item).toBeDefined();
    expect(item!.status).toBe("queued");
    expect(item!.stage).toBe("triage");
    expect(item!.title).toBe(title);
    expect(item!.repo).toBe(repo);
    expect(item!.base).toBe("main");
    expect(item!.approvals).toEqual(["spec", "review"]);

    // The inbox file physically moved into the item store.
    expect(() => harness.readFile(path.join(harness.paths.inbox, `${result.slug}.md`))).toThrow();
  });

  it("knownReposNewestFirst orders newest first and excludes (unknown)", () => {
    const harness = newHarness();
    harness.db.insertItem({ slug: "a", title: "A", repo: "/repo/A", base: "main", approvals: [], stage: "triage", status: "queued" });
    harness.db.insertItem({ slug: "b", title: "B", repo: "/repo/B", base: "main", approvals: [], stage: "triage", status: "queued" });
    harness.db.insertItem({ slug: "u", title: "U", repo: "(unknown)", base: "main", approvals: [], stage: "triage", status: "malformed" });

    const repos = harness.db.knownReposNewestFirst();
    expect(repos.map((r) => r.repo)).toEqual(["/repo/B", "/repo/A"]);
    expect(repos).toHaveLength(2);
    expect(repos[0]!.count).toBe(1);
    expect(repos[1]!.count).toBe(1);
    expect(repos.some((r) => r.repo === "(unknown)")).toBe(false);
  });

  it("a title whose slug is already claimed fails clearly instead of dead-dropping in the inbox", async () => {
    const harness = newHarness();
    harness.db.insertItem({
      slug: "add-dark-mode", title: "Add dark mode", repo: "/repo/X", base: "main",
      approvals: [], stage: "pr", status: "done",
    });

    const result = await authorItem(
      { title: "Add dark mode", repo: makeRepo(), description: "Different task, same title." },
      harness.db, harness.paths, new ScriptedIO({ isInteractive: false }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("add-dark-mode");
    expect(result.reason).toContain("different title");
    expect(readdirSync(harness.paths.inbox)).toHaveLength(0);
  });

  it("a title whose slug is held by a *rejected* item is allowed (resurrect-by-re-drop)", async () => {
    const harness = newHarness();
    const repo = makeRepo();
    harness.db.insertItem({
      slug: "add-dark-mode", title: "Add dark mode", repo, base: "main",
      approvals: [], stage: "triage", status: "rejected",
    });

    const result = await authorItem(
      { title: "Add dark mode", repo, description: "Re-worded after triage rejection." },
      harness.db, harness.paths, new ScriptedIO({ isInteractive: false }),
    );
    expect(result.ok).toBe(true);
  });

  it("a relative repo path is stored as an absolute path", async () => {
    const harness = newHarness();
    const repo = makeRepo();
    const relative = path.relative(process.cwd(), repo);

    const result = await authorItem(
      { title: "T", repo: relative, description: "Body." },
      harness.db, harness.paths, new ScriptedIO({ isInteractive: false }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain(`repo: ${repo}\n`);
  });

  it("concurrent same-title creation is exclusive: existing inbox file aborts, never clobbers", async () => {
    const harness = newHarness();
    const repo = makeRepo();
    const dest = path.join(harness.paths.inbox, "add-dark-mode.md");
    harness.writeFile(dest, "---\ntitle: Pre-existing\nrepo: /x\nbase: main\napprovals: []\n---\n\nfirst\n");

    const result = await authorItem(
      { title: "Add dark mode", repo, description: "Second, later write." },
      harness.db, harness.paths, new ScriptedIO({ isInteractive: false }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("inbox already has");
    // The first item's content survives untouched.
    expect(harness.readFile(dest)).toContain("first");
  });

  it("editor comment stripping removes only the generated block; user markdown (incl. '#' lines) survives", () => {
    const template = buildEditorTemplate({ title: "T", repo: "/r", base: "main", approvals: [] });
    expect(template.startsWith("<!--")).toBe(true);
    expect(template.trimEnd().endsWith("-->")).toBe(true);

    const authored = template + "## Requirements\n\n- treat `-` and `_` alike\n# a lone markdown line\n";
    const stripped = stripEditorComments(authored);

    expect(stripped).toBe("## Requirements\n\n- treat `-` and `_` alike\n# a lone markdown line");
  });

  it("stripEditorComments tolerates a deleted instruction block", () => {
    expect(stripEditorComments("\nBody only.\n")).toBe("Body only.");
  });

  it("a title containing '-->' cannot hijack the generated block's closing marker", () => {
    const template = buildEditorTemplate({ title: "Convert A --> B", repo: "/r", base: "main", approvals: [] });
    const authored = template + "## Requirements\n\nConvert A --> B, safely.\n";
    const stripped = stripEditorComments(authored);
    expect(stripped).toBe("## Requirements\n\nConvert A --> B, safely.");
    // An empty body still aborts even when the title contains '-->':
    expect(stripEditorComments(template)).toBe("");
  });

  it("splitEditorCommand honors quoted EDITOR paths and arguments", () => {
    expect(splitCommand('"/opt/My Editor/bin/editor" --wait')).toEqual(["/opt/My Editor/bin/editor", "--wait"]);
    expect(splitCommand("code -w")).toEqual(["code", "-w"]);
    expect(splitCommand("vi")).toEqual(["vi"]);
    expect(splitCommand("emacs -nw -f 'my fun func'")).toEqual(["emacs", "-nw", "-f", "my fun func"]);
  });
});
