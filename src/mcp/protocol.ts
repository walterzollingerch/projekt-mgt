import { toolListe, toolAusfuehren, type Kontext } from './tools'
import { protokollieren } from './auth'

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

Begriffe: Ein Projekt gehört zu einer Firma und hat Mitglieder. Aufgaben (Tasks) liegen in Projekten, haben immer ein Fälligkeitsdatum und höchstens eine zuständige Person — diese muss Mitglied des Projekts sein. Aufgaben können in Ordnern gruppiert werden und eine Ebene tief Unter-Aufgaben haben. «Schliessen» archiviert eine Aufgabe; gelöscht wird nur in Ausnahmefällen. Tags sind eine zweite, projektübergreifende Ordnung: sie gehören zur FIRMA, stehen in allen ihren Projekten bereit und eine Aufgabe kann beliebig viele tragen (list_tasks und search_tasks filtern danach).

Eigene Tasks: Jede Person hat zusätzlich ein persönliches Projekt «Eigene Tasks» (in list_projects an «persoenlich: true» erkennbar). Es gehört zu keiner Firma, hat genau ein Mitglied und ist für alle anderen unsichtbar — auch für Administratoren. Aufgaben darin sind immer der Person selbst zugewiesen, tragen keine Tags und lösen keine E-Mails aus. Was nur die Person selbst betrifft, gehört dorthin und nicht in ein Firmenprojekt.

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
  msg: JsonRpcAnfrage
): Promise<object | null> {
  const id = msg?.id ?? null
  const methode = msg?.method

  if (typeof methode !== 'string')
    return rpcFehler(id, FEHLER.ungueltigeAnfrage, 'Feld «method» fehlt.')

  // Benachrichtigungen (kein id-Feld) werden quittiert, nicht beantwortet
  if (methode.startsWith('notifications/')) return null

  switch (methode) {
    case 'initialize': {
      const gewuenscht = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : null
      const version = gewuenscht && VERSIONEN.includes(gewuenscht) ? gewuenscht : VERSIONEN[0]
      return rpcErgebnis(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: SERVER_NAME,
          title: 'Tom Talent Portal — Projekt-Mgt',
          version: SERVER_VERSION,
        },
        instructions: ANLEITUNG,
      })
    }

    case 'ping':
      return rpcErgebnis(id, {})

    case 'tools/list':
      return rpcErgebnis(id, { tools: toolListe() })

    case 'tools/call': {
      const name = msg.params?.name
      if (typeof name !== 'string')
        return rpcFehler(id, FEHLER.ungueltigeParameter, 'Feld «name» fehlt.')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>

      const ergebnis = await toolAusfuehren(ctx, name, args)
      await protokollieren(
        ctx.supabase,
        ctx.identitaet,
        name,
        args,
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

/** Einzelnachricht oder Stapel verarbeiten */
export async function anfrageVerarbeiten(ctx: Kontext, koerper: unknown): Promise<object | object[] | null> {
  if (Array.isArray(koerper)) {
    const antworten = await Promise.all(koerper.map(m => nachrichtVerarbeiten(ctx, m as JsonRpcAnfrage)))
    const gefiltert = antworten.filter((a): a is object => a !== null)
    return gefiltert.length > 0 ? gefiltert : null
  }
  if (!koerper || typeof koerper !== 'object')
    return rpcFehler(null, FEHLER.ungueltigeAnfrage, 'Ungültige JSON-RPC-Nachricht.')
  return nachrichtVerarbeiten(ctx, koerper as JsonRpcAnfrage)
}
