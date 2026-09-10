import { NextRequest, NextResponse } from 'next/server'
import { createTask, updateTask, addTaskNote } from '../logik/service'
import { istGueltigeAktion, aktionKurz, type ScreeningAktion } from '../logik/screening'
import { angemeldet, istAbbruch } from './helfer'
import type { Db, Json } from '../typen'

// ============================================================
// Ausführung eines bestätigten Screening-Plans.
//
// Was hier ankommt, hat ein Mensch in der Vorschau gesehen,
// abgewählt und womöglich von Hand geändert — bis hin zu einem
// anderen Zielprojekt. Geprüft wird deshalb nur die FORM; ob die
// Person darf, was sie ausgelöst hat, entscheidet die RLS: gearbeitet
// wird mit ihrem eigenen Client über dieselben Service-Funktionen wie
// beim Bearbeiten von Hand. Ein Screening kann damit nie mehr als sie
// selbst.
//
// Eine gescheiterte Aktion stoppt die übrigen nicht. Bei einem
// Dutzend Aktionen ist «drei liefen, eine nicht, hier ist der Grund»
// brauchbarer als ein Rückzieher auf alles.
// ============================================================

export const maxDuration = 120

/** Mehr als das ist kein bestätigter Vorschlag mehr */
const MAX_AKTIONEN = 50
const ANHANG_MAX_BYTES = 10 * 1024 * 1024
const SCREENING_BUCKET = 'screening-dokumente'
const ANHANG_BUCKET = 'task-attachments'
const MAX_NOTIZ = 5000

interface Dokument {
  /** Pfad im Bucket `screening-dokumente`, beginnt mit der eigenen Profil-ID */
  pfad: string
  name: string
}

interface AktionErgebnis {
  nr: number
  typ: string
  ok: boolean
  /** Kurzform der ausgeführten Aktion bzw. der Grund des Scheiterns */
  meldung: string
  /** Bei «neu» die ID der entstandenen Aufgabe */
  taskId?: string
}

export async function POST(request: NextRequest) {
  const a = await angemeldet()
  if (istAbbruch(a)) return a
  const { supabase, userId } = a

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Ungültige Anfrage.' }, { status: 400 })
  }
  const {
    aktionen: roheAktionen,
    mailsSenden,
    dokument,
    projektId,
  } = body as {
    aktionen?: unknown
    mailsSenden?: unknown
    dokument?: unknown
    projektId?: unknown
  }

  if (!Array.isArray(roheAktionen) || roheAktionen.length === 0) {
    return NextResponse.json({ error: 'Keine Aktionen zum Ausführen.' }, { status: 400 })
  }
  if (roheAktionen.length > MAX_AKTIONEN) {
    return NextResponse.json({ error: `Höchstens ${MAX_AKTIONEN} Aktionen auf einmal.` }, { status: 400 })
  }

  const aktionen: ScreeningAktion[] = []
  for (const roh of roheAktionen) {
    if (!istGueltigeAktion(roh)) {
      return NextResponse.json({ error: 'Eine der Aktionen hat eine ungültige Form.' }, { status: 400 })
    }
    aktionen.push(roh)
  }

  const ohneMail = !mailsSenden
  const beleg = pruefeDokument(dokument, userId)

  const ergebnisse: AktionErgebnis[] = []
  for (const aktion of aktionen) {
    ergebnisse.push(await fuehreAus(supabase, userId, aktion, ohneMail, beleg))
  }

  // Protokoll. Scheitert es, ist das kein Grund, die bereits
  // ausgeführten Aktionen als Fehlschlag zu melden — die Änderungen
  // stehen längst in den Aufgaben.
  const { error: protokollFehler } = await supabase.from('screening_laeufe').insert({
    profile_id: userId,
    project_id: typeof projektId === 'string' ? projektId : null,
    datei_pfad: beleg?.pfad ?? null,
    datei_name: beleg?.name ?? null,
    mails_gesendet: !ohneMail,
    aktionen: aktionen as unknown as Json,
    ergebnis: ergebnisse as unknown as Json,
  })
  if (protokollFehler) console.error('Screening-Lauf konnte nicht protokolliert werden:', protokollFehler)

  return NextResponse.json({
    ergebnisse,
    erfolgreich: ergebnisse.filter(e => e.ok).length,
    gescheitert: ergebnisse.filter(e => !e.ok).length,
  })
}

/**
 * Das Dokument darf nur aus dem eigenen Ordner im Screening-Bucket
 * stammen. Der erste Pfadabschnitt ist die Profil-ID der hochladenden
 * Person — dieselbe Bindung, die auch die Storage-Policy zieht.
 */
function pruefeDokument(dokument: unknown, userId: string): Dokument | null {
  if (!dokument || typeof dokument !== 'object') return null
  const d = dokument as Record<string, unknown>
  if (typeof d.pfad !== 'string' || typeof d.name !== 'string') return null
  if (!d.pfad.startsWith(`${userId}/`) || d.pfad.includes('..')) return null
  return { pfad: d.pfad, name: d.name }
}

