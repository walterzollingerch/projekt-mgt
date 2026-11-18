-- ============================================================
-- Angriff und Gegenproben zu sql/modul/14_task_schutz.sql
--
-- Spielt den Angriff aus der Portal-Aufgabe nach: Ein einfaches
-- Projektmitglied zieht eine fremde Aufgabe per direktem PATCH an
-- sich und macht sie für Team und Projektverwaltung unsichtbar.
-- Jeder Schritt steht mit seinem erwarteten Ergebnis da, dazu die
-- Gegenproben, dass die erlaubten Wege weiter gehen.
--
-- Läuft gegen eine leere Datenbank im Container
-- (`npm run rechte-pruefen`), nie gegen eine echte Umgebung.
--
-- Die Rollen:
--   A  greift an — Projektmitglied, an nichts beteiligt
--   B  erstellt und führt die Aufgaben
--   C  führt die Unter-Aufgabe
--   D  einfaches Mitglied, an nichts beteiligt
--   M  Projektverwalter, Mitglied und Beobachter von T1
--   X  Administrator, kein Mitglied
-- ============================================================

SET client_min_messages TO warning;

-- Bis zur Auswertung am Ende interessiert keine Zeile der Ausgabe
\o /dev/null

CREATE SCHEMA pruefung;
GRANT USAGE ON SCHEMA pruefung TO authenticated, service_role;

CREATE TABLE pruefung.ergebnis (
  nr       SERIAL PRIMARY KEY,
  pruefung TEXT,
  ist      TEXT,
  muss     TEXT
);

CREATE TABLE pruefung.wer (name TEXT PRIMARY KEY, id UUID NOT NULL);

-- Kurzname → ID, auch innerhalb der geprüften Anweisungen benutzbar
CREATE FUNCTION pruefung.p(p_name TEXT) RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pruefung', 'pg_temp' AS $$
  SELECT id FROM pruefung.wer WHERE name = p_name;
$$;
GRANT EXECUTE ON FUNCTION pruefung.p(TEXT) TO authenticated, service_role;

CREATE FUNCTION pruefung.fest(p_pruefung TEXT, p_ist TEXT, p_muss TEXT) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO pruefung.ergebnis (pruefung, ist, muss) VALUES (p_pruefung, p_ist, p_muss);
$$;

-- Eine Anweisung als angemeldete Person ausführen (Rolle
-- `authenticated`, Profil-ID in den JWT-Claims — wie ein Aufruf
-- über PostgREST). Liefert die Zahl der betroffenen Zeilen oder den
-- Fehlertext. «Fehler: RLS» steht für eine abgewiesene Zeile,
-- damit die Prüfung nicht an der Sprache der Postgres-Meldung hängt.
CREATE FUNCTION pruefung.als(p_profil UUID, p_sql TEXT) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE n BIGINT;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_profil)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  EXECUTE 'RESET ROLE';
  RETURN n || ' Zeilen';
EXCEPTION WHEN others THEN
  EXECUTE 'RESET ROLE';
  RETURN 'Fehler: ' || CASE
    WHEN SQLERRM LIKE '%row-level security%' THEN 'RLS'
    ELSE split_part(SQLERRM, E'\n', 1)
  END;
END
$$;

-- Dasselbe mit dem Service-Role-Schlüssel: keine JWT-Claims, also
-- `auth.uid() IS NULL`, und die RLS greift nicht (BYPASSRLS).
CREATE FUNCTION pruefung.als_service(p_sql TEXT) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE n BIGINT;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  EXECUTE 'RESET ROLE';
  RETURN n || ' Zeilen';
EXCEPTION WHEN others THEN
  EXECUTE 'RESET ROLE';
  RETURN 'Fehler: ' || split_part(SQLERRM, E'\n', 1);
END
$$;

-- Wie viele Zeilen sieht diese Person?
CREATE FUNCTION pruefung.sicht(p_profil UUID, p_sql TEXT) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE n BIGINT;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_profil)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  EXECUTE 'SELECT count(*) FROM (' || p_sql || ') q' INTO n;
  EXECUTE 'RESET ROLE';
  RETURN n::text;
