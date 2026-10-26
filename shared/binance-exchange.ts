import type { ProjectMarket, VenueMarketSnapshot } from "./types.ts";
export interface BinanceExchangeResponse {
  projectId: string;
  generatedAt: number;
  authentication: "public-no-key";
  items: Array<{
    market: ProjectMarket;
    snapshot: VenueMarketSnapshot;
    volume24hQuote: number | null;
    quote: string;
  }>;
  failures: Array<{
    marketId: string;
    symbol: string;
    marketType: string;
    reason: string;
  }>;
  coverage: {
    spotSelected: number;
    perpetualSelected: number;
    successful: number;
    requested: number;
  };
}
