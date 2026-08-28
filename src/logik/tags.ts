// ============================================================
// Tags im Projekt-Mgt — Farben und gemeinsame Typen.
//
// Tags werden pro Mandant (= Firma) gepflegt und stehen in allen
// Projekten dieser Firma zur Verfügung. Die Farbe ist bewusst eine
// feste Auswahl statt Freitext: so bleiben die Chips im UI
// einheitlich und Tailwind kennt die Klassen zur Bauzeit.
// ============================================================

export const TAG_FARBEN = ['grau', 'blau', 'gruen', 'gelb', 'orange', 'rot', 'violett', 'tuerkis'] as const
export type TagFarbe = (typeof TAG_FARBEN)[number]

export const TAG_FARB_LABELS: Record<TagFarbe, string> = {
  grau: 'Grau',
  blau: 'Blau',
  gruen: 'Grün',
  gelb: 'Gelb',
  orange: 'Orange',
  rot: 'Rot',
  violett: 'Violett',
  tuerkis: 'Türkis',
}

// Klassen als ganze Strings — Tailwind darf sie nicht zusammensetzen
export const TAG_FARB_KLASSEN: Record<TagFarbe, string> = {
  grau: 'bg-gray-100 text-gray-700 border-gray-200',
  blau: 'bg-blue-100 text-blue-800 border-blue-200',
  gruen: 'bg-green-100 text-green-800 border-green-200',
  gelb: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  orange: 'bg-orange-100 text-orange-800 border-orange-200',
  rot: 'bg-red-100 text-red-800 border-red-200',
  violett: 'bg-purple-100 text-purple-800 border-purple-200',
  tuerkis: 'bg-teal-100 text-teal-800 border-teal-200',
}

// Ausgewählter Filter-Chip: kräftiger, damit die Auswahl auffällt
export const TAG_FARB_KLASSEN_AKTIV: Record<TagFarbe, string> = {
  grau: 'bg-gray-600 text-white border-gray-600',
  blau: 'bg-blue-600 text-white border-blue-600',
  gruen: 'bg-green-600 text-white border-green-600',
  gelb: 'bg-yellow-500 text-white border-yellow-500',
  orange: 'bg-orange-500 text-white border-orange-500',
  rot: 'bg-red-600 text-white border-red-600',
  violett: 'bg-purple-600 text-white border-purple-600',
  tuerkis: 'bg-teal-600 text-white border-teal-600',
}

export function istTagFarbe(wert: unknown): wert is TagFarbe {
  return typeof wert === 'string' && (TAG_FARBEN as readonly string[]).includes(wert)
}

export function farbKlassen(farbe: string | null | undefined, aktiv = false): string {
  const f: TagFarbe = istTagFarbe(farbe) ? farbe : 'grau'
  return aktiv ? TAG_FARB_KLASSEN_AKTIV[f] : TAG_FARB_KLASSEN[f]
}

export interface TagRow {
  id: string
  company_id: string
  name: string
  farbe: string
  position: number
}

/** Tag-Angabe an einer Aufgabe (aus dem PostgREST-Embed) */
export interface TaskTagRef {
  tag: { id: string; name: string; farbe: string } | null
}

/** Tags einer Aufgabe in der Reihenfolge der Tag-Pflege */
export function tagsVonTask(
  zuordnungen: TaskTagRef[] | null | undefined,
  reihenfolge: TagRow[] = []
): { id: string; name: string; farbe: string }[] {
  const rang = new Map(reihenfolge.map((t, i) => [t.id, i]))
  return (zuordnungen ?? [])
    .map(z => z.tag)
    .filter((t): t is { id: string; name: string; farbe: string } => !!t)
    .sort((a, b) => (rang.get(a.id) ?? 999) - (rang.get(b.id) ?? 999) || a.name.localeCompare(b.name))
}
