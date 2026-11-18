import { createClient } from '@supabase/supabase-js'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import type { Db, ProjektMgtDatabase } from '../typen'

// ============================================================
// Authentifizierung des MCP-Servers.
//
// Externe Stakeholder haben keine Portal-Session (kein Cookie), sie
// weisen sich mit einem persönlichen Token aus. Der Token steckt
// entweder im Pfad (…/api/mcp/<token>) oder im Authorization-Header.
// Gespeichert ist nur der SHA-256-Hash.
//
// Der Zugriff auf die Daten läuft danach mit dem Service-Role-
// Schlüssel — die RLS greift dort NICHT. Die Rechteprüfung
// übernimmt deshalb `src/lib/mcp/guard.ts`.
// ============================================================

export function serviceClient(): Db {
  return createClient<ProjektMgtDatabase>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )
}

/** Neuen Klartext-Token erzeugen (43 Zeichen, URL-sicher) */
export function neuerToken(): string {
  return randomBytes(32).toString('base64url')
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface McpIdentitaet {
  tokenId: string
  tokenName: string
  profile: {
    id: string
    email: string
    full_name: string
    /** Die Gastgeber-Apps benennen die Nicht-Admin-Rolle verschieden
     *  ('mitarbeiter' im Portal, 'user' in Terramay). Geprüft wird
     *  überall nur auf 'admin', deshalb hier bewusst offen. */
    role: string
    is_blocked: boolean
    can_manage_projects: boolean
    can_use_projects: boolean
  }
}

export type AuthErgebnis =
  | { ok: true; identitaet: McpIdentitaet }
  | { ok: false; grund: string }

/**
 * Token prüfen und die dahinterliegende Person auflösen.
 * Schlägt fehl bei unbekanntem, widerrufenem oder abgelaufenem
 * Token, bei gesperrtem Profil und wenn die Person das Projekt-Mgt
 * gar nicht benutzen darf.
 *
 * `ohneProjektRecht`: Die letzte Prüfung entfällt — für Zugänge mit
 * App-Werkzeugen (erweiterung.ts), die auch ohne Projekt-Mgt etwas
 * anbieten. Die Projekt-Werkzeuge blendet dann `projektWerkzeugeErlaubt`
 * aus.
 */
export async function tokenAufloesen(
  supabase: Db,
  token: string | null | undefined,
  optionen: { ohneProjektRecht?: boolean } = {}
): Promise<AuthErgebnis> {
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 200)
    return { ok: false, grund: 'Kein gültiger Zugang. Bitte die persönliche MCP-Adresse aus dem Portal verwenden.' }

  const hash = tokenHash(token)
  const { data: row } = await supabase
    .from('mcp_tokens')
    .select('id, name, token_hash, profile_id, revoked_at, expires_at')
    .eq('token_hash', hash)
    .maybeSingle()

  if (!row) return { ok: false, grund: 'Zugang unbekannt oder gelöscht.' }

  // Der Lookup läuft bereits über den Hash; der zusätzliche
  // konstantzeitige Vergleich schadet nicht.
  const a = Buffer.from(row.token_hash)
  const b = Buffer.from(hash)
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return { ok: false, grund: 'Zugang unbekannt oder gelöscht.' }

  if (row.revoked_at) return { ok: false, grund: 'Dieser Zugang wurde widerrufen.' }
  if (row.expires_at && new Date(row.expires_at) < new Date())
    return { ok: false, grund: 'Dieser Zugang ist abgelaufen.' }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, is_blocked, can_manage_projects, can_use_projects')
    .eq('id', row.profile_id)
    .single()

  if (!profile) return { ok: false, grund: 'Das zugehörige Benutzerprofil existiert nicht mehr.' }
  if (profile.is_blocked) return { ok: false, grund: 'Das zugehörige Benutzerprofil ist gesperrt.' }
  if (!optionen.ohneProjektRecht && !projektWerkzeugeErlaubt(profile))
    return { ok: false, grund: 'Diesem Profil fehlt das Recht «Projekt-Mgt verwenden».' }

  return {
    ok: true,
    identitaet: { tokenId: row.id, tokenName: row.name, profile },
  }
}

/** Darf diese Person die Projekt-Mgt-Werkzeuge überhaupt benutzen */
export function projektWerkzeugeErlaubt(profile: McpIdentitaet['profile']): boolean {
  return profile.role === 'admin' || profile.can_use_projects
}

