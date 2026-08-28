import { splitLinks } from '../../hilfen'

/**
 * Gibt Freitext (Notizen, Beschreibungen) aus und macht enthaltene
 * http(s)-URLs klickbar. Der Text wird dabei nie als HTML interpretiert —
 * gerendert werden ausschliesslich Textknoten und erkannte Links.
 */
export default function TextMitLinks({ text, className }: { text: string; className?: string }) {
  return (
    <p className={className}>
      {splitLinks(text).map((segment, i) => segment.typ === 'link' ? (
        <a
          key={i}
          href={segment.wert}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#1a5276] underline break-all hover:text-[#154360]"
          onClick={e => e.stopPropagation()}
        >
          {segment.wert}
        </a>
      ) : segment.wert)}
    </p>
  )
}
