// ============================================================
// Import von Aufgaben aus einer CSV-Datei.
//
// Gelesen wird das Format der Todoist-Projektvorlage («Export as
// template → CSV»). Todoist kann exportieren, wir nicht importieren —
// diese Datei schliesst die Lücke. Das Format passt gut auf unser
// Modell:
//
//   section          → Ordner
//   task, INDENT 1   → Aufgabe
//   task, INDENT 2   → Unter-Aufgabe der letzten Aufgabe mit INDENT 1
//   CONTENT          → Titel
//   DESCRIPTION      → Beschreibung
//   RESPONSIBLE      → Zuständige Person (Zuordnung siehe unten)
//   DATE / DEADLINE  → Fälligkeit
//
// Ignoriert werden PRIORITY, DURATION, IS_COLLAPSED, AUTHOR und die
// Sprach-/Zeitzonenspalten: dafür gibt es hier keine Entsprechung,
// und etwas zu erfinden wäre schlimmer als es wegzulassen.
//
// Diese Datei ist bewusst frei von Datenbank und Netz — sie liest
// Text und liefert einen Plan. Geschrieben wird erst, wenn jemand
// die Vorschau gesehen und bestätigt hat.
// ============================================================

/** Eine Person aus der Mitgliederliste des Zielprojekts */
export interface ImportMitglied {
  id: string
  full_name: string
  email: string
}

export interface ImportAufgabe {
  titel: string
  beschreibung: string | null
  /** Name der Sektion aus der Datei; null = ohne Ordner */
  ordner: string | null
  /** Rohtext aus RESPONSIBLE, z.B. «Beat (379540)» */
  zustaendigRoh: string | null
  /** Aufgelöst gegen die Projektmitglieder; null = niemand */
  zustaendigId: string | null
  /** YYYY-MM-DD, sofern die Datei ein lesbares Datum enthielt */
  faellig: string | null
  unterAufgaben: ImportAufgabe[]
}

export interface ImportPlan {
  /** Ordnernamen in der Reihenfolge ihres Auftretens */
  ordner: string[]
  aufgaben: ImportAufgabe[]
  /** Summe inklusive Unter-Aufgaben */
  anzahl: number
  anzahlUnterAufgaben: number
  /** Aufgaben ohne lesbares Datum — sie bekommen die Ersatzfälligkeit */
  ohneDatum: number
  /**
   * Personen aus RESPONSIBLE, zu denen sich kein Projektmitglied
   * finden liess. Ihre Aufgaben entstehen ohne Zuständige.
   */
  unbekanntePersonen: string[]
  /** Alles, was jemand vor dem Schreiben wissen sollte */
  warnungen: string[]
}

const MAX_TITEL = 300
const MAX_BESCHREIBUNG = 5000

// ------------------------------------------------------------
// CSV
// ------------------------------------------------------------

/**
 * Zerlegt CSV nach RFC 4180: Felder in Anführungszeichen dürfen
 * Kommas und Zeilenumbrüche enthalten, zwei Anführungszeichen
 * hintereinander stehen für eines im Text.
 *
 * Bewusst von Hand statt mit einer Bibliothek: das Modul liefert
 * TypeScript-Quellen aus und soll keine Abhängigkeit dazubekommen,
 * die beide Apps mitschleppen müssen.
 */
export function csvZerlegen(text: string): string[][] {
  // Byte Order Mark: Excel und Todoist stellen ihn Dateien voran, im
  // ersten Feld würde er als unsichtbares Zeichen landen
  const roh = text.replace(/^\uFEFF/, '')
  const zeilen: string[][] = []
  let zeile: string[] = []
  let feld = ''
  let inZitat = false

  for (let i = 0; i < roh.length; i++) {
    const c = roh[i]
    if (inZitat) {
      if (c === '"') {
        if (roh[i + 1] === '"') { feld += '"'; i++ }
        else inZitat = false
      } else {
        feld += c
      }
      continue
    }
    if (c === '"') { inZitat = true; continue }
    if (c === ',') { zeile.push(feld); feld = ''; continue }
    if (c === '\r') continue
    if (c === '\n') { zeile.push(feld); zeilen.push(zeile); zeile = []; feld = ''; continue }
    feld += c
  }
  if (feld !== '' || zeile.length > 0) { zeile.push(feld); zeilen.push(zeile) }
  return zeilen
}

