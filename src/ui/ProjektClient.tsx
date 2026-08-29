'use client'
import Link from 'next/link'
import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { ArrowLeft, Plus, Search, Users, Archive, RotateCcw, CheckCircle2, Trash2, Pencil, MessageSquare, UserPlus, UserMinus, Paperclip, Bell, X, Repeat, Folder, FolderTree, ChevronDown, ChevronRight, ArrowUp, ArrowDown, Tags } from 'lucide-react'
import Button from './komponenten/Button'
import Badge from './komponenten/Badge'
import Modal from './komponenten/Modal'
import TagChip from './komponenten/TagChip'
import TextMitLinks from './komponenten/TextMitLinks'
import Input from './komponenten/Input'
import { createClient } from './supabaseBrowser'
import { formatDate } from '../hilfen'
import TagModusSchalter from './komponenten/TagModusSchalter'
import { TAG_FARBEN, TAG_FARB_LABELS, TAG_CHIP_WAEHLBAR, passtZuTags, tagsVonTask, type TagFarbe, type TagModus, type TagRow, type TaskTagRef } from '../logik/tags'

interface ProfileOption {
  id: string
  full_name: string
  email: string
}

interface MemberRow {
  id: string
  profile_id: string
  profile: ProfileOption | null
}

interface ProjectRow {
  id: string
  company_id: string
  name: string
  beschreibung: string | null
  status: 'aktiv' | 'archiviert'
  company: { id: string; name: string } | null
  members: MemberRow[]
}

interface FolderRow {
  id: string
  project_id: string
  name: string
  position: number
}

interface TaskRow {
  id: string
  project_id: string
  titel: string
  beschreibung: string | null
  assignee_id: string | null
  created_by: string | null
  due_date: string
  status: 'offen' | 'geschlossen'
  wiederholung: 'woechentlich' | 'monatlich' | 'jaehrlich' | null
  parent_task_id: string | null
  folder_id: string | null
  closed_at: string | null
  assignee: ProfileOption | null
  /* Notiz-Anzahl aus dem Server-Select task_notes(count) */
  notes?: { count: number }[]
  /* Tags aus dem Embed task_tag_zuordnungen(tag:task_tags(...)) */
  tags?: TaskTagRef[]
}

const WIEDERHOLUNG_LABELS: Record<string, string> = {
  woechentlich: 'Jede Woche am gleichen Tag',
  monatlich: 'Jeden Monat am gleichen Tag',
  jaehrlich: 'Jedes Jahr am gleichen Tag',
}

function noteCount(task: TaskRow): number {
  return task.notes?.[0]?.count ?? 0
}

interface NoteRow {
  id: string
  text: string
  file_path: string | null
  file_name: string | null
  created_at: string
  author: { id: string; full_name: string } | null
}

interface WatcherRow {
  profile_id: string
  profile: { id: string; full_name: string } | null
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

interface MoveProjekt {
  id: string
  name: string
  company_id: string | null
  company_name: string | null
}

interface ProjektClientProps {
  project: ProjectRow
  initialTasks: TaskRow[]
  initialFolders: FolderRow[]
  /* Tags der Firma dieses Projekts (gelten firmenweit) */
  initialTags: TagRow[]
  profiles: ProfileOption[]
  /* Aktive Projekte, in denen ich Mitglied bin — Ziele beim Umhängen */
  moveProjekte: MoveProjekt[]
  isManager: boolean
  userId: string
  /** Unter welchem Pfad die Modul-Seiten in dieser App hängen
   *  (Portal `/aufgaben`, Terramay `/dashboard/projekte`). */
  basisPfad?: string
}

const emptyTaskForm = { titel: '', beschreibung: '', assignee_id: '', due_date: '', wiederholung: '', folder_id: '', tag_ids: [] as string[] }
const emptyDetailForm = { ...emptyTaskForm, project_id: '' }

// Tag-IDs einer Aufgabe
function tagIdsVon(task: TaskRow): string[] {
  return (task.tags ?? []).map(z => z.tag?.id).filter((id): id is string => !!id)
}

// Offene Tasks hierarchisch ordnen: Mutter-Tasks nach Fälligkeit,
// ihre offenen Unter-Tasks direkt eingerückt darunter
function hierarchisch(offen: TaskRow[]): { task: TaskRow; istKind: boolean }[] {
  const wurzeln = offen
    .filter(t => !t.parent_task_id)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
  const result: { task: TaskRow; istKind: boolean }[] = []
  for (const wurzel of wurzeln) {
    result.push({ task: wurzel, istKind: false })
    offen
      .filter(t => t.parent_task_id === wurzel.id)
      .sort((a, b) => a.due_date.localeCompare(b.due_date))
      .forEach(kind => result.push({ task: kind, istKind: true }))
  }
  // Offene Unter-Tasks, deren Mutter bereits geschlossen/gelöscht
  // wurde (Altbestand), nicht verlieren
  const enthalten = new Set(result.map(r => r.task.id))
  offen.filter(t => !enthalten.has(t.id)).forEach(t => result.push({ task: t, istKind: true }))
  return result
}

function istUeberfaellig(task: TaskRow): boolean {
  if (task.status !== 'offen') return false
  const heute = new Date()
  heute.setHours(0, 0, 0, 0)
  return new Date(`${task.due_date}T00:00:00`) < heute
}

export default function ProjektClient({ project: initialProject, initialTasks, initialFolders, initialTags, profiles, moveProjekte, isManager, userId, basisPfad = '/aufgaben' }: ProjektClientProps) {
  const supabase = createClient()
  const [project, setProject] = useState(initialProject)
  const [members, setMembers] = useState(initialProject.members)
  const [tasks, setTasks] = useState(initialTasks)
  const [folders, setFolders] = useState(initialFolders)
  const [tags, setTags] = useState(initialTags)
  const [tab, setTab] = useState<'offen' | 'archiv'>('offen')
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Modals
  const [taskModalOpen, setTaskModalOpen] = useState(false)
  const [taskForm, setTaskForm] = useState(emptyTaskForm)
  // Gesetzt, wenn der Anlegen-Dialog einen Unter-Task erstellt
  const [subtaskParent, setSubtaskParent] = useState<TaskRow | null>(null)
  const [memberModalOpen, setMemberModalOpen] = useState(false)
  const [memberError, setMemberError] = useState('')
  const [memberBusyId, setMemberBusyId] = useState<string | null>(null)
  const [projectModalOpen, setProjectModalOpen] = useState(false)
  const [projectForm, setProjectForm] = useState({ name: initialProject.name, beschreibung: initialProject.beschreibung ?? '' })

  // Ordner
  const [folderModalOpen, setFolderModalOpen] = useState(false)
  const [folderError, setFolderError] = useState('')
  const [folderBusyId, setFolderBusyId] = useState<string | null>(null)
  const [neuerFolderName, setNeuerFolderName] = useState('')
  const [editFolderId, setEditFolderId] = useState<string | null>(null)
  const [editFolderName, setEditFolderName] = useState('')
  // Eingeklappte Ordner-Sektionen ('ohne' = Aufgaben ohne Ordner)
  const [eingeklappt, setEingeklappt] = useState<Set<string>>(new Set())

  // Tags (Firma) — Verwaltung und Filter
  const [tagModalOpen, setTagModalOpen] = useState(false)
  const [tagError, setTagError] = useState('')
  const [tagBusyId, setTagBusyId] = useState<string | null>(null)
  const [neuerTagName, setNeuerTagName] = useState('')
  const [neuerTagFarbe, setNeuerTagFarbe] = useState<TagFarbe>('blau')
  const [editTagId, setEditTagId] = useState<string | null>(null)
  const [editTagName, setEditTagName] = useState('')
  const [editTagFarbe, setEditTagFarbe] = useState<TagFarbe>('grau')
  // Gewählte Filter-Tags (ODER-Verknüpfung)
  const [filterTags, setFilterTags] = useState<Set<string>>(new Set())
  const [tagModus, setTagModus] = useState<TagModus>('oder')

  // Task-Detail
  const [detailTask, setDetailTask] = useState<TaskRow | null>(null)
  const [detailForm, setDetailForm] = useState(emptyDetailForm)
  // Bestätigung, nachdem ein Task in ein anderes Projekt umgehängt wurde
  const [moveHinweis, setMoveHinweis] = useState<{ text: string; href: string } | null>(null)
  const [notes, setNotes] = useState<NoteRow[]>([])
  const [notesLoading, setNotesLoading] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [noteSaving, setNoteSaving] = useState(false)
  const [noteFile, setNoteFile] = useState<File | null>(null)
  const [informId, setInformId] = useState('')
  const [watchers, setWatchers] = useState<WatcherRow[]>([])
  const [focusNotes, setFocusNotes] = useState(false)
  const notesRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const openDetail = useCallback((task: TaskRow, mitNotizen = false) => {
    setFocusNotes(mitNotizen)
    setDetailTask(task)
    setDetailForm({
      titel: task.titel,
      beschreibung: task.beschreibung ?? '',
      assignee_id: task.assignee_id ?? '',
      due_date: task.due_date,
      wiederholung: task.wiederholung ?? '',
      folder_id: task.folder_id ?? '',
      tag_ids: tagIdsVon(task),
      project_id: task.project_id,
    })
    setNoteText('')
    setNoteFile(null)
    setInformId('')
    setError('')
  }, [])

  // Deep-Link aus der Zuweisungs-Mail: /aufgaben/[id]?task=<taskId>
  useEffect(() => {
    const taskId = new URLSearchParams(window.location.search).get('task')
    if (!taskId) return
    const task = initialTasks.find(t => t.id === taskId)
    if (task) openDetail(task)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Notizen (chronologisch) und Beobachter laden, sobald ein Task
  // geöffnet wird
  useEffect(() => {
    if (!detailTask) return
    let cancelled = false
    setNotesLoading(true)
    Promise.all([
      supabase
        .from('task_notes')
        .select('id, text, file_path, file_name, created_at, author:profiles!task_notes_author_id_fkey(id, full_name)')
        .eq('task_id', detailTask.id)
        .order('created_at', { ascending: true }),
      supabase
        .from('task_watchers')
        .select('profile_id, profile:profiles!task_watchers_profile_id_fkey(id, full_name)')
        .eq('task_id', detailTask.id),
    ]).then(([{ data: noteData }, { data: watcherData }]) => {
      if (!cancelled) {
        setNotes((noteData as unknown as NoteRow[]) ?? [])
        setWatchers((watcherData as unknown as WatcherRow[]) ?? [])
        setNotesLoading(false)
      }
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailTask?.id])

  // Beim Klick aufs Notiz-Symbol direkt zu den Notizen scrollen
  useEffect(() => {
    if (focusNotes && detailTask && !notesLoading) {
      notesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setFocusNotes(false)
    }
  }, [focusNotes, detailTask, notesLoading])

  const offeneAnzahl = useMemo(() => tasks.filter(t => t.status === 'offen').length, [tasks])

  // Offene Tasks nach Ordner gruppiert; Aufgaben ohne Ordner stehen
  // als letzte Gruppe. Ordner ohne offene Aufgaben bleiben sichtbar —
  // sonst liesse sich dort nichts mehr einsortieren.
  // Tag-Filter: je nach Modus mindestens einer der gewählten Tags
  // («oder») oder alle («und»). Mutter-Tasks passender Unter-Tasks
  // bleiben als Kontext sichtbar.
  const passtZuTagFilter = useCallback(
    (task: TaskRow) => passtZuTags(tagIdsVon(task), filterTags, tagModus),
    [filterTags, tagModus]
  )

  const nachTagFilter = useCallback((liste: TaskRow[]) => {
    if (filterTags.size === 0) return liste
    const treffer = new Set(liste.filter(passtZuTagFilter).map(t => t.id))
    const eltern = new Set(
      liste.filter(t => treffer.has(t.id) && t.parent_task_id).map(t => t.parent_task_id as string)
    )
    return liste.filter(t => treffer.has(t.id) || eltern.has(t.id))
  }, [filterTags, passtZuTagFilter])

  const offeneGruppen = useMemo(() => {
    const offen = nachTagFilter(tasks.filter(t => t.status === 'offen'))
    const bekannt = new Set(folders.map(f => f.id))
    const gruppen: { folder: FolderRow | null; eintraege: { task: TaskRow; istKind: boolean }[] }[] =
      folders.map(f => ({ folder: f, eintraege: hierarchisch(offen.filter(t => t.folder_id === f.id)) }))
    const ohne = hierarchisch(offen.filter(t => !t.folder_id || !bekannt.has(t.folder_id)))
    if (ohne.length > 0 || folders.length === 0) gruppen.push({ folder: null, eintraege: ohne })
    return gruppen
  }, [tasks, folders, nachTagFilter])
  const archivierteTasks = useMemo(() => {
    const geschlossen = nachTagFilter(tasks.filter(t => t.status === 'geschlossen'))
      .sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''))
    const q = search.trim().toLowerCase()
    if (!q) return geschlossen
    return geschlossen.filter(t =>
      t.titel.toLowerCase().includes(q) ||
      (t.beschreibung ?? '').toLowerCase().includes(q) ||
      (t.assignee?.full_name ?? '').toLowerCase().includes(q)
    )
  }, [tasks, search, nachTagFilter])

  const istMitglied = members.some(m => m.profile_id === userId)
  const darfTasksBearbeiten = isManager || istMitglied

  // --- Task anlegen ---
  const handleCreateTask = async () => {
    setError('')
    if (!taskForm.titel.trim() || !taskForm.due_date) {
      setError('Titel und Fertigstellungsdatum sind Pflichtfelder.')
      return
    }
    setLoading(true)
    const res = await fetch('/api/aufgaben/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: project.id,
        titel: taskForm.titel,
        beschreibung: taskForm.beschreibung,
        assignee_id: taskForm.assignee_id || null,
        due_date: taskForm.due_date,
        wiederholung: taskForm.wiederholung || null,
        parent_task_id: subtaskParent?.id ?? null,
        // Unter-Tasks landen im Ordner ihres Mutter-Tasks
        folder_id: subtaskParent ? null : (taskForm.folder_id || null),
        tag_ids: taskForm.tag_ids,
      }),
    })
    const result = await res.json()
    setLoading(false)
    if (!res.ok) {
      setError(result.error || 'Fehler beim Anlegen.')
      return
    }
    setTasks(prev => [...prev, { ...result.task, notes: [{ count: 0 }] }])
    setTaskForm(emptyTaskForm)
    setSubtaskParent(null)
    setTaskModalOpen(false)
  }

