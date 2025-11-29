import {
  DetectionConfig,
  LoanQuote,
  Mispricing,
  PairRequest,
  Quote,
} from "../types";
import { simulateArb } from "../sim/arbitrage";

const DEFAULT_CONFIG: DetectionConfig = {
  minProfitUsd: 0,
  defaultTradeSize: 10_000, // denominated in quote token (≈ USD for USDC pairs)
  liquidityFraction: 0.2,
  minLiquidityUsd: 50_000,
  maxPriceRatio: 3,
  slippageBps: 50,
};

const enum LiquidityCutoffs {
  SHALLOW = 250_000,
  DEEP = 2_000_000,
}

const MIN_PRICE = 1e-9;

function liquidityClass(liquidityUsd: number): Mispricing["liquidityClass"] {
  if (liquidityUsd >= LiquidityCutoffs.DEEP) return "deep";
  if (liquidityUsd >= LiquidityCutoffs.SHALLOW) return "mid";
  return "shallow";
}

function toLoanMap(quotes: LoanQuote[]) {
  const map = new Map<string, LoanQuote>();
  quotes.forEach((loan) => map.set(loan.asset.toUpperCase(), loan));
  return map;
}

function hasLoanCapacity(
  map: Map<string, LoanQuote>,
  asset: string,
  size: number
) {
  const entry = map.get(asset.toUpperCase());
  if (!entry) return false;
  return entry.available >= size;
}

