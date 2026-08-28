import { NextRequest } from 'next/server'
import { antwort } from '../logik/http'
import { updateTag, deleteTag } from '../logik/service'
import { angemeldet, istAbbruch } from './helfer'

// Tag umbenennen, umfärben oder verschieben (Admins und
// Projektverwalter der Firma — RLS)
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const a = await angemeldet()
  if (istAbbruch(a)) return a
  return antwort(await updateTag(a.supabase, id, await request.json()))
}

// Tag löschen — die Zuordnungen an den Aufgaben fallen mit weg
// (ON DELETE CASCADE), die Aufgaben selbst bleiben bestehen
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const a = await angemeldet()
  if (istAbbruch(a)) return a
  return antwort(await deleteTag(a.supabase, id))
}
