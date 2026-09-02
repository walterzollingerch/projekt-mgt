import type { Db, Result } from '../typen'
import { istTagFarbe, type TagFarbe } from './tags'
import { hostLesen } from '../host'
import {
  sendTaskAssignedMail,
  sendTaskUnassignedMail,
  sendTaskChangedMail,
  sendTaskClosedMail,
  sendTaskNoteMail,
  sendMemberAddedMail,
  sendMemberRemovedMail,
  formatDatum,
  type MailAttachment,
} from '../mail/taskMail'

// ============================================================
// Fachlogik des Projekt-Mgt (Projekte, Ordner, Tasks, Notizen).
//
// Bewusst frei von HTTP und von Authentifizierung: die Funktionen
// bekommen einen Supabase-Client und die Profil-ID des Handelnden.
// Über die Web-App kommt ein Cookie-gebundener Client — dort ist die
// RLS die Zugriffskontrolle. Über den MCP-Server (externe
// Stakeholder) kommt ein Service-Role-Client; dort prüft
// `src/lib/mcp/guard.ts` die Rechte vorher explizit, weil die RLS
// für den Service-Role-Schlüssel nicht greift.
// ============================================================

// `Db` und `Result` liegen seit der Auslagerung in `../typen`. Sie
// werden hier weiterhin re-exportiert, damit die bestehenden Importe
// (MCP-Werkzeuge, API-Routen) unverändert bleiben.
export type { Db, Result }

const fail = (status: number, error: string): { ok: false; status: number; error: string } =>
  ({ ok: false, status, error })
const done = <T>(data: T): { ok: true; data: T } => ({ ok: true, data })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Tags hängen über die Zuordnungstabelle an der Aufgabe; das Embed
// liefert sie in derselben Form, die auch die Seiten-Selects nutzen
export const TAG_EMBED = 'tags:task_tag_zuordnungen(tag:task_tags(id, name, farbe))'

export const TASK_SELECT =
  `*, assignee:profiles!tasks_assignee_id_fkey(id, full_name, email), project:projects(id, name, company_id), ${TAG_EMBED}`

// Resend-Limit ist 40 MB pro Mail — wir bleiben deutlich darunter
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

export type Wiederholung = 'woechentlich' | 'monatlich' | 'jaehrlich'
const WIEDERHOLUNGEN: Wiederholung[] = ['woechentlich', 'monatlich', 'jaehrlich']

interface Empfaenger {
  id: string
  full_name: string
  email: string
}

interface Akteur {
  /** Anzeigename für den Mailtext */
  name: string
  /** Reply-To der Benachrichtigung — null, wenn das Profil fehlt */
  email: string | null
}

// Wer die Benachrichtigung auslöst: Name für den Text, Mail-Adresse
// als Reply-To, damit Antworten bei dieser Person landen und nicht im
// Sammelpostfach
async function akteurVon(supabase: Db, userId: string, fallback: string): Promise<Akteur> {
  const { data } = await supabase.from('mitarbeiter_verzeichnis').select('full_name, email').eq('id', userId).single()
  return { name: data?.full_name ?? fallback, email: data?.email ?? null }
}

