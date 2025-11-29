import path from "node:path";

import { runWatcherOnce, WATCHER_LOG_DIR } from "./watcher";
import { publishDashboard } from "./dashboard/publish";

export interface WatcherLoopOptions {
  durationMs?: number;
  intervalMs?: number;
  logDir?: string;
  outputDir?: string;
  publish?: boolean;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWatcherForDuration(
  options: WatcherLoopOptions = {}
) {
  if (!process.env.TVL_WATCHER_MODE) {
    process.env.TVL_WATCHER_MODE = "live";
  }
  const durationMs = options.durationMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 10_000;
  const logDir = options.logDir ?? WATCHER_LOG_DIR;
  const outputDir =
    options.outputDir ??
    path.join(path.dirname(logDir), "dashboard");
  const publish = options.publish !== false;

  const start = Date.now();
  let iterations = 0;
  // Run at least once even if duration is tiny
  do {
    await runWatcherOnce({ logDir });
    iterations += 1;
    if (Date.now() - start >= durationMs) {
      break;
    }
    await sleep(intervalMs);
  } while (Date.now() - start < durationMs);

  let publishResult: ReturnType<typeof publishDashboard> | null = null;
  if (publish) {
    publishResult = publishDashboard({ logsDir: logDir, outputDir });
  }

  return {
    iterations,
    durationMs: Date.now() - start,
    publishResult,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const durationMs = args[0] ? Number(args[0]) : undefined;
  const intervalMs = args[1] ? Number(args[1]) : undefined;
  const logDir = args[2];
  const outputDir = args[3];
  runWatcherForDuration({ durationMs, intervalMs, logDir, outputDir })
    .then((result) => {
      console.log(
        `[watcher-loop] ran ${result.iterations} iterations in ${
          result.durationMs / 1000
        }s`
      );
      if (result.publishResult) {
        console.log(
          `[watcher-loop] dashboard summary -> ${result.publishResult.filePath}`
        );
      }
    })
    .catch((err) => {
      console.error("[watcher-loop] failed", err);
      process.exit(1);
    });
}

