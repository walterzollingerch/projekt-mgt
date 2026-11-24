import { toolListe, toolAusfuehren, TOOL_MAP, type Kontext } from './tools'
import {
  aufrufAbschliessen,
  aufrufReservieren,
  projektWerkzeugeErlaubt,
  MCP_RATELIMIT_TEXT,
} from './auth'
import type { McpWerkzeugErgebnis, McpZusatz } from './erweiterung'

// ============================================================
// Minimale, zustandslose Umsetzung des Model Context Protocol
// (JSON-RPC 2.0 über HTTP POST, «Streamable HTTP»-Transport).
//
// Bewusst ohne SDK und ohne Sitzungsverwaltung: Vercel-Functions
// halten keinen Zustand zwischen Aufrufen, und jede Anfrage bringt
// den Token mit. Der Server antwortet auf POST direkt mit JSON —
// das erlaubt die Spezifikation ausdrücklich, ein SSE-Stream ist
// nicht nötig, weil dieser Server nie von sich aus etwas sendet.
// ============================================================

export const SERVER_NAME = 'ttportal-projekt-mgt'
export const SERVER_VERSION = '1.0.0'

/** Vom Server unterstützte Protokollversionen, neueste zuerst */
const VERSIONEN = ['2025-06-18', '2025-03-26', '2024-11-05']

const ANLEITUNG = `Dieser Server gibt Zugriff auf das Modul «Projekt-Mgt» des Tom Talent Portals.

Begriffe: Ein Projekt gehört zu einer Firma und hat Mitglieder. Aufgaben (Tasks) liegen in Projekten, haben meist ein Fälligkeitsdatum (ohne Datum gelten sie als fällig, nicht als überfällig) und höchstens eine zuständige Person — diese muss Mitglied des Projekts sein. Aufgaben können in Ordnern gruppiert werden und eine Ebene tief Unter-Aufgaben haben. «Schliessen» archiviert eine Aufgabe; gelöscht wird nur in Ausnahmefällen. Tags sind eine zweite, projektübergreifende Ordnung: sie gehören zur FIRMA, stehen in allen ihren Projekten bereit und eine Aufgabe kann beliebig viele tragen (list_tasks und search_tasks filtern danach).

Eigene Tasks: Jede Person hat zusätzlich ein persönliches Projekt «Eigene Tasks» (in list_projects an «persoenlich: true» erkennbar). Es gehört zu keiner Firma, hat genau ein Mitglied und ist für alle anderen unsichtbar — auch für Administratoren. Aufgaben darin sind immer der Person selbst zugewiesen, tragen keine Tags und lösen keine E-Mails aus. Was nur die Person selbst betrifft, gehört dorthin und nicht in ein Firmenprojekt.

Vertraulich: Eine Aufgabe kann «vertraulich» sein (Feld vertraulich in den Aufgaben, setzbar mit create_task und update_task). Dann sehen sie samt Notizen nur die zuständige Person, wer sie erstellt hat, die Beobachter und Administratoren — andere Projektmitglieder nicht. Unter-Aufgaben folgen ihrem Mutter-Task. Inhalte vertraulicher Aufgaben nicht an Personen weitergeben, die nicht beteiligt sind.

Vorgehen: Beginne mit list_projects, um IDs zu bekommen. Alle Parameter, die auf «_id» enden, erwarten die UUID aus dem Portal, niemals einen Namen — schlage IDs bei Bedarf mit list_projects, list_people, list_tags oder search_tasks nach.

Wichtig: Änderungen wirken sofort im Portal und lösen automatisch E-Mails an die betroffenen Personen aus (Zuweisung, Änderung, Schliessen, neue Notiz). Frage im Zweifel nach, bevor du schreibst.`

interface JsonRpcAnfrage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export const FEHLER = {
  parse: -32700,
  ungueltigeAnfrage: -32600,
  methodeUnbekannt: -32601,
  ungueltigeParameter: -32602,
  intern: -32603,
} as const

