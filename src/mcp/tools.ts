import type { Db } from '../logik/service'
import {
  createTask,
  updateTask,
  deleteTask,
  addTaskNote,
  createProject,
  updateProject,
  deleteProject,
  addProjectMember,
  removeProjectMember,
  createFolder,
  updateFolder,
  deleteFolder,
  createTag,
  updateTag,
  deleteTag,
  type Result,
} from '../logik/service'
import type { McpIdentitaet } from './auth'
import {
  ZugriffFehlt,
  istAdmin,
  istProjektverwalter,
  ladeOrdnerMitZugriff,
  ladeTagMitZugriff,
  ladeTaskMitZugriff,
  sichtbareFirmenIds,
  sichtbareProjektIds,
  verlangeProjektVerwaltung,
  verlangeProjektZugriff,
  verlangeProjektverwalter,
  verlangeTagPflege,
  verlangeTagSicht,
} from './guard'

// ============================================================
// Werkzeuge des MCP-Servers «TTPortal Projekt-Mgt».
//
// Jedes Werkzeug prüft zuerst die Rechte (guard.ts) und ruft dann
// dieselbe Fachlogik auf, die auch die Web-App benutzt
// (src/lib/aufgaben/service.ts) — inklusive der Benachrichtigungs-
// Mails. Was ein externer Stakeholder über MCP auslöst, ist für das
// Team damit nicht von einer Aktion im Portal zu unterscheiden.
// ============================================================

export interface Kontext {
  supabase: Db
  identitaet: McpIdentitaet
}

