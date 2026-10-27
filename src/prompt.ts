import * as readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stamp } from "./util.js";
import { stripEditorComments, type AuthoringIO } from "./new.js";

async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(`${question}: `);
  } finally {
    rl.close();
  }
}

async function readPipedStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function openEditor(template: string): Promise<string> {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  const tmp = path.join(os.tmpdir(), `wb-new-${stamp()}.md`);
  writeFileSync(tmp, template, "utf8");
  try {
    const parts = editor.split(/\s+/).filter(Boolean);
    const bin = parts[0];
    if (!bin) throw new Error("editor command is empty");
    const args = parts.slice(1);
    const res = spawnSync(bin, [...args, tmp], { stdio: "inherit" });
    if (res.error) throw res.error;
    if (res.status !== 0) return ""; // editor aborted (non-zero exit)
    return stripEditorComments(readFileSync(tmp, "utf8"));
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function makeRealIO(): AuthoringIO {
  return {
    isInteractive: process.stdin.isTTY === true,
    out: (m) => console.log(m),
    err: (m) => console.error(m),
    prompt: promptLine,
    openEditor,
    readPipedStdin,
  };
}
