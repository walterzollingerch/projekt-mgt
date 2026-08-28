import { createBrowserClient } from '@supabase/ssr'
import type { CookieOptions } from '@supabase/ssr'
import type { ProjektMgtDatabase } from '../typen'

// ============================================================
// Browser-Client für die Oberfläche des Moduls.
//
// Bewusst eigenständig statt über den Host-Adapter: Client-
// Komponenten laufen im Browser, wo die serverseitige Konfiguration
// nicht existiert. Beide Apps setzen dieselben beiden Variablen,
// mehr braucht es nicht.
//
// Die Cookie-Einstellungen sind wortgleich aus
// `src/lib/supabase/cookies.ts` des TT Portals übernommen — sie
// enthalten nichts Hostspezifisches. Die Begründungen dort gelten
// unverändert:
//
// maxAge fehlt, weil @supabase/ssr es nach dem Spread wieder auf
// seinen eigenen Wert zurücksetzt (400 Tage) — ein Wert hier sähe
// aus wie eine Verkürzung, wäre aber wirkungslos. Der wirksame
// Hebel ist `sessions_inactivity_timeout` in Supabase.
//
// httpOnly steht bewusst nicht auf true: createBrowserClient liest
// die Session selbst aus document.cookie und würde sich sonst
// aussperren.
// ============================================================

export const COOKIE_OPTIONS: CookieOptions = {
  // Secure nur in Produktion — auf http://localhost würde ein
  // Secure-Cookie gar nicht erst gespeichert.
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
}

export function createClient() {
  return createBrowserClient<ProjektMgtDatabase>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookieOptions: COOKIE_OPTIONS }
  )
}