async function fuehreAus(
  supabase: Db,
  userId: string,
  aktion: ScreeningAktion,
  ohneMail: boolean,
  beleg: Dokument | null
): Promise<AktionErgebnis> {
  const basis = { nr: aktion.nr, typ: aktion.typ }
  try {
    switch (aktion.typ) {
      case 'neu': {
        const r = await createTask(
          supabase,
          userId,
          {
            project_id: aktion.projektId,
            titel: aktion.titel,
            beschreibung: aktion.beschreibung,
            assignee_id: aktion.zustaendigId,
            due_date: aktion.faellig,
            folder_id: aktion.ordnerId,
            tag_ids: aktion.tagIds,
          },
          { ohneMail }
        )
        return r.ok
          ? { ...basis, ok: true, meldung: aktionKurz(aktion), taskId: r.data.task.id }
          : { ...basis, ok: false, meldung: r.error }
      }

      case 'aktualisieren': {
        // Nur mitschicken, was sich ändert: `updateTask` deutet die
        // Anwesenheit eines Schlüssels als Änderungswunsch — ein
        // durchgereichtes `beschreibung: null` würde die vorhandene
        // Beschreibung löschen.
        const input: Record<string, unknown> = {}
        if (aktion.titel) input.titel = aktion.titel
        if (aktion.beschreibung) input.beschreibung = aktion.beschreibung
        if (aktion.zustaendigId) input.assignee_id = aktion.zustaendigId
        if (aktion.faellig) input.due_date = aktion.faellig
        if (aktion.projektId) input.project_id = aktion.projektId

        const r = await updateTask(supabase, userId, aktion.taskId, input, { ohneMail })
        return r.ok
          ? { ...basis, ok: true, meldung: aktionKurz(aktion), taskId: aktion.taskId }
          : { ...basis, ok: false, meldung: r.error }
      }

      case 'notiz':
      case 'schliessen': {
        // Schliessen ohne Notiztext: reines Schliessen, ohne Notiz
        if (aktion.typ === 'schliessen' && !aktion.text) {
          const r = await updateTask(supabase, userId, aktion.taskId, { action: 'schliessen' }, { ohneMail })
          return r.ok
            ? { ...basis, ok: true, meldung: aktionKurz(aktion), taskId: aktion.taskId }
            : { ...basis, ok: false, meldung: r.error }
        }

        const anhang = beleg ? await anhangKopieren(supabase, beleg, aktion.taskId) : null
        const r = await addTaskNote(
          supabase,
          userId,
          aktion.taskId,
          {
            text: mitHerkunft(aktion.text!, beleg),
            file_path: anhang?.pfad,
            file_name: anhang?.name,
            schliessen: aktion.typ === 'schliessen',
          },
          { ohneMail }
        )
        if (!r.ok) return { ...basis, ok: false, meldung: r.error }
        // Notiz gespeichert, Schliessen gescheitert (z.B. offene
        // Unter-Aufgaben) — das ist ein Teilerfolg und muss sichtbar
        // sein, sonst gilt die Aufgabe fälschlich als erledigt.
        if (r.data.abschlussFehler) {
          return { ...basis, ok: false, meldung: `Notiz gespeichert, aber nicht geschlossen: ${r.data.abschlussFehler}` }
        }
        return { ...basis, ok: true, meldung: aktionKurz(aktion), taskId: aktion.taskId }
      }
    }
  } catch (err) {
    console.error('Screening-Aktion fehlgeschlagen:', aktion.typ, err)
    return { ...basis, ok: false, meldung: 'Unerwarteter Fehler bei dieser Aktion.' }
  }
}

/**
 * Hängt dem Notiztext an, woher er stammt. Ohne diesen Hinweis steht
 * die Notiz später da, als hätte sie jemand von Hand getippt — und
 * niemand kann nachvollziehen, aus welchem Protokoll sie kam.
 */
function mitHerkunft(text: string, beleg: Dokument | null): string {
  const hinweis = beleg
    ? `\n\n— aus «${beleg.name}» (Dokument-Screening)`
    : '\n\n— aus einem Dokument-Screening'
  return (text.length + hinweis.length > MAX_NOTIZ ? text.slice(0, MAX_NOTIZ - hinweis.length) : text) + hinweis
}

/**
 * Kopiert das Dokument in den Anhang-Bucket. Nötig, weil
 * `addTaskNote` einen Pfad unterhalb der Task-ID verlangt (dort
 * hängen die Storage-Policies der Anhänge) — der Screening-Bucht
 * ordnet dagegen nach Person.
 *
 * Scheitert die Kopie, entsteht die Notiz trotzdem, nur ohne Anhang:
 * der Text ist das Wesentliche.
 */
async function anhangKopieren(
  supabase: Db,
  beleg: Dokument,
  taskId: string
): Promise<{ pfad: string; name: string } | null> {
  try {
    const { data: blob, error } = await supabase.storage.from(SCREENING_BUCKET).download(beleg.pfad)
    if (error || !blob || blob.size > ANHANG_MAX_BYTES) return null

    const endung = beleg.name.includes('.') ? beleg.name.slice(beleg.name.lastIndexOf('.')) : ''
    const ziel = `${taskId}/${crypto.randomUUID()}${endung}`
    const { error: uploadFehler } = await supabase.storage
      .from(ANHANG_BUCKET)
      .upload(ziel, blob, { contentType: blob.type || 'application/octet-stream' })
    if (uploadFehler) return null

    return { pfad: ziel, name: beleg.name }
  } catch (err) {
    console.error('Anhang konnte nicht kopiert werden:', err)
    return null
  }
}
