import {
  DetectionConfig,
  LoanQuote,
  Mispricing,
  PairRequest,
  Quote,
} from "../types";
import { simulateArb } from "../sim/arbitrage";
import { OnchainLiquidityMap } from "../liquidity/onchain";
import { getTokenDecimals } from "../onchain/erc20";
import {
  quoteTrade as defaultQuoteTrade,
  convertTokensToUsd as defaultConvertTokensToUsd,
} from "../execution";
import { capTradeSizeByDepth } from "../depth";

const DEFAULT_CONFIG: DetectionConfig = {
  minProfitUsd: 0,
  defaultTradeSize: 10_000,
  liquidityFraction: 0.2,
  minLiquidityUsd: 50_000,
  maxPriceRatio: 3,
  slippageBps: 50,
  minLoanDurationHours: 0.1,
};

const enum LiquidityCutoffs {
  SHALLOW = 250_000,
  DEEP = 2_000_000,
}

const MIN_PRICE = 1e-9;

export interface TokenMeta {
  address: string;
  decimals: number;
  priceUsd: number;
}

export interface ExecutionHooks {
  quoteTrade: typeof defaultQuoteTrade;
  convertTokensToUsd: typeof defaultConvertTokensToUsd;
}

const EXECUTION_DEFAULT: ExecutionHooks = {
  quoteTrade: defaultQuoteTrade,
  convertTokensToUsd: defaultConvertTokensToUsd,
};

const tokenDecimalCache = new Map<string, number>();
const tokenPriceCache = new Map<string, number>();

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

function selectLoan(
  map: Map<string, LoanQuote>,
  asset: string,
  size: number,
  minDurationHours: number
): LoanQuote | null {
  const entry = map.get(asset.toUpperCase());
  if (!entry) return null;
  if (entry.available < size) return null;
  if ((entry.maxDurationHours ?? 0) < minDurationHours) return null;
  return entry;
}

async function resolveTokenMeta(
  pair: PairRequest,
  kind: "base" | "quote",
  execution: ExecutionHooks
): Promise<TokenMeta | null> {
  const address =
    kind === "base" ? pair.baseAddress : pair.quoteAddress;
  if (!address) {
    return null;
  }
  const overrideDecimals =
    kind === "base" ? pair.baseDecimals : pair.quoteDecimals;
  const key = address.toLowerCase();
  let decimals =
    overrideDecimals ?? tokenDecimalCache.get(key);
  if (decimals === undefined) {
    const fetched = await getTokenDecimals(address);
    if (fetched === null) return null;
    decimals = fetched;
    tokenDecimalCache.set(key, decimals);
  }

  let priceUsd = tokenPriceCache.get(key);
  if (priceUsd === undefined) {
    const usdValue = await execution.convertTokensToUsd(
      address,
      decimals,
      1
    );
    if (usdValue === null || usdValue <= 0) {
      return null;
    }
    priceUsd = usdValue;
    tokenPriceCache.set(key, priceUsd);
  }

  return { address, decimals, priceUsd };
}

async function computeQuoteTradeSize(params: {
  pair: PairRequest;
  bestVenue: Quote;
  config: DetectionConfig;
  quoteMeta: TokenMeta;
  baseMeta: TokenMeta;
  minLiquidityUsd: number;
  onchain?: { baseAmount: number; quoteAmount: number };
}): Promise<number> {
  const { pair, bestVenue, config, quoteMeta, baseMeta, minLiquidityUsd, onchain } =
    params;
  const defaultTokens =
    quoteMeta.priceUsd > 0
      ? config.defaultTradeSize / quoteMeta.priceUsd
      : config.defaultTradeSize;

  const reserveCap = onchain?.quoteAmount;
  const depthSize = await capTradeSizeByDepth({
    pair,
    venueId: bestVenue.venueId,
    direction: "quoteToBase",
    tokenIn: quoteMeta,
    tokenOut: baseMeta,
    targetTokens: defaultTokens,
    slippageBps: config.slippageBps,
    reserveCapTokens: reserveCap,
  });
  if (depthSize) {
    return depthSize;
  }

  if (onchain) {
    const quoteCap = onchain.quoteAmount * config.liquidityFraction;
    const baseCapToQuote =
      onchain.baseAmount *
      config.liquidityFraction *
      Math.max(bestVenue.price, MIN_PRICE);
    return Math.max(
      0,
      Math.min(defaultTokens, quoteCap, baseCapToQuote)
    );
  }

  if (minLiquidityUsd > 0 && quoteMeta.priceUsd > 0) {
    const usdCap = minLiquidityUsd * config.liquidityFraction;
    const tokenCap = usdCap / quoteMeta.priceUsd;
    return Math.max(0, Math.min(defaultTokens, tokenCap));
  }

  return Math.max(0, defaultTokens);
}