// ── Ratelimit ───────────────────────────────────────────────
//
// Gezählt wird in mcp_audit, wo ohnehin jeder Werkzeugaufruf landet —
// keine zusätzliche Tabelle nötig. Begrenzt werden damit die
// Werkzeugaufrufe, nicht initialize/tools-list; genau die sind der
// teure Teil (jeder erzeugt Datenbankabfragen, manche verschicken
// Mails).
//
// Verbraucht wird das Kontingent in `aufrufReservieren()` weiter
// unten — einmal pro Werkzeugaufruf, vor der Ausführung, serialisiert
// in der Datenbank. `ratelimitPruefen()` ist nur die billige Vorprüfung
// am Anfang der HTTP-Anfrage, die den richtigen Statuscode (429) geben
// kann; sie allein wäre durchlässig, sobald mehrere Aufrufe
// gleichzeitig laufen.
//
// Grosszügig bemessen: Ein Modell, das an einem Projekt arbeitet,
// macht ohne Weiteres 50 Aufrufe in wenigen Minuten. Die Grenze soll
// Dauerschleifen und massenhaftes Abgreifen bremsen, nicht normales
// Arbeiten.
const MCP_FENSTER_MINUTEN = 10
const MCP_MAX_PRO_FENSTER = 300

export interface RatelimitErgebnis {
  erlaubt: boolean
  anzahl: number
}

/**
 * Prüft, ob dieser Token sein Aufrufkontingent ausgeschöpft hat.
 *
 * Bewusst FAIL-OPEN, anders als die Bremse beim Passwort-Zurücksetzen:
 * Dort verzögert ein Fehlschlag nur eine Verwaltungsaufgabe. Hier
 * würde er den Zugang externer Beteiligter komplett lahmlegen, und
 * zwar wegen eines Datenbankfehlers, der nichts mit Missbrauch zu tun
 * hat. Der Fehlerfall wird laut protokolliert.
 */
export async function ratelimitPruefen(supabase: Db, profileId: string): Promise<RatelimitErgebnis> {
  const seit = new Date(Date.now() - MCP_FENSTER_MINUTEN * 60 * 1000).toISOString()
  // Gezählt wird pro PERSON, nicht pro Token. Zwei Gründe: fachlich soll ein
  // zweiter Zugang derselben Person nicht das doppelte Kontingent geben, und
  // mcp_audit hat einen Index auf (profile_id, created_at DESC), aber keinen
  // auf token_id — die Abfrage bliebe sonst mit wachsender Tabelle hängen.
  const { count, error } = await supabase
    .from('mcp_audit')
    .select('id', { count: 'exact', head: true })
    .eq('profile_id', profileId)
    .gte('created_at', seit)

  if (error) {
    console.error('MCP: Ratelimit konnte nicht geprüft werden (Aufruf wird durchgelassen):', error)
    return { erlaubt: true, anzahl: 0 }
  }
  const anzahl = count ?? 0
  return { erlaubt: anzahl < MCP_MAX_PRO_FENSTER, anzahl }
}

export const MCP_RATELIMIT_TEXT =
  `Zu viele Aufrufe: mehr als ${MCP_MAX_PRO_FENSTER} in ${MCP_FENSTER_MINUTEN} Minuten. Bitte kurz warten und dann fortfahren.`

