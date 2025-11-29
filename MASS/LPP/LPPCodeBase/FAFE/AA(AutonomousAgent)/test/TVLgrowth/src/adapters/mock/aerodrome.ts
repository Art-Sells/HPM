import fs from "node:fs";
import path from "node:path";

import { StaticAdapter } from "../staticAdapter";
import { QuoteSeed } from "../../types";

const FIXTURE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "quotes",
  "aerodrome-v2.json"
);

const FIXTURES = JSON.parse(
  fs.readFileSync(FIXTURE_PATH, "utf8")
) as Record<string, QuoteSeed[]>;

export const aerodromeMockAdapter = new StaticAdapter("aerodrome-v2", FIXTURES);

