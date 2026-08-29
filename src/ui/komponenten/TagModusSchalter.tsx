import type { TagModus } from '../../logik/tags'

interface TagModusSchalterProps {
  modus: TagModus
  onChange: (modus: TagModus) => void
}

const OPTIONEN: { wert: TagModus; label: string; titel: string }[] = [
  { wert: 'oder', label: 'mind. eines', titel: 'Aufgaben, die mindestens einen der gewählten Tags tragen' },
  { wert: 'und', label: 'alle', titel: 'Nur Aufgaben, die alle gewählten Tags tragen' },
]

// Umschalter für die Verknüpfung mehrerer Tag-Filter. Erscheint erst,
// wenn mindestens zwei Tags gewählt sind — vorher sind ODER und UND
// dasselbe.
export default function TagModusSchalter({ modus, onChange }: TagModusSchalterProps) {
  return (
    <span
      role="group"
      aria-label="Verknüpfung der gewählten Tags"
      className="inline-flex items-center rounded-full border border-gray-300 overflow-hidden bg-white"
    >
      {OPTIONEN.map(o => (
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
