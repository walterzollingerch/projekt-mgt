-- ============================================================
-- Migration: Vertrauliche Aufgaben (Projekt-Mgt)
--
-- Eine Aufgabe kann auf «vertraulich» gestellt werden. Ab dann sehen
-- sie — samt Titel, Beschreibung, Notizen, Anhängen, Tags und
-- Beobachtern — nur noch die Beteiligten:
--
--   • die zuständige Person
--   • die Person, die sie erstellt hat
--   • die Beobachter (wer bei neuen Notizen informiert wird)
--
-- Alle drei müssen weiterhin Mitglied des Projekts sein. Übrige
-- Projektmitglieder und Projektverwalter sehen die Aufgabe gar nicht.
-- Administratoren sehen wie bisher alles (`tasks_all_admin`), mit
-- Ausnahme der persönlichen Projekte anderer (sql/modul/09).
--
-- Unter-Aufgaben folgen ihrem Mutter-Task: Sie sind vertraulich, wenn
-- er es ist, und wer am Mutter-Task beteiligt ist, sieht auch seine
-- Unter-Aufgaben. Ein Trigger erzwingt das, nicht die Oberfläche.
--
-- Umgesetzt an zwei Stellen:
--   1. `tasks_select_member` / `tasks_update_member` prüfen die
--      Beteiligung.
--   2. `is_member_of_task()` prüft sie ebenfalls. Darauf bauen die
--      Policies von Notizen, Beobachtern, Tag-Zuordnungen und
--      Storage-Anhängen auf — sie folgen damit ohne eigene Änderung.
--
-- Im TT Portal liegt dieselbe Datei als
-- `supabase/migrations/20261021143009_projekt_mgt_vertrauliche_tasks.sql`
-- und geht mit `supabase db push` in die Produktion. In Terramay im
-- SQL Editor ausführen, BEVOR die App auf die Modulversion mit
-- `tasks.vertraulich` wechselt (setzt sql/modul/01 bis 12 voraus).
--
-- ACHTUNG: `src/mcp/guard.ts` bildet diese Regel für den
-- Service-Role-Zugang im Code nach — beide Seiten gehören zusammen.
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- 1. Spalte
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS vertraulich BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tasks.vertraulich IS
  'true = nur fuer Beteiligte sichtbar (zustaendig, erstellt, Beobachter; '
  'bei Unter-Aufgaben auch die des Mutter-Tasks) und fuer Administratoren. '
  'Unter-Aufgaben folgen dem Mutter-Task (Trigger tasks_vertraulich_erben).';


-- ════════════════════════════════════════════════════════════
-- 2. Beteiligung
--
-- SECURITY DEFINER, damit die Policies nicht rekursiv auf `tasks`
-- und `task_watchers` zugreifen — dieselbe Bauweise wie
-- is_member_of_task().
--
-- Die Funktion liest den gespeicherten Stand. In einem UPDATE sieht
-- sie deshalb den Stand VOR der Änderung: wer eine vertrauliche
-- Aufgabe an jemand anderen abgibt, darf das noch tun, sieht sie
-- danach aber nicht mehr. Für ein INSERT findet sie die neue Zeile
-- nicht — dort prüfen die Policies `created_by` / `assignee_id`
-- direkt auf der Zeile.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.ist_task_beteiligt(p_task_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.tasks t
    WHERE t.id IN (
            p_task_id,
            (SELECT k.parent_task_id FROM public.tasks k WHERE k.id = p_task_id)
          )
      AND (t.assignee_id = auth.uid()
           OR t.created_by = auth.uid()
           OR EXISTS (
                SELECT 1 FROM public.task_watchers w
                WHERE w.task_id = t.id AND w.profile_id = auth.uid()
              ))
  );
$$;

