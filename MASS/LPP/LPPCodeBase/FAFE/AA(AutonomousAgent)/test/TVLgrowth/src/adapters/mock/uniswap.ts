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
  "uniswap-v3.json"
);

const FIXTURES = JSON.parse(
  fs.readFileSync(FIXTURE_PATH, "utf8")
) as Record<string, QuoteSeed[]>;

export const uniswapMockAdapter = new StaticAdapter("uniswap-v3", FIXTURES);