export interface ToolDef {
  name: string
  beschreibung: string
  schema: Record<string, unknown>
  /** true = liest nur, verändert nichts */
  nurLesen: boolean
  handler: (ctx: Kontext, args: Record<string, unknown>) => Promise<unknown>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Fehler, dessen Text unverändert an den Aufrufer geht */
export class ToolFehler extends Error {}

function str(args: Record<string, unknown>, key: string, pflicht = true): string {
  const v = args[key]
  if (typeof v !== 'string' || !v.trim()) {
    if (pflicht) throw new ToolFehler(`Parameter «${key}» fehlt.`)
    return ''
  }
  return v
}

function uuid(args: Record<string, unknown>, key: string): string {
  const v = str(args, key)
  if (!UUID_RE.test(v)) throw new ToolFehler(`«${key}» muss eine ID aus dem Portal sein (UUID), nicht ein Name.`)
  return v
}

/** Ergebnis der Fachlogik auspacken oder mit Klartext scheitern */
function auspacken<T>(result: Result<T>): T {
  if (!result.ok) throw new ToolFehler(result.error)
  return result.data
}

/** Heutiges Datum in Schweizer Zeit als YYYY-MM-DD */
function heute(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' })
}

/** Suchbegriff für PostgREST-`or()` entschärfen (siehe Archiv-Suche der App) */
function suchbegriffEntschaerfen(begriff: string): string {
  return begriff.replace(/[,()"\\%_]/g, ' ').trim()
}

// ---- Ausgabeformate ---------------------------------------

interface RohTask {
  id: string
  titel: string
  beschreibung?: string | null
  status: string
  due_date: string
  wiederholung?: string | null
  parent_task_id?: string | null
  folder_id?: string | null
  closed_at?: string | null
  project_id: string
  assignee_id?: string | null
}

type NamenKarte = Map<string, string>
type TagKarte = Map<string, { id: string; name: string; farbe: string }[]>

function taskAusgabe(t: RohTask, projekte: NamenKarte, personen: NamenKarte, ordner: NamenKarte, tags: TagKarte) {
  return {
    id: t.id,
    titel: t.titel,
    beschreibung: t.beschreibung ?? null,
    status: t.status,
    faellig_am: t.due_date,
    ueberfaellig: t.status === 'offen' && t.due_date < heute(),
    wiederholung: t.wiederholung ?? null,
    projekt: { id: t.project_id, name: projekte.get(t.project_id) ?? null },
    ordner: t.folder_id ? { id: t.folder_id, name: ordner.get(t.folder_id) ?? null } : null,
    tags: (tags.get(t.id) ?? []).map(g => ({ id: g.id, name: g.name })),
    zustaendig: t.assignee_id ? { id: t.assignee_id, name: personen.get(t.assignee_id) ?? null } : null,
    ist_unter_task: !!t.parent_task_id,
    mutter_task_id: t.parent_task_id ?? null,
    geschlossen_am: t.closed_at ?? null,
  }
}

/** Projekt-, Personen-, Ordnernamen und Tags für eine Task-Liste nachladen */
async function namenLaden(supabase: Db, tasks: RohTask[]) {
  const projektIds = [...new Set(tasks.map(t => t.project_id))]
  const personIds = [...new Set(tasks.map(t => t.assignee_id).filter((x): x is string => !!x))]
  const ordnerIds = [...new Set(tasks.map(t => t.folder_id).filter((x): x is string => !!x))]
  const taskIds = tasks.map(t => t.id)

  const [projekte, personen, ordner, zuordnungen] = await Promise.all([
    projektIds.length
      ? supabase.from('projects').select('id, name').in('id', projektIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    personIds.length
      ? supabase.from('profiles').select('id, full_name').in('id', personIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
    ordnerIds.length
      ? supabase.from('project_folders').select('id, name').in('id', ordnerIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    taskIds.length
      ? supabase
          .from('task_tag_zuordnungen')
          .select('task_id, tag:task_tags(id, name, farbe, position)')
          .in('task_id', taskIds)
      : Promise.resolve({ data: [] }),
  ])

  const tags: TagKarte = new Map()
  const rohZuordnungen = (zuordnungen.data ?? []) as unknown as {
    task_id: string
    tag: { id: string; name: string; farbe: string; position: number } | null
  }[]
  for (const z of rohZuordnungen) {
    if (!z.tag) continue
    const liste = tags.get(z.task_id) ?? []
    liste.push(z.tag)
    tags.set(z.task_id, liste)
  }
  for (const liste of tags.values()) {
    liste.sort((a, b) => a.name.localeCompare(b.name))
  }

  return {
    projekte: new Map((projekte.data ?? []).map(p => [p.id, p.name])) as NamenKarte,
    personen: new Map((personen.data ?? []).map(p => [p.id, p.full_name])) as NamenKarte,
    ordner: new Map((ordner.data ?? []).map(o => [o.id, o.name])) as NamenKarte,
    tags,
  }
}

async function tasksAusgeben(supabase: Db, tasks: RohTask[]) {
  const { projekte, personen, ordner, tags } = await namenLaden(supabase, tasks)
  return tasks.map(t => taskAusgabe(t, projekte, personen, ordner, tags))
}

/** `tag_ids`-Parameter prüfen (leer/fehlend = kein Tag-Filter) */
function tagIdsAusArgs(args: Record<string, unknown>, key = 'tag_ids'): string[] {
  const v = args[key]
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new ToolFehler(`«${key}» muss eine Liste von Tag-IDs sein.`)
  return v.map(id => {
    if (typeof id !== 'string' || !UUID_RE.test(id))
      throw new ToolFehler(`«${key}» enthält etwas, das keine Tag-ID (UUID) ist — Tag-IDs liefert list_tags.`)
    return id
  })
}

/** IDs aller Aufgaben, die mindestens einen dieser Tags tragen */
async function taskIdsMitTags(supabase: Db, tagIds: string[]): Promise<string[]> {
  const { data } = await supabase
    .from('task_tag_zuordnungen')
    .select('task_id')
    .in('tag_id', tagIds)
    .limit(5000)
  return [...new Set((data ?? []).map(z => z.task_id))]
}

const TASK_FELDER = 'id, project_id, titel, beschreibung, assignee_id, due_date, status, wiederholung, parent_task_id, folder_id, closed_at'

// ---- Werkzeuge --------------------------------------------

export const TOOLS: ToolDef[] = [
  {
    name: 'whoami',
    beschreibung: 'Zeigt, als welche Person dieser Zugang im Tom Talent Portal handelt, und welche Rechte sie im Projekt-Mgt hat. Nützlich als erster Aufruf, um den eigenen Handlungsspielraum zu kennen.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    nurLesen: true,
    async handler({ supabase, identitaet }) {
      const sichtbar = await sichtbareProjektIds(supabase, identitaet)
      return {
        profil_id: identitaet.profile.id,
        name: identitaet.profile.full_name,
        email: identitaet.profile.email,
        zugang: identitaet.tokenName,
        ist_admin: istAdmin(identitaet),
        darf_projekte_verwalten: istProjektverwalter(identitaet),
        sichtbare_projekte: sichtbar === null ? 'alle (Admin)' : sichtbar.length,
      }
    },
  },

  {
    name: 'list_companies',
    beschreibung: 'Listet die Firmen der Holding mit ihren IDs. Wird für company_id beim Anlegen eines Projekts gebraucht.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    nurLesen: true,
    async handler({ supabase }) {
      const { data } = await supabase.from('companies').select('id, name').order('name')
      return { firmen: data ?? [] }
    },
  },

  {
    name: 'list_projects',
    beschreibung: 'Listet alle Projekte, die diese Person sehen darf — mit Firma, Status und der Anzahl offener bzw. überfälliger Aufgaben. Startpunkt für fast alles andere.',
    schema: {
      type: 'object',
      properties: {
        mit_archivierten: { type: 'boolean', description: 'Auch archivierte Projekte zeigen (Standard: nein)' },
      },
      additionalProperties: false,
    },
    nurLesen: true,
    async handler({ supabase, identitaet }, args) {
      const sichtbar = await sichtbareProjektIds(supabase, identitaet)
      if (sichtbar !== null && sichtbar.length === 0) return { projekte: [] }

      let q = supabase
        .from('projects')
        .select('id, name, beschreibung, status, company_id, created_at')
        .order('name')
      if (sichtbar !== null) q = q.in('id', sichtbar)
      if (args.mit_archivierten !== true) q = q.eq('status', 'aktiv')

      const { data: projekte, error } = await q
      if (error) throw new ToolFehler('Projekte konnten nicht geladen werden.')
      const liste = projekte ?? []
      if (liste.length === 0) return { projekte: [] }

      const ids = liste.map(p => p.id)
      const [{ data: firmen }, { data: offeneTasks }] = await Promise.all([
        supabase.from('companies').select('id, name').in('id', [...new Set(liste.map(p => p.company_id))]),
        supabase.from('tasks').select('project_id, due_date').eq('status', 'offen').in('project_id', ids),
      ])
      const firmenName = new Map((firmen ?? []).map(f => [f.id, f.name]))
      const stichtag = heute()

      return {
        projekte: liste.map(p => {
          const eigene = (offeneTasks ?? []).filter(t => t.project_id === p.id)
          return {
            id: p.id,
            name: p.name,
            beschreibung: p.beschreibung,
            status: p.status,
            firma: { id: p.company_id, name: firmenName.get(p.company_id) ?? null },
            offene_aufgaben: eigene.length,
            ueberfaellige_aufgaben: eigene.filter(t => t.due_date < stichtag).length,
          }
        }),
      }
    },
  },

  {
    name: 'get_project',
    beschreibung: 'Details eines Projekts: Beschreibung, Mitglieder (mit ihren IDs — nur Mitglieder können Aufgaben zugewiesen bekommen) und die Ordner des Projekts.',
    schema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: 'ID des Projekts (aus list_projects)' } },
      required: ['project_id'],
      additionalProperties: false,
    },
    nurLesen: true,
    async handler({ supabase, identitaet }, args) {
      const projectId = uuid(args, 'project_id')
      await verlangeProjektZugriff(supabase, identitaet, projectId)

      const [{ data: projekt }, { data: mitglieder }, { data: ordner }, { data: tasks }] = await Promise.all([
        supabase.from('projects').select('id, name, beschreibung, status, company_id, created_at').eq('id', projectId).single(),
        supabase
          .from('project_members')
          .select('profile:profiles!project_members_profile_id_fkey(id, full_name, email)')
          .eq('project_id', projectId),
        supabase.from('project_folders').select('id, name, position').eq('project_id', projectId).order('position'),
        supabase.from('tasks').select('status, due_date').eq('project_id', projectId),
      ])
      if (!projekt) throw new ToolFehler('Projekt nicht gefunden.')

      const { data: firma } = await supabase.from('companies').select('id, name').eq('id', projekt.company_id).maybeSingle()
      const stichtag = heute()
      const offen = (tasks ?? []).filter(t => t.status === 'offen')

      return {
        id: projekt.id,
        name: projekt.name,
        beschreibung: projekt.beschreibung,
        status: projekt.status,
        firma: firma ?? { id: projekt.company_id, name: null },
        mitglieder: (mitglieder ?? [])
          .map(m => m.profile as unknown as { id: string; full_name: string; email: string } | null)
          .filter((p): p is { id: string; full_name: string; email: string } => !!p)
          .map(p => ({ id: p.id, name: p.full_name, email: p.email })),
        ordner: ordner ?? [],
        offene_aufgaben: offen.length,
        ueberfaellige_aufgaben: offen.filter(t => t.due_date < stichtag).length,
        archivierte_aufgaben: (tasks ?? []).length - offen.length,
      }
    },
  },

  {
    name: 'list_tasks',
    beschreibung: 'Listet Aufgaben — wahlweise eines Projekts oder über alle sichtbaren Projekte hinweg. Filter für Status, Zuständigkeit, Ordner, Tags und Fälligkeit. Standard: nur offene Aufgaben, älteste Fälligkeit zuerst.',
    schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Auf ein Projekt einschränken (weglassen = alle sichtbaren Projekte)' },
        status: { type: 'string', enum: ['offen', 'geschlossen', 'alle'], description: 'Standard: offen' },
        nur_meine: { type: 'boolean', description: 'Nur Aufgaben, für die ich selbst zuständig bin' },
        assignee_id: { type: 'string', description: 'Nur Aufgaben dieser Person (Profil-ID)' },
        folder_id: { type: 'string', description: 'Nur Aufgaben in diesem Ordner' },
        tag_ids: { type: 'array', items: { type: 'string' }, description: 'Nur Aufgaben mit mindestens einem dieser Tags (IDs aus list_tags)' },
        nur_ueberfaellig: { type: 'boolean', description: 'Nur Aufgaben, deren Fälligkeit in der Vergangenheit liegt' },
        faellig_bis: { type: 'string', description: 'Nur Aufgaben mit Fälligkeit bis und mit diesem Datum (YYYY-MM-DD)' },
        faellig_ab: { type: 'string', description: 'Nur Aufgaben mit Fälligkeit ab diesem Datum (YYYY-MM-DD)' },
        limit: { type: 'number', description: 'Maximale Anzahl (Standard 50, höchstens 200)' },
      },
      additionalProperties: false,
    },
    nurLesen: true,
    async handler({ supabase, identitaet }, args) {
      let q = supabase.from('tasks').select(TASK_FELDER)

      if (typeof args.project_id === 'string') {
        const projectId = uuid(args, 'project_id')
        await verlangeProjektZugriff(supabase, identitaet, projectId)
        q = q.eq('project_id', projectId)
      } else {
        const sichtbar = await sichtbareProjektIds(supabase, identitaet)
        if (sichtbar !== null) {
          if (sichtbar.length === 0) return { aufgaben: [], anzahl: 0 }
          q = q.in('project_id', sichtbar)
        }
      }

      const status = typeof args.status === 'string' ? args.status : 'offen'
      if (status === 'offen' || status === 'geschlossen') q = q.eq('status', status)

      if (args.nur_meine === true) q = q.eq('assignee_id', identitaet.profile.id)
      else if (typeof args.assignee_id === 'string') q = q.eq('assignee_id', uuid(args, 'assignee_id'))

      if (typeof args.folder_id === 'string') q = q.eq('folder_id', uuid(args, 'folder_id'))

      const filterTags = tagIdsAusArgs(args)
      if (filterTags.length > 0) {
        const taskIds = await taskIdsMitTags(supabase, filterTags)
        if (taskIds.length === 0) return { aufgaben: [], anzahl: 0 }
        q = q.in('id', taskIds)
      }

      if (args.nur_ueberfaellig === true) q = q.lt('due_date', heute())
      if (typeof args.faellig_bis === 'string') q = q.lte('due_date', args.faellig_bis)
      if (typeof args.faellig_ab === 'string') q = q.gte('due_date', args.faellig_ab)

      const limit = Math.min(typeof args.limit === 'number' && args.limit > 0 ? args.limit : 50, 200)
      const { data, error } = await q.order('due_date', { ascending: true }).limit(limit)
      if (error) throw new ToolFehler('Aufgaben konnten nicht geladen werden.')

      const aufgaben = await tasksAusgeben(supabase, (data ?? []) as RohTask[])
      return { aufgaben, anzahl: aufgaben.length, hinweis: aufgaben.length === limit ? `Es wurden ${limit} Treffer zurückgegeben — es kann weitere geben.` : undefined }
    },
  },

  {
    name: 'get_task',
    beschreibung: 'Eine Aufgabe im Detail: Beschreibung, Zuständigkeit, Unter-Aufgaben, alle Notizen in chronologischer Reihenfolge und die Personen, die bei neuen Notizen informiert werden.',
    schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
      additionalProperties: false,
    },
    nurLesen: true,
    async handler({ supabase, identitaet }, args) {
      const taskId = uuid(args, 'task_id')
      await ladeTaskMitZugriff(supabase, identitaet, taskId)

      const [{ data: task }, { data: notizen }, { data: kinder }, { data: watchers }] = await Promise.all([
        supabase.from('tasks').select(TASK_FELDER).eq('id', taskId).single(),
        supabase
          .from('task_notes')
          .select('id, text, file_name, created_at, author:profiles!task_notes_author_id_fkey(id, full_name)')
          .eq('task_id', taskId)
          .order('created_at', { ascending: true }),
        supabase.from('tasks').select(TASK_FELDER).eq('parent_task_id', taskId).order('due_date'),
        supabase
          .from('task_watchers')
          .select('profile:profiles!task_watchers_profile_id_fkey(id, full_name)')
          .eq('task_id', taskId),
      ])
      if (!task) throw new ToolFehler('Aufgabe nicht gefunden.')

      const [haupt] = await tasksAusgeben(supabase, [task as RohTask])
      return {
        ...haupt,
        unter_aufgaben: await tasksAusgeben(supabase, (kinder ?? []) as RohTask[]),
        notizen: (notizen ?? []).map(n => ({
          id: n.id,
          text: n.text,
          anhang: n.file_name ?? null,
          autor: (n.author as unknown as { full_name: string } | null)?.full_name ?? null,
          erfasst_am: n.created_at,
        })),
        beobachter: (watchers ?? [])
          .map(w => w.profile as unknown as { id: string; full_name: string } | null)
          .filter((p): p is { id: string; full_name: string } => !!p)
          .map(p => ({ id: p.id, name: p.full_name })),
      }
    },
  },

