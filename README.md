# @tomtalent/projekt-mgt

Projekte, Aufgaben, Ordner, Tags, Notizen, Beobachter, wiederkehrende Aufgaben und ein MCP-Zugang — als geteiltes Modul für mehrere Next.js-Apps.

Benutzt von **TT Portal** (`ttportal`) und **Terramay** (`terramay-horses`). Beide Apps haben ihre eigene Datenbank, ihre eigenen Nutzer und ihre eigenen Projekte. Geteilt wird ausschliesslich Code und Schema-Definition — **es fliessen keine Daten zwischen den Apps.**

## Die eine Regel

**Änderungen am Projekt-Mgt passieren hier, nie in einer der Apps.**

Wer den Code in `node_modules/@tomtalent/projekt-mgt` bearbeitet, verliert die Änderung beim nächsten `npm install` — und die andere App bekommt sie ohnehin nie. Merkmal einer Änderung, die hierher gehört: sie betrifft Projekte, Aufgaben, Ordner, Tags, Notizen, Beobachter oder den MCP-Zugang.

## Aufbau

```
sql/          Migrationen in Reihenfolge (01…08). Jede App spielt sie in
              ihre eigene Datenbank ein.
src/typen.ts  Das Schema, das dieses Modul besitzt — plus profiles,
              companies und die View mitarbeiter_verzeichnis, die es von
              der Gastgeber-App erwartet.
src/host.ts   Host-Adapter: Domain, Marke, Mail-Absender, Textüberschreibungen.
src/logik/    Fachlogik (service.ts), Tags, HTTP-Hülle. Frei von
              Authentifizierung: bekommt einen Supabase-Client und die
              Profil-ID des Handelnden.
src/mail/     Resend-Benachrichtigungen.
src/mcp/      MCP-Server (JSON-RPC über HTTP, ohne SDK).
src/ui/       Oberfläche (React) inkl. eigener Grundbausteine.
```

## Einbinden

**1. Abhängigkeit** in der `package.json` der App:

```json
"@tomtalent/projekt-mgt": "github:walterzollingerch/projekt-mgt#v1.0.0"
```

Immer auf einen **Tag** zeigen, nie auf `main` — sonst ändert sich das Verhalten der App beim nächsten Vercel-Build, ohne dass jemand etwas getan hat.

**2. Transpilieren.** Das Paket liefert TypeScript-Quellen aus, keinen Build. In `next.config.ts`:

```ts
transpilePackages: ['@tomtalent/projekt-mgt']
```

**3. Konfigurieren.** Die App legt ein eigenes Setup-Modul an und importiert es in jedem Einstiegspunkt (Seiten, API-Routen, MCP-Route):

```ts
import { projektMgtKonfigurieren } from '@tomtalent/projekt-mgt'

projektMgtKonfigurieren({
  appUrl: 'https://ttportal.tomtalent.ch',
  marke: {
    titel: 'TOM TALENT — Projekt-Mgt',
    absender: 'TOM TALENT Mgt AG',
    mailVonName: 'TOM TALENT Projekt-Mgt',
    mailVonAdresse: process.env.RESEND_FROM_EMAIL || 'mittagessen@tomtalent.ch',
  },
})
```

**4. Datenbank.** Die Migrationen aus `sql/` einspielen, dazu die Voraussetzungen der Gastgeber-App:

- Tabellen `profiles` (mit `role`, `is_blocked`, `company_id`, `can_use_projects`, `can_manage_projects`) und `companies` (`id`, `name`)
- View `mitarbeiter_verzeichnis` mit den Spalten `id, full_name, email, company_id, is_blocked, darf_projekte_nutzen`
- Privater Storage-Bucket `task-attachments`

**5. Client übergeben.** Die App reicht ihren eigenen Supabase-Client an der Grenze herein:

```ts
import { alsProjektMgtClient } from '@tomtalent/projekt-mgt'
const db = alsProjektMgtClient(await createClient())
```

Der Cast ist Absicht und steht genau an dieser einen Stelle: TypeScript kann die beiden Schema-Typen nicht ineinander überführen, obwohl die benutzten Tabellen deckungsgleich sind. Innerhalb des Moduls ist damit alles typisiert, statt überall `any` zu haben.

## Sprache

**Deutsch ist die führende Sprache und fest eingebaut.** Eine App überschreibt einzelne Beschriftungen über `texte` im Host-Adapter; fehlt ein Eintrag, bleibt der deutsche Text stehen. Eine unvollständige Übersetzung ist damit sichtbar, aber nie kaputt — und eine App kann in Betrieb gehen, bevor alles übersetzt ist.

## Rechte

Die RLS-Policies in `sql/` sind in beiden Datenbanken identisch. Sie lesen `profiles.role = 'admin'`, `can_use_projects` und `can_manage_projects`.

Der MCP-Server arbeitet mit dem Service-Role-Schlüssel, **für den die RLS nicht greift**. `src/mcp/guard.ts` bildet die Policies deshalb explizit im Code nach. **Wer eine Policy ändert, muss beide Seiten anfassen** — das SQL und den Guard.

Einzige erlaubte Abweichung zwischen den Apps: wie die Nicht-Admin-Rolle heisst (`mitarbeiter` im Portal, `user` in Terramay). Geprüft wird überall nur auf `admin`.

## Änderung ausliefern

1. Hier ändern, `npm run typecheck`
2. Commit, Version in `package.json` hochziehen, Tag setzen (`v1.1.0`)
3. In **beiden** Apps den Tag in der `package.json` anheben, `npm install`, Typprüfung, pushen
4. Kam eine Migration dazu: in **beiden** Datenbanken einspielen

Schritt 3 und 4 gehören zusammen. Eine App, die den neuen Code hat, aber die Migration nicht, zeigt Fehler statt Daten.
