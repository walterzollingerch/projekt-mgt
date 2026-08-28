import { NextRequest, NextResponse } from 'next/server'
import { serviceClient, tokenAufloesen, nutzungStempeln, ratelimitPruefen, MCP_RATELIMIT_TEXT } from './auth'
import { anfrageVerarbeiten, rpcFehler, FEHLER, SERVER_NAME, SERVER_VERSION } from './protocol'

// Gemeinsamer HTTP-Teil des MCP-Servers für beide Einstiegspunkte:
// /api/mcp/<token> (Token im Pfad — für Claude Desktop, claude.ai
// und alles, was nur eine URL entgegennimmt) und /api/mcp mit
// Authorization: Bearer <token> (für Clients, die Header setzen
// können, z.B. Claude Code).

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS })
}

/** Token aus dem Authorization-Header lesen (Bearer oder blank) */
export function tokenAusHeader(request: NextRequest): string | null {
  const auth = request.headers.get('authorization')
  if (!auth) return null
  const treffer = /^Bearer\s+(.+)$/i.exec(auth.trim())
  return treffer ? treffer[1].trim() : auth.trim()
}

export function mcpOptions() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

/**
 * GET beantwortet die Spezifikation mit «kein Server-Stream» —
 * dieser Server sendet nie von sich aus Nachrichten.
 */
export function mcpGet() {
  return json(
    rpcFehler(null, FEHLER.ungueltigeAnfrage, 'Dieser Server bietet keinen Server-Sent-Events-Stream an. Bitte JSON-RPC per POST senden.'),
    405
  )
}

/** DELETE beendet eine Sitzung — der Server ist zustandslos, also ein No-op */
export function mcpDelete() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function mcpPost(request: NextRequest, token: string | null): Promise<NextResponse> {
  let koerper: unknown
  try {
    koerper = await request.json()
  } catch {
    return json(rpcFehler(null, FEHLER.parse, 'Ungültiges JSON.'), 400)
  }

  const supabase = serviceClient()
  const auth = await tokenAufloesen(supabase, token)
  if (!auth.ok) {
    return json(
      {
        ...rpcFehler(null, FEHLER.ungueltigeAnfrage, auth.grund),
        server: `${SERVER_NAME}/${SERVER_VERSION}`,
      },
      401
    )
  }

  // Aufrufkontingent prüfen, bevor irgendein Werkzeug läuft. 429 ist der
  // richtige Code — Clients und Modelle erkennen ihn als «später nochmal»,
  // während ein 4xx aus der Fachlogik als endgültiger Fehler gilt.
  const limit = await ratelimitPruefen(supabase, auth.identitaet.profile.id)
  if (!limit.erlaubt) {
    console.warn(
      `MCP: Ratelimit erreicht — Token ${auth.identitaet.tokenId} (${auth.identitaet.tokenName}), ` +
      `Profil ${auth.identitaet.profile.id}, ${limit.anzahl} Aufrufe im Fenster`
    )
    return json(rpcFehler(null, FEHLER.ungueltigeAnfrage, MCP_RATELIMIT_TEXT), 429)
  }

  const ctx = { supabase, identitaet: auth.identitaet }
  const antwort = await anfrageVerarbeiten(ctx, koerper)

  // Awaited — auf Vercel wird die Function nach der Response
  // eingefroren, nicht awaitete Promises laufen sonst nie
  await nutzungStempeln(supabase, auth.identitaet.tokenId)

  // Reine Benachrichtigungen (z.B. notifications/initialized) werden
  // laut Spezifikation mit 202 ohne Rumpf quittiert
  if (antwort === null) return new NextResponse(null, { status: 202, headers: CORS })
  return json(antwort)
}
