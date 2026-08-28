import { NextRequest } from 'next/server'
import { antwort } from '../logik/http'
import { addProjectMember, removeProjectMember } from '../logik/service'
import { angemeldet, istAbbruch } from './helfer'

// Mitglied zufügen (nur Projektverwalter — RLS); informiert die
// betroffene Person per Mail
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const a = await angemeldet()
  if (istAbbruch(a)) return a
  const { profile_id } = await request.json()
  return antwort(await addProjectMember(a.supabase, a.userId, id, profile_id))
}

// Mitglied entfernen (nur Projektverwalter — RLS); informiert die
// betroffene Person per Mail. Offene Tasks der Person bleiben
// bestehen und können neu zugewiesen werden.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const a = await angemeldet()
  if (istAbbruch(a)) return a
  const profileId = request.nextUrl.searchParams.get('profileId')
  return antwort(await removeProjectMember(a.supabase, a.userId, id, profileId))
}
