import * as path from "node:path";
import { mkdirSync } from "node:fs";

export interface FactoryPaths {
  root: string;
  inbox: string;
  items: string;
  archive: string;
  kb: string;
  proposals: string;
  logs: string;
}

export function makePaths(root: string): FactoryPaths {
  return {
    root,
    inbox: path.join(root, "inbox"),
    items: path.join(root, "items"),
    archive: path.join(root, "archive"),
    kb: path.join(root, "kb"),
    proposals: path.join(root, "proposals"),
    logs: path.join(root, "logs"),
  };
}

export function itemDir(p: FactoryPaths, slug: string): string {
  return path.join(p.items, slug);
}

export function itemFile(p: FactoryPaths, slug: string): string {
  return path.join(itemDir(p, slug), "item.md");
}

export function artifactDir(p: FactoryPaths, slug: string): string {
  return path.join(itemDir(p, slug), "artifacts");
}

export function ensureLayout(p: FactoryPaths): void {
  for (const dir of [p.root, p.inbox, p.items, p.archive, p.kb, p.proposals, p.logs]) {
    mkdirSync(dir, { recursive: true });
  }
}