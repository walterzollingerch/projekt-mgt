'use client'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, ClipboardList, Users, UserCircle, ChevronRight, Archive, Search, CalendarClock, MessageSquare, FolderOpen, Folder, Tags, X } from 'lucide-react'
import Button from './komponenten/Button'
import Badge from './komponenten/Badge'
import Modal from './komponenten/Modal'
import TagChip from './komponenten/TagChip'
import TagModusSchalter from './komponenten/TagModusSchalter'
import Input from './komponenten/Input'
import { createClient } from './supabaseBrowser'
import { formatDate } from '../hilfen'
import { TAG_CHIP_WAEHLBAR, passtZuTags, tagsVonTask, type TagModus, type TagRow, type TaskTagRef } from '../logik/tags'
import { machT, type Woerterbuch } from './texte'

interface ProfileOption {
  id: string
  full_name: string
  email: string
}

interface ProjectRow {
  id: string
  /* null beim persönlichen Projekt — es gehört zu keiner Firma */
  company_id: string | null
  name: string
  beschreibung: string | null
  status: 'aktiv' | 'archiviert'
  /* Gesetzt = persönliches Projekt «Eigene Tasks» dieser Person.
     Optional, weil eine Seite die Spalte vielleicht nicht mitlädt —
     erkannt wird das Projekt dann an der fehlenden Firma. */
  persoenlich_fuer?: string | null
  company: { id: string; name: string } | null
  members: { id: string; profile_id: string; profile: ProfileOption | null }[]
  tasks: { id: string; status: 'offen' | 'geschlossen' }[]
}

/**
 * Ist das das persönliche Projekt «Eigene Tasks»?
 *
 * Zwei Kennzeichen, weil das erste fehlen kann: `persoenlich_fuer`
 * lädt nur, wer die Spalte auswählt. Die fehlende Firma ist dagegen
 * gleichwertig und immer da — der CHECK `projects_firma_oder_persoenlich`
 * lässt genau eine der beiden Spalten gesetzt sein. Sichtbar ist ein
 * persönliches Projekt ohnehin nur seiner eigenen Person.
 */
function istPersoenlich(p: { company_id: string | null; persoenlich_fuer?: string | null }): boolean {
  return !!p.persoenlich_fuer || !p.company_id
}

interface TaskRow {
  id: string
  titel: string
  due_date: string
  status: 'offen' | 'geschlossen'
  project_id: string
  assignee_id: string | null
  parent_task_id: string | null
  folder_id: string | null
  assignee: { id: string; full_name: string } | null
  project: { id: string; name: string } | null
  /* Tags aus dem Embed task_tag_zuordnungen(tag:task_tags(...)) */
  tags?: TaskTagRef[]
}

interface FolderRow {
  id: string
  project_id: string
  name: string
  position: number
}

interface SucheTreffer extends TaskRow {
  beschreibung: string | null
  /* true = gefunden über den Text einer Notiz, nicht über den Task selbst */
  trefferInNotiz?: boolean
}

interface AufgabenClientProps {
  initialProjects: ProjectRow[]
  initialOffeneTasks: TaskRow[]
  folders: FolderRow[]
  /* Tags aller Firmen, in denen ich ein Projekt habe */
  tags: TagRow[]
  companies: { id: string; name: string }[]
  profiles: ProfileOption[]
  isManager: boolean
  userId: string
  /** Beschriftungen überschreiben; fehlt ein Eintrag, bleibt der
   *  deutsche Text stehen. Inhalte werden nie übersetzt. */
  texte?: Woerterbuch
  /** Unter welchem Pfad die Modul-Seiten in dieser App hängen
   *  (Portal `/aufgaben`, Terramay `/dashboard/projekte`). */
  basisPfad?: string
}

const emptyProjektForm = { name: '', company_id: '', beschreibung: '', member_ids: [] as string[] }
const emptyTaskForm = { project_id: '', titel: '', beschreibung: '', assignee_id: '', due_date: '', wiederholung: '', folder_id: '', tag_ids: [] as string[] }

const SUCHE_SELECT = 'id, titel, beschreibung, due_date, status, project_id, assignee_id, parent_task_id, folder_id, assignee:profiles!tasks_assignee_id_fkey(id, full_name), project:projects(id, name), tags:task_tag_zuordnungen(tag:task_tags(id, name, farbe))'

