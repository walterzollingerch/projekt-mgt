-- ============================================================
-- Migration: Aufrufkontingent des MCP-Zugangs atomar reservieren
--
-- Das Kontingent (300 Werkzeugaufrufe pro Person in 10 Minuten)
-- wurde bisher so geprüft: zählen, Werkzeug ausführen, danach die
-- `mcp_audit`-Zeile schreiben. Zwischen Zählen und Schreiben liegt
-- die ganze Arbeit des Werkzeugs — alles, was in dieser Zeit
-- hereinkommt, sieht denselben Stand und wird durchgelassen.
--
-- Nachgewiesen wurde das mit einem JSON-RPC-Stapel (ein Array in
-- einer Anfrage): 150 Aufrufe liefen gleichzeitig durch, der Zähler
-- stand danach auf 443 bei Grenze 300. Der Stapel ist die bequeme
-- Form des Angriffs und wird im Modul jetzt abgelehnt (MCP
-- 2025-06-18 kennt kein Batching mehr) — die Lücke bleibt aber auch
-- ohne ihn: Wer gleichzeitig viele einzelne HTTP-Anfragen schickt,
-- bekommt dieselbe Wirkung. Dagegen hilft nur, das Kontingent in
-- EINER Anweisung zu prüfen und zu verbrauchen.
--
-- NEU: `mcp_aufruf_reservieren()` zählt und trägt ein, bevor das
-- Werkzeug läuft — serialisiert pro Person über einen
-- Transaktions-Advisory-Lock. Zwei gleichzeitige Reservierungen
-- derselben Person warten aufeinander, statt denselben Zählerstand
-- zu sehen. Verbraucht ist der Aufruf damit VOR der Ausführung;
-- das Ergebnis (`erfolg`, `fehler`) führt der Server danach nach.
--
-- Folge für das Protokoll: Eine Zeile entsteht beim Beginn des
-- Aufrufs, nicht am Ende. Bricht die Function-Instanz zwischendurch
-- ab (Timeout, Deployment), bleibt sie mit `erfolg = false` und
-- «Aufruf nicht abgeschlossen» stehen. Das ist genauer als bisher,
-- wo ein abgebrochener Aufruf gar keine Spur hinterliess.
--
-- Grenze und Fenster stehen bewusst NICHT hier, sondern kommen als
-- Parameter aus `src/mcp/auth.ts` (MCP_MAX_PRO_FENSTER,
-- MCP_FENSTER_MINUTEN). Eine Zahl, die an zwei Orten gepflegt wird,
-- ist eine Zahl, die irgendwann auseinanderläuft.
--
-- Einspielen: wie die übrigen Dateien aus `sql/modul/` in beiden
-- Datenbanken, nach `08_mcp_tokens.sql` (dort entsteht `mcp_audit`).
-- Der Server arbeitet auch ohne diese Migration weiter — fehlt die
-- Funktion, fällt er auf das alte Verhalten zurück und meldet es
-- laut. Ein MCP-Zugang, der wegen einer fehlenden Migration
-- komplett stillsteht, wäre der schlimmere Ausfall.
-- ============================================================

