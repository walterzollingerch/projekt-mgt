import { NextRequest } from 'next/server'
import { antwort } from '../logik/http'
import { createTag } from '../logik/service'
import { angemeldet, istAbbruch } from './helfer'

// Tag einer Firma anlegen. Tags gelten firmenweit (Mandant) und
// stehen in allen Projekten dieser Firma zur Verfügung; pflegen
// dürfen sie Admins und Projektverwalter der Firma (RLS).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: companyId } = await params
  const a = await angemeldet()
  if (istAbbruch(a)) return a
  return antwort(await createTag(a.supabase, a.userId, companyId, await request.json()))
}