END
$$;


-- ════════════════════════════════════════════════════════════
-- Ausgangslage (als Eigentümer angelegt, die RLS ist hier nicht
-- der Prüfgegenstand)
-- ════════════════════════════════════════════════════════════

INSERT INTO pruefung.wer (name, id) VALUES
  ('A',     '11111111-1111-4111-8111-111111111111'),
  ('B',     '22222222-2222-4222-8222-222222222222'),
  ('C',     '33333333-3333-4333-8333-333333333333'),
  ('D',     '44444444-4444-4444-8444-444444444444'),
  ('M',     '55555555-5555-4555-8555-555555555555'),
  ('X',     '66666666-6666-4666-8666-666666666666'),
  ('Firma', '99999999-9999-4999-8999-999999999999'),
  ('P',     '77777777-7777-4777-8777-777777777777'),
  ('T1',    '0a000000-0000-4000-8000-000000000001'),
  ('S1',    '0a000000-0000-4000-8000-000000000002'),
  ('T2',    '0a000000-0000-4000-8000-000000000003'),
  ('T3',    '0a000000-0000-4000-8000-000000000004'),
  ('TA',    '0a000000-0000-4000-8000-000000000005');

INSERT INTO public.companies (id, name) VALUES (pruefung.p('Firma'), 'Prüffirma');

INSERT INTO public.profiles (id, email, full_name, company_id, role, can_use_projects, can_manage_projects) VALUES
  (pruefung.p('A'), 'a@pruefung.local', 'Anna Angriff',     pruefung.p('Firma'), 'mitarbeiter', true,  false),
  (pruefung.p('B'), 'b@pruefung.local', 'Beat Besitz',      pruefung.p('Firma'), 'mitarbeiter', true,  false),
  (pruefung.p('C'), 'c@pruefung.local', 'Carla Unteraufgabe', pruefung.p('Firma'), 'mitarbeiter', true,  false),
  (pruefung.p('D'), 'd@pruefung.local', 'Dora Danebenstehend', pruefung.p('Firma'), 'mitarbeiter', true,  false),
  (pruefung.p('M'), 'm@pruefung.local', 'Max Verwalter',    pruefung.p('Firma'), 'mitarbeiter', true,  true),
  (pruefung.p('X'), 'x@pruefung.local', 'Xenia Admin',      pruefung.p('Firma'), 'admin',       false, false);

-- Jede berechtigte Person hat jetzt ihr persönliches Projekt
-- (Trigger profiles_persoenliches_projekt, sql/modul/09)
INSERT INTO pruefung.wer (name, id)
  SELECT 'EigenA', id FROM public.projects WHERE persoenlich_fuer = pruefung.p('A');
INSERT INTO pruefung.wer (name, id)
  SELECT 'EigenD', id FROM public.projects WHERE persoenlich_fuer = pruefung.p('D');

INSERT INTO public.projects (id, company_id, name, created_by)
  VALUES (pruefung.p('P'), pruefung.p('Firma'), 'Prüfprojekt', pruefung.p('M'));

INSERT INTO public.project_members (project_id, profile_id, added_by)
  SELECT pruefung.p('P'), pruefung.p(n), pruefung.p('M')
  FROM (VALUES ('M'), ('A'), ('B'), ('C'), ('D')) v(n);

INSERT INTO public.tasks (id, project_id, titel, assignee_id, created_by, due_date) VALUES
  (pruefung.p('T1'), pruefung.p('P'), 'Budget Q1 abstimmen', pruefung.p('B'), pruefung.p('B'), '2026-12-01'),
  (pruefung.p('T2'), pruefung.p('P'), 'Offerten einholen',   pruefung.p('B'), pruefung.p('B'), '2026-12-02'),
  (pruefung.p('T3'), pruefung.p('P'), 'Protokoll schreiben', pruefung.p('A'), pruefung.p('B'), '2026-12-03');

