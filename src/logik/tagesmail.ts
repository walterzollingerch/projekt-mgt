import type { Db } from '../typen'
import { sendTagesmail, type TagesmailTask } from '../mail/taskMail'

// ============================================================
// Tägliche Aufgaben-Mail.
//
// Wer sie in der Übersicht abonniert hat (Tabelle
// `aufgaben_tagesmail`, sql/modul/12), bekommt an jedem Arbeitstag
// eine Mail mit ALLEN eigenen offenen Aufgaben — zuoberst die, die in
// höchstens fünf Arbeitstagen fällig oder schon überfällig sind.
//
// «Eigene» heisst: mir zugewiesen. Aufgaben ohne zuständige Person
// oder aus archivierten Projekten erscheinen nicht — dieselbe Regel
// wie in der Fälligkeitsliste der Übersicht.
//
// Ausgelöst wird der Versand von der App (Cron/n8n) mit einem
// Service-Role-Client; die Funktion selbst kennt keine
// Authentifizierung. Arbeitstage sind Montag bis Freitag — Feiertage
// kennt das Modul nicht, sie gehören der App.
// ============================================================

/** Wie weit der Abschnitt «bald fällig» vorausschaut */
export const TAGESMAIL_ARBEITSTAGE = 5

/** Pause zwischen zwei Mails — Resend erlaubt wenige Aufrufe pro Sekunde */
const PAUSE_MS = 600

const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/

/** Heutiges Datum (YYYY-MM-DD) in der Zeitzone der Apps */
export function heuteZuerich(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' })
}

function wochentag(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay()
}

export function istWochenende(iso: string): boolean {
  const t = wochentag(iso)
  return t === 0 || t === 6
}

/**
 * Das Datum `n` Arbeitstage (Mo–Fr) nach `iso`. Aufgaben mit
 * Fälligkeit bis und mit diesem Datum gelten als «bald fällig».
 * Beispiel: Donnerstag + 5 → Donnerstag der Folgewoche.
 */
export function arbeitstageSpaeter(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  let rest = n
  while (rest > 0) {
    d.setUTCDate(d.getUTCDate() + 1)
    const t = d.getUTCDay()
    if (t !== 0 && t !== 6) rest--
  }
  return d.toISOString().slice(0, 10)
}

/** Grenze für «bald fällig» ab heute */
export function faelligkeitsGrenze(heute: string = heuteZuerich()): string {
  return arbeitstageSpaeter(heute, TAGESMAIL_ARBEITSTAGE)
}

// ── Versand (App, mit Service Role) ────────────────────────────

export interface TagesmailOptionen {
  /** Stichtag (YYYY-MM-DD), Standard heute in Zürich */
  heute?: string
  /** Nur an diese Person — auch ohne Abo (Probe-Mail) */
  nurProfil?: string
  /** Auch am Wochenende und trotz bereits erfolgtem Versand heute */
  erzwingen?: boolean
}

export interface TagesmailErgebnis {
  stichtag: string
  grenze: string
  abonnenten: number
  gesendet: number
  /** Keine offene Aufgabe → keine Mail */
  ohneAufgaben: number
  /** Heute schon bekommen, gesperrt oder ohne Modul-Recht */
  uebersprungen: number
  fehlgeschlagen: number
  /** Gesetzt, wenn der Lauf gar nicht erst stattfand (Wochenende) */
  hinweis?: string
}

interface Empfaenger {
  id: string
  email: string
  full_name: string
  is_blocked: boolean
  role: string
  can_use_projects: boolean
  can_manage_projects: boolean
  zuletzt_gesendet_am: string | null
}

type ProjektEmbed = { id: string; name: string; status: 'aktiv' | 'archiviert'; company: { name: string } | null } | null

async function ladeEmpfaenger(db: Db, nurProfil?: string): Promise<Empfaenger[]> {
  const profilSpalten = 'id, email, full_name, is_blocked, role, can_use_projects, can_manage_projects'
  if (nurProfil) {
    const { data, error } = await db.from('profiles').select(profilSpalten).eq('id', nurProfil).maybeSingle()
    if (error) throw error
    return data ? [{ ...data, zuletzt_gesendet_am: null }] : []
  }
  const { data, error } = await db
    .from('aufgaben_tagesmail')
    .select(`zuletzt_gesendet_am, profil:profiles(${profilSpalten})`)
  if (error) throw error
  return ((data ?? []) as unknown as { zuletzt_gesendet_am: string | null; profil: Omit<Empfaenger, 'zuletzt_gesendet_am'> | null }[])
    .flatMap(z => z.profil ? [{ ...z.profil, zuletzt_gesendet_am: z.zuletzt_gesendet_am }] : [])
}

