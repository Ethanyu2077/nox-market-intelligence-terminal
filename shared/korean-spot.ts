import type {ProjectMarket,Quality} from './types.ts';
export type KoreanVenue='upbit'|'bithumb';
export interface KoreanSpotSnapshot {
  market:ProjectMarket;
  quote:'KRW';
  priceKrw:number|null;
  changeFromPreviousClosePct:number|null;
  volume24hBase:number|null;
  turnover24hKrw:number|null;
  bidKrw:number|null;
  askKrw:number|null;
  spreadBps:number|null;
  sourceTime:number|null;
  rawSourceTime:number|null;
  timestampIssue:'future-source-time'|'missing-source-time'|null;
  lastTradeTime:number|null;
  bookTime:number|null;
  fetchedAt:number;
  quality:Quality;
  bookState:'available'|'unavailable';
  source:string;
}
export interface KoreanSpotResponse {
  projectId:string;
  quote:'KRW';
  items:KoreanSpotSnapshot[];
  failures:{marketId:string;exchange:KoreanVenue;symbol:string;reason:string}[];
  requested:number;
  fetchedAt:number;
}