export function detectMispricings(
  quotes: Quote[],
  pairs: PairRequest[],
  loanQuotes: LoanQuote[] = [],
  cfg: Partial<DetectionConfig> = {}
): Mispricing[] {
  const config: DetectionConfig = { ...DEFAULT_CONFIG, ...cfg };
  const loanMap = toLoanMap(loanQuotes);
  const pairMap = new Map<string, PairRequest>();
  pairs.forEach((pair) => pairMap.set(`${pair.base}/${pair.quote}`, pair));

  const grouped = new Map<
    string,
    { pair: PairRequest; buyQuotes: Quote[]; sellQuotes: Quote[] }
  >();

  for (const quote of quotes) {
    const pairDef = pairMap.get(quote.pairId);
    if (!pairDef) continue;
    const record =
      grouped.get(quote.pairId) ??
      {
        pair: pairDef,
        buyQuotes: [],
        sellQuotes: [],
      };

    if (quote.tokenIn === pairDef.quote && quote.tokenOut === pairDef.base) {
      record.buyQuotes.push(quote);
    } else if (
      quote.tokenIn === pairDef.base &&
      quote.tokenOut === pairDef.quote
    ) {
      record.sellQuotes.push(quote);
    }

    grouped.set(quote.pairId, record);
  }

  const opportunities: Mispricing[] = [];

  grouped.forEach(({ pair, buyQuotes, sellQuotes }, pairId) => {
    if (!buyQuotes.length || !sellQuotes.length) return;

    const bestBuy = [...buyQuotes].sort((a, b) => b.price - a.price)[0];
    const bestSell = [...sellQuotes].sort((a, b) => b.price - a.price)[0];
    const minLiquidity = Math.min(bestBuy.liquidityUsd, bestSell.liquidityUsd);
    if (minLiquidity < config.minLiquidityUsd) {
      return;
    }

    const priceRatio =
      bestSell.price / Math.max(bestBuy.price, MIN_PRICE);
    if (
      (priceRatio > config.maxPriceRatio ||
        priceRatio < 1 / config.maxPriceRatio) &&
      minLiquidity < config.minLiquidityUsd * 5
    ) {
      return;
    }

    const maxTradeByLiquidity = minLiquidity * config.liquidityFraction;

    // Loop A: borrow quote token (e.g., USDC) -> buy base -> sell base
    const sizeQuote = Math.min(config.defaultTradeSize, maxTradeByLiquidity);
    const baseReceived = bestBuy.price * sizeQuote;
    const quoteRecovered = baseReceived * bestSell.price;
    const netQuote = quoteRecovered - sizeQuote;
    const netQuoteAfterGas = netQuote - (bestBuy.gasUsd + bestSell.gasUsd);
    const edgeBps =
      sizeQuote === 0 ? 0 : (netQuoteAfterGas / sizeQuote) * 10_000;

    if (
      sizeQuote > 0 &&
      netQuoteAfterGas > config.minProfitUsd &&
      hasLoanCapacity(loanMap, pair.quote, sizeQuote)
    ) {
      const loan = loanMap.get(pair.quote.toUpperCase());
      const opportunity: Mispricing = {
        pairId,
        borrowToken: pair.quote,
        buyVenue: bestBuy.venueId,
        sellVenue: bestSell.venueId,
        edgeBps,
        expectedProfitUsd: netQuoteAfterGas,
        recommendedSize: sizeQuote,
        liquidityClass: liquidityClass(minLiquidity),
        notes: `Borrow ${pair.quote} → buy ${pair.base} on ${bestBuy.venueId}, sell on ${bestSell.venueId}`,
      };

      const sim = simulateArb({
        opportunity,
        borrowSize: sizeQuote,
        slippageBps: config.slippageBps,
        loanAprBps: loan?.aprBps,
        loanDurationHours: loan?.maxDurationHours,
      });

      if (sim.passes && sim.netProfitUsd > config.minProfitUsd) {
        opportunity.expectedProfitUsd = sim.netProfitUsd;
        opportunity.edgeBps = sim.effectiveEdgeBps;
        opportunities.push(opportunity);
      }
    }

    // Loop B: borrow base token -> sell -> buy back cheaper
    const sizeBaseCapByLiquidity =
      bestSell.price <= 0
        ? 0
        : maxTradeByLiquidity / Math.max(bestSell.price, MIN_PRICE);
    const sizeBaseDefault =
      bestSell.price <= 0
        ? 0
        : config.defaultTradeSize / Math.max(bestSell.price, MIN_PRICE);
    const sizeBase = Math.min(sizeBaseCapByLiquidity, sizeBaseDefault);
    if (sizeBase > 0) {
      const quoteProceeds = sizeBase * bestSell.price;
      const baseRepurchased = quoteProceeds * bestBuy.price;
      const profitBase = baseRepurchased - sizeBase;
      const profitUsd =
        profitBase * bestSell.price - (bestBuy.gasUsd + bestSell.gasUsd);
      const principalUsd = sizeBase * bestSell.price;
      const edgeBpsBase =
        principalUsd === 0 ? 0 : (profitUsd / principalUsd) * 10_000;

      if (
        profitUsd > config.minProfitUsd &&
        hasLoanCapacity(loanMap, pair.base, sizeBase)
      ) {
        const loan = loanMap.get(pair.base.toUpperCase());
        const opportunity: Mispricing = {
          pairId,
          borrowToken: pair.base,
          buyVenue: bestBuy.venueId,
          sellVenue: bestSell.venueId,
          edgeBps: edgeBpsBase,
          expectedProfitUsd: profitUsd,
          recommendedSize: sizeBase,
          liquidityClass: liquidityClass(minLiquidity),
          notes: `Borrow ${pair.base} → sell on ${bestSell.venueId}, rebuy on ${bestBuy.venueId}`,
        };

        const sim = simulateArb({
          opportunity,
          borrowSize: sizeBase,
          slippageBps: config.slippageBps,
          loanAprBps: loan?.aprBps,
          loanDurationHours: loan?.maxDurationHours,
        });

        if (sim.passes && sim.netProfitUsd > config.minProfitUsd) {
          opportunity.expectedProfitUsd = sim.netProfitUsd;
          opportunity.edgeBps = sim.effectiveEdgeBps;
          opportunities.push(opportunity);
        }
      }
    }
  });

  // Order by best expected profit so AA can prioritize
  return opportunities.sort(
    (a, b) => b.expectedProfitUsd - a.expectedProfitUsd
  );
}

