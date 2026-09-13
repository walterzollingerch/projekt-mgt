-- ============================================================
-- 11 — Screening-Bucket: Grössenlimit und MIME-Allowlist
--
-- 10_screening.sql legte `screening-dokumente` ohne file_size_limit und
-- ohne allowed_mime_types an. Der Dialog prüft zwar clientseitig (7 MB,
-- PDF/JPEG/PNG/WebP/HEIC — ScreeningDialog.tsx), aber die Storage-API
-- nimmt direkt vom Browser an, was ihr geschickt wird: jede Datei jeder
-- Grösse, von jedem Konto mit «Projekt-Mgt verwenden». Alle anderen
-- Buckets des Portals tragen ihre Grenzen serverseitig
-- (Security-Review TT Portal 12.09.2026, Befund D-6).
--
-- Grenzen: 8 MB (ein MB Luft über dem Dialog, damit die Meldung aus dem
-- Dialog kommt, nicht aus Storage) und genau die Typen des Dialogs,
-- HEIF als Geschwister von HEIC dazu. Bestand am 12.09.2026: 1 Objekt,
-- application/pdf, 4,3 MB — bleibt unter beiden Grenzen.
--
-- Idempotent. Im Supabase SQL Editor beider Host-Projekte einspielen
-- (TT Portal, Terramay).
-- ============================================================

UPDATE storage.buckets
   SET file_size_limit    = 8388608,   -- 8 MB
       allowed_mime_types = ARRAY[
         'application/pdf',
         'image/jpeg', 'image/png', 'image/webp',
         'image/heic', 'image/heif'
       ]
 WHERE id = 'screening-dokumente';

-- ── Verifikation (rein lesend) ──────────────────────────────────────────────
SELECT id, public, file_size_limit, array_length(allowed_mime_types, 1) AS mime_typen
FROM storage.buckets WHERE id = 'screening-dokumente';
-- Erwartet: public = false, file_size_limit = 8388608, mime_typen = 6.
--
-- Bestand, der die neuen Grenzen verletzen würde (muss 0 sein):
SELECT count(*) AS zu_gross_oder_falscher_typ
FROM storage.objects
WHERE bucket_id = 'screening-dokumente'
  AND ((metadata->>'size')::bigint > 8388608
       OR NOT (metadata->>'mimetype' = ANY (ARRAY['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif'])));