// Nächste Fälligkeit gemäss Regel, ausgehend von der bisherigen
// Fälligkeit; liegt das Ergebnis nicht in der Zukunft (Task wurde
// verspätet geschlossen), wird weitergeschaltet bis es das tut.
// Monatlich: gleicher Tag, auf Monatsende geklemmt (31. → 28./30.).
export function naechsteFaelligkeit(dueDate: string, regel: Wiederholung): string {
  const heute = new Date()
  heute.setHours(0, 0, 0, 0)
  const d = new Date(`${dueDate}T00:00:00`)
  const zielTag = d.getDate()
  do {
    if (regel === 'woechentlich') {
      d.setDate(d.getDate() + 7)
    } else if (regel === 'monatlich') {
      d.setDate(1)
      d.setMonth(d.getMonth() + 1)
      const letzterTag = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
      d.setDate(Math.min(zielTag, letzterTag))
    } else {
      d.setDate(1)
      d.setFullYear(d.getFullYear() + 1)
      const letzterTag = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
      d.setDate(Math.min(zielTag, letzterTag))
    }
  } while (d <= heute)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ------------------------------------------------------------
// Projekte
// ------------------------------------------------------------

export interface CreateProjectInput {
  company_id?: unknown
  name?: unknown
  beschreibung?: unknown
  member_ids?: unknown
}

// Neues Projekt anlegen. Der Ersteller wird immer automatisch
// Mitglied — Nicht-Admins sehen nur Projekte, in denen sie Mitglied
// sind.
export async function createProject(supabase: Db, userId: string, input: CreateProjectInput) {
  const { company_id, name, beschreibung, member_ids } = input

  if (!company_id || typeof company_id !== 'string' || !UUID_RE.test(company_id))
    return fail(400, 'Ungültige Firmen-ID.')
  if (!name || typeof name !== 'string' || !name.trim() || name.length > 200)
    return fail(400, 'Ungültiger Projektname.')

  const { data: project, error } = await supabase
    .from('projects')
    .insert({
      company_id,
      name: name.trim(),
      beschreibung: typeof beschreibung === 'string' && beschreibung.trim() ? beschreibung.trim() : null,
      created_by: userId,
    })
    .select('*, company:companies(id, name)')
    .single()

  if (error || !project) {
    const status = error?.code === '42501' ? 403 : 500
    return fail(status, 'Projekt konnte nicht angelegt werden.')
  }

  const gewaehlte = Array.isArray(member_ids)
    ? member_ids.filter((id: unknown): id is string => typeof id === 'string' && UUID_RE.test(id))
    : []
  const rows = [...new Set([userId, ...gewaehlte])]
    .map(profile_id => ({ project_id: project.id, profile_id, added_by: userId }))
  const { error: memberError } = await supabase.from('project_members').insert(rows)
  if (memberError) {
    console.error('Projektmitglieder konnten nicht angelegt werden:', memberError)
  } else {
    // Info-Mail an alle zugefügten Personen ausser dem Ersteller.
    // Awaited — auf Vercel wird die Function nach der Response
    // eingefroren, nicht awaitete Promises laufen sonst nie.
    const empfaengerIds = rows.map(r => r.profile_id).filter(pid => pid !== userId)
    if (empfaengerIds.length > 0) {
      const [{ data: empfaenger }, akteur] = await Promise.all([
        supabase.from('mitarbeiter_verzeichnis').select('id, full_name, email').in('id', empfaengerIds),
        akteurVon(supabase, userId, 'Ein Projektverwalter'),
      ])
      await Promise.allSettled((empfaenger ?? []).map(p =>
        sendMemberAddedMail({
          to: p.email,
          empfaengerName: p.full_name,
          projektName: project.name,
          geaendertVon: akteur.name,
          antwortAn: akteur.email,
          projektPath: `${hostLesen().basisPfad}/${project.id}`,
        })
      ))
    }
  }

  return done({ project })
}

export interface UpdateProjectInput {
  name?: unknown
  beschreibung?: unknown
  status?: unknown
}

// Projekt bearbeiten/archivieren
export async function updateProject(supabase: Db, projectId: string, input: UpdateProjectInput) {
  const payload: { name?: string; beschreibung?: string | null; status?: 'aktiv' | 'archiviert' } = {}

  if (typeof input.name === 'string') {
    if (!input.name.trim() || input.name.length > 200)
      return fail(400, 'Ungültiger Projektname.')
    payload.name = input.name.trim()
  }
  if ('beschreibung' in input) {
    payload.beschreibung =
      typeof input.beschreibung === 'string' && input.beschreibung.trim() ? input.beschreibung.trim() : null
  }
  if (input.status === 'aktiv' || input.status === 'archiviert') {
    payload.status = input.status
  }
  if (Object.keys(payload).length === 0) return fail(400, 'Keine Änderungen.')

  const { data: project, error } = await supabase
    .from('projects')
    .update(payload)
    .eq('id', projectId)
    .select('*, company:companies(id, name)')
    .single()

  if (error || !project) return fail(400, 'Projekt konnte nicht gespeichert werden.')
  return done({ project })
}

// Projekt löschen; Tasks und Notizen werden per ON DELETE CASCADE
// mitgelöscht
export async function deleteProject(supabase: Db, projectId: string) {
  const { error, count } = await supabase
    .from('projects')
    .delete({ count: 'exact' })
    .eq('id', projectId)

  if (error || !count) return fail(400, 'Projekt konnte nicht gelöscht werden.')
  return done({ success: true })
}

// ------------------------------------------------------------
// Projektmitglieder
// ------------------------------------------------------------

// Mitglied zufügen; informiert die betroffene Person per Mail
export async function addProjectMember(supabase: Db, userId: string, projectId: string, profileId: unknown) {
  if (!profileId || typeof profileId !== 'string' || !UUID_RE.test(profileId))
    return fail(400, 'Ungültige Profil-ID.')

  const { data: member, error } = await supabase
    .from('project_members')
    .insert({ project_id: projectId, profile_id: profileId, added_by: userId })
    .select('*, profile:profiles!project_members_profile_id_fkey(id, full_name, email)')
    .single()

  if (error || !member) {
    const msg = error?.code === '23505'
      ? 'Person ist bereits Projektmitglied.'
      : 'Mitglied konnte nicht zugefügt werden.'
    return fail(400, msg)
  }

  // Info-Mail an die zugefügte Person. Muss awaited werden — auf
  // Vercel wird die Function nach der Response eingefroren, nicht
  // awaitete Promises laufen sonst nie. Fehler fängt die
  // Mail-Funktion intern ab.
  if (member.profile && member.profile.id !== userId) {
    const [{ data: project }, akteur] = await Promise.all([
      supabase.from('projects').select('name').eq('id', projectId).single(),
      akteurVon(supabase, userId, 'Ein Projektverwalter'),
    ])
    await sendMemberAddedMail({
      to: member.profile.email,
      empfaengerName: member.profile.full_name,
      projektName: project?.name ?? '',
      geaendertVon: akteur.name,
      antwortAn: akteur.email,
      projektPath: `${hostLesen().basisPfad}/${projectId}`,
    })
  }

  return done({ member })
}

// Mitglied entfernen; informiert die betroffene Person per Mail.
// Offene Tasks der Person bleiben bestehen und können neu zugewiesen
// werden.
export async function removeProjectMember(supabase: Db, userId: string, projectId: string, profileId: unknown) {
  if (!profileId || typeof profileId !== 'string' || !UUID_RE.test(profileId))
    return fail(400, 'Ungültige Profil-ID.')

  // Profil vor dem Entfernen laden (danach ist es für den Aufrufer
  // je nach Rechten evtl. nicht mehr sichtbar)
  const { data: profile } = await supabase
    .from('mitarbeiter_verzeichnis')
    .select('id, full_name, email')
    .eq('id', profileId)
    .single()

  const { error, count } = await supabase
    .from('project_members')
    .delete({ count: 'exact' })
    .eq('project_id', projectId)
    .eq('profile_id', profileId)

  if (error || !count) return fail(400, 'Mitglied konnte nicht entfernt werden.')

  // Info-Mail an die entfernte Person (awaited — siehe oben)
  if (profile && profile.id !== userId) {
    const [{ data: project }, akteur] = await Promise.all([
      supabase.from('projects').select('name').eq('id', projectId).single(),
      akteurVon(supabase, userId, 'Ein Projektverwalter'),
    ])
    await sendMemberRemovedMail({
      to: profile.email,
      empfaengerName: profile.full_name,
      projektName: project?.name ?? '',
      geaendertVon: akteur.name,
      antwortAn: akteur.email,
    })
  }

  return done({ success: true })
}

// ------------------------------------------------------------
// Ordner
// ------------------------------------------------------------

// Ordner in einem Projekt anlegen (neue Ordner hinten anhängen)
export async function createFolder(supabase: Db, userId: string, projectId: string, name: unknown) {
  if (!name || typeof name !== 'string' || !name.trim() || name.length > 100)
    return fail(400, 'Ungültiger Ordnername.')

  const { data: letzter } = await supabase
    .from('project_folders')
    .select('position')
    .eq('project_id', projectId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: folder, error } = await supabase
    .from('project_folders')
    .insert({
      project_id: projectId,
      name: name.trim(),
      position: (letzter?.position ?? -1) + 1,
      created_by: userId,
    })
    .select('id, project_id, name, position')
    .single()

  if (error || !folder) {
    const msg = error?.code === '23505'
      ? 'Es gibt in diesem Projekt bereits einen Ordner mit diesem Namen.'
      : 'Ordner konnte nicht angelegt werden.'
    return fail(400, msg)
  }
  return done({ folder })
}

export interface UpdateFolderInput {
  name?: unknown
  position?: unknown
}

// Ordner umbenennen oder verschieben
export async function updateFolder(supabase: Db, folderId: string, input: UpdateFolderInput) {
  const payload: { name?: string; position?: number } = {}

  if (typeof input.name === 'string') {
    if (!input.name.trim() || input.name.length > 100)
      return fail(400, 'Ungültiger Ordnername.')
    payload.name = input.name.trim()
  }
  if (typeof input.position === 'number' && Number.isInteger(input.position) && input.position >= 0) {
    payload.position = input.position
  }
  if (Object.keys(payload).length === 0) return fail(400, 'Keine Änderungen.')

  const { data: folder, error } = await supabase
    .from('project_folders')
    .update(payload)
    .eq('id', folderId)
    .select('id, project_id, name, position')
    .single()

  if (error || !folder) {
    const msg = error?.code === '23505'
      ? 'Es gibt in diesem Projekt bereits einen Ordner mit diesem Namen.'
      : 'Ordner konnte nicht gespeichert werden.'
    return fail(400, msg)
  }
  return done({ folder })
}

// Ordner löschen. Der DB-Trigger lässt das nur zu, wenn keine
// offenen Aufgaben mehr zugewiesen sind; archivierte Aufgaben
// verlieren lediglich die Ordner-Zuordnung (ON DELETE SET NULL).
export async function deleteFolder(supabase: Db, folderId: string) {
  const { error, count } = await supabase
    .from('project_folders')
    .delete({ count: 'exact' })
    .eq('id', folderId)

  if (error || !count) {
    // Die Trigger-Meldung ist bereits deutsch formuliert
    const msg = error?.message.includes('offene Aufgabe')
      ? error.message.replace(/^.*?:\s*/, '')
      : 'Ordner konnte nicht gelöscht werden.'
    return fail(400, msg)
  }
  return done({ success: true })
}

// ------------------------------------------------------------
// Tags (pro Mandant = Firma)
// ------------------------------------------------------------

interface TagRow {
  id: string
  company_id: string
  name: string
  farbe: string
  position: number
}

// Tag in einer Firma anlegen (neue Tags hinten anhängen)
export async function createTag(supabase: Db, userId: string, companyId: string, input: { name?: unknown; farbe?: unknown }) {
  if (!UUID_RE.test(companyId)) return fail(400, 'Ungültige Firmen-ID.')
  if (!input.name || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60)
    return fail(400, 'Ungültiger Tag-Name.')
  if (input.farbe !== undefined && !istTagFarbe(input.farbe))
    return fail(400, 'Ungültige Farbe.')

  const { data: letzter } = await supabase
    .from('task_tags')
    .select('position')
    .eq('company_id', companyId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: tag, error } = await supabase
    .from('task_tags')
    .insert({
      company_id: companyId,
      name: input.name.trim(),
      farbe: (input.farbe as TagFarbe) ?? 'grau',
      position: (letzter?.position ?? -1) + 1,
      created_by: userId,
    })
    .select('id, company_id, name, farbe, position')
    .single()

  if (error || !tag) {
    const msg = error?.code === '23505'
      ? 'Es gibt in dieser Firma bereits einen Tag mit diesem Namen.'
      : error?.code === '42501'
        ? 'Keine Berechtigung, Tags dieser Firma zu pflegen.'
        : 'Tag konnte nicht angelegt werden.'
    return fail(error?.code === '42501' ? 403 : 400, msg)
  }
  return done({ tag })
}

export interface UpdateTagInput {
  name?: unknown
  farbe?: unknown
  position?: unknown
}

// Tag umbenennen, umfärben oder verschieben
export async function updateTag(supabase: Db, tagId: string, input: UpdateTagInput) {
  const payload: { name?: string; farbe?: TagFarbe; position?: number } = {}

  if (typeof input.name === 'string') {
    if (!input.name.trim() || input.name.length > 60) return fail(400, 'Ungültiger Tag-Name.')
    payload.name = input.name.trim()
  }
  if (input.farbe !== undefined) {
    if (!istTagFarbe(input.farbe)) return fail(400, 'Ungültige Farbe.')
    payload.farbe = input.farbe
  }
  if (typeof input.position === 'number' && Number.isInteger(input.position) && input.position >= 0) {
    payload.position = input.position
  }
  if (Object.keys(payload).length === 0) return fail(400, 'Keine Änderungen.')

  const { data: tag, error } = await supabase
    .from('task_tags')
    .update(payload)
    .eq('id', tagId)
    .select('id, company_id, name, farbe, position')
    .single()

  if (error || !tag) {
    const msg = error?.code === '23505'
      ? 'Es gibt in dieser Firma bereits einen Tag mit diesem Namen.'
      : 'Tag konnte nicht gespeichert werden.'
    return fail(400, msg)
  }
  return done({ tag })
}

// Tag löschen — die Zuordnungen an den Aufgaben verschwinden mit
// (ON DELETE CASCADE), die Aufgaben selbst bleiben unberührt
export async function deleteTag(supabase: Db, tagId: string) {
  const { error, count } = await supabase
    .from('task_tags')
    .delete({ count: 'exact' })
    .eq('id', tagId)

  if (error || !count) return fail(400, 'Tag konnte nicht gelöscht werden.')
  return done({ success: true })
}

// Eingabe `tag_ids` prüfen: Liste eindeutiger UUIDs oder null bei
// ungültiger Eingabe
function tagIdListe(wert: unknown): string[] | null {
  if (!Array.isArray(wert)) return null
  const ids = wert.filter((id: unknown): id is string => typeof id === 'string' && UUID_RE.test(id))
  if (ids.length !== wert.length) return null
  return [...new Set(ids)]
}

// Prüft vor dem Speichern, ob alle Tags existieren und zur Firma des
// Projekts gehören — der DB-Trigger würde das sonst erst beim
// Schreiben mit einer technischen Meldung abfangen
async function pruefeTags(supabase: Db, projectId: string, tagIds: string[]): Promise<Result<TagRow[]>> {
  if (tagIds.length === 0) return done([])

  const { data: projekt } = await supabase
    .from('projects')
    .select('company_id')
    .eq('id', projectId)
    .single()
  if (!projekt) return fail(400, 'Projekt nicht gefunden.')
  // Das persönliche Projekt gehört zu keiner Firma — und Tags
  // gehören zu genau einer
  if (!projekt.company_id)
    return fail(400, 'Tags gehören zu einer Firma — im persönlichen Projekt «Eigene Tasks» gibt es keine.')

  const { data: tags } = await supabase
    .from('task_tags')
    .select('id, company_id, name, farbe, position')
    .in('id', tagIds)
    .order('position', { ascending: true })

  const gefunden = (tags ?? []) as TagRow[]
  if (gefunden.length !== tagIds.length)
    return fail(400, 'Mindestens ein Tag existiert nicht mehr.')
  if (gefunden.some(t => t.company_id !== projekt.company_id))
    return fail(400, 'Tags gelten pro Firma — mindestens ein Tag gehört zu einer anderen Firma als das Projekt.')

  return done(gefunden)
}

// Tags einer Aufgabe in der Form nachladen, die auch das Embed
// liefert (nach dem Schreiben, damit Trigger-Bereinigungen — etwa
// beim Umhängen in eine andere Firma — enthalten sind)
async function ladeTaskTags(supabase: Db, taskId: string) {
  const { data } = await supabase
    .from('task_tag_zuordnungen')
    .select('tag:task_tags(id, name, farbe, position)')
    .eq('task_id', taskId)

  return ((data ?? []) as unknown as { tag: { id: string; name: string; farbe: string; position: number } | null }[])
    .filter(z => !!z.tag)
    .sort((a, b) => (a.tag!.position - b.tag!.position) || a.tag!.name.localeCompare(b.tag!.name))
    .map(z => ({ tag: { id: z.tag!.id, name: z.tag!.name, farbe: z.tag!.farbe } }))
}

// Zuordnungen einer Aufgabe auf genau `tagIds` setzen
async function setzeTaskTags(supabase: Db, userId: string, taskId: string, tagIds: string[]): Promise<string | null> {
  const { data: bestehend } = await supabase
    .from('task_tag_zuordnungen')
    .select('tag_id')
    .eq('task_id', taskId)

  const alt = new Set((bestehend ?? []).map(z => z.tag_id))
  const neu = new Set(tagIds)
  const zuLoeschen = [...alt].filter(id => !neu.has(id))
  const zuSetzen = tagIds.filter(id => !alt.has(id))

  if (zuLoeschen.length > 0) {
    const { error } = await supabase
      .from('task_tag_zuordnungen')
      .delete()
      .eq('task_id', taskId)
      .in('tag_id', zuLoeschen)
    if (error) return 'Tags konnten nicht vollständig gespeichert werden.'
  }
  if (zuSetzen.length > 0) {
    const { error } = await supabase
      .from('task_tag_zuordnungen')
      .insert(zuSetzen.map(tag_id => ({ task_id: taskId, tag_id, created_by: userId })))
    if (error) return 'Tags konnten nicht vollständig gespeichert werden.'
  }
  return null
}

// ------------------------------------------------------------
// Tasks
// ------------------------------------------------------------

export interface CreateTaskInput {
  project_id?: unknown
  titel?: unknown
  beschreibung?: unknown
  assignee_id?: unknown
  due_date?: unknown
  wiederholung?: unknown
  parent_task_id?: unknown
  folder_id?: unknown
  tag_ids?: unknown
}

// Task anlegen (der DB-Trigger stellt sicher, dass der Zuständige
// Projektmitglied ist)
export async function createTask(supabase: Db, userId: string, input: CreateTaskInput) {
  const { project_id, titel, beschreibung, assignee_id, due_date, wiederholung, parent_task_id, folder_id } = input

  if (!project_id || typeof project_id !== 'string' || !UUID_RE.test(project_id))
    return fail(400, 'Ungültige Projekt-ID.')
  if (!titel || typeof titel !== 'string' || !titel.trim() || titel.length > 300)
    return fail(400, 'Ungültiger Titel.')
  if (!due_date || typeof due_date !== 'string' || !DATE_RE.test(due_date))
    return fail(400, 'Ungültiges Fertigstellungsdatum.')
  if (assignee_id && (typeof assignee_id !== 'string' || !UUID_RE.test(assignee_id)))
    return fail(400, 'Ungültiger Zuständiger.')
  if (wiederholung && !WIEDERHOLUNGEN.includes(wiederholung as Wiederholung))
    return fail(400, 'Ungültige Wiederholung.')
  if (parent_task_id && (typeof parent_task_id !== 'string' || !UUID_RE.test(parent_task_id)))
    return fail(400, 'Ungültiger Mutter-Task.')
  if (folder_id && (typeof folder_id !== 'string' || !UUID_RE.test(folder_id)))
    return fail(400, 'Ungültiger Ordner.')

  // Tags vorab prüfen — sie müssen zur Firma des Projekts gehören
  let tagIds: string[] = []
  if (input.tag_ids !== undefined && input.tag_ids !== null) {
    const liste = tagIdListe(input.tag_ids)
    if (!liste) return fail(400, 'Ungültige Tag-Auswahl.')
    const geprueft = await pruefeTags(supabase, project_id, liste)
    if (!geprueft.ok) return geprueft
    tagIds = geprueft.data.map(t => t.id)
  }

  const { data: task, error } = await supabase
    .from('tasks')
    .insert({
      project_id,
      titel: titel.trim(),
      beschreibung: typeof beschreibung === 'string' && beschreibung.trim() ? beschreibung.trim() : null,
      assignee_id: (assignee_id as string) || null,
      due_date,
      // Unter-Tasks wiederholen sich nicht — der Folge-Task eines
      // Mutter-Tasks entsteht ohne Unter-Tasks
      wiederholung: parent_task_id ? null : ((wiederholung as Wiederholung) || null),
      parent_task_id: (parent_task_id as string) || null,
      // Unter-Tasks übernehmen den Ordner des Mutter-Tasks (DB-Trigger)
      folder_id: parent_task_id ? null : ((folder_id as string) || null),
      created_by: userId,
    })
    .select(TASK_SELECT)
    .single()

  if (error || !task) {
    // Trigger-Meldungen (Mitgliedschaft, Hierarchie) sind bereits
    // deutsch formuliert — direkt durchreichen
    const msg = error?.message.includes('Mitglied')
      ? 'Der Zuständige muss zuerst dem Projekt als Mitglied zugefügt werden.'
      : error && /Unter-Task|Mutter-Task|Ordner/.test(error.message)
        ? error.message.replace(/^.*?:\s*/, '')
        : 'Task konnte nicht angelegt werden.'
    return fail(400, msg)
  }

  // Tags zuordnen (vorab geprüft; ein Fehler hier soll den bereits
  // angelegten Task nicht scheitern lassen)
  if (tagIds.length > 0) {
    const tagFehler = await setzeTaskTags(supabase, userId, task.id, tagIds)
    if (tagFehler) console.error('Tags konnten nicht gesetzt werden:', task.id)
    task.tags = await ladeTaskTags(supabase, task.id)
  }

  // Zuweisungs-Mail. Awaited — auf Vercel wird die Function nach der
  // Response eingefroren, nicht awaitete Promises laufen sonst nie.
  // Fehler fängt die Mail-Funktion intern ab.
  if (task.assignee && task.assignee.id !== userId) {
    const akteur = await akteurVon(supabase, userId, 'Ein Teammitglied')
    await sendTaskAssignedMail({
      to: task.assignee.email,
      empfaengerName: task.assignee.full_name,
      taskTitel: task.titel,
      projektName: task.project?.name ?? '',
      dueDate: task.due_date,
      zugewiesenVon: akteur.name,
      antwortAn: akteur.email,
      taskPath: `${hostLesen().basisPfad}/${task.project_id}?task=${task.id}`,
    })
  }

  return done({ task })
}

export interface UpdateTaskInput {
  titel?: unknown
  beschreibung?: unknown
  assignee_id?: unknown
  due_date?: unknown
  wiederholung?: unknown
  folder_id?: unknown
  project_id?: unknown
  tag_ids?: unknown
  action?: unknown
}

// Task bearbeiten, schliessen (= archivieren) oder reaktivieren.
// Mails: neuer/bisheriger Verantwortlicher bei Zuweisungswechsel;
// Verantwortlicher bei Änderungen an Titel, Fälligkeit oder Status.
export async function updateTask(supabase: Db, userId: string, id: string, input: UpdateTaskInput) {
  // Bisherigen Stand laden (für Änderungs-Diff, Umhängen und Mails)
  const { data: current } = await supabase
    .from('tasks')
    .select('id, titel, due_date, assignee_id, status, project_id, parent_task_id, assignee:profiles!tasks_assignee_id_fkey(id, full_name, email)')
    .eq('id', id)
    .single()
  if (!current) return fail(404, 'Task nicht gefunden.')

  const payload: {
    titel?: string
    beschreibung?: string | null
    assignee_id?: string | null
    due_date?: string
    wiederholung?: Wiederholung | null
    folder_id?: string | null
    project_id?: string
    status?: 'offen' | 'geschlossen'
    closed_at?: string | null
    closed_by?: string | null
  } = {}

  if (typeof input.titel === 'string') {
    if (!input.titel.trim() || input.titel.length > 300) return fail(400, 'Ungültiger Titel.')
    payload.titel = input.titel.trim()
  }
  if ('beschreibung' in input) {
    payload.beschreibung =
      typeof input.beschreibung === 'string' && input.beschreibung.trim() ? input.beschreibung.trim() : null
  }
  if ('assignee_id' in input) {
    if (input.assignee_id !== null && (typeof input.assignee_id !== 'string' || !UUID_RE.test(input.assignee_id)))
      return fail(400, 'Ungültiger Zuständiger.')
    payload.assignee_id = input.assignee_id as string | null
  }
  if (typeof input.due_date === 'string') {
    if (!DATE_RE.test(input.due_date)) return fail(400, 'Ungültiges Fertigstellungsdatum.')
    payload.due_date = input.due_date
  }
  if ('wiederholung' in input) {
    if (input.wiederholung !== null && !WIEDERHOLUNGEN.includes(input.wiederholung as Wiederholung))
      return fail(400, 'Ungültige Wiederholung.')
    payload.wiederholung = input.wiederholung as Wiederholung | null
  }
  // Ordner-Zuweisung. Unter-Tasks liegen immer im Ordner ihres
  // Mutter-Tasks — der DB-Trigger führt das nach, das Feld wird hier
  // gar nicht erst übernommen.
  if ('folder_id' in input && !current.parent_task_id) {
    if (input.folder_id !== null && (typeof input.folder_id !== 'string' || !UUID_RE.test(input.folder_id)))
      return fail(400, 'Ungültiger Ordner.')
    payload.folder_id = input.folder_id as string | null
  }
  // Umhängen in ein anderes Projekt. Über die Web-App verlangt die
  // RLS Mitgliedschaft in beiden Projekten (bzw. Admin-Rolle), über
  // MCP prüft das der Guard.
  const zielProjekt = typeof input.project_id === 'string' && input.project_id !== current.project_id
    ? input.project_id
    : null
  if (zielProjekt) {
    if (!UUID_RE.test(zielProjekt)) return fail(400, 'Ungültiges Zielprojekt.')
    if (current.parent_task_id)
      return fail(400, 'Unter-Tasks können nicht einzeln umgehängt werden — hänge den Mutter-Task um, die Unter-Tasks ziehen mit.')
    payload.project_id = zielProjekt
    // Ordner gehören zu genau einem Projekt — die Zuordnung fällt
    // beim Umhängen weg (die Unter-Tasks zieht der DB-Trigger nach)
    payload.folder_id = null
  }

  if (input.action === 'schliessen') {
    payload.status = 'geschlossen'
    payload.closed_at = new Date().toISOString()
    payload.closed_by = userId
  } else if (input.action === 'reaktivieren') {
    payload.status = 'offen'
    payload.closed_at = null
    payload.closed_by = null
  }

  // Tags: null = nicht mitgeschickt (bleiben unverändert), sonst die
  // neue Menge. Geprüft wird gegen die Firma des Zielprojekts.
  let tagIds: string[] | null = null
  if (input.tag_ids !== undefined && input.tag_ids !== null) {
    const liste = tagIdListe(input.tag_ids)
    if (!liste) return fail(400, 'Ungültige Tag-Auswahl.')
    const geprueft = await pruefeTags(supabase, zielProjekt ?? current.project_id, liste)
    if (!geprueft.ok) return geprueft
    tagIds = geprueft.data.map(t => t.id)
  }

  if (Object.keys(payload).length === 0 && tagIds === null) return fail(400, 'Keine Änderungen.')

  // Beim Umhängen ziehen die Unter-Tasks mit. Alle betroffenen
  // Zuständigen müssen im Zielprojekt Mitglied sein (DB-Trigger) —
  // vorab prüfen, um eine verständliche Meldung zu liefern.
  let kinder: { id: string; assignee_id: string | null }[] = []
  if (zielProjekt) {
    const { data: kinderData } = await supabase
      .from('tasks')
      .select('id, assignee_id')
      .eq('parent_task_id', id)
    kinder = kinderData ?? []

    // Zielprojekt ist ein persönliches: dort ist alles der Person
    // selbst zugewiesen (DB-Trigger), die Mitgliederprüfung unten
    // entfällt deshalb. Fremde persönliche Projekte sind tabu.
    const { data: ziel } = await supabase
      .from('projects')
      .select('persoenlich_fuer')
      .eq('id', zielProjekt)
      .single()
    if (ziel?.persoenlich_fuer && ziel.persoenlich_fuer !== userId)
      return fail(403, 'In das persönliche Projekt einer anderen Person kann nichts umgehängt werden.')

    const betroffene = ziel?.persoenlich_fuer ? [] : [...new Set(
      [('assignee_id' in payload ? payload.assignee_id : current.assignee_id), ...kinder.map(k => k.assignee_id)]
        .filter((a): a is string => !!a)
    )]
    if (betroffene.length > 0) {
      const { data: mitglieder } = await supabase
        .from('project_members')
        .select('profile_id')
        .eq('project_id', zielProjekt)
        .in('profile_id', betroffene)
      const istMitglied = new Set((mitglieder ?? []).map(m => m.profile_id))
      const fehlende = betroffene.filter(a => !istMitglied.has(a))
      if (fehlende.length > 0) {
        const { data: namen } = await supabase.from('mitarbeiter_verzeichnis').select('full_name').in('id', fehlende)
        const liste = (namen ?? []).map(n => n.full_name).join(', ')
        return fail(400, `Umhängen nicht möglich: ${liste} ${fehlende.length === 1 ? 'ist' : 'sind'} nicht Mitglied des Zielprojekts. Zuerst dort als Mitglied zufügen oder die Zuständigkeit ändern.`)
      }
    }
  }

  // Werden nur Tags geändert, bleibt die Task-Zeile unangetastet —
  // ein UPDATE ohne Spalten lehnt PostgREST ab
  const { data: task, error } = Object.keys(payload).length > 0
    ? await supabase
        .from('tasks')
        .update(payload)
        .eq('id', id)
        .select(TASK_SELECT)
        .single()
    : await supabase
        .from('tasks')
        .select(TASK_SELECT)
        .eq('id', id)
        .single()

  if (error || !task) {
    // Trigger-Meldungen (Mitgliedschaft, Hierarchie) sind bereits
    // deutsch formuliert — direkt durchreichen
    const msg = error?.message.includes('Mitglied zugefügt') || error?.message.includes('Mitglied werden')
      ? 'Der Zuständige muss zuerst dem Projekt als Mitglied zugefügt werden.'
      : error && /Unter-Task|Mutter-Task|Ordner/.test(error.message)
        ? error.message.replace(/^.*?:\s*/, '')
        : 'Task konnte nicht gespeichert werden.'
    return fail(400, msg)
  }

  // Umhängen: Unter-Tasks nachziehen (erst nach dem Mutter-Task —
  // der Hierarchie-Trigger prüft gegen dessen Projekt) und Beobachter
  // entfernen, die im Zielprojekt nicht Mitglied sind
  if (zielProjekt) {
    if (kinder.length > 0) {
      const { error: kinderError } = await supabase
        .from('tasks')
        .update({ project_id: zielProjekt })
        .eq('parent_task_id', id)
      if (kinderError) console.error('Unter-Tasks konnten nicht umgehängt werden:', kinderError)
    }

    const taskIds = [id, ...kinder.map(k => k.id)]
    const { data: watcher } = await supabase
      .from('task_watchers')
      .select('id, profile_id')
      .in('task_id', taskIds)
    if (watcher && watcher.length > 0) {
      const { data: mitglieder } = await supabase
        .from('project_members')
        .select('profile_id')
        .eq('project_id', zielProjekt)
        .in('profile_id', [...new Set(watcher.map(w => w.profile_id))])
      const istMitglied = new Set((mitglieder ?? []).map(m => m.profile_id))
      const zuEntfernen = watcher.filter(w => !istMitglied.has(w.profile_id)).map(w => w.id)
      if (zuEntfernen.length > 0) {
        await supabase.from('task_watchers').delete().in('id', zuEntfernen)
      }
    }
  }

  // Tags setzen. Beim Umhängen in eine andere Firma räumt zusätzlich
  // ein DB-Trigger die dort ungültigen Zuordnungen weg — deshalb die
  // Tags danach frisch laden statt aus dem Select oben zu übernehmen.
  if (tagIds) {
    const tagFehler = await setzeTaskTags(supabase, userId, id, tagIds)
    if (tagFehler) console.error('Tags konnten nicht gesetzt werden:', id)
  }
  if (tagIds || zielProjekt) {
    task.tags = await ladeTaskTags(supabase, id)
  }

  const taskPath = `${hostLesen().basisPfad}/${task.project_id}?task=${task.id}`
  const projektName = task.project?.name ?? ''
  const assigneeChanged = 'assignee_id' in payload && payload.assignee_id !== current.assignee_id

  // Schliessen wird separat an Ersteller und Zuständige(n) gemeldet
  const wurdeGeschlossen = payload.status === 'geschlossen' && current.status !== 'geschlossen'

  // Wiederkehrender Task: beim Schliessen den Folge-Task gemäss
  // Regel erstellen (gleicher Titel/Beschreibung/Zuständiger)
  let folgeTask = null
  if (wurdeGeschlossen && task.wiederholung) {
    const { data: neu, error: folgeError } = await supabase
      .from('tasks')
      .insert({
        project_id: task.project_id,
        titel: task.titel,
        beschreibung: task.beschreibung,
        assignee_id: task.assignee_id,
        due_date: naechsteFaelligkeit(task.due_date, task.wiederholung as Wiederholung),
        wiederholung: task.wiederholung,
        // Der Folge-Task bleibt im gleichen Ordner
        folder_id: task.folder_id,
        created_by: userId,
      })
      .select(TASK_SELECT)
      .single()
    if (folgeError) {
      console.error('Folge-Task konnte nicht erstellt werden:', folgeError)
    } else {
      folgeTask = neu
      // Der Folge-Task erbt die Tags des geschlossenen Tasks
      const geerbt = (task.tags ?? []).map(z => z.tag?.id).filter((tid): tid is string => !!tid)
      if (geerbt.length > 0 && folgeTask) {
        await setzeTaskTags(supabase, userId, folgeTask.id, geerbt)
        folgeTask.tags = await ladeTaskTags(supabase, folgeTask.id)
      }
    }
  }

  // Inhaltliche Änderungen für die Info-Mail an den Verantwortlichen
  const aenderungen: string[] = []
  if (payload.titel && payload.titel !== current.titel)
    aenderungen.push(`Titel: «${current.titel}» → «${payload.titel}»`)
  if (payload.due_date && payload.due_date !== current.due_date)
    aenderungen.push(`Fälligkeit: ${formatDatum(current.due_date)} → ${formatDatum(payload.due_date)}`)
  if (payload.status === 'offen' && current.status !== 'offen')
    aenderungen.push('Status: reaktiviert (offen)')
  if (zielProjekt)
    aenderungen.push(`Projekt gewechselt — die Aufgabe liegt jetzt im Projekt «${projektName}»`)

  // Awaited — auf Vercel wird die Function nach der Response
  // eingefroren, nicht awaitete Promises laufen sonst nie. Fehler
  // fängt die Mail-Funktion intern ab.
  if (wurdeGeschlossen) {
    // Nur Ersteller und Zuständige(r) werden informiert — wer selbst
    // schliesst, erhält keine Mail
    const empfaengerIds = [...new Set(
      [task.created_by, task.assignee_id].filter(
        (pid): pid is string => !!pid && pid !== userId
      )
    )]
    const [{ data: profile }, akteur] = await Promise.all([
      empfaengerIds.length > 0
        ? supabase.from('mitarbeiter_verzeichnis').select('id, full_name, email').in('id', empfaengerIds)
        : { data: [] },
      akteurVon(supabase, userId, 'Ein Teammitglied'),
    ])
    const empfaenger = (profile ?? []) as unknown as Empfaenger[]
    await Promise.allSettled(empfaenger.map(p =>
      sendTaskClosedMail({
        to: p.email,
        empfaengerName: p.full_name,
        taskTitel: task.titel,
        projektName,
        geschlossenVon: akteur.name,
        antwortAn: akteur.email,
        taskPath,
      })
    ))

    // Folge-Task eines wiederkehrenden Tasks: Verantwortlichen
    // über die neue Aufgabe informieren
    if (folgeTask?.assignee && folgeTask.assignee.id !== userId) {
      await sendTaskAssignedMail({
        to: folgeTask.assignee.email,
        empfaengerName: folgeTask.assignee.full_name,
        taskTitel: folgeTask.titel,
        projektName,
        dueDate: folgeTask.due_date,
        zugewiesenVon: akteur.name,
        antwortAn: akteur.email,
        taskPath: `${hostLesen().basisPfad}/${folgeTask.project_id}?task=${folgeTask.id}`,
      })
    }
  }

  if (assigneeChanged || aenderungen.length > 0) {
    const akteur = await akteurVon(supabase, userId, 'Ein Teammitglied')
    const oldAssignee = current.assignee as unknown as Empfaenger | null

    if (assigneeChanged) {
      // Neuer Verantwortlicher erhält die Zuweisungs-Mail …
      if (task.assignee && task.assignee.id !== userId) {
        await sendTaskAssignedMail({
          to: task.assignee.email,
          empfaengerName: task.assignee.full_name,
          taskTitel: task.titel,
          projektName,
          dueDate: task.due_date,
          zugewiesenVon: akteur.name,
          antwortAn: akteur.email,
          taskPath,
        })
      }
      // … der bisherige die Abgabe-Mail
      if (oldAssignee && oldAssignee.id !== userId) {
        await sendTaskUnassignedMail({
          to: oldAssignee.email,
          empfaengerName: oldAssignee.full_name,
          taskTitel: task.titel,
          projektName,
          geaendertVon: akteur.name,
          antwortAn: akteur.email,
        })
      }
    } else if (aenderungen.length > 0 && task.assignee && task.assignee.id !== userId) {
      // Verantwortlicher bleibt gleich → Änderungs-Mail
      await sendTaskChangedMail({
        to: task.assignee.email,
        empfaengerName: task.assignee.full_name,
        taskTitel: current.titel,
        projektName,
        aenderungen,
        geaendertVon: akteur.name,
        antwortAn: akteur.email,
        taskPath,
      })
    }
  }

  return done({ task, folgeTask })
}

// Task löschen
export async function deleteTask(supabase: Db, id: string) {
  const { error, count } = await supabase
    .from('tasks')
    .delete({ count: 'exact' })
    .eq('id', id)

  if (error || !count) return fail(400, 'Task konnte nicht gelöscht werden.')
  return done({ success: true })
}

// ------------------------------------------------------------
// Notizen
// ------------------------------------------------------------

export interface AddNoteInput {
  text?: unknown
  file_path?: unknown
  file_name?: unknown
  inform_profile_id?: unknown
}

// Notiz anfügen (Notizen sind unveränderlich). Optional: Datei-Anhang
// (bereits in den Storage hochgeladen) und eine zusätzlich zu
// informierende Person — sie wird als Beobachter gespeichert und ab
// sofort bei jeder neuen Notiz informiert.
export async function addTaskNote(supabase: Db, userId: string, id: string, input: AddNoteInput) {
  const { text, file_path, file_name, inform_profile_id } = input

  if (!text || typeof text !== 'string' || !text.trim() || text.length > 5000)
    return fail(400, 'Ungültiger Notiztext.')
  if (file_path && (typeof file_path !== 'string' || !file_path.startsWith(`${id}/`)))
    return fail(400, 'Ungültiger Dateipfad.')
  if (file_path && (!file_name || typeof file_name !== 'string'))
    return fail(400, 'Dateiname fehlt.')
  if (inform_profile_id && (typeof inform_profile_id !== 'string' || !UUID_RE.test(inform_profile_id)))
    return fail(400, 'Ungültige Person.')

  const { data: note, error } = await supabase
    .from('task_notes')
    .insert({
      task_id: id,
      author_id: userId,
      text: text.trim(),
      file_path: (file_path as string) || null,
      file_name: file_path ? (file_name as string) : null,
    })
    .select('*, author:profiles!task_notes_author_id_fkey(id, full_name)')
    .single()

  if (error || !note) return fail(400, 'Notiz konnte nicht gespeichert werden.')

  // Zusätzliche Person als Beobachter speichern (bleibt dauerhaft;
  // Duplikate ignorieren). Der DB-Trigger prüft die Projektmitgliedschaft.
  let watcherFehler: string | null = null
  if (inform_profile_id) {
    const { error: watcherError } = await supabase
      .from('task_watchers')
      .upsert(
        { task_id: id, profile_id: inform_profile_id as string, added_by: userId },
        { onConflict: 'task_id,profile_id', ignoreDuplicates: true }
      )
    if (watcherError) {
      watcherFehler = watcherError.message.includes('Mitglied')
        ? 'Die zu informierende Person muss Mitglied des Projekts sein.'
        : 'Person konnte nicht als Beobachter gespeichert werden.'
    }
  }

  // Task-Kontext, Verantwortlichen und Beobachter für die Mails laden
  const [{ data: task }, { data: watchers }, akteur] = await Promise.all([
    supabase
      .from('tasks')
      .select('id, titel, project_id, project:projects(name), assignee:profiles!tasks_assignee_id_fkey(id, full_name, email), ersteller:profiles!tasks_created_by_fkey(id, full_name, email)')
      .eq('id', id)
      .single(),
    supabase
      .from('task_watchers')
      .select('profile:profiles!task_watchers_profile_id_fkey(id, full_name, email)')
      .eq('task_id', id),
    akteurVon(supabase, userId, 'Ein Teammitglied'),
  ])

  // Der Verantwortliche und der Ersteller der Aufgabe werden bei jeder
  // Notiz informiert, dazu die Beobachter; der Autor der Notiz nie
  const kandidaten: (Empfaenger | null)[] = [
    (task?.assignee as unknown as Empfaenger | null) ?? null,
    (task?.ersteller as unknown as Empfaenger | null) ?? null,
    ...(watchers ?? []).map(w => w.profile as unknown as Empfaenger | null),
  ]
  const empfaenger = [
    ...new Map(
      kandidaten
        .filter((p): p is Empfaenger => !!p && p.id !== userId)
        .map(p => [p.id, p])
    ).values(),
  ]

  if (task && empfaenger.length > 0) {
    // Datei-Anhang aus dem Storage laden (falls vorhanden und nicht zu gross)
    let attachments: MailAttachment[] | undefined
    if (note.file_path && note.file_name) {
      const { data: blob } = await supabase.storage.from('task-attachments').download(note.file_path)
      if (blob && blob.size <= MAX_ATTACHMENT_BYTES) {
        attachments = [{
          filename: note.file_name,
          content: Buffer.from(await blob.arrayBuffer()).toString('base64'),
        }]
      }
    }

    // Awaited — auf Vercel wird die Function nach der Response
    // eingefroren. Fehler fängt die Mail-Funktion ab; allSettled sorgt
    // zusätzlich dafür, dass ein einzelner Ausfall den Versand an die
    // übrigen Empfänger nicht mitreisst.
    await Promise.allSettled(empfaenger.map(p =>
      sendTaskNoteMail({
        to: p.email,
        empfaengerName: p.full_name,
        taskTitel: task.titel,
        projektName: task.project?.name ?? '',
        notizText: note.text,
        autor: akteur.name,
        antwortAn: akteur.email,
        taskPath: `${hostLesen().basisPfad}/${task.project_id}?task=${task.id}`,
        attachments,
      })
    ))
  }

  return done({ note, watcherFehler })
}
