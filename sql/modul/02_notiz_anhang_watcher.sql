-- ============================================================
-- Migration: Notiz-Anhänge und Task-Beobachter (Projekt-Mgt)
-- 1) Notizen können eine Datei tragen (privater Storage-Bucket,
--    wird bei der Notiz-Mail als Attachment mitversendet)
-- 2) task_watchers: beim Notiz-Erfassen kann eine weitere Person
--    aus dem Projekt informiert werden; sie bleibt gespeichert und
--    wird ab dann bei jeder neuen Notiz des Tasks informiert
-- Führe dieses Script im Supabase SQL Editor aus
-- (setzt supabase_migration_projektmgt_recht.sql voraus)
-- ============================================================

-- 1. Datei-Felder auf task_notes (eine Datei pro Notiz)
ALTER TABLE public.task_notes
  ADD COLUMN IF NOT EXISTS file_path TEXT,
  ADD COLUMN IF NOT EXISTS file_name TEXT;

-- 2. Beobachter pro Task
CREATE TABLE IF NOT EXISTS public.task_watchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  added_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (task_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_task_watchers_task ON public.task_watchers(task_id);

-- Beobachter muss Mitglied des Projekts sein (wie der Zuständige)
CREATE OR REPLACE FUNCTION public.ensure_watcher_is_member()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.tasks t
    JOIN public.project_members pm ON pm.project_id = t.project_id
    WHERE t.id = NEW.task_id AND pm.profile_id = NEW.profile_id
  ) THEN
    RAISE EXCEPTION 'Die zu informierende Person muss Mitglied des Projekts sein';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS task_watchers_is_member ON public.task_watchers;
CREATE TRIGGER task_watchers_is_member
  BEFORE INSERT OR UPDATE ON public.task_watchers
  FOR EACH ROW EXECUTE FUNCTION public.ensure_watcher_is_member();

-- 3. RLS für task_watchers
ALTER TABLE public.task_watchers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "task_watchers_all_manager" ON public.task_watchers;
CREATE POLICY "task_watchers_all_manager" ON public.task_watchers
  FOR ALL USING (public.is_project_manager()) WITH CHECK (public.is_project_manager());
DROP POLICY IF EXISTS "task_watchers_select_member" ON public.task_watchers;
CREATE POLICY "task_watchers_select_member" ON public.task_watchers
  FOR SELECT USING (public.is_member_of_task(task_id));
DROP POLICY IF EXISTS "task_watchers_insert_member" ON public.task_watchers;
CREATE POLICY "task_watchers_insert_member" ON public.task_watchers
  FOR INSERT WITH CHECK (public.is_member_of_task(task_id));
DROP POLICY IF EXISTS "task_watchers_delete_member" ON public.task_watchers;
CREATE POLICY "task_watchers_delete_member" ON public.task_watchers
  FOR DELETE USING (public.is_member_of_task(task_id));

-- 4. Privater Storage-Bucket für Notiz-Anhänge.
--    Pfad-Konvention: <task_id>/<uuid>-<dateiname> — der erste
--    Pfadteil ist die Task-ID, darüber greifen die Policies.
INSERT INTO storage.buckets (id, name, public) VALUES ('task-attachments', 'task-attachments', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "task_attachments_select" ON storage.objects;
CREATE POLICY "task_attachments_select" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'task-attachments'
    AND (public.is_project_manager()
         OR public.is_member_of_task(((storage.foldername(name))[1])::uuid))
  );

DROP POLICY IF EXISTS "task_attachments_insert" ON storage.objects;
CREATE POLICY "task_attachments_insert" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'task-attachments'
    AND (public.is_project_manager()
         OR public.is_member_of_task(((storage.foldername(name))[1])::uuid))
  );
