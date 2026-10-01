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
  /** Zusätzlicher Inhalt nach dem Einleitungstext (bereits escaptes HTML) */
  inhaltHtml?: string
  /** Dasselbe für die Textfassung */
  inhaltText?: string
  /** Kleingedrucktes über der Grussformel (bereits escaptes HTML) */
  fussHtml?: string
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

async function sendeUeberResend({ to, empfaengerName, subject, intro, buttonLabel, buttonPath, attachments, antwortAn, inhaltHtml, inhaltText, fussHtml }: PortalMailParams): Promise<boolean> {
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
    text: `Hallo ${empfaengerName},\n\n${intro}\n${inhaltText ? `\n${inhaltText}\n` : ''}${link && buttonLabel ? `\n${buttonLabel}: ${link}\n` : ''}\nFreundliche Grüsse\n${marke.absender}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
        <div style="background:#1a5276;padding:24px 32px;border-radius:8px 8px 0 0;">
          <h1 style="color:#fff;margin:0;font-size:18px;">${escapeHtml(marke.titel)}</h1>
        </div>
        <div style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
          <p style="color:#374151;font-size:15px;">Hallo <strong>${escapeHtml(empfaengerName)}</strong>,</p>
          <p style="color:#374151;font-size:15px;white-space:pre-line;">${escapeHtmlMitLinks(intro)}</p>
          ${inhaltHtml ?? ''}
          ${link && buttonLabel ? `
          <div style="margin:24px 0;">
            <a href="${link}"
               style="background:#1a5276;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:bold;">
              ${escapeHtml(buttonLabel)}
            </a>
          </div>` : ''}
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
          ${fussHtml ? `<p style="color:#9ca3af;font-size:12px;margin:0 0 12px;">${fussHtml}</p>` : ''}
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

// Beobachter: neue Notiz im Task (Datei-Anhang wird mitversendet).
// Ist die Notiz eine Schlussnotiz, meldet dieselbe Mail zugleich den
// Abschluss — sonst bekämen Ersteller und Zuständige(r) zwei Mails,
// die dasselbe erzählen.
export function sendTaskNoteMail({ to, empfaengerName, taskTitel, projektName, notizText, autor, taskPath, attachments, antwortAn, abschluss }: { to: string; empfaengerName: string; taskTitel: string; projektName: string; notizText: string; autor: string; taskPath: string; attachments?: MailAttachment[]; antwortAn?: string | null; abschluss?: boolean }): Promise<boolean> {
  const anhang = attachments && attachments.length > 0 ? `\n\nDatei im Anhang: ${attachments.map(a => a.filename).join(', ')}` : ''
  return sendProjektMgtMail({
    to,
    empfaengerName,
    subject: abschluss ? `Aufgabe geschlossen: ${taskTitel}` : `Neue Notiz: ${taskTitel}`,
    intro: abschluss
      ? `${autor} hat die Aufgabe «${taskTitel}» im Projekt «${projektName}» mit einer Schlussnotiz geschlossen und archiviert:\n\n«${notizText}»${anhang}`
      : `${autor} hat der Aufgabe «${taskTitel}» im Projekt «${projektName}» eine Notiz angefügt:\n\n«${notizText}»${anhang}`,
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

// --- Tägliche Aufgaben-Mail ---

export interface TagesmailTask {
  id: string
  titel: string
  due_date: string
  project_id: string
  projektName: string
  firmaName: string | null
  istUnterTask: boolean
}

/** Mehr Zeilen machen die Mail unlesbar — der Rest steht im Portal */
const TAGESMAIL_MAX_WEITERE = 100

const WOCHENTAG_KURZ = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

function datumMitTag(iso: string): string {
  const [j, m, d] = iso.slice(0, 10).split('-')
  const tag = WOCHENTAG_KURZ[new Date(`${iso.slice(0, 10)}T12:00:00Z`).getUTCDay()]
  return `${tag} ${d}.${m}.${j}`
}

function tagesmailTabelle(tasks: TagesmailTask[], stichtag: string, basis: string): string {
  const zeilen = tasks.map(t => {
    const ueberfaellig = t.due_date < stichtag
    const heute = t.due_date === stichtag
    const datumFarbe = ueberfaellig ? '#b91c1c' : heute ? '#b45309' : '#374151'
    const vermerk = ueberfaellig ? ' · überfällig' : heute ? ' · heute' : ''
    const projekt = t.firmaName ? `${t.projektName} · ${t.firmaName}` : t.projektName
    const link = `${basis}/${t.project_id}?task=${t.id}`
    return `
      <tr>
        <td style="padding:8px 10px 8px 0;border-bottom:1px solid #f3f4f6;white-space:nowrap;vertical-align:top;color:${datumFarbe};font-size:13px;${ueberfaellig || heute ? 'font-weight:bold;' : ''}">${escapeHtml(datumMitTag(t.due_date))}${vermerk}</td>
        <td style="padding:8px 0;border-bottom:1px solid #f3f4f6;vertical-align:top;font-size:14px;">
          <a href="${link}" style="color:#1a5276;text-decoration:none;font-weight:bold;">${t.istUnterTask ? '↳ ' : ''}${escapeHtml(t.titel)}</a>
          <div style="color:#6b7280;font-size:12px;margin-top:2px;">${escapeHtml(projekt)}</div>
        </td>
      </tr>`
  }).join('')
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 8px;">${zeilen}</table>`
}

