// ============================================================
// Fälligkeit einer Aufgabe — die eine Stelle, die sagt, was «kein
// Datum» bedeutet (sql/modul/16, Entscheid 24.11.2026):
//
//   Eine Aufgabe ohne Fälligkeitsdatum ist FÄLLIG. Sie gehört in
//   jede Liste und jede Zählung, die fällige oder überfällige
//   Aufgaben berücksichtigt, und wird dort als «ohne
//   Fälligkeitsdatum» ausgewiesen. Überfällig ist sie nicht — eine
//   Frist, die es nicht gibt, kann nicht verstrichen sein.
//
// Rein und client-tauglich: keine Datenbank, keine Server-Importe.
// Daten sind ISO-Tage (YYYY-MM-DD) und lassen sich als Zeichenkette
// vergleichen.
// ============================================================

/** Fälligkeit, wie sie in `tasks.due_date` steht */
export type Faelligkeit = string | null | undefined

/** Beschriftung überall dort, wo sonst ein Datum stünde */
export const OHNE_FAELLIGKEIT = 'Ohne Fälligkeitsdatum'

export function hatFaelligkeit(due: Faelligkeit): due is string {
  return typeof due === 'string' && due !== ''
}

/**
 * Sortierung nach Fälligkeit. Aufgaben ohne Datum stehen zuoberst:
 * sie sind jetzt fällig und sollen nicht hinter dem letzten Termin
 * verschwinden.
 */
export function vergleicheFaelligkeit(a: Faelligkeit, b: Faelligkeit): number {
  const hatA = hatFaelligkeit(a)
  const hatB = hatFaelligkeit(b)
  if (!hatA || !hatB) return hatA === hatB ? 0 : hatA ? 1 : -1
  return a.localeCompare(b)
}

/** Fällig bis und mit `grenze` — ohne Datum immer */
export function istFaelligBis(due: Faelligkeit, grenze: string): boolean {
  return !hatFaelligkeit(due) || due <= grenze
}

/** Frist verstrichen — ohne Datum nie */
export function istUeberfaelligAm(due: Faelligkeit, heute: string): boolean {
  return hatFaelligkeit(due) && due < heute
}

/**
 * PostgREST-Filter «fällig bis und mit `grenze`», Aufgaben ohne
 * Datum eingeschlossen. Für `.or(…)` auf `tasks`.
 */
export function faelligBisFilter(grenze: string): string {
  return `due_date.is.null,due_date.lte.${grenze}`
}
