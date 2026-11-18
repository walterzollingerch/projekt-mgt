// ============================================================
// Kontingent-Prüfung des MCP-Servers (gestartet von
// werkzeug/kontingent-pruefen.sh — nicht direkt aufrufen).
//
// Spielt den Angriff aus der Portal-Aufgabe nach:
//
//   • ein JSON-RPC-Stapel mit mehr Aufrufen als erlaubt
//   • viele gleichzeitige Einzelanfragen gegen dieselbe Grenze
//
// und die Gegenproben, dass der erlaubte Betrieb weitergeht — unter
// anderem mit einem echten Client der offiziellen MCP-SDK, derselben
// Bibliothek, die Claude Code und Claude Desktop benutzen.
//
// Aufgebaut wird dafür der ganze Weg einer echten Anfrage:
//
//   Client/curl → HTTP → mcpPost (src/mcp/handler.ts)
//              → supabase-js → Hülle → PostgREST → Postgres
//
// Die Hülle ersetzt nur das, was Supabase vor PostgREST stellt: Sie
// schneidet `/rest/v1` ab und nimmt `apikey`/`Authorization` weg,
// damit PostgREST den Dummy-Schlüssel nicht als JWT liest. Alles
// dahinter ist dieselbe REST-Schnittstelle wie in der Produktion.
// ============================================================

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const POSTGREST_URL = process.env.POSTGREST_URL ?? 'http://127.0.0.1:54331'
const DB_CONTAINER = process.env.DB_CONTAINER ?? 'projekt-mgt-kontingent-db'
const HUELLE_PORT = Number(process.env.HUELLE_PORT ?? 54332)
const MCP_PORT = Number(process.env.MCP_PORT ?? 54333)

// Muss VOR dem Import des Moduls stehen: serviceClient() liest die
// Umgebung, der Schlüssel ist für PostgREST ohne JWT bedeutungslos.
process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${HUELLE_PORT}`
process.env.SUPABASE_SERVICE_ROLE_KEY = 'pruefung-ohne-bedeutung'

const { mcpPost, tokenAusHeader, ratelimitPruefen, serviceClient, MCP_RATELIMIT_TEXT, MCP_AUFRUF_OFFEN } =
  await import('../../src/mcp/index')
const { MCP_STAPEL_TEXT } = await import('../../src/mcp/protocol')
const { MCP_MAX_KOERPER_BYTES } = await import('../../src/mcp/handler')
type McpErweiterung = import('../../src/mcp/erweiterung').McpErweiterung

const TOKEN_A = 'pruefung-kontingent-token-person-a'
const TOKEN_B = 'pruefung-kontingent-token-person-b'
const PROFIL_A = 'bbbbbbbb-0000-4000-8000-000000000001'
const PROFIL_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const PROJEKT = 'cccccccc-0000-4000-8000-000000000001'
/** Wie in src/mcp/auth.ts */
const GRENZE = 300

// ── Datenbank direkt (nur für Aufbau und Nachschau) ─────────

function sql(befehl: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', DB_CONTAINER, 'psql', '-v', 'ON_ERROR_STOP=1', '-At', '-U', 'postgres', '-d', 'pruefung', '-c', befehl],
    { encoding: 'utf8' }
  ).trim()
}

const zeilen = (profil: string) =>
  Number(sql(`SELECT count(*) FROM mcp_audit WHERE profile_id = '${profil}'`))

// ── Hülle vor PostgREST ─────────────────────────────────────

const ROH = ['host', 'connection', 'content-length', 'apikey', 'authorization', 'accept-encoding']

function koerperLesen(req: IncomingMessage): Promise<Buffer> {
  return new Promise((loese, scheitere) => {
    const teile: Buffer[] = []
    req.on('data', t => teile.push(t as Buffer))
    req.on('end', () => loese(Buffer.concat(teile)))
    req.on('error', scheitere)
  })
}

const huelle = createServer(async (req, res) => {
  try {
    const pfad = (req.url ?? '/').replace(/^\/rest\/v1/, '')
    const kopf: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers))
      if (!ROH.includes(k) && typeof v === 'string') kopf[k] = v
    const leer = req.method === 'GET' || req.method === 'HEAD'
    const koerper = leer ? undefined : await koerperLesen(req)
    const antwort = await fetch(POSTGREST_URL + pfad, { method: req.method, headers: kopf, body: koerper })
    const aus: Record<string, string> = {}
    antwort.headers.forEach((wert, name) => {
      if (!['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(name)) aus[name] = wert
    })
    const inhalt = Buffer.from(await antwort.arrayBuffer())
    res.writeHead(antwort.status, aus)
    res.end(inhalt)
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: String(e) }))
  }
})

// ── Der MCP-Server über HTTP ────────────────────────────────
//
// Eine App-Erweiterung ist dabei, weil der dritte Parameter von
// `ausfuehren` geprüft werden soll: die Kennung dieses einen
// Aufrufs. Das Werkzeug schaut selbst in die Datenbank und meldet,
// was dort zu seiner Kennung schon steht — so zeigt die Prüfung,
// dass die Protokollzeile VOR dem Werkzeug entsteht.

interface Beobachtung {
  id: string
  /** Stand der mcp_audit-Zeile, während das Werkzeug lief */
  zeileWaehrendLauf: string
}
const beobachtungen: Beobachtung[] = []

const erweiterung: McpErweiterung = async () => ({
  projektWerkzeuge: true,
  werkzeuge: [
    {
      name: 'pruef_werkzeug',
      description: 'Nur für die Prüfung: meldet die Kennung des eigenen Aufrufs.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
  async ausfuehren(name, _args, aufruf) {
    if (name !== 'pruef_werkzeug') return { erfolg: false, fehler: `Unbekanntes Werkzeug «${name}».` }
    const stand = sql(
      `SELECT coalesce(tool || '/' || erfolg || '/' || coalesce(fehler, '—'), 'keine Zeile')
         FROM mcp_audit WHERE id = '${aufruf.id}'`
    )
    beobachtungen.push({ id: aufruf.id, zeileWaehrendLauf: stand || 'keine Zeile' })
    return { erfolg: true, daten: { aufruf: aufruf.id } }
  },
})

const mcpServer = createServer(async (req, res) => {
  const roh = await koerperLesen(req)
  const kopf = new Headers()
  for (const [k, v] of Object.entries(req.headers))
    if (!['host', 'connection'].includes(k) && typeof v === 'string') kopf.set(k, v)
  const anfrage = new Request(`http://127.0.0.1:${MCP_PORT}/api/mcp`, {
    method: req.method,
    headers: kopf,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : roh,
  })
  const antwort =
    req.method === 'POST'
      ? await mcpPost(anfrage as never, tokenAusHeader(anfrage as never), erweiterung)
      : new Response(JSON.stringify({ error: 'nur POST' }), { status: 405 })
  const text = await antwort.text()
  res.writeHead(antwort.status, { 'content-type': antwort.headers.get('content-type') ?? 'application/json' })
  res.end(text)
})

