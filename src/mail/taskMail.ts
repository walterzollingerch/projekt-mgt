import { Resend } from 'resend'
import { escapeHtml, escapeHtmlMitLinks } from '../hilfen'
import { hostLesen } from '../host'

// Datum de-CH formatieren (due_date kommt als YYYY-MM-DD)
function formatDatum(dateStr: string): string {
  return new Date(`${dateStr.slice(0, 10)}T00:00:00`).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export interface MailAttachment {
  filename: string
  /** Dateiinhalt Base64-codiert (Resend-Format) */
  content: string
}

interface PortalMailParams {
  to: string
  empfaengerName: string
  subject: string
  intro: string
  buttonLabel?: string
  buttonPath?: string
  attachments?: MailAttachment[]
  /**
   * Adresse der Person, die die Benachrichtigung ausgelöst hat.
   * Landet als Reply-To in der Mail, damit eine Antwort bei ihr
   * ankommt und nicht im Sammelpostfach (RESEND_REPLY_TO).
   */
  antwortAn?: string | null
}

// Versendet Benachrichtigungen für das Projekt-Mgt-Modul. Ohne
// RESEND_API_KEY wird still übersprungen (der Workflow darf nicht
// an fehlender Mail scheitern).
//
// Diese Hülle fängt ab, was der Versand werfen kann: Resend liefert
// Fehler der API zwar als error-Objekt zurück, wirft aber bei
// Netzwerkproblemen, Timeouts und Rate-Limits. Ein solcher Fehler darf
// den Aufrufer nie erreichen — die Mail geht dem Schreibvorgang in der
// Datenbank zeitlich nach, der Datensatz ist also längst gespeichert.
// Käme der Fehler durch, meldete das Portal «Unerwarteter Fehler»,
// obwohl gespeichert wurde; der Client (MCP-Agent oder UI) wiederholte
// den Aufruf und erzeugte doppelte Aufgaben und doppelte Notizen —
// Notizen sind unveränderlich und lassen sich nicht mehr entfernen.
async function sendProjektMgtMail(params: PortalMailParams): Promise<boolean> {
  try {
    return await sendeUeberResend(params)
  } catch (fehler) {
    console.error('Projekt-Mgt-Mail fehlgeschlagen (Ausnahme):', fehler)
    return false
  }
}

async function sendeUeberResend({ to, empfaengerName, subject, intro, buttonLabel, buttonPath, attachments, antwortAn }: PortalMailParams): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    // Ohne Key wird still übersprungen (der Workflow darf nicht an
    // fehlender Mail scheitern) — aber im Log sichtbar, sonst sucht
    // man den fehlenden Versand vergeblich in Resend
    console.error('Projekt-Mgt-Mail übersprungen: RESEND_API_KEY ist nicht gesetzt.')
    return false
  }

  const resend = new Resend(apiKey)
  const { appUrl, marke } = hostLesen()
  const fromName = marke.mailVonName
  const fromEmail = marke.mailVonAdresse
  const link = buttonPath ? `${appUrl}${buttonPath}` : null

  // Antworten sollen bei der auslösenden Person landen; nur wenn die
  // nicht bekannt ist, greift das Sammelpostfach aus der Env
  const replyTo = antwortAn?.trim() || process.env.RESEND_REPLY_TO

  const { error } = await resend.emails.send({
    from: `${fromName} <${fromEmail}>`,
    ...(replyTo ? { replyTo } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    to,
    subject,
    text: `Hallo ${empfaengerName},\n\n${intro}\n${link && buttonLabel ? `\n${buttonLabel}: ${link}\n` : ''}\nFreundliche Grüsse\n${marke.absender}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
        <div style="background:#1a5276;padding:24px 32px;border-radius:8px 8px 0 0;">
          <h1 style="color:#fff;margin:0;font-size:18px;">${escapeHtml(marke.titel)}</h1>
        </div>
        <div style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
          <p style="color:#374151;font-size:15px;">Hallo <strong>${escapeHtml(empfaengerName)}</strong>,</p>
          <p style="color:#374151;font-size:15px;white-space:pre-line;">${escapeHtmlMitLinks(intro)}</p>
          ${link && buttonLabel ? `
          <div style="margin:24px 0;">
            <a href="${link}"
               style="background:#1a5276;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:bold;">
              ${escapeHtml(buttonLabel)}
            </a>
          </div>` : ''}
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
          <p style="color:#9ca3af;font-size:13px;margin:0;">Freundliche Grüsse<br/>${escapeHtml(marke.absender)}</p>
        </div>
      </div>`,
  })

  if (error) {
    console.error('Projekt-Mgt-Mail fehlgeschlagen:', error)
    return false
  }
  return true
}

// --- Task-Verantwortung ---

interface TaskAssignedMailParams {
  to: string
  empfaengerName: string
  taskTitel: string
  projektName: string
  dueDate: string
  zugewiesenVon: string
  taskPath: string
  antwortAn?: string | null
}

