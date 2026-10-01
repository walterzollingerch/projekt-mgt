-- ============================================================
-- Migration: Tägliche Aufgaben-Mail (Projekt-Mgt)
--
-- Jede Person kann in der Übersicht des Moduls ankreuzen, dass sie
-- jeden Arbeitstag eine Mail mit ihren offenen Aufgaben bekommt —
-- zuoberst die, die in fünf oder weniger Arbeitstagen fällig (oder
-- schon überfällig) sind.
--
-- Eine Zeile = abonniert. Keine Zeile = keine Mail. Bewusst eine
-- eigene Tabelle des Moduls statt einer Spalte auf `profiles`: die
-- gehört der Gastgeber-App, und deren Privilegien-Trigger zählt die
-- Spalten pro App einzeln auf.
--
-- Geschrieben wird nur von der Person selbst (Schalter in der
-- Oberfläche). Den Versand macht die App mit Service Role; die
-- Tabelle liest sie dafür ganz.
--
-- Führe dieses Script im Supabase SQL Editor aus
-- (setzt sql/modul/01 bis 11 voraus).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.aufgaben_tagesmail (
  profile_id   UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Vom Versand gesetzt: verhindert, dass ein doppelt ausgelöster
  -- Lauf am selben Tag ein zweites Mal verschickt
  zuletzt_gesendet_am DATE
);

COMMENT ON TABLE public.aufgaben_tagesmail IS
  'Abonnement der täglichen Aufgaben-Mail. Eine Zeile = abonniert.';

ALTER TABLE public.aufgaben_tagesmail ENABLE ROW LEVEL SECURITY;

-- Jede Person sieht, setzt und löscht nur ihre eigene Zeile.
-- Kein UPDATE: `zuletzt_gesendet_am` gehört dem Versand.
DROP POLICY IF EXISTS "aufgaben_tagesmail_select_eigene" ON public.aufgaben_tagesmail;
CREATE POLICY "aufgaben_tagesmail_select_eigene" ON public.aufgaben_tagesmail
  FOR SELECT USING (profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "aufgaben_tagesmail_insert_eigene" ON public.aufgaben_tagesmail;
CREATE POLICY "aufgaben_tagesmail_insert_eigene" ON public.aufgaben_tagesmail
  FOR INSERT WITH CHECK (profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "aufgaben_tagesmail_delete_eigene" ON public.aufgaben_tagesmail;
CREATE POLICY "aufgaben_tagesmail_delete_eigene" ON public.aufgaben_tagesmail
  FOR DELETE USING (profile_id = (SELECT auth.uid()));

-- ------------------------------------------------------------
-- Tabellenrechte: Supabase vergibt neuen Tabellen in `public`
-- automatisch alle Rechte an `authenticated` (und je nach Stand an
-- `anon`). Deshalb beide im REVOKE und danach genau das, was die
-- Oberfläche braucht.
-- ------------------------------------------------------------

REVOKE ALL ON public.aufgaben_tagesmail FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.aufgaben_tagesmail TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.aufgaben_tagesmail TO service_role;

-- ── Verifikation (rein lesend) ──────────────────────────────────────────────
-- Erwartet: in der Spalte «muss» steht überall dasselbe wie in «ist».
SELECT 'anon darf irgendetwas auf aufgaben_tagesmail (muss 0 sein)' AS pruefung,
       count(*)::text AS ist, '0' AS muss
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'aufgaben_tagesmail' AND grantee = 'anon'
UNION ALL
SELECT 'authenticated darf lesen (muss true sein)',
       has_table_privilege('authenticated', 'public.aufgaben_tagesmail', 'SELECT')::text, 'true'
UNION ALL
SELECT 'authenticated darf anlegen (muss true sein)',
       has_table_privilege('authenticated', 'public.aufgaben_tagesmail', 'INSERT')::text, 'true'
UNION ALL
SELECT 'authenticated darf loeschen (muss true sein)',
       has_table_privilege('authenticated', 'public.aufgaben_tagesmail', 'DELETE')::text, 'true'
UNION ALL
SELECT 'authenticated darf aendern (muss false sein)',
       has_table_privilege('authenticated', 'public.aufgaben_tagesmail', 'UPDATE')::text, 'false'
UNION ALL
SELECT 'authenticated darf truncaten (muss false sein)',
       has_table_privilege('authenticated', 'public.aufgaben_tagesmail', 'TRUNCATE')::text, 'false'
UNION ALL
SELECT 'RLS auf aufgaben_tagesmail aktiv (muss true sein)',
       relrowsecurity::text, 'true'
FROM pg_class WHERE oid = 'public.aufgaben_tagesmail'::regclass;

-- Diese Migration legt KEINE Funktion an — die zwei Rechte-Zeilen für
-- Funktionen entfallen deshalb hier.