  // --- Task-Detail speichern / schliessen / reaktivieren ---
  const patchTask = async (body: Record<string, unknown>): Promise<boolean> => {
    if (!detailTask) return false
    setLoading(true)
    const res = await fetch(`/api/aufgaben/tasks/${detailTask.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const result = await res.json()
    setLoading(false)
    if (!res.ok) {
      setError(result.error || 'Fehler beim Speichern.')
      return false
    }
    // Notiz-Zähler beibehalten — die API liefert ihn nicht mit
    setTasks(prev => {
      const next = prev.map(t => (t.id === result.task.id ? { ...result.task, notes: t.notes } : t))
      // Wiederkehrender Task: beim Schliessen erstellt die API den
      // Folge-Task — direkt in die Liste aufnehmen
      return result.folgeTask ? [...next, { ...result.folgeTask, notes: [{ count: 0 }] }] : next
    })
    setDetailTask(prev => (prev ? { ...result.task, notes: prev.notes } : result.task))
    return true
  }

  const handleSaveDetail = async () => {
    setError('')
    if (!detailForm.titel.trim() || !detailForm.due_date) {
      setError('Titel und Fertigstellungsdatum sind Pflichtfelder.')
      return
    }
    if (!detailTask) return
    const taskId = detailTask.id
    const zielProjekt = detailForm.project_id !== detailTask.project_id
      ? moveProjekte.find(p => p.id === detailForm.project_id) ?? null
      : null

    // Tags gelten pro Firma: beim Umhängen in eine andere Firma
    // fallen sie weg, innerhalb derselben Firma bleiben sie
    const firmenwechsel = !!zielProjekt && zielProjekt.company_id !== project.company_id

    const ok = await patchTask({
      titel: detailForm.titel,
      beschreibung: detailForm.beschreibung,
      assignee_id: detailForm.assignee_id || null,
      due_date: detailForm.due_date,
      wiederholung: detailForm.wiederholung || null,
      // Beim Umhängen fällt die Ordner-Zuordnung serverseitig weg
      folder_id: zielProjekt ? null : (detailForm.folder_id || null),
      tag_ids: firmenwechsel ? [] : detailForm.tag_ids,
      project_id: detailForm.project_id,
    })
    if (!ok) return

    // Unter-Tasks liegen immer im Ordner ihrer Mutter (DB-Trigger) —
    // lokal nachziehen, damit sie in der richtigen Gruppe landen
    if (!zielProjekt) {
      const neuerOrdner = detailForm.folder_id || null
      setTasks(prev => prev.map(t => (t.parent_task_id === taskId ? { ...t, folder_id: neuerOrdner } : t)))
    }

    if (zielProjekt) {
      // Task (und seine Unter-Tasks) liegen jetzt in einem anderen
      // Projekt — aus dieser Liste entfernen
      setTasks(prev => prev.filter(t => t.id !== taskId && t.parent_task_id !== taskId))
      setMoveHinweis({
        text: `Aufgabe wurde ins Projekt «${zielProjekt.name}» verschoben.`,
        href: `${basisPfad}/${zielProjekt.id}?task=${taskId}`,
      })
    }
    setDetailTask(null)
  }

  const handleClose = async () => {
    if (await patchTask({ action: 'schliessen' })) setDetailTask(null)
  }

  const handleReactivate = async () => {
    if (await patchTask({ action: 'reaktivieren' })) {
      setDetailTask(null)
      setTab('offen')
    }
  }

  const handleDeleteTask = async () => {
    if (!detailTask || !confirm('Task endgültig löschen? (Schliessen archiviert ihn stattdessen.)')) return
    setLoading(true)
    const res = await fetch(`/api/aufgaben/tasks/${detailTask.id}`, { method: 'DELETE' })
    setLoading(false)
    if (res.ok) {
      setTasks(prev => prev.filter(t => t.id !== detailTask.id))
      setDetailTask(null)
    }
  }

  // --- Notiz anfügen (optional mit Datei und zu informierender Person) ---
  const handleAddNote = async () => {
    if (!detailTask || !noteText.trim()) return
    setError('')
    setNoteSaving(true)

    // Datei zuerst in den privaten Storage laden
    let filePath: string | null = null
    if (noteFile) {
      const path = `${detailTask.id}/${crypto.randomUUID()}-${noteFile.name}`
      const { error: uploadError } = await supabase.storage
        .from('task-attachments')
        .upload(path, noteFile)
      if (uploadError) {
        setError('Datei konnte nicht hochgeladen werden.')
        setNoteSaving(false)
        return
      }
      filePath = path
    }

    const res = await fetch(`/api/aufgaben/tasks/${detailTask.id}/notizen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: noteText,
        file_path: filePath,
        file_name: noteFile?.name ?? null,
        inform_profile_id: informId || null,
      }),
    })
    const result = await res.json()
    setNoteSaving(false)
    if (res.ok) {
      setNotes(prev => [...prev, result.note])
      setNoteText('')
      setNoteFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      if (informId && !watchers.some(w => w.profile_id === informId)) {
        const profil = memberOptions.find(m => m.id === informId)
        setWatchers(prev => [...prev, { profile_id: informId, profile: profil ? { id: profil.id, full_name: profil.full_name } : null }])
      }
      setInformId('')
      if (result.watcherFehler) setError(result.watcherFehler)
      setTasks(prev => prev.map(t =>
        t.id === detailTask.id ? { ...t, notes: [{ count: noteCount(t) + 1 }] } : t
      ))
    } else {
      setError(result.error || 'Notiz konnte nicht gespeichert werden.')
    }
  }

  // Anhang über eine kurzlebige signierte URL öffnen (privater Bucket)
  const handleOpenAttachment = async (note: NoteRow) => {
    if (!note.file_path) return
    const { data } = await supabase.storage
      .from('task-attachments')
      .createSignedUrl(note.file_path, 60, { download: note.file_name ?? undefined })
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  // Beobachter entfernen (RLS: Projektmitglieder und Verwalter)
  const handleRemoveWatcher = async (profileId: string) => {
    if (!detailTask) return
    const { error: delError } = await supabase
      .from('task_watchers')
      .delete()
      .eq('task_id', detailTask.id)
      .eq('profile_id', profileId)
    if (!delError) setWatchers(prev => prev.filter(w => w.profile_id !== profileId))
  }

  // --- Ordner ---
  const offeneImOrdner = (folderId: string) =>
    tasks.filter(t => t.folder_id === folderId && t.status === 'offen').length
  const gesamtImOrdner = (folderId: string) =>
    tasks.filter(t => t.folder_id === folderId).length

  const toggleGruppe = (key: string) => {
    setEingeklappt(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleCreateFolder = async () => {
    if (!neuerFolderName.trim()) return
    setFolderError('')
    setFolderBusyId('neu')
    const res = await fetch(`/api/aufgaben/projekte/${project.id}/ordner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: neuerFolderName }),
    })
    const result = await res.json()
    setFolderBusyId(null)
    if (!res.ok) {
      setFolderError(result.error || 'Ordner konnte nicht angelegt werden.')
      return
    }
    setFolders(prev => [...prev, result.folder])
    setNeuerFolderName('')
  }

  const handleRenameFolder = async (folderId: string) => {
    if (!editFolderName.trim()) return
    setFolderError('')
    setFolderBusyId(folderId)
    const res = await fetch(`/api/aufgaben/ordner/${folderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editFolderName }),
    })
    const result = await res.json()
    setFolderBusyId(null)
    if (!res.ok) {
      setFolderError(result.error || 'Ordner konnte nicht gespeichert werden.')
      return
    }
    setFolders(prev => prev.map(f => (f.id === folderId ? { ...f, name: result.folder.name } : f)))
    setEditFolderId(null)
  }

  // Reihenfolge tauschen — beide betroffenen Ordner bekommen ihre
  // neue Position, damit auch Altbestände sauber durchnummeriert sind
  const handleMoveFolder = async (index: number, richtung: -1 | 1) => {
    const ziel = index + richtung
    if (ziel < 0 || ziel >= folders.length) return
    const neu = [...folders]
    ;[neu[index], neu[ziel]] = [neu[ziel], neu[index]]
    const nummeriert = neu.map((f, i) => ({ ...f, position: i }))
    setFolders(nummeriert)
    setFolderError('')
    await Promise.all(
      [nummeriert[index], nummeriert[ziel]].map(f =>
        fetch(`/api/aufgaben/ordner/${f.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ position: f.position }),
        })
      )
    )
  }

  const handleDeleteFolder = async (folder: FolderRow) => {
    const offen = offeneImOrdner(folder.id)
    if (offen > 0) {
      setFolderError(`«${folder.name}» enthält noch ${offen} offene ${offen === 1 ? 'Aufgabe' : 'Aufgaben'} — zuerst schliessen oder in einen anderen Ordner verschieben.`)
      return
    }
    const archiviert = gesamtImOrdner(folder.id)
    const frage = archiviert > 0
      ? `Ordner «${folder.name}» löschen? Die ${archiviert} archivierten Aufgaben bleiben erhalten und stehen danach ohne Ordner.`
      : `Ordner «${folder.name}» löschen?`
    if (!confirm(frage)) return

    setFolderError('')
    setFolderBusyId(folder.id)
    const res = await fetch(`/api/aufgaben/ordner/${folder.id}`, { method: 'DELETE' })
    setFolderBusyId(null)
    if (!res.ok) {
      const result = await res.json().catch(() => ({}))
      setFolderError(result.error || 'Ordner konnte nicht gelöscht werden.')
      return
    }
    setFolders(prev => prev.filter(f => f.id !== folder.id))
    setTasks(prev => prev.map(t => (t.folder_id === folder.id ? { ...t, folder_id: null } : t)))
  }

  const oeffneOrdnerVerwaltung = (folder?: FolderRow) => {
    setFolderError('')
    setNeuerFolderName('')
    setEditFolderId(folder?.id ?? null)
    setEditFolderName(folder?.name ?? '')
    setFolderModalOpen(true)
  }

  // --- Tags (Firma) ---
  // Wie oft ein Tag in DIESEM Projekt verwendet wird; firmenweit kann
  // er in weiteren Projekten hängen (Hinweis beim Löschen)
  const tagVerwendung = (tagId: string) =>
    tasks.filter(t => tagIdsVon(t).includes(tagId)).length

  const toggleFilterTag = (tagId: string) => {
    setFilterTags(prev => {
      const next = new Set(prev)
      if (next.has(tagId)) next.delete(tagId)
      else next.add(tagId)
      return next
    })
  }

  const toggleFormTag = (tagId: string, ziel: 'neu' | 'detail') => {
    const umschalten = (ids: string[]) =>
      ids.includes(tagId) ? ids.filter(id => id !== tagId) : [...ids, tagId]
    if (ziel === 'neu') setTaskForm(f => ({ ...f, tag_ids: umschalten(f.tag_ids) }))
    else setDetailForm(f => ({ ...f, tag_ids: umschalten(f.tag_ids) }))
  }

  const handleCreateTag = async () => {
    if (!neuerTagName.trim()) return
    setTagError('')
    setTagBusyId('neu')
    const res = await fetch(`/api/aufgaben/firmen/${project.company_id}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: neuerTagName, farbe: neuerTagFarbe }),
    })
    const result = await res.json()
    setTagBusyId(null)
    if (!res.ok) {
      setTagError(result.error || 'Tag konnte nicht angelegt werden.')
      return
    }
    setTags(prev => [...prev, result.tag])
    setNeuerTagName('')
  }

  const handleSaveTag = async (tagId: string) => {
    if (!editTagName.trim()) return
    setTagError('')
    setTagBusyId(tagId)
    const res = await fetch(`/api/aufgaben/tags/${tagId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editTagName, farbe: editTagFarbe }),
    })
    const result = await res.json()
    setTagBusyId(null)
    if (!res.ok) {
      setTagError(result.error || 'Tag konnte nicht gespeichert werden.')
      return
    }
    setTags(prev => prev.map(t => (t.id === tagId ? { ...t, name: result.tag.name, farbe: result.tag.farbe } : t)))
    // Die Chips an den Aufgaben ziehen mit
    setTasks(prev => prev.map(t => ({
      ...t,
      tags: (t.tags ?? []).map(z =>
        z.tag && z.tag.id === tagId
          ? { tag: { id: z.tag.id, name: result.tag.name as string, farbe: result.tag.farbe as string } }
          : z
      ),
    })))
    setEditTagId(null)
  }

  // Reihenfolge tauschen — wie bei den Ordnern werden beide
  // betroffenen Tags neu durchnummeriert
  const handleMoveTag = async (index: number, richtung: -1 | 1) => {
    const ziel = index + richtung
    if (ziel < 0 || ziel >= tags.length) return
    const neu = [...tags]
    ;[neu[index], neu[ziel]] = [neu[ziel], neu[index]]
    const nummeriert = neu.map((t, i) => ({ ...t, position: i }))
    setTags(nummeriert)
    setTagError('')
    await Promise.all(
      [nummeriert[index], nummeriert[ziel]].map(t =>
        fetch(`/api/aufgaben/tags/${t.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ position: t.position }),
        })
      )
    )
  }

  const handleDeleteTag = async (tag: TagRow) => {
    const hier = tagVerwendung(tag.id)
    const frage = hier > 0
      ? `Tag «${tag.name}» löschen? Er wird aus ${hier} ${hier === 1 ? 'Aufgabe' : 'Aufgaben'} dieses Projekts entfernt — und aus allen weiteren Aufgaben von ${project.company?.name ?? 'dieser Firma'}. Die Aufgaben selbst bleiben bestehen.`
      : `Tag «${tag.name}» löschen? Er verschwindet aus allen Projekten von ${project.company?.name ?? 'dieser Firma'}.`
    if (!confirm(frage)) return

    setTagError('')
    setTagBusyId(tag.id)
    const res = await fetch(`/api/aufgaben/tags/${tag.id}`, { method: 'DELETE' })
    setTagBusyId(null)
    if (!res.ok) {
      const result = await res.json().catch(() => ({}))
      setTagError(result.error || 'Tag konnte nicht gelöscht werden.')
      return
    }
    setTags(prev => prev.filter(t => t.id !== tag.id))
    setTasks(prev => prev.map(t => ({ ...t, tags: (t.tags ?? []).filter(z => z.tag?.id !== tag.id) })))
    setFilterTags(prev => {
      if (!prev.has(tag.id)) return prev
      const next = new Set(prev)
      next.delete(tag.id)
      return next
    })
    setTaskForm(f => ({ ...f, tag_ids: f.tag_ids.filter(id => id !== tag.id) }))
    setDetailForm(f => ({ ...f, tag_ids: f.tag_ids.filter(id => id !== tag.id) }))
  }

  // --- Mitglieder verwalten ---
  const handleAddMember = async (profileId: string) => {
    setMemberError('')
    setMemberBusyId(profileId)
    const res = await fetch(`/api/aufgaben/projekte/${project.id}/mitglieder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId }),
    })
    const result = await res.json()
    setMemberBusyId(null)
    if (res.ok) {
      setMembers(prev => [...prev, result.member])
    } else {
      setMemberError(result.error || 'Mitglied konnte nicht zugefügt werden.')
    }
  }

  const handleRemoveMember = async (profileId: string) => {
    setMemberError('')
    setMemberBusyId(profileId)
    const res = await fetch(`/api/aufgaben/projekte/${project.id}/mitglieder?profileId=${profileId}`, { method: 'DELETE' })
    setMemberBusyId(null)
    if (res.ok) {
      setMembers(prev => prev.filter(m => m.profile_id !== profileId))
    } else {
      const result = await res.json().catch(() => ({}))
      setMemberError(result.error || 'Mitglied konnte nicht entfernt werden.')
    }
  }

  // --- Projekt bearbeiten ---
  const handleSaveProject = async () => {
    setError('')
    if (!projectForm.name.trim()) {
      setError('Der Projektname darf nicht leer sein.')
      return
    }
    setLoading(true)
    const res = await fetch(`/api/aufgaben/projekte/${project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(projectForm),
    })
    const result = await res.json()
    setLoading(false)
    if (!res.ok) {
      setError(result.error || 'Fehler beim Speichern.')
      return
    }
    setProject(prev => ({ ...prev, ...result.project, members: prev.members }))
    setProjectModalOpen(false)
  }

  const memberOptions = members
    .map(m => m.profile)
    .filter((p): p is ProfileOption => !!p)
    .sort((a, b) => a.full_name.localeCompare(b.full_name))

  // Ersteller des geöffneten Tasks — er wird wie der Verantwortliche bei
  // jeder Notiz informiert (nur einmal anzeigen, wenn beides dieselbe Person ist)
  const detailErsteller = detailTask && detailTask.created_by && detailTask.created_by !== detailTask.assignee_id
    ? memberOptions.find(m => m.id === detailTask.created_by) ?? null
    : null

  // Unter-Tasks des geöffneten Tasks (für Anzeige und Abschluss-Sperre)
  const detailKinder = detailTask ? tasks.filter(t => t.parent_task_id === detailTask.id) : []
  const detailOffeneKinder = detailKinder.filter(t => t.status === 'offen').length
  const detailMutter = detailTask?.parent_task_id
    ? tasks.find(t => t.id === detailTask.parent_task_id) ?? null
    : null

  // Zielprojekt beim Umhängen; wechselt dabei die Firma, gelten die
  // Tags dort nicht mehr
  const detailZielProjekt = detailTask && detailForm.project_id !== detailTask.project_id
    ? moveProjekte.find(p => p.id === detailForm.project_id) ?? null
    : null
  const detailFirmenwechsel = !!detailZielProjekt && detailZielProjekt.company_id !== project.company_id

  const renderTaskRow = (task: TaskRow, istKind = false) => (
    <button
      key={task.id}
      onClick={() => openDetail(task)}
      className={`w-full text-left bg-white rounded-lg border border-gray-200 shadow-sm p-4 hover:border-[#1a5276] transition-colors flex items-start sm:items-center justify-between gap-3 ${istKind ? 'ml-3 w-[calc(100%-0.75rem)] sm:ml-6 sm:w-[calc(100%-1.5rem)] border-l-4 border-l-[#d4e6f1]' : ''}`}
    >
      <div className="min-w-0 flex-1">
        <div className="font-medium text-gray-800 truncate">{task.titel}</div>
        {tagsVonTask(task.tags, tags).length > 0 && (
          <div className="flex flex-wrap items-center gap-1 mt-1.5">
            {tagsVonTask(task.tags, tags).map(t => (
              <TagChip key={t.id} name={t.name} farbe={t.farbe} />
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-gray-500">
          <span className={istUeberfaellig(task) ? 'text-red-600 font-semibold' : ''}>
            Fällig: {formatDate(task.due_date)}
          </span>
          <span>{task.assignee ? task.assignee.full_name : 'Nicht zugewiesen'}</span>
          {task.wiederholung && (
            <span className="inline-flex items-center gap-1" title={WIEDERHOLUNG_LABELS[task.wiederholung]}>
              <Repeat size={12} />
              {task.wiederholung === 'woechentlich' ? 'wöchentlich' : task.wiederholung === 'monatlich' ? 'monatlich' : 'jährlich'}
            </span>
          )}
          {(() => {
            const kinder = tasks.filter(t => t.parent_task_id === task.id)
            if (kinder.length === 0) return null
            const erledigt = kinder.filter(k => k.status === 'geschlossen').length
            return <span title="Unter-Tasks erledigt">{erledigt}/{kinder.length} Unter-Tasks</span>
          })()}
          {task.status === 'geschlossen' && task.closed_at && (
            <span>Geschlossen: {formatDate(task.closed_at)}</span>
          )}
          {/* Im Offen-Tab steht der Ordner schon über der Gruppe */}
          {task.status === 'geschlossen' && task.folder_id && (
            <span className="inline-flex items-center gap-1">
              <Folder size={12} />
              {folders.find(f => f.id === task.folder_id)?.name ?? 'Ordner'}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap justify-end items-center gap-x-2 gap-y-1 shrink-0 max-w-[45%] sm:max-w-none">
        {noteCount(task) > 0 && (
          <span
            role="button"
            title="Notizen öffnen"
            onClick={e => { e.stopPropagation(); openDetail(task, true) }}
            className="inline-flex items-center gap-1 text-xs text-[#1a5276] bg-[#eaf2f8] hover:bg-[#d4e6f1] rounded-full px-2.5 py-1.5 transition-colors"
          >
            <MessageSquare size={13} />
            {noteCount(task)}
          </span>
        )}
        {task.status === 'geschlossen'
          ? <Badge variant="default"><Archive size={11} className="mr-1" />Archiviert</Badge>
          : istUeberfaellig(task)
            ? <Badge variant="danger">Überfällig</Badge>
            : <Badge variant="info">Offen</Badge>}
      </div>
    </button>
  )

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:py-8">
      <Link href={basisPfad} className="inline-flex items-center gap-1 py-1 text-sm text-[#1a5276] hover:underline mb-4">
        <ArrowLeft size={15} /> Alle Projekte
      </Link>

      {moveHinweis && (
        <div className="mb-4 p-3 rounded-md bg-green-50 border border-green-200 text-sm text-green-800 flex items-center justify-between gap-3">
          <span>✓ {moveHinweis.text}</span>
          <Link href={moveHinweis.href} className="underline shrink-0">Dort öffnen</Link>
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-bold text-[#1a5276] break-words">{project.name}</h1>
            {project.status === 'archiviert' && <Badge variant="default">Archiviert</Badge>}
          </div>
          <p className="text-sm text-gray-500 mt-1">
            {project.company?.name}
            {project.beschreibung ? ` — ${project.beschreibung}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          {isManager && (
            <>
              <Button variant="outline" size="sm" className="flex-1 sm:flex-none py-2.5 sm:py-1.5" onClick={() => { setProjectForm({ name: project.name, beschreibung: project.beschreibung ?? '' }); setError(''); setProjectModalOpen(true) }}>
                <Pencil size={14} /> Bearbeiten
              </Button>
              <Button variant="outline" size="sm" className="flex-1 sm:flex-none py-2.5 sm:py-1.5" onClick={() => setMemberModalOpen(true)}>
                <Users size={14} /> Mitglieder ({members.length})
              </Button>
            </>
          )}
          {darfTasksBearbeiten && (
            <Button variant="outline" size="sm" className="flex-1 sm:flex-none py-2.5 sm:py-1.5" onClick={() => oeffneOrdnerVerwaltung()}>
              <FolderTree size={14} /> Ordner ({folders.length})
            </Button>
          )}
          {isManager && (
            <Button
              variant="outline"
              size="sm"
              className="flex-1 sm:flex-none py-2.5 sm:py-1.5"
              onClick={() => { setTagError(''); setEditTagId(null); setNeuerTagName(''); setTagModalOpen(true) }}
            >
              <Tags size={14} /> Tags ({tags.length})
            </Button>
          )}
          {darfTasksBearbeiten && (
            <Button size="sm" className="flex-1 sm:flex-none py-2.5 sm:py-1.5" onClick={() => { setTaskForm(emptyTaskForm); setSubtaskParent(null); setError(''); setTaskModalOpen(true) }}>
              <Plus size={16} /> Neuer Task
            </Button>
          )}
        </div>
      </div>

      {!isManager && (
        <div className="flex flex-wrap items-center gap-1.5 mb-6 text-xs text-gray-500">
          <Users size={13} />
          {memberOptions.map(m => (
            <span key={m.id} className="bg-gray-100 rounded-full px-2 py-0.5">{m.full_name}</span>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-gray-200 mb-4">
        <button
          onClick={() => setTab('offen')}
          className={`px-3 sm:px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === 'offen' ? 'border-[#1a5276] text-[#1a5276]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
        >
          Offen ({offeneAnzahl})
        </button>
        <button
          onClick={() => setTab('archiv')}
          className={`px-3 sm:px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === 'archiv' ? 'border-[#1a5276] text-[#1a5276]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
        >
          Archiv ({tasks.filter(t => t.status === 'geschlossen').length})
        </button>
      </div>

      {/* Tag-Filter — ab zwei gewählten Tags ist die Verknüpfung
          umschaltbar; passt ein Unter-Task, bleibt sein Mutter-Task
          als Kontext sichtbar */}
      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          <span className="inline-flex items-center gap-1 text-xs text-gray-500 mr-0.5">
            <Tags size={13} /> Tags:
          </span>
          {tags.map(t => {
            const aktiv = filterTags.has(t.id)
            return (
              <button key={t.id} type="button" onClick={() => toggleFilterTag(t.id)} title={aktiv ? 'Filter entfernen' : 'Nach diesem Tag filtern'}>
                <TagChip
                  name={t.name}
                  farbe={t.farbe}
                  aktiv={aktiv}
                  className={aktiv ? '' : TAG_CHIP_WAEHLBAR}
                />
              </button>
            )
          })}
          {filterTags.size > 1 && (
            <TagModusSchalter modus={tagModus} onChange={setTagModus} />
          )}
          {filterTags.size > 0 && (
            <button
              type="button"
              onClick={() => setFilterTags(new Set())}
              className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 px-2 py-1"
            >
              <X size={12} /> Filter zurücksetzen
            </button>
          )}
        </div>
      )}

      {tab === 'offen' && (
        <div className="flex flex-col gap-3">
          {offeneAnzahl === 0 && folders.length === 0 && (
            <p className="text-sm text-gray-500 py-8 text-center">Keine offenen Tasks.</p>
          )}
          {filterTags.size > 0 && offeneGruppen.every(g => g.eintraege.length === 0) && (
            <p className="text-sm text-gray-500 py-8 text-center">Keine offenen Aufgaben mit den gewählten Tags.</p>
          )}
          {offeneGruppen.map(({ folder, eintraege }) => {
            // Bei aktivem Tag-Filter nur Gruppen mit Treffern zeigen
            if (filterTags.size > 0 && eintraege.length === 0) return null
            // Ohne angelegte Ordner bleibt die Liste flach wie bisher
            if (!folder && folders.length === 0) {
              return (
                <div key="flach" className="flex flex-col gap-2">
                  {eintraege.map(({ task, istKind }) => renderTaskRow(task, istKind))}
                </div>
              )
            }
            const key = folder?.id ?? 'ohne'
            const offen = !eingeklappt.has(key)
            return (
              <section key={key} className="rounded-lg border border-gray-200 bg-gray-50/70 overflow-hidden">
                <div className="flex items-center border-b border-gray-200 bg-white">
                  <button
                    onClick={() => toggleGruppe(key)}
                    aria-expanded={offen}
                    className="min-w-0 flex-1 flex items-center gap-2 px-3 sm:px-4 py-3 text-left hover:bg-gray-50 transition-colors"
                  >
                    {offen
                      ? <ChevronDown size={16} className="text-gray-400 shrink-0" />
                      : <ChevronRight size={16} className="text-gray-400 shrink-0" />}
                    <Folder size={15} className={`shrink-0 ${folder ? 'text-[#1a5276]' : 'text-gray-400'}`} />
                    <span className={`text-sm font-semibold truncate ${folder ? 'text-gray-800' : 'text-gray-500'}`}>
                      {folder ? folder.name : 'Ohne Ordner'}
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-gray-500 bg-gray-100 rounded-full px-2 py-0.5">
                      {eintraege.length}
                    </span>
                  </button>
                  {darfTasksBearbeiten && (
                    <div className="flex items-center shrink-0 pr-1 sm:pr-2">
                      <button
                        title="Aufgabe in diesem Ordner anlegen"
                        onClick={() => {
                          setTaskForm({ ...emptyTaskForm, folder_id: folder?.id ?? '' })
                          setSubtaskParent(null)
                          setError('')
                          setTaskModalOpen(true)
                        }}
                        className="p-2.5 text-gray-400 hover:text-[#1a5276] hover:bg-gray-100 rounded-md transition-colors"
                      >
                        <Plus size={16} />
                      </button>
                      {folder && (
                        <button
                          title="Ordner umbenennen"
                          onClick={() => oeffneOrdnerVerwaltung(folder)}
                          className="p-2.5 text-gray-400 hover:text-[#1a5276] hover:bg-gray-100 rounded-md transition-colors"
                        >
                          <Pencil size={15} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {offen && (
                  <div className="flex flex-col gap-2 p-2 sm:p-3">
                    {eintraege.length === 0
                      ? <p className="text-xs text-gray-400 py-3 text-center">Keine offenen Aufgaben in diesem Ordner.</p>
                      : eintraege.map(({ task, istKind }) => renderTaskRow(task, istKind))}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}

      {tab === 'archiv' && (
        <div className="flex flex-col gap-2">
          <div className="relative mb-2">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Archiv durchsuchen (Titel, Beschreibung, Zuständiger) …"
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
            />
          </div>
          {archivierteTasks.length === 0 && (
            <p className="text-sm text-gray-500 py-8 text-center">
              {search || filterTags.size > 0 ? 'Keine archivierten Tasks gefunden.' : 'Noch keine archivierten Tasks.'}
            </p>
          )}
          {archivierteTasks.map(t => renderTaskRow(t))}
        </div>
      )}

      {/* Neuer Task / Unter-Task */}
      <Modal
        open={taskModalOpen}
        onClose={() => { setSubtaskParent(null); setTaskModalOpen(false) }}
        title={subtaskParent ? 'Neuer Unter-Task' : 'Neuer Task'}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setTaskModalOpen(false)}>Abbrechen</Button>
            <Button onClick={handleCreateTask} loading={loading}>Task anlegen</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error && <p className="text-sm text-red-600">{error}</p>}
          {subtaskParent && (
            <p className="text-sm text-gray-600 bg-[#eaf2f8] rounded-md px-3 py-2">
              Wird als Unter-Task von <strong>«{subtaskParent.titel}»</strong> angelegt.
              Der Mutter-Task kann erst geschlossen werden, wenn alle Unter-Tasks geschlossen sind.
            </p>
          )}
          <Input
            label="Titel *"
            className="text-base sm:text-sm"
            value={taskForm.titel}
            onChange={e => setTaskForm(f => ({ ...f, titel: e.target.value }))}
          />
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">Beschreibung</label>
            <textarea
              value={taskForm.beschreibung}
              onChange={e => setTaskForm(f => ({ ...f, beschreibung: e.target.value }))}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-gray-700">Zuständig</label>
              <select
                value={taskForm.assignee_id}
                onChange={e => setTaskForm(f => ({ ...f, assignee_id: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
              >
                <option value="">Nicht zugewiesen</option>
                {memberOptions.map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
              </select>
            </div>
            <Input
              label="Fertigstellungsdatum *"
              className="text-base sm:text-sm"
              type="date"
              value={taskForm.due_date}
              onChange={e => setTaskForm(f => ({ ...f, due_date: e.target.value }))}
            />
          </div>
          {!subtaskParent && (
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-gray-700">Wiederholung</label>
              <select
                value={taskForm.wiederholung}
                onChange={e => setTaskForm(f => ({ ...f, wiederholung: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
              >
                <option value="">Keine</option>
                <option value="woechentlich">Jede Woche am gleichen Tag</option>
                <option value="monatlich">Jeden Monat am gleichen Tag</option>
                <option value="jaehrlich">Jedes Jahr am gleichen Tag</option>
              </select>
              <p className="text-xs text-gray-500">Beim Schliessen wird automatisch der Folge-Task mit der nächsten Fälligkeit erstellt.</p>
            </div>
          )}
          {!subtaskParent && folders.length > 0 && (
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-gray-700">Ordner</label>
              <select
                value={taskForm.folder_id}
                onChange={e => setTaskForm(f => ({ ...f, folder_id: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
              >
                <option value="">Ohne Ordner</option>
                {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
          )}
          {subtaskParent && subtaskParent.folder_id && (
            <p className="text-xs text-gray-500">
              Der Unter-Task liegt im Ordner «{folders.find(f => f.id === subtaskParent.folder_id)?.name ?? 'Unbekannt'}» des Mutter-Tasks.
            </p>
          )}
          {/* Tags der Firma — Mehrfachauswahl */}
          {tags.length > 0 && (
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-gray-700">Tags</label>
              <div className="flex flex-wrap items-center gap-1.5">
                {tags.map(t => {
                  const gewaehlt = taskForm.tag_ids.includes(t.id)
                  return (
                    <button key={t.id} type="button" onClick={() => toggleFormTag(t.id, 'neu')}>
                      <TagChip name={t.name} farbe={t.farbe} aktiv={gewaehlt} size="sm" className={gewaehlt ? '' : TAG_CHIP_WAEHLBAR} />
                    </button>
                  )
                })}
              </div>
              <p className="text-xs text-gray-500">Mehrfachauswahl möglich. Tags gelten für alle Projekte von {project.company?.name ?? 'dieser Firma'}.</p>
            </div>
          )}
        </div>
      </Modal>

      {/* Task-Detail */}
      <Modal
        open={!!detailTask}
        onClose={() => setDetailTask(null)}
        title={detailTask?.status === 'geschlossen' ? 'Task (archiviert)' : 'Task'}
        size="xl"
        footer={
          detailTask ? (
            <>
              {isManager && (
                <Button variant="danger" onClick={handleDeleteTask} loading={loading} className="mr-auto">
                  <Trash2 size={14} /> Löschen
                </Button>
              )}
              {detailTask.status === 'offen' ? (
                <>
                  <Button
                    variant="secondary"
                    onClick={handleClose}
                    loading={loading}
                    disabled={detailOffeneKinder > 0}
                    title={detailOffeneKinder > 0 ? `Erst möglich, wenn alle Unter-Tasks geschlossen sind (${detailOffeneKinder} offen)` : undefined}
                  >
                    <CheckCircle2 size={15} /> Schliessen<span className="hidden sm:inline">&nbsp;&amp; archivieren</span>
                  </Button>
                  <Button onClick={handleSaveDetail} loading={loading}>Speichern</Button>
                </>
              ) : (
                <Button variant="secondary" onClick={handleReactivate} loading={loading}>
                  <RotateCcw size={15} /> Reaktivieren
                </Button>
              )}
            </>
          ) : undefined
        }
      >
        {detailTask && (
          <div className="flex flex-col gap-4">
            {error && <p className="text-sm text-red-600">{error}</p>}
            {detailMutter && (
              <button
                type="button"
                onClick={() => openDetail(detailMutter)}
                className="self-start inline-flex items-center gap-1 text-xs text-[#1a5276] bg-[#eaf2f8] rounded-full px-2.5 py-1 hover:bg-[#d4e6f1] transition-colors"
              >
                Unter-Task von «{detailMutter.titel}»
              </button>
            )}
            {detailOffeneKinder > 0 && detailTask.status === 'offen' && (
              <p className="text-xs text-amber-700 bg-amber-50 rounded-md px-3 py-2">
                Dieser Task kann erst geschlossen werden, wenn alle Unter-Tasks geschlossen sind ({detailOffeneKinder} noch offen).
              </p>
            )}
            {detailTask.status === 'offen' ? (
              <>
                <Input
                  label="Titel *"
                  className="text-base sm:text-sm"
                  value={detailForm.titel}
                  onChange={e => setDetailForm(f => ({ ...f, titel: e.target.value }))}
                />
                <div className="flex flex-col gap-1">
                  <label className="text-sm font-medium text-gray-700">Beschreibung</label>
                  <textarea
                    value={detailForm.beschreibung}
                    onChange={e => setDetailForm(f => ({ ...f, beschreibung: e.target.value }))}
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium text-gray-700">Zuständig</label>
                    <select
                      value={detailForm.assignee_id}
                      onChange={e => setDetailForm(f => ({ ...f, assignee_id: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
                    >
                      <option value="">Nicht zugewiesen</option>
                      {memberOptions.map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
                    </select>
                  </div>
                  <Input
                    label="Fertigstellungsdatum *"
                    className="text-base sm:text-sm"
                    type="date"
                    value={detailForm.due_date}
                    onChange={e => setDetailForm(f => ({ ...f, due_date: e.target.value }))}
                  />
                </div>
                {!detailTask.parent_task_id && (
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium text-gray-700">Wiederholung</label>
                    <select
                      value={detailForm.wiederholung}
                      onChange={e => setDetailForm(f => ({ ...f, wiederholung: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
                    >
                      <option value="">Keine</option>
                      <option value="woechentlich">Jede Woche am gleichen Tag</option>
                      <option value="monatlich">Jeden Monat am gleichen Tag</option>
                      <option value="jaehrlich">Jedes Jahr am gleichen Tag</option>
                    </select>
                    <p className="text-xs text-gray-500">Beim Schliessen wird automatisch der Folge-Task mit der nächsten Fälligkeit erstellt.</p>
                  </div>
                )}
                {!detailTask.parent_task_id && folders.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium text-gray-700">Ordner</label>
                    <select
                      value={detailForm.project_id !== detailTask.project_id ? '' : detailForm.folder_id}
                      onChange={e => setDetailForm(f => ({ ...f, folder_id: e.target.value }))}
                      disabled={detailForm.project_id !== detailTask.project_id}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#1a5276] disabled:bg-gray-50 disabled:text-gray-400"
                    >
                      <option value="">Ohne Ordner</option>
                      {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                    {detailForm.project_id !== detailTask.project_id
                      ? <p className="text-xs text-amber-700">Ordner gehören zu einem Projekt — beim Umhängen fällt die Zuordnung weg.</p>
                      : detailKinder.length > 0
                        ? <p className="text-xs text-gray-500">Die Unter-Tasks ziehen in denselben Ordner mit.</p>
                        : null}
                  </div>
                )}
                {detailTask.parent_task_id && detailTask.folder_id && (
                  <p className="text-xs text-gray-500">
                    Ordner: «{folders.find(f => f.id === detailTask.folder_id)?.name ?? 'Unbekannt'}» — Unter-Tasks folgen dem Ordner des Mutter-Tasks.
                  </p>
                )}
                {/* Tags der Firma — Mehrfachauswahl */}
                {tags.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium text-gray-700">Tags</label>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {tags.map(t => {
                        const gewaehlt = !detailFirmenwechsel && detailForm.tag_ids.includes(t.id)
                        return (
                          <button
                            key={t.id}
                            type="button"
                            disabled={detailFirmenwechsel}
                            onClick={() => toggleFormTag(t.id, 'detail')}
                            className={detailFirmenwechsel ? 'cursor-not-allowed opacity-40' : ''}
                          >
                            <TagChip name={t.name} farbe={t.farbe} aktiv={gewaehlt} size="sm" className={gewaehlt ? '' : TAG_CHIP_WAEHLBAR} />
                          </button>
                        )
                      })}
                    </div>
                    {detailFirmenwechsel
                      ? <p className="text-xs text-amber-700">Tags gelten pro Firma — beim Wechsel zu «{detailZielProjekt?.company_name}» fallen sie weg.</p>
                      : <p className="text-xs text-gray-500">Mehrfachauswahl möglich. Tags gelten für alle Projekte von {project.company?.name ?? 'dieser Firma'}.</p>}
                  </div>
                )}
                {/* Umhängen — Unter-Tasks ziehen mit dem Mutter-Task mit
                    und lassen sich nicht einzeln verschieben */}
                {!detailTask.parent_task_id && moveProjekte.length > 1 && (
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium text-gray-700">Projekt</label>
                    <select
                      value={detailForm.project_id}
                      onChange={e => setDetailForm(f => ({ ...f, project_id: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
                    >
                      {moveProjekte.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.company_name ? `${p.company_name} — ${p.name}` : p.name}
                        </option>
                      ))}
                    </select>
                    {detailForm.project_id !== detailTask.project_id ? (
                      <p className="text-xs text-amber-700">
                        Beim Speichern wird die Aufgabe umgehängt{detailKinder.length > 0 ? ' — die Unter-Tasks ziehen mit' : ''}.
                        Der Zuständige muss im Zielprojekt Mitglied sein.
                      </p>
                    ) : (
                      <p className="text-xs text-gray-500">Zum Umhängen ein anderes Projekt wählen (nur Projekte, in denen du Mitglied bist).</p>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="text-sm text-gray-700">
                <div className="font-semibold text-gray-800 text-base">{detailTask.titel}</div>
                {tagsVonTask(detailTask.tags, tags).length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 mt-1.5">
                    {tagsVonTask(detailTask.tags, tags).map(t => (
                      <TagChip key={t.id} name={t.name} farbe={t.farbe} />
                    ))}
                  </div>
                )}
                {detailTask.beschreibung && <TextMitLinks text={detailTask.beschreibung} className="mt-1 whitespace-pre-wrap" />}
                <div className="flex flex-wrap gap-4 mt-3 text-xs text-gray-500">
                  <span>Fällig: {formatDate(detailTask.due_date)}</span>
                  <span>Zuständig: {detailTask.assignee?.full_name ?? 'Nicht zugewiesen'}</span>
                  {detailTask.folder_id && (
                    <span>Ordner: {folders.find(f => f.id === detailTask.folder_id)?.name ?? 'Unbekannt'}</span>
                  )}
                  {detailTask.closed_at && <span>Geschlossen: {formatDate(detailTask.closed_at)}</span>}
                </div>
              </div>
            )}

            {/* Unter-Tasks (nur bei Mutter-Tasks) */}
            {!detailTask.parent_task_id && (detailKinder.length > 0 || (darfTasksBearbeiten && detailTask.status === 'offen')) && (
              <div className="border-t border-gray-100 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <h4 className="text-sm font-semibold text-gray-700">
                    Unter-Tasks{detailKinder.length > 0 && ` (${detailKinder.length - detailOffeneKinder}/${detailKinder.length} erledigt)`}
                  </h4>
                  {darfTasksBearbeiten && detailTask.status === 'offen' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSubtaskParent(detailTask)
                        setTaskForm(emptyTaskForm)
                        setDetailTask(null)
                        setError('')
                        setTaskModalOpen(true)
                      }}
                    >
                      <Plus size={14} /> Unter-Task anlegen
                    </Button>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  {detailKinder
                    .sort((a, b) => a.due_date.localeCompare(b.due_date))
                    .map(kind => (
                      <button
                        key={kind.id}
                        type="button"
                        onClick={() => openDetail(kind)}
                        className="flex items-center justify-between gap-2 text-left text-sm bg-gray-50 hover:bg-gray-100 rounded-md px-3 py-2.5 transition-colors"
                      >
                        <span className={`min-w-0 flex-1 truncate ${kind.status === 'geschlossen' ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                          {kind.titel}
                        </span>
                        <span className="flex items-center gap-2 shrink-0 text-xs text-gray-500">
                          {formatDate(kind.due_date)}
                          {kind.status === 'geschlossen'
                            ? <CheckCircle2 size={14} className="text-green-600" />
                            : istUeberfaellig(kind)
                              ? <Badge variant="danger">Überfällig</Badge>
                              : <Badge variant="info">Offen</Badge>}
                        </span>
                      </button>
                    ))}
                </div>
              </div>
            )}

            {/* Notizen — chronologisch, mit Autor */}
            <div ref={notesRef} className="border-t border-gray-100 pt-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 mb-2">
                <h4 className="text-sm font-semibold text-gray-700">Notizen</h4>
                {(watchers.length > 0 || detailTask.assignee || detailErsteller) && (
                  <div className="flex flex-wrap items-center gap-1 text-xs text-gray-500">
                    <Bell size={12} />
                    <span className="mr-0.5">wird informiert:</span>
                    {detailTask.assignee && (
                      <span
                        className="inline-flex items-center gap-1 bg-gray-100 text-gray-600 rounded-full px-2 py-0.5"
                        title="Der Verantwortliche wird bei jeder Notiz automatisch informiert"
                      >
                        {detailTask.assignee.full_name} (verantwortlich)
                      </span>
                    )}
                    {detailErsteller && (
                      <span
                        className="inline-flex items-center gap-1 bg-gray-100 text-gray-600 rounded-full px-2 py-0.5"
                        title="Der Ersteller der Aufgabe wird bei jeder Notiz automatisch informiert"
                      >
                        {detailErsteller.full_name} (Ersteller)
                      </span>
                    )}
                    {watchers.filter(w => w.profile_id !== detailTask.assignee_id && w.profile_id !== detailTask.created_by).map(w => (
                      <span key={w.profile_id} className="inline-flex items-center gap-1 bg-[#eaf2f8] text-[#1a5276] rounded-full pl-2 pr-1 py-0.5">
                        {w.profile?.full_name ?? 'Unbekannt'}
                        {darfTasksBearbeiten && (
                          <button
                            type="button"
                            title="Nicht mehr informieren"
                            onClick={() => handleRemoveWatcher(w.profile_id)}
                            className="hover:bg-[#d4e6f1] rounded-full p-0.5"
                          >
                            <X size={11} />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {notesLoading && <p className="text-sm text-gray-400">Lade Notizen …</p>}
              {!notesLoading && notes.length === 0 && <p className="text-sm text-gray-400">Noch keine Notizen.</p>}
              <div className="flex flex-col gap-2">
                {notes.map(note => (
                  <div key={note.id} className="bg-gray-50 rounded-md px-3 py-2">
                    <div className="text-xs text-gray-500 mb-0.5">
                      <span className="font-medium text-gray-700">{note.author?.full_name ?? 'Unbekannt'}</span>
                      {' — '}
                      {new Date(note.created_at).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </div>
                    <TextMitLinks text={note.text} className="text-sm text-gray-800 whitespace-pre-wrap" />
                    {note.file_path && (
                      <button
                        type="button"
                        onClick={() => handleOpenAttachment(note)}
                        className="inline-flex items-center gap-1 mt-1.5 text-xs text-[#1a5276] hover:underline"
                      >
                        <Paperclip size={12} />
                        {note.file_name ?? 'Anhang'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {darfTasksBearbeiten && (
                <div className="flex flex-col gap-2 mt-3">
                  <textarea
                    value={noteText}
                    onChange={e => setNoteText(e.target.value)}
                    rows={2}
                    placeholder="Notiz hinzufügen …"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 border border-gray-300 rounded-md px-2.5 py-2.5 sm:py-1.5 cursor-pointer hover:bg-gray-50">
                      <Paperclip size={13} />
                      <span className="max-w-32 sm:max-w-40 truncate">{noteFile ? noteFile.name : 'Datei anfügen'}</span>
                      <input
                        ref={fileInputRef}
                        type="file"
                        className="hidden"
                        onChange={e => {
                          const f = e.target.files?.[0] ?? null
                          if (f && f.size > MAX_UPLOAD_BYTES) {
                            setError('Datei ist zu gross (max. 10 MB).')
                            e.target.value = ''
                            return
                          }
                          setNoteFile(f)
                        }}
                      />
                    </label>
                    {noteFile && (
                      <button
                        type="button"
                        title="Datei entfernen"
                        onClick={() => { setNoteFile(null); if (fileInputRef.current) fileInputRef.current.value = '' }}
                        className="text-gray-400 hover:text-gray-600 p-2 -m-1"
                      >
                        <X size={14} />
                      </button>
                    )}
                    <select
                      value={informId}
                      onChange={e => setInformId(e.target.value)}
                      className="min-w-0 flex-1 sm:flex-none text-base sm:text-xs border border-gray-300 rounded-md px-2 py-2 sm:py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
                      title="Diese Person wird über die Notiz informiert und bleibt für künftige Notizen dieses Tasks gespeichert"
                    >
                      <option value="">Person informieren …</option>
                      {memberOptions
                        .filter(m => m.id !== userId && m.id !== detailTask.assignee_id && m.id !== detailTask.created_by && !watchers.some(w => w.profile_id === m.id))
                        .map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
                    </select>
                    <Button size="sm" onClick={handleAddNote} loading={noteSaving} disabled={!noteText.trim()} className="w-full sm:w-auto py-2.5 sm:py-1.5 sm:ml-auto">
                      Anfügen
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* Ordner verwalten — anlegen, umbenennen, sortieren, löschen.
          Löschen ist nur bei Ordnern ohne offene Aufgaben möglich
          (der DB-Trigger erzwingt das zusätzlich serverseitig). */}
      <Modal
        open={folderModalOpen}
        onClose={() => { setEditFolderId(null); setFolderError(''); setFolderModalOpen(false) }}
        title="Ordner verwalten"
        size="lg"
      >
        <p className="text-xs text-gray-500 mb-3">
          Ordner gliedern die Aufgaben dieses Projekts. Jede Aufgabe kann einem
          Ordner zugewiesen werden und erscheint dann in dessen Gruppe;
          Unter-Tasks folgen automatisch dem Ordner ihres Mutter-Tasks.
          Löschen ist erst möglich, wenn keine offenen Aufgaben mehr im Ordner liegen.
        </p>
        {folderError && <p className="text-sm text-red-600 mb-3">{folderError}</p>}

        <div className="border border-gray-200 rounded-md divide-y divide-gray-100 mb-5">
          {folders.length === 0 && (
            <p className="px-3 py-3 text-sm text-gray-400">Noch keine Ordner angelegt.</p>
          )}
          {folders.map((f, i) => {
            const offen = offeneImOrdner(f.id)
            const gesamt = gesamtImOrdner(f.id)
            return (
              <div key={f.id} className="px-3 py-2">
                {editFolderId === f.id ? (
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <input
                      value={editFolderName}
                      onChange={e => setEditFolderName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleRenameFolder(f.id) }}
                      autoFocus
                      maxLength={100}
                      className="min-w-0 flex-1 px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleRenameFolder(f.id)}
                        loading={folderBusyId === f.id}
                        disabled={!editFolderName.trim()}
                        className="flex-1 sm:flex-none py-2.5 sm:py-1.5"
                      >
                        Speichern
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditFolderId(null)} className="flex-1 sm:flex-none py-2.5 sm:py-1.5">
                        Abbrechen
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Folder size={15} className="text-[#1a5276] shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-gray-800 truncate">{f.name}</div>
                      <div className="text-xs text-gray-400">
                        {offen} offen{gesamt > offen ? ` · ${gesamt - offen} archiviert` : ''}
                      </div>
                    </div>
                    <div className="flex items-center shrink-0">
                      <button
                        title="Nach oben"
                        disabled={i === 0}
                        onClick={() => handleMoveFolder(i, -1)}
                        className="p-2.5 text-gray-400 hover:text-gray-700 disabled:opacity-25 disabled:hover:text-gray-400 transition-colors"
                      >
                        <ArrowUp size={15} />
                      </button>
                      <button
                        title="Nach unten"
                        disabled={i === folders.length - 1}
                        onClick={() => handleMoveFolder(i, 1)}
                        className="p-2.5 text-gray-400 hover:text-gray-700 disabled:opacity-25 disabled:hover:text-gray-400 transition-colors"
                      >
                        <ArrowDown size={15} />
                      </button>
                      <button
                        title="Umbenennen"
                        onClick={() => { setFolderError(''); setEditFolderId(f.id); setEditFolderName(f.name) }}
                        className="p-2.5 text-gray-400 hover:text-[#1a5276] transition-colors"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        title={offen > 0 ? `Nicht möglich — ${offen} offene Aufgabe(n) im Ordner` : 'Ordner löschen'}
                        disabled={offen > 0 || folderBusyId === f.id}
                        onClick={() => handleDeleteFolder(f)}
                        className="p-2.5 text-gray-400 hover:text-red-600 disabled:opacity-25 disabled:hover:text-gray-400 transition-colors"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <h4 className="text-sm font-semibold text-gray-700 mb-2">Neuer Ordner</h4>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={neuerFolderName}
            onChange={e => setNeuerFolderName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreateFolder() }}
            placeholder="z. B. Konzept, Umsetzung, Abnahme"
            maxLength={100}
            className="min-w-0 flex-1 px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
          />
          <Button
            onClick={handleCreateFolder}
            loading={folderBusyId === 'neu'}
            disabled={!neuerFolderName.trim()}
            className="shrink-0 py-2.5 sm:py-2"
          >
            <Plus size={16} /> Anlegen
          </Button>
        </div>
      </Modal>

      {/* Tags verwalten (nur Verwalter) — Tags gehören zur FIRMA,
          nicht zum Projekt: Änderungen wirken in allen Projekten
          dieses Mandanten. */}
      <Modal
        open={tagModalOpen}
        onClose={() => { setEditTagId(null); setTagError(''); setTagModalOpen(false) }}
        title={`Tags — ${project.company?.name ?? 'Firma'}`}
        size="lg"
      >
        <p className="text-xs text-gray-500 mb-3">
          Tags werden pro Firma gepflegt und stehen in allen Projekten von{' '}
          {project.company?.name ?? 'dieser Firma'} zur Verfügung. Eine Aufgabe
          kann beliebig viele Tags tragen; über die Tag-Leiste lässt sich die
          Aufgabenliste danach filtern. Löschen entfernt den Tag aus allen
          Aufgaben der Firma — die Aufgaben selbst bleiben bestehen.
        </p>
        {tagError && <p className="text-sm text-red-600 mb-3">{tagError}</p>}

        <div className="border border-gray-200 rounded-md divide-y divide-gray-100 mb-5">
          {tags.length === 0 && (
            <p className="px-3 py-3 text-sm text-gray-400">Noch keine Tags angelegt.</p>
          )}
          {tags.map((t, i) => (
            <div key={t.id} className="px-3 py-2">
              {editTagId === t.id ? (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <input
                      value={editTagName}
                      onChange={e => setEditTagName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleSaveTag(t.id) }}
                      autoFocus
                      maxLength={60}
                      className="min-w-0 flex-1 px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleSaveTag(t.id)}
                        loading={tagBusyId === t.id}
                        disabled={!editTagName.trim()}
                        className="flex-1 sm:flex-none py-2.5 sm:py-1.5"
                      >
                        Speichern
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditTagId(null)} className="flex-1 sm:flex-none py-2.5 sm:py-1.5">
                        Abbrechen
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {TAG_FARBEN.map(f => (
                      <button key={f} type="button" onClick={() => setEditTagFarbe(f)} title={TAG_FARB_LABELS[f]}>
                        <TagChip
                          name={TAG_FARB_LABELS[f]}
                          farbe={f}
                          aktiv={editTagFarbe === f}
                          className={editTagFarbe === f ? '' : TAG_CHIP_WAEHLBAR}
                        />
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <TagChip name={t.name} farbe={t.farbe} size="sm" />
                    <div className="text-xs text-gray-400 mt-1">
                      {tagVerwendung(t.id)} {tagVerwendung(t.id) === 1 ? 'Aufgabe' : 'Aufgaben'} in diesem Projekt
                    </div>
                  </div>
                  <div className="flex items-center shrink-0">
                    <button
                      title="Nach oben"
                      disabled={i === 0}
                      onClick={() => handleMoveTag(i, -1)}
                      className="p-2.5 text-gray-400 hover:text-gray-700 disabled:opacity-25 disabled:hover:text-gray-400 transition-colors"
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      title="Nach unten"
                      disabled={i === tags.length - 1}
                      onClick={() => handleMoveTag(i, 1)}
                      className="p-2.5 text-gray-400 hover:text-gray-700 disabled:opacity-25 disabled:hover:text-gray-400 transition-colors"
                    >
                      <ArrowDown size={15} />
                    </button>
                    <button
                      title="Umbenennen / Farbe ändern"
                      onClick={() => {
                        setTagError('')
                        setEditTagId(t.id)
                        setEditTagName(t.name)
                        setEditTagFarbe((TAG_FARBEN as readonly string[]).includes(t.farbe) ? (t.farbe as TagFarbe) : 'grau')
                      }}
                      className="p-2.5 text-gray-400 hover:text-[#1a5276] transition-colors"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      title="Tag löschen"
                      disabled={tagBusyId === t.id}
                      onClick={() => handleDeleteTag(t)}
                      className="p-2.5 text-gray-400 hover:text-red-600 disabled:opacity-25 disabled:hover:text-gray-400 transition-colors"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <h4 className="text-sm font-semibold text-gray-700 mb-2">Neuer Tag</h4>
        <div className="flex flex-col gap-2">
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={neuerTagName}
              onChange={e => setNeuerTagName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateTag() }}
              placeholder="z. B. Dringend, Marketing, Budget"
              maxLength={60}
              className="min-w-0 flex-1 px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
            />
            <Button
              onClick={handleCreateTag}
              loading={tagBusyId === 'neu'}
              disabled={!neuerTagName.trim()}
              className="shrink-0 py-2.5 sm:py-2"
            >
              <Plus size={16} /> Anlegen
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {TAG_FARBEN.map(f => (
              <button key={f} type="button" onClick={() => setNeuerTagFarbe(f)} title={TAG_FARB_LABELS[f]}>
                <TagChip
                  name={TAG_FARB_LABELS[f]}
                  farbe={f}
                  aktiv={neuerTagFarbe === f}
                  className={neuerTagFarbe === f ? '' : TAG_CHIP_WAEHLBAR}
                />
              </button>
            ))}
          </div>
        </div>
      </Modal>

      {/* Mitglieder verwalten (nur Verwalter) — explizite Buttons
          statt Checkbox-Toggle, damit kein Klick versehentlich
          jemanden aus dem Projekt entfernt */}
      <Modal open={memberModalOpen} onClose={() => { setMemberError(''); setMemberModalOpen(false) }} title="Projektmitglieder" size="lg">
        <p className="text-xs text-gray-500 mb-3">
          Nur Mitglieder können Tasks zugewiesen bekommen. Zur Auswahl stehen
          Personen mit dem Recht «Projekt-Mgt verwenden» sowie Admins.
          Beim Zufügen oder Entfernen wird die Person per Mail informiert.
        </p>
        {memberError && <p className="text-sm text-red-600 mb-3">{memberError}</p>}

        <h4 className="text-sm font-semibold text-gray-700 mb-2">Mitglieder ({members.length})</h4>
        <div className="border border-gray-200 rounded-md divide-y divide-gray-100 mb-4">
          {members.length === 0 && <p className="px-3 py-2 text-sm text-gray-400">Noch keine Mitglieder.</p>}
          {members.map(m => (
            <div key={m.profile_id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="text-gray-800 truncate">{m.profile?.full_name ?? 'Unbekannt'}</div>
                <div className="text-gray-400 text-xs truncate">{m.profile?.email}</div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                loading={memberBusyId === m.profile_id}
                onClick={() => handleRemoveMember(m.profile_id)}
                className="shrink-0 text-red-600 hover:bg-red-50"
              >
                <UserMinus size={14} /> Entfernen
              </Button>
            </div>
          ))}
        </div>

        <h4 className="text-sm font-semibold text-gray-700 mb-2">Hinzufügen</h4>
        <div className="border border-gray-200 rounded-md max-h-64 overflow-y-auto divide-y divide-gray-100">
          {profiles.filter(p => !members.some(m => m.profile_id === p.id)).map(p => (
            <div key={p.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="text-gray-800 truncate">{p.full_name}</div>
                <div className="text-gray-400 text-xs truncate">{p.email}</div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                loading={memberBusyId === p.id}
                onClick={() => handleAddMember(p.id)}
                className="shrink-0"
              >
                <UserPlus size={14} /> Hinzufügen
              </Button>
            </div>
          ))}
          {profiles.filter(p => !members.some(m => m.profile_id === p.id)).length === 0 && (
            <p className="px-3 py-2 text-sm text-gray-400">Alle berechtigten Personen sind bereits Mitglied.</p>
          )}
        </div>
      </Modal>

      {/* Projekt bearbeiten (nur Verwalter) */}
      <Modal
        open={projectModalOpen}
        onClose={() => setProjectModalOpen(false)}
        title="Projekt bearbeiten"
        footer={
          <>
            <Button
              variant="outline"
              onClick={async () => {
                const neu = project.status === 'aktiv' ? 'archiviert' : 'aktiv'
                const res = await fetch(`/api/aufgaben/projekte/${project.id}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ status: neu }),
                })
                if (res.ok) setProject(prev => ({ ...prev, status: neu }))
              }}
              className="mr-auto"
            >
              {project.status === 'aktiv' ? 'Projekt archivieren' : 'Projekt reaktivieren'}
            </Button>
            <Button variant="ghost" onClick={() => setProjectModalOpen(false)}>Abbrechen</Button>
            <Button onClick={handleSaveProject} loading={loading}>Speichern</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Input
            label="Projektname *"
            className="text-base sm:text-sm"
            value={projectForm.name}
            onChange={e => setProjectForm(f => ({ ...f, name: e.target.value }))}
          />
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">Beschreibung</label>
            <textarea
              value={projectForm.beschreibung}
              onChange={e => setProjectForm(f => ({ ...f, beschreibung: e.target.value }))}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#1a5276]"
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
