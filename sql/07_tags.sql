-- ============================================================
-- Migration: Tags im Projekt-Mgt
-- Tags sind eine eigene Dimension neben Projekt und Ordner:
--  - gepflegt wird pro Mandant (= Firma), nicht pro Projekt —
--    dieselben Tags stehen in allen Projekten einer Firma bereit
--  - eine Aufgabe kann beliebig viele Tags haben (n:m)
--  - der Tag muss zur Firma der Aufgabe gehören (Trigger)
--  - wandert eine Aufgabe in ein Projekt einer ANDEREN Firma,
--    fallen ihre Tags automatisch weg (sie gelten dort nicht)
-- Führe dieses Script im Supabase SQL Editor aus
-- (setzt supabase_migration_projekt_ordner.sql voraus)
-- ============================================================

-- 1. Tags pro Firma
CREATE TABLE IF NOT EXISTS public.task_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  farbe TEXT NOT NULL DEFAULT 'grau',
  position INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT task_tags_farbe_check CHECK (
    farbe IN ('grau', 'blau', 'gruen', 'gelb', 'orange', 'rot', 'violett', 'tuerkis')
  )
);

-- Tag-Namen sind pro Firma eindeutig (Gross-/Kleinschreibung egal)
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_tags_name_unique
  ON public.task_tags(company_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_task_tags_company
  ON public.task_tags(company_id, position);

-- 2. Zuordnung Aufgabe ↔ Tag
CREATE TABLE IF NOT EXISTS public.task_tag_zuordnungen (
  task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES public.task_tags(id) ON DELETE CASCADE,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (task_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_task_tag_zuordnungen_tag
  ON public.task_tag_zuordnungen(tag_id);

-- 3. updated_at
DROP TRIGGER IF EXISTS task_tags_updated_at ON public.task_tags;
CREATE TRIGGER task_tags_updated_at BEFORE UPDATE ON public.task_tags
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 4. Ein Tag darf nur an Aufgaben derselben Firma hängen
CREATE OR REPLACE FUNCTION public.ensure_task_tag_firma()
RETURNS TRIGGER AS $$
DECLARE
  tag_firma UUID;
  task_firma UUID;
BEGIN
  SELECT company_id INTO tag_firma FROM public.task_tags WHERE id = NEW.tag_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tag nicht gefunden';
  END IF;

  SELECT p.company_id INTO task_firma
  FROM public.tasks t
  JOIN public.projects p ON p.id = t.project_id
  WHERE t.id = NEW.task_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Aufgabe nicht gefunden';
  END IF;

  IF tag_firma <> task_firma THEN
    RAISE EXCEPTION 'Der Tag gehört zu einer anderen Firma als die Aufgabe';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS task_tag_zuordnungen_firma ON public.task_tag_zuordnungen;
CREATE TRIGGER task_tag_zuordnungen_firma
  BEFORE INSERT OR UPDATE ON public.task_tag_zuordnungen
  FOR EACH ROW EXECUTE FUNCTION public.ensure_task_tag_firma();

-- 5. Umhängen in ein Projekt einer anderen Firma: firmenfremde Tags
--    fallen weg (Ordner verhalten sich gleich — sie gehören zu genau
--    einem Projekt). Innerhalb derselben Firma bleiben die Tags.
CREATE OR REPLACE FUNCTION public.sync_task_tags_firma()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM public.task_tag_zuordnungen z
  USING public.task_tags g, public.projects p
  WHERE z.task_id = NEW.id
    AND z.tag_id = g.id
    AND p.id = NEW.project_id
    AND g.company_id <> p.company_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tasks_tags_firma_sync ON public.tasks;
CREATE TRIGGER tasks_tags_firma_sync
  AFTER UPDATE OF project_id ON public.tasks
  FOR EACH ROW WHEN (NEW.project_id IS DISTINCT FROM OLD.project_id)
  EXECUTE FUNCTION public.sync_task_tags_firma();

-- 6. Hilfsfunktionen für die RLS (nach den Tabellen anlegen —
--    Postgres validiert LANGUAGE-sql-Bodies schon beim CREATE)

-- Tags einer Firma sehen: Admins immer, sonst wer in mindestens
-- einem Projekt dieser Firma Mitglied ist
CREATE OR REPLACE FUNCTION public.darf_firmen_tags_sehen(p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
  SELECT public.is_project_admin()
      OR EXISTS (
        SELECT 1
        FROM public.projects p
        JOIN public.project_members m ON m.project_id = p.id
        JOIN public.profiles pr ON pr.id = m.profile_id
        WHERE p.company_id = p_company_id
          AND m.profile_id = auth.uid()
          AND NOT pr.is_blocked
      );
$$;

-- Tags einer Firma pflegen: Admins immer, sonst Projektverwalter,
-- die in dieser Firma ein Projekt haben (Mitglied oder Ersteller).
-- Tags wirken firmenweit, deshalb bewusst enger als das Anlegen
-- von Ordnern (das jedes Projektmitglied darf).
CREATE OR REPLACE FUNCTION public.darf_firmen_tags_pflegen(p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
  SELECT public.is_project_admin()
      OR (public.is_project_manager() AND EXISTS (
            SELECT 1 FROM public.projects p
            WHERE p.company_id = p_company_id
              AND (public.is_project_member(p.id) OR p.created_by = auth.uid())
          ));
$$;

-- 7. RLS
ALTER TABLE public.task_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_tag_zuordnungen ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "task_tags_select" ON public.task_tags;
CREATE POLICY "task_tags_select" ON public.task_tags
  FOR SELECT USING (public.darf_firmen_tags_sehen(company_id));

DROP POLICY IF EXISTS "task_tags_insert" ON public.task_tags;
CREATE POLICY "task_tags_insert" ON public.task_tags
  FOR INSERT WITH CHECK (public.darf_firmen_tags_pflegen(company_id));

DROP POLICY IF EXISTS "task_tags_update" ON public.task_tags;
CREATE POLICY "task_tags_update" ON public.task_tags
  FOR UPDATE USING (public.darf_firmen_tags_pflegen(company_id))
  WITH CHECK (public.darf_firmen_tags_pflegen(company_id));

DROP POLICY IF EXISTS "task_tags_delete" ON public.task_tags;
CREATE POLICY "task_tags_delete" ON public.task_tags
  FOR DELETE USING (public.darf_firmen_tags_pflegen(company_id));

-- Zuordnungen: wie bei Notizen — Admins alles, sonst Mitglieder des
-- Projekts, in dem die Aufgabe liegt
DROP POLICY IF EXISTS "task_tag_zuordnungen_all_admin" ON public.task_tag_zuordnungen;
CREATE POLICY "task_tag_zuordnungen_all_admin" ON public.task_tag_zuordnungen
  FOR ALL USING (public.is_project_admin()) WITH CHECK (public.is_project_admin());

DROP POLICY IF EXISTS "task_tag_zuordnungen_select_member" ON public.task_tag_zuordnungen;
CREATE POLICY "task_tag_zuordnungen_select_member" ON public.task_tag_zuordnungen
  FOR SELECT USING (public.is_member_of_task(task_id));

DROP POLICY IF EXISTS "task_tag_zuordnungen_insert_member" ON public.task_tag_zuordnungen;
CREATE POLICY "task_tag_zuordnungen_insert_member" ON public.task_tag_zuordnungen
  FOR INSERT WITH CHECK (public.is_member_of_task(task_id));

DROP POLICY IF EXISTS "task_tag_zuordnungen_delete_member" ON public.task_tag_zuordnungen;
CREATE POLICY "task_tag_zuordnungen_delete_member" ON public.task_tag_zuordnungen
  FOR DELETE USING (public.is_member_of_task(task_id));
