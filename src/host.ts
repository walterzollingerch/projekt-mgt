// ============================================================
// Host-Adapter — alles, was von der Gastgeber-App abhängt.
//
// Das Modul selbst kennt weder Firma noch Domain noch Absender.
// Jede App meldet ihre Werte EINMAL an, bevor sie das Modul
// benutzt (siehe README, Abschnitt «Einbinden»).
//
// Sprache: Deutsch ist die führende Sprache und im Modul fest
// eingebaut. `texte` ist die Stelle, an der eine App einzelne
// Beschriftungen überschreibt — fehlt ein Eintrag, bleibt der
// deutsche Text stehen. Damit ist eine unvollständige Übersetzung
// sichtbar, aber nie kaputt.
// ============================================================

export interface ProjektMgtHost {
  /** Basis-Adresse für Links in Benachrichtigungen, OHNE Schrägstrich am Ende */
  appUrl: string

  /**
   * Unter welchem Pfad die Oberfläche des Moduls in dieser App
   * hängt, OHNE Schrägstrich am Ende — z.B. `/aufgaben` im Portal,
   * `/dashboard/projekte` in Terramay. Daraus baut das Modul die
   * Deep-Links in seinen Benachrichtigungen.
   *
   * Die Oberfläche selbst bekommt denselben Wert als Prop von der
   * Seite: Client-Komponenten laufen im Browser, wo diese
   * serverseitige Konfiguration nicht existiert.
   */
  basisPfad: string

  marke: {
    /** Kopfzeile der Mail, z.B. «TOM TALENT — Projekt-Mgt» */
    titel: string
    /** Grussformel am Fuss, z.B. «TOM TALENT Mgt AG» */
    absender: string
    /** Anzeigename im Von-Feld */
    mailVonName: string
    /** Adresse im Von-Feld */
    mailVonAdresse: string
  }

  /**
   * Überschreibungen einzelner Beschriftungen. Schlüssel sind die
   * deutschen Originaltexte. Wird in Phase 2 von der Oberfläche
   * benutzt; heute noch ohne Wirkung.
   */
  texte?: Record<string, string>
}

let host: ProjektMgtHost | null = null

/**
 * Einmal pro Prozess aufrufen, bevor irgendeine Funktion des Moduls
 * benutzt wird. Mehrfaches Aufrufen mit denselben Werten ist
 * harmlos — die App-Einstiegspunkte importieren ihr Setup-Modul
 * jeweils selbst.
 */
export function projektMgtKonfigurieren(neu: ProjektMgtHost): void {
  host = neu
}

export function hostLesen(): ProjektMgtHost {
  if (!host) {
    throw new Error(
      'projekt-mgt ist nicht konfiguriert. Die App muss projektMgtKonfigurieren({...}) ' +
      'aufrufen, bevor sie das Modul benutzt — siehe README, Abschnitt «Einbinden».'
    )
  }
  return host
}

/** Text übersetzen; ohne Eintrag bleibt der deutsche Originaltext stehen. */
export function t(deutsch: string): string {
  return host?.texte?.[deutsch] ?? deutsch
}
