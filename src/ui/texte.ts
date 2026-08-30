// ============================================================
// Übersetzung der Oberfläche.
//
// Deutsch ist die führende Sprache und steht als Schlüssel direkt
// im JSX — wer den Code liest, sieht den echten Text und nicht
// `label.task.create.button`. Eine App übergibt ein Wörterbuch,
// das einzelne Einträge überschreibt; fehlt einer, bleibt der
// deutsche Text stehen. Eine unvollständige Übersetzung ist damit
// sichtbar, aber nie kaputt.
//
// Übersetzt werden ausschliesslich BESCHRIFTUNGEN. Inhalte —
// Aufgabentitel, Beschreibungen, Notizen, Projekt-, Ordner- und
// Tag-Namen — bleiben immer so, wie sie eingegeben wurden.
//
// Warum als Prop und nicht über den Host-Adapter: die Oberfläche
// besteht aus Client-Komponenten. Die laufen im Browser, wo die
// serverseitige Konfiguration nicht existiert. Die Seite reicht das
// Wörterbuch deshalb als gewöhnliche Prop herein.
// ============================================================

export type Woerterbuch = Record<string, string>

/**
 * Baut die Übersetzungsfunktion.
 *
 * Platzhalter `{0}`, `{1}` … werden der Reihe nach durch die
 * weiteren Argumente ersetzt — so bleiben Sätze mit eingesetzten
 * Werten übersetzbar, ohne sie zerschneiden zu müssen:
 *
 *   t('Ordner «{0}» löschen?', ordner.name)
 */
export function machT(texte?: Woerterbuch) {
  return function t(deutsch: string, ...werte: (string | number)[]): string {
    const s = texte?.[deutsch] ?? deutsch
    if (werte.length === 0) return s
    return s.replace(/\{(\d+)\}/g, (_, i) => {
      const w = werte[Number(i)]
      return w === undefined ? '' : String(w)
    })
  }
}

export type T = ReturnType<typeof machT>
