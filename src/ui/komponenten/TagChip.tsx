import { cn } from '../../hilfen'
import { farbKlassen } from '../../logik/tags'

interface TagChipProps {
  name: string
  farbe?: string | null
  /** kräftige Darstellung, z. B. als gewählter Filter */
  aktiv?: boolean
  size?: 'xs' | 'sm'
  className?: string
  children?: React.ReactNode
}

// Farbiger Chip für einen Tag (Projekt-Mgt). Die Farbe kommt aus der
// festen Palette in src/lib/aufgaben/tags.ts.
export default function TagChip({ name, farbe, aktiv = false, size = 'xs', className, children }: TagChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-medium',
        size === 'xs' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm',
        farbKlassen(farbe, aktiv),
        className
      )}
    >
      {name}
      {children}
    </span>
  )
}
