import { NextRequest } from 'next/server'
import { antwort } from '../logik/http'
import { createProject } from '../logik/service'
import { angemeldet, istAbbruch } from './helfer'

// Neues Projekt anlegen (nur Projektverwalter — die RLS blockiert alle anderen)
export async function POST(request: NextRequest) {
  const a = await angemeldet()
  if (istAbbruch(a)) return a
  return antwort(await createProject(a.supabase, a.userId, await request.json()))
}