type FaelligFilter = 'ueberfaellig' | 'heute' | 'woche' | 'alle'
// Die Schlüssel sind Werte, die Beschriftungen daneben Text —
// übersetzt wird nur letzterer.
const faelligLabels = (txt: (d: string) => string): Record<FaelligFilter, string> => ({
  ueberfaellig: txt('Überfällig'),
  heute: txt('Bis heute'),
  woche: txt('Nächste 7 Tage'),
  alle: txt('Alle offenen'),
})

function heuteISO(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function inTagenISO(tage: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + tage)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// PostgREST-Filter: Kommas und Klammern würden die or()-Syntax
// zerlegen, Prozent/Unterstrich sind ilike-Platzhalter
function sucheEscapen(q: string): string {
  return q.replace(/[,()"\\%_]/g, ' ').trim()
}

export default function AufgabenClient({ initialProjects, initialOffeneTasks, folders, tags, companies, profiles, isManager, userId, basisPfad = '/aufgaben', texte }: AufgabenClientProps) {
  const txt = machT(texte)
  const labels = faelligLabels(txt)
  const supabase = createClient()
  const [projects, setProjects] = useState(initialProjects)
  const [offeneTasks, setOffeneTasks] = useState(initialOffeneTasks)
  const [tab, setTab] = useState<'projekte' | 'faellig' | 'suche'>('projekte')

  // Projekt anlegen
  const [projektModalOpen, setProjektModalOpen] = useState(false)
  const [projektForm, setProjektForm] = useState(emptyProjektForm)
  const [projektLoading, setProjektLoading] = useState(false)
  const [projektError, setProjektError] = useState('')

  // Aufgabe anlegen
  const [taskModalOpen, setTaskModalOpen] = useState(false)
  const [taskForm, setTaskForm] = useState(emptyTaskForm)
  const [taskLoading, setTaskLoading] = useState(false)
  const [taskError, setTaskError] = useState('')

  // Fälligkeits-Ansicht
  const [faelligFilter, setFaelligFilter] = useState<FaelligFilter>('woche')
  const [nurMeine, setNurMeine] = useState(false)

  // Tag-Filter (ODER-Verknüpfung, gilt für «Fällig» und «Suche»)
  const [filterTags, setFilterTags] = useState<Set<string>>(new Set())
  const [tagModus, setTagModus] = useState<TagModus>('oder')

  // Suche
  const [suche, setSuche] = useState('')
  const [treffer, setTreffer] = useState<SucheTreffer[]>([])
  // Begriff, zu dem die Treffer gehören — verhindert, dass beim
  // Tippen veraltete Resultate angezeigt werden
  const [trefferFuer, setTrefferFuer] = useState('')

  // Projekte, in denen ich Mitglied bin — nur dort kann ich Aufgaben
  // anlegen (Admins sehen zwar alle Projekte, die Auswahl bleibt aber
  // bewusst auf die eigenen beschränkt). Das eigene Projekt steht
  // zuoberst.
  const meineProjekte = useMemo(
    () => projects
      .filter(p => p.status === 'aktiv' && p.members.some(m => m.profile_id === userId))
      .sort((a, b) =>
        (istPersoenlich(a) ? 0 : 1) - (istPersoenlich(b) ? 0 : 1) || a.name.localeCompare(b.name)
      ),
    [projects, userId]
  )

  // Das persönliche Projekt: ein Ort für Aufgaben, die niemanden
  // sonst betreffen. Es gehört keiner Firma, hat mich als einziges
  // Mitglied, und alles darin ist mir zugewiesen (DB-Trigger).
  const eigenesProjekt = useMemo(
    () => projects.find(istPersoenlich) ?? null,
    [projects]
  )

  // Es entsteht mit der Migration und wird für neue Personen
  // nachgeführt (sql/modul/09). Fehlt es trotzdem — etwa weil das
  // Profil älter ist als das Modul —, legt der Aufruf es an, statt
  // einen leeren Platz zu zeigen.
  useEffect(() => {
    if (eigenesProjekt) return
    let abgebrochen = false
    void (async () => {
      const { data: id, error } = await supabase.rpc('persoenliches_projekt_sichern')
      if (error || !id || abgebrochen) return
      const { data } = await supabase
        .from('projects')
        .select('id, company_id, name, beschreibung, status, persoenlich_fuer')
        .eq('id', id)
        .single()
      if (!data || abgebrochen) return
      setProjects(prev => prev.some(p => p.id === data.id) ? prev : [...prev, {
        ...data,
        company: null,
        members: [{ id: `neu-${userId}`, profile_id: userId, profile: profiles.find(p => p.id === userId) ?? null }],
        tasks: [],
      }])
    })()
    return () => { abgebrochen = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Im Anlegen-Dialog ist das eigene Projekt gewählt
  const taskFormIstEigen = !!taskForm.project_id && taskForm.project_id === eigenesProjekt?.id

  // Ordner des im Anlegen-Dialog gewählten Projekts
  const projektOrdner = useMemo(
    () => folders.filter(f => f.project_id === taskForm.project_id),
    [folders, taskForm.project_id]
  )

  // Tags der Firma des im Anlegen-Dialog gewählten Projekts
  const projektTags = useMemo(() => {
    const firma = projects.find(p => p.id === taskForm.project_id)?.company_id
    return firma ? tags.filter(t => t.company_id === firma) : []
  }, [tags, projects, taskForm.project_id])

  // Tag-Filter: Chips nach Firma gruppiert (die Übersicht spannt über
  // alle Mandanten, in denen ich Projekte habe)
  const tagsNachFirma = useMemo(() => {
    const firmenNamen = new Map<string, string>()
    for (const c of companies) firmenNamen.set(c.id, c.name)
    for (const p of projects) if (p.company) firmenNamen.set(p.company.id, p.company.name)
    const gruppen = new Map<string, { name: string; tags: TagRow[] }>()
    for (const t of tags) {
      const eintrag = gruppen.get(t.company_id) ?? { name: firmenNamen.get(t.company_id) ?? txt('Firma'), tags: [] }
      eintrag.tags.push(t)
      gruppen.set(t.company_id, eintrag)
    }
    return [...gruppen.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [tags, projects, companies])

  // Tag-Filter: je nach Modus mindestens einer der gewählten Tags
  // («oder») oder alle («und»)
  const passtZuTagFilter = useCallback(
    (task: TaskRow) => {
      const eigene = (task.tags ?? [])
        .map(z => z.tag?.id)
        .filter((id): id is string => !!id)
      return passtZuTags(eigene, filterTags, tagModus)
    },
    [filterTags, tagModus]
  )

  const toggleFilterTag = (tagId: string) => {
    setFilterTags(prev => {
      const next = new Set(prev)
      if (next.has(tagId)) next.delete(tagId)
      else next.add(tagId)
      return next
    })
  }

  // Filterleiste über den Listen; ohne gepflegte Tags entfällt sie
  const renderTagFilter = () => {
    if (tags.length === 0) return null
    return (
      <div className="flex flex-wrap items-center gap-1.5 mb-4">
        <span className="inline-flex items-center gap-1 text-xs text-gray-500 mr-0.5">
          <Tags size={13} /> Tags:
        </span>
        {tagsNachFirma.map(gruppe => (
          <div key={gruppe.name} className="flex flex-wrap items-center gap-1.5">
            {tagsNachFirma.length > 1 && (
              <span className="text-xs text-gray-400">{gruppe.name}:</span>
            )}
            {gruppe.tags.map(t => {
              const aktiv = filterTags.has(t.id)
              return (
                <button key={t.id} type="button" onClick={() => toggleFilterTag(t.id)} title={aktiv ? txt('Filter entfernen') : txt('Nach diesem Tag filtern')}>
                  <TagChip name={t.name} farbe={t.farbe} aktiv={aktiv} className={aktiv ? '' : TAG_CHIP_WAEHLBAR} />
                </button>
              )
            })}
          </div>
        ))}
        {filterTags.size > 1 && (
          <TagModusSchalter modus={tagModus} onChange={setTagModus} txt={txt} />
        )}
        {filterTags.size > 0 && (
          <button
            type="button"
            onClick={() => setFilterTags(new Set())}
            className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 px-2 py-1"
          >
            <X size={12} /> {txt('Filter zurücksetzen')}
          </button>
        )}
      </div>
    )
  }

  // Nach Firma gruppieren, archivierte Projekte ans Ende. Das
  // persönliche Projekt steht separat darüber — es gehört zu keiner
  // Firma und wäre unter «Ohne Firma» falsch einsortiert.
  const grouped = useMemo(() => {
    const map = new Map<string, { companyName: string; projects: ProjectRow[] }>()
    const sorted = [...projects].filter(p => !istPersoenlich(p)).sort((a, b) =>
      a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'aktiv' ? -1 : 1
    )
    for (const p of sorted) {
      const key = p.company?.id ?? 'ohne'
      const entry = map.get(key) ?? { companyName: p.company?.name ?? txt('Ohne Firma'), projects: [] }
      entry.projects.push(p)
      map.set(key, entry)
    }
    return [...map.values()].sort((a, b) => a.companyName.localeCompare(b.companyName))
  }, [projects])

  const ueberfaelligAnzahl = useMemo(
    () => offeneTasks.filter(t => t.due_date < heuteISO()).length,
    [offeneTasks]
  )

  const faelligeTasks = useMemo(() => {
    const heute = heuteISO()
    return offeneTasks
      .filter(t => {
        if (nurMeine && t.assignee_id !== userId) return false
        if (!passtZuTagFilter(t)) return false
        if (faelligFilter === 'ueberfaellig') return t.due_date < heute
        if (faelligFilter === 'heute') return t.due_date <= heute
        if (faelligFilter === 'woche') return t.due_date <= inTagenISO(7)
        return true
      })
      .sort((a, b) => a.due_date.localeCompare(b.due_date))
  }, [offeneTasks, faelligFilter, nurMeine, userId, passtZuTagFilter])

  const gefilterteTreffer = treffer.filter(passtZuTagFilter)

  const sucheBegriff = sucheEscapen(suche)
  const sucheAktiv = sucheBegriff.length >= 2
  const sucheLaeuft = sucheAktiv && trefferFuer !== sucheBegriff

  // Freitext-Suche über Titel, Beschreibung und Notiztexte —
  // die RLS begrenzt die Treffer automatisch auf meine Projekte
  useEffect(() => {
    if (!sucheAktiv) return
    let abgebrochen = false
    const timer = setTimeout(async () => {
      const [taskRes, notizRes] = await Promise.all([
        supabase
          .from('tasks')
          .select(SUCHE_SELECT)
          .or(`titel.ilike.%${sucheBegriff}%,beschreibung.ilike.%${sucheBegriff}%`)
          .limit(50),
        supabase
          .from('task_notes')
          .select('task_id')
          .ilike('text', `%${sucheBegriff}%`)
          .limit(100),
      ])

      const direkt = (taskRes.data as unknown as SucheTreffer[]) ?? []
      const direktIds = new Set(direkt.map(t => t.id))
      const notizIds = [...new Set((notizRes.data ?? []).map(n => n.task_id))].filter(tid => !direktIds.has(tid))

      let ausNotizen: SucheTreffer[] = []
      if (notizIds.length > 0) {
        const { data } = await supabase.from('tasks').select(SUCHE_SELECT).in('id', notizIds)
        ausNotizen = ((data as unknown as SucheTreffer[]) ?? []).map(t => ({ ...t, trefferInNotiz: true }))
      }

      if (!abgebrochen) {
        setTreffer([...direkt, ...ausNotizen].sort((a, b) => b.due_date.localeCompare(a.due_date)))
        setTrefferFuer(sucheBegriff)
      }
    }, 300)
    return () => { abgebrochen = true; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sucheBegriff, sucheAktiv])

  const toggleMember = (id: string) => {
    setProjektForm(f => ({
      ...f,
      member_ids: f.member_ids.includes(id) ? f.member_ids.filter(m => m !== id) : [...f.member_ids, id],
    }))
  }

  const handleCreateProjekt = async () => {
    setProjektError('')
    if (!projektForm.name.trim() || !projektForm.company_id) {
      setProjektError(txt('Name und Firma sind Pflichtfelder.'))
      return
    }
    setProjektLoading(true)
    const res = await fetch('/api/aufgaben/projekte', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(projektForm),
    })
    const result = await res.json()
    setProjektLoading(false)
    if (!res.ok) {
      setProjektError(result.error || txt('Fehler beim Anlegen.'))
      return
    }
    // Der Ersteller wird serverseitig immer Mitglied
    const memberIds = [...new Set([userId, ...projektForm.member_ids])]
    const members = memberIds.map(id => ({
      id: `neu-${id}`,
      profile_id: id,
      profile: profiles.find(p => p.id === id) ?? null,
    }))
    setProjects(prev => [...prev, { ...result.project, members, tasks: [] }])
    setProjektForm(emptyProjektForm)
    setProjektModalOpen(false)
  }

  const handleCreateTask = async () => {
    setTaskError('')
    if (!taskForm.project_id || !taskForm.titel.trim() || !taskForm.due_date) {
      setTaskError(txt('Projekt, Titel und Fertigstellungsdatum sind Pflichtfelder.'))
      return
    }
    setTaskLoading(true)
    const res = await fetch('/api/aufgaben/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: taskForm.project_id,
        titel: taskForm.titel,
        beschreibung: taskForm.beschreibung,
        assignee_id: taskForm.assignee_id || null,
        due_date: taskForm.due_date,
        wiederholung: taskForm.wiederholung || null,
        folder_id: taskForm.folder_id || null,
        tag_ids: taskForm.tag_ids,
      }),
    })
    const result = await res.json()
    setTaskLoading(false)
    if (!res.ok) {
      setTaskError(result.error || txt('Fehler beim Anlegen.'))
      return
    }

    const projekt = projects.find(p => p.id === taskForm.project_id)
    // Nicht nach der Eingabe suchen, sondern nach dem, was der Server
    // gespeichert hat — im eigenen Projekt weist der DB-Trigger die
    // Aufgabe der Person selbst zu
    const assignee = projekt?.members.find(m => m.profile_id === result.task.assignee_id)?.profile ?? null
    setOffeneTasks(prev => [...prev, {
      id: result.task.id,
      titel: result.task.titel,
      due_date: result.task.due_date,
      status: 'offen',
      project_id: result.task.project_id,
      assignee_id: result.task.assignee_id,
      parent_task_id: null,
      folder_id: result.task.folder_id ?? null,
      assignee: assignee ? { id: assignee.id, full_name: assignee.full_name } : null,
      project: projekt ? { id: projekt.id, name: projekt.name } : null,
      tags: taskForm.tag_ids
        .map(id => tags.find(t => t.id === id))
        .filter((t): t is TagRow => !!t)
        .map(t => ({ tag: { id: t.id, name: t.name, farbe: t.farbe } })),
    }])
    setProjects(prev => prev.map(p =>
      p.id === taskForm.project_id ? { ...p, tasks: [...p.tasks, { id: result.task.id, status: 'offen' as const }] } : p
    ))
    setTaskForm(emptyTaskForm)
    setTaskModalOpen(false)
  }

  const renderTaskZeile = (task: TaskRow | SucheTreffer, zeigeStatus = false) => {
    const ueberfaellig = task.status === 'offen' && task.due_date < heuteISO()
    return (
      <Link
        key={task.id}
        href={`${basisPfad}/${task.project_id}?task=${task.id}`}
        className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 hover:border-[#1a5276] transition-colors flex items-start sm:items-center justify-between gap-3"
      >
        <div className="min-w-0 flex-1">
          {/* Zwei Zeilen auf dem Handy — siehe renderTaskRow im ProjektClient. */}
          <div className="font-medium text-gray-800 line-clamp-2 sm:line-clamp-none sm:truncate">{task.titel}</div>
          {tagsVonTask(task.tags, tags).length > 0 && (
            <div className="flex flex-wrap items-center gap-1 mt-1.5">
              {tagsVonTask(task.tags, tags).map(t => (
                <TagChip key={t.id} name={t.name} farbe={t.farbe} />
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-gray-500">
            <span className="inline-flex items-center gap-1 text-[#1a5276]">
              <FolderOpen size={12} />
              {task.project?.name ?? txt('Unbekanntes Projekt')}
            </span>
            <span className={ueberfaellig ? 'text-red-600 font-semibold' : ''}>
              {txt('Fällig')}: {formatDate(task.due_date)}
            </span>
            <span>{task.assignee ? task.assignee.full_name : txt('Nicht zugewiesen')}</span>
            {task.folder_id && (
              <span className="inline-flex items-center gap-1">
                <Folder size={12} />
                {folders.find(f => f.id === task.folder_id)?.name ?? txt('Ordner')}
              </span>
            )}
            {task.parent_task_id && <span>{txt('Unter-Task')}</span>}
            {'trefferInNotiz' in task && task.trefferInNotiz && (
              <span className="inline-flex items-center gap-1">
                <MessageSquare size={12} /> {txt('Treffer in Notiz')}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap justify-end items-center gap-x-2 gap-y-1 shrink-0 max-w-[45%] sm:max-w-none">
          {zeigeStatus && task.status === 'geschlossen' && (
            <Badge variant="default"><Archive size={11} className="mr-1" />{txt('Archiviert')}</Badge>
          )}
          {ueberfaellig && <Badge variant="danger">{txt('Überfällig')}</Badge>}
          <ChevronRight size={18} className="text-gray-400" />
        </div>
      </Link>
    )
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-bold text-[#1a5276]">Projekt-Mgt</h1>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          {meineProjekte.length > 0 && (
            <Button
              onClick={() => {
                setTaskForm({ ...emptyTaskForm, project_id: meineProjekte.length === 1 ? meineProjekte[0].id : '' })
                setTaskError('')
                setTaskModalOpen(true)
              }}
              size="sm"
              className="flex-1 sm:flex-none py-2.5 sm:py-1.5 whitespace-nowrap"
            >
              <Plus size={16} /> {txt('Neue Aufgabe')}
            </Button>
          )}
          {isManager && (
            <Button
              variant="outline"
              onClick={() => { setProjektForm(emptyProjektForm); setProjektError(''); setProjektModalOpen(true) }}
              size="sm"
              className="flex-1 sm:flex-none py-2.5 sm:py-1.5 whitespace-nowrap"
            >
              <Plus size={16} /> {txt('Neues Projekt')}
            </Button>
          )}
        </div>
      </div>

      {/* Tabs — auf schmalen Displays horizontal scrollbar statt umbrechend */}
      <div className="flex items-center gap-1 border-b border-gray-200 mb-4 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto">
        {([
          ['projekte', txt('Projekte ({0})', projects.length)],
          ['faellig', `Fällig${ueberfaelligAnzahl > 0 ? ` (${ueberfaelligAnzahl} überfällig)` : ''}`],
          ['suche', txt('Suche')],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`shrink-0 whitespace-nowrap px-3 sm:px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === key ? 'border-[#1a5276] text-[#1a5276]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* --- Projekte --- */}
      {tab === 'projekte' && (
        <>
          {eigenesProjekt && (
            <div className="mb-8">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">{txt('Für mich')}</h2>
              <Link
                href={`${basisPfad}/${eigenesProjekt.id}`}
                className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 hover:border-[#1a5276] transition-colors flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <UserCircle size={16} className="text-[#1a5276] shrink-0" />
                    <span className="font-semibold text-gray-800 truncate">{txt('Eigene Tasks')}</span>
                  </div>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {txt('Nur für dich sichtbar — alles hier ist dir zugewiesen.')}
                  </p>
                  <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                    <span>
                      {txt(
                        eigenesProjekt.tasks.filter(t => t.status === 'offen').length === 1
                          ? '{0} offener Task'
                          : '{0} offene Tasks',
                        eigenesProjekt.tasks.filter(t => t.status === 'offen').length
                      )}
                    </span>
                  </div>
                </div>
                <ChevronRight size={18} className="text-gray-400 shrink-0" />
              </Link>
            </div>
          )}
          {grouped.length === 0 && (
            <div className="text-center py-16 text-gray-500">
              <ClipboardList size={40} className="mx-auto mb-3 text-gray-300" />
              {isManager
                ? txt('Noch keine Projekte. Lege das erste Projekt an.')
                : txt('Dir wurden noch keine Projekte zugewiesen.')}
            </div>
          )}
          {grouped.map(group => (
            <div key={group.companyName} className="mb-8">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">{group.companyName}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {group.projects.map(project => {
                  const offen = project.tasks.filter(t => t.status === 'offen').length
                  return (
                    <Link
                      key={project.id}
                      href={`${basisPfad}/${project.id}`}
                      className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 hover:border-[#1a5276] transition-colors flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-gray-800 truncate">{project.name}</span>
                          {project.status === 'archiviert' && (
                            <Badge variant="default"><Archive size={11} className="mr-1" />{txt('Archiviert')}</Badge>
                          )}
                        </div>
                        {project.beschreibung && (
                          <p className="text-sm text-gray-500 truncate mt-0.5">{project.beschreibung}</p>
                        )}
                        <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                          <span className="inline-flex items-center gap-1">
                            <Users size={13} />
                            {txt(project.members.length === 1 ? '{0} Mitglied' : '{0} Mitglieder', project.members.length)}
                          </span>
                          <span>{txt(offen === 1 ? '{0} offener Task' : '{0} offene Tasks', offen)}</span>
                        </div>
                      </div>
                      <ChevronRight size={18} className="text-gray-400 shrink-0" />
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </>
      )}

      {/* --- Fällige Tasks über alle Projekte --- */}
      {tab === 'faellig' && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {(Object.keys(labels) as FaelligFilter[]).map(key => (
              <button
                key={key}
                onClick={() => setFaelligFilter(key)}
                className={`text-xs rounded-full px-3 py-2 sm:py-1.5 border transition-colors ${faelligFilter === key ? 'bg-[#1a5276] text-white border-[#1a5276]' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}
              >
                {labels[key]}
              </button>
            ))}
            <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer py-2 sm:py-0 sm:ml-2">
              <input
                type="checkbox"
                checked={nurMeine}
                onChange={e => setNurMeine(e.target.checked)}
                className="w-4 h-4 accent-[#1a5276]"
              />
              {txt('Nur meine Aufgaben')}
            </label>
          </div>
          {renderTagFilter()}
          <div className="flex flex-col gap-2">
            {faelligeTasks.length === 0 && (
              <div className="text-center py-16 text-gray-500">
                <CalendarClock size={40} className="mx-auto mb-3 text-gray-300" />
                {txt('Keine Aufgaben in diesem Zeitraum.')}
              </div>
            )}
            {faelligeTasks.map(t => renderTaskZeile(t))}
          </div>
        </>
      )}

      {/* --- Freitext-Suche --- */}
      {tab === 'suche' && (
        <>
          <div className="relative mb-4">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={suche}
              onChange={e => setSuche(e.target.value)}
              autoFocus
              placeholder={txt('Über alle Projekte suchen (Titel, Beschreibung, Notizen) …')}
              className="w-full pl-9 pr-3 py-2.5 sm:py-2 border border-gray-300 rounded-md text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
            />
          </div>
          <p className="text-xs text-gray-500 mb-3">
            {txt('Durchsucht offene und archivierte Aufgaben in allen Projekten, die du sehen darfst.')}
          </p>
          {renderTagFilter()}
          {!sucheAktiv && (
            <p className="text-sm text-gray-400 py-8 text-center">{txt('Mindestens zwei Zeichen eingeben.')}</p>
          )}
          {sucheLaeuft && <p className="text-sm text-gray-400 py-8 text-center">{txt('Suche läuft …')}</p>}
          {sucheAktiv && !sucheLaeuft && gefilterteTreffer.length === 0 && (
            <p className="text-sm text-gray-500 py-8 text-center">
              {txt(filterTags.size > 0 ? 'Keine Treffer für «{0}» mit den gewählten Tags.' : 'Keine Treffer für «{0}».', suche)}
            </p>
          )}
          <div className="flex flex-col gap-2">
            {sucheAktiv && !sucheLaeuft && gefilterteTreffer.map(t => renderTaskZeile(t, true))}
          </div>
        </>
      )}

      {/* Neue Aufgabe */}
      <Modal
        open={taskModalOpen}
        onClose={() => setTaskModalOpen(false)}
        title={txt('Neue Aufgabe')}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setTaskModalOpen(false)}>{txt('Abbrechen')}</Button>
            <Button onClick={handleCreateTask} loading={taskLoading}>{txt('Aufgabe anlegen')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {taskError && <p className="text-sm text-red-600">{taskError}</p>}
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">{txt('Projekt *')}</label>
            <select
              value={taskForm.project_id}
              onChange={e => setTaskForm(f => ({ ...f, project_id: e.target.value, assignee_id: '', folder_id: '', tag_ids: [] }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
            >
              <option value="">{txt('Bitte wählen …')}</option>
              {meineProjekte.map(p => (
                <option key={p.id} value={p.id}>
                  {istPersoenlich(p)
                    ? txt('Eigene Tasks')
                    : p.company?.name ? `${p.company.name} — ${p.name}` : p.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500">{txt('Zur Auswahl stehen die aktiven Projekte, in denen du Mitglied bist.')}</p>
          </div>
          <Input
            label={txt('Titel *')}
            className="text-base sm:text-sm"
            value={taskForm.titel}
            onChange={e => setTaskForm(f => ({ ...f, titel: e.target.value }))}
          />
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">{txt('Beschreibung')}</label>
            <textarea
              value={taskForm.beschreibung}
              onChange={e => setTaskForm(f => ({ ...f, beschreibung: e.target.value }))}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Im eigenen Projekt gibt es nichts zu wählen — alles
                dort gehört mir (der DB-Trigger setzt es ohnehin) */}
            {taskFormIstEigen ? (
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">{txt('Zuständig')}</label>
                <p className="px-3 py-2 text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-md">
                  {txt('Du selbst — im eigenen Projekt ist jede Aufgabe dir zugewiesen.')}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-gray-700">{txt('Zuständig')}</label>
                <select
                  value={taskForm.assignee_id}
                  onChange={e => setTaskForm(f => ({ ...f, assignee_id: e.target.value }))}
                  disabled={!taskForm.project_id}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#1a5276] disabled:bg-gray-50"
                >
                  <option value="">{txt('Nicht zugewiesen')}</option>
                  {(projects.find(p => p.id === taskForm.project_id)?.members ?? [])
                    .map(m => m.profile)
                    .filter((p): p is ProfileOption => !!p)
                    .sort((a, b) => a.full_name.localeCompare(b.full_name))
                    .map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
                </select>
              </div>
            )}
            <Input
              label={txt('Fertigstellungsdatum *')}
              className="text-base sm:text-sm"
              type="date"
              value={taskForm.due_date}
              onChange={e => setTaskForm(f => ({ ...f, due_date: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">{txt('Wiederholung')}</label>
            <select
              value={taskForm.wiederholung}
              onChange={e => setTaskForm(f => ({ ...f, wiederholung: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
            >
              <option value="">{txt('Keine')}</option>
              <option value="woechentlich">{txt('Jede Woche am gleichen Tag')}</option>
              <option value="monatlich">{txt('Jeden Monat am gleichen Tag')}</option>
              <option value="jaehrlich">{txt('Jedes Jahr am gleichen Tag')}</option>
            </select>
            <p className="text-xs text-gray-500">{txt('Beim Schliessen wird automatisch der Folge-Task mit der nächsten Fälligkeit erstellt.')}</p>
          </div>
          {/* Ordner des gewählten Projekts; Ordner selbst werden in
              der Projektansicht verwaltet */}
          {projektOrdner.length > 0 && (
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-gray-700">{txt('Ordner')}</label>
              <select
                value={taskForm.folder_id}
                onChange={e => setTaskForm(f => ({ ...f, folder_id: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
              >
                <option value="">{txt('Ohne Ordner')}</option>
                {projektOrdner.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
          )}
          {/* Tags der Firma des gewählten Projekts; gepflegt werden
              sie in der Projektansicht unter «Tags» */}
          {projektTags.length > 0 && (
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-gray-700">{txt('Tags')}</label>
              <div className="flex flex-wrap items-center gap-1.5">
                {projektTags.map(t => {
                  const gewaehlt = taskForm.tag_ids.includes(t.id)
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTaskForm(f => ({
                        ...f,
                        tag_ids: f.tag_ids.includes(t.id) ? f.tag_ids.filter(id => id !== t.id) : [...f.tag_ids, t.id],
                      }))}
                    >
                      <TagChip name={t.name} farbe={t.farbe} aktiv={gewaehlt} size="sm" className={gewaehlt ? '' : TAG_CHIP_WAEHLBAR} />
                    </button>
                  )
                })}
              </div>
              <p className="text-xs text-gray-500">{txt('Mehrfachauswahl möglich.')}</p>
            </div>
          )}
        </div>
      </Modal>

      {/* Neues Projekt */}
      <Modal
        open={projektModalOpen}
        onClose={() => setProjektModalOpen(false)}
        title={txt('Neues Projekt')}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setProjektModalOpen(false)}>{txt('Abbrechen')}</Button>
            <Button onClick={handleCreateProjekt} loading={projektLoading}>{txt('Projekt anlegen')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {projektError && <p className="text-sm text-red-600">{projektError}</p>}
          <Input
            label={txt('Projektname *')}
            className="text-base sm:text-sm"
            value={projektForm.name}
            onChange={e => setProjektForm(f => ({ ...f, name: e.target.value }))}
            placeholder={txt('z. B. Website-Relaunch')}
          />
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">{txt('Firma *')}</label>
            <select
              value={projektForm.company_id}
              onChange={e => setProjektForm(f => ({ ...f, company_id: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
            >
              <option value="">{txt('Bitte wählen …')}</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">{txt('Beschreibung')}</label>
            <textarea
              value={projektForm.beschreibung}
              onChange={e => setProjektForm(f => ({ ...f, beschreibung: e.target.value }))}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">{txt('Mitglieder')}</label>
            <p className="text-xs text-gray-500 mb-1">Nur Mitglieder können Tasks zugewiesen bekommen. Zur Auswahl stehen Personen mit dem Recht «Projekt-Mgt verwenden» sowie Admins. Du wirst automatisch Mitglied.</p>
            <div className="border border-gray-200 rounded-md max-h-48 overflow-y-auto divide-y divide-gray-100">
              {profiles.map(p => (
                <label key={p.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={projektForm.member_ids.includes(p.id)}
                    onChange={() => toggleMember(p.id)}
                    className="w-4 h-4 accent-[#1a5276]"
                  />
                  <span className="text-gray-800">{p.full_name}</span>
                  <span className="text-gray-400 text-xs truncate">{p.email}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
