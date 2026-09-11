'use client'
import { useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Pencil, Quote, Sparkles, XCircle } from 'lucide-react'
import Button from './Button'
import Modal from './Modal'
import Input from './Input'
import TagChip from './TagChip'
import { createClient } from '../supabaseBrowser'
import { formatDate } from '../../hilfen'
import { TAG_CHIP_WAEHLBAR } from '../../logik/tags'
import type { ScreeningAktion, ScreeningKontext, ScreeningPlan } from '../../logik/screening'
import type { T } from '../texte'

// ============================================================
// Dokument-Screening: Dokument rein, Vorschlag raus, Mensch
// entscheidet.
//
// Drei Schritte in einem Dialog:
//   1. eingabe   — Datei oder Text
//   2. vorschau  — jede Aktion einzeln an-/abwählbar und änderbar
//   3. ergebnis  — was lief, was nicht
//
// Der zweite Schritt ist der Grund für das Ganze. Ausgeführt wird
// ausschliesslich, was hier stehen bleibt und angehakt ist — der
// Vorschlag selbst löst nichts aus.
// ============================================================

const BUCKET = 'screening-dokumente'
/** Grosszügig genug für Protokolle, klein genug für die Analyse (PDF-Limit 7 MB) */
const MAX_BYTES = 7 * 1024 * 1024
const ERLAUBTE_TYPEN = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']

interface Person {
  id: string
  full_name: string
}

interface ScreeningDialogProps {
  open: boolean
  onClose: () => void
  projekt: { id: string; name: string }
  mitglieder: Person[]
  ordner: { id: string; name: string }[]
  tags: { id: string; name: string; farbe: string }[]
  /** Projekte, in die eine Aufgabe stattdessen gelegt werden kann */
  andereProjekte: { id: string; name: string }[]
  screening: { analyseUrl: string; ausfuehrenUrl: string }
  /** Sprache der Person (`de`, `pt`, `en`) — in ihr antwortet das Modell. Ohne Angabe Deutsch. */
  sprache?: string
  userId: string
  txt: T
  /** Nach der Ausführung: Ansicht neu laden */
  onFertig: () => void
}

type Schritt = 'eingabe' | 'vorschau' | 'ergebnis'

interface AktionErgebnis {
  nr: number
  typ: string
  ok: boolean
  meldung: string
}

/** Eine Aktion in der Vorschau, mit dem, was die Oberfläche zusätzlich braucht */
interface Zeile {
  aktion: ScreeningAktion
  gewaehlt: boolean
  offen: boolean
  bearbeiten: boolean
}

