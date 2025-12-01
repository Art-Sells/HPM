import { uniswapMockAdapter } from "./mock/uniswap";
import { aerodromeMockAdapter } from "./mock/aerodrome";
import { VenueAdapter } from "../types";
import { getDexscreenerAdapter } from "./live/dexscreener";
import { getUniswapV3Adapter } from "./live/uniswapV3";
import { getAerodromeAdapter } from "./live/aerodrome";

const USE_LIVE =
  process.env.TVL_WATCHER_MODE &&
  process.env.TVL_WATCHER_MODE.toLowerCase() === "live";

const USE_DIRECT_DEX =
  process.env.TVL_WATCHER_DIRECT_DEX &&
  process.env.TVL_WATCHER_DIRECT_DEX.toLowerCase() === "1";

export function getDefaultAdapters(): VenueAdapter[] {
  if (USE_LIVE) {
    // Use direct on-chain adapters instead of Dexscreener for accurate pricing
    if (USE_DIRECT_DEX) {
      return [getUniswapV3Adapter(), getAerodromeAdapter()];
    }
    return [getDexscreenerAdapter()];
  }
  return [uniswapMockAdapter, aerodromeMockAdapter];
}

