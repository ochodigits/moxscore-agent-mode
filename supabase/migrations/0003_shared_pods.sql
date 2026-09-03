-- Shared pod checks: 2-4 decklists compared on one page, shareable by pod_id.
-- Same access model as shared_decks: RLS on, NO public policies — all access
-- goes through the service-role key in api/pod.ts (share-link obscurity).

CREATE TABLE public.shared_pods (
  pod_id TEXT PRIMARY KEY,
  -- Array of { "decklist": string, "label": string | null }
  decks JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT shared_pods_decks_shape CHECK (
    jsonb_typeof(decks) = 'array'
    AND jsonb_array_length(decks) BETWEEN 2 AND 4
  ),
  -- 4 decks x 20KB decklist cap, with headroom for labels/JSON syntax.
  CONSTRAINT shared_pods_decks_size CHECK (pg_column_size(decks) <= 90000)
);

ALTER TABLE public.shared_pods ENABLE ROW LEVEL SECURITY;
