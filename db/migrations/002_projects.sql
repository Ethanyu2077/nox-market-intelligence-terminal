CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  token_symbol text NOT NULL,
  contract_address text,
  identity_source text NOT NULL CHECK (identity_source IN ('symbol', 'contract')),
  identity_network text,
  archived boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL,
  default_interval text NOT NULL DEFAULT '5m',
  streaming_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_markets (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  instrument_id text NOT NULL,
  exchange text NOT NULL,
  market_type text NOT NULL CHECK (market_type IN ('spot', 'perpetual')),
  native_symbol text NOT NULL,
  base_asset text NOT NULL,
  quote_asset text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, instrument_id)
);

CREATE UNIQUE INDEX one_primary_market_per_project
  ON project_markets (project_id)
  WHERE is_primary;

CREATE INDEX active_projects_order
  ON projects (archived, display_order);
