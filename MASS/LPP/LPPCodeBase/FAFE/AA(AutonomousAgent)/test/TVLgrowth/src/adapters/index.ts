import { uniswapMockAdapter } from "./mock/uniswap";
import { aerodromeMockAdapter } from "./mock/aerodrome";
import { VenueAdapter } from "../types";
import { getDexscreenerAdapter } from "./live/dexscreener";

const USE_LIVE =
  process.env.TVL_WATCHER_MODE &&
  process.env.TVL_WATCHER_MODE.toLowerCase() === "live";

export function getDefaultAdapters(): VenueAdapter[] {
  if (USE_LIVE) {
    return [getDexscreenerAdapter()];
  }
  return [uniswapMockAdapter, aerodromeMockAdapter];
}