INSERT INTO public.tasks (id, project_id, parent_task_id, titel, assignee_id, created_by, due_date)
  VALUES (pruefung.p('S1'), pruefung.p('P'), pruefung.p('T1'), 'Zahlen einholen',
          pruefung.p('C'), pruefung.p('C'), '2026-11-25');

INSERT INTO public.task_watchers (task_id, profile_id, added_by)
  VALUES (pruefung.p('T1'), pruefung.p('M'), pruefung.p('B'));


-- ════════════════════════════════════════════════════════════
-- 0. Rechte der neuen Funktionen
-- ════════════════════════════════════════════════════════════

SELECT pruefung.fest('anon darf darf_task_abschirmen nicht ausfuehren',
  has_function_privilege('anon', 'public.darf_task_abschirmen(uuid,uuid)', 'EXECUTE')::text, 'false');
SELECT pruefung.fest('anon darf darf_task_beteiligte_aendern nicht ausfuehren',
  has_function_privilege('anon', 'public.darf_task_beteiligte_aendern(uuid)', 'EXECUTE')::text, 'false');
SELECT pruefung.fest('authenticated darf darf_task_abschirmen ausfuehren',
  has_function_privilege('authenticated', 'public.darf_task_abschirmen(uuid,uuid)', 'EXECUTE')::text, 'true');
SELECT pruefung.fest('authenticated darf task_update_schutz nicht ausfuehren',
  has_function_privilege('authenticated', 'public.task_update_schutz()', 'EXECUTE')::text, 'false');
SELECT pruefung.fest('authenticated darf sync_task_beobachter_projekt nicht ausfuehren',
  has_function_privilege('authenticated', 'public.sync_task_beobachter_projekt()', 'EXECUTE')::text, 'false');


-- ════════════════════════════════════════════════════════════
-- 1. Der Angriff (A ist Mitglied, aber an T1 unbeteiligt)
-- ════════════════════════════════════════════════════════════

SELECT pruefung.fest('A sieht die Aufgaben des Projekts (Voraussetzung des Angriffs)',
  pruefung.sicht(pruefung.p('A'), $$SELECT id FROM public.tasks WHERE project_id = pruefung.p('P')$$), '4');

SELECT pruefung.fest('3b: A entfernt die Beobachter von T1',
  pruefung.als(pruefung.p('A'), $$DELETE FROM public.task_watchers WHERE task_id = pruefung.p('T1')$$),
  '0 Zeilen');

SELECT pruefung.fest('3c: A ueberschreibt created_by von T1',
  pruefung.als(pruefung.p('A'), $$UPDATE public.tasks SET created_by = pruefung.p('A') WHERE id = pruefung.p('T1')$$),
  'Fehler: Wer eine Aufgabe erstellt hat, lässt sich nachträglich nicht ändern.');

SELECT pruefung.fest('3c: A stellt T1 auf vertraulich',
  pruefung.als(pruefung.p('A'), $$UPDATE public.tasks SET vertraulich = true WHERE id = pruefung.p('T1')$$),
  'Fehler: Nur Beteiligte oder die Projektverwaltung können eine Aufgabe auf «vertraulich» stellen.');

SELECT pruefung.fest('3c: A setzt vertraulich, assignee_id und created_by in einem PATCH',
  pruefung.als(pruefung.p('A'), $$UPDATE public.tasks
      SET vertraulich = true, assignee_id = pruefung.p('A'), created_by = pruefung.p('A')
    WHERE id = pruefung.p('T1')$$),
  'Fehler: Wer eine Aufgabe erstellt hat, lässt sich nachträglich nicht ändern.');

SELECT pruefung.fest('3c: A setzt vertraulich und zieht die Zustaendigkeit an sich',
  pruefung.als(pruefung.p('A'), $$UPDATE public.tasks
      SET vertraulich = true, assignee_id = pruefung.p('A')
    WHERE id = pruefung.p('T1')$$),
  'Fehler: Nur Beteiligte oder die Projektverwaltung können eine Aufgabe auf «vertraulich» stellen.');

