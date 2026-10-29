/**
 * Provider-neutral execution ledger contract.
 *
 * Golden fixtures define a cross-language calculation contract. The production position-flow
 * research path consumes this ledger; legacy offline scripts remain separately labeled.
 */
export type LedgerSide = 'long' | 'short';

export interface LedgerInput {
  side: LedgerSide;
  /** Contract count when multiplier != 1; otherwise base units. Effective base = quantity * multiplier. */
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  contractMultiplier?: number;
  leverage?: number;
  feeBpsPerSide?: number;
  /** Adverse slippage applied to each fill (not to the reported raw price return). */
  slippageBpsPerSide?: number;
  /** Funding cash in quote currency (positive = received); computed with fundingCash(). */
  fundingCash?: number;
}

export interface LedgerResult {
  entryNotional: number;
  exitNotional: number;
  /** Raw price move, independent of position side. */
  priceReturnPct: number;
  /** Price move converted to the claim's direction (long = price, short = -price). */
  directionalGrossPct: number;
  grossPnlQuote: number;
  feesQuote: number;
  slippageQuote: number;
  fundingCash: number;
  /** Gross P&L using slippage-adjusted fills, minus fees, plus funding cash. */
  netPnlQuote: number;
  /** Net P&L divided by the raw entry notional. */
  notionalReturnPct: number;
  marginQuote: number;
  /** Net P&L divided by posted margin (entryNotional / leverage). */
  marginRoiPct: number;
  entryFillPrice: number;
  exitFillPrice: number;
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number`);
  return value;
}

export function computeLedger(input: LedgerInput): LedgerResult {
  if (input.side !== 'long' && input.side !== 'short') throw new Error('side must be long or short');
  const multiplier = positive(input.contractMultiplier ?? 1, 'contractMultiplier');
  const quantity = positive(input.quantity, 'quantity');
  const entryPrice = positive(input.entryPrice, 'entryPrice');
  const exitPrice = positive(input.exitPrice, 'exitPrice');
  const leverage = positive(input.leverage ?? 1, 'leverage');
  const feeBps = input.feeBpsPerSide ?? 0;
  const slippageBps = input.slippageBpsPerSide ?? 0;
  if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps >= 10_000) throw new Error('fee bps must be finite in [0, 10000)');
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) throw new Error('slippage bps must be finite in [0, 10000)');
  if (!Number.isFinite(input.fundingCash ?? 0)) throw new Error('fundingCash must be finite');
  const slippage = slippageBps / 10_000;
  const entryFillPrice = input.side === 'long' ? entryPrice * (1 + slippage) : entryPrice * (1 - slippage);
  const exitFillPrice = input.side === 'long' ? exitPrice * (1 - slippage) : exitPrice * (1 + slippage);
  const entryNotional = quantity * multiplier * entryPrice;
  const exitNotional = quantity * multiplier * exitPrice;
  const entryFillNotional = quantity * multiplier * entryFillPrice;
  const exitFillNotional = quantity * multiplier * exitFillPrice;
  const priceReturnPct = (exitPrice / entryPrice - 1) * 100;
  // Fixed-base-quantity linear P&L: short 100->50 is +50%, never +100%.
  const grossPnlQuote = input.side === 'long' ? exitFillNotional - entryFillNotional : entryFillNotional - exitFillNotional;
  const feesQuote = (entryFillNotional + exitFillNotional) * feeBps / 10_000;
  const slippageQuote = quantity * multiplier * (Math.abs(entryFillPrice - entryPrice) + Math.abs(exitFillPrice - exitPrice));
  const fundingCash = input.fundingCash ?? 0;
  const netPnlQuote = grossPnlQuote - feesQuote + fundingCash;
  const marginQuote = entryNotional / leverage;
  if (![entryNotional, exitNotional, entryFillPrice, exitFillPrice, grossPnlQuote, feesQuote, netPnlQuote, marginQuote, netPnlQuote / entryNotional * 100, netPnlQuote / marginQuote * 100].every(Number.isFinite) || marginQuote <= 0) throw new Error('ledger arithmetic overflow');
  return {
    entryNotional,
    exitNotional,
    priceReturnPct,
    directionalGrossPct: input.side === 'long' ? priceReturnPct : -priceReturnPct,
    grossPnlQuote,
    feesQuote,
    slippageQuote,
    fundingCash,
    netPnlQuote,
    notionalReturnPct: netPnlQuote / entryNotional * 100,
    marginQuote,
    marginRoiPct: marginQuote > 0 ? netPnlQuote / marginQuote * 100 : 0,
    entryFillPrice,
    exitFillPrice,
  };
}

/** Funding cash: positive rate → longs pay shorts; negative rate → shorts pay longs. */
export function fundingCash(input: { side: LedgerSide; quantity: number; markPrice: number; rate: number; contractMultiplier?: number }): number {
  if (input.side !== 'long' && input.side !== 'short') throw new Error('side must be long or short');
  const multiplier = positive(input.contractMultiplier ?? 1, 'contractMultiplier');
  const quantity = positive(input.quantity, 'quantity');
  const markPrice = positive(input.markPrice, 'markPrice');
  if (!Number.isFinite(input.rate)) throw new Error('funding rate must be finite');
  const notional = quantity * multiplier * markPrice;
  const cash = (input.side === 'long' ? -1 : 1) * notional * input.rate;
  if (!Number.isFinite(cash)) throw new Error('funding arithmetic overflow');
  return cash;
}

export interface EquityPoint { trade: number; equity: number; peak: number; drawdownPct: number }

export function equityCurve(trades: Array<{ netPnlQuote: number }>, initialCapital: number): {
  points: EquityPoint[]; finalEquity: number; totalReturnPct: number; maxDrawdownPct: number; wins: number; losses: number; winRatePct: number | null;
} {
  positive(initialCapital, 'initialCapital');
  if (trades.some(trade => !Number.isFinite(trade.netPnlQuote))) throw new Error('netPnlQuote must be finite');
  let equity = initialCapital, peak = initialCapital, maxDrawdownPct = 0, wins = 0, losses = 0;
  const points: EquityPoint[] = [];
  trades.forEach((trade, index) => {
    equity += trade.netPnlQuote;
    if (trade.netPnlQuote > 0) wins += 1;
    if (trade.netPnlQuote < 0) losses += 1;
    peak = Math.max(peak, equity);
    const drawdownPct = peak > 0 ? (peak - equity) / peak * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
    points.push({ trade: index + 1, equity, peak, drawdownPct });
  });
  return {
    points,
    finalEquity: equity,
    totalReturnPct: initialCapital > 0 ? (equity / initialCapital - 1) * 100 : 0,
    maxDrawdownPct,
    wins,
    losses,
    // Zero trades must not display a 0% win rate.
    winRatePct: trades.length > 0 ? wins / trades.length * 100 : null,
  };
}

/** Static overlap budget only. NOT a dynamic account simulator: no realized PnL, funding or cash updates. */
export function allocateByCapital(trades: Array<{ entryNotional: number; entryTime: number; exitTime: number }>, capital: number, maxLeverage = 1): { accepted: number[]; rejected: number[] } {
  positive(capital, 'capital');
  positive(maxLeverage, 'maxLeverage');
  for (const trade of trades) {
    positive(trade.entryNotional, 'entryNotional');
    if (!Number.isFinite(trade.entryTime) || !Number.isFinite(trade.exitTime) || trade.exitTime <= trade.entryTime) throw new Error('trade times must be finite and exitTime > entryTime');
  }
  const accepted: number[] = [], rejected: number[] = [];
  const active: Array<{ index: number; until: number; margin: number }> = [];
  const ordered = trades.map((trade, index) => ({ ...trade, index })).sort((a, b) => a.entryTime - b.entryTime);
  for (const trade of ordered) {
    for (let i = active.length - 1; i >= 0; i--) if (active[i].until <= trade.entryTime) active.splice(i, 1);
    const used = active.reduce((sum, item) => sum + item.margin, 0);
    const margin = trade.entryNotional / maxLeverage;
    if (!Number.isFinite(margin) || margin <= 0) throw new Error('margin must be positive and finite');
    if (used + margin > capital + 1e-9) { rejected.push(trade.index); continue; }
    active.push({ index: trade.index, until: trade.exitTime, margin });
    accepted.push(trade.index);
  }
  return { accepted, rejected };
}
