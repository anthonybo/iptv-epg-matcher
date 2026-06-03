-- Migration: 046_add_breaking_events
-- Description: Persist synthesized/web-grounded breaking events so the
--              Breaking tab can PRELOAD the last-known still-active events
--              instantly (instead of an empty/loading screen) while a fresh
--              pull runs in the background. Survives restarts; decouples the
--              user-facing load from the slow/flaky web-search + LLM step.
-- Date: 2026-06-02
--
-- Events are user-INDEPENDENT (general breaking news). Channel matching to a
-- user's IPTV catalog stays per-user and is NOT stored here.
--
-- event_key  : normalized title — UPSERT key so the same story seen across
--              refreshes updates in place (refreshes last_seen / expires_at)
-- expires_at : when the event stops being "active" (last_seen + active window).
--              loadPersistedActive() filters on this; a pruner deletes past it.

CREATE TABLE IF NOT EXISTS breaking_events (
  event_key      TEXT          PRIMARY KEY,
  title          TEXT          NOT NULL,
  type           TEXT,
  location       TEXT,
  summary        TEXT,
  channel_hints  JSONB         NOT NULL DEFAULT '[]'::jsonb,
  confidence     TEXT,
  grounded       BOOLEAN       NOT NULL DEFAULT FALSE,
  sources        JSONB         NOT NULL DEFAULT '[]'::jsonb,
  first_seen     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at     TIMESTAMP     NOT NULL
);

-- "active events, freshest first" — the preload query.
CREATE INDEX IF NOT EXISTS idx_breaking_events_active
  ON breaking_events(expires_at DESC, last_seen DESC);