-- ════════════════════════════════════════════════════════════
-- Reservierung: zählen und eintragen unter einem Lock
--
-- SECURITY INVOKER mit Absicht: Aufrufen soll das nur der Server
-- mit dem Service-Role-Schlüssel. `authenticated` bekommt KEIN
-- EXECUTE — anders als bei den Rechte-Hilfsfunktionen aus
-- sql/modul/14, die die RLS selbst braucht. Wer im Browser
-- Protokollzeilen schreiben könnte, könnte das Protokoll
-- verwässern; und die RLS von `mcp_audit` kennt ohnehin keine
-- INSERT-Policy.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.mcp_aufruf_reservieren(
  p_aufruf_id       UUID,
  p_token_id        UUID,
  p_profile_id      UUID,
  p_tool            TEXT,
  p_argumente       JSONB,
  p_grenze          INTEGER,
  p_fenster_minuten INTEGER
)
RETURNS TABLE (erlaubt BOOLEAN, anzahl INTEGER)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  v_anzahl INTEGER;
BEGIN
  IF p_aufruf_id IS NULL OR p_profile_id IS NULL OR p_tool IS NULL THEN
    RAISE EXCEPTION 'mcp_aufruf_reservieren: Aufruf, Person und Werkzeug sind Pflicht';
  END IF;
  IF p_grenze IS NULL OR p_grenze < 1 OR p_fenster_minuten IS NULL OR p_fenster_minuten < 1 THEN
    RAISE EXCEPTION 'mcp_aufruf_reservieren: Grenze und Fenster müssen positiv sein';
  END IF;

  -- Der Kern der Sache: Reservierungen derselben Person laufen
  -- hintereinander. Der Lock hängt an der Transaktion und fällt mit
  -- ihr — die Funktion wird über PostgREST pro Aufruf in einer
  -- eigenen Transaktion ausgeführt, er ist also nur so lange
  -- gehalten, wie Zählen und Eintragen dauern. Pro Person, nicht
  -- global: zwei verschiedene Zugänge bremsen sich nicht gegenseitig.
  PERFORM pg_advisory_xact_lock(hashtextextended('mcp_kontingent:' || p_profile_id::TEXT, 0));

  -- Gezählt wird pro PERSON und über `mcp_audit` — wie bisher
  -- (Index idx_mcp_audit_profile auf (profile_id, created_at DESC)).
  SELECT count(*) INTO v_anzahl
    FROM public.mcp_audit a
   WHERE a.profile_id = p_profile_id
     AND a.created_at >= now() - make_interval(mins => p_fenster_minuten);

  IF v_anzahl >= p_grenze THEN
    RETURN QUERY SELECT false, v_anzahl;
    RETURN;
  END IF;

  -- Verbraucht, bevor das Werkzeug läuft. `erfolg`/`fehler` führt
  -- der Server nach dem Werkzeug nach (aufrufAbschliessen).
  INSERT INTO public.mcp_audit (id, token_id, profile_id, tool, argumente, erfolg, fehler)
  VALUES (p_aufruf_id, p_token_id, p_profile_id, p_tool, p_argumente, false, 'Aufruf nicht abgeschlossen');

  RETURN QUERY SELECT true, v_anzahl + 1;
END;
$$;

COMMENT ON FUNCTION public.mcp_aufruf_reservieren(UUID, UUID, UUID, TEXT, JSONB, INTEGER, INTEGER) IS
  'Reserviert einen MCP-Werkzeugaufruf: zaehlt die Aufrufe der Person im '
  'Fenster und traegt die mcp_audit-Zeile ein, beides unter einem '
  'Advisory-Lock pro Person. erlaubt = false heisst: Kontingent '
  'ausgeschoepft, keine Zeile geschrieben. Grenze und Fenster gibt der '
  'Server vor (src/mcp/auth.ts).';

REVOKE ALL ON FUNCTION public.mcp_aufruf_reservieren(UUID, UUID, UUID, TEXT, JSONB, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_aufruf_reservieren(UUID, UUID, UUID, TEXT, JSONB, INTEGER, INTEGER) TO service_role;


-- ════════════════════════════════════════════════════════════
-- Selbstprüfung — zeigt nach dem Einspielen, dass alles sitzt
-- ════════════════════════════════════════════════════════════
SELECT 'Pruefung' AS pruefung, 'Ergebnis' AS ergebnis, 'Erwartet' AS erwartet
UNION ALL
SELECT 'mcp_aufruf_reservieren vorhanden (muss 1 sein)',
       count(*)::text, '1'
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'mcp_aufruf_reservieren'
UNION ALL
SELECT 'service_role darf sie ausfuehren (muss true sein)',
       has_function_privilege('service_role',
         'public.mcp_aufruf_reservieren(uuid,uuid,uuid,text,jsonb,integer,integer)', 'EXECUTE')::text, 'true'
UNION ALL
SELECT 'anon und authenticated duerfen NICHT (muss ff sein)',
       left(has_function_privilege('anon',
              'public.mcp_aufruf_reservieren(uuid,uuid,uuid,text,jsonb,integer,integer)', 'EXECUTE')::text, 1)
         || left(has_function_privilege('authenticated',
              'public.mcp_aufruf_reservieren(uuid,uuid,uuid,text,jsonb,integer,integer)', 'EXECUTE')::text, 1), 'ff'
UNION ALL
SELECT 'Index fuer das Zaehlen vorhanden (muss 1 sein)',
       count(*)::text, '1'
  FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'mcp_audit' AND indexname = 'idx_mcp_audit_profile';