function starte(server: Server, port: number): Promise<void> {
  return new Promise(loese => server.listen(port, '127.0.0.1', () => loese()))
}

// ── Anfragen ────────────────────────────────────────────────

const URL_MCP = `http://127.0.0.1:${MCP_PORT}/api/mcp`

async function post(koerper: unknown, token = TOKEN_A) {
  const antwort = await fetch(URL_MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: typeof koerper === 'string' ? koerper : JSON.stringify(koerper),
  })
  const text = await antwort.text()
  let daten: any = null
  try {
    daten = JSON.parse(text)
  } catch {
    /* 202 ohne Rumpf */
  }
  return { status: antwort.status, daten }
}

let naechsteId = 1
const aufruf = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: naechsteId++,
  method: 'tools/call',
  params: { name, arguments: args },
})

// ── Prüfbericht ─────────────────────────────────────────────

/** Derselbe Client, mit dem der MCP-Server arbeitet */
const supabase = serviceClient()

const bericht: { pruefung: string; ergebnis: string; erwartet: string }[] = []
let fehlgeschlagen = 0

function pruefe(pruefung: string, ergebnis: unknown, erwartet: unknown) {
  const a = typeof ergebnis === 'string' ? ergebnis : JSON.stringify(ergebnis)
  const b = typeof erwartet === 'string' ? erwartet : JSON.stringify(erwartet)
  if (a !== b) fehlgeschlagen++
  bericht.push({ pruefung, ergebnis: a, erwartet: b })
  console.log(`${a === b ? '✓' : '✗'} ${pruefung}\n    ergebnis: ${a}\n    erwartet: ${b}`)
}

const kontingentHinweis = (antwort: any) =>
  antwort?.result?.isError === true && antwort?.result?.content?.[0]?.text === MCP_RATELIMIT_TEXT

// ── Prüfung ─────────────────────────────────────────────────

await starte(huelle, HUELLE_PORT)
await starte(mcpServer, MCP_PORT)