async function computeBaseTradeSize(params: {
  pair: PairRequest;
  bestVenue: Quote;
  config: DetectionConfig;
  baseMeta: TokenMeta;
  quoteMeta: TokenMeta;
  minLiquidityUsd: number;
  onchain?: { baseAmount: number; quoteAmount: number };
}): Promise<number> {
  const { pair, bestVenue, config, baseMeta, quoteMeta, minLiquidityUsd, onchain } =
    params;
  const defaultTokens =
    baseMeta.priceUsd > 0
      ? config.defaultTradeSize / baseMeta.priceUsd
      : config.defaultTradeSize;

  const reserveCap = onchain?.baseAmount;
  const depthSize = await capTradeSizeByDepth({
    pair,
    venueId: bestVenue.venueId,
    direction: "baseToQuote",
    tokenIn: baseMeta,
    tokenOut: quoteMeta,
    targetTokens: defaultTokens,
    slippageBps: config.slippageBps,
    reserveCapTokens: reserveCap,
  });
  if (depthSize) {
    return depthSize;
  }

  if (onchain) {
    const baseCap = onchain.baseAmount * config.liquidityFraction;
    const quoteCapToBase =
      onchain.quoteAmount *
      config.liquidityFraction /
      Math.max(bestVenue.price, MIN_PRICE);
    return Math.max(0, Math.min(defaultTokens, baseCap, quoteCapToBase));
  }

  if (minLiquidityUsd > 0 && baseMeta.priceUsd > 0) {
    const usdCap = minLiquidityUsd * config.liquidityFraction;
    const tokenCap = usdCap / baseMeta.priceUsd;
    return Math.max(0, Math.min(defaultTokens, tokenCap));
  }

  return Math.max(0, defaultTokens);
}

export async function detectMispricings(
  quotes: Quote[],
  pairs: PairRequest[],
  loanQuotes: LoanQuote[] = [],
  cfg: Partial<DetectionConfig> = {},
  onchainLiquidity?: OnchainLiquidityMap,
  execution: ExecutionHooks = EXECUTION_DEFAULT
): Promise<Mispricing[]> {
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

  for (const [pairId, { pair, buyQuotes, sellQuotes }] of grouped.entries()) {
    if (!buyQuotes.length || !sellQuotes.length) continue;

    const bestBuy = [...buyQuotes].sort((a, b) => b.price - a.price)[0];
    const bestSell = [...sellQuotes].sort((a, b) => b.price - a.price)[0];
    let minLiquidity = Math.min(bestBuy.liquidityUsd, bestSell.liquidityUsd);

    const onchain =
      onchainLiquidity?.[pairId] ??
      onchainLiquidity?.[`${pair.quote}/${pair.base}`];
    if (onchain) {
      const baseToQuote = onchain.baseAmount * bestSell.price;
      const quoteAmount = onchain.quoteAmount;
      const overrideLiquidity = Math.min(baseToQuote, quoteAmount);
      if (overrideLiquidity > 0) {
        minLiquidity = overrideLiquidity;
      }
    }

    if (minLiquidity < config.minLiquidityUsd) {
      continue;
    }

    const priceRatio =
      bestSell.price / Math.max(bestBuy.price, MIN_PRICE);
    if (
      (priceRatio > config.maxPriceRatio ||
        priceRatio < 1 / config.maxPriceRatio) &&
      minLiquidity < config.minLiquidityUsd * 5
    ) {
      continue;
    }

    const baseMeta = await resolveTokenMeta(pair, "base", execution);
    const quoteMeta = await resolveTokenMeta(pair, "quote", execution);
    if (!baseMeta || !quoteMeta) {
      continue;
    }

    const quoteOpportunity = await evaluateQuoteDirection({
      pairId,
      pair,
      bestBuy,
      bestSell,
      quoteMeta,
      baseMeta,
      minLiquidityUsd: minLiquidity,
      onchain,
      config,
      loanMap,
      execution,
    });
    if (quoteOpportunity) {
      opportunities.push(quoteOpportunity);
    }

    const baseOpportunity = await evaluateBaseDirection({
      pairId,
      pair,
      bestBuy,
      bestSell,
      quoteMeta,
      baseMeta,
      minLiquidityUsd: minLiquidity,
      onchain,
      config,
      loanMap,
      execution,
    });
    if (baseOpportunity) {
      opportunities.push(baseOpportunity);
    }
  }

  return opportunities.sort(
    (a, b) => b.expectedProfitUsd - a.expectedProfitUsd
  );
}

