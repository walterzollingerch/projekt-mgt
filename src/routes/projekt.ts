import { NextRequest } from 'next/server'
import { antwort } from '../logik/http'
import { updateProject, deleteProject } from '../logik/service'
import { angemeldet, istAbbruch } from './helfer'

// Projekt bearbeiten/archivieren (nur Projektverwalter — RLS)
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const a = await angemeldet()
  if (istAbbruch(a)) return a
  return antwort(await updateProject(a.supabase, id, await request.json()))
}

// Projekt löschen (nur Projektverwalter — RLS); Tasks und Notizen
// werden per ON DELETE CASCADE mitgelöscht
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const a = await angemeldet()
  if (istAbbruch(a)) return a
  return antwort(await deleteProject(a.supabase, id))
}