SELECT pruefung.fest('Offene Frage des Befunds: A haengt T1 nach «Eigene Tasks» um',
  pruefung.als(pruefung.p('A'), $$UPDATE public.tasks SET project_id = pruefung.p('EigenA') WHERE id = pruefung.p('T1')$$),
  'Fehler: Nur Beteiligte oder die Projektverwaltung können eine Aufgabe nach «Eigene Tasks» übernehmen.');

SELECT pruefung.fest('A haengt T1 ins persoenliche Projekt von D um',
  pruefung.als(pruefung.p('A'), $$UPDATE public.tasks SET project_id = pruefung.p('EigenD') WHERE id = pruefung.p('T1')$$),
  'Fehler: Nur Beteiligte oder die Projektverwaltung können eine Aufgabe nach «Eigene Tasks» übernehmen.');

-- Zustand nach dem Angriff
SELECT pruefung.fest('T1 gehoert weiterhin B',
  (SELECT (created_by = pruefung.p('B'))::text FROM public.tasks WHERE id = pruefung.p('T1')), 'true');
SELECT pruefung.fest('T1 ist nicht vertraulich',
  (SELECT vertraulich::text FROM public.tasks WHERE id = pruefung.p('T1')), 'false');
SELECT pruefung.fest('T1 liegt noch im Prueffprojekt',
  (SELECT (project_id = pruefung.p('P'))::text FROM public.tasks WHERE id = pruefung.p('T1')), 'true');
SELECT pruefung.fest('Beobachter M von T1 ist noch da',
  (SELECT count(*)::text FROM public.task_watchers WHERE task_id = pruefung.p('T1')), '1');
SELECT pruefung.fest('B sieht nach dem Angriff alle vier Aufgaben',
  pruefung.sicht(pruefung.p('B'), $$SELECT id FROM public.tasks WHERE project_id = pruefung.p('P')$$), '4');
SELECT pruefung.fest('Projektverwalter M sieht nach dem Angriff alle vier Aufgaben',
  pruefung.sicht(pruefung.p('M'), $$SELECT id FROM public.tasks WHERE project_id = pruefung.p('P')$$), '4');


-- ════════════════════════════════════════════════════════════
-- 2. Gegenprobe: tägliche Zusammenarbeit geht weiter
-- ════════════════════════════════════════════════════════════

SELECT pruefung.fest('A darf den Titel einer fremden Aufgabe aendern',
  pruefung.als(pruefung.p('A'), $$UPDATE public.tasks SET titel = 'Budget Q1 abstimmen (A)' WHERE id = pruefung.p('T1')$$),
  '1 Zeilen');

SELECT pruefung.fest('A darf die Zustaendigkeit uebernehmen',
  pruefung.als(pruefung.p('A'), $$UPDATE public.tasks SET assignee_id = pruefung.p('A') WHERE id = pruefung.p('T1')$$),
  '1 Zeilen');

SELECT pruefung.fest('… und B sieht T1 danach weiter (Urheberschaft blieb)',
  pruefung.sicht(pruefung.p('B'), $$SELECT id FROM public.tasks WHERE id = pruefung.p('T1')$$), '1');
SELECT pruefung.fest('… und M sieht T1 danach weiter',
  pruefung.sicht(pruefung.p('M'), $$SELECT id FROM public.tasks WHERE id = pruefung.p('T1')$$), '1');

SELECT pruefung.fest('A darf eine fremde Aufgabe schliessen',
  pruefung.als(pruefung.p('A'), $$UPDATE public.tasks SET status = 'geschlossen' WHERE id = pruefung.p('T3')$$),
  '1 Zeilen');
SELECT pruefung.fest('A darf sie wieder reaktivieren',
  pruefung.als(pruefung.p('A'), $$UPDATE public.tasks SET status = 'offen' WHERE id = pruefung.p('T3')$$),
  '1 Zeilen');

