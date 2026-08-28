-- ============================================================
-- Migration: Unter-Tasks (Projekt-Mgt)
-- Ein Task kann Unter-Tasks haben (eine Ebene tief). Ein Mutter-
-- Task kann erst geschlossen werden, wenn alle Unter-Tasks
-- geschlossen sind — per Trigger erzwungen, nicht nur im UI.
-- Weitere Regeln (ebenfalls Trigger):
--  - Unter-Task liegt im gleichen Projekt wie der Mutter-Task
--  - keine Unter-Tasks von Unter-Tasks (keine Enkel)
--  - kein offener Unter-Task unter geschlossenem Mutter-Task
--    (weder anlegen noch reaktivieren)
-- Löschen eines Mutter-Tasks löscht die Unter-Tasks mit (CASCADE).
-- Führe dieses Script im Supabase SQL Editor aus
-- (setzt supabase_migration_projekte_mitglieder_sichtbarkeit.sql voraus)
-- ============================================================

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS parent_task_id UUID REFERENCES public.tasks(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_tasks_parent ON public.tasks(parent_task_id);

CREATE OR REPLACE FUNCTION public.ensure_task_hierarchie()
RETURNS TRIGGER AS $$
DECLARE
  eltern RECORD;
BEGIN
  IF NEW.parent_task_id IS NOT NULL THEN
    IF NEW.parent_task_id = NEW.id THEN
      RAISE EXCEPTION 'Ein Task kann nicht sein eigener Unter-Task sein';
    END IF;

    SELECT project_id, parent_task_id, status INTO eltern
    FROM public.tasks WHERE id = NEW.parent_task_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mutter-Task nicht gefunden';
    END IF;
    IF eltern.parent_task_id IS NOT NULL THEN
      RAISE EXCEPTION 'Unter-Tasks können keine eigenen Unter-Tasks haben';
    END IF;
    IF eltern.project_id <> NEW.project_id THEN
      RAISE EXCEPTION 'Der Unter-Task muss im gleichen Projekt liegen wie der Mutter-Task';
    END IF;
    -- Ein Task mit eigenen Unter-Tasks kann nicht selbst Unter-Task werden
    IF EXISTS (SELECT 1 FROM public.tasks WHERE parent_task_id = NEW.id) THEN
      RAISE EXCEPTION 'Ein Task mit Unter-Tasks kann nicht selbst Unter-Task werden';
    END IF;
    -- Kein offener Unter-Task unter geschlossenem Mutter-Task
    IF NEW.status = 'offen' AND eltern.status = 'geschlossen' THEN
      RAISE EXCEPTION 'Der Mutter-Task ist geschlossen — zuerst den Mutter-Task reaktivieren';
    END IF;
  END IF;

  -- Schliessen nur, wenn alle Unter-Tasks geschlossen sind
  IF TG_OP = 'UPDATE' AND NEW.status = 'geschlossen' AND OLD.status = 'offen' THEN
    IF EXISTS (
      SELECT 1 FROM public.tasks
      WHERE parent_task_id = NEW.id AND status = 'offen'
    ) THEN
      RAISE EXCEPTION 'Der Task kann erst geschlossen werden, wenn alle Unter-Tasks geschlossen sind';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tasks_hierarchie ON public.tasks;
CREATE TRIGGER tasks_hierarchie
  BEFORE INSERT OR UPDATE OF parent_task_id, status, project_id ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.ensure_task_hierarchie();
