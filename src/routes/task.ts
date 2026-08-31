import { NextRequest } from 'next/server'
import { antwort } from '../logik/http'
import { updateTask, deleteTask } from '../logik/service'
import { angemeldet, istAbbruch } from './helfer'

// Task bearbeiten, schliessen (= archivieren) oder reaktivieren
// (Projektmitglieder und Verwalter — RLS). Mails: neuer/bisheriger
// Verantwortlicher bei Zuweisungswechsel; Verantwortlicher bei
// Änderungen an Titel, Fälligkeit oder Status.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const a = await angemeldet()
  if (istAbbruch(a)) return a
  return antwort(await updateTask(a.supabase, a.userId, id, await request.json()))
}

// Task löschen (nur Projektverwalter — im persönlichen Projekt die
// Person selbst; entschieden wird das in der RLS)
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const a = await angemeldet()
  if (istAbbruch(a)) return a
  return antwort(await deleteTask(a.supabase, id))
}
