import { NextRequest } from 'next/server'
import { antwort } from '../logik/http'
import { createTask } from '../logik/service'
import { angemeldet, istAbbruch } from './helfer'

// Task anlegen (Projektmitglieder und Verwalter — RLS; der DB-Trigger
// stellt sicher, dass der Zuständige Projektmitglied ist)
export async function POST(request: NextRequest) {
  const a = await angemeldet()
  if (istAbbruch(a)) return a
  return antwort(await createTask(a.supabase, a.userId, await request.json()))
}