interface DirectionParams {
  pairId: string;
  pair: PairRequest;
  bestBuy: Quote;
  bestSell: Quote;
  quoteMeta: TokenMeta;
  baseMeta: TokenMeta;
  minLiquidityUsd: number;
  onchain?: { baseAmount: number; quoteAmount: number };
  config: DetectionConfig;
  loanMap: Map<string, LoanQuote>;
  execution: ExecutionHooks;
}

async function evaluateQuoteDirection(
  params: DirectionParams
): Promise<Mispricing | null> {
  const {
    pairId,
    pair,
    bestBuy,
    bestSell,
    quoteMeta,
    baseMeta,
    minLiquidityUsd,
    onchain,
    config,
    loanMap,
    execution,
  } = params;

  const sizeQuote = await computeQuoteTradeSize({
    pair,
    bestVenue: bestBuy,
    config,
    quoteMeta,
    baseMeta,
    minLiquidityUsd,
    onchain,
  });
  if (sizeQuote <= 0) return null;

  const quoteLoan = selectLoan(
    loanMap,
    pair.quote,
    sizeQuote,
    config.minLoanDurationHours
  );
  if (!quoteLoan) return null;

  const buyQuote = await execution.quoteTrade({
    pairId,
    sellToken: quoteMeta.address,
    buyToken: baseMeta.address,
    sellTokenDecimals: quoteMeta.decimals,
    buyTokenDecimals: baseMeta.decimals,
    sellAmountTokens: sizeQuote,
  });
  if (!buyQuote) return null;

  const sellQuote = await execution.quoteTrade({
    pairId,
    sellToken: baseMeta.address,
    buyToken: quoteMeta.address,
    sellTokenDecimals: baseMeta.decimals,
    buyTokenDecimals: quoteMeta.decimals,
    sellAmountTokens: buyQuote.amountOutTokens,
  });
  if (!sellQuote) return null;

  const totalGasUsd = buyQuote.gasUsd + sellQuote.gasUsd;
  const sizeQuoteUsd = sizeQuote * quoteMeta.priceUsd;
  const quoteRecoveredUsd = sellQuote.amountOutTokens * quoteMeta.priceUsd;
  const netProfitUsd = quoteRecoveredUsd - sizeQuoteUsd - totalGasUsd;
  if (netProfitUsd <= config.minProfitUsd) {
    return null;
  }

  const edgeBps =
    sizeQuoteUsd === 0 ? 0 : (netProfitUsd / sizeQuoteUsd) * 10_000;

  const opportunity: Mispricing = {
    pairId,
    borrowToken: pair.quote,
    buyVenue: bestBuy.venueId,
    sellVenue: bestSell.venueId,
    edgeBps,
    expectedProfitUsd: netProfitUsd,
    recommendedSize: sizeQuote,
    liquidityClass: liquidityClass(minLiquidityUsd),
    notes: `Borrow ${pair.quote} → buy ${pair.base} on ${bestBuy.venueId}, sell on ${bestSell.venueId}`,
  };

  const flashFeeUsd = quoteLoan.flashFeeBps
    ? (sizeQuoteUsd * quoteLoan.flashFeeBps) / 10_000
    : 0;

  const sim = simulateArb({
    opportunity,
    borrowSize: sizeQuote,
    borrowTokenPriceUsd: quoteMeta.priceUsd,
    slippageBps: config.slippageBps,
    loanAprBps: quoteLoan.aprBps,
    loanDurationHours: config.minLoanDurationHours,
    extraFeesUsd: flashFeeUsd,
  });

  if (sim.passes && sim.netProfitUsd > config.minProfitUsd) {
    opportunity.expectedProfitUsd = sim.netProfitUsd;
    opportunity.edgeBps = sim.effectiveEdgeBps;
    opportunity.recommendedSize = sim.borrowSize;
    return opportunity;
  }

  return null;
}