export default function ScreeningDialog({
  open,
  onClose,
  projekt,
  mitglieder,
  ordner,
  tags,
  andereProjekte,
  screening,
  sprache,
  userId,
  txt,
  onFertig,
}: ScreeningDialogProps) {
  const supabase = createClient()
  const [schritt, setSchritt] = useState<Schritt>('eingabe')
  const [fehler, setFehler] = useState('')
  const [laeuft, setLaeuft] = useState(false)

  // Eingabe
  const [datei, setDatei] = useState<File | null>(null)
  const [freitext, setFreitext] = useState('')
  const dateiRef = useRef<HTMLInputElement>(null)

  // Vorschau
  const [plan, setPlan] = useState<ScreeningPlan | null>(null)
  const [kontext, setKontext] = useState<ScreeningKontext | null>(null)
  const [zeilen, setZeilen] = useState<Zeile[]>([])
  const [mailsSenden, setMailsSenden] = useState(false)
  const [anhaengen, setAnhaengen] = useState(false)
  /** Pfad des hochgeladenen Dokuments, solange es im Bucket liegt */
  const [dokument, setDokument] = useState<{ pfad: string; name: string } | null>(null)

  // Ergebnis
  const [ergebnisse, setErgebnisse] = useState<AktionErgebnis[]>([])

  const zuruecksetzen = () => {
    setSchritt('eingabe')
    setFehler('')
    setLaeuft(false)
    setDatei(null)
    setFreitext('')
    setPlan(null)
    setKontext(null)
    setZeilen([])
    setMailsSenden(false)
    setAnhaengen(false)
    setDokument(null)
    setErgebnisse([])
    if (dateiRef.current) dateiRef.current.value = ''
  }

  const schliessen = () => {
    // Das Dokument liegt nur bis zur Entscheidung im Bucket. Bleibt
    // es liegen, sammeln sich Protokolle und Offerten dort an, die
    // niemand mehr braucht — aufräumen gehört zum Schliessen.
    if (dokument) void supabase.storage.from(BUCKET).remove([dokument.pfad])
    zuruecksetzen()
    onClose()
  }

  // ----------------------------------------------------------
  // Schritt 1: analysieren
  // ----------------------------------------------------------

  const analysieren = async () => {
    setFehler('')
    if (!datei && !freitext.trim()) {
      setFehler(txt('Bitte eine Datei wählen oder Text einfügen.'))
      return
    }
    setLaeuft(true)

    let quelle: Record<string, unknown>
    let hochgeladen: { pfad: string; name: string } | null = null

    if (datei) {
      if (datei.size > MAX_BYTES) {
        setLaeuft(false)
        setFehler(txt('Die Datei ist zu gross (höchstens 7 MB).'))
        return
      }
      const endung = datei.name.includes('.') ? datei.name.slice(datei.name.lastIndexOf('.')) : ''
      const pfad = `${userId}/${crypto.randomUUID()}${endung}`
      const { error: uploadFehler } = await supabase.storage.from(BUCKET).upload(pfad, datei)
      if (uploadFehler) {
        setLaeuft(false)
        setFehler(txt('Die Datei konnte nicht hochgeladen werden.'))
        return
      }
      hochgeladen = { pfad, name: datei.name }
      quelle = { typ: 'upload', pfad, name: datei.name }
    } else {
      quelle = { typ: 'text', inhalt: freitext }
    }

    try {
      const res = await fetch(screening.analyseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projektId: projekt.id, quelle, sprache }),
      })
      const daten = await res.json()
      if (!res.ok) {
        setFehler(daten.error || txt('Die Analyse ist fehlgeschlagen.'))
        setLaeuft(false)
        return
      }
      const neuerPlan = daten.plan as ScreeningPlan
      setPlan(neuerPlan)
      setKontext(daten.kontext as ScreeningKontext)
      setDokument(hochgeladen)
      setZeilen(
        neuerPlan.aktionen.map(a => ({
          aktion: a,
          // Schliessen ist die einzige Aktion, die etwas wegnimmt —
          // sie beginnt abgewählt und muss bewusst gesetzt werden.
          gewaehlt: a.typ !== 'schliessen',
          offen: false,
          bearbeiten: false,
        }))
      )
      setSchritt('vorschau')
    } catch {
      setFehler(txt('Die Analyse ist fehlgeschlagen.'))
    }
    setLaeuft(false)
  }

  // ----------------------------------------------------------
  // Schritt 2: ausführen
  // ----------------------------------------------------------

  const ausfuehren = async () => {
    const gewaehlt = zeilen.filter(z => z.gewaehlt).map(z => z.aktion)
    if (gewaehlt.length === 0) {
      setFehler(txt('Es ist keine Aktion ausgewählt.'))
      return
    }
    setFehler('')
    setLaeuft(true)
    try {
      const res = await fetch(screening.ausfuehrenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aktionen: gewaehlt,
          mailsSenden,
          projektId: projekt.id,
          dokument: anhaengen ? dokument : null,
        }),
      })
      const daten = await res.json()
      if (!res.ok) {
        setFehler(daten.error || txt('Die Ausführung ist fehlgeschlagen.'))
        setLaeuft(false)
        return
      }
      setErgebnisse(daten.ergebnisse as AktionErgebnis[])
      // Das Dokument hat seinen Zweck erfüllt; was bleiben soll, ist
      // als Anhang kopiert.
      if (dokument) {
        void supabase.storage.from(BUCKET).remove([dokument.pfad])
        setDokument(null)
      }
      setSchritt('ergebnis')
      onFertig()
    } catch {
      setFehler(txt('Die Ausführung ist fehlgeschlagen.'))
    }
    setLaeuft(false)
  }

  // ----------------------------------------------------------
  // Hilfen für die Vorschau
  // ----------------------------------------------------------

  const taskTitel = (id: string) => kontext?.tasks.find(t => t.id === id)?.titel ?? txt('(unbekannte Aufgabe)')
  const personName = (id: string | null) =>
    id ? (mitglieder.find(p => p.id === id)?.full_name ?? txt('(unbekannt)')) : txt('niemand')
  const projektName = (id: string) =>
    id === projekt.id ? projekt.name : (andereProjekte.find(p => p.id === id)?.name ?? txt('(anderes Projekt)'))

  const setzeAktion = (index: number, aenderung: Partial<ScreeningAktion>) => {
    setZeilen(alt =>
      alt.map((z, i) => (i === index ? { ...z, aktion: { ...z.aktion, ...aenderung } as ScreeningAktion } : z))
    )
  }
  const setzeZeile = (index: number, aenderung: Partial<Zeile>) => {
    setZeilen(alt => alt.map((z, i) => (i === index ? { ...z, ...aenderung } : z)))
  }

  const anzahlGewaehlt = zeilen.filter(z => z.gewaehlt).length

  // ----------------------------------------------------------
  // Darstellung
  // ----------------------------------------------------------

  const titel =
    schritt === 'eingabe'
      ? txt('Dokument screenen')
      : schritt === 'vorschau'
        ? txt('Vorgeschlagene Aktionen')
        : txt('Ergebnis')

  const footer =
    schritt === 'eingabe' ? (
      <>
        <Button variant="ghost" onClick={schliessen}>{txt('Abbrechen')}</Button>
        <Button onClick={analysieren} loading={laeuft} disabled={!datei && !freitext.trim()}>
          <Sparkles size={14} /> {txt('Analysieren')}
        </Button>
      </>
    ) : schritt === 'vorschau' ? (
      <>
        <Button variant="ghost" onClick={schliessen}>{txt('Abbrechen')}</Button>
        <Button variant="outline" onClick={() => { setSchritt('eingabe'); setFehler('') }} disabled={laeuft}>
          {txt('Zurück')}
        </Button>
        <Button onClick={ausfuehren} loading={laeuft} disabled={anzahlGewaehlt === 0}>
          {txt(anzahlGewaehlt === 1 ? '{0} Aktion ausführen' : '{0} Aktionen ausführen', anzahlGewaehlt)}
        </Button>
      </>
    ) : (
      <Button onClick={schliessen}>{txt('Schliessen')}</Button>
    )

  return (
    <Modal open={open} onClose={schliessen} title={titel} size="xl" footer={footer}>
      {fehler && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">{fehler}</div>
      )}

      {schritt === 'eingabe' && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            {txt(
              'Lade ein Protokoll, eine Mail oder ein Dokument hoch. Daraus entsteht ein Vorschlag: welche Aufgaben eröffnet, aktualisiert oder mit einer Notiz ergänzt werden sollen. Ausgeführt wird nichts, bevor du es im nächsten Schritt bestätigt hast.'
            )}
          </p>

          <div>
            <label className="text-sm font-medium text-gray-700">{txt('Datei (PDF oder Bild)')}</label>
            <input
              ref={dateiRef}
              type="file"
              accept={ERLAUBTE_TYPEN.join(',')}
              onChange={e => {
                setFehler('')
                setDatei(e.target.files?.[0] ?? null)
              }}
              className="mt-1 block w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-[#eaf2f8] file:text-[#1a5276] hover:file:bg-[#d4e6f1]"
            />
          </div>

          <div className="flex items-center gap-3 text-xs text-gray-400">
            <span className="h-px flex-1 bg-gray-200" />
            {txt('oder')}
            <span className="h-px flex-1 bg-gray-200" />
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">{txt('Text einfügen')}</label>
            <textarea
              value={freitext}
              onChange={e => {
                setFehler('')
                setFreitext(e.target.value)
              }}
              rows={8}
              placeholder={txt('Mail-Inhalt oder Protokolltext hier einfügen …')}
              className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#1a5276] focus:border-transparent"
            />
          </div>

          <p className="text-xs text-gray-500">
            {txt(
              'Das Dokument wird für die Analyse an die Claude-API übermittelt und danach wieder gelöscht. Zugeordnet werden kann nur, was im Projekt «{0}» sichtbar ist.',
              projekt.name
            )}
          </p>
        </div>
      )}

      {schritt === 'vorschau' && plan && (
        <div className="space-y-4">
          {plan.zusammenfassung && (
            <div className="p-3 bg-[#eaf2f8] rounded-md text-sm text-gray-700">{plan.zusammenfassung}</div>
          )}

          {plan.warnungen.length > 0 && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-md space-y-1">
              {plan.warnungen.map((w, i) => (
                <p key={i} className="text-xs text-amber-800 flex gap-2">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  {w}
                </p>
              ))}
            </div>
          )}

          {zeilen.length === 0 ? (
            <p className="text-sm text-gray-500">
              {txt('Aus diesem Dokument liess sich keine Aktion ableiten.')}
            </p>
          ) : (
            <div className="space-y-2">
              {zeilen.map((z, i) => (
                <AktionZeile
                  key={i}
                  zeile={z}
                  index={i}
                  txt={txt}
                  mitglieder={mitglieder}
                  ordner={ordner}
                  tags={tags}
                  projekt={projekt}
                  andereProjekte={andereProjekte}
                  tasks={kontext?.tasks ?? []}
                  taskTitel={taskTitel}
                  personName={personName}
                  projektName={projektName}
                  setzeAktion={setzeAktion}
                  setzeZeile={setzeZeile}
                />
              ))}
            </div>
          )}

          <div className="pt-3 border-t border-gray-100 space-y-2">
            <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={mailsSenden}
                onChange={e => setMailsSenden(e.target.checked)}
                className="mt-0.5 rounded border-gray-300"
              />
              <span>
                {txt('Beteiligte per Mail informieren')}
                <span className="block text-xs text-gray-500">
                  {txt(
                    'Ohne Haken laufen alle Aktionen still. Mit Haken bekommt jede betroffene Person pro Aktion eine Mail — bei vielen Aktionen sind das viele Mails.'
                  )}
                </span>
              </span>
            </label>

            {dokument && (
              <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={anhaengen}
                  onChange={e => setAnhaengen(e.target.checked)}
                  className="mt-0.5 rounded border-gray-300"
                />
                <span>
                  {txt('Dokument an die Notizen anhängen')}
                  <span className="block text-xs text-gray-500">
                    {txt('«{0}» wird jeder Notiz dieses Laufs als Anhang beigelegt.', dokument.name)}
                  </span>
                </span>
              </label>
            )}
          </div>
        </div>
      )}

      {schritt === 'ergebnis' && (
        <div className="space-y-2">
          {ergebnisse.map((e, i) => {
            // Die Erfolgsmeldung baut die Oberfläche selbst — sie kennt
            // die Aktion und das Wörterbuch. Vom Server kommt nur der
            // Grund eines Scheiterns; der ist deutsch wie alle
            // Meldungen der Fachlogik.
            const aktion = zeilen.find(z => z.aktion.nr === e.nr)?.aktion
            const zielName = aktion ? (aktion.typ === 'neu' ? aktion.titel : taskTitel(aktion.taskId)) : ''
            const meldung = e.ok && aktion ? txt(ERFOLG[aktion.typ], zielName) : e.meldung
            return (
              <div
                key={i}
                className={`flex gap-2 items-start p-2 rounded-md text-sm ${e.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`}
              >
                {e.ok ? (
                  <CheckCircle2 size={15} className="shrink-0 mt-0.5" />
                ) : (
                  <XCircle size={15} className="shrink-0 mt-0.5" />
                )}
                <span>{meldung}</span>
              </div>
            )
          })}
          {ergebnisse.length === 0 && <p className="text-sm text-gray-500">{txt('Nichts ausgeführt.')}</p>}
        </div>
      )}
    </Modal>
  )
}