try {
  console.log('\n── 1. Gegenprobe: echter Client der offiziellen MCP-SDK ──\n')
  // Dieselbe Bibliothek, die Claude Code und Claude Desktop benutzen.
  // Sie schickt pro POST genau eine Nachricht — die Ablehnung von
  // Stapeln darf an ihr nichts ändern.
  {
    const client = new Client({ name: 'kontingent-pruefung', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN_A}` } },
    })
    await client.connect(transport)
    pruefe('SDK-Client: Handschlag mit Protokollfassung', client.getServerVersion()?.name ?? '—', 'ttportal-projekt-mgt')
    const werkzeuge = (await client.listTools()).tools.map(w => w.name)
    pruefe('SDK-Client: tools/list bringt Projekt- und App-Werkzeuge', [
      werkzeuge.includes('list_projects'),
      werkzeuge.includes('pruef_werkzeug'),
    ], [true, true])
    const ergebnis: any = await client.callTool({ name: 'list_projects', arguments: {} })
    const projekte = JSON.parse(ergebnis.content[0].text).projekte.map((p: any) => p.name)
    pruefe('SDK-Client: tools/call liefert die Projekte', projekte.includes('Prüfprojekt'), true)
    pruefe('SDK-Client: der Aufruf steht im Protokoll', zeilen(PROFIL_A), 1)
    await client.close()
  }

  console.log('\n── 2. Gegenprobe: erlaubter Betrieb nacheinander ──\n')
  {
    const vorher = zeilen(PROFIL_A)
    const antworten = []
    for (let i = 0; i < 10; i++) antworten.push(await post(aufruf('list_projects')))
    pruefe(
      'Zehn Aufrufe nacheinander: alle mit HTTP 200 und ohne Fehler',
      antworten.every(a => a.status === 200 && a.daten?.result?.isError === false),
      true
    )
    pruefe('Zehn Aufrufe: zehn neue Protokollzeilen', zeilen(PROFIL_A) - vorher, 10)
    pruefe(
      'Protokoll nachgeführt: kein Aufruf bleibt offen',
      sql(`SELECT count(*) FROM mcp_audit WHERE profile_id = '${PROFIL_A}' AND fehler = '${MCP_AUFRUF_OFFEN}'`),
      '0'
    )
    pruefe(
      'Protokoll nachgeführt: alle als erfolgreich vermerkt',
      sql(`SELECT count(*) FROM mcp_audit WHERE profile_id = '${PROFIL_A}' AND erfolg`),
      String(zeilen(PROFIL_A))
    )
  }

  console.log('\n── 3. Angriff: JSON-RPC-Stapel ──\n')
  {
    const vorher = zeilen(PROFIL_A)
    const stapel = Array.from({ length: 150 }, () => aufruf('list_projects'))
    const antwort = await post(stapel)
    pruefe('Stapel mit 150 Werkzeugaufrufen: HTTP 400', antwort.status, 400)
    pruefe('Stapel: JSON-RPC-Fehler -32600 mit Begründung', [antwort.daten?.error?.code, antwort.daten?.error?.message], [
      -32600,
      MCP_STAPEL_TEXT,
    ])
    pruefe('Stapel: kein einziger Aufruf wurde ausgeführt', zeilen(PROFIL_A) - vorher, 0)

    // Auch ein harmloser Stapel wird abgelehnt — eine Ausnahme wäre
    // wieder ein Weg, mehrere Nachrichten gleichzeitig laufen zu lassen
    const harmlos = await post([
      { jsonrpc: '2.0', id: 900, method: 'ping' },
      { jsonrpc: '2.0', id: 901, method: 'tools/list' },
    ])
    pruefe('Stapel aus zwei harmlosen Nachrichten: ebenfalls HTTP 400', harmlos.status, 400)

    // Einzelne Nachricht derselben Art: unverändert erlaubt
    const einzeln = await post({ jsonrpc: '2.0', id: 902, method: 'ping' })
    pruefe('Einzelne Nachricht: unverändert HTTP 200', [einzeln.status, JSON.stringify(einzeln.daten?.result)], [200, '{}'])
  }

  console.log('\n── 4. Angriff: zu grosser Anfragekörper ──\n')
  {
    const gross = JSON.stringify({
      jsonrpc: '2.0',
      id: 903,
      method: 'tools/call',
      params: { name: 'list_projects', arguments: { füllung: 'x'.repeat(MCP_MAX_KOERPER_BYTES) } },
    })
    const antwort = await post(gross)
    pruefe('Rumpf über 1 MiB: HTTP 413', antwort.status, 413)
    pruefe('Rumpf über 1 MiB: JSON-RPC-Fehler -32600', antwort.daten?.error?.code, -32600)
  }

  console.log('\n── 5. Angriff: gleichzeitige Einzelanfragen ──\n')
  {
    // Fenster bis fünf unter die Grenze füllen: so liegt die Grenze
    // mitten im Schwung der gleichzeitigen Anfragen. Vorher räumen,
    // damit die Zahl unabhängig von den Schritten davor stimmt.
    sql(`DELETE FROM mcp_audit WHERE profile_id = '${PROFIL_A}'`)
    sql(
      `INSERT INTO mcp_audit (token_id, profile_id, tool, erfolg)
         SELECT 'dddddddd-0000-4000-8000-000000000001', '${PROFIL_A}', 'list_projects', true
           FROM generate_series(1, ${GRENZE - 5})`
    )
    pruefe('Ausgangslage: fünf Aufrufe unter der Grenze', zeilen(PROFIL_A), GRENZE - 5)

    const antworten = await Promise.all(Array.from({ length: 40 }, () => post(aufruf('list_projects'))))
    const durch = antworten.filter(a => a.status === 200 && a.daten?.result?.isError === false).length
    const hinweis = antworten.filter(a => a.status === 200 && kontingentHinweis(a.daten)).length
    const zuVieleAufrufe = antworten.filter(a => a.status === 429).length
    pruefe('40 gleichzeitige Anfragen: genau 5 kommen durch', durch, 5)
    // Wie die 35 abgewiesen werden, hängt am Zufall der Reihenfolge:
    // Wer startet, solange der Zähler noch unter der Grenze steht,
    // läuft in die Reservierung und bekommt den Hinweis als Ergebnis;
    // wer später startet, wird schon von der Vorprüfung mit 429
    // abgewiesen. Beides ist richtig, die Summe ist die Zusage.
    console.log(`    (davon ${hinweis} mit Kontingent-Hinweis, ${zuVieleAufrufe} mit HTTP 429)`)
    pruefe('40 gleichzeitige Anfragen: die anderen 35 werden abgewiesen', hinweis + zuVieleAufrufe, 35)
    pruefe('Zähler steht genau auf der Grenze', zeilen(PROFIL_A), GRENZE)

    const danach = await post(aufruf('list_projects'))
    pruefe('Nächste Anfrage: HTTP 429', danach.status, 429)
    pruefe('429 nennt die Grenze', danach.daten?.error?.message, MCP_RATELIMIT_TEXT)
    pruefe('Die abgewiesene Anfrage verbraucht nichts', zeilen(PROFIL_A), GRENZE)
  }

  console.log('\n── 5b. Gegenprobe des Nachweises: ohne Reservierung reisst die Grenze ──\n')
  {
    // Dasselbe Szenario mit dem alten Muster «zählen, arbeiten,
    // eintragen» — gebaut aus `ratelimitPruefen()`, die es noch gibt.
    // Reisst die Grenze hier nicht, prüft Abschnitt 5 nichts.
    sql(`DELETE FROM mcp_audit WHERE profile_id = '${PROFIL_A}'`)
    sql(
      `INSERT INTO mcp_audit (token_id, profile_id, tool, erfolg)
         SELECT 'dddddddd-0000-4000-8000-000000000001', '${PROFIL_A}', 'list_projects', true
           FROM generate_series(1, ${GRENZE - 5})`
    )
    const altesMuster = async () => {
      const limit = await ratelimitPruefen(supabase, PROFIL_A)
      if (!limit.erlaubt) return
      await supabase.from('mcp_audit').insert({
        token_id: 'dddddddd-0000-4000-8000-000000000001',
        profile_id: PROFIL_A,
        tool: 'list_projects',
        erfolg: true,
      })
    }
    await Promise.all(Array.from({ length: 40 }, altesMuster))
    const stand = zeilen(PROFIL_A)
    console.log(`    (Zähler nach dem alten Muster: ${stand}, Grenze ${GRENZE})`)
    pruefe('Altes Muster: 40 gleichzeitige Aufrufe überschreiten die Grenze', stand > GRENZE, true)
  }

  console.log('\n── 6. Gegenprobe: die Grenze gilt pro Person ──\n')
  {
    const antwort = await post(aufruf('list_projects'), TOKEN_B)
    pruefe('Person B arbeitet weiter, obwohl A ausgeschöpft ist', [antwort.status, antwort.daten?.result?.isError], [200, false])
    pruefe('Person B hat eine eigene Protokollzeile', zeilen(PROFIL_B), 1)
  }

  console.log('\n── 7. Haken der App-Werkzeuge: Kennung pro Aufruf ──\n')
  {
    beobachtungen.length = 0
    sql(`DELETE FROM mcp_audit WHERE profile_id = '${PROFIL_B}'`)
    const antworten = []
    for (let i = 0; i < 3; i++) antworten.push(await post(aufruf('pruef_werkzeug'), TOKEN_B))
    pruefe('Drei Aufrufe des App-Werkzeugs: alle ok', antworten.every(a => a.daten?.result?.isError === false), true)
    pruefe('Der Haken bekam drei Kennungen', beobachtungen.length, 3)
    pruefe('Jede Kennung kommt genau einmal vor', new Set(beobachtungen.map(b => b.id)).size, 3)
    pruefe(
      'Die Protokollzeile stand schon, als das Werkzeug lief',
      beobachtungen.map(b => b.zeileWaehrendLauf),
      Array(3).fill(`pruef_werkzeug/false/${MCP_AUFRUF_OFFEN}`)
    )
    pruefe(
      'Jede Kennung ist die id ihrer Protokollzeile, jetzt nachgeführt',
      sql(
        `SELECT count(*) FROM mcp_audit
          WHERE id IN (${beobachtungen.map(b => `'${b.id}'`).join(', ')})
            AND tool = 'pruef_werkzeug' AND erfolg AND fehler IS NULL`
      ),
      '3'
    )
    pruefe(
      'Die Kennung, die das Werkzeug meldete, ist dieselbe',
      antworten.map(a => JSON.parse(a.daten.result.content[0].text).aufruf),
      beobachtungen.map(b => b.id)
    )
  }

  console.log('\n── 8. Gegenprobe: fehlgeschlagener Aufruf wird nachgeführt ──\n')
  {
    const antwort = await post(aufruf('get_task', { task_id: randomUUID() }), TOKEN_B)
    pruefe('Unbekannte Aufgabe: isError, aber HTTP 200', [antwort.status, antwort.daten?.result?.isError], [200, true])
    pruefe(
      'Die Protokollzeile trägt den Fehler, nicht «offen»',
      sql(
        `SELECT count(*) FROM mcp_audit
          WHERE profile_id = '${PROFIL_B}' AND tool = 'get_task'
            AND NOT erfolg AND fehler IS NOT NULL AND fehler <> '${MCP_AUFRUF_OFFEN}'`
      ),
      '1'
    )
  }

  console.log('\n── 9. Rechte der Reservierungs-Funktion ──\n')
  {
    const rechte = sql(
      `SELECT left(has_function_privilege('anon', 'public.mcp_aufruf_reservieren(uuid,uuid,uuid,text,jsonb,integer,integer)', 'EXECUTE')::text, 1)
            || left(has_function_privilege('authenticated', 'public.mcp_aufruf_reservieren(uuid,uuid,uuid,text,jsonb,integer,integer)', 'EXECUTE')::text, 1)
            || left(has_function_privilege('service_role', 'public.mcp_aufruf_reservieren(uuid,uuid,uuid,text,jsonb,integer,integer)', 'EXECUTE')::text, 1)`
    )
    pruefe('anon und authenticated dürfen nicht, service_role darf (ff t)', rechte, 'fft')
  }

  console.log('\n── 10. Fail-open: ohne Migration 15 läuft der Zugang weiter ──\n')
  {
    sql('DROP FUNCTION public.mcp_aufruf_reservieren(uuid,uuid,uuid,text,jsonb,integer,integer)')
    sql("NOTIFY pgrst, 'reload schema'")
    await new Promise(l => setTimeout(l, 500))
    const vorher = zeilen(PROFIL_B)
    const antwort = await post(aufruf('list_projects'), TOKEN_B)
    pruefe('Ohne die Funktion: der Aufruf läuft trotzdem', [antwort.status, antwort.daten?.result?.isError], [200, false])
    pruefe('Ohne die Funktion: die Protokollzeile entsteht weiterhin', zeilen(PROFIL_B) - vorher, 1)
  }
} finally {
  huelle.close()
  mcpServer.close()
}

console.log('\n════════════════════════════════════════════════')
console.log(`${bericht.length - fehlgeschlagen} von ${bericht.length} Prüfungen erfüllt`)
if (fehlgeschlagen) {
  console.error(`\n✗ ${fehlgeschlagen} Prüfung(en) fehlgeschlagen`)
  process.exit(1)
}
console.log('✓ Stapel abgelehnt, Kontingent atomar, erlaubter Betrieb unverändert')