REVOKE ALL ON FUNCTION public.ist_task_beteiligt(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ist_task_beteiligt(UUID) TO authenticated, service_role;

-- Bisher: «Mitglied des Projekts dieser Aufgabe». Neu zusätzlich:
-- bei einer vertraulichen Aufgabe nur, wer beteiligt ist. Der Join
-- auf profiles (gesperrt wirkt überall) stammt aus
-- security_10_gesperrt_wirkt_ueberall.sql des Portals und bleibt.
CREATE OR REPLACE FUNCTION public.is_member_of_task(p_task_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.tasks t
    JOIN public.project_members pm ON pm.project_id = t.project_id
    JOIN public.profiles p        ON p.id = pm.profile_id
    WHERE t.id = p_task_id
      AND pm.profile_id = auth.uid()
      AND NOT p.is_blocked
      AND (NOT t.vertraulich OR public.ist_task_beteiligt(t.id))
  );
$$;

REVOKE ALL ON FUNCTION public.is_member_of_task(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_member_of_task(UUID) TO authenticated, service_role;


-- ════════════════════════════════════════════════════════════
-- 3. Unter-Aufgaben folgen dem Mutter-Task
-- ════════════════════════════════════════════════════════════

-- Beim Anlegen, Einhängen und Umstellen: eine Unter-Aufgabe übernimmt
-- den Wert ihres Mutter-Tasks — einzeln umstellen lässt sie sich nicht
CREATE OR REPLACE FUNCTION public.task_vertraulich_erben()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT vertraulich INTO NEW.vertraulich FROM public.tasks WHERE id = NEW.parent_task_id;
    NEW.vertraulich := COALESCE(NEW.vertraulich, false);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.task_vertraulich_erben() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tasks_vertraulich_erben ON public.tasks;
CREATE TRIGGER tasks_vertraulich_erben
  BEFORE INSERT OR UPDATE OF vertraulich, parent_task_id ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.task_vertraulich_erben();

-- Mutter-Task umgestellt: Unter-Aufgaben ziehen nach. Läuft als
-- Eigentümer, weil die handelnde Person nicht jede Unter-Aufgabe
-- sehen muss (z. B. eine, an der sie nur über den Mutter-Task
-- beteiligt ist, nachdem sie die Zuständigkeit abgegeben hat).
CREATE OR REPLACE FUNCTION public.task_vertraulich_weitergeben()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.parent_task_id IS NULL AND NEW.vertraulich IS DISTINCT FROM OLD.vertraulich THEN
    UPDATE public.tasks
       SET vertraulich = NEW.vertraulich
     WHERE parent_task_id = NEW.id
       AND vertraulich IS DISTINCT FROM NEW.vertraulich;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.task_vertraulich_weitergeben() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tasks_vertraulich_weitergeben ON public.tasks;
CREATE TRIGGER tasks_vertraulich_weitergeben
  AFTER UPDATE OF vertraulich ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.task_vertraulich_weitergeben();


-- ════════════════════════════════════════════════════════════
-- 4. Sichtbarkeit der Aufgaben selbst
--
-- `tasks_all_admin` (Administratoren, ausser persönlichen Projekten
-- anderer) bleibt unverändert — ein Admin sieht immer alles.
-- `tasks_insert_member` bleibt ebenfalls: anlegen darf jedes Mitglied,
-- und wer anlegt, ist als Ersteller beteiligt.
-- Löschen (`tasks_delete_verwalter`) braucht zusätzlich Lesezugriff
-- auf die Zeile und greift deshalb nicht bei vertraulichen Aufgaben,
-- an denen der Verwalter nicht beteiligt ist.
-- ════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "tasks_select_member" ON public.tasks;
CREATE POLICY "tasks_select_member" ON public.tasks
  FOR SELECT USING (
    public.is_project_member(project_id)
    AND (NOT vertraulich
         OR assignee_id = (SELECT auth.uid())
         OR created_by = (SELECT auth.uid())
         OR public.ist_task_beteiligt(id))
  );

DROP POLICY IF EXISTS "tasks_update_member" ON public.tasks;
CREATE POLICY "tasks_update_member" ON public.tasks
  FOR UPDATE USING (
    public.is_project_member(project_id)
    AND (NOT vertraulich
         OR assignee_id = (SELECT auth.uid())
         OR created_by = (SELECT auth.uid())
         OR public.ist_task_beteiligt(id))
  )
  WITH CHECK (public.is_project_member(project_id));


-- ── Verifikation (rein lesend) ──────────────────────────────────────────────
-- Erwartet: in der Spalte «muss» steht überall dasselbe wie in «ist».
SELECT 'anon darf ist_task_beteiligt ausfuehren (muss false sein)' AS pruefung,
       has_function_privilege('anon', 'public.ist_task_beteiligt(uuid)', 'EXECUTE')::text AS ist, 'false' AS muss
UNION ALL
SELECT 'anon darf is_member_of_task ausfuehren (muss false sein)',
       has_function_privilege('anon', 'public.is_member_of_task(uuid)', 'EXECUTE')::text, 'false'
UNION ALL
SELECT 'authenticated darf ist_task_beteiligt ausfuehren (muss true sein)',
       has_function_privilege('authenticated', 'public.ist_task_beteiligt(uuid)', 'EXECUTE')::text, 'true'
UNION ALL
SELECT 'authenticated darf is_member_of_task ausfuehren (muss true sein)',
       has_function_privilege('authenticated', 'public.is_member_of_task(uuid)', 'EXECUTE')::text, 'true'
UNION ALL
SELECT 'authenticated darf Trigger-Funktion ausfuehren (muss false sein)',
       has_function_privilege('authenticated', 'public.task_vertraulich_erben()', 'EXECUTE')::text, 'false'
UNION ALL
SELECT 'Spalte tasks.vertraulich vorhanden (muss 1 sein)',
       count(*)::text, '1'
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'vertraulich';
