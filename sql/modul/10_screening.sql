-- ============================================================
-- Migration: Dokument-Screening (Projekt-Mgt)
--
-- Eine Maske nimmt ein Dokument entgegen (Protokoll, Mail, Offerte),
-- ein Sprachmodell schlägt daraus Aktionen vor, ein Mensch bestätigt
-- sie, und erst dann werden sie ausgeführt. Diese Migration legt an,
-- was das an Datenbank braucht:
--
--   1. den privaten Bucket, in dem das Dokument bis zur Bestätigung
--      liegt
--   2. das Protokoll der tatsächlich ausgeführten Läufe
--
-- Führe dieses Script im Supabase SQL Editor aus
-- (setzt modul/01 bis 09 voraus).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Bucket für die hochgeladenen Dokumente
--
--    Pfad-Konvention: <profile_id>/<uuid>.<endung> — der erste
--    Pfadabschnitt ist die hochladende Person, darüber greifen die
--    Policies.
--
--    Warum nicht `task-attachments`: dessen Policies binden den Pfad
--    an eine EXISTIERENDE Task-ID (modul/02). Beim Hochladen gibt es
--    die Aufgabe aber noch gar nicht — sie entsteht erst, wenn jemand
--    den Vorschlag bestätigt. Ein eigener Bucket, nach Person
--    geordnet, ist die ehrliche Abbildung: das Dokument gehört bis
--    dahin niemandem ausser der Person, die es hochgeladen hat.
-- ------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public) VALUES ('screening-dokumente', 'screening-dokumente', false)
ON CONFLICT (id) DO NOTHING;

-- Nur die eigenen Dokumente, in beide Richtungen. Bewusst OHNE
-- Verwalter-Ausnahme: ein hochgeladenes Protokoll ist Rohmaterial auf
-- dem Weg in die Aufgaben, kein Projektinhalt. Was davon bleiben
-- soll, landet als Notiz-Anhang in `task-attachments` — dort gelten
-- dann die Projektrechte.
DROP POLICY IF EXISTS "screening_dokumente_select" ON storage.objects;
CREATE POLICY "screening_dokumente_select" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'screening-dokumente'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "screening_dokumente_insert" ON storage.objects;
CREATE POLICY "screening_dokumente_insert" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'screening-dokumente'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "screening_dokumente_delete" ON storage.objects;
CREATE POLICY "screening_dokumente_delete" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'screening-dokumente'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ------------------------------------------------------------
-- 2. Protokoll der ausgeführten Läufe
--
--    Ein Screening ändert auf einen Schlag ein Dutzend Aufgaben über
--    mehrere Projekte hinweg. Ohne Spur bleibt später unklar, woher
--    eine Notiz oder eine Fälligkeit kam. Festgehalten wird der
--    bestätigte Plan und was daraus tatsächlich wurde — auch das
--    Gescheiterte.
--
--    Nur ausgeführte Läufe stehen hier. Eine Analyse allein ändert
--    nichts und braucht keine Spur.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.screening_laeufe (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Projekt, aus dem das Screening gestartet wurde. Die einzelnen
  -- Aktionen können in andere Projekte zeigen — sie stehen in `aktionen`.
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  datei_pfad TEXT,
  datei_name TEXT,
  mails_gesendet BOOLEAN NOT NULL DEFAULT FALSE,
  aktionen JSONB NOT NULL,
  ergebnis JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_screening_laeufe_person
  ON public.screening_laeufe(profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_screening_laeufe_projekt
  ON public.screening_laeufe(project_id, created_at DESC);

ALTER TABLE public.screening_laeufe ENABLE ROW LEVEL SECURITY;

-- Jede Person sieht ihre eigenen Läufe und legt eigene an.
-- Kein UPDATE, kein DELETE: ein Protokoll, das die protokollierte
-- Person ändern kann, ist keines. Projektverwalter bekommen bewusst
-- KEINE Sicht — was ein Screening bewirkt hat, steht in den Aufgaben
-- selbst und ist dort für alle Beteiligten sichtbar.
DROP POLICY IF EXISTS "screening_laeufe_select_eigene" ON public.screening_laeufe;
CREATE POLICY "screening_laeufe_select_eigene" ON public.screening_laeufe
  FOR SELECT USING (profile_id = auth.uid());

DROP POLICY IF EXISTS "screening_laeufe_insert_eigene" ON public.screening_laeufe;
CREATE POLICY "screening_laeufe_insert_eigene" ON public.screening_laeufe
  FOR INSERT WITH CHECK (profile_id = auth.uid());

-- ------------------------------------------------------------
-- 3. Tabellenrechte
--
--    Supabase vergibt für neue Tabellen im Schema `public` per
--    ALTER DEFAULT PRIVILEGES automatisch ALLE Rechte an `anon` UND
--    `authenticated`. Ein REVOKE nur von PUBLIC und anon liesse
--    `authenticated` mit UPDATE, DELETE und TRUNCATE zurück — und
--    TRUNCATE filtert die RLS nicht. Deshalb beide Rollen im REVOKE
--    und danach genau das, was die App braucht.
-- ------------------------------------------------------------

REVOKE ALL ON public.screening_laeufe FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.screening_laeufe TO authenticated;
GRANT SELECT, INSERT ON public.screening_laeufe TO service_role;

-- ── Verifikation (rein lesend) ──────────────────────────────────────────────
-- Erwartet: in der Spalte «muss» steht überall dasselbe wie in «ist».
SELECT 'anon darf irgendetwas auf screening_laeufe (muss 0 sein)' AS pruefung,
       count(*)::text AS ist, '0' AS muss
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'screening_laeufe' AND grantee = 'anon'
UNION ALL
SELECT 'authenticated darf Laeufe lesen (muss true sein)',
       has_table_privilege('authenticated', 'public.screening_laeufe', 'SELECT')::text, 'true'
UNION ALL
SELECT 'authenticated darf Laeufe anlegen (muss true sein)',
       has_table_privilege('authenticated', 'public.screening_laeufe', 'INSERT')::text, 'true'
UNION ALL
SELECT 'authenticated darf Laeufe aendern (muss false sein)',
       has_table_privilege('authenticated', 'public.screening_laeufe', 'UPDATE')::text, 'false'
UNION ALL
SELECT 'authenticated darf Laeufe loeschen (muss false sein)',
       has_table_privilege('authenticated', 'public.screening_laeufe', 'DELETE')::text, 'false'
UNION ALL
SELECT 'authenticated darf Laeufe truncaten (muss false sein)',
       has_table_privilege('authenticated', 'public.screening_laeufe', 'TRUNCATE')::text, 'false'
UNION ALL
SELECT 'RLS auf screening_laeufe aktiv (muss true sein)',
       relrowsecurity::text, 'true'
FROM pg_class WHERE oid = 'public.screening_laeufe'::regclass
UNION ALL
SELECT 'Bucket screening-dokumente ist privat (muss false sein)',
       public::text, 'false'
FROM storage.buckets WHERE id = 'screening-dokumente';

-- Diese Migration legt KEINE Funktion an — die zwei Rechte-Zeilen für
-- Funktionen (REVOKE von PUBLIC, anon / GRANT an authenticated,
-- service_role) entfallen deshalb hier. Kommt später eine dazu,
-- gehören sie unmittelbar hinter ihr CREATE.
