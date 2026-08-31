import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Das Schema, das dieses Modul BESITZT — plus die drei Dinge, die
// es von der Gastgeber-App erwartet: `profiles`, `companies` und
// die View `mitarbeiter_verzeichnis`.
//
// Bewusst NICHT die generierten `database.types.ts` der jeweiligen
// App: die enthalten deren gesamtes Schema und unterscheiden sich
// von App zu App. Hier steht nur, worauf dieses Modul zugreift.
// Die Gastgeber-App reicht ihren eigenen Client an der Grenze mit
// einem Cast herein (siehe `alsProjektMgtClient`).
// ============================================================

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface ProjektMgtDatabase {
  public: {
    Tables: {
      // ── von der Gastgeber-App erwartet ────────────────────
      companies: {
        Row: { id: string; name: string }
        Insert: { id?: string; name: string }
        Update: { id?: string; name?: string }
        Relationships: []
      }
      profiles: {
        Row: { id: string; email: string; full_name: string; role: string; company_id: string | null; is_blocked: boolean; can_manage_projects: boolean; can_use_projects: boolean }
        Insert: { id: string; email: string; full_name: string; role?: string; company_id?: string | null; is_blocked?: boolean; can_manage_projects?: boolean; can_use_projects?: boolean }
        Update: { id?: string; email?: string; full_name?: string; role?: string; company_id?: string | null; is_blocked?: boolean; can_manage_projects?: boolean; can_use_projects?: boolean }
        Relationships: [{ foreignKeyName: 'profiles_company_id_fkey'; columns: ['company_id']; referencedRelation: 'companies'; referencedColumns: ['id'] }]
      }

      // ── diesem Modul gehörend ─────────────────────────────
      // `company_id` ist null und `persoenlich_fuer` gesetzt beim
      // persönlichen Projekt «Eigene Tasks» — es gehört zu einer
      // Person, nicht zu einer Firma. Bei jedem anderen Projekt ist
      // es genau umgekehrt (CHECK projects_firma_oder_persoenlich).
      projects: {
        Row: { id: string; company_id: string | null; name: string; beschreibung: string | null; status: 'aktiv' | 'archiviert'; persoenlich_fuer: string | null; created_by: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; company_id?: string | null; name: string; beschreibung?: string | null; status?: 'aktiv' | 'archiviert'; persoenlich_fuer?: string | null; created_by?: string | null; created_at?: string; updated_at?: string }
        Update: { id?: string; company_id?: string | null; name?: string; beschreibung?: string | null; status?: 'aktiv' | 'archiviert'; created_by?: string | null; updated_at?: string }
        Relationships: [{ foreignKeyName: 'projects_company_id_fkey'; columns: ['company_id']; referencedRelation: 'companies'; referencedColumns: ['id'] }, { foreignKeyName: 'projects_created_by_fkey'; columns: ['created_by']; referencedRelation: 'profiles'; referencedColumns: ['id'] }, { foreignKeyName: 'projects_persoenlich_fuer_fkey'; columns: ['persoenlich_fuer']; referencedRelation: 'profiles'; referencedColumns: ['id'] }]
      }
      project_members: {
        Row: { id: string; project_id: string; profile_id: string; added_by: string | null; created_at: string }
        Insert: { id?: string; project_id: string; profile_id: string; added_by?: string | null; created_at?: string }
        Update: { id?: string; project_id?: string; profile_id?: string; added_by?: string | null }
        Relationships: [{ foreignKeyName: 'project_members_project_id_fkey'; columns: ['project_id']; referencedRelation: 'projects'; referencedColumns: ['id'] }, { foreignKeyName: 'project_members_profile_id_fkey'; columns: ['profile_id']; referencedRelation: 'profiles'; referencedColumns: ['id'] }, { foreignKeyName: 'project_members_added_by_fkey'; columns: ['added_by']; referencedRelation: 'profiles'; referencedColumns: ['id'] }]
      }
      project_folders: {
        Row: { id: string; project_id: string; name: string; position: number; created_by: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; project_id: string; name: string; position?: number; created_by?: string | null; created_at?: string; updated_at?: string }
        Update: { id?: string; project_id?: string; name?: string; position?: number; created_by?: string | null; updated_at?: string }
        Relationships: [{ foreignKeyName: 'project_folders_project_id_fkey'; columns: ['project_id']; referencedRelation: 'projects'; referencedColumns: ['id'] }, { foreignKeyName: 'project_folders_created_by_fkey'; columns: ['created_by']; referencedRelation: 'profiles'; referencedColumns: ['id'] }]
      }
      tasks: {
        Row: { id: string; project_id: string; titel: string; beschreibung: string | null; assignee_id: string | null; due_date: string; status: 'offen' | 'geschlossen'; wiederholung: 'woechentlich' | 'monatlich' | 'jaehrlich' | null; parent_task_id: string | null; folder_id: string | null; closed_at: string | null; closed_by: string | null; created_by: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; project_id: string; titel: string; beschreibung?: string | null; assignee_id?: string | null; due_date: string; status?: 'offen' | 'geschlossen'; wiederholung?: 'woechentlich' | 'monatlich' | 'jaehrlich' | null; parent_task_id?: string | null; folder_id?: string | null; closed_at?: string | null; closed_by?: string | null; created_by?: string | null; created_at?: string; updated_at?: string }
        Update: { id?: string; project_id?: string; titel?: string; beschreibung?: string | null; assignee_id?: string | null; due_date?: string; status?: 'offen' | 'geschlossen'; wiederholung?: 'woechentlich' | 'monatlich' | 'jaehrlich' | null; parent_task_id?: string | null; folder_id?: string | null; closed_at?: string | null; closed_by?: string | null; updated_at?: string }
        Relationships: [{ foreignKeyName: 'tasks_project_id_fkey'; columns: ['project_id']; referencedRelation: 'projects'; referencedColumns: ['id'] }, { foreignKeyName: 'tasks_assignee_id_fkey'; columns: ['assignee_id']; referencedRelation: 'profiles'; referencedColumns: ['id'] }, { foreignKeyName: 'tasks_folder_id_fkey'; columns: ['folder_id']; referencedRelation: 'project_folders'; referencedColumns: ['id'] }, { foreignKeyName: 'tasks_closed_by_fkey'; columns: ['closed_by']; referencedRelation: 'profiles'; referencedColumns: ['id'] }, { foreignKeyName: 'tasks_created_by_fkey'; columns: ['created_by']; referencedRelation: 'profiles'; referencedColumns: ['id'] }]
      }
      task_tags: {
        Row: { id: string; company_id: string; name: string; farbe: string; position: number; created_by: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; company_id: string; name: string; farbe?: string; position?: number; created_by?: string | null; created_at?: string; updated_at?: string }
        Update: { id?: string; company_id?: string; name?: string; farbe?: string; position?: number; created_by?: string | null; updated_at?: string }
        Relationships: [{ foreignKeyName: 'task_tags_company_id_fkey'; columns: ['company_id']; referencedRelation: 'companies'; referencedColumns: ['id'] }, { foreignKeyName: 'task_tags_created_by_fkey'; columns: ['created_by']; referencedRelation: 'profiles'; referencedColumns: ['id'] }]
      }
      task_tag_zuordnungen: {
        Row: { task_id: string; tag_id: string; created_by: string | null; created_at: string }
        Insert: { task_id: string; tag_id: string; created_by?: string | null; created_at?: string }
        Update: { task_id?: string; tag_id?: string; created_by?: string | null }
        Relationships: [{ foreignKeyName: 'task_tag_zuordnungen_task_id_fkey'; columns: ['task_id']; referencedRelation: 'tasks'; referencedColumns: ['id'] }, { foreignKeyName: 'task_tag_zuordnungen_tag_id_fkey'; columns: ['tag_id']; referencedRelation: 'task_tags'; referencedColumns: ['id'] }, { foreignKeyName: 'task_tag_zuordnungen_created_by_fkey'; columns: ['created_by']; referencedRelation: 'profiles'; referencedColumns: ['id'] }]
      }
      task_notes: {
        Row: { id: string; task_id: string; author_id: string | null; text: string; file_path: string | null; file_name: string | null; created_at: string }
        Insert: { id?: string; task_id: string; author_id?: string | null; text: string; file_path?: string | null; file_name?: string | null; created_at?: string }
        Update: { id?: string; task_id?: string; author_id?: string | null; text?: string; file_path?: string | null; file_name?: string | null }
        Relationships: [{ foreignKeyName: 'task_notes_task_id_fkey'; columns: ['task_id']; referencedRelation: 'tasks'; referencedColumns: ['id'] }, { foreignKeyName: 'task_notes_author_id_fkey'; columns: ['author_id']; referencedRelation: 'profiles'; referencedColumns: ['id'] }]
      }
      task_watchers: {
        Row: { id: string; task_id: string; profile_id: string; added_by: string | null; created_at: string }
        Insert: { id?: string; task_id: string; profile_id: string; added_by?: string | null; created_at?: string }
        Update: { id?: string; task_id?: string; profile_id?: string; added_by?: string | null }
        Relationships: [{ foreignKeyName: 'task_watchers_task_id_fkey'; columns: ['task_id']; referencedRelation: 'tasks'; referencedColumns: ['id'] }, { foreignKeyName: 'task_watchers_profile_id_fkey'; columns: ['profile_id']; referencedRelation: 'profiles'; referencedColumns: ['id'] }, { foreignKeyName: 'task_watchers_added_by_fkey'; columns: ['added_by']; referencedRelation: 'profiles'; referencedColumns: ['id'] }]
      }
      mcp_tokens: {
        Row: { id: string; profile_id: string; name: string; token_hash: string; token_prefix: string; created_by: string | null; created_at: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null }
        Insert: { id?: string; profile_id: string; name: string; token_hash: string; token_prefix: string; created_by?: string | null; created_at?: string; last_used_at?: string | null; expires_at?: string | null; revoked_at?: string | null }
        Update: { id?: string; profile_id?: string; name?: string; token_hash?: string; token_prefix?: string; last_used_at?: string | null; expires_at?: string | null; revoked_at?: string | null }
        Relationships: [{ foreignKeyName: 'mcp_tokens_profile_id_fkey'; columns: ['profile_id']; referencedRelation: 'profiles'; referencedColumns: ['id'] }, { foreignKeyName: 'mcp_tokens_created_by_fkey'; columns: ['created_by']; referencedRelation: 'profiles'; referencedColumns: ['id'] }]
      }
      mcp_audit: {
        Row: { id: string; token_id: string | null; profile_id: string | null; tool: string; argumente: Json | null; erfolg: boolean; fehler: string | null; created_at: string }
        Insert: { id?: string; token_id?: string | null; profile_id?: string | null; tool: string; argumente?: Json | null; erfolg?: boolean; fehler?: string | null; created_at?: string }
        Update: { id?: string; token_id?: string | null; profile_id?: string | null; tool?: string; argumente?: Json | null; erfolg?: boolean; fehler?: string | null }
        Relationships: [{ foreignKeyName: 'mcp_audit_token_id_fkey'; columns: ['token_id']; referencedRelation: 'mcp_tokens'; referencedColumns: ['id'] }, { foreignKeyName: 'mcp_audit_profile_id_fkey'; columns: ['profile_id']; referencedRelation: 'profiles'; referencedColumns: ['id'] }]
      }
    }
    Views: {
      // Kollegenverzeichnis OHNE Rechte-Matrix. Muss in jeder
      // Gastgeber-App unter genau diesem Namen existieren; im Portal
      // angelegt mit supabase_migration_security_06_verzeichnis.sql.
      mitarbeiter_verzeichnis: {
        Row: { id: string; full_name: string; email: string; company_id: string | null; is_blocked: boolean; darf_projekte_nutzen: boolean }
        Relationships: []
      }
    }
    Functions: {
      // Legt das persönliche Projekt der angemeldeten Person an,
      // falls es fehlt, und liefert seine ID (sql/modul/09).
      persoenliches_projekt_sichern: {
        Args: Record<string, never>
        Returns: string
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}

export type Db = SupabaseClient<ProjektMgtDatabase>

/**
 * Grenzübergang: die Gastgeber-App reicht ihren eigenen, gegen ihr
 * volles Schema typisierten Client herein. TypeScript kann die beiden
 * Schema-Typen nicht ineinander überführen, obwohl die hier benutzten
 * Tabellen deckungsgleich sind — deshalb genau EIN bewusster Cast an
 * der Grenze statt `any` im ganzen Modul.
 */
export function alsProjektMgtClient(client: unknown): Db {
  return client as Db
}

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string }