SELECT pruefung.fest('A darf eine Aufgabe in ein anderes gewoehnliches Projekt umhaengen (unveraendert erlaubt)',
  pruefung.als(pruefung.p('A'), $$UPDATE public.tasks SET project_id = pruefung.p('P') WHERE id = pruefung.p('T2')$$),
  '1 Zeilen');

-- A ist jetzt zuständig für T1, also beteiligt. Das fremde
-- persönliche Projekt bleibt trotzdem zu: dort ist A kein Mitglied,
-- das weist schon das WITH CHECK ab.
SELECT pruefung.fest('A (beteiligt) haengt T1 ins fremde persoenliche Projekt von D',
  pruefung.als(pruefung.p('A'), $$UPDATE public.tasks SET project_id = pruefung.p('EigenD') WHERE id = pruefung.p('T1')$$),
  'Fehler: RLS');


-- ════════════════════════════════════════════════════════════
-- 3. «Vertraulich» durch Beteiligte — und die Vererbung
-- ════════════════════════════════════════════════════════════

SELECT pruefung.fest('B (Ersteller, nicht mehr zustaendig) stellt T1 auf vertraulich',
  pruefung.als(pruefung.p('B'), $$UPDATE public.tasks SET vertraulich = true WHERE id = pruefung.p('T1')$$),
  '1 Zeilen');

SELECT pruefung.fest('Die Unter-Aufgabe S1 ist mitgezogen (Trigger tasks_vertraulich_weitergeben)',
  (SELECT vertraulich::text FROM public.tasks WHERE id = pruefung.p('S1')), 'true');

SELECT pruefung.fest('B (Ersteller) sieht die vertrauliche T1',
  pruefung.sicht(pruefung.p('B'), $$SELECT id FROM public.tasks WHERE id = pruefung.p('T1')$$), '1');
SELECT pruefung.fest('A (zustaendig) sieht die vertrauliche T1',
  pruefung.sicht(pruefung.p('A'), $$SELECT id FROM public.tasks WHERE id = pruefung.p('T1')$$), '1');
SELECT pruefung.fest('M (Beobachter) sieht die vertrauliche T1',
  pruefung.sicht(pruefung.p('M'), $$SELECT id FROM public.tasks WHERE id = pruefung.p('T1')$$), '1');
SELECT pruefung.fest('X (Administrator) sieht die vertrauliche T1',
  pruefung.sicht(pruefung.p('X'), $$SELECT id FROM public.tasks WHERE id = pruefung.p('T1')$$), '1');
SELECT pruefung.fest('D (einfaches Mitglied) sieht die vertrauliche T1 nicht',
  pruefung.sicht(pruefung.p('D'), $$SELECT id FROM public.tasks WHERE id = pruefung.p('T1')$$), '0');
SELECT pruefung.fest('C (zustaendig fuer die Unter-Aufgabe) sieht S1 weiter',
  pruefung.sicht(pruefung.p('C'), $$SELECT id FROM public.tasks WHERE id = pruefung.p('S1')$$), '1');
SELECT pruefung.fest('D sieht S1 nicht',
  pruefung.sicht(pruefung.p('D'), $$SELECT id FROM public.tasks WHERE id = pruefung.p('S1')$$), '0');

SELECT pruefung.fest('D kann die Vertraulichkeit nicht aufheben',
  pruefung.als(pruefung.p('D'), $$UPDATE public.tasks SET vertraulich = false WHERE id = pruefung.p('T1')$$),
  '0 Zeilen');

SELECT pruefung.fest('B nimmt die Vertraulichkeit zurueck',
  pruefung.als(pruefung.p('B'), $$UPDATE public.tasks SET vertraulich = false WHERE id = pruefung.p('T1')$$),
  '1 Zeilen');
SELECT pruefung.fest('D sieht wieder alle vier Aufgaben',
  pruefung.sicht(pruefung.p('D'), $$SELECT id FROM public.tasks WHERE project_id = pruefung.p('P')$$), '4');


