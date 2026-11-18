-- ============================================================
-- Host-Attrappe für die Rechte-Prüfung (nur für Tests)
--
-- Das Modul erwartet von der Gastgeber-App `profiles`, `companies`,
-- die View `mitarbeiter_verzeichnis`, die Rollen von Supabase und
-- `auth.uid()`. Diese Datei stellt davon genau so viel bereit, wie
-- `sql/modul/01` bis `14` brauchen — gegen eine leere Postgres-
-- Datenbank im Container, nie gegen eine echte Umgebung.
--
-- Was hier NICHT drin ist, ist Absicht: kein GoTrue, kein MFA, keine
-- Rechte-Spalten ausser denen des Moduls. Wer eine Regel prüfen
-- will, die an `mfa_vorgezeigt()` oder an Portal-Policies hängt,
-- prüft sie nicht hier.
-- ============================================================

-- ── Rollen wie in Supabase ──────────────────────────────────
-- `authenticated` ist nicht Eigentümer der Tabellen, die RLS greift
-- also. `service_role` umgeht sie (BYPASSRLS) — genauso wie in
-- Supabase, weshalb der MCP-Zugang seine Rechte im Code prüfen muss.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;

GRANT USAGE ON SCHEMA public, extensions, auth, storage TO anon, authenticated, service_role;

-- Supabase vergibt Tabellenrechte an diese Rollen; die Produktion
-- hat `anon` davon ausgenommen (Rechte-Reset der Baseline). Dieselbe
-- Ausgangslage hier: `authenticated` darf alles, was die RLS zulässt.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO authenticated, service_role;

-- ── auth.uid() ──────────────────────────────────────────────
-- Wie in Supabase: die Profil-ID steht in den JWT-Claims der
-- Sitzung. Ohne Claims (Service Role, SQL-Editor) ist sie NULL —
-- deshalb das NULLIF VOR dem Cast, sonst scheitert die leere
-- Einstellung am JSON-Parser.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
$$;

-- ── companies / profiles ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.companies (
  id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.profiles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT UNIQUE NOT NULL,
  full_name           TEXT NOT NULL,
  company_id          UUID REFERENCES public.companies(id) ON DELETE SET NULL,
  role                TEXT NOT NULL DEFAULT 'mitarbeiter',
  is_blocked          BOOLEAN NOT NULL DEFAULT false,
  can_use_projects    BOOLEAN NOT NULL DEFAULT false,
  can_manage_projects BOOLEAN NOT NULL DEFAULT false
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_self" ON public.profiles;
CREATE POLICY "profiles_select_self" ON public.profiles
  FOR SELECT USING (id = auth.uid());

CREATE OR REPLACE VIEW public.mitarbeiter_verzeichnis AS
  SELECT id, full_name, email, company_id, is_blocked,
         (can_use_projects OR can_manage_projects OR role = 'admin') AS darf_projekte_nutzen
  FROM public.profiles;

-- ── Storage-Attrappe ────────────────────────────────────────
-- Nur so viel, dass die Bucket- und Objekt-Policies des Moduls
-- angelegt werden können.
CREATE TABLE IF NOT EXISTS storage.buckets (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  public             BOOLEAN NOT NULL DEFAULT false,
  file_size_limit    BIGINT,
  allowed_mime_types TEXT[]
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id TEXT REFERENCES storage.buckets(id),
  name      TEXT NOT NULL,
  owner     UUID,
  metadata  JSONB
);

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT ALL ON storage.objects, storage.buckets TO authenticated, service_role;

CREATE OR REPLACE FUNCTION storage.foldername(name TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1];
$$;

-- `handle_updated_at()` bringt im Portal die App mit; Terramay kannte
-- sie nicht. sql/modul/01 legt sie an, wenn sie fehlt — hier fehlt
-- sie absichtlich, damit dieser Pfad mitgeprüft wird.
