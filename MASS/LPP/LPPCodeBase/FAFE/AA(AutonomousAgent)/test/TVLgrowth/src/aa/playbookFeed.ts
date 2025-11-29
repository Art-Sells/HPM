import fs from "node:fs";
import path from "node:path";

import { Playbook, PlaybookEntry } from "../playbook/generator";

const DEFAULT_PLAYBOOK_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "strategies",
  "daily-playbook.json"
);

export interface LoadOptions {
  filePath?: string;
}

export function loadPlaybook(
  options: LoadOptions = {}
): Playbook | null {
  const file = options.filePath ?? DEFAULT_PLAYBOOK_PATH;
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as Playbook;
  return data;
}

export function loadPlaybookEntries(
  options: LoadOptions = {}
): PlaybookEntry[] {
  const book = loadPlaybook(options);
  return book ? book.entries : [];
}

