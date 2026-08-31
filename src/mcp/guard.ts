import type { Db } from '../logik/service'
import type { McpIdentitaet } from './auth'

// ============================================================
// Rechteprüfung für den MCP-Zugang.
//
// Der MCP-Server arbeitet mit dem Service-Role-Schlüssel, für den
// die RLS nicht greift. Dieses Modul bildet die Policies aus
// supabase_migration_task_tracker.sql und
// supabase_migration_projekte_mitglieder_sichtbarkeit.sql explizit
// im Code ab:
//
//   is_project_admin()        → istAdmin
//   is_project_manager()      → istProjektverwalter
//   is_project_member(p)      → istMitglied
//   kann_projekt_verwalten(p) → kannProjektVerwalten
//
// Wer über MCP arbeitet, sieht und darf damit genau das, was er
// auch unter /aufgaben im Portal sieht und darf.
//
// Persönliche Projekte («Eigene Tasks», sql/modul/09) sind die eine
// Stelle, an der auch ein Administrator nichts sieht. Der Guard
// bildet das an drei Stellen ab: beim Sehen, beim Verwalten und bei
// den Listen, die Admins sonst ungefiltert bekommen.
// ============================================================

export class ZugriffFehlt extends Error {}

export function istAdmin(id: McpIdentitaet): boolean {
  return id.profile.role === 'admin' && !id.profile.is_blocked
}

export function istProjektverwalter(id: McpIdentitaet): boolean {
  return !id.profile.is_blocked && (id.profile.role === 'admin' || id.profile.can_manage_projects)
}

export async function istMitglied(supabase: Db, id: McpIdentitaet, projectId: string): Promise<boolean> {
  const { data } = await supabase
    .from('project_members')
    .select('id')
    .eq('project_id', projectId)
    .eq('profile_id', id.profile.id)
    .maybeSingle()
  return !!data
}

async function istErsteller(supabase: Db, id: McpIdentitaet, projectId: string): Promise<boolean> {
  const { data } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('created_by', id.profile.id)
    .maybeSingle()
  return !!data
}

/** Wem gehört dieses Projekt persönlich (null = gewöhnliches Projekt) */
async function persoenlichFuer(supabase: Db, projectId: string): Promise<string | null> {
  const { data } = await supabase
    .from('projects')
    .select('persoenlich_fuer')
    .eq('id', projectId)
    .maybeSingle()
  return data?.persoenlich_fuer ?? null
}

/** Darf dieses konkrete Projekt verwalten (Mitglieder, Umbenennen, Löschen) */
export async function kannProjektVerwalten(supabase: Db, id: McpIdentitaet, projectId: string): Promise<boolean> {
  // Ein persönliches Projekt verwaltet niemand — auch die Person
  // selbst nicht: es wird weder umbenannt noch archiviert, gelöscht
  // oder um Mitglieder ergänzt
  if (await persoenlichFuer(supabase, projectId)) return false
  if (istAdmin(id)) return true
  if (!istProjektverwalter(id)) return false
  return (await istMitglied(supabase, id, projectId)) || (await istErsteller(supabase, id, projectId))
}

/** Darf das Projekt überhaupt sehen (lesen) */
export async function kannProjektSehen(supabase: Db, id: McpIdentitaet, projectId: string): Promise<boolean> {
  const eigner = await persoenlichFuer(supabase, projectId)
  if (eigner) return eigner === id.profile.id
  if (istAdmin(id)) return true
  return (await istMitglied(supabase, id, projectId)) || (await istErsteller(supabase, id, projectId))
}

/** IDs aller für diese Person sichtbaren Projekte (null = alle, Admin) */
export async function sichtbareProjektIds(supabase: Db, id: McpIdentitaet): Promise<string[] | null> {
  if (istAdmin(id)) return null
  const [{ data: mitglied }, { data: erstellt }] = await Promise.all([
    supabase.from('project_members').select('project_id').eq('profile_id', id.profile.id),
    supabase.from('projects').select('id').eq('created_by', id.profile.id),
  ])
  return [...new Set([
    ...(mitglied ?? []).map(m => m.project_id),
    ...(erstellt ?? []).map(p => p.id),
  ])]
}

/**
 * Die persönlichen Projekte ALLER ANDEREN. Gegenstück zum `null` von
 * `sichtbareProjektIds`: wer alles sehen darf (Admin), sieht trotzdem
 * nicht hier hinein. Für alle übrigen ist die Liste ohnehin schon
 * eingeschränkt — dann bleibt diese hier leer.
 */
export async function fremdePersoenlicheProjektIds(supabase: Db, id: McpIdentitaet): Promise<string[]> {
  if (!istAdmin(id)) return []
  const { data } = await supabase
    .from('projects')
    .select('id, persoenlich_fuer')
    .not('persoenlich_fuer', 'is', null)
  return (data ?? []).filter(p => p.persoenlich_fuer !== id.profile.id).map(p => p.id)
}

// ---- Zusicherungen (werfen ZugriffFehlt) -------------------

export async function verlangeProjektZugriff(supabase: Db, id: McpIdentitaet, projectId: string): Promise<void> {
  if (!(await kannProjektSehen(supabase, id, projectId)))
    throw new ZugriffFehlt('Kein Zugriff auf dieses Projekt — du bist dort nicht Mitglied.')
}

