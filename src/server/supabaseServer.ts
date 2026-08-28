import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { ProjektMgtDatabase, Db } from '../typen'
import { COOKIE_OPTIONS } from '../ui/supabaseBrowser'

// ============================================================
// Server-Client für die Routen des Moduls.
//
// Wortgleich zu dem, was beide Apps ohnehin bauen — dieselben
// Cookie-Einstellungen wie der Browser-Client, damit die Sitzung
// nicht auseinanderläuft.
//
// Die App behält ihren eigenen Server-Client für ihren eigenen
// Code; dieser hier wird nur von den Modul-Routen benutzt.
// ============================================================

export async function projektMgtServerClient(): Promise<Db> {
  const cookieStore = await cookies()

  return createServerClient<ProjektMgtDatabase>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server Component — cookies sind hier nur lesbar
          }
        },
      },
    }
  )
}
