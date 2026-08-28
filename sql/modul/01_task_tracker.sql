-- ============================================================
-- Migration: Task-Tracker (Projekte & Aufgaben)
-- Neues Recht can_manage_projects, Tabellen projects,
-- project_members, tasks, task_notes.
-- Sichtbarkeit: Projektverwalter sehen alles, Mitarbeiter nur
-- Projekte, denen sie als Mitglied zugefügt wurden.
-- Notizen sind unveränderlich (nur Einfügen) — der chronologische
-- Verlauf mit Autor bleibt garantiert erhalten.
-- Führe dieses Script im Supabase SQL Editor aus
-- (setzt supabase_migration_sommerfest_gaeste.sql voraus)
-- ============================================================

-- 1./2. HOST-ANTEIL — nicht mehr hier.
--
-- Die Spalten `can_manage_projects` / `can_use_projects` auf
-- `profiles` und der Privilegien-Schutz-Trigger gehören der
-- Gastgeber-App, nicht dem Modul: der Trigger zählt ALLE Rechte-
-- Spalten der jeweiligen App auf, und die sind überall andere.
-- Siehe `sql/host/` — dort liegt für jede App ihre Fassung.
--
-- Vor diesem Script laufen lassen.

-- 3. Hilfsfunktion für die RLS (weitere Hilfsfunktionen folgen in
--    Abschnitt 7b — sie referenzieren die neuen Tabellen und können
--    erst nach deren Anlage erstellt werden)
CREATE OR REPLACE FUNCTION public.is_project_manager()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND (role = 'admin' OR can_manage_projects) AND NOT is_blocked
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- 4. Projekte
CREATE TABLE IF NOT EXISTS public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  beschreibung TEXT,
  status TEXT NOT NULL DEFAULT 'aktiv' CHECK (status IN ('aktiv', 'archiviert')),
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Projektmitglieder (nur Mitglieder sind als Task-Zuständige wählbar)
CREATE TABLE IF NOT EXISTS public.project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  added_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, profile_id)
);

-- 6. Tasks — geschlossen = archiviert (kein separates Archiv,
--    das Archiv ist eine gefilterte Ansicht mit Suche)
CREATE TABLE IF NOT EXISTS public.tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  titel TEXT NOT NULL,
  beschreibung TEXT,
  assignee_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'offen' CHECK (status IN ('offen', 'geschlossen')),
  closed_at TIMESTAMPTZ,
  closed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Notizen — unveränderlich, chronologisch, mit Autor
