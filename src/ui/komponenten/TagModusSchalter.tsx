import type { TagModus } from '../../logik/tags'
import type { T } from '../texte'

interface TagModusSchalterProps {
  modus: TagModus
  onChange: (modus: TagModus) => void
  /** Übersetzungsfunktion der aufrufenden Ansicht */
  txt: T
}

// Die Werte ('oder'/'und') sind Zustand, die Beschriftungen daneben
// sind Text — nur letztere gehen durch die Übersetzung.
const optionen = (txt: T): { wert: TagModus; label: string; titel: string }[] => [
  { wert: 'oder', label: txt('mind. eines'), titel: txt('Aufgaben, die mindestens einen der gewählten Tags tragen') },
  { wert: 'und', label: txt('alle'), titel: txt('Nur Aufgaben, die alle gewählten Tags tragen') },
]

// Umschalter für die Verknüpfung mehrerer Tag-Filter. Erscheint erst,
// wenn mindestens zwei Tags gewählt sind — vorher sind ODER und UND
// dasselbe.
export default function TagModusSchalter({ modus, onChange, txt }: TagModusSchalterProps) {
  return (
    <span
      role="group"
      aria-label={txt('Verknüpfung der gewählten Tags')}
      className="inline-flex items-center rounded-full border border-gray-300 overflow-hidden bg-white"
    >
      {optionen(txt).map(o => (
        <button
          key={o.wert}
          type="button"
          onClick={() => onChange(o.wert)}
          aria-pressed={modus === o.wert}
          title={o.titel}
          className={`px-2 py-0.5 text-xs font-medium transition-colors ${
            modus === o.wert ? 'bg-[#1a5276] text-white' : 'text-gray-600 hover:bg-gray-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </span>
  )
}
