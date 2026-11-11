import { Search } from 'lucide-react'

// ============================================================
// Suche und Firmen-Eingrenzung über einer Personenliste.
//
// Die Auswahl «wer darf Mitglied werden» umfasst alle Personen mit
// Projekt-Mgt-Recht über alle Firmen — zu viele, um sie nur zu
// durchblättern. Der Baustein hält selbst keinen Zustand; die Liste
// darunter filtert mit `filterePersonen`.
// ============================================================

export interface FilterPerson {
  id: string
  full_name: string
  email: string
  /* Fehlt, wenn die Gastgeber-Seite die Firma nicht mitlädt — dann
     gibt es nur die Suche */
  company_id?: string | null
}

export interface PersonenFilterWert {
  suche: string
  firmaId: string
}

export const leererPersonenFilter: PersonenFilterWert = { suche: '', firmaId: '' }

export function filterePersonen<P extends FilterPerson>(personen: P[], filter: PersonenFilterWert): P[] {
  const suche = filter.suche.trim().toLowerCase()
  return personen.filter(p =>
    (!filter.firmaId || p.company_id === filter.firmaId) &&
    (!suche || p.full_name.toLowerCase().includes(suche) || p.email.toLowerCase().includes(suche))
  )
}

interface PersonenFilterProps {
  personen: FilterPerson[]
  firmen: { id: string; name: string }[]
  wert: PersonenFilterWert
  onChange: (wert: PersonenFilterWert) => void
  txt: (text: string) => string
}

export default function PersonenFilter({ personen, firmen, wert, onChange, txt }: PersonenFilterProps) {
  // Nur Firmen anbieten, aus denen überhaupt jemand zur Auswahl steht
  const vorhandene = new Set(personen.map(p => p.company_id).filter(Boolean))
  const waehlbar = firmen.filter(f => vorhandene.has(f.id))

  return (
    <div className="flex flex-col sm:flex-row gap-2 mb-2">
      <div className="relative flex-1">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input
          type="search"
          value={wert.suche}
          onChange={e => onChange({ ...wert, suche: e.target.value })}
          placeholder={txt('Name oder E-Mail suchen …')}
          aria-label={txt('Name oder E-Mail suchen …')}
          className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm bg-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
        />
      </div>
      {waehlbar.length > 1 && (
        <select
          value={wert.firmaId}
          onChange={e => onChange({ ...wert, firmaId: e.target.value })}
          aria-label={txt('Firma')}
          className="sm:w-56 px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
        >
          <option value="">{txt('Alle Firmen')}</option>
          {waehlbar.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      )}
    </div>
  )
}
