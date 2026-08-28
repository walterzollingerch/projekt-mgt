import { NextRequest } from 'next/server'
import { antwort } from '../logik/http'
import { updateFolder, deleteFolder } from '../logik/service'
import { angemeldet, istAbbruch } from './helfer'

// Ordner umbenennen oder verschieben (Projektmitglieder und Admins — RLS)
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const a = await angemeldet()
  if (istAbbruch(a)) return a
  return antwort(await updateFolder(a.supabase, id, await request.json()))
}

// Ordner löschen. Der DB-Trigger lässt das nur zu, wenn keine
// offenen Aufgaben mehr zugewiesen sind; archivierte Aufgaben
// verlieren lediglich die Ordner-Zuordnung (ON DELETE SET NULL).
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const a = await angemeldet()
  if (istAbbruch(a)) return a
  return antwort(await deleteFolder(a.supabase, id))
}