function tagesmailText(tasks: TagesmailTask[], stichtag: string): string {
  return tasks.map(t => {
    const vermerk = t.due_date < stichtag ? ' (überfällig)' : t.due_date === stichtag ? ' (heute)' : ''
    return `• ${datumMitTag(t.due_date)}${vermerk} — ${t.titel} [${t.projektName}]`
  }).join('\n')
}

// Abonnent:in: Übersicht der eigenen offenen Aufgaben, zuerst die bald fälligen
export function sendTagesmail({ to, empfaengerName, stichtag, grenze, arbeitstage, baldFaellig, weitere }: {
  to: string
  empfaengerName: string
  stichtag: string
  grenze: string
  arbeitstage: number
  baldFaellig: TagesmailTask[]
  weitere: TagesmailTask[]
}): Promise<boolean> {
  const { appUrl, basisPfad } = hostLesen()
  const basis = `${appUrl}${basisPfad}`
  const total = baldFaellig.length + weitere.length
  const ueberfaellig = baldFaellig.filter(t => t.due_date < stichtag).length
  const gezeigt = weitere.slice(0, TAGESMAIL_MAX_WEITERE)
  const rest = weitere.length - gezeigt.length

  const h2 = (text: string) =>
    `<h2 style="color:#1a5276;font-size:15px;margin:24px 0 6px;">${escapeHtml(text)}</h2>`
  const titelBald = `Überfällig und fällig in den nächsten ${arbeitstage} Arbeitstagen (bis ${datumMitTag(grenze)})`
  const titelWeitere = baldFaellig.length > 0 ? 'Weitere offene Aufgaben' : 'Deine offenen Aufgaben'

  const inhaltHtml = [
    h2(`${titelBald} — ${baldFaellig.length}`),
    baldFaellig.length > 0
      ? tagesmailTabelle(baldFaellig, stichtag, basis)
      : '<p style="color:#6b7280;font-size:14px;margin:0;">Nichts fällig in diesem Zeitraum.</p>',
    weitere.length > 0 ? h2(`${titelWeitere} — ${weitere.length}`) : '',
    weitere.length > 0 ? tagesmailTabelle(gezeigt, stichtag, basis) : '',
    rest > 0 ? `<p style="color:#6b7280;font-size:13px;margin:4px 0 0;">… und ${rest} weitere im Portal.</p>` : '',
  ].join('')

  const inhaltText = [
    `${titelBald}:`,
    baldFaellig.length > 0 ? tagesmailText(baldFaellig, stichtag) : 'Nichts fällig in diesem Zeitraum.',
    ...(weitere.length > 0 ? ['', `${titelWeitere}:`, tagesmailText(gezeigt, stichtag)] : []),
    ...(rest > 0 ? [`… und ${rest} weitere im Portal.`] : []),
  ].join('\n')

  const bald = baldFaellig.length - ueberfaellig
  const zusammenfassung = [
    ueberfaellig > 0 ? `${ueberfaellig} überfällig` : '',
    bald > 0 ? `${bald} bald fällig` : '',
    `${total} offen`,
  ].filter(Boolean).join(', ')

  return sendProjektMgtMail({
    to,
    empfaengerName,
    subject: `Deine Aufgaben am ${datumMitTag(stichtag)}: ${zusammenfassung}`,
    intro: total === 1
      ? 'Du hast eine offene Aufgabe.'
      : `Du hast ${total} offene Aufgaben${ueberfaellig > 0 ? `, ${ueberfaellig === 1 ? 'eine davon ist' : `${ueberfaellig} davon sind`} überfällig` : ''}.`,
    inhaltHtml,
    inhaltText,
    buttonLabel: 'Fällige Aufgaben öffnen',
    buttonPath: `${basisPfad}?tab=faellig&meine=1`,
    fussHtml: `Du bekommst diese Mail an jedem Arbeitstag, weil du sie im <a href="${basis}" style="color:#9ca3af;">Projekt-Mgt</a> abonniert hast. Abbestellen: dort das Häkchen «Tägliche Mail» entfernen.`,
  })
}

export { formatDatum }