export function rpcFehler(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function rpcErgebnis(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

/**
 * Eine einzelne JSON-RPC-Nachricht verarbeiten.
 * Rückgabe `null` = Benachrichtigung ohne Antwort.
 */
export async function nachrichtVerarbeiten(
  ctx: Kontext,
  msg: JsonRpcAnfrage,
  zusatz: McpZusatz | null = null
): Promise<object | null> {
  const id = msg?.id ?? null
  const methode = msg?.method

  if (typeof methode !== 'string')
    return rpcFehler(id, FEHLER.ungueltigeAnfrage, 'Feld «method» fehlt.')

  // Benachrichtigungen (kein id-Feld) werden quittiert, nicht beantwortet
  if (methode.startsWith('notifications/')) return null

  // Ohne Zusatz wie bisher: Projekt-Werkzeuge immer (das Recht hat
  // tokenAufloesen dann schon verlangt)
  const mitProjekt = !zusatz || (zusatz.projektWerkzeuge && projektWerkzeugeErlaubt(ctx.identitaet.profile))

  switch (methode) {
    case 'initialize': {
      const gewuenscht = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : null
      const version = gewuenscht && VERSIONEN.includes(gewuenscht) ? gewuenscht : VERSIONEN[0]
      return rpcErgebnis(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: SERVER_NAME,
          title: zusatz ? 'Tom Talent Portal' : 'Tom Talent Portal — Projekt-Mgt',
          version: SERVER_VERSION,
        },
        instructions: [mitProjekt ? ANLEITUNG : null, zusatz?.anleitung ?? null].filter(Boolean).join('\n\n'),
      })
    }

    case 'ping':
      return rpcErgebnis(id, {})

    case 'tools/list':
      return rpcErgebnis(id, { tools: [...(mitProjekt ? toolListe() : []), ...(zusatz?.werkzeuge ?? [])] })

    case 'tools/call': {
      const name = msg.params?.name
      if (typeof name !== 'string')
        return rpcFehler(id, FEHLER.ungueltigeParameter, 'Feld «name» fehlt.')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>

      // Kontingent für genau diesen Aufruf verbrauchen, BEVOR das
      // Werkzeug läuft — sonst sehen gleichzeitige Aufrufe alle
      // denselben Zählerstand. Die Reservierung schreibt zugleich die
      // Protokollzeile; ihre Kennung bekommen die App-Werkzeuge mit.
      const aufruf = await aufrufReservieren(ctx.supabase, ctx.identitaet, name, args)
      if (!aufruf.erlaubt)
        // Als fachliches Ergebnis, nicht als Protokollfehler: so sagt
        // das Modell der Person, warum es aufhört. Die nächste Anfrage
        // beantwortet der Server mit 429 (handler.ts).
        return rpcErgebnis(id, { content: [{ type: 'text', text: MCP_RATELIMIT_TEXT }], isError: true })

      let ergebnis: McpWerkzeugErgebnis
      if (TOOL_MAP.has(name) || !zusatz) {
        ergebnis = mitProjekt
          ? await toolAusfuehren(ctx, name, args)
          : { erfolg: false, fehler: 'Dieser Zugang bietet das Projekt-Mgt nicht an.' }
      } else if (zusatz.werkzeuge.some(w => w.name === name)) {
        ergebnis = await zusatz.ausfuehren(name, args, { id: aufruf.id })
      } else {
        ergebnis = { erfolg: false, fehler: `Unbekanntes Werkzeug «${name}».` }
      }
      await aufrufAbschliessen(
        ctx.supabase,
        aufruf.id,
        ergebnis.erfolg,
        ergebnis.erfolg ? undefined : ergebnis.fehler
      )

      // Fachliche Fehler kommen als isError-Ergebnis zurück (nicht als
      // Protokollfehler) — so kann das Modell darauf reagieren.
      return rpcErgebnis(id, ergebnis.erfolg
        ? { content: [{ type: 'text', text: JSON.stringify(ergebnis.daten, null, 2) }], isError: false }
        : { content: [{ type: 'text', text: ergebnis.fehler }], isError: true })
    }

    // Nicht angeboten, aber manche Clients fragen trotzdem an
    case 'resources/list':
      return rpcErgebnis(id, { resources: [] })
    case 'resources/templates/list':
      return rpcErgebnis(id, { resourceTemplates: [] })
    case 'prompts/list':
      return rpcErgebnis(id, { prompts: [] })

    default:
      return rpcFehler(id, FEHLER.methodeUnbekannt, `Methode «${methode}» wird nicht unterstützt.`)
  }
}

/**
 * Text für einen abgelehnten Stapel. Nennt die Spezifikation, damit
 * der Fehler für einen Client-Entwickler nicht nach Laune aussieht.
 */
export const MCP_STAPEL_TEXT =
  'Stapel (JSON-Arrays) nimmt dieser Server nicht an. Der Rumpf eines POST muss genau eine ' +
  'JSON-RPC-Nachricht sein — seit der Protokollfassung 2025-06-18 kennt MCP kein Batching mehr. ' +
  'Bitte die Nachrichten einzeln senden.'

/**
 * Eine Nachricht verarbeiten. Ein Stapel wird abgelehnt — siehe
 * `mcpPost`, das ihn schon vor der Token-Prüfung abfängt; diese
 * Prüfung ist die zweite Verteidigungslinie für andere Aufrufer.
 */
export async function anfrageVerarbeiten(
  ctx: Kontext,
  koerper: unknown,
  zusatz: McpZusatz | null = null
): Promise<object | object[] | null> {
  if (Array.isArray(koerper)) return rpcFehler(null, FEHLER.ungueltigeAnfrage, MCP_STAPEL_TEXT)
  if (!koerper || typeof koerper !== 'object')
    return rpcFehler(null, FEHLER.ungueltigeAnfrage, 'Ungültige JSON-RPC-Nachricht.')
  return nachrichtVerarbeiten(ctx, koerper as JsonRpcAnfrage, zusatz)
}
