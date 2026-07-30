-- Tenant isolation backstop.
--
-- Layer 1 (ergonomic): src/lib/db.ts injects tenantId into every query.
-- Layer 2 (this file): Postgres RLS refuses to return or write rows belonging to
--   another tenant even if layer 1 is bypassed by a bug or a raw query.
--
-- Two roles:
--   salesengine      — owner. Runs migrations and seeds. Has BYPASSRLS.
--   salesengine_app  — runtime role used by the app and worker. No bypass.
--
-- The app sets `app.current_tenant` per transaction via set_config(..., true).
-- When it is unset, current_setting() returns NULL and every policy evaluates
-- to NULL => no rows. Fail-closed by construction.

-- 1. Runtime role -----------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salesengine_app') THEN
    CREATE ROLE salesengine_app LOGIN PASSWORD 'salesengine_app';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO salesengine_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO salesengine_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO salesengine_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO salesengine_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO salesengine_app;

-- Owner must be able to bypass so migrations and seeds can span tenants.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salesengine') THEN
    EXECUTE 'ALTER ROLE salesengine BYPASSRLS';
  END IF;
END
$$;

-- 2. Policies on every table carrying a tenantId ----------------------------
-- Discovered from the catalog rather than hardcoded, so tables added in later
-- migrations are covered by re-running this block (see 3. below).
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'tenantId'
      AND a.attisdropped = false
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON public.%I
        USING ("tenantId" = current_setting('app.current_tenant', true))
        WITH CHECK ("tenantId" = current_setting('app.current_tenant', true))
    $f$, t);
  END LOOP;
END
$$;

-- The tenants table keys on its own primary key.
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.tenants;
CREATE POLICY tenant_isolation ON public.tenants
  USING (id = current_setting('app.current_tenant', true))
  WITH CHECK (id = current_setting('app.current_tenant', true));

-- 3. Helper so later migrations can re-apply coverage in one call ------------
CREATE OR REPLACE FUNCTION public.apply_tenant_rls() RETURNS void AS $fn$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'tenantId'
      AND a.attisdropped = false
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON public.%I
        USING ("tenantId" = current_setting('app.current_tenant', true))
        WITH CHECK ("tenantId" = current_setting('app.current_tenant', true))
    $f$, t);
  END LOOP;
END
$fn$ LANGUAGE plpgsql;
