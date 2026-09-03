import { NextRequest } from 'next/server'
import { antwort } from '../logik/http'
import { addTaskNote } from '../logik/service'
import { angemeldet, istAbbruch } from './helfer'

// Notiz anfügen (Projektmitglieder und Verwalter — RLS erzwingt
// zudem author_id = eigene ID; Notizen sind unveränderlich).
// Optional: Datei-Anhang (bereits in den Storage hochgeladen) und
// eine zusätzlich zu informierende Person — sie wird als Beobachter
// gespeichert und ab sofort bei jeder neuen Notiz informiert.
// Mit `schliessen: true` wird die Notiz zur Schlussnotiz: der Task
// wird gleich geschlossen und archiviert, die Antwort enthält dann
// den geschlossenen Task (und bei einer Wiederholung den Folge-Task).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const a = await angemeldet()
  if (istAbbruch(a)) return a
  return antwort(await addTaskNote(a.supabase, a.userId, id, await request.json()))
}