// Neuer Verantwortlicher: Task wurde dir zugewiesen
export function sendTaskAssignedMail({ to, empfaengerName, taskTitel, projektName, dueDate, zugewiesenVon, taskPath, antwortAn }: TaskAssignedMailParams): Promise<boolean> {
  const faellig = formatDatum(dueDate)
  return sendProjektMgtMail({
    to,
    empfaengerName,
    subject: `Neue Aufgabe: ${taskTitel} (fällig ${faellig})`,
    intro: `${zugewiesenVon} hat dir im Projekt «${projektName}» eine Aufgabe zugewiesen: «${taskTitel}» — fällig am ${faellig}.`,
    buttonLabel: 'Aufgabe öffnen',
    buttonPath: taskPath,
    antwortAn,
  })
}

// Bisheriger Verantwortlicher: Verantwortung wurde entzogen
export function sendTaskUnassignedMail({ to, empfaengerName, taskTitel, projektName, geaendertVon, antwortAn }: { to: string; empfaengerName: string; taskTitel: string; projektName: string; geaendertVon: string; antwortAn?: string | null }): Promise<boolean> {
  return sendProjektMgtMail({
    to,
    empfaengerName,
    subject: `Aufgabe abgegeben: ${taskTitel}`,
    intro: `${geaendertVon} hat die Verantwortung für die Aufgabe «${taskTitel}» im Projekt «${projektName}» neu vergeben. Du bist nicht mehr zuständig.`,
    antwortAn,
  })
}

// Verantwortlicher: Titel, Fälligkeit oder Status wurden geändert
export function sendTaskChangedMail({ to, empfaengerName, taskTitel, projektName, aenderungen, geaendertVon, taskPath, antwortAn }: { to: string; empfaengerName: string; taskTitel: string; projektName: string; aenderungen: string[]; geaendertVon: string; taskPath: string; antwortAn?: string | null }): Promise<boolean> {
  return sendProjektMgtMail({
    to,
    empfaengerName,
    subject: `Aufgabe geändert: ${taskTitel}`,
    intro: `${geaendertVon} hat deine Aufgabe «${taskTitel}» im Projekt «${projektName}» geändert:\n${aenderungen.map(a => `• ${a}`).join('\n')}`,
    buttonLabel: 'Aufgabe öffnen',
    buttonPath: taskPath,
    antwortAn,
  })
}

// Ersteller + Zuständige(r): Aufgabe wurde geschlossen und archiviert
export function sendTaskClosedMail({ to, empfaengerName, taskTitel, projektName, geschlossenVon, taskPath, antwortAn }: { to: string; empfaengerName: string; taskTitel: string; projektName: string; geschlossenVon: string; taskPath: string; antwortAn?: string | null }): Promise<boolean> {
  return sendProjektMgtMail({
    to,
    empfaengerName,
    subject: `Aufgabe geschlossen: ${taskTitel}`,
    intro: `${geschlossenVon} hat die Aufgabe «${taskTitel}» im Projekt «${projektName}» geschlossen und archiviert.`,
    buttonLabel: 'Aufgabe öffnen',
    buttonPath: taskPath,
    antwortAn,
  })
}

// Beobachter: neue Notiz im Task (Datei-Anhang wird mitversendet)
export function sendTaskNoteMail({ to, empfaengerName, taskTitel, projektName, notizText, autor, taskPath, attachments, antwortAn }: { to: string; empfaengerName: string; taskTitel: string; projektName: string; notizText: string; autor: string; taskPath: string; attachments?: MailAttachment[]; antwortAn?: string | null }): Promise<boolean> {
  return sendProjektMgtMail({
    to,
    empfaengerName,
    subject: `Neue Notiz: ${taskTitel}`,
    intro: `${autor} hat der Aufgabe «${taskTitel}» im Projekt «${projektName}» eine Notiz angefügt:\n\n«${notizText}»${attachments && attachments.length > 0 ? `\n\nDatei im Anhang: ${attachments.map(a => a.filename).join(', ')}` : ''}`,
    buttonLabel: 'Aufgabe öffnen',
    buttonPath: taskPath,
    attachments,
    antwortAn,
  })
}

// --- Projektmitgliedschaft ---

export function sendMemberAddedMail({ to, empfaengerName, projektName, geaendertVon, projektPath, antwortAn }: { to: string; empfaengerName: string; projektName: string; geaendertVon: string; projektPath: string; antwortAn?: string | null }): Promise<boolean> {
  return sendProjektMgtMail({
    to,
    empfaengerName,
    subject: `Projekt «${projektName}»: du bist jetzt Mitglied`,
    intro: `${geaendertVon} hat dich dem Projekt «${projektName}» als Mitglied zugefügt. Du kannst jetzt Tasks sehen, anlegen und zugewiesen bekommen.`,
    buttonLabel: 'Projekt öffnen',
    buttonPath: projektPath,
    antwortAn,
  })
}

export function sendMemberRemovedMail({ to, empfaengerName, projektName, geaendertVon, antwortAn }: { to: string; empfaengerName: string; projektName: string; geaendertVon: string; antwortAn?: string | null }): Promise<boolean> {
  return sendProjektMgtMail({
    to,
    empfaengerName,
    subject: `Projekt «${projektName}»: Mitgliedschaft beendet`,
    intro: `${geaendertVon} hat dich aus dem Projekt «${projektName}» entfernt. Du hast keinen Zugriff mehr auf dessen Tasks.`,
    antwortAn,
  })
}

export { formatDatum }
