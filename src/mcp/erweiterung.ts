import type { Kontext } from './tools'

// ============================================================
// Andockpunkt für Werkzeuge der Gastgeber-App.
//
// Das Modul bringt die Projekt-Mgt-Werkzeuge mit. Eine App kann über
// denselben Zugang weitere anbieten (im Portal: Verwaltung und HR),
// ohne das Protokoll nachzubauen: Sie übergibt `mcpPost` eine
// Erweiterung, die nach der Token-Prüfung einmal pro Anfrage läuft und
// sagt, was dieser Zugang zusätzlich kann — und ob er die
// Projekt-Werkzeuge überhaupt anbieten soll.
//
// Ohne Erweiterung verhält sich der Server wie bis v1.17: nur
// Projekt-Mgt, und der Zugang verlangt «Projekt-Mgt verwenden».
//
// Die Rechte der App-Werkzeuge prüft die App selbst. Das Modul
// protokolliert ihre Aufrufe nur wie die eigenen (mcp_audit, ohne
// Inhalte) und zählt sie in die Ratengrenze ein.
//
// Die Erweiterung läuft einmal pro ANFRAGE — ihr Kontext taugt
// deshalb nicht, um etwas pro Werkzeugaufruf zu reservieren. Dafür
// bekommt `ausfuehren` seit v1.21 einen dritten Parameter: die
// Kennung dieses einen Aufrufs (`McpAufruf`). Eine App, die eine
// eigene Grenze atomar halten will (im Portal die HR-Bremse), hat
// damit den Schlüssel, unter dem sie reservieren und danach
// nachführen oder wieder löschen kann.
// ============================================================

export interface McpZusatzWerkzeug {
  /** Darf mit keinem Projekt-Mgt-Werkzeug zusammenfallen */
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export type McpWerkzeugErgebnis = { erfolg: true; daten: unknown } | { erfolg: false; fehler: string }

/** Ein einzelner Werkzeugaufruf — gültig genau für diesen Aufruf */
export interface McpAufruf {
  /**
   * Kennung dieses Aufrufs, eine UUID. Sie ist die `id` der
   * `mcp_audit`-Zeile, die das Modul VOR `ausfuehren` geschrieben hat
   * (sql/modul/15) — eine App kann ihre eigenen Protokoll- und
   * Reservierungszeilen daran hängen und so Modul- und App-Protokoll
   * zusammenführen.
   *
   * Eindeutig pro Aufruf, auch wenn dasselbe Werkzeug in derselben
   * Anfrage mehrmals vorkommt. Ein Fremdschlüssel auf `mcp_audit`
   * ist trotzdem nicht ratsam: schlägt der Protokolleintrag des
   * Moduls fehl, läuft der Aufruf bewusst weiter (Fail-open), und
   * die Zeile fehlt dann.
   */
  id: string
}

export interface McpZusatz {
  /** Projekt-Mgt-Werkzeuge anbieten. Ohne das Recht «Projekt-Mgt
   *  verwenden» bleiben sie trotzdem aus. */
  projektWerkzeuge: boolean
  werkzeuge: McpZusatzWerkzeug[]
  /** `aufruf` kam mit v1.21 dazu; wer ihn nicht braucht, lässt ihn weg. */
  ausfuehren(name: string, args: Record<string, unknown>, aufruf: McpAufruf): Promise<McpWerkzeugErgebnis>
  /** Wird an die Anleitung aus `initialize` angehängt */
  anleitung?: string
}

export type McpErweiterung = (ctx: Kontext) => Promise<McpZusatz>
