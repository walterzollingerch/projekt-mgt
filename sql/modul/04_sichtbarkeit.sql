-- ============================================================
-- Migration: Projekt-Sichtbarkeit nur für Mitglieder (Projekt-Mgt)
-- Bisher sahen Projektverwalter (can_manage_projects) ALLE Projekte.
-- Neu: Nur Admins sehen alles. Projektverwalter sehen/verwalten nur
-- Projekte, in denen sie Mitglied sind (oder die sie selbst erstellt
-- haben — nötig, damit ein frisch angelegtes Projekt sichtbar ist;
-- die API fügt den Ersteller zusätzlich automatisch als Mitglied zu).
-- Führe dieses Script im Supabase SQL Editor aus
-- (setzt supabase_migration_task_wiederholung.sql voraus)
-- ============================================================

-- 1. Hilfsfunktionen
CREATE OR REPLACE FUNCTION public.is_project_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin' AND NOT is_blocked
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Darf dieses konkrete Projekt verwalten: Admin — oder Projekt-
-- verwalter, der Mitglied oder Ersteller des Projekts ist
CREATE OR REPLACE FUNCTION public.kann_projekt_verwalten(p_project_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.is_project_admin()
      OR (public.is_project_manager() AND (
            public.is_project_member(p_project_id)
            OR EXISTS (
              SELECT 1 FROM public.projects
              WHERE id = p_project_id AND created_by = auth.uid()
            )));
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- 2. Projekte
DROP POLICY IF EXISTS "projects_all_manager" ON public.projects;
DROP POLICY IF EXISTS "projects_all_admin" ON public.projects;
CREATE POLICY "projects_all_admin" ON public.projects
  FOR ALL USING (public.is_project_admin()) WITH CHECK (public.is_project_admin());
-- projects_select_member bleibt bestehen (Mitglieder lesen)
DROP POLICY IF EXISTS "projects_select_creator" ON public.projects;
CREATE POLICY "projects_select_creator" ON public.projects
  FOR SELECT USING (created_by = auth.uid());
DROP POLICY IF EXISTS "projects_insert_manager" ON public.projects;
CREATE POLICY "projects_insert_manager" ON public.projects
  FOR INSERT WITH CHECK (public.is_project_manager() AND created_by = auth.uid());
DROP POLICY IF EXISTS "projects_update_manager" ON public.projects;
CREATE POLICY "projects_update_manager" ON public.projects
  FOR UPDATE USING (public.kann_projekt_verwalten(id))
  WITH CHECK (public.kann_projekt_verwalten(id));
DROP POLICY IF EXISTS "projects_delete_manager" ON public.projects;
CREATE POLICY "projects_delete_manager" ON public.projects
  FOR DELETE USING (public.kann_projekt_verwalten(id));

-- 3. Projektmitglieder
DROP POLICY IF EXISTS "project_members_all_manager" ON public.project_members;
DROP POLICY IF EXISTS "project_members_all_admin" ON public.project_members;
CREATE POLICY "project_members_all_admin" ON public.project_members
  FOR ALL USING (public.is_project_admin()) WITH CHECK (public.is_project_admin());
-- project_members_select_member bleibt bestehen
DROP POLICY IF EXISTS "project_members_select_verwalter" ON public.project_members;
CREATE POLICY "project_members_select_verwalter" ON public.project_members
  FOR SELECT USING (public.kann_projekt_verwalten(project_id));
DROP POLICY IF EXISTS "project_members_insert_verwalter" ON public.project_members;
CREATE POLICY "project_members_insert_verwalter" ON public.project_members
  FOR INSERT WITH CHECK (public.kann_projekt_verwalten(project_id));
DROP POLICY IF EXISTS "project_members_delete_verwalter" ON public.project_members;
CREATE POLICY "project_members_delete_verwalter" ON public.project_members
  FOR DELETE USING (public.kann_projekt_verwalten(project_id));

-- 4. Tasks
DROP POLICY IF EXISTS "tasks_all_manager" ON public.tasks;
DROP POLICY IF EXISTS "tasks_all_admin" ON public.tasks;
CREATE POLICY "tasks_all_admin" ON public.tasks
  FOR ALL USING (public.is_project_admin()) WITH CHECK (public.is_project_admin());
-- Mitglieder-Policies (select/insert/update) bleiben bestehen
DROP POLICY IF EXISTS "tasks_delete_verwalter" ON public.tasks;
CREATE POLICY "tasks_delete_verwalter" ON public.tasks
  FOR DELETE USING (public.kann_projekt_verwalten(project_id));

-- 5. Notizen: Verwalter-Blankozugriff durch Admin ersetzen
DROP POLICY IF EXISTS "task_notes_select" ON public.task_notes;
CREATE POLICY "task_notes_select" ON public.task_notes
  FOR SELECT USING (public.is_project_admin() OR public.is_member_of_task(task_id));
DROP POLICY IF EXISTS "task_notes_insert" ON public.task_notes;
CREATE POLICY "task_notes_insert" ON public.task_notes
  FOR INSERT WITH CHECK (
    author_id = auth.uid()
    AND (public.is_project_admin() OR public.is_member_of_task(task_id))
  );

-- 6. Beobachter
DROP POLICY IF EXISTS "task_watchers_all_manager" ON public.task_watchers;
DROP POLICY IF EXISTS "task_watchers_all_admin" ON public.task_watchers;
CREATE POLICY "task_watchers_all_admin" ON public.task_watchers
  FOR ALL USING (public.is_project_admin()) WITH CHECK (public.is_project_admin());
-- Mitglieder-Policies bleiben bestehen

-- 7. Storage-Anhänge: Verwalter-Blankozugriff durch Admin ersetzen
DROP POLICY IF EXISTS "task_attachments_select" ON storage.objects;
CREATE POLICY "task_attachments_select" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'task-attachments'
    AND (public.is_project_admin()
         OR public.is_member_of_task(((storage.foldername(name))[1])::uuid))
  );
DROP POLICY IF EXISTS "task_attachments_insert" ON storage.objects;
CREATE POLICY "task_attachments_insert" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'task-attachments'
    AND (public.is_project_admin()
         OR public.is_member_of_task(((storage.foldername(name))[1])::uuid))
  );

-- Hinweis: profiles_select_projectmgr (Projektverwalter sehen alle
-- Profile) bleibt bestehen — nötig für die Mitglieder-Auswahl.
