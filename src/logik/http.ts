import { NextResponse } from 'next/server'
import type { Result } from './service'

// Ergebnis der Fachfunktionen (src/lib/aufgaben/service.ts) in eine
// HTTP-Antwort übersetzen — die Fachlogik kennt kein HTTP, damit sie
// auch der MCP-Server verwenden kann.
export function antwort<T>(result: Result<T>): NextResponse {
  return result.ok
    ? NextResponse.json(result.data)
    : NextResponse.json({ error: result.error }, { status: result.status })
}
