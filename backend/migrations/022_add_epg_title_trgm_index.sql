-- Migration: 022_add_epg_title_trgm_index
-- Description: Trigram GIN index on epg_programs.title for the
--              EPG-first matcher. Without it, a fuzzy LIKE/regex
--              search across 3.3M programs is a sequential scan.
--              With pg_trgm + GIN we get sub-100ms lookups.
-- Date: 2026-04-25
--
-- pg_trgm extension is already installed (verified). This migration
-- only adds the index.

CREATE INDEX IF NOT EXISTS idx_epg_programs_title_trgm
  ON epg_programs USING gin (title gin_trgm_ops);
