import { NextResponse } from 'next/server'
import { projektMgtServerClient } from '../server/supabaseServer'
import type { Db } from '../typen'

// ============================================================
// Gemeinsamer Auftakt jeder Modul-Route: Client bauen, Person
// auflösen, ohne Anmeldung mit 401 abbrechen.
//
// Die eigentliche Zugriffskontrolle macht danach die RLS — hier
// wird nur festgestellt, WER fragt.
// ============================================================

export type Angemeldet = { supabase: Db; userId: string }

export async function angemeldet(): Promise<Angemeldet | NextResponse> {
  const supabase = await projektMgtServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return { supabase, userId: user.id }
}

export function istAbbruch(x: Angemeldet | NextResponse): x is NextResponse {
  return x instanceof NextResponse
}
