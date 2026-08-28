-- ============================================================
-- HOST-VORAUSSETZUNGEN 1/2 — Terramay (bnahtgsfsvkruwydwluj)
--
-- Was die Gastgeber-App bereitstellen muss, damit das Modul
-- `projekt-mgt` laufen kann. Diese Datei gehört Terramay, nicht dem
-- Modul: der Privilegien-Schutz zählt Terramays Rechte-Spalten auf,
-- und die sind andere als im Portal.
--
-- REIHENFOLGE
--   1. DIESE Datei
--   2. sql/modul/01 bis 08 der Reihe nach
--   3. terramay_02_profilzugriff.sql — die braucht Funktionen, die
--      erst in modul/01 entstehen, und muss deshalb zuletzt laufen
--
-- Mehrfaches Ausführen ist ungefährlich.
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- ABSCHNITT A — Rechte-Spalten
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_use_projects    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_manage_projects BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.profiles.can_use_projects IS
  'Darf das Projekt-Mgt benutzen und ist als Projektmitglied waehlbar.';
COMMENT ON COLUMN public.profiles.can_manage_projects IS
  'Darf Projekte und deren Mitglieder verwalten.';


-- ════════════════════════════════════════════════════════════
-- ABSCHNITT B — Privilegien-Schutz
--
-- ACHTUNG, das schliesst eine bestehende Luecke und ist nicht nur
-- Vorbereitung fuer das Modul:
--
-- Die Policy "Users can update own profile" lautet
--   FOR UPDATE USING (auth.uid() = id)
-- und hat KEIN WITH CHECK. Postgres nimmt dann die USING-Bedingung
-- auch als Pruefung der neuen Zeile. Jede angemeldete Person darf
-- ihre eigene Profilzeile damit beliebig aendern — einschliesslich
-- `role`, `is_blocked` und `modules`. Ein Konto kann sich also
-- selbst zum Administrator machen, per direktem API-Aufruf, ohne
-- dass die Oberflaeche das anbietet.
--
-- Ohne diesen Trigger wuerde das Modul die Luecke vergroessern:
-- can_use_projects und can_manage_projects waeren genauso frei
-- setzbar.
--
-- Der Trigger laesst normale Profil-Aenderungen (Name, Sprache)
-- unangetastet und blockiert nur Rechte-Aenderungen durch
-- Nicht-Administratoren. `auth.uid() IS NULL` bedeutet Zugriff mit
-- dem Service-Role-Schluessel oder aus dem SQL-Editor — dort greift
-- der Schutz bewusst nicht, sonst koennte die Benutzerverwaltung
-- keine Rechte mehr vergeben.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.protect_profile_privileges()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.role                    IS DISTINCT FROM OLD.role
      OR NEW.is_blocked           IS DISTINCT FROM OLD.is_blocked
      OR NEW.modules              IS DISTINCT FROM OLD.modules
      OR NEW.can_prepare_handover IS DISTINCT FROM OLD.can_prepare_handover
      OR NEW.can_approve_invoices IS DISTINCT FROM OLD.can_approve_invoices
      OR NEW.receives_invoice_emails IS DISTINCT FROM OLD.receives_invoice_emails
      OR NEW.can_use_projects     IS DISTINCT FROM OLD.can_use_projects
      OR NEW.can_manage_projects  IS DISTINCT FROM OLD.can_manage_projects) THEN
    IF auth.uid() IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
    ) THEN
      RAISE EXCEPTION 'Keine Berechtigung, Rollen oder Rechte zu ändern';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS protect_profile_privileges ON public.profiles;
CREATE TRIGGER protect_profile_privileges
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_privileges();


-- ════════════════════════════════════════════════════════════
-- ABSCHNITT B2 — Kollegenverzeichnis
--
-- Das Modul liest Namen und E-Mail von Personen ueber diese View
-- statt direkt aus `profiles` — sie gibt bewusst NUR heraus, was
-- ein Verzeichnis braucht, und nie die Rechte-Matrix.
--
-- Terramays `profiles` fuehrt keine E-Mail; sie kommt aus
-- auth.users, wie in der bestehenden RPC get_profiles_with_email.
-- Deshalb security_invoker = false: die View muss mit den Rechten
-- ihres Besitzers laufen, sonst kaeme sie an auth.users nicht heran.
-- Der Supabase-Linter meldet das als `security_definer_view` — das
-- ist hier der Zweck, nicht ein Versaeumnis.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.mitarbeiter_verzeichnis
WITH (security_invoker = false) AS
SELECT
  p.id,
  p.full_name,
  u.email,
  NULL::uuid AS company_id,   -- Terramay ordnet Personen keiner Firma zu
  p.is_blocked,
  (p.role = 'admin' OR p.can_use_projects OR p.can_manage_projects) AS darf_projekte_nutzen
FROM public.profiles p
JOIN auth.users u ON u.id = p.id;

REVOKE ALL ON public.mitarbeiter_verzeichnis FROM PUBLIC, anon;
GRANT SELECT ON public.mitarbeiter_verzeichnis TO authenticated, service_role;

COMMENT ON VIEW public.mitarbeiter_verzeichnis IS
  'Kollegenverzeichnis fuer das Projekt-Mgt. Bewusst OHNE Rechte-Matrix — '
  'nur Name, E-Mail und die Modul-Zugehoerigkeit.';
