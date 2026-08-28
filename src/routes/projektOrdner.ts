import { NextRequest } from 'next/server'
import { antwort } from '../logik/http'
import { createFolder } from '../logik/service'
import { angemeldet, istAbbruch } from './helfer'

// Ordner in einem Projekt anlegen (Projektmitglieder und Admins — RLS)
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params
  const a = await angemeldet()
  if (istAbbruch(a)) return a
  const body = await request.json()
  return antwort(await createFolder(a.supabase, a.userId, projectId, body.name))
}
