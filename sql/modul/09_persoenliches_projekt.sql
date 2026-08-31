-- ============================================================
-- Migration: Persönliches Projekt «Eigene Tasks» (Projekt-Mgt)
--
-- Jede Person, die das Modul benutzen darf, bekommt genau einen
-- Ort, an dem sie Aufgaben für sich selbst führt. Technisch ist das
-- ein gewöhnliches Projekt mit der Markierung `persoenlich_fuer` —
-- deshalb erscheint es ohne weiteres Zutun überall dort, wo Projekte
-- schon vorkommen: in der Übersicht, in der Fälligkeitsliste, in der
-- Suche und über MCP.
--
-- Drei Eigenschaften unterscheiden es von einem normalen Projekt:
--
--   1. Es gehört zu KEINER Firma (`company_id IS NULL`). Eine Person
--      ist nicht die Firma, für die sie arbeitet, und in Terramay
--      gibt es die Zuordnung gar nicht. Folge: dort gibt es auch
--      keine Tags — die gehören zur Firma.
--   2. Es hat genau ein Mitglied, und jede Aufgabe darin ist dieser
--      Person zugewiesen. Beides erzwingen Trigger, nicht die
--      Oberfläche.
--   3. Es ist privat. Auch Administratoren sehen weder das Projekt
--      noch seine Aufgaben, Notizen oder Anhänge. Dafür wird jede
--      Admin-Blankopolicy des Moduls um «ausser persönlichen
--      Projekten» ergänzt.
--
-- Führe dieses Script im Supabase SQL Editor aus
-- (setzt sql/modul/01 bis 08 voraus).
-- ACHTUNG: `src/mcp/guard.ts` bildet diese Policies für den
-- Service-Role-Zugang im Code nach — beide Seiten gehören zusammen.
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- 1. Spalte und Firmenzuordnung
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS persoenlich_fuer UUID REFERENCES public.profiles(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.projects.persoenlich_fuer IS
  'Gesetzt = persoenliches Projekt dieser Person («Eigene Tasks»). '
  'Genau ein Mitglied, alle Aufgaben ihr zugewiesen, fuer alle '
  'anderen unsichtbar — auch fuer Administratoren.';

-- Höchstens ein persönliches Projekt pro Person
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_persoenlich_fuer
  ON public.projects(persoenlich_fuer) WHERE persoenlich_fuer IS NOT NULL;

-- Ein persönliches Projekt gehört zu keiner Firma; jedes andere
-- Projekt braucht weiterhin eine.
ALTER TABLE public.projects ALTER COLUMN company_id DROP NOT NULL;

ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_firma_oder_persoenlich;
ALTER TABLE public.projects ADD CONSTRAINT projects_firma_oder_persoenlich
  CHECK ((company_id IS NOT NULL AND persoenlich_fuer IS NULL)
      OR (company_id IS NULL     AND persoenlich_fuer IS NOT NULL));


-- ════════════════════════════════════════════════════════════
-- 2. Hilfsfunktionen
--
-- SECURITY DEFINER, damit die Policies unten nicht rekursiv auf
-- `projects` zugreifen — dieselbe Bauweise wie is_project_member().
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.ist_persoenliches_projekt(p_project_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects
    WHERE id = p_project_id AND persoenlich_fuer IS NOT NULL
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.ist_persoenlicher_task(p_task_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.tasks t
    JOIN public.projects p ON p.id = t.project_id
    WHERE t.id = p_task_id AND p.persoenlich_fuer IS NOT NULL
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Ein persönliches Projekt verwaltet niemand — es wird weder
-- umbenannt noch archiviert, gelöscht oder um Mitglieder ergänzt.
-- Es verschwindet mit dem Profil (ON DELETE CASCADE).
CREATE OR REPLACE FUNCTION public.kann_projekt_verwalten(p_project_id UUID)
RETURNS BOOLEAN AS $$
  SELECT NOT public.ist_persoenliches_projekt(p_project_id)
     AND (public.is_project_admin()
          OR (public.is_project_manager() AND (
                public.is_project_member(p_project_id)
                OR EXISTS (
                  SELECT 1 FROM public.projects
                  WHERE id = p_project_id AND created_by = auth.uid()
                ))));
$$ LANGUAGE sql SECURITY DEFINER STABLE;


-- ════════════════════════════════════════════════════════════
-- 3. Anlegen
--
-- Zwei Funktionen mit Absicht: die innere legt für eine beliebige
-- Person an (Nachführ-Trigger, Erstbefüllung), die äussere kann nur
-- die angemeldete Person für sich selbst aufrufen.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.persoenliches_projekt_anlegen(p_profile_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_id UUID;
BEGIN
  SELECT id INTO v_id FROM public.projects WHERE persoenlich_fuer = p_profile_id;

  IF v_id IS NULL THEN
    BEGIN
      INSERT INTO public.projects (company_id, name, status, created_by, persoenlich_fuer)
      VALUES (NULL, 'Eigene Tasks', 'aktiv', p_profile_id, p_profile_id)
      RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      -- Zwei gleichzeitige Anmeldungen derselben Person
      SELECT id INTO v_id FROM public.projects WHERE persoenlich_fuer = p_profile_id;
    END;
  END IF;

  INSERT INTO public.project_members (project_id, profile_id, added_by)
  VALUES (v_id, p_profile_id, p_profile_id)
  ON CONFLICT (project_id, profile_id) DO NOTHING;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.persoenliches_projekt_anlegen(UUID) FROM PUBLIC, anon, authenticated;

-- Für die Oberfläche: legt das eigene persönliche Projekt an, falls
-- es fehlt, und liefert seine ID. Idempotent.
CREATE OR REPLACE FUNCTION public.persoenliches_projekt_sichern()
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_profil UUID := auth.uid();
BEGIN
  IF v_profil IS NULL THEN
    RAISE EXCEPTION 'Nicht angemeldet';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_profil AND NOT is_blocked
      AND (role = 'admin' OR can_use_projects OR can_manage_projects)
  ) THEN
    RAISE EXCEPTION 'Kein Zugang zum Projekt-Mgt';
  END IF;
  RETURN public.persoenliches_projekt_anlegen(v_profil);
END;
$$;

REVOKE ALL ON FUNCTION public.persoenliches_projekt_sichern() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.persoenliches_projekt_sichern() TO authenticated, service_role;


-- ════════════════════════════════════════════════════════════
-- 4. Nachführen
--
-- Der Trigger sitzt auf `profiles` — einer Tabelle der Gastgeber-App.
-- Er liest sie nur und schreibt ausschliesslich in Tabellen des
-- Moduls; die Rechte-Spalten selbst gehören weiterhin dem Host
-- (siehe sql/host/).
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.persoenliches_projekt_nachfuehren()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NOT NEW.is_blocked
     AND (NEW.role = 'admin' OR NEW.can_use_projects OR NEW.can_manage_projects) THEN
    PERFORM public.persoenliches_projekt_anlegen(NEW.id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS profiles_persoenliches_projekt ON public.profiles;
CREATE TRIGGER profiles_persoenliches_projekt
  AFTER INSERT OR UPDATE OF role, is_blocked, can_use_projects, can_manage_projects
  ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.persoenliches_projekt_nachfuehren();

-- Erstbefüllung für alle, die das Modul heute schon benutzen dürfen
DO $erstbefuellung$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT id FROM public.profiles
    WHERE NOT is_blocked
      AND (role = 'admin' OR can_use_projects OR can_manage_projects)
  LOOP
    PERFORM public.persoenliches_projekt_anlegen(r.id);
  END LOOP;
END
$erstbefuellung$;


-- ════════════════════════════════════════════════════════════
-- 5. Trigger: genau ein Mitglied, alles selbst zugewiesen
-- ════════════════════════════════════════════════════════════

-- Aufgaben im persönlichen Projekt gehören immer der Person selbst.
-- Gesetzt statt abgelehnt: wer eine Aufgabe dorthin umhängt, meint
-- «das mache ich selbst», und soll dafür nicht zwei Schritte
-- brauchen.
--
-- Der Triggername beginnt bewusst mit «tasks_assignee_e…»: Postgres
-- feuert BEFORE-Trigger in alphabetischer Reihenfolge, und die
-- Zuweisung muss vor der Mitgliedschaftsprüfung
-- (`tasks_assignee_is_member`) stehen.
CREATE OR REPLACE FUNCTION public.eigener_task_zuweisung()
RETURNS TRIGGER AS $$
DECLARE
  v_owner UUID;
BEGIN
  SELECT persoenlich_fuer INTO v_owner FROM public.projects WHERE id = NEW.project_id;
  IF v_owner IS NOT NULL THEN
    NEW.assignee_id := v_owner;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tasks_assignee_eigen ON public.tasks;
CREATE TRIGGER tasks_assignee_eigen
  BEFORE INSERT OR UPDATE OF assignee_id, project_id ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.eigener_task_zuweisung();

-- Ein persönliches Projekt hat genau ein Mitglied
CREATE OR REPLACE FUNCTION public.eigenes_projekt_mitglied()
RETURNS TRIGGER AS $$
DECLARE
  v_owner UUID;
BEGIN
  SELECT persoenlich_fuer INTO v_owner FROM public.projects WHERE id = NEW.project_id;
  IF v_owner IS NOT NULL AND NEW.profile_id <> v_owner THEN
    RAISE EXCEPTION 'Das persönliche Projekt «Eigene Tasks» hat genau ein Mitglied — die Person selbst.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS project_members_eigen ON public.project_members;
CREATE TRIGGER project_members_eigen
  BEFORE INSERT OR UPDATE ON public.project_members
  FOR EACH ROW EXECUTE FUNCTION public.eigenes_projekt_mitglied();

-- Die Markierung selbst ist unveränderlich: ein persönliches Projekt
-- wird nie ein gewöhnliches und umgekehrt.
CREATE OR REPLACE FUNCTION public.persoenliches_projekt_schuetzen()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.persoenlich_fuer IS DISTINCT FROM OLD.persoenlich_fuer THEN
    RAISE EXCEPTION 'Die persönliche Zuordnung eines Projekts kann nicht geändert werden.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS projects_persoenlich_unveraenderlich ON public.projects;
CREATE TRIGGER projects_persoenlich_unveraenderlich
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.persoenliches_projekt_schuetzen();


-- ════════════════════════════════════════════════════════════
-- 6. Tags: im persönlichen Projekt gibt es keine
--
-- Beide Funktionen stammen aus modul/07 und verglichen dort zwei
-- Firmen-IDs. Ist eine davon NULL, ist das Ergebnis in SQL nicht
-- FALSE, sondern NULL — die Prüfung liefe ins Leere und die
-- Aufräumung täte nichts. Deshalb hier neu gefasst.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.ensure_task_tag_firma()
RETURNS TRIGGER AS $$
DECLARE
  tag_firma UUID;
  task_firma UUID;
  task_persoenlich UUID;
BEGIN
  SELECT company_id INTO tag_firma FROM public.task_tags WHERE id = NEW.tag_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tag nicht gefunden';
  END IF;

  SELECT p.company_id, p.persoenlich_fuer INTO task_firma, task_persoenlich
  FROM public.tasks t
  JOIN public.projects p ON p.id = t.project_id
  WHERE t.id = NEW.task_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Aufgabe nicht gefunden';
  END IF;

  IF task_persoenlich IS NOT NULL THEN
    RAISE EXCEPTION 'Tags gehören zu einer Firma — im persönlichen Projekt «Eigene Tasks» gibt es keine.';
  END IF;

  IF tag_firma <> task_firma THEN
    RAISE EXCEPTION 'Der Tag gehört zu einer anderen Firma als die Aufgabe';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Umhängen: firmenfremde Tags fallen weg — beim Umhängen ins
-- persönliche Projekt alle.
CREATE OR REPLACE FUNCTION public.sync_task_tags_firma()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM public.task_tag_zuordnungen z
  USING public.task_tags g, public.projects p
  WHERE z.task_id = NEW.id
    AND z.tag_id = g.id
    AND p.id = NEW.project_id
    AND (p.company_id IS NULL OR g.company_id <> p.company_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ════════════════════════════════════════════════════════════
-- 7. Sichtbarkeit: privat heisst privat
--
-- Jede Blankopolicy für Administratoren wird um «ausser
-- persönlichen Projekten» ergänzt. Die Mitglieder-Policies bleiben
-- unverändert — das eine Mitglied ist die Person selbst.
-- ════════════════════════════════════════════════════════════

-- Projekte
DROP POLICY IF EXISTS "projects_all_admin" ON public.projects;
CREATE POLICY "projects_all_admin" ON public.projects
  FOR ALL USING (public.is_project_admin() AND persoenlich_fuer IS NULL)
  WITH CHECK (public.is_project_admin() AND persoenlich_fuer IS NULL);

-- Ein persönliches Projekt entsteht ausschliesslich über
-- persoenliches_projekt_sichern(), nie über ein gewöhnliches INSERT
DROP POLICY IF EXISTS "projects_insert_manager" ON public.projects;
CREATE POLICY "projects_insert_manager" ON public.projects
  FOR INSERT WITH CHECK (
    public.is_project_manager() AND created_by = auth.uid() AND persoenlich_fuer IS NULL
  );

-- Mitglieder
DROP POLICY IF EXISTS "project_members_all_admin" ON public.project_members;
CREATE POLICY "project_members_all_admin" ON public.project_members
  FOR ALL USING (public.is_project_admin() AND NOT public.ist_persoenliches_projekt(project_id))
  WITH CHECK (public.is_project_admin() AND NOT public.ist_persoenliches_projekt(project_id));

-- Aufgaben
DROP POLICY IF EXISTS "tasks_all_admin" ON public.tasks;
CREATE POLICY "tasks_all_admin" ON public.tasks
  FOR ALL USING (public.is_project_admin() AND NOT public.ist_persoenliches_projekt(project_id))
  WITH CHECK (public.is_project_admin() AND NOT public.ist_persoenliches_projekt(project_id));

-- Löschen: sonst nur Projektverwalter — im eigenen Projekt die
-- Person selbst, denn dort gibt es keinen Verwalter
DROP POLICY IF EXISTS "tasks_delete_eigen" ON public.tasks;
CREATE POLICY "tasks_delete_eigen" ON public.tasks
  FOR DELETE USING (
    public.ist_persoenliches_projekt(project_id) AND public.is_project_member(project_id)
  );

-- Ordner
DROP POLICY IF EXISTS "project_folders_all_admin" ON public.project_folders;
CREATE POLICY "project_folders_all_admin" ON public.project_folders
  FOR ALL USING (public.is_project_admin() AND NOT public.ist_persoenliches_projekt(project_id))
  WITH CHECK (public.is_project_admin() AND NOT public.ist_persoenliches_projekt(project_id));

-- Tag-Zuordnungen (Tags selbst gehören zur Firma und sind nie
-- persönlich)
DROP POLICY IF EXISTS "task_tag_zuordnungen_all_admin" ON public.task_tag_zuordnungen;
CREATE POLICY "task_tag_zuordnungen_all_admin" ON public.task_tag_zuordnungen
  FOR ALL USING (public.is_project_admin() AND NOT public.ist_persoenlicher_task(task_id))
  WITH CHECK (public.is_project_admin() AND NOT public.ist_persoenlicher_task(task_id));

-- Notizen
DROP POLICY IF EXISTS "task_notes_select" ON public.task_notes;
CREATE POLICY "task_notes_select" ON public.task_notes
  FOR SELECT USING (
    (public.is_project_admin() AND NOT public.ist_persoenlicher_task(task_id))
    OR public.is_member_of_task(task_id)
  );
DROP POLICY IF EXISTS "task_notes_insert" ON public.task_notes;
CREATE POLICY "task_notes_insert" ON public.task_notes
  FOR INSERT WITH CHECK (
    author_id = auth.uid()
    AND ((public.is_project_admin() AND NOT public.ist_persoenlicher_task(task_id))
         OR public.is_member_of_task(task_id))
  );

-- Beobachter
DROP POLICY IF EXISTS "task_watchers_all_admin" ON public.task_watchers;
CREATE POLICY "task_watchers_all_admin" ON public.task_watchers
  FOR ALL USING (public.is_project_admin() AND NOT public.ist_persoenlicher_task(task_id))
  WITH CHECK (public.is_project_admin() AND NOT public.ist_persoenlicher_task(task_id));

-- Anhänge im Storage (erster Pfadabschnitt ist die Task-ID)
DROP POLICY IF EXISTS "task_attachments_select" ON storage.objects;
CREATE POLICY "task_attachments_select" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'task-attachments'
    AND ((public.is_project_admin()
          AND NOT public.ist_persoenlicher_task(((storage.foldername(name))[1])::uuid))
         OR public.is_member_of_task(((storage.foldername(name))[1])::uuid))
  );
DROP POLICY IF EXISTS "task_attachments_insert" ON storage.objects;
CREATE POLICY "task_attachments_insert" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'task-attachments'
    AND ((public.is_project_admin()
          AND NOT public.ist_persoenlicher_task(((storage.foldername(name))[1])::uuid))
         OR public.is_member_of_task(((storage.foldername(name))[1])::uuid))
  );
