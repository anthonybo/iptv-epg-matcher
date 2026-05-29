-- Resync every SERIAL/BIGSERIAL sequence to its owning column's max.
--
-- The original sqlite→Postgres migration COPY'd rows WITH their
-- explicit ids but never advanced the backing sequences. So
-- nextval() still returned low values (e.g. users_id_seq at 2 while
-- MAX(users.id) = 3), and the next INSERT collided on the primary
-- key with "duplicate key value violates unique constraint
-- *_pkey". This silently broke every insert that relies on a
-- default id — most visibly new user registration.
--
-- This walks pg_depend to find each sequence's owning table+column
-- and setval()s it to MAX(col). Idempotent and data-safe: setval
-- only moves the counter forward to avoid future collisions; it
-- never touches row data. Safe to re-run any time.

DO $$
DECLARE
  r RECORD;
  max_id BIGINT;
BEGIN
  FOR r IN
    SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col
    FROM pg_class s
    JOIN pg_depend d    ON d.objid = s.oid AND d.deptype = 'a'
    JOIN pg_class t     ON t.oid = d.refobjid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
    WHERE s.relkind = 'S'
  LOOP
    EXECUTE format('SELECT COALESCE(MAX(%I), 0) FROM %I', r.col, r.tbl) INTO max_id;
    IF max_id > 0 THEN
      -- is_called = true → next nextval() returns max_id + 1
      EXECUTE format('SELECT setval(%L, %s, true)', r.seq, max_id);
    ELSE
      -- empty table → next nextval() returns 1
      EXECUTE format('SELECT setval(%L, 1, false)', r.seq);
    END IF;
    RAISE NOTICE 'resynced % → %.% (max=%)', r.seq, r.tbl, r.col, max_id;
  END LOOP;
END $$;
