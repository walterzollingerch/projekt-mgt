-- ============================================================
-- Migration: Wiederkehrende Tasks (Projekt-Mgt)
-- Ein Task kann als wiederkehrend markiert werden (jede Woche /
-- jeden Monat / jedes Jahr am gleichen Tag). Beim Schliessen
-- erstellt die API automatisch den Folge-Task mit der nächsten
-- Fälligkeit gemäss Regel.
-- Führe dieses Script im Supabase SQL Editor aus
-- (setzt supabase_migration_notiz_anhang_watcher.sql voraus)
-- ============================================================

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS wiederholung TEXT
  CHECK (wiederholung IN ('woechentlich', 'monatlich', 'jaehrlich'));

-- Bestehende SuisseImage-Aufgabe (Teleboy-Import) direkt als
-- jährlich wiederkehrend markieren, falls vorhanden
UPDATE public.tasks
SET wiederholung = 'jaehrlich'
WHERE titel = '📄 Jahresrechnung SuisseImage' AND wiederholung IS NULL;
