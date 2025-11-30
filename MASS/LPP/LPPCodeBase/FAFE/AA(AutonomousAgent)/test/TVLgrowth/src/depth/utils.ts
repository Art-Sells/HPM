export function parseVenueId(venueId: string): {
  dexId: string;
  address?: string;
} {
  const [dexId, address] = venueId.split(":");
  return {
    dexId: (dexId ?? "").toLowerCase(),
    address,
  };
}

export function getDepthMode(): "live" | "mock" {
  const env =
    process.env.TVL_WATCHER_DEPTH_MODE ??
    (process.env.NODE_ENV === "test" ? "mock" : "live");
  return env.toLowerCase() === "mock" ? "mock" : "live";
}

export function limitPrecision(amount: number, decimals: number): string {
  const precision = Math.min(decimals, 8);
  return amount.toFixed(precision);
}


