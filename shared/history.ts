export interface HistoryEvent {
  id: string;
  kind: "trade" | "liquidation" | "snapshot" | "regime" | "volume" | "alignment" | "l2";
  marketKey: string;
  projectId: string | null;
  eventTime: number;
  ingestTime: number;
  source: string;
  quality: string;
  payload: unknown;
}
