import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { format } from 'date-fns'
import { de } from 'date-fns/locale'

// ============================================================
// Hilfsfunktionen des Moduls. Wortgleich übernommen aus
// `src/lib/utils.ts` des TT Portals (Stand 27.08.2026) — dort
// bleiben sie bestehen, weil sie auch ausserhalb des Projekt-Mgt
// benutzt werden. Hier steht nur, was dieses Modul braucht.
// ============================================================

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(date: string | Date): string {
  return format(new Date(date), 'dd.MM.yyyy', { locale: de })
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// http(s)-URLs in Freitext (Notizen, Beschreibungen). Ein Link endet am
// ersten Leerzeichen; Satzzeichen am Schluss gehören zum Satz, nicht zum Link.
const URL_MUSTER = /https?:\/\/[^\s<>]+/g
const URL_ENDZEICHEN = /[.,;:!?)\]}»"'“”]+$/

export interface TextSegment {
  typ: 'text' | 'link'
  wert: string
}

/**
 * Zerlegt Freitext in Text- und Link-Segmente. Die Anzeige rendert
 * daraus klickbare Links, ohne den Text als HTML zu interpretieren.
 */
export function splitLinks(text: string): TextSegment[] {
  const segmente: TextSegment[] = []
  let pos = 0

  for (const treffer of text.matchAll(URL_MUSTER)) {
    const start = treffer.index ?? 0
    const url = treffer[0].replace(URL_ENDZEICHEN, '')
    if (!url) continue
    if (start > pos) segmente.push({ typ: 'text', wert: text.slice(pos, start) })
    segmente.push({ typ: 'link', wert: url })
    pos = start + url.length
  }

  if (pos < text.length) segmente.push({ typ: 'text', wert: text.slice(pos) })
  return segmente
}

/**
 * Wie escapeHtml, aber http(s)-URLs werden zu klickbaren Links —
 * für Freitext in E-Mails. Escaped wird weiterhin alles.
 */
export function escapeHtmlMitLinks(text: string): string {
  return splitLinks(text)
    .map(s => s.typ === 'link'
      ? `<a href="${escapeHtml(s.wert)}" style="color:#1a5276;">${escapeHtml(s.wert)}</a>`
      : escapeHtml(s.wert))
    .join('')
}