-- ════════════════════════════════════════════════════════════
-- 4. Die Projektverwaltung
--
-- «Vertraulich» einschalten kann auch die Projektverwaltung nur,
-- wenn sie beteiligt ist — nicht wegen der neuen Regel, sondern
-- weil `tasks_select_member` auch gegen die NEUE Zeile geprüft wird
-- (Postgres wendet die SELECT-Policy beim UPDATE auf beide Zeilen
-- an, sobald die Anweisung Spalten liest). Die Aufgabe wäre für die
-- Verwaltung im selben Moment unsichtbar. Das ist die Zusage von
-- sql/modul/13 und bleibt so.
-- ════════════════════════════════════════════════════════════

SELECT pruefung.fest('M (Verwalter, an T2 unbeteiligt) stellt T2 auf vertraulich — waere danach selbst blind',
  pruefung.als(pruefung.p('M'), $$UPDATE public.tasks SET vertraulich = true WHERE id = pruefung.p('T2')$$),
  'Fehler: RLS');
SELECT pruefung.fest('… T2 ist nicht vertraulich geworden',
  (SELECT vertraulich::text FROM public.tasks WHERE id = pruefung.p('T2')), 'false');

INSERT INTO public.task_watchers (task_id, profile_id, added_by)
  VALUES (pruefung.p('T2'), pruefung.p('M'), pruefung.p('B'));

SELECT pruefung.fest('M (Verwalter und Beobachter) stellt T2 auf vertraulich',
  pruefung.als(pruefung.p('M'), $$UPDATE public.tasks SET vertraulich = true WHERE id = pruefung.p('T2')$$),
  '1 Zeilen');
SELECT pruefung.fest('B (Ersteller) sieht T2 weiter',
  pruefung.sicht(pruefung.p('B'), $$SELECT id FROM public.tasks WHERE id = pruefung.p('T2')$$), '1');
SELECT pruefung.fest('M nimmt es zurueck',
  pruefung.als(pruefung.p('M'), $$UPDATE public.tasks SET vertraulich = false WHERE id = pruefung.p('T2')$$),
  '1 Zeilen');

DELETE FROM public.task_watchers WHERE task_id = pruefung.p('T2');

-- Nach «Eigene Tasks» übernehmen darf die Verwaltung auch ohne
-- Beteiligung: dort sieht sie die Aufgabe weiter, und löschen
-- (`tasks_delete_verwalter`) dürfte sie sie ohnehin.
SELECT pruefung.fest('M (Verwalter, unbeteiligt) uebernimmt T2 nach «Eigene Tasks»',
  pruefung.als(pruefung.p('M'), format('UPDATE public.tasks SET project_id = %L WHERE id = pruefung.p(''T2'')',
    (SELECT id FROM public.projects WHERE persoenlich_fuer = pruefung.p('M')))),
  '1 Zeilen');
SELECT pruefung.fest('… die Urheberschaft bleibt bei B',
  (SELECT (created_by = pruefung.p('B'))::text FROM public.tasks WHERE id = pruefung.p('T2')), 'true');

-- Für die nächsten Abschnitte zurück ins Prüfprojekt
UPDATE public.tasks SET project_id = pruefung.p('P'), assignee_id = pruefung.p('B') WHERE id = pruefung.p('T2');


-- ════════════════════════════════════════════════════════════
-- 5. Beobachter entfernen
-- ════════════════════════════════════════════════════════════

INSERT INTO public.task_watchers (task_id, profile_id, added_by)
  VALUES (pruefung.p('T2'), pruefung.p('D'), pruefung.p('B'));

SELECT pruefung.fest('A (an T2 unbeteiligt) entfernt den Beobachter D nicht',
  pruefung.als(pruefung.p('A'), $$DELETE FROM public.task_watchers WHERE task_id = pruefung.p('T2')$$),
  '0 Zeilen');

SELECT pruefung.fest('D entfernt sich selbst als Beobachter',
  pruefung.als(pruefung.p('D'), $$DELETE FROM public.task_watchers
    WHERE task_id = pruefung.p('T2') AND profile_id = pruefung.p('D')$$),
  '1 Zeilen');