CREATE TABLE IF NOT EXISTS public.task_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  author_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7b. Hilfsfunktionen auf den neuen Tabellen (SECURITY DEFINER,
--     damit die RLS-Policies nicht rekursiv auf die eigenen
--     Tabellen zugreifen)
CREATE OR REPLACE FUNCTION public.is_project_member(p_project_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = p_project_id AND profile_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.is_member_of_task(p_task_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.tasks t
    JOIN public.project_members pm ON pm.project_id = t.project_id
    WHERE t.id = p_task_id AND pm.profile_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Teilen zwei Benutzer ein Projekt? (für die Profil-Sichtbarkeit)
CREATE OR REPLACE FUNCTION public.shares_project_with(p_profile_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.project_members a
    JOIN public.project_members b ON a.project_id = b.project_id
    WHERE a.profile_id = auth.uid() AND b.profile_id = p_profile_id
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- 8. Zuständiger muss Projektmitglied sein
CREATE OR REPLACE FUNCTION public.ensure_task_assignee_is_member()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.assignee_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = NEW.project_id AND profile_id = NEW.assignee_id
  ) THEN
    RAISE EXCEPTION 'Der Zuständige muss zuerst dem Projekt als Mitglied zugefügt werden';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tasks_assignee_is_member ON public.tasks;
CREATE TRIGGER tasks_assignee_is_member
  BEFORE INSERT OR UPDATE OF assignee_id, project_id ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.ensure_task_assignee_is_member();

-- 9. updated_at-Trigger
DROP TRIGGER IF EXISTS projects_updated_at ON public.projects;
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
DROP TRIGGER IF EXISTS tasks_updated_at ON public.tasks;
CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 10. Indexe (pg_trgm für die Archiv-Suche ist bereits installiert)
CREATE INDEX IF NOT EXISTS idx_project_members_project ON public.project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_profile ON public.project_members(profile_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON public.tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON public.tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_task_notes_task ON public.task_notes(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_titel_trgm ON public.tasks
  USING gin (titel gin_trgm_ops);

-- 11. RLS
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_notes ENABLE ROW LEVEL SECURITY;

-- Projekte: Verwalter alles, Mitglieder lesen
DROP POLICY IF EXISTS "projects_all_manager" ON public.projects;
CREATE POLICY "projects_all_manager" ON public.projects
  FOR ALL USING (public.is_project_manager()) WITH CHECK (public.is_project_manager());
DROP POLICY IF EXISTS "projects_select_member" ON public.projects;
CREATE POLICY "projects_select_member" ON public.projects
  FOR SELECT USING (public.is_project_member(id));

-- Mitglieder: Verwalter alles, Mitglieder sehen die Mitgliederliste
-- ihrer Projekte (nötig für die Zuständigen-Auswahl)
DROP POLICY IF EXISTS "project_members_all_manager" ON public.project_members;
CREATE POLICY "project_members_all_manager" ON public.project_members
  FOR ALL USING (public.is_project_manager()) WITH CHECK (public.is_project_manager());
DROP POLICY IF EXISTS "project_members_select_member" ON public.project_members;
CREATE POLICY "project_members_select_member" ON public.project_members
  FOR SELECT USING (public.is_project_member(project_id));

-- Tasks: Verwalter alles; Mitglieder lesen, anlegen und bearbeiten
-- (inkl. schliessen/reaktivieren); löschen nur Verwalter
DROP POLICY IF EXISTS "tasks_all_manager" ON public.tasks;
CREATE POLICY "tasks_all_manager" ON public.tasks
  FOR ALL USING (public.is_project_manager()) WITH CHECK (public.is_project_manager());
DROP POLICY IF EXISTS "tasks_select_member" ON public.tasks;
CREATE POLICY "tasks_select_member" ON public.tasks
  FOR SELECT USING (public.is_project_member(project_id));
DROP POLICY IF EXISTS "tasks_insert_member" ON public.tasks;
CREATE POLICY "tasks_insert_member" ON public.tasks
  FOR INSERT WITH CHECK (public.is_project_member(project_id));
DROP POLICY IF EXISTS "tasks_update_member" ON public.tasks;
CREATE POLICY "tasks_update_member" ON public.tasks
  FOR UPDATE USING (public.is_project_member(project_id))
  WITH CHECK (public.is_project_member(project_id));

-- Notizen: lesen für Verwalter und Mitglieder; einfügen nur als
-- man selbst; kein UPDATE/DELETE — der Verlauf ist unveränderlich
DROP POLICY IF EXISTS "task_notes_select" ON public.task_notes;
CREATE POLICY "task_notes_select" ON public.task_notes
  FOR SELECT USING (public.is_project_manager() OR public.is_member_of_task(task_id));
DROP POLICY IF EXISTS "task_notes_insert" ON public.task_notes;
CREATE POLICY "task_notes_insert" ON public.task_notes
  FOR INSERT WITH CHECK (
    author_id = auth.uid()
    AND (public.is_project_manager() OR public.is_member_of_task(task_id))
  );

-- 12. HOST-ANTEIL — nicht mehr hier.
--
-- Die Profil-Sichtbarkeit (Projektverwalter sehen alle Profile,
-- Mitglieder die Profile ihrer Projektkollegen) greift in die
-- `profiles`-Policies der Gastgeber-App ein. Sie benutzt zwar die
-- Modulfunktionen `is_project_manager()` und `shares_project_with()`,
-- gehört aber der App — jede hat dort ihre eigenen Policies.
--
-- Siehe `sql/host/`. NACH diesem Script laufen lassen, weil die
-- beiden Funktionen erst hier entstehen.