async function ladeOffeneAufgaben(db: Db, profileId: string): Promise<TagesmailTask[]> {
  const { data, error } = await db
    .from('tasks')
    .select('id, titel, due_date, project_id, parent_task_id, project:projects!inner(id, name, status, company:companies(name))')
    .eq('assignee_id', profileId)
    .eq('status', 'offen')
    .eq('project.status', 'aktiv')
    .order('due_date', { ascending: true })
    .limit(1000)
  if (error) throw error
  return ((data ?? []) as unknown as { id: string; titel: string; due_date: string; project_id: string; parent_task_id: string | null; project: ProjektEmbed }[])
    .map(t => ({
      id: t.id,
      titel: t.titel,
      due_date: t.due_date,
      project_id: t.project_id,
      projektName: t.project?.name ?? '',
      firmaName: t.project?.company?.name ?? null,
      istUnterTask: !!t.parent_task_id,
    }))
}

function darfModulNutzen(p: Empfaenger): boolean {
  return !p.is_blocked && !!p.email?.includes('@') && (p.role === 'admin' || p.can_use_projects || p.can_manage_projects)
}

const warte = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Verschickt die Tagesmail an alle Abonnent:innen. Eine Person ohne
 * offene Aufgabe bekommt nichts. Wer heute schon eine bekommen hat,
 * wird übersprungen — ein doppelt ausgelöster Lauf schadet nicht.
 */
export async function tagesmailVersenden(db: Db, optionen: TagesmailOptionen = {}): Promise<TagesmailErgebnis> {
  const stichtag = optionen.heute && DATUM_RE.test(optionen.heute) ? optionen.heute : heuteZuerich()
  const grenze = faelligkeitsGrenze(stichtag)
  const ergebnis: TagesmailErgebnis = {
    stichtag, grenze, abonnenten: 0, gesendet: 0, ohneAufgaben: 0, uebersprungen: 0, fehlgeschlagen: 0,
  }

  if (istWochenende(stichtag) && !optionen.erzwingen) {
    return { ...ergebnis, hinweis: 'Wochenende — kein Versand.' }
  }

  const empfaenger = await ladeEmpfaenger(db, optionen.nurProfil)
  ergebnis.abonnenten = empfaenger.length

  let erste = true
  for (const person of empfaenger) {
    if (!darfModulNutzen(person) || (!optionen.erzwingen && person.zuletzt_gesendet_am === stichtag)) {
      ergebnis.uebersprungen++
      continue
    }

    let aufgaben: TagesmailTask[]
    try {
      aufgaben = await ladeOffeneAufgaben(db, person.id)
    } catch (fehler) {
      console.error(`Tagesmail: Aufgaben für ${person.id} nicht ladbar:`, fehler)
      ergebnis.fehlgeschlagen++
      continue
    }
    if (aufgaben.length === 0) {
      ergebnis.ohneAufgaben++
      continue
    }

    if (!erste) await warte(PAUSE_MS)
    erste = false

    const ok = await sendTagesmail({
      to: person.email,
      empfaengerName: person.full_name,
      stichtag,
      grenze,
      arbeitstage: TAGESMAIL_ARBEITSTAGE,
      baldFaellig: aufgaben.filter(t => t.due_date <= grenze),
      weitere: aufgaben.filter(t => t.due_date > grenze),
    })
    if (!ok) {
      ergebnis.fehlgeschlagen++
      continue
    }
    ergebnis.gesendet++

    // Erst nach dem Versand markieren: scheitert er, versucht es ein
    // zweiter Lauf am selben Tag erneut. Die Probe-Mail an eine
    // einzelne Person markiert nichts.
    if (!optionen.nurProfil) {
      const { error } = await db
        .from('aufgaben_tagesmail')
        .update({ zuletzt_gesendet_am: stichtag })
        .eq('profile_id', person.id)
      if (error) console.error('Tagesmail: zuletzt_gesendet_am nicht gesetzt:', error)
    }
  }

  return ergebnis
}