INSERT INTO public.task_watchers (task_id, profile_id, added_by)
  VALUES (pruefung.p('T2'), pruefung.p('D'), pruefung.p('B'));

SELECT pruefung.fest('B (Ersteller) entfernt den Beobachter D',
  pruefung.als(pruefung.p('B'), $$DELETE FROM public.task_watchers WHERE task_id = pruefung.p('T2')$$),
  '1 Zeilen');

INSERT INTO public.task_watchers (task_id, profile_id, added_by)
  VALUES (pruefung.p('T2'), pruefung.p('D'), pruefung.p('B'));

SELECT pruefung.fest('M (Verwalter) entfernt den Beobachter D',
  pruefung.als(pruefung.p('M'), $$DELETE FROM public.task_watchers WHERE task_id = pruefung.p('T2')$$),
  '1 Zeilen');

SELECT pruefung.fest('A darf weiterhin Beobachter hinzufuegen (unveraendert)',
  pruefung.als(pruefung.p('A'), $$INSERT INTO public.task_watchers (task_id, profile_id, added_by)
    VALUES (pruefung.p('T2'), pruefung.p('D'), pruefung.p('A'))$$),
  '1 Zeilen');


-- ════════════════════════════════════════════════════════════
-- 6. Einhängen unter eine fremde vertrauliche Aufgabe
--
-- Der Erb-Trigger würde `vertraulich` setzen; das WITH CHECK der
-- Policy weist die Zeile ab. Ohne diesen Weg liesse sich eine fremde
-- Aufgabe am Trigger vorbei verstecken.
-- ════════════════════════════════════════════════════════════

SELECT pruefung.fest('A legt eine eigene vertrauliche Aufgabe an',
  pruefung.als(pruefung.p('A'), $$INSERT INTO public.tasks (id, project_id, titel, assignee_id, created_by, due_date, vertraulich)
    VALUES (pruefung.p('TA'), pruefung.p('P'), 'Eigene vertrauliche Aufgabe',
            pruefung.p('A'), pruefung.p('A'), '2026-12-05', true)$$),
  '1 Zeilen');

SELECT pruefung.fest('A haengt die fremde T2 unter ihre vertrauliche Aufgabe',
  pruefung.als(pruefung.p('A'), $$UPDATE public.tasks SET parent_task_id = pruefung.p('TA') WHERE id = pruefung.p('T2')$$),
  'Fehler: RLS');
SELECT pruefung.fest('T2 hat keinen Mutter-Task bekommen',
  (SELECT (parent_task_id IS NULL)::text FROM public.tasks WHERE id = pruefung.p('T2')), 'true');
SELECT pruefung.fest('T2 ist nicht vertraulich geworden',
  (SELECT vertraulich::text FROM public.tasks WHERE id = pruefung.p('T2')), 'false');


-- ════════════════════════════════════════════════════════════
-- 7. «Eigene Tasks»: Beteiligte dürfen übernehmen
-- ════════════════════════════════════════════════════════════

SELECT pruefung.fest('A (zustaendig fuer T3) uebernimmt T3 nach «Eigene Tasks»',
  pruefung.als(pruefung.p('A'), $$UPDATE public.tasks SET project_id = pruefung.p('EigenA') WHERE id = pruefung.p('T3')$$),
  '1 Zeilen');
SELECT pruefung.fest('… T3 ist dort A zugewiesen (Trigger tasks_assignee_eigen)',
  (SELECT (assignee_id = pruefung.p('A'))::text FROM public.tasks WHERE id = pruefung.p('T3')), 'true');
SELECT pruefung.fest('… A sieht T3',
  pruefung.sicht(pruefung.p('A'), $$SELECT id FROM public.tasks WHERE id = pruefung.p('T3')$$), '1');
SELECT pruefung.fest('… X (Administrator) sieht T3 nicht mehr (privat bleibt privat)',
  pruefung.sicht(pruefung.p('X'), $$SELECT id FROM public.tasks WHERE id = pruefung.p('T3')$$), '0');

