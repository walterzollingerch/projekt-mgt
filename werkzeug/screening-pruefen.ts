// Offline-Prüfung der Schicht, die Fremdmaterial abfängt:
// `planPruefen` (verwirft, was nicht aus dem Kontext stammt) und
// `istGueltigeAktion` (Formprüfung vor der Ausführung).
//
// Kein Netz, keine Datenbank, kein API-Schlüssel.

import { planPruefen, istGueltigeAktion, type ScreeningKontext } from '../src/logik/screening'

const P = {
  projekt: '11111111-1111-4111-8111-111111111111',
  anderesProjekt: '22222222-2222-4222-8222-222222222222',
  fremdesProjekt: '99999999-9999-4999-8999-999999999999',
  anna: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  fremdePerson: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  t_offerte: 'c1111111-1111-4111-8111-111111111111',
  fremderTask: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  ordner: 'd1111111-1111-4111-8111-111111111111',
  tag: 'e1111111-1111-4111-8111-111111111111',
  fremderTag: 'e9999999-9999-4999-8999-999999999999',
}

const kontext: ScreeningKontext = {
  projektId: P.projekt,
  projektName: 'Standort Zürich 2026',
  companyId: 'f1111111-1111-4111-8111-111111111111',
  tasksGekuerzt: false,
  tasks: [
    {
      id: P.t_offerte,
      titel: 'Offerte Elektroinstallation einholen',
      beschreibung: null,
      faellig: '2026-09-20',
      zustaendig: { id: P.anna, name: 'Anna Meier' },
      ordner: 'Bau',
      tags: ['Dringend'],
      mutterTaskId: null,
    },
  ],
  mitglieder: [{ id: P.anna, name: 'Anna Meier' }],
  ordner: [{ id: P.ordner, name: 'Bau' }],
  tags: [{ id: P.tag, name: 'Dringend' }],
  andereProjekte: [{ id: P.anderesProjekt, name: 'Marketing 2026' }],
}

const rohAktion = (u: Record<string, unknown>) => ({
  typ: 'notiz',
  begruendung: 'Test',
  beleg: null,
  task_id: null,
  project_id: null,
  titel: null,
  beschreibung: null,
  text: null,
  zustaendig_id: null,
  faellig: null,
  ordner_id: null,
  tag_ids: [],
  ...u,
})

