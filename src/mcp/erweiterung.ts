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
// ============================================================

export interface McpZusatzWerkzeug {
  /** Darf mit keinem Projekt-Mgt-Werkzeug zusammenfallen */
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export type McpWerkzeugErgebnis = { erfolg: true; daten: unknown } | { erfolg: false; fehler: string }

export interface McpZusatz {
  /** Projekt-Mgt-Werkzeuge anbieten. Ohne das Recht «Projekt-Mgt
   *  verwenden» bleiben sie trotzdem aus. */
  projektWerkzeuge: boolean
  werkzeuge: McpZusatzWerkzeug[]
  ausfuehren(name: string, args: Record<string, unknown>): Promise<McpWerkzeugErgebnis>
  /** Wird an die Anleitung aus `initialize` angehängt */
  anleitung?: string
}

export type McpErweiterung = (ctx: Kontext) => Promise<McpZusatz>