// ------------------------------------------------------------
// Einzelne Felder
// ------------------------------------------------------------

/**
 * Fälligkeit aus DATE oder DEADLINE. Todoist schreibt dort je nach
 * Aufgabe ein Datum oder eine Wiederholungsregel im Klartext
 * («every 2 weeks») — Letzteres ergibt hier null, die Aufgabe
 * bekommt dann die Ersatzfälligkeit. Wiederholungen wandern
 * absichtlich nicht mit: die drei Regeln des Moduls decken Todoists
 * Möglichkeiten nicht ab, und eine falsch geratene Wiederholung
 * erzeugt auf Dauer falsche Aufgaben.
 */
export function datumLesen(roh: string | undefined): string | null {
  const wert = (roh ?? '').trim()
  if (!wert) return null

  const iso = wert.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`

  const deutsch = wert.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
  if (deutsch) {
    const [, tag, monat, jahr] = deutsch
    return `${jahr}-${monat.padStart(2, '0')}-${tag.padStart(2, '0')}`
  }
  return null
}

/**
 * Person zu einem RESPONSIBLE-Eintrag suchen.
 *
 * Todoist schreibt dort «Anzeigename (ID)» — der Anzeigename ist oft
 * nur ein Vorname, die ID gehört zu Todoist und nützt uns nichts.
 * Gesucht wird deshalb der Reihe nach: E-Mail, vollständiger Name,
 * und erst zuletzt ein einzelnes Namensteil. Passt Letzteres auf
 * mehrere Mitglieder, bleibt die Aufgabe unzugewiesen — lieber
 * niemand als die falsche Person.
 */
export function personFinden(roh: string | null, mitglieder: ImportMitglied[]): ImportMitglied | null {
  const wert = (roh ?? '').replace(/\s*\(\d+\)\s*$/, '').trim().toLowerCase()
  if (!wert) return null

  const perMail = mitglieder.find(m => m.email.toLowerCase() === wert)
  if (perMail) return perMail

  const perName = mitglieder.find(m => m.full_name.toLowerCase() === wert)
  if (perName) return perName

  const treffer = mitglieder.filter(m =>
    m.full_name.toLowerCase().split(/\s+/).includes(wert)
  )
  return treffer.length === 1 ? treffer[0] : null
}

// ------------------------------------------------------------
// Plan
// ------------------------------------------------------------

/** Spaltennummern aus der Kopfzeile; Todoist stellt sie nicht um, verlassen wollen wir uns aber nicht darauf */
function spalten(kopf: string[]): Record<string, number> {
  const karte: Record<string, number> = {}
  kopf.forEach((name, i) => { karte[name.trim().toUpperCase()] = i })
  return karte
}

export type ImportErgebnis =
  | { ok: true; plan: ImportPlan }
  | { ok: false; fehler: string }

/**
 * Liest die Datei und baut den Plan. Schreibt nichts — der Plan ist
 * die Grundlage für die Vorschau.
 */
export function planLesen(text: string, mitglieder: ImportMitglied[]): ImportErgebnis {
  const zeilen = csvZerlegen(text)
  const kopfNr = zeilen.findIndex(z => (z[0] ?? '').trim().toUpperCase() === 'TYPE')
  if (kopfNr === -1)
    return { ok: false, fehler: 'Das sieht nicht nach einer Todoist-Vorlage aus — die Kopfzeile mit «TYPE» fehlt.' }

  const s = spalten(zeilen[kopfNr])
  if (s.CONTENT === undefined)
    return { ok: false, fehler: 'In der Kopfzeile fehlt die Spalte «CONTENT» — ohne sie gibt es keine Titel.' }

  const warnungen: string[] = []
  const unbekannte = new Set<string>()
  const ordner: string[] = []
  const aufgaben: ImportAufgabe[] = []
  let aktuellerOrdner: string | null = null
  let letzteMutter: ImportAufgabe | null = null
  let ohneDatum = 0
  let unterAufgaben = 0
  let gekuerzt = 0
  let zuTief = 0

  for (let i = kopfNr + 1; i < zeilen.length; i++) {
    const z = zeilen[i]
    const typ = (z[0] ?? '').trim().toLowerCase()
    const inhalt = (z[s.CONTENT] ?? '').trim()

    if (typ === 'section') {
      // Eine Sektion beendet die laufende Aufgabengruppe
      aktuellerOrdner = inhalt || null
      letzteMutter = null
      if (aktuellerOrdner && !ordner.includes(aktuellerOrdner)) ordner.push(aktuellerOrdner)
      continue
    }
    if (typ !== 'task') continue          // meta, Leerzeilen, Unbekanntes
    if (!inhalt) continue

    let titel = inhalt
    if (titel.length > MAX_TITEL) { titel = titel.slice(0, MAX_TITEL); gekuerzt++ }

    const beschreibungRoh = (z[s.DESCRIPTION] ?? '').trim()
    const faellig = datumLesen(z[s.DATE]) ?? datumLesen(z[s.DEADLINE])
    if (!faellig) ohneDatum++

    const zustaendigRoh = (z[s.RESPONSIBLE] ?? '').trim() || null
    const person = personFinden(zustaendigRoh, mitglieder)
    if (zustaendigRoh && !person) unbekannte.add(zustaendigRoh.replace(/\s*\(\d+\)\s*$/, '').trim())

    const aufgabe: ImportAufgabe = {
      titel,
      beschreibung: beschreibungRoh ? beschreibungRoh.slice(0, MAX_BESCHREIBUNG) : null,
      ordner: aktuellerOrdner,
      zustaendigRoh,
      zustaendigId: person?.id ?? null,
      faellig,
      unterAufgaben: [],
    }

    const einzug = Number.parseInt((z[s.INDENT] ?? '1').trim(), 10) || 1
    if (einzug > 1 && letzteMutter) {
      if (einzug > 2) zuTief++
      letzteMutter.unterAufgaben.push(aufgabe)
      unterAufgaben++
    } else {
      aufgaben.push(aufgabe)
      letzteMutter = aufgabe
    }
  }

  if (aufgaben.length === 0)
    return { ok: false, fehler: 'In der Datei stehen keine Aufgaben.' }

  if (gekuerzt > 0)
    warnungen.push(gekuerzt === 1
      ? `Ein Titel ist länger als ${MAX_TITEL} Zeichen und wird gekürzt.`
      : `${gekuerzt} Titel sind länger als ${MAX_TITEL} Zeichen und werden gekürzt.`)
  if (zuTief > 0)
    warnungen.push(zuTief === 1
      ? 'Eine Aufgabe liegt tiefer als zwei Ebenen. Das Modul kennt nur eine Ebene Unter-Aufgaben — sie hängt sich an die nächsthöhere Aufgabe.'
      : `${zuTief} Aufgaben liegen tiefer als zwei Ebenen. Das Modul kennt nur eine Ebene Unter-Aufgaben — sie hängen sich an die nächsthöhere Aufgabe.`)
  if (unbekannte.size > 0)
    warnungen.push(`Nicht zuordenbar: ${[...unbekannte].join(', ')}. Diese Aufgaben entstehen ohne Zuständige — nur Projektmitglieder sind wählbar.`)

  return {
    ok: true,
    plan: {
      ordner,
      aufgaben,
      anzahl: aufgaben.length + unterAufgaben,
      anzahlUnterAufgaben: unterAufgaben,
      ohneDatum,
      unbekanntePersonen: [...unbekannte],
      warnungen,
    },
  }
}