/** Zeitstempel der letzten Nutzung nachführen (Fehler sind egal) */
export async function nutzungStempeln(supabase: Db, tokenId: string): Promise<void> {
  const { error } = await supabase
    .from('mcp_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', tokenId)
  if (error) console.error('MCP: last_used_at konnte nicht gesetzt werden:', error)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const istUuid = (v: unknown) => typeof v === 'string' && UUID_RE.test(v)

/**
 * Was von den Werkzeug-Argumenten ins Protokoll darf: IDs, Zahlen und
 * Ja/Nein — von allen übrigen Feldern nur der Name (`felder`).
 *
 * mcp_audit lesen alle Admins. Titel, Beschreibungen, Notizen und
 * Suchbegriffe aus «Eigene Tasks» oder vertraulichen Aufgaben gehören
 * dort nicht hin; nachvollziehbar bleibt trotzdem, wer welche Aufgabe in
 * welchem Projekt angefasst und welche Felder dabei gesetzt hat.
 */
export function protokollArgumente(argumente: unknown): Record<string, unknown> | null {
  if (!argumente || typeof argumente !== 'object' || Array.isArray(argumente)) return null
  const aus: Record<string, unknown> = {}
  const felder: string[] = []
  for (const [k, v] of Object.entries(argumente)) {
    const id = /(^id|_id)$/.test(k) && (v === null || istUuid(v))
    const ids = /_ids$/.test(k) && Array.isArray(v) && v.every(istUuid)
    if (id || ids || typeof v === 'boolean' || typeof v === 'number') aus[k] = v
    else felder.push(k)
  }
  if (felder.length) aus.felder = felder
  return aus
}

// ── Aufruf reservieren und abschliessen ─────────────────────
//
// Ein Werkzeugaufruf bekommt seine Protokollzeile, BEVOR er läuft:
// `mcp_aufruf_reservieren()` (sql/modul/15) zählt und trägt in einer
// Anweisung ein, serialisiert pro Person. Damit kann sich kein zweiter
// Aufruf — in derselben Anfrage oder in einer gleichzeitigen — auf
// denselben Zählerstand berufen.
//
// Nach dem Werkzeug führt `aufrufAbschliessen()` das Ergebnis nach.
// Eine Zeile, die auf «Aufruf nicht abgeschlossen» stehen bleibt, ist
// ein Aufruf, dessen Function-Instanz unterwegs aufgehört hat.

/** Steht in `mcp_audit.fehler`, solange der Aufruf läuft */
export const MCP_AUFRUF_OFFEN = 'Aufruf nicht abgeschlossen'

export interface AufrufReservierung {
  /** Kennung dieses einen Werkzeugaufrufs — gleich der `id` der
   *  `mcp_audit`-Zeile. Wird den App-Werkzeugen mitgegeben
   *  (erweiterung.ts), damit auch sie pro Aufruf reservieren können. */
  id: string
  erlaubt: boolean
  /** Stand des Zählers nach dieser Reservierung (0 = unbekannt) */
  anzahl: number
}

/** Plan B: Zeile ohne Reservierung eintragen (Fail-open, s.u.) */
async function zeileEintragen(
  supabase: Db,
  identitaet: McpIdentitaet,
  id: string,
  tool: string,
  argumente: unknown
): Promise<void> {
  const { error } = await supabase.from('mcp_audit').insert({
    id,
    token_id: identitaet.tokenId,
    profile_id: identitaet.profile.id,
    tool,
    argumente: protokollArgumente(argumente) as never,
    erfolg: false,
    fehler: MCP_AUFRUF_OFFEN,
  })
  if (error) console.error('MCP: Audit-Eintrag fehlgeschlagen:', error)
}

/**
 * Kontingent für genau diesen Werkzeugaufruf verbrauchen.
 *
 * Bewusst FAIL-OPEN wie `ratelimitPruefen()`: Fehlt die Funktion
 * (Migration 15 noch nicht eingespielt) oder antwortet die Datenbank
 * nicht, läuft der Aufruf — und die Zeile entsteht auf dem alten Weg,
 * weiterhin vor der Ausführung. Ein MCP-Zugang, der wegen eines
 * Datenbankfehlers komplett stillsteht, wäre der schlimmere Ausfall;
 * die Grenze bleibt dann so durchlässig, wie sie vorher war.
 */
export async function aufrufReservieren(
  supabase: Db,
  identitaet: McpIdentitaet,
  tool: string,
  argumente: unknown
): Promise<AufrufReservierung> {
  const id = randomUUID()
  const { data, error } = await supabase.rpc('mcp_aufruf_reservieren', {
    p_aufruf_id: id,
    p_token_id: identitaet.tokenId,
    p_profile_id: identitaet.profile.id,
    p_tool: tool,
    p_argumente: protokollArgumente(argumente) as never,
    p_grenze: MCP_MAX_PRO_FENSTER,
    p_fenster_minuten: MCP_FENSTER_MINUTEN,
  })

  const zeile = Array.isArray(data) ? data[0] : data
  if (!error && zeile && typeof zeile.erlaubt === 'boolean') {
    if (!zeile.erlaubt)
      console.warn(
        `MCP: Kontingent ausgeschöpft — Token ${identitaet.tokenId} (${identitaet.tokenName}), ` +
        `Profil ${identitaet.profile.id}, ${zeile.anzahl} Aufrufe im Fenster, Werkzeug ${tool}`
      )
    return { id, erlaubt: zeile.erlaubt, anzahl: zeile.anzahl ?? 0 }
  }

  console.error(
    'MCP: Aufruf konnte nicht reserviert werden (wird durchgelassen):',
    error ?? 'Reservierung ohne Ergebnis'
  )
  await zeileEintragen(supabase, identitaet, id, tool, argumente)
  return { id, erlaubt: true, anzahl: 0 }
}

/** Ergebnis des Werkzeugs in der reservierten Zeile nachführen */
export async function aufrufAbschliessen(
  supabase: Db,
  aufrufId: string,
  erfolg: boolean,
  fehler?: string
): Promise<void> {
  const { data, error } = await supabase
    .from('mcp_audit')
    .update({ erfolg, fehler: fehler ?? null })
    .eq('id', aufrufId)
    .select('id')
  if (error) console.error('MCP: Audit-Eintrag konnte nicht nachgeführt werden:', error)
  else if (!data?.length) console.error(`MCP: Keine Protokollzeile zum Aufruf ${aufrufId} gefunden`)
}
