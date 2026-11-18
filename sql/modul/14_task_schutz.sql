-- ============================================================
-- Migration: Aufgaben gegen stilles Aneignen schützen (Projekt-Mgt)
--
-- `tasks_update_member` prüfte im WITH CHECK nur
-- `is_project_member(project_id)`. Wer eine Aufgabe sehen durfte,
-- durfte damit per direktem PATCH auf die REST-Schnittstelle JEDE
-- Spalte auf JEDEN Wert setzen — die Oberfläche schickt `created_by`
-- nie mit, die Datenbank nahm es trotzdem an. Drei Wege führten
-- dazu, dass eine fremde Aufgabe für das ganze Team samt
-- Projektverwaltung verschwindet:
--
--   1. `created_by` überschreiben. Danach stand die Urheberschaft
--      auf der angreifenden Person, und die ursprüngliche
--      Erstellerin war keine Beteiligte mehr.
--   2. `vertraulich = true` setzen. Wer beteiligt ist (zuständig,
--      erstellt, Beobachter), bestimmte die angreifende Person mit
--      Schritt 1 selbst; das enge USING von `tasks_select_member`
--      wirkte danach gegen alle anderen.
--   3. `project_id` auf das eigene persönliche Projekt «Eigene
--      Tasks» stellen. Dort sieht niemand hinein — auch kein
--      Administrator (sql/modul/09) — und `tasks_delete_eigen`
--      erlaubt zusätzlich das Löschen. Das war der härteste der drei
--      Wege und im Befund nur als offene Frage vermerkt.
--
-- Dazu liess `task_watchers_delete_member` jedes Projektmitglied die
-- Beobachter jeder Aufgabe entfernen — auch einer Aufgabe, mit der
-- es nichts zu tun hat. Das war Schritt 0 des Angriffs und ist auch
-- ohne ihn eine Lücke: Kolleginnen still von den Mails einer Aufgabe
-- abschneiden.
--
-- NEU, drei Regeln:
--
--   • `created_by` ist für Angemeldete unveränderlich.
--   • Eine Aufgabe «abschirmen» — auf `vertraulich` stellen oder in
--     «Eigene Tasks» übernehmen — darf nur, wer an ihr schon
--     beteiligt ist oder das Projekt verwaltet
--     (`darf_task_abschirmen`).
--   • Beobachter entfernen darf nur, wer beteiligt ist oder das
--     Projekt verwaltet.
--
-- BEWUSST NICHT geändert:
--
--   • Die Zuständigkeit darf weiterhin jedes Projektmitglied
--     ändern — das ist tägliche Zusammenarbeit, nicht der Angriff.
--     Still ist es nicht mehr: `created_by` bleibt stehen, die
--     Beobachter bleiben stehen, und ohne «vertraulich» bleibt die
--     Aufgabe für das ganze Projekt sichtbar.
--   • Das Umhängen in ein anderes gewöhnliches Projekt bleibt jedem
--     Mitglied erlaubt. Dort ist die Aufgabe weiter sichtbar — für
--     die Mitglieder des Zielprojekts und für Administratoren —, und
--     `created_by` sagt, von wem sie stammt. «Eigene Tasks» ist der
--     Sonderfall, weil dort niemand hineinsieht.
--   • Die Projektverwaltung bekommt KEINEN Zugriff auf vertrauliche
--     Aufgaben, an denen sie nicht beteiligt ist. Das ist die
--     Zusage von sql/modul/13, und sie bleibt. Unerreichbar wird
--     dadurch nichts mehr: «vertraulich» kann nur noch setzen, wer
--     beteiligt ist, und wer eine Aufgabe erstellt hat, bleibt
--     beteiligt — die Vertraulichkeit also auch zurücknehmen.
--     Administratoren sehen wie bisher alles.
--
-- EINE EIGENHEIT, die beim Prüfen auffiel und hier festgehalten
-- gehört: «Vertraulich» einschalten kann auch die Projektverwaltung
-- nur, wenn sie an der Aufgabe beteiligt ist. Nicht wegen der neuen
-- Regel — Postgres prüft die SELECT-Policy beim UPDATE auch gegen
-- die NEUE Zeile, sobald die Anweisung Spalten der Tabelle liest.
-- Die Aufgabe wäre für die Verwaltung im selben Moment unsichtbar,
-- und die Datenbank lehnt die Änderung darum ab. Dasselbe gilt für
-- `kann_projekt_verwalten` in `darf_task_abschirmen`: dort wirkt es
-- beim Übernehmen nach «Eigene Tasks» (die Aufgabe bleibt sichtbar),
-- beim Einschalten von «vertraulich» nicht. Wer eine Aufgabe
-- erstellt hat oder sie führt, bleibt sichtbar — dort greift die
-- Regel wie beschrieben.
--
-- ACHTUNG: `src/mcp/guard.ts` bildet diese Regeln für den
-- Service-Role-Zugang im Code nach (`darfTaskAbschirmen`) — beide
-- Seiten gehören zusammen. Der Guard ist die einzige Prüfung, die
-- für MCP greift: dort gilt die RLS nicht.
--
-- Führe dieses Script im Supabase SQL Editor aus
-- (setzt sql/modul/01 bis 13 voraus). Mehrfaches Ausführen ist
-- ungefährlich.
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- 1. Darf diese Person die Aufgabe abschirmen?
--
-- «Abschirmen» heisst: die Aufgabe dem übrigen Projekt entziehen —
-- auf `vertraulich` stellen oder in «Eigene Tasks» übernehmen. Die
-- Antwort ist dieselbe Bedingung an zwei Stellen (Policy und
-- Trigger), deshalb steht sie genau einmal hier.
--
-- `ist_task_beteiligt()` liest den GESPEICHERTEN Stand (sql/modul/13)
-- — genau das ist hier gewollt: Wer beteiligt ist, entscheidet die
-- Zeile vor der Änderung, nicht die Werte, die der Aufruf mitbringt.
-- Sonst genügte ein `assignee_id = <ich>` im selben PATCH.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.darf_task_abschirmen(p_task_id UUID, p_project_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
  SELECT public.ist_task_beteiligt(p_task_id)
      OR public.kann_projekt_verwalten(p_project_id);
$$;

COMMENT ON FUNCTION public.darf_task_abschirmen(UUID, UUID) IS
  'true = darf die Aufgabe dem uebrigen Projekt entziehen (vertraulich '
  'setzen, in «Eigene Tasks» uebernehmen, Beobachter entfernen): wer an '
  'ihr beteiligt ist oder das Projekt verwaltet. Liest den gespeicherten '
  'Stand der Zeile, nicht die Werte der laufenden Aenderung.';

REVOKE ALL ON FUNCTION public.darf_task_abschirmen(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.darf_task_abschirmen(UUID, UUID) TO authenticated, service_role;

-- Dasselbe für eine Aufgabe, von der nur die ID bekannt ist — die
-- Policy auf `task_watchers` hat kein `project_id` zur Hand. Der
-- Umweg über eine SECURITY-DEFINER-Funktion ist nötig, weil eine
-- Unterabfrage auf `tasks` in der Policy unter der RLS der
-- handelnden Person stünde.
CREATE OR REPLACE FUNCTION public.darf_task_beteiligte_aendern(p_task_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tasks t
    WHERE t.id = p_task_id
      AND public.darf_task_abschirmen(t.id, t.project_id)
  );
$$;

COMMENT ON FUNCTION public.darf_task_beteiligte_aendern(UUID) IS
  'true = darf den Kreis der Beteiligten dieser Aufgabe aendern '
  '(Beobachter entfernen): wer beteiligt ist oder das Projekt verwaltet.';

REVOKE ALL ON FUNCTION public.darf_task_beteiligte_aendern(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.darf_task_beteiligte_aendern(UUID) TO authenticated, service_role;


-- ════════════════════════════════════════════════════════════
-- 2. Trigger: Urheberschaft und «Eigene Tasks»
--
-- Zwei Regeln, die eine Policy nicht ausdrücken kann: Ein WITH CHECK
-- sieht nur die neue Zeile und kann sie nicht mit der alten
-- vergleichen.
--
-- Der Schutz greift nur für Angemeldete (`auth.uid() IS NOT NULL`).
-- Mit dem Service-Role-Schlüssel und im SQL-Editor greift er
-- bewusst nicht — genauso wie der Privilegien-Schutz auf `profiles`
-- (sql/host/). Sonst könnten die Trigger des Moduls selbst
-- (`tasks_vertraulich_weitergeben`), der Jira-Spiegel und die
-- Benutzerverwaltung nicht mehr arbeiten. Für den MCP-Zugang, der
-- mit Service Role läuft, prüft `src/mcp/guard.ts`.
--
-- Der Name beginnt mit «tasks_s…»: Postgres feuert BEFORE-Trigger in
-- alphabetischer Reihenfolge. Damit läuft dieser Trigger vor
-- `tasks_vertraulich_erben` und sieht `vertraulich` so, wie der
-- Aufruf es mitbringt — die Vererbung vom Mutter-Task bleibt
-- unangetastet (sie gehört nicht der handelnden Person, sondern dem
-- Mutter-Task).
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.task_update_schutz()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Urheberschaft ist unveränderlich. Die Oberfläche und die
  -- Fachlogik schicken `created_by` bei einer Änderung nie mit —
  -- wer es doch tut, will die Spur verwischen.
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Wer eine Aufgabe erstellt hat, lässt sich nachträglich nicht ändern.';
  END IF;

  -- In «Eigene Tasks» übernehmen entzieht die Aufgabe allen anderen,
  -- auch den Administratoren. Nur für Beteiligte und die
  -- Projektverwaltung.
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     AND public.ist_persoenliches_projekt(NEW.project_id)
     AND NOT public.darf_task_abschirmen(OLD.id, OLD.project_id) THEN
    RAISE EXCEPTION 'Nur Beteiligte oder die Projektverwaltung können eine Aufgabe nach «Eigene Tasks» übernehmen.';
  END IF;

  -- «Vertraulich» einschalten blendet die Aufgabe für das übrige
  -- Projekt aus. Dieselbe Regel steht im WITH CHECK von
  -- `tasks_update_member` (Abschnitt 4) — hier steht sie für die
  -- deutsche Begründung, die bis in die Oberfläche durchreicht.
  IF NEW.vertraulich AND NOT OLD.vertraulich
     AND NOT public.darf_task_abschirmen(OLD.id, OLD.project_id) THEN
    RAISE EXCEPTION 'Nur Beteiligte oder die Projektverwaltung können eine Aufgabe auf «vertraulich» stellen.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.task_update_schutz() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tasks_schutz ON public.tasks;
CREATE TRIGGER tasks_schutz
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.task_update_schutz();


-- ════════════════════════════════════════════════════════════
-- 3. Beobachter beim Umhängen aufräumen
--
-- Ein Beobachter muss Mitglied des Projekts sein (Trigger
-- `task_watchers_is_member`, sql/modul/02). Beim Umhängen in ein
-- anderes Projekt räumte das bisher `updateTask` mit dem Client der
-- handelnden Person auf. Mit der strengeren DELETE-Policy aus
-- Abschnitt 4 könnte dieses Aufräumen stillschweigend misslingen —
-- und ein Beobachter zurückbleiben, der im Zielprojekt nichts
-- verloren hat. Deshalb liegt die Aufräumung jetzt in der Datenbank,
-- wie die der Tag-Zuordnungen (`tasks_tags_firma_sync`,
-- sql/modul/07): als Eigentümer, immer, unabhängig davon, wer
-- umhängt.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.sync_task_beobachter_projekt()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  DELETE FROM public.task_watchers w
  WHERE w.task_id = NEW.id
    AND NOT EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = NEW.project_id
        AND pm.profile_id = w.profile_id
    );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_task_beobachter_projekt() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tasks_beobachter_projekt_sync ON public.tasks;
CREATE TRIGGER tasks_beobachter_projekt_sync
  AFTER UPDATE OF project_id ON public.tasks
  FOR EACH ROW WHEN (NEW.project_id IS DISTINCT FROM OLD.project_id)
  EXECUTE FUNCTION public.sync_task_beobachter_projekt();


-- ════════════════════════════════════════════════════════════
-- 4. Policies
--
-- `tasks_update_member`: Das USING bleibt wortgleich wie in
-- sql/modul/13. Das WITH CHECK bekommt die Bedingung, die ihm
-- fehlte: Eine Zeile darf nach der Änderung nur dann vertraulich
-- sein, wenn die handelnde Person sie abschirmen darf.
--
-- Für eine Zeile, die schon vertraulich IST, ändert das nichts: wer
-- das USING passiert, ist beteiligt (`ist_task_beteiligt()` liest
-- genau die Spalten, die das USING einzeln prüft). Die Bedingung
-- greift beim Einschalten — und beim Einhängen einer fremden Aufgabe
-- unter einen vertraulichen Mutter-Task, wo der Erb-Trigger
-- `vertraulich` setzt.
--
-- `task_watchers_delete_member`: zusätzlich zur Mitgliedschaft die
-- Beteiligung. `is_member_of_task()` bleibt vorangestellt — ohne
-- Lesezugriff auf die Aufgabe wird kein Beobachter entfernt.
-- Administratoren und das Entfernen durch die Fachlogik bleiben über
-- `task_watchers_all_admin` bzw. Abschnitt 3 unberührt.
-- ════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "tasks_update_member" ON public.tasks;
CREATE POLICY "tasks_update_member" ON public.tasks
  FOR UPDATE USING (
    public.is_project_member(project_id)
    AND (NOT vertraulich
         OR assignee_id = (SELECT auth.uid())
         OR created_by = (SELECT auth.uid())
         OR public.ist_task_beteiligt(id))
  )
  WITH CHECK (
    public.is_project_member(project_id)
    AND (NOT vertraulich OR public.darf_task_abschirmen(id, project_id))
  );

DROP POLICY IF EXISTS "task_watchers_delete_member" ON public.task_watchers;
CREATE POLICY "task_watchers_delete_member" ON public.task_watchers
  FOR DELETE USING (
    public.is_member_of_task(task_id)
    AND public.darf_task_beteiligte_aendern(task_id)
  );


-- ── Verifikation (rein lesend) ──────────────────────────────────────────────
-- Erwartet: in der Spalte «muss» steht überall dasselbe wie in «ist».
SELECT 'anon darf darf_task_abschirmen ausfuehren (muss false sein)' AS pruefung,
       has_function_privilege('anon', 'public.darf_task_abschirmen(uuid,uuid)', 'EXECUTE')::text AS ist, 'false' AS muss
UNION ALL
SELECT 'anon darf darf_task_beteiligte_aendern ausfuehren (muss false sein)',
       has_function_privilege('anon', 'public.darf_task_beteiligte_aendern(uuid)', 'EXECUTE')::text, 'false'
UNION ALL
SELECT 'authenticated darf darf_task_abschirmen ausfuehren (muss true sein)',
       has_function_privilege('authenticated', 'public.darf_task_abschirmen(uuid,uuid)', 'EXECUTE')::text, 'true'
UNION ALL
SELECT 'authenticated darf darf_task_beteiligte_aendern ausfuehren (muss true sein)',
       has_function_privilege('authenticated', 'public.darf_task_beteiligte_aendern(uuid)', 'EXECUTE')::text, 'true'
UNION ALL
SELECT 'authenticated darf die Trigger-Funktionen NICHT ausfuehren (muss ff sein)',
       left(has_function_privilege('authenticated', 'public.task_update_schutz()', 'EXECUTE')::text, 1)
         || left(has_function_privilege('authenticated', 'public.sync_task_beobachter_projekt()', 'EXECUTE')::text, 1), 'ff'
UNION ALL
SELECT 'Trigger tasks_schutz vorhanden (muss 1 sein)',
       count(*)::text, '1'
  FROM pg_trigger WHERE tgrelid = 'public.tasks'::regclass AND tgname = 'tasks_schutz'
UNION ALL
SELECT 'Trigger tasks_beobachter_projekt_sync vorhanden (muss 1 sein)',
       count(*)::text, '1'
  FROM pg_trigger WHERE tgrelid = 'public.tasks'::regclass AND tgname = 'tasks_beobachter_projekt_sync'
UNION ALL
SELECT 'WITH CHECK von tasks_update_member prueft das Abschirmen (muss 1 sein)',
       count(*)::text, '1'
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'tasks' AND policyname = 'tasks_update_member'
   AND with_check LIKE '%darf_task_abschirmen%'
UNION ALL
SELECT 'DELETE-Policy der Beobachter prueft die Beteiligung (muss 1 sein)',
       count(*)::text, '1'
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'task_watchers' AND policyname = 'task_watchers_delete_member'
   AND qual LIKE '%darf_task_beteiligte_aendern%';
