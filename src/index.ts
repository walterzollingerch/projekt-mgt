// Öffentliche Oberfläche des Moduls «Projekt-Mgt».
//
// Fachlogik, Typen und Host-Adapter. Die Oberfläche liegt unter
// `@tomtalent/projekt-mgt/ui`, der MCP-Server unter `.../mcp` —
// beide bringen eigene Abhängigkeiten mit (React bzw. next/server)
// und sollen nicht in jedem Importpfad landen.

export * from './logik/service'
export * from './logik/tags'
export * from './logik/csvImport'
export { antwort } from './logik/http'
export type { Db, Result, ProjektMgtDatabase, Json } from './typen'
export { alsProjektMgtClient } from './typen'
export { projektMgtKonfigurieren, hostLesen, t } from './host'
export type { ProjektMgtHost } from './host'