// ------------------------------------------------------------
// Eine Zeile der Vorschau
// ------------------------------------------------------------

const TYP_LABEL: Record<ScreeningAktion['typ'], string> = {
  notiz: 'Notiz',
  neu: 'Neue Aufgabe',
  aktualisieren: 'Änderung',
  schliessen: 'Abschluss',
}

/** Erfolgsmeldung im Ergebnis-Schritt; {0} ist Titel der Aufgabe */
const ERFOLG: Record<ScreeningAktion['typ'], string> = {
  notiz: 'Notiz an «{0}» angefügt',
  neu: 'Aufgabe «{0}» eröffnet',
  aktualisieren: '«{0}» geändert',
  schliessen: '«{0}» geschlossen',
}

const TYP_FARBE: Record<ScreeningAktion['typ'], string> = {
  notiz: 'bg-blue-50 text-blue-700 border-blue-200',
  neu: 'bg-green-50 text-green-700 border-green-200',
  aktualisieren: 'bg-amber-50 text-amber-700 border-amber-200',
  schliessen: 'bg-purple-50 text-purple-700 border-purple-200',
}

interface AktionZeileProps {
  zeile: Zeile
  index: number
  txt: T
  mitglieder: Person[]
  ordner: { id: string; name: string }[]
  tags: { id: string; name: string; farbe: string }[]
  projekt: { id: string; name: string }
  andereProjekte: { id: string; name: string }[]
  tasks: { id: string; titel: string }[]
  taskTitel: (id: string) => string
  personName: (id: string | null) => string
  projektName: (id: string) => string
  setzeAktion: (index: number, aenderung: Partial<ScreeningAktion>) => void
  setzeZeile: (index: number, aenderung: Partial<Zeile>) => void
}