async function evaluateBaseDirection(
  params: DirectionParams
): Promise<Mispricing | null> {
  const {
    pairId,
    pair,
    bestBuy,
    bestSell,
    quoteMeta,
    baseMeta,
    minLiquidityUsd,
    onchain,
    config,
    loanMap,
    execution,
  } = params;

  const sizeBase = await computeBaseTradeSize({
    pair,
    bestVenue: bestSell,
    config,
    baseMeta,
    quoteMeta,
    minLiquidityUsd,
    onchain,
  });
  if (sizeBase <= 0) return null;

  const baseLoan = selectLoan(
    loanMap,
    pair.base,
    sizeBase,
    config.minLoanDurationHours
  );
  if (!baseLoan) return null;

  const sellQuote = await execution.quoteTrade({
    pairId,
    sellToken: baseMeta.address,
    buyToken: quoteMeta.address,
    sellTokenDecimals: baseMeta.decimals,
    buyTokenDecimals: quoteMeta.decimals,
    sellAmountTokens: sizeBase,
  });
  if (!sellQuote) return null;

  const buyBackQuote = await execution.quoteTrade({
    pairId,
    sellToken: quoteMeta.address,
    buyToken: baseMeta.address,
    sellTokenDecimals: quoteMeta.decimals,
    buyTokenDecimals: baseMeta.decimals,
    sellAmountTokens: sellQuote.amountOutTokens,
  });
  if (!buyBackQuote) return null;

  const totalGasUsd = sellQuote.gasUsd + buyBackQuote.gasUsd;
  const sizeBaseUsd = sizeBase * baseMeta.priceUsd;
  const baseRecoveredUsd =
    buyBackQuote.amountOutTokens * baseMeta.priceUsd;
  const netProfitUsd = baseRecoveredUsd - sizeBaseUsd - totalGasUsd;
  if (netProfitUsd <= config.minProfitUsd) {
    return null;
  }

  const edgeBps =
    sizeBaseUsd === 0 ? 0 : (netProfitUsd / sizeBaseUsd) * 10_000;

  const opportunity: Mispricing = {
    pairId,
    borrowToken: pair.base,
    buyVenue: bestBuy.venueId,
    sellVenue: bestSell.venueId,
    edgeBps,
    expectedProfitUsd: netProfitUsd,
    recommendedSize: sizeBase,
    liquidityClass: liquidityClass(minLiquidityUsd),
    notes: `Borrow ${pair.base} → sell on ${bestSell.venueId}, rebuy on ${bestBuy.venueId}`,
  };

  const flashFeeUsd = baseLoan.flashFeeBps
    ? (sizeBaseUsd * baseLoan.flashFeeBps) / 10_000
    : 0;

  const sim = simulateArb({
    opportunity,
    borrowSize: sizeBase,
    borrowTokenPriceUsd: baseMeta.priceUsd,
    slippageBps: config.slippageBps,
    loanAprBps: baseLoan.aprBps,
    loanDurationHours: config.minLoanDurationHours,
    extraFeesUsd: flashFeeUsd,
  });

  if (sim.passes && sim.netProfitUsd > config.minProfitUsd) {
    opportunity.expectedProfitUsd = sim.netProfitUsd;
    opportunity.edgeBps = sim.effectiveEdgeBps;
    opportunity.recommendedSize = sim.borrowSize;
    return opportunity;
  }

  return null;
}

