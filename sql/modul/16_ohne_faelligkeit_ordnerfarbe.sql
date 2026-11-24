-- ============================================================
-- Migration: Aufgaben ohne Fälligkeitsdatum, Ordner mit Farbe
-- (Projekt-Mgt)
--
-- 1. FÄLLIGKEIT IST KEINE PFLICHT MEHR
--
--    Bisher war `tasks.due_date` NOT NULL. Wer etwas nur festhalten
--    wollte, musste ein Datum erfinden — und bekam dafür später eine
--    «überfällig»-Meldung, die nichts bedeutete.
--
--    NEU: `due_date` darf NULL sein. Die Regel dazu (Entscheid
--    24.11.2026) steht im Code, nicht in der Datenbank, und gilt
--    überall gleich:
--
--      Eine Aufgabe ohne Datum ist FÄLLIG. Sie erscheint überall,
--      wo fällige und überfällige Aufgaben berücksichtigt werden
--      (Fällig-Liste, Tagesmail, Startseite, MCP-Filter), und wird
--      dort als «ohne Fälligkeitsdatum» ausgewiesen — nicht als
--      überfällig, denn eine Frist, die es nicht gibt, kann nicht
--      verstrichen sein.
--
--    Die Auswertung liegt in `src/logik/faelligkeit.ts`.
--
--    Eine wiederkehrende Aufgabe braucht weiterhin ein Datum: Der
--    Folge-Task wird aus der bisherigen Fälligkeit berechnet
--    («jeden Monat am gleichen Tag»). Ohne Datum gäbe es nichts,
--    wovon aus weitergezählt wird.
--
-- 2. ORDNER BEKOMMEN EINE FARBE
--
--    `project_folders.farbe`, dieselbe feste Auswahl wie bei den
--    Tags (sql/modul/07). NULL = keine Farbe, so sehen alle
--    bestehenden Ordner weiter aus wie bisher.
--
-- Keine neuen Funktionen, keine neuen Tabellen: an den Rechten
-- ändert sich nichts. Ordner pflegt wie bisher jedes Projektmitglied.
--
-- Setzt 01_task_tracker.sql, 03_wiederholung.sql und 06_ordner.sql
-- voraus.
-- ============================================================

-- 1. Fälligkeit optional
ALTER TABLE public.tasks ALTER COLUMN due_date DROP NOT NULL;

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_wiederholung_braucht_datum;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_wiederholung_braucht_datum
  CHECK (wiederholung IS NULL OR due_date IS NOT NULL);

-- 2. Ordnerfarbe
ALTER TABLE public.project_folders ADD COLUMN IF NOT EXISTS farbe TEXT;

ALTER TABLE public.project_folders DROP CONSTRAINT IF EXISTS project_folders_farbe_check;
ALTER TABLE public.project_folders ADD CONSTRAINT project_folders_farbe_check
  CHECK (
    farbe IS NULL
    OR farbe IN ('grau', 'blau', 'gruen', 'gelb', 'orange', 'rot', 'violett', 'tuerkis')
  );
