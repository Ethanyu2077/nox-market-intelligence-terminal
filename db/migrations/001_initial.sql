CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE venues (
  id text PRIMARY KEY,
  name text NOT NULL,
  market_type text NOT NULL,
  source_url text NOT NULL
);

CREATE TABLE instruments (
  id text PRIMARY KEY,
  venue_id text NOT NULL REFERENCES venues(id),
  native_symbol text NOT NULL,
  base_asset text NOT NULL,
  quote_asset text NOT NULL,
  settlement_asset text NOT NULL,
  contract_type text NOT NULL,
  multiplier numeric NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE (venue_id, native_symbol)
);

CREATE TABLE market_trades (
  instrument_id text NOT NULL REFERENCES instruments(id),
  venue text NOT NULL,
  event_time timestamptz NOT NULL,
  ingest_time timestamptz NOT NULL DEFAULT now(),
  venue_trade_id text NOT NULL,
  price numeric NOT NULL,
  base_quantity numeric NOT NULL,
  quote_notional numeric NOT NULL,
  aggressor_side text NOT NULL CHECK (aggressor_side IN ('buy', 'sell')),
  source text NOT NULL,
  quality_flags jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (instrument_id, venue_trade_id, event_time)
);
SELECT create_hypertable('market_trades', by_range('event_time'), if_not_exists => TRUE);

CREATE TABLE candle_bars (
  instrument_id text NOT NULL REFERENCES instruments(id),
  venue text NOT NULL,
  interval text NOT NULL,
  event_time timestamptz NOT NULL,
  ingest_time timestamptz NOT NULL DEFAULT now(),
  open numeric NOT NULL, high numeric NOT NULL, low numeric NOT NULL, close numeric NOT NULL,
  base_volume numeric NOT NULL, quote_volume numeric NOT NULL,
  source text NOT NULL, quality_flags jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (instrument_id, interval, event_time)
);
SELECT create_hypertable('candle_bars', by_range('event_time'), if_not_exists => TRUE);

CREATE TABLE oi_snapshots (
  instrument_id text NOT NULL REFERENCES instruments(id), venue text NOT NULL,
  event_time timestamptz NOT NULL, ingest_time timestamptz NOT NULL DEFAULT now(),
  contracts numeric, base_quantity numeric NOT NULL, usd_notional numeric NOT NULL,
  mark_price numeric NOT NULL, source text NOT NULL, quality_flags jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (instrument_id, event_time)
);
SELECT create_hypertable('oi_snapshots', by_range('event_time'), if_not_exists => TRUE);

CREATE TABLE cvd_bars (
  instrument_id text NOT NULL REFERENCES instruments(id), venue text NOT NULL, interval text NOT NULL,
  event_time timestamptz NOT NULL, ingest_time timestamptz NOT NULL DEFAULT now(),
  buy_notional numeric NOT NULL, sell_notional numeric NOT NULL, delta_notional numeric NOT NULL,
  source text NOT NULL, quality_flags jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (instrument_id, interval, event_time)
);
SELECT create_hypertable('cvd_bars', by_range('event_time'), if_not_exists => TRUE);

CREATE TABLE funding_events (
  instrument_id text NOT NULL REFERENCES instruments(id), venue text NOT NULL,
  event_time timestamptz NOT NULL, ingest_time timestamptz NOT NULL DEFAULT now(),
  funding_rate numeric NOT NULL, settlement_interval_minutes integer,
  source text NOT NULL, quality_flags jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (instrument_id, event_time)
);

CREATE TABLE alert_rules (
  id uuid PRIMARY KEY, symbol text NOT NULL, metric text NOT NULL, operator text NOT NULL,
  threshold numeric NOT NULL, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE watchlist_items (
  watchlist_id uuid NOT NULL, instrument_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (watchlist_id, instrument_id)
);
CREATE INDEX market_trades_instrument_time ON market_trades (instrument_id, event_time DESC);
CREATE INDEX oi_snapshots_instrument_time ON oi_snapshots (instrument_id, event_time DESC);