  {
    name: 'search_tasks',
    beschreibung: 'Volltextsuche über Titel und Beschreibung aller sichtbaren Aufgaben, auf Wunsch auch über die Notiztexte. Sucht standardmässig auch im Archiv (geschlossene Aufgaben).',
    schema: {
      type: 'object',
      properties: {
        suchbegriff: { type: 'string' },
        mit_notizen: { type: 'boolean', description: 'Auch in den Notiztexten suchen (Standard: ja)' },
        nur_offene: { type: 'boolean', description: 'Geschlossene Aufgaben ausblenden' },
        tag_ids: { type: 'array', items: { type: 'string' }, description: 'Treffer auf Aufgaben mit mindestens einem dieser Tags einschränken' },
        limit: { type: 'number', description: 'Maximale Anzahl (Standard 30, höchstens 100)' },
      },
      required: ['suchbegriff'],
      additionalProperties: false,
    },
    nurLesen: true,
    async handler({ supabase, identitaet }, args) {
      const roh = str(args, 'suchbegriff')
      const begriff = suchbegriffEntschaerfen(roh)
      if (!begriff) throw new ToolFehler('Der Suchbegriff enthält nur Sonderzeichen.')

      const sichtbar = await sichtbareProjektIds(supabase, identitaet)
      if (sichtbar !== null && sichtbar.length === 0) return { aufgaben: [], anzahl: 0 }
      const limit = Math.min(typeof args.limit === 'number' && args.limit > 0 ? args.limit : 30, 100)

      // Tag-Filter: Treffer auf Aufgaben mit einem dieser Tags eingrenzen
      const filterTags = tagIdsAusArgs(args)
      let getaggt: string[] | null = null
      if (filterTags.length > 0) {
        getaggt = await taskIdsMitTags(supabase, filterTags)
        if (getaggt.length === 0) return { aufgaben: [], anzahl: 0 }
      }

      let direkt = supabase
        .from('tasks')
        .select(TASK_FELDER)
        .or(`titel.ilike.%${begriff}%,beschreibung.ilike.%${begriff}%`)
      if (sichtbar !== null) direkt = direkt.in('project_id', sichtbar)
      if (args.nur_offene === true) direkt = direkt.eq('status', 'offen')
      if (getaggt !== null) direkt = direkt.in('id', getaggt)

      const { data: treffer, error } = await direkt.order('due_date', { ascending: false }).limit(limit)
      if (error) throw new ToolFehler('Suche fehlgeschlagen.')

      const gefunden = new Map<string, RohTask>((treffer ?? []).map(t => [t.id, t as RohTask]))
      const ausNotiz = new Set<string>()

      if (args.mit_notizen !== false) {
        const { data: notizen } = await supabase
          .from('task_notes')
          .select('task_id, text')
          .ilike('text', `%${begriff}%`)
          .limit(limit * 3)
        const offeneIds = [...new Set((notizen ?? []).map(n => n.task_id))]
          .filter(id => !gefunden.has(id))
          .filter(id => getaggt === null || getaggt.includes(id))
        if (offeneIds.length > 0) {
          let q = supabase.from('tasks').select(TASK_FELDER).in('id', offeneIds)
          if (sichtbar !== null) q = q.in('project_id', sichtbar)
          if (args.nur_offene === true) q = q.eq('status', 'offen')
          const { data: weitere } = await q.limit(limit)
          for (const t of weitere ?? []) {
            gefunden.set(t.id, t as RohTask)
            ausNotiz.add(t.id)
          }
        }
      }

      const liste = [...gefunden.values()].slice(0, limit)
      const ausgabe = await tasksAusgeben(supabase, liste)
      return {
        anzahl: ausgabe.length,
        aufgaben: ausgabe.map(a => ({ ...a, treffer_in_notiz: ausNotiz.has(a.id) })),
      }
    },
  },

