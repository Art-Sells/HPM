import fs from "node:fs";
import path from "node:path";

import { Mispricing } from "../types";

export interface PlaybookEntry {
  pairId: string;
  borrowToken: string;
  sellVenue: string;
  buyVenue: string;
  edgeBps: number;
  expectedProfitUsd: number;
  recommendedSize: number;
  liquidityClass: string;
}

export interface Playbook {
  generatedAt: number;
  entries: PlaybookEntry[];
}

export function buildPlaybook(
  mispricings: Mispricing[],
  limit = 10
): Playbook {
  const sorted = [...mispricings]
    .sort((a, b) => b.expectedProfitUsd - a.expectedProfitUsd)
    .slice(0, limit);

  const entries = sorted.map((opp) => ({
    pairId: opp.pairId,
    borrowToken: opp.borrowToken,
    sellVenue: opp.sellVenue,
    buyVenue: opp.buyVenue,
    edgeBps: Number(opp.edgeBps.toFixed(2)),
    expectedProfitUsd: Number(opp.expectedProfitUsd.toFixed(2)),
    recommendedSize: Number(opp.recommendedSize.toFixed(2)),
    liquidityClass: opp.liquidityClass,
  }));

  return { generatedAt: Date.now(), entries };
}

export function persistPlaybook(playbook: Playbook) {
  const dir = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "strategies"
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `playbook-${new Date(playbook.generatedAt)
      .toISOString()
      .replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(file, JSON.stringify(playbook, null, 2));
}