function AktionZeile({
  zeile,
  index,
  txt,
  mitglieder,
  ordner,
  tags,
  projekt,
  andereProjekte,
  tasks,
  taskTitel,
  personName,
  projektName,
  setzeAktion,
  setzeZeile,
}: AktionZeileProps) {
  const a = zeile.aktion
  const selectKlasse =
    'w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#1a5276]'

  return (
    <div className={`border rounded-md ${zeile.gewaehlt ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50 opacity-60'}`}>
      <div className="flex gap-2 p-2.5">
        <input
          type="checkbox"
          checked={zeile.gewaehlt}
          onChange={e => setzeZeile(index, { gewaehlt: e.target.checked })}
          className="mt-1 rounded border-gray-300 shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`px-1.5 py-0.5 rounded border text-[11px] font-medium ${TYP_FARBE[a.typ]}`}>
              {txt(TYP_LABEL[a.typ])}
            </span>
            <span className="text-sm font-medium text-gray-800 truncate">
              {a.typ === 'neu' ? a.titel : taskTitel(a.taskId)}
            </span>
          </div>

          <p className="text-xs text-gray-600 mt-1">{zusammenfassung(a, txt, personName, projektName)}</p>

          <div className="flex gap-3 mt-1.5">
            <button
              type="button"
              onClick={() => setzeZeile(index, { offen: !zeile.offen })}
              className="text-xs text-gray-500 hover:text-gray-700 inline-flex items-center gap-1"
            >
              {zeile.offen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {txt('Begründung')}
            </button>
            <button
              type="button"
              onClick={() => setzeZeile(index, { bearbeiten: !zeile.bearbeiten })}
              className="text-xs text-[#1a5276] hover:underline inline-flex items-center gap-1"
            >
              <Pencil size={12} /> {txt('Bearbeiten')}
            </button>
          </div>

          {zeile.offen && (
            <div className="mt-2 space-y-1.5 text-xs">
              <p className="text-gray-600">{a.begruendung}</p>
              {a.beleg && (
                <p className="flex gap-1.5 text-gray-500 italic border-l-2 border-gray-200 pl-2">
                  <Quote size={11} className="shrink-0 mt-0.5" />
                  {a.beleg}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {zeile.bearbeiten && (
        <div className="px-2.5 pb-3 pt-1 border-t border-gray-100 space-y-2.5">
          {/* Ziel-Aufgabe — bei allem ausser einer neuen Aufgabe */}
          {a.typ !== 'neu' && (
            <label className="block">
              <span className="text-xs font-medium text-gray-600">{txt('Aufgabe')}</span>
              <select
                value={a.taskId}
                onChange={e => setzeAktion(index, { taskId: e.target.value } as Partial<ScreeningAktion>)}
                className={selectKlasse}
              >
                {tasks.map(t => (
                  <option key={t.id} value={t.id}>{t.titel}</option>
                ))}
              </select>
            </label>
          )}

          {a.typ === 'notiz' && (
            <label className="block">
              <span className="text-xs font-medium text-gray-600">{txt('Notiztext')}</span>
              <textarea
                value={a.text}
                onChange={e => setzeAktion(index, { text: e.target.value } as Partial<ScreeningAktion>)}
                rows={4}
                className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
              />
            </label>
          )}

          {a.typ === 'schliessen' && (
            <label className="block">
              <span className="text-xs font-medium text-gray-600">
                {txt('Schlussnotiz (leer = ohne Notiz schliessen)')}
              </span>
              <textarea
                value={a.text ?? ''}
                onChange={e =>
                  setzeAktion(index, { text: e.target.value.trim() ? e.target.value : null } as Partial<ScreeningAktion>)
                }
                rows={3}
                className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
              />
            </label>
          )}

          {a.typ === 'neu' && (
            <>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">{txt('Projekt')}</span>
                <select
                  value={a.projektId}
                  onChange={e => {
                    // Ordner, Tags und Zuständige gehören zum bisherigen
                    // Projekt bzw. dessen Firma — im neuen sind sie
                    // ungültig und werden zurückgesetzt.
                    const neu = e.target.value
                    setzeAktion(index, {
                      projektId: neu,
                      ...(neu !== projekt.id ? { ordnerId: null, tagIds: [], zustaendigId: null } : {}),
                    } as Partial<ScreeningAktion>)
                  }}
                  className={selectKlasse}
                >
                  <option value={projekt.id}>{projekt.name}</option>
                  {andereProjekte.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>

              <Input
                label={txt('Titel')}
                value={a.titel}
                onChange={e => setzeAktion(index, { titel: e.target.value } as Partial<ScreeningAktion>)}
              />

              <label className="block">
                <span className="text-xs font-medium text-gray-600">{txt('Beschreibung')}</span>
                <textarea
                  value={a.beschreibung ?? ''}
                  onChange={e =>
                    setzeAktion(index, {
                      beschreibung: e.target.value.trim() ? e.target.value : null,
                    } as Partial<ScreeningAktion>)
                  }
                  rows={3}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
                />
              </label>
            </>
          )}

          {a.typ === 'aktualisieren' && (
            <>
              <Input
                label={txt('Neuer Titel (leer = unverändert)')}
                value={a.titel ?? ''}
                onChange={e =>
                  setzeAktion(index, { titel: e.target.value.trim() ? e.target.value : null } as Partial<ScreeningAktion>)
                }
              />
              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  {txt('In ein anderes Projekt verschieben')}
                </span>
                <select
                  value={a.projektId ?? ''}
                  onChange={e =>
                    setzeAktion(index, { projektId: e.target.value || null } as Partial<ScreeningAktion>)
                  }
                  className={selectKlasse}
                >
                  <option value="">{txt('— hier lassen —')}</option>
                  {andereProjekte.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
            </>
          )}

          {/* Fälligkeit und Zuständige: bei neuen Aufgaben und Änderungen */}
          {(a.typ === 'neu' || a.typ === 'aktualisieren') && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <Input
                type="date"
                label={a.typ === 'neu' ? txt('Fälligkeit') : txt('Neue Fälligkeit (leer = unverändert)')}
                value={a.faellig ?? ''}
                onChange={e =>
                  setzeAktion(index, {
                    faellig: a.typ === 'neu' ? e.target.value : e.target.value || null,
                  } as Partial<ScreeningAktion>)
                }
              />
              <label className="block">
                <span className="text-sm font-medium text-gray-700">{txt('Zuständig')}</span>
                <select
                  value={a.zustaendigId ?? ''}
                  onChange={e =>
                    setzeAktion(index, { zustaendigId: e.target.value || null } as Partial<ScreeningAktion>)
                  }
                  className={selectKlasse}
                >
                  <option value="">{txt('— niemand —')}</option>
                  {mitglieder.map(m => (
                    <option key={m.id} value={m.id}>{m.full_name}</option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {/* Ordner und Tags nur bei einer neuen Aufgabe im aktuellen Projekt */}
          {a.typ === 'neu' && a.projektId === projekt.id && (
            <>
              {ordner.length > 0 && (
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">{txt('Ordner')}</span>
                  <select
                    value={a.ordnerId ?? ''}
                    onChange={e =>
                      setzeAktion(index, { ordnerId: e.target.value || null } as Partial<ScreeningAktion>)
                    }
                    className={selectKlasse}
                  >
                    <option value="">{txt('— ohne Ordner —')}</option>
                    {ordner.map(o => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                </label>
              )}

              {tags.length > 0 && (
                <div>
                  <span className="text-xs font-medium text-gray-600">{txt('Tags')}</span>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {tags.map(t => {
                      const gewaehlt = a.tagIds.includes(t.id)
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() =>
                            setzeAktion(index, {
                              tagIds: gewaehlt ? a.tagIds.filter(x => x !== t.id) : [...a.tagIds, t.id],
                            } as Partial<ScreeningAktion>)
                          }
                          className={TAG_CHIP_WAEHLBAR}
                        >
                          <TagChip name={t.name} farbe={t.farbe} aktiv={gewaehlt} />
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Was diese Aktion in einer Zeile bewirkt */
function zusammenfassung(
  a: ScreeningAktion,
  txt: T,
  personName: (id: string | null) => string,
  projektName: (id: string) => string
): string {
  switch (a.typ) {
    case 'notiz':
      return a.text.length > 160 ? `${a.text.slice(0, 160)}…` : a.text
    case 'neu': {
      const teile = [txt('fällig {0}', formatDate(a.faellig))]
      if (a.zustaendigId) teile.push(txt('für {0}', personName(a.zustaendigId)))
      teile.push(txt('in «{0}»', projektName(a.projektId)))
      return teile.join(' · ')
    }
    case 'aktualisieren': {
      const teile: string[] = []
      if (a.titel) teile.push(txt('Titel → «{0}»', a.titel))
      if (a.faellig) teile.push(txt('Fälligkeit → {0}', formatDate(a.faellig)))
      if (a.zustaendigId) teile.push(txt('zuständig → {0}', personName(a.zustaendigId)))
      if (a.beschreibung) teile.push(txt('Beschreibung geändert'))
      if (a.projektId) teile.push(txt('Projekt → «{0}»', projektName(a.projektId)))
      return teile.join(' · ')
    }
    case 'schliessen':
      return a.text ? txt('Schliessen mit Notiz: {0}', a.text.slice(0, 120)) : txt('Aufgabe wird geschlossen')
  }
}
