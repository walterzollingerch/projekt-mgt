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
--
-- Stand 21.10.2026: dieselbe Fassung wie live in Terramay
-- (terramay-horses: migration_benutzer_verwalten.sql und
-- migration_seguranca_conta_ativa.sql, Punkt 4). Sie schuetzt alle
-- Rechte-Spalten, die Terramay inzwischen fuehrt, und laesst
-- Benutzerverwalter (can_manage_users) die Rechte anderer
-- Nicht-Admins aendern. Die fruehere Fassung dieser Datei kannte nur
-- acht Spalten — erneutes Einspielen haette can_manage_reservations,
-- can_manage_users usw. wieder frei setzbar gemacht.
-- ════════════════════════════════════════════════════════════

-- Die Spalten gehoeren Terramay, nicht dem Modul. Fehlt eine, wuerde
-- der Trigger erst beim naechsten Profil-Update scheitern — und dann
-- bei JEDEM. Deshalb lieber hier abbrechen.
DO $$
DECLARE
  fehlend text;
BEGIN
  SELECT string_agg(c, ', ') INTO fehlend
    FROM unnest(ARRAY['company_id', 'assigned_car_ids', 'assigned_horse_ids',
                      'can_use_reservations', 'can_manage_reservations',
                      'can_manage_schedules', 'can_manage_animals',
                      'nur_direkte_mails', 'can_manage_users']) AS c
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = c
   );
  IF fehlend IS NOT NULL THEN
    RAISE EXCEPTION 'profiles: Spalten fehlen (%) — zuerst die Terramay-Migrationen ausfuehren', fehlend;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.is_user_manager()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = auth.uid() AND can_manage_users AND role <> 'admin' AND NOT is_blocked
  );
$$;

CREATE OR REPLACE FUNCTION public.protect_profile_privileges()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  rechte_geaendert boolean;
BEGIN
  rechte_geaendert :=
       NEW.role                    IS DISTINCT FROM OLD.role
    OR NEW.is_blocked              IS DISTINCT FROM OLD.is_blocked
    OR NEW.modules                 IS DISTINCT FROM OLD.modules
    OR NEW.company_id              IS DISTINCT FROM OLD.company_id
    OR NEW.assigned_car_ids        IS DISTINCT FROM OLD.assigned_car_ids
    OR NEW.assigned_horse_ids      IS DISTINCT FROM OLD.assigned_horse_ids
    OR NEW.can_prepare_handover    IS DISTINCT FROM OLD.can_prepare_handover
    OR NEW.can_approve_invoices    IS DISTINCT FROM OLD.can_approve_invoices
    OR NEW.receives_invoice_emails IS DISTINCT FROM OLD.receives_invoice_emails
    OR NEW.can_use_projects        IS DISTINCT FROM OLD.can_use_projects
    OR NEW.can_manage_projects     IS DISTINCT FROM OLD.can_manage_projects
    OR NEW.can_use_reservations    IS DISTINCT FROM OLD.can_use_reservations
    OR NEW.can_manage_reservations IS DISTINCT FROM OLD.can_manage_reservations
    OR NEW.can_manage_schedules    IS DISTINCT FROM OLD.can_manage_schedules
    OR NEW.can_manage_animals      IS DISTINCT FROM OLD.can_manage_animals
    OR NEW.nur_direkte_mails       IS DISTINCT FROM OLD.nur_direkte_mails
    OR NEW.can_manage_users        IS DISTINCT FROM OLD.can_manage_users;

  IF NOT rechte_geaendert OR auth.uid() IS NULL THEN  -- Service-Role / SQL
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') THEN
    RETURN NEW;
  END IF;

  IF public.is_user_manager()
     AND OLD.id <> auth.uid()
     AND OLD.role <> 'admin'
     AND NEW.role IS NOT DISTINCT FROM OLD.role
     AND NEW.can_manage_users IS NOT DISTINCT FROM OLD.can_manage_users THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Keine Berechtigung, Rollen oder Rechte zu ändern' USING ERRCODE = '42501';
END;
$$;

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
-- Stand 21.10.2026: die Adresse kommt aus profiles.email, einem
-- Spiegel von auth.users.email (terramay-horses:
-- migration_profile_email.sql). Damit braucht die View keinen Griff
-- nach auth.users mehr und laeuft mit security_invoker = true — es
-- gilt die RLS von `profiles` fuer den Abfragenden (gesperrte Konten
-- sehen nur sich selbst). Gleiche Fassung wie
-- migration_verzeichnis_ohne_auth_users.sql; die fruehere Fassung
-- hier (Besitzerrechte, auth.users) haette beides zurueckgedreht.
-- ════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'email'
  ) THEN
    RAISE EXCEPTION 'profiles.email fehlt — zuerst migration_profile_email.sql (terramay-horses) ausfuehren';
  END IF;
END $$;

-- Neu anlegen statt ersetzen: aeltere Fassungen lieferten email als
-- varchar(255) aus auth.users, CREATE OR REPLACE VIEW kann den Typ
-- nicht aendern.
DROP VIEW IF EXISTS public.mitarbeiter_verzeichnis;

CREATE VIEW public.mitarbeiter_verzeichnis
WITH (security_invoker = true) AS
SELECT
  p.id,
  p.full_name,
  p.email,
  NULL::uuid AS company_id,   -- Terramay ordnet Personen keiner Firma zu
  p.is_blocked,
  (p.role = 'admin' OR p.can_use_projects OR p.can_manage_projects) AS darf_projekte_nutzen
FROM public.profiles p;

REVOKE ALL ON public.mitarbeiter_verzeichnis FROM PUBLIC, anon;
GRANT SELECT ON public.mitarbeiter_verzeichnis TO authenticated, service_role;

COMMENT ON VIEW public.mitarbeiter_verzeichnis IS
  'Kollegenverzeichnis fuer das Projekt-Mgt. Bewusst OHNE Rechte-Matrix — '
  'nur Name, E-Mail und die Modul-Zugehoerigkeit. Liest die Adresse aus '
  'profiles.email (Spiegel von auth.users.email), damit die View mit den '
  'Rechten des Abfragenden laufen kann.';
