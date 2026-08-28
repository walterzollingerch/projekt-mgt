-- ============================================================
-- Migration: Ordner in Projekten (Projekt-Mgt)
-- Ein Projekt kann beliebig viele Ordner haben; ein Task kann
-- einem Ordner zugewiesen werden und erscheint dann unterhalb
-- dieses Ordners. Regeln (per Trigger erzwungen, nicht nur im UI):
--  - der Ordner muss zum Projekt des Tasks gehören
--  - Unter-Tasks liegen immer im Ordner ihres Mutter-Tasks
--    (wird automatisch nachgeführt, auch beim Umhängen)
--  - ein Ordner kann nur gelöscht werden, wenn ihm keine OFFENEN
--    Tasks mehr zugewiesen sind; archivierte Tasks verlieren beim
--    Löschen lediglich die Ordner-Zuordnung (ON DELETE SET NULL)
-- Führe dieses Script im Supabase SQL Editor aus
-- (setzt supabase_migration_unter_tasks.sql voraus)
-- ============================================================

-- 1. Ordner
CREATE TABLE IF NOT EXISTS public.project_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ordnernamen sind pro Projekt eindeutig (Gross-/Kleinschreibung egal)
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_folders_name_unique
  ON public.project_folders(project_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_project_folders_project
  ON public.project_folders(project_id, position);

-- 2. Zuordnung am Task
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES public.project_folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_folder ON public.tasks(folder_id);

-- 3. updated_at
DROP TRIGGER IF EXISTS project_folders_updated_at ON public.project_folders;
CREATE TRIGGER project_folders_updated_at BEFORE UPDATE ON public.project_folders
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 4. Ordner-Zuordnung am Task absichern
--    Unter-Tasks erben den Ordner des Mutter-Tasks — dadurch bleibt
--    die eingerückte Darstellung unter der Mutter immer stimmig.
CREATE OR REPLACE FUNCTION public.ensure_task_folder()
RETURNS TRIGGER AS $$
DECLARE
  ordner_projekt UUID;
BEGIN
  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT folder_id INTO NEW.folder_id
    FROM public.tasks WHERE id = NEW.parent_task_id;
    RETURN NEW;
  END IF;

  IF NEW.folder_id IS NOT NULL THEN
    SELECT project_id INTO ordner_projekt
    FROM public.project_folders WHERE id = NEW.folder_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Ordner nicht gefunden';
    END IF;
    IF ordner_projekt <> NEW.project_id THEN
      RAISE EXCEPTION 'Der Ordner gehört nicht zu diesem Projekt';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tasks_folder ON public.tasks;
CREATE TRIGGER tasks_folder
  BEFORE INSERT OR UPDATE OF folder_id, project_id, parent_task_id ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.ensure_task_folder();

-- 5. Wechselt ein Mutter-Task den Ordner, ziehen die Unter-Tasks mit
CREATE OR REPLACE FUNCTION public.sync_subtask_folder()
RETURNS TRIGGER AS $$
BEGIN
  -- Nur Mutter-Tasks; das Nachziehen der Kinder löst diesen Trigger
  -- zwar erneut aus, läuft dort aber sofort in diese Bedingung
  IF NEW.parent_task_id IS NULL AND NEW.folder_id IS DISTINCT FROM OLD.folder_id THEN
    UPDATE public.tasks
       SET folder_id = NEW.folder_id
     WHERE parent_task_id = NEW.id
       AND folder_id IS DISTINCT FROM NEW.folder_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tasks_folder_sync_kinder ON public.tasks;
CREATE TRIGGER tasks_folder_sync_kinder
  AFTER UPDATE OF folder_id ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.sync_subtask_folder();

-- 6. Löschschutz: nur leere Ordner (ohne offene Tasks) sind löschbar
CREATE OR REPLACE FUNCTION public.ensure_folder_leer()
RETURNS TRIGGER AS $$
DECLARE
  offene INTEGER;
BEGIN
  -- Wird das ganze Projekt gelöscht, räumt CASCADE Ordner und Tasks
  -- gemeinsam ab — dann darf dieser Schutz nicht dazwischenfunken
  -- (die projects-Zeile ist in derselben Transaktion schon weg).
  IF NOT EXISTS (SELECT 1 FROM public.projects WHERE id = OLD.project_id) THEN
    RETURN OLD;
  END IF;

  SELECT COUNT(*) INTO offene
  FROM public.tasks
  WHERE folder_id = OLD.id AND status = 'offen';

  IF offene > 0 THEN
    RAISE EXCEPTION 'Der Ordner enthält noch % offene Aufgabe(n) — zuerst schliessen oder in einen anderen Ordner verschieben', offene;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS project_folders_nur_leer_loeschen ON public.project_folders;
CREATE TRIGGER project_folders_nur_leer_loeschen
  BEFORE DELETE ON public.project_folders
  FOR EACH ROW EXECUTE FUNCTION public.ensure_folder_leer();

-- 7. RLS — wie bei Tasks: Admins alles, Projektmitglieder lesen,
--    anlegen, umbenennen und löschen (das Löschen ist durch den
--    Trigger oben ohnehin auf leere Ordner beschränkt)
ALTER TABLE public.project_folders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "project_folders_all_admin" ON public.project_folders;
CREATE POLICY "project_folders_all_admin" ON public.project_folders
  FOR ALL USING (public.is_project_admin()) WITH CHECK (public.is_project_admin());

DROP POLICY IF EXISTS "project_folders_select_member" ON public.project_folders;
CREATE POLICY "project_folders_select_member" ON public.project_folders
  FOR SELECT USING (public.is_project_member(project_id));

DROP POLICY IF EXISTS "project_folders_insert_member" ON public.project_folders;
CREATE POLICY "project_folders_insert_member" ON public.project_folders
  FOR INSERT WITH CHECK (public.is_project_member(project_id));

DROP POLICY IF EXISTS "project_folders_update_member" ON public.project_folders;
CREATE POLICY "project_folders_update_member" ON public.project_folders
  FOR UPDATE USING (public.is_project_member(project_id))
  WITH CHECK (public.is_project_member(project_id));

DROP POLICY IF EXISTS "project_folders_delete_member" ON public.project_folders;
CREATE POLICY "project_folders_delete_member" ON public.project_folders
  FOR DELETE USING (public.is_project_member(project_id));
