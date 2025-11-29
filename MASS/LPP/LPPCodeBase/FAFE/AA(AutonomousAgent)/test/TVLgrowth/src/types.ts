export type TokenSymbol = "USDC" | "ASSET" | "cbBTC" | string;

export type VenueId =
  | "uniswap-v3"
  | "aerodrome-v2"
  | "baseswap"
  | "odos"
  | "one-inch"
  | string;

export interface PairRequest {
  base: TokenSymbol;             // e.g. ASSET
  quote: TokenSymbol;            // e.g. USDC
  query?: string;                // optional custom search string for adapters
  baseAddress?: string;          // optional token contract address
  quoteAddress?: string;
  pairAddress?: string;          // optional DEX pair contract address
  chainId?: string;              // preferred chain (default Base)
}

export interface Quote {
  pairId: string;          // `${base}/${quote}`
  venueId: VenueId;
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountIn: number;        // standardized input size (e.g. 1 USDC)
  amountOut: number;       // expected output size
  price: number;           // amountOut / amountIn
  gasUsd: number;          // estimated gas cost in USD
  liquidityUsd: number;    // estimated accessible liquidity
  timestamp: number;       // unix ms
}

export type QuoteSeed = Omit<Quote, "venueId" | "timestamp">;

export interface LoanQuote {
  lender: string;
  asset: TokenSymbol;
  available: number;
  aprBps: number;
  maxDurationHours: number;
  timestamp: number;
}

export interface VenueAdapter {
  id: VenueId;
  fetchQuotes(pairs: PairRequest[]): Promise<Quote[]>;
}

export interface Mispricing {
  pairId: string;
  borrowToken: TokenSymbol;
  buyVenue: VenueId;   // venue where token is cheaper
  sellVenue: VenueId;  // venue where token fetches more
  edgeBps: number;
  expectedProfitUsd: number;
  recommendedSize: number; // units of borrowToken
  liquidityClass: "deep" | "mid" | "shallow";
  notes?: string;
}

export interface DetectionConfig {
  minProfitUsd: number;
  defaultTradeSize: number;
  liquidityFraction: number;
  minLiquidityUsd: number;
  maxPriceRatio: number;
  slippageBps: number;
}

export interface WatcherResult {
  timestamp: number;
  quotes: Quote[];
  mispricings: Mispricing[];
  loanQuotes: LoanQuote[];
}