  {
    name: 'list_people',
    beschreibung: 'Listet Personen mit ihren Profil-IDs. Ohne project_id alle Personen aus den Projekten, die du sehen darfst; mit project_id nur die Mitglieder dieses Projekts — nur diese können dort zuständig sein.',
    schema: {
      type: 'object',
      properties: { project_id: { type: 'string' } },
      additionalProperties: false,
    },
    nurLesen: true,
    async handler({ supabase, identitaet }, args) {
      if (typeof args.project_id === 'string') {
        const projectId = uuid(args, 'project_id')
        await verlangeProjektZugriff(supabase, identitaet, projectId)
        const { data } = await supabase
          .from('project_members')
          .select('profile:profiles!project_members_profile_id_fkey(id, full_name, email)')
          .eq('project_id', projectId)
        return {
          personen: (data ?? [])
            .map(m => m.profile as unknown as { id: string; full_name: string; email: string } | null)
            .filter((p): p is { id: string; full_name: string; email: string } => !!p)
            .map(p => ({ id: p.id, name: p.full_name, email: p.email })),
        }
      }

      // Ohne Projekt: nur Personen aus den Projekten, die der Aufrufer
      // ohnehin sehen darf.
      //
      // Vorher lieferte dieser Zweig Name und E-Mail JEDER Person mit
      // Modul-Recht — über den Service-Role-Client, an dem die RLS nicht
      // greift, an einen per Definition externen Zugang. Für den Zweck des
      // Werkzeugs ist das zu viel: Zuständig sein kann nur, wer Mitglied des
      // betreffenden Projekts ist, und diese Projekte sieht der Aufrufer
      // ohnehin schon. Ein vollständiges Mitarbeiterverzeichnis braucht
      // dafür niemand.
      //
      // Admins behalten die volle Liste — sie sehen im Portal alle Projekte
      // und damit ohnehin alle Beteiligten.
      const projektIds = await sichtbareProjektIds(supabase, identitaet)

      if (projektIds === null) {
        const { data } = await supabase
          .from('profiles')
          .select('id, full_name, email, role, can_use_projects, is_blocked')
          .eq('is_blocked', false)
          .order('full_name')
        return {
          personen: (data ?? [])
            .filter(p => p.role === 'admin' || p.can_use_projects)
            .map(p => ({ id: p.id, name: p.full_name, email: p.email })),
        }
      }

      if (projektIds.length === 0) return { personen: [] }

      const { data: mitglieder } = await supabase
        .from('project_members')
        .select('profile_id')
        .in('project_id', projektIds)

      // Die eigene Person immer mitliefern — auch wenn sie (als Ersteller
      // ohne Mitgliedschaft) in keiner Mitgliederliste steht
      const ids = [...new Set([
        ...(mitglieder ?? []).map(m => m.profile_id),
        identitaet.profile.id,
      ])]

      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, email, is_blocked')
        .in('id', ids)
        .eq('is_blocked', false)
        .order('full_name')
      return {
        personen: (data ?? []).map(p => ({ id: p.id, name: p.full_name, email: p.email })),
      }
    },
  },