let fehler = 0
const pruefe = (name: string, ok: boolean) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}`)
  if (!ok) fehler++
}

console.log('── planPruefen gegen erfundene IDs ──────────────────')

// 1. Notiz auf eine Aufgabe, die es im Kontext nicht gibt
{
  const p = planPruefen(
    { zusammenfassung: 'x', warnungen: [], aktionen: [rohAktion({ typ: 'notiz', task_id: P.fremderTask, text: 'Hallo' })] },
    kontext
  )
  pruefe('Notiz auf fremde Aufgabe wird verworfen', p.aktionen.length === 0)
  pruefe('… und als Warnung gemeldet, nicht stillschweigend', p.warnungen.length === 1)
}

// 2. Abschluss einer fremden Aufgabe
{
  const p = planPruefen(
    { zusammenfassung: 'x', warnungen: [], aktionen: [rohAktion({ typ: 'schliessen', task_id: P.fremderTask })] },
    kontext
  )
  pruefe('Abschluss einer fremden Aufgabe wird verworfen', p.aktionen.length === 0)
}

// 3. Neue Aufgabe mit erfundener Person, erfundenem Ordner und Tag
{
  const p = planPruefen(
    {
      zusammenfassung: 'x',
      warnungen: [],
      aktionen: [
        rohAktion({
          typ: 'neu',
          titel: 'Neue Aufgabe',
          faellig: '2026-10-01',
          zustaendig_id: P.fremdePerson,
          ordner_id: 'd9999999-9999-4999-8999-999999999999',
          tag_ids: [P.fremderTag, P.tag],
        }),
      ],
    },
    kontext
  )
  const a = p.aktionen[0]
  pruefe('Neue Aufgabe bleibt bestehen', a?.typ === 'neu')
  pruefe('Erfundene Zuständige fällt weg', a?.typ === 'neu' && a.zustaendigId === null)
  pruefe('Erfundener Ordner fällt weg', a?.typ === 'neu' && a.ordnerId === null)
  pruefe('Nur der bekannte Tag bleibt', a?.typ === 'neu' && a.tagIds.length === 1 && a.tagIds[0] === P.tag)
}

// 4. Neue Aufgabe in einem Projekt, das nicht sichtbar ist
{
  const p = planPruefen(
    {
      zusammenfassung: 'x',
      warnungen: [],
      aktionen: [rohAktion({ typ: 'neu', titel: 'X', faellig: '2026-10-01', project_id: P.fremdesProjekt })],
    },
    kontext
  )
  const a = p.aktionen[0]
  pruefe('Unsichtbares Zielprojekt fällt auf das aktuelle zurück', a?.typ === 'neu' && a.projektId === P.projekt)
}

// 5. Sichtbares anderes Projekt: erlaubt, aber ohne dessen fremde Beigaben
{
  const p = planPruefen(
    {
      zusammenfassung: 'x',
      warnungen: [],
      aktionen: [
        rohAktion({
          typ: 'neu',
          titel: 'X',
          faellig: '2026-10-01',
          project_id: P.anderesProjekt,
          zustaendig_id: P.anna,
          ordner_id: P.ordner,
          tag_ids: [P.tag],
        }),
      ],
    },
    kontext
  )
  const a = p.aktionen[0]
  pruefe('Anderes sichtbares Projekt ist erlaubt', a?.typ === 'neu' && a.projektId === P.anderesProjekt)
  pruefe(
    'Ordner, Tags und Zuständige des alten Projekts wandern nicht mit',
    a?.typ === 'neu' && a.ordnerId === null && a.tagIds.length === 0 && a.zustaendigId === null
  )
}

// 6. Kaputte Eingaben
{
  const p = planPruefen(
    {
      zusammenfassung: 'x',
      warnungen: [],
      aktionen: [
        rohAktion({ typ: 'notiz', task_id: P.t_offerte, text: '   ' }),
        rohAktion({ typ: 'neu', titel: '', faellig: '2026-10-01' }),
        rohAktion({ typ: 'aktualisieren', task_id: P.t_offerte }),
        rohAktion({ typ: 'loeschen', task_id: P.t_offerte }),
      ],
    },
    kontext
  )
  pruefe('Leere Notiz, titelloser Task, inhaltlose Änderung und Fantasietyp fallen alle weg', p.aktionen.length === 0)
  pruefe('… mit vier Warnungen', p.warnungen.length === 4)
}

// 7. Datumsformate
{
  const p = planPruefen(
    {
      zusammenfassung: 'x',
      warnungen: [],
      aktionen: [
        rohAktion({ typ: 'neu', titel: 'A', faellig: '01.10.2026' }),
        rohAktion({ typ: 'aktualisieren', task_id: P.t_offerte, faellig: 'nächste Woche', titel: 'B' }),
      ],
    },
    kontext
  )
  const neu = p.aktionen.find(a => a.typ === 'neu')
  const upd = p.aktionen.find(a => a.typ === 'aktualisieren')
  pruefe('Unlesbares Datum bei «neu» wird ersetzt und gemeldet', /^\d{4}-\d{2}-\d{2}$/.test(neu?.typ === 'neu' ? neu.faellig : ''))
  pruefe('Unlesbares Datum bei «aktualisieren» fällt weg', upd?.typ === 'aktualisieren' && upd.faellig === null)
}

// 8. Mengenbegrenzung
{
  const viele = Array.from({ length: 80 }, () => rohAktion({ typ: 'notiz', task_id: P.t_offerte, text: 'x' }))
  const p = planPruefen({ zusammenfassung: 'x', warnungen: [], aktionen: viele }, kontext)
  pruefe('Höchstens 50 Aktionen', p.aktionen.length <= 50)
}

console.log('\n── istGueltigeAktion (Formprüfung vor der Ausführung) ──')
{
  const gut = { nr: 1, typ: 'notiz', begruendung: '', beleg: null, taskId: P.t_offerte, text: 'Hallo' }
  pruefe('Gültige Notiz wird angenommen', istGueltigeAktion(gut))
  pruefe('Notiz ohne Text wird abgelehnt', !istGueltigeAktion({ ...gut, text: '  ' }))
  pruefe('Notiz mit Nicht-UUID wird abgelehnt', !istGueltigeAktion({ ...gut, taskId: '../../etc/passwd' }))
  pruefe(
    'Zu langer Notiztext wird abgelehnt',
    !istGueltigeAktion({ ...gut, text: 'x'.repeat(5001) })
  )
  pruefe('Unbekannter Typ wird abgelehnt', !istGueltigeAktion({ ...gut, typ: 'loeschen' }))
  pruefe('Änderung ohne Inhalt wird abgelehnt', !istGueltigeAktion({
    nr: 1, typ: 'aktualisieren', begruendung: '', beleg: null, taskId: P.t_offerte,
    titel: null, beschreibung: null, zustaendigId: null, faellig: null, projektId: null,
  }))
  pruefe('Neue Aufgabe ohne Datum wird abgelehnt', !istGueltigeAktion({
    nr: 1, typ: 'neu', begruendung: '', beleg: null, projektId: P.projekt,
    titel: 'X', beschreibung: null, zustaendigId: null, faellig: null, ordnerId: null, tagIds: [],
  }))
  pruefe('Abschluss ohne Notiz ist gültig', istGueltigeAktion({
    nr: 1, typ: 'schliessen', begruendung: '', beleg: null, taskId: P.t_offerte, text: null,
  }))
  pruefe('null wird abgelehnt', !istGueltigeAktion(null))
}

console.log(fehler === 0 ? '\nAlle Prüfungen bestanden.' : `\n${fehler} Prüfung(en) fehlgeschlagen.`)
process.exit(fehler === 0 ? 0 : 1)
