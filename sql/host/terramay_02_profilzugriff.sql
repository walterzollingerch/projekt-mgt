-- ============================================================
-- HOST-VORAUSSETZUNGEN 2/2 — Terramay (bnahtgsfsvkruwydwluj)
--
-- ZULETZT ausfuehren: erst terramay_01_voraussetzungen.sql, dann
-- sql/modul/01 bis 08, dann diese Datei.
--
-- Sie benutzt die Funktionen is_project_manager() und
-- shares_project_with() aus sql/modul/01 — laeuft sie zu frueh,
-- bricht CREATE POLICY mit "function does not exist" ab.
-- ============================================================

-- ════════════════════════════════════════════════════════════
-- Profil-Sichtbarkeit fuer das Modul: Projektverwalter sehen alle
-- Profile (Mitglieder-Auswahl), Mitglieder die Profile ihrer
-- Projektkollegen (Zustaendigen-Anzeige). Benutzt die Funktionen
-- aus sql/modul/01 — deshalb erst danach.
-- ════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "profiles_select_projectmgr" ON public.profiles;
CREATE POLICY "profiles_select_projectmgr" ON public.profiles
  FOR SELECT USING (public.is_project_manager());

DROP POLICY IF EXISTS "profiles_select_shared_project" ON public.profiles;
CREATE POLICY "profiles_select_shared_project" ON public.profiles
  FOR SELECT USING (public.shares_project_with(id));


-- Den Speicher-Bucket `task-attachments` samt seinen Policies legt
-- sql/modul/02_notiz_anhang_watcher.sql an — er gehoert dem Modul,
-- nicht der App.


-- ════════════════════════════════════════════════════════════
-- KONTROLLE
-- ════════════════════════════════════════════════════════════

SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='profiles'
      AND column_name IN ('can_use_projects','can_manage_projects'))          AS rechte_spalten,   -- erwartet 2
  (SELECT count(*) FROM pg_trigger
    WHERE tgrelid='public.profiles'::regclass AND tgname='protect_profile_privileges') AS schutz_trigger, -- erwartet 1
  (SELECT count(*) FROM information_schema.views
    WHERE table_schema='public' AND table_name='mitarbeiter_verzeichnis')     AS verzeichnis,      -- erwartet 1
  (SELECT count(*) FROM storage.buckets WHERE id='task-attachments')          AS speicher,         -- erwartet 1
  (SELECT count(*) FROM information_schema.tables
    WHERE table_schema='public' AND table_name IN
      ('projects','project_members','project_folders','tasks','task_notes',
       'task_watchers','task_tags','task_tag_zuordnungen'))                   AS modul_tabellen;   -- erwartet 8