  {
    name: 'create_task',
    beschreibung: 'Legt eine neue Aufgabe in einem Projekt an. Fälligkeitsdatum ist Pflicht. Die zuständige Person muss Mitglied des Projekts sein und wird per E-Mail informiert. Mit parent_task_id entsteht eine Unter-Aufgabe (nur eine Ebene tief).',
    schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        titel: { type: 'string', description: 'Höchstens 300 Zeichen' },
        faellig_am: { type: 'string', description: 'Fälligkeitsdatum im Format YYYY-MM-DD (Pflicht)' },
        beschreibung: { type: 'string' },
        assignee_id: { type: 'string', description: 'Profil-ID der zuständigen Person (muss Projektmitglied sein)' },
        wiederholung: { type: 'string', enum: ['woechentlich', 'monatlich', 'jaehrlich'], description: 'Beim Schliessen entsteht automatisch die nächste Aufgabe' },
        folder_id: { type: 'string', description: 'Ordner innerhalb des Projekts' },
        tag_ids: { type: 'array', items: { type: 'string' }, description: 'Tags der Aufgabe (IDs aus list_tags; müssen zur Firma des Projekts gehören)' },
        parent_task_id: { type: 'string', description: 'Macht die Aufgabe zur Unter-Aufgabe dieser Aufgabe' },
      },
      required: ['project_id', 'titel', 'faellig_am'],
      additionalProperties: false,
    },
    nurLesen: false,
    async handler({ supabase, identitaet }, args) {
      const projectId = uuid(args, 'project_id')
      await verlangeProjektZugriff(supabase, identitaet, projectId)

      const { task } = auspacken(await createTask(supabase, identitaet.profile.id, {
        project_id: projectId,
        titel: args.titel,
        beschreibung: args.beschreibung,
        assignee_id: args.assignee_id,
        due_date: args.faellig_am,
        wiederholung: args.wiederholung,
        folder_id: args.folder_id,
        tag_ids: 'tag_ids' in args ? tagIdsAusArgs(args) : undefined,
        parent_task_id: args.parent_task_id,
      }))
      const [ausgabe] = await tasksAusgeben(supabase, [task as unknown as RohTask])
      return { angelegt: ausgabe }
    },
  },

  {
    name: 'update_task',
    beschreibung: 'Ändert eine bestehende Aufgabe. Nur die übergebenen Felder werden angefasst. Zuständigkeits-, Titel- und Fälligkeitsänderungen lösen automatisch die üblichen E-Mails aus. Mit project_id wird die Aufgabe in ein anderes Projekt umgehängt (Unter-Aufgaben ziehen mit). tag_ids ersetzt die Tag-Liste vollständig — zuerst get_task lesen, sonst gehen bestehende Tags verloren.',
    schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        titel: { type: 'string' },
        beschreibung: { type: ['string', 'null'] },
        faellig_am: { type: 'string', description: 'YYYY-MM-DD' },
        assignee_id: { type: ['string', 'null'], description: 'null = Zuständigkeit entfernen' },
        wiederholung: { type: ['string', 'null'], enum: ['woechentlich', 'monatlich', 'jaehrlich', null] },
        folder_id: { type: ['string', 'null'], description: 'null = aus dem Ordner nehmen' },
        tag_ids: { type: 'array', items: { type: 'string' }, description: 'Ersetzt die Tags der Aufgabe (leere Liste = alle Tags entfernen)' },
        project_id: { type: 'string', description: 'Zielprojekt beim Umhängen' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    nurLesen: false,
    async handler({ supabase, identitaet }, args) {
      const taskId = uuid(args, 'task_id')
      await ladeTaskMitZugriff(supabase, identitaet, taskId)

      const eingabe: Record<string, unknown> = {}
      if ('titel' in args) eingabe.titel = args.titel
      if ('beschreibung' in args) eingabe.beschreibung = args.beschreibung
      if ('faellig_am' in args) eingabe.due_date = args.faellig_am
      if ('assignee_id' in args) eingabe.assignee_id = args.assignee_id
      if ('wiederholung' in args) eingabe.wiederholung = args.wiederholung
      if ('folder_id' in args) eingabe.folder_id = args.folder_id
      if ('tag_ids' in args) eingabe.tag_ids = tagIdsAusArgs(args)
      if (typeof args.project_id === 'string') {
        const ziel = uuid(args, 'project_id')
        await verlangeProjektZugriff(supabase, identitaet, ziel)
        eingabe.project_id = ziel
      }
      if (Object.keys(eingabe).length === 0) throw new ToolFehler('Keine Änderungen angegeben.')

      const { task } = auspacken(await updateTask(supabase, identitaet.profile.id, taskId, eingabe))
      const [ausgabe] = await tasksAusgeben(supabase, [task as unknown as RohTask])
      return { gespeichert: ausgabe }
    },
  },

  {
    name: 'close_task',
    beschreibung: 'Schliesst eine Aufgabe (= archiviert sie). Alle Projektmitglieder werden per E-Mail informiert. Offene Unter-Aufgaben müssen vorher geschlossen sein. Bei wiederkehrenden Aufgaben entsteht automatisch die nächste.',
    schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
      additionalProperties: false,
    },
    nurLesen: false,
    async handler({ supabase, identitaet }, args) {
      const taskId = uuid(args, 'task_id')
      await ladeTaskMitZugriff(supabase, identitaet, taskId)
      const { task, folgeTask } = auspacken(
        await updateTask(supabase, identitaet.profile.id, taskId, { action: 'schliessen' })
      )
      const ausgabe = await tasksAusgeben(
        supabase,
        [task as unknown as RohTask, ...(folgeTask ? [folgeTask as unknown as RohTask] : [])]
      )
      return { geschlossen: ausgabe[0], folge_aufgabe: ausgabe[1] ?? null }
    },
  },

  {
    name: 'reopen_task',
    beschreibung: 'Reaktiviert eine geschlossene Aufgabe. Die zuständige Person wird per E-Mail informiert.',
    schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
      additionalProperties: false,
    },
    nurLesen: false,
    async handler({ supabase, identitaet }, args) {
      const taskId = uuid(args, 'task_id')
      await ladeTaskMitZugriff(supabase, identitaet, taskId)
      const { task } = auspacken(
        await updateTask(supabase, identitaet.profile.id, taskId, { action: 'reaktivieren' })
      )
      const [ausgabe] = await tasksAusgeben(supabase, [task as unknown as RohTask])
      return { reaktiviert: ausgabe }
    },
  },

  {
    name: 'delete_task',
    beschreibung: 'Löscht eine Aufgabe endgültig samt Notizen und Unter-Aufgaben. Nur für Projektverwalter. In der Regel ist close_task das Richtige — Geschlossenes bleibt im Archiv auffindbar.',
    schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
      additionalProperties: false,
    },
    nurLesen: false,
    async handler({ supabase, identitaet }, args) {
      const taskId = uuid(args, 'task_id')
      const task = await ladeTaskMitZugriff(supabase, identitaet, taskId)
      await verlangeProjektVerwaltung(supabase, identitaet, task.project_id)
      auspacken(await deleteTask(supabase, taskId))
      return { geloescht: { id: taskId, titel: task.titel } }
    },
  },

  {
    name: 'add_note',
    beschreibung: 'Fügt einer Aufgabe eine Notiz hinzu. Notizen sind unveränderlich und bilden den chronologischen Verlauf. Die zuständige Person, der Ersteller der Aufgabe und alle Beobachter werden per E-Mail informiert; mit inform_profile_id kommt eine weitere Person dauerhaft als Beobachter dazu.',
    schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        text: { type: 'string', description: 'Höchstens 5000 Zeichen' },
        inform_profile_id: { type: 'string', description: 'Zusätzlich zu informierende Person (muss Projektmitglied sein)' },
      },
      required: ['task_id', 'text'],
      additionalProperties: false,
    },
    nurLesen: false,
    async handler({ supabase, identitaet }, args) {
      const taskId = uuid(args, 'task_id')
      await ladeTaskMitZugriff(supabase, identitaet, taskId)
      const { note, watcherFehler } = auspacken(await addTaskNote(supabase, identitaet.profile.id, taskId, {
        text: args.text,
        inform_profile_id: args.inform_profile_id,
      }))
      return {
        notiz: { id: note.id, text: note.text, erfasst_am: note.created_at },
        hinweis: watcherFehler ?? undefined,
      }
    },
  },

  {
    name: 'create_project',
    beschreibung: 'Legt ein neues Projekt für eine Firma an. Nur für Personen mit dem Recht «Projekte verwalten». Die anlegende Person wird automatisch Mitglied; weitere Mitglieder werden per E-Mail informiert.',
    schema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'ID der Firma (aus list_companies)' },
        name: { type: 'string' },
        beschreibung: { type: 'string' },
        member_ids: { type: 'array', items: { type: 'string' }, description: 'Profil-IDs weiterer Mitglieder' },
      },
      required: ['company_id', 'name'],
      additionalProperties: false,
    },
    nurLesen: false,
    async handler({ supabase, identitaet }, args) {
      verlangeProjektverwalter(identitaet)
      const { project } = auspacken(await createProject(supabase, identitaet.profile.id, {
        company_id: args.company_id,
        name: args.name,
        beschreibung: args.beschreibung,
        member_ids: args.member_ids,
      }))
      return { angelegt: { id: project.id, name: project.name, status: project.status } }
    },
  },

  {
    name: 'update_project',
    beschreibung: 'Benennt ein Projekt um, ändert die Beschreibung oder archiviert bzw. reaktiviert es. Nur für Verwalter dieses Projekts.',
    schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        name: { type: 'string' },
        beschreibung: { type: ['string', 'null'] },
        status: { type: 'string', enum: ['aktiv', 'archiviert'] },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    nurLesen: false,
    async handler({ supabase, identitaet }, args) {
      const projectId = uuid(args, 'project_id')
      await verlangeProjektVerwaltung(supabase, identitaet, projectId)
      const eingabe: Record<string, unknown> = {}
      if ('name' in args) eingabe.name = args.name
      if ('beschreibung' in args) eingabe.beschreibung = args.beschreibung
      if ('status' in args) eingabe.status = args.status
      const { project } = auspacken(await updateProject(supabase, projectId, eingabe))
      return { gespeichert: { id: project.id, name: project.name, status: project.status } }
    },
  },

  {
    name: 'delete_project',
    beschreibung: 'Löscht ein Projekt endgültig — samt aller Aufgaben, Notizen und Ordner. Nur für Verwalter dieses Projekts. In den meisten Fällen ist Archivieren (update_project mit status «archiviert») die bessere Wahl.',
    schema: {
      type: 'object',
      properties: { project_id: { type: 'string' } },
      required: ['project_id'],
      additionalProperties: false,
    },
    nurLesen: false,
    async handler({ supabase, identitaet }, args) {
      const projectId = uuid(args, 'project_id')
      await verlangeProjektVerwaltung(supabase, identitaet, projectId)
      auspacken(await deleteProject(supabase, projectId))
      return { geloescht: { id: projectId } }
    },
  },

  {
    name: 'add_project_member',
    beschreibung: 'Fügt eine Person einem Projekt als Mitglied hinzu (Voraussetzung, um dort zuständig sein zu können). Die Person wird per E-Mail informiert. Nur für Verwalter dieses Projekts.',
    schema: {
      type: 'object',
      properties: { project_id: { type: 'string' }, profile_id: { type: 'string' } },
      required: ['project_id', 'profile_id'],
      additionalProperties: false,
    },
    nurLesen: false,
    async handler({ supabase, identitaet }, args) {
      const projectId = uuid(args, 'project_id')
      await verlangeProjektVerwaltung(supabase, identitaet, projectId)
      auspacken(await addProjectMember(supabase, identitaet.profile.id, projectId, uuid(args, 'profile_id')))
      return { zugefuegt: { project_id: projectId, profile_id: args.profile_id } }
    },
  },

  {
    name: 'remove_project_member',
    beschreibung: 'Entfernt eine Person aus einem Projekt. Offene Aufgaben der Person bleiben bestehen und sollten neu zugewiesen werden. Die Person wird per E-Mail informiert. Nur für Verwalter dieses Projekts.',
    schema: {
      type: 'object',
      properties: { project_id: { type: 'string' }, profile_id: { type: 'string' } },
      required: ['project_id', 'profile_id'],
      additionalProperties: false,
    },
    nurLesen: false,
    async handler({ supabase, identitaet }, args) {
      const projectId = uuid(args, 'project_id')
      await verlangeProjektVerwaltung(supabase, identitaet, projectId)
      auspacken(await removeProjectMember(supabase, identitaet.profile.id, projectId, uuid(args, 'profile_id')))
      return { entfernt: { project_id: projectId, profile_id: args.profile_id } }
    },
  },

  {
    name: 'create_folder',
    beschreibung: 'Legt im Projekt einen Ordner an, um Aufgaben zu gruppieren. Der Name muss im Projekt eindeutig sein.',
    schema: {
      type: 'object',
      properties: { project_id: { type: 'string' }, name: { type: 'string' } },
      required: ['project_id', 'name'],
      additionalProperties: false,
    },
    nurLesen: false,
    async handler({ supabase, identitaet }, args) {
      const projectId = uuid(args, 'project_id')
      await verlangeProjektZugriff(supabase, identitaet, projectId)
      const { folder } = auspacken(await createFolder(supabase, identitaet.profile.id, projectId, args.name))
      return { angelegt: folder }
    },
  },

  {
    name: 'update_folder',
    beschreibung: 'Benennt einen Ordner um oder ändert seine Position in der Liste (0 = zuoberst).',
    schema: {
      type: 'object',
      properties: {
        folder_id: { type: 'string' },
        name: { type: 'string' },
        position: { type: 'number' },
      },
      required: ['folder_id'],
      additionalProperties: false,
    },
    nurLesen: false,
    async handler({ supabase, identitaet }, args) {
      const folderId = uuid(args, 'folder_id')
      await ladeOrdnerMitZugriff(supabase, identitaet, folderId)
      const eingabe: Record<string, unknown> = {}
      if ('name' in args) eingabe.name = args.name
      if ('position' in args) eingabe.position = args.position
      const { folder } = auspacken(await updateFolder(supabase, folderId, eingabe))
      return { gespeichert: folder }
    },
  },

  {
    name: 'delete_folder',
    beschreibung: 'Löscht einen Ordner. Das geht nur, wenn keine offenen Aufgaben mehr darin liegen; archivierte Aufgaben verlieren lediglich die Ordner-Zuordnung.',
    schema: {
      type: 'object',
      properties: { folder_id: { type: 'string' } },
      required: ['folder_id'],
      additionalProperties: false,
    },
    nurLesen: false,
    async handler({ supabase, identitaet }, args) {
      const folderId = uuid(args, 'folder_id')
      const folder = await ladeOrdnerMitZugriff(supabase, identitaet, folderId)
      auspacken(await deleteFolder(supabase, folderId))
      return { geloescht: { id: folderId, name: folder.name } }
    },
  },

  {
    name: 'list_tags',
    beschreibung: 'Listet die Tags mit ihren IDs. Tags gehören zur FIRMA (Mandant), nicht zum Projekt: derselbe Tag steht in allen Projekten einer Firma zur Verfügung. Ohne company_id werden die Tags aller Firmen gezeigt, in denen du ein Projekt hast.',
    schema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'Nur die Tags dieser Firma (IDs aus list_companies)' },
      },
      additionalProperties: false,
    },
    nurLesen: true,
    async handler({ supabase, identitaet }, args) {
      let firmenIds: string[] | null
      if (typeof args.company_id === 'string') {
        const companyId = uuid(args, 'company_id')
        await verlangeTagSicht(supabase, identitaet, companyId)
        firmenIds = [companyId]
      } else {
        firmenIds = await sichtbareFirmenIds(supabase, identitaet)
        if (firmenIds !== null && firmenIds.length === 0) return { tags: [] }
      }

      let q = supabase.from('task_tags').select('id, company_id, name, farbe, position').order('position')
      if (firmenIds !== null) q = q.in('company_id', firmenIds)
      const { data: tags, error } = await q
      if (error) throw new ToolFehler('Tags konnten nicht geladen werden.')
      const liste = tags ?? []
      if (liste.length === 0) return { tags: [] }

      const { data: firmen } = await supabase
        .from('companies')
        .select('id, name')
        .in('id', [...new Set(liste.map(t => t.company_id))])
      const firmenName = new Map((firmen ?? []).map(f => [f.id, f.name]))

      return {
        tags: liste.map(t => ({
          id: t.id,
          name: t.name,
          farbe: t.farbe,
          firma: { id: t.company_id, name: firmenName.get(t.company_id) ?? null },
        })),
      }
    },
  },

  {
    name: 'create_tag',
    beschreibung: 'Legt für eine Firma einen neuen Tag an. Er steht danach in allen Projekten dieser Firma zur Verfügung. Der Name muss pro Firma eindeutig sein. Nur für Admins und Projektverwalter dieser Firma.',
    schema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'ID der Firma (aus list_companies)' },
        name: { type: 'string', description: 'Höchstens 60 Zeichen' },
        farbe: {
          type: 'string',
          enum: ['grau', 'blau', 'gruen', 'gelb', 'orange', 'rot', 'violett', 'tuerkis'],
          description: 'Farbe des Chips im Portal (Standard: grau)',
        },
      },
      required: ['company_id', 'name'],
      additionalProperties: false,
    },
    nurLesen: false,
    async handler({ supabase, identitaet }, args) {
      const companyId = uuid(args, 'company_id')
      await verlangeTagPflege(supabase, identitaet, companyId)
      const { tag } = auspacken(await createTag(supabase, identitaet.profile.id, companyId, {
        name: args.name,
        farbe: args.farbe,
      }))
      return { angelegt: tag }
    },
  },

  {
    name: 'update_tag',
    beschreibung: 'Benennt einen Tag um, ändert seine Farbe oder seine Position in der Liste (0 = zuoberst). Die Änderung wirkt in allen Projekten der Firma. Nur für Admins und Projektverwalter dieser Firma.',
    schema: {
      type: 'object',
      properties: {
        tag_id: { type: 'string' },
        name: { type: 'string' },
        farbe: {
          type: 'string',
          enum: ['grau', 'blau', 'gruen', 'gelb', 'orange', 'rot', 'violett', 'tuerkis'],
        },
        position: { type: 'number' },
      },
      required: ['tag_id'],
      additionalProperties: false,
    },
    nurLesen: false,
    async handler({ supabase, identitaet }, args) {
      const tagId = uuid(args, 'tag_id')
      const vorher = await ladeTagMitZugriff(supabase, identitaet, tagId)
      await verlangeTagPflege(supabase, identitaet, vorher.company_id)

      const eingabe: Record<string, unknown> = {}
      if ('name' in args) eingabe.name = args.name
      if ('farbe' in args) eingabe.farbe = args.farbe
      if ('position' in args) eingabe.position = args.position
      if (Object.keys(eingabe).length === 0) throw new ToolFehler('Keine Änderungen angegeben.')

      const { tag } = auspacken(await updateTag(supabase, tagId, eingabe))
      return { gespeichert: tag }
    },
  },

  {
    name: 'delete_tag',
    beschreibung: 'Löscht einen Tag endgültig. Er verschwindet damit aus ALLEN Aufgaben dieser Firma — die Aufgaben selbst bleiben unverändert bestehen. Nur für Admins und Projektverwalter dieser Firma.',
    schema: {
      type: 'object',
      properties: { tag_id: { type: 'string' } },
      required: ['tag_id'],
      additionalProperties: false,
    },
    nurLesen: false,
    async handler({ supabase, identitaet }, args) {
      const tagId = uuid(args, 'tag_id')
      const tag = await ladeTagMitZugriff(supabase, identitaet, tagId)
      await verlangeTagPflege(supabase, identitaet, tag.company_id)
      auspacken(await deleteTag(supabase, tagId))
      return { geloescht: { id: tagId, name: tag.name } }
    },
  },
]

