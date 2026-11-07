/**
 * Minimal structural types for the parts of CCXT this adapter uses.
 *
 * Keeping our own interfaces (instead of importing CCXT's huge typings) lets the adapter
 * be unit-tested with a fake exchange and keeps `ccxt` a lazily imported, optional
 * dependency of the API process.
 */

export interface CcxtMarket {
  id: string;
  symbol: string;
  type?: string;
  spot?: boolean;
  swap?: boolean;
  future?: boolean;
  option?: boolean;
  base?: string;
  quote?: string;
  settle?: string | null;
  active?: boolean | null;
  contractSize?: number | null;
  linear?: boolean;
  inverse?: boolean;
}

export interface CcxtTicker {
  symbol?: string;
  timestamp?: number | null;
  last?: number | null;
  close?: number | null;
  markPrice?: number | null;
  percentage?: number | null;
  baseVolume?: number | null;
  quoteVolume?: number | null;
  bid?: number | null;
  ask?: number | null;
}

export interface CcxtOpenInterest {
  openInterestAmount?: number | null;
  openInterestValue?: number | null;
  timestamp?: number | null;
}

export interface CcxtFunding {
  fundingRate?: number | null;
  fundingTimestamp?: number | null;
  nextFundingTimestamp?: number | null;
}

export interface CcxtExchangeLike {
  id: string;
  version?: string;
  markets?: Record<string, CcxtMarket> | null;
  markets_by_id?: Record<string, CcxtMarket[]> | null;
  loadMarkets(reload?: boolean): Promise<Record<string, CcxtMarket>>;
  fetchTicker(symbol: string): Promise<CcxtTicker>;
  fetchOpenInterest?(symbol: string): Promise<CcxtOpenInterest | null>;
  fetchFundingRate?(symbol: string): Promise<CcxtFunding | null>;
}

export interface CcxtExchangeHealth {
  id: string;
  enabled: boolean;
  loaded: boolean;
  markets: number;
  perpetuals: number;
  latencyMs: number | null;
  error: string | null;
  checkedAt: number | null;
}
