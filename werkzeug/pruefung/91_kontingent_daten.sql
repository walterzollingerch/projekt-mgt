-- ============================================================
-- Testdaten für die Kontingent-Prüfung (nur für Tests)
--
-- Eine Firma, ein Projekt, zwei Personen mit je einem MCP-Zugang.
-- Die Tokens stehen im Klartext hier, weil sie nur in der leeren
-- Container-Datenbank gelten — gespeichert wird wie in der
-- Produktion ausschliesslich ihr SHA-256-Hash.
--
-- Zwei Personen, weil das Kontingent PRO PERSON gilt: Person B ist
-- die Gegenprobe, dass eine ausgeschöpfte Grenze nicht die ganze
-- Installation bremst.
-- ============================================================

INSERT INTO public.companies (id, name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'Prüf AG');

INSERT INTO public.profiles (id, email, full_name, company_id, role, can_use_projects)
VALUES
  ('bbbbbbbb-0000-4000-8000-000000000001', 'person-a@pruefung.invalid', 'Person A',
   'aaaaaaaa-0000-4000-8000-000000000001', 'mitarbeiter', true),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'person-b@pruefung.invalid', 'Person B',
   'aaaaaaaa-0000-4000-8000-000000000001', 'mitarbeiter', true);

INSERT INTO public.projects (id, company_id, name, status, created_by)
VALUES ('cccccccc-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
        'Prüfprojekt', 'aktiv', 'bbbbbbbb-0000-4000-8000-000000000001');

INSERT INTO public.project_members (project_id, profile_id)
VALUES
  ('cccccccc-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001'),
  ('cccccccc-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002');

-- Die Klartext-Tokens kennt auch werkzeug/pruefung/kontingent.ts
INSERT INTO public.mcp_tokens (id, profile_id, name, token_hash, token_prefix)
VALUES
  ('dddddddd-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001',
   'Zugang A',
   encode(sha256(convert_to('pruefung-kontingent-token-person-a', 'UTF8')), 'hex'),
   'pruefung'),
  ('dddddddd-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002',
   'Zugang B',
   encode(sha256(convert_to('pruefung-kontingent-token-person-b', 'UTF8')), 'hex'),
   'pruefung');