export const TOOL_MAP = new Map(TOOLS.map(t => [t.name, t]))

/** Werkzeugliste im MCP-Format */
export function toolListe() {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.beschreibung,
    inputSchema: t.schema,
    annotations: {
      readOnlyHint: t.nurLesen,
      destructiveHint: t.name.startsWith('delete_'),
      idempotentHint: t.nurLesen,
      openWorldHint: false,
    },
  }))
}

/** Werkzeug ausführen; Rechte- und Fachfehler kommen als Klartext zurück */
export async function toolAusfuehren(
  ctx: Kontext,
  name: string,
  args: Record<string, unknown>
): Promise<{ erfolg: true; daten: unknown } | { erfolg: false; fehler: string }> {
  const tool = TOOL_MAP.get(name)
  if (!tool) return { erfolg: false, fehler: `Unbekanntes Werkzeug «${name}».` }

  try {
    return { erfolg: true, daten: await tool.handler(ctx, args ?? {}) }
  } catch (e) {
    if (e instanceof ZugriffFehlt || e instanceof ToolFehler) return { erfolg: false, fehler: e.message }
    console.error(`MCP-Werkzeug ${name} fehlgeschlagen:`, e)
    return { erfolg: false, fehler: 'Unerwarteter Fehler im Portal. Bitte später erneut versuchen.' }
  }
}
