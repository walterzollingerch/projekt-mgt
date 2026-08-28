-- ============================================================
-- Migration: MCP-Zugang für externe Stakeholder (Projekt-Mgt)
--
-- Legt die Tabellen für persönliche MCP-Zugänge an. Jeder Zugang
-- gehört zu genau einem Portal-Profil; der MCP-Server handelt
-- ausschliesslich im Namen dieses Profils und sieht/darf exakt das,
-- was die Person auch unter /aufgaben sieht und darf.
--
-- Der Token wird NUR als SHA-256-Hash gespeichert — die Klartext-URL
-- wird beim Anlegen ein einziges Mal angezeigt und ist danach nicht
-- mehr rekonstruierbar.
--
-- Führe dieses Script im Supabase SQL Editor aus
-- (setzt supabase_migration_projekt_ordner.sql voraus)
-- ============================================================

-- 1. Zugänge
CREATE TABLE IF NOT EXISTS public.mcp_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Bezeichnung des Zugangs, z.B. «Claude Desktop von Thomas»
  name TEXT NOT NULL,
  -- SHA-256-Hex des Klartext-Tokens
  token_hash TEXT NOT NULL UNIQUE,
  -- Erste Zeichen des Tokens zur Wiedererkennung in der Liste
  token_prefix TEXT NOT NULL,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  -- Optionales Ablaufdatum; NULL = unbefristet
  expires_at TIMESTAMPTZ,
  -- Gesetzt = widerrufen, der Zugang funktioniert nicht mehr
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mcp_tokens_profile ON public.mcp_tokens(profile_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_hash ON public.mcp_tokens(token_hash);

-- 2. Protokoll aller Aufrufe (Nachvollziehbarkeit: wer hat von
--    aussen was ausgelöst)
CREATE TABLE IF NOT EXISTS public.mcp_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id UUID REFERENCES public.mcp_tokens(id) ON DELETE SET NULL,
  profile_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  tool TEXT NOT NULL,
  argumente JSONB,
  erfolg BOOLEAN NOT NULL DEFAULT TRUE,
  fehler TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_audit_created ON public.mcp_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_profile ON public.mcp_audit(profile_id, created_at DESC);

-- 3. RLS: kein Zugriff über den Anon-Key. Beide Tabellen werden
--    ausschliesslich serverseitig mit dem Service-Role-Schlüssel
--    gelesen und geschrieben (der die RLS umgeht); die Admin-Ansicht
--    läuft über /api/admin/mcp-tokens. Lesen erlauben wir zusätzlich
--    Admins, damit direkte Abfragen im Studio/Client möglich bleiben.
ALTER TABLE public.mcp_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mcp_tokens_select_admin" ON public.mcp_tokens;
CREATE POLICY "mcp_tokens_select_admin" ON public.mcp_tokens
  FOR SELECT USING (public.is_project_admin());

DROP POLICY IF EXISTS "mcp_audit_select_admin" ON public.mcp_audit;
CREATE POLICY "mcp_audit_select_admin" ON public.mcp_audit
  FOR SELECT USING (public.is_project_admin());
