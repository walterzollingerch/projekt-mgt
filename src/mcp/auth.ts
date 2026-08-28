import { createClient } from '@supabase/supabase-js'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
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
 */
export async function tokenAufloesen(supabase: Db, token: string | null | undefined): Promise<AuthErgebnis> {
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
  if (profile.role !== 'admin' && !profile.can_use_projects)
    return { ok: false, grund: 'Diesem Profil fehlt das Recht «Projekt-Mgt verwenden».' }

  return {
    ok: true,
    identitaet: { tokenId: row.id, tokenName: row.name, profile },
  }
}

// ── Ratelimit ───────────────────────────────────────────────
//
// Gezählt wird in mcp_audit, wo ohnehin jeder Werkzeugaufruf landet —
// keine zusätzliche Tabelle nötig. Begrenzt werden damit die
// Werkzeugaufrufe, nicht initialize/tools-list; genau die sind der
// teure Teil (jeder erzeugt Datenbankabfragen, manche verschicken
// Mails).
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

/** Aufruf protokollieren (Nachvollziehbarkeit externer Zugriffe) */
export async function protokollieren(
  supabase: Db,
  identitaet: McpIdentitaet,
  tool: string,
  argumente: unknown,
  erfolg: boolean,
  fehler?: string
): Promise<void> {
  const { error } = await supabase.from('mcp_audit').insert({
    token_id: identitaet.tokenId,
    profile_id: identitaet.profile.id,
    tool,
    argumente: (argumente ?? null) as never,
    erfolg,
    fehler: fehler ?? null,
  })
  if (error) console.error('MCP: Audit-Eintrag fehlgeschlagen:', error)
}