export async function verlangeProjektVerwaltung(supabase: Db, id: McpIdentitaet, projectId: string): Promise<void> {
  if (await kannProjektVerwalten(supabase, id, projectId)) return
  if (await persoenlichFuer(supabase, projectId))
    throw new ZugriffFehlt(
      'Das persönliche Projekt «Eigene Tasks» wird nicht verwaltet: es hat genau ein Mitglied, ' +
      'behält seinen Namen und verschwindet erst mit dem Profil. Aufgaben darin kannst du normal führen.'
    )
  throw new ZugriffFehlt('Dafür brauchst du Verwaltungsrechte in diesem Projekt.')
}

/**
 * Aufgaben löschen: sonst Sache der Projektverwaltung — im eigenen
 * persönlichen Projekt die der Person selbst, denn dort gibt es
 * keinen Verwalter (Policy `tasks_delete_eigen`).
 */
export async function verlangeTaskLoeschung(supabase: Db, id: McpIdentitaet, projectId: string): Promise<void> {
  const eigner = await persoenlichFuer(supabase, projectId)
  if (eigner) {
    if (eigner === id.profile.id) return
    throw new ZugriffFehlt('Kein Zugriff auf dieses Projekt — du bist dort nicht Mitglied.')
  }
  await verlangeProjektVerwaltung(supabase, id, projectId)
}

export function verlangeProjektverwalter(id: McpIdentitaet): void {
  if (!istProjektverwalter(id))
    throw new ZugriffFehlt('Dafür brauchst du das Recht «Projekte verwalten».')
}

/** Task laden und Zugriff prüfen; liefert Task samt Projekt-ID */
export async function ladeTaskMitZugriff(supabase: Db, id: McpIdentitaet, taskId: string) {
  const { data: task } = await supabase
    .from('tasks')
    .select('id, project_id, titel, status, parent_task_id')
    .eq('id', taskId)
    .maybeSingle()
  if (!task) throw new ZugriffFehlt('Aufgabe nicht gefunden.')
  await verlangeProjektZugriff(supabase, id, task.project_id)
  return task
}

// ---- Tags (gehören zur Firma, nicht zum Projekt) -----------
//
//   darf_firmen_tags_sehen(c)   → kannFirmenTagsSehen
//   darf_firmen_tags_pflegen(c) → kannFirmenTagsPflegen

/** IDs aller Firmen, in denen diese Person ein Projekt hat (null = alle, Admin) */
export async function sichtbareFirmenIds(supabase: Db, id: McpIdentitaet): Promise<string[] | null> {
  const projektIds = await sichtbareProjektIds(supabase, id)
  if (projektIds === null) return null
  if (projektIds.length === 0) return []
  const { data } = await supabase.from('projects').select('company_id').in('id', projektIds)
  // Das persönliche Projekt gehört zu keiner Firma — es bringt
  // deshalb auch keine Tags mit
  return [...new Set((data ?? []).map(p => p.company_id).filter((c): c is string => !!c))]
}

/** Tags dieser Firma sehen und an Aufgaben setzen */
export async function kannFirmenTagsSehen(supabase: Db, id: McpIdentitaet, companyId: string): Promise<boolean> {
  const firmen = await sichtbareFirmenIds(supabase, id)
  return firmen === null || firmen.includes(companyId)
}

/** Tags dieser Firma pflegen (anlegen, umbenennen, löschen) — wie im
 *  Portal nur Admins und Projektverwalter mit einem Projekt der Firma */
export async function kannFirmenTagsPflegen(supabase: Db, id: McpIdentitaet, companyId: string): Promise<boolean> {
  if (istAdmin(id)) return true
  if (!istProjektverwalter(id)) return false
  return await kannFirmenTagsSehen(supabase, id, companyId)
}

export async function verlangeTagSicht(supabase: Db, id: McpIdentitaet, companyId: string): Promise<void> {
  if (!(await kannFirmenTagsSehen(supabase, id, companyId)))
    throw new ZugriffFehlt('Kein Zugriff auf die Tags dieser Firma — du hast dort kein Projekt.')
}

export async function verlangeTagPflege(supabase: Db, id: McpIdentitaet, companyId: string): Promise<void> {
  if (!(await kannFirmenTagsPflegen(supabase, id, companyId)))
    throw new ZugriffFehlt('Tags gelten firmenweit — pflegen dürfen sie nur Admins und Projektverwalter dieser Firma.')
}

/** Tag laden und Zugriff prüfen */
export async function ladeTagMitZugriff(supabase: Db, id: McpIdentitaet, tagId: string) {
  const { data: tag } = await supabase
    .from('task_tags')
    .select('id, company_id, name, farbe, position')
    .eq('id', tagId)
    .maybeSingle()
  if (!tag) throw new ZugriffFehlt('Tag nicht gefunden.')
  await verlangeTagSicht(supabase, id, tag.company_id)
  return tag
}

/** Ordner laden und Zugriff prüfen */
export async function ladeOrdnerMitZugriff(supabase: Db, id: McpIdentitaet, folderId: string) {
  const { data: folder } = await supabase
    .from('project_folders')
    .select('id, project_id, name, position')
    .eq('id', folderId)
    .maybeSingle()
  if (!folder) throw new ZugriffFehlt('Ordner nicht gefunden.')
  await verlangeProjektZugriff(supabase, id, folder.project_id)
  return folder
}
