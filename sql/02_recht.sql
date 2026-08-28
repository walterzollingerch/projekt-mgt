-- ============================================================
-- Migration: Recht "Darf Projekt-Mgt verwenden" (can_use_projects)
-- Mit diesem Recht sieht man die Kachel "Projekt-Mgt" unter Start
-- und ist bei Projekten als Mitglied wählbar.
-- Führe dieses Script im Supabase SQL Editor aus
-- (setzt supabase_migration_task_tracker.sql voraus)
-- ============================================================

-- 1. Neues Recht auf profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_use_projects BOOLEAN DEFAULT FALSE NOT NULL;

-- 2. Privilegien-Schutz-Trigger um das neue Recht erweitern
CREATE OR REPLACE FUNCTION public.protect_profile_privileges()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.role IS DISTINCT FROM OLD.role
      OR NEW.can_capture_receipts IS DISTINCT FROM OLD.can_capture_receipts
      OR NEW.can_manage_finances IS DISTINCT FROM OLD.can_manage_finances
      OR NEW.can_manage_meals IS DISTINCT FROM OLD.can_manage_meals
      OR NEW.can_manage_users IS DISTINCT FROM OLD.can_manage_users
      OR NEW.can_manage_references IS DISTINCT FROM OLD.can_manage_references
      OR NEW.can_review_references IS DISTINCT FROM OLD.can_review_references
      OR NEW.can_manage_trademarks IS DISTINCT FROM OLD.can_manage_trademarks
      OR NEW.can_view_factorial_reports IS DISTINCT FROM OLD.can_view_factorial_reports
      OR NEW.can_view_event_guests IS DISTINCT FROM OLD.can_view_event_guests
      OR NEW.can_manage_projects IS DISTINCT FROM OLD.can_manage_projects
      OR NEW.can_use_projects IS DISTINCT FROM OLD.can_use_projects
      OR NEW.is_blocked IS DISTINCT FROM OLD.is_blocked) THEN
    IF auth.uid() IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
    ) THEN
      RAISE EXCEPTION 'Keine Berechtigung, Rollen oder Rechte zu ändern';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Bestehende Projektmitglieder erhalten das Recht automatisch,
--    damit sie den Zugang nicht verlieren
UPDATE public.profiles
SET can_use_projects = TRUE
WHERE id IN (SELECT profile_id FROM public.project_members)
  AND NOT can_use_projects;