-- Beobachter, die im Zielprojekt nicht Mitglied sind, räumt der
-- neue Trigger weg — unabhängig davon, wer umhängt
INSERT INTO public.task_watchers (task_id, profile_id, added_by)
  VALUES (pruefung.p('T1'), pruefung.p('D'), pruefung.p('B'));
SELECT pruefung.fest('B uebernimmt T1 nach «Eigene Tasks» von B',
  pruefung.als(pruefung.p('B'), format('UPDATE public.tasks SET project_id = %L WHERE id = pruefung.p(''T1'')',
    (SELECT id FROM public.projects WHERE persoenlich_fuer = pruefung.p('B')))),
  '1 Zeilen');
SELECT pruefung.fest('… die Beobachter von T1 sind weggeraeumt (Trigger tasks_beobachter_projekt_sync)',
  (SELECT count(*)::text FROM public.task_watchers WHERE task_id = pruefung.p('T1')), '0');


-- ════════════════════════════════════════════════════════════
-- 8. Service Role (Jira-Spiegel, Benutzerverwaltung, MCP)
--
-- Ohne JWT-Claims ist `auth.uid()` NULL; dort greift der Schutz
-- bewusst nicht. Für MCP prüft `src/mcp/guard.ts`.
-- ════════════════════════════════════════════════════════════

SELECT pruefung.fest('Service Role darf created_by setzen',
  pruefung.als_service($$UPDATE public.tasks SET created_by = pruefung.p('C') WHERE id = pruefung.p('T2')$$),
  '1 Zeilen');
SELECT pruefung.fest('Service Role darf vertraulich setzen',
  pruefung.als_service($$UPDATE public.tasks SET vertraulich = true WHERE id = pruefung.p('T2')$$),
  '1 Zeilen');
UPDATE public.tasks SET created_by = pruefung.p('B'), vertraulich = false WHERE id = pruefung.p('T2');


-- ════════════════════════════════════════════════════════════
-- 9. Das persönliche Projekt bleibt, wie es war
-- ════════════════════════════════════════════════════════════

SELECT pruefung.fest('D legt in «Eigene Tasks» eine Aufgabe an',
  pruefung.als(pruefung.p('D'), $$INSERT INTO public.tasks (project_id, titel, created_by, due_date)
    VALUES (pruefung.p('EigenD'), 'Nur fuer mich', pruefung.p('D'), '2026-12-09')$$),
  '1 Zeilen');
SELECT pruefung.fest('… D sieht sie',
  pruefung.sicht(pruefung.p('D'), $$SELECT id FROM public.tasks WHERE project_id = pruefung.p('EigenD')$$), '1');
SELECT pruefung.fest('… X (Administrator) sieht sie nicht',
  pruefung.sicht(pruefung.p('X'), $$SELECT id FROM public.tasks WHERE project_id = pruefung.p('EigenD')$$), '0');
SELECT pruefung.fest('… A sieht sie nicht',
  pruefung.sicht(pruefung.p('A'), $$SELECT id FROM public.tasks WHERE project_id = pruefung.p('EigenD')$$), '0');


-- ════════════════════════════════════════════════════════════
-- Ergebnis
-- ════════════════════════════════════════════════════════════

\o

SELECT nr, pruefung, ist, muss,
       CASE WHEN ist = muss THEN 'ok' ELSE '>>> FEHLER' END AS urteil
FROM pruefung.ergebnis ORDER BY nr;

DO $$
DECLARE offen INTEGER; alle INTEGER;
BEGIN
  SELECT count(*) FILTER (WHERE ist IS DISTINCT FROM muss), count(*) INTO offen, alle
  FROM pruefung.ergebnis;
  IF offen > 0 THEN
    RAISE EXCEPTION '% von % Pruefungen fehlgeschlagen', offen, alle;
  END IF;
  RAISE WARNING 'Alle % Pruefungen ok', alle;
END
$$;
