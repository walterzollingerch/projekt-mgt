# @tomtalent/projekt-mgt

Projekte, Aufgaben, Ordner, Tags, Notizen, Beobachter, wiederkehrende Aufgaben und ein MCP-Zugang — als geteiltes Modul für mehrere Next.js-Apps.

Benutzt von **TT Portal** (`ttportal`) und **Terramay** (`terramay-horses`). Beide Apps haben ihre eigene Datenbank, ihre eigenen Nutzer und ihre eigenen Projekte. Geteilt wird ausschliesslich Code und Schema-Definition — **es fliessen keine Daten zwischen den Apps.**

## Die eine Regel

**Änderungen am Projekt-Mgt passieren hier, nie in einer der Apps.**

Wer den Code in `node_modules/@tomtalent/projekt-mgt` bearbeitet, verliert die Änderung beim nächsten `npm install` — und die andere App bekommt sie ohnehin nie. Merkmal einer Änderung, die hierher gehört: sie betrifft Projekte, Aufgaben, Ordner, Tags, Notizen, Beobachter oder den MCP-Zugang.

## Aufbau

```
sql/modul/    Migrationen des Moduls in Reihenfolge (01…09). In jeder App
              identisch — hier stehen die Tabellen, Trigger und Policies,
              die dem Projekt-Mgt gehören.
sql/host/     Was die Gastgeber-App bereitstellen muss. Pro App eine
              Fassung, weil sie deren profiles-Spalten aufzählt.
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
"@tomtalent/projekt-mgt": "https://github.com/walterzollingerch/projekt-mgt/archive/refs/tags/v1.0.0.tar.gz"
```

Immer auf einen **Tag** zeigen, nie auf `main` — sonst ändert sich das Verhalten der App beim nächsten Vercel-Build, ohne dass jemand etwas getan hat.

**Nicht** die Kurzform `github:walterzollingerch/projekt-mgt#v1.0.0` benutzen. npm schreibt die in der Lock-Datei auf `git+ssh://git@github.com/…` um — auch wenn man ausdrücklich `git+https://` hinschreibt. Im Vercel-Build gibt es keine SSH-Schlüssel, und er scheitert dann beim Installieren. Das Tarball-Archiv ist reines HTTPS und braucht im Build kein Git.

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

**4. Datenbank.** In dieser Reihenfolge:

1. `sql/host/<app>_01_voraussetzungen.sql`
2. `sql/modul/01` bis `09` der Reihe nach
3. `sql/host/<app>_02_profilzugriff.sql`

Drei Dateien statt einer, weil Schritt 3 die Funktionen `is_project_manager()` und `shares_project_with()` aus `modul/01` benutzt. Stünde er in derselben Datei wie Schritt 1, würde ein Ausführen am Stück mit «function does not exist» abbrechen — eine Datei, die man nur teilweise ausführen darf, ist eine Falle.

Die Gastgeber-App muss mitbringen: `profiles` (mit `role`, `is_blocked`, `can_use_projects`, `can_manage_projects`), `companies` (`id`, `name`) und die View `mitarbeiter_verzeichnis` (`id, full_name, email, company_id, is_blocked, darf_projekte_nutzen`). Den Storage-Bucket `task-attachments` legt `sql/modul/02` an.

**Vor dem Einspielen trocken prüfen.** Die ganze Kette lässt sich gegen die Zieldatenbank durchspielen, ohne etwas zu hinterlassen — das findet alle fehlenden Voraussetzungen auf einmal statt eine pro Anlauf:

```sql
BEGIN;
-- host/<app>_01, dann modul/01..08, dann host/<app>_02 aneinandergehängt
ROLLBACK;
```

Der Supabase-SQL-Editor fährt ohnehin jedes Skript in einer Transaktion: bricht es ab, ist nichts halb angelegt.

**Warum die Trennung:** Der Privilegien-Schutz-Trigger auf `profiles` zählt *alle* Rechte-Spalten der jeweiligen App auf — im Portal sind das zwölf, in Terramay sieben. Eine gemeinsame Fassung wäre in beiden Apps falsch. Dasselbe gilt für die Erweiterung der `profiles`-Policies. Alles andere ist überall gleich.

**5. Client übergeben.** Die App reicht ihren eigenen Supabase-Client an der Grenze herein:

```ts
import { alsProjektMgtClient } from '@tomtalent/projekt-mgt'
const db = alsProjektMgtClient(await createClient())
```

Der Cast ist Absicht und steht genau an dieser einen Stelle: TypeScript kann die beiden Schema-Typen nicht ineinander überführen, obwohl die benutzten Tabellen deckungsgleich sind. Innerhalb des Moduls ist damit alles typisiert, statt überall `any` zu haben.

## Sprache

**Deutsch ist die führende Sprache und fest eingebaut.** Eine App überschreibt einzelne Beschriftungen über `texte` im Host-Adapter; fehlt ein Eintrag, bleibt der deutsche Text stehen. Eine unvollständige Übersetzung ist damit sichtbar, aber nie kaputt — und eine App kann in Betrieb gehen, bevor alles übersetzt ist.

## Eigene Tasks

Jede Person, die das Modul benutzen darf, hat ein persönliches Projekt **«Eigene Tasks»** — den Ort für Aufgaben, die niemanden sonst betreffen. Technisch ist es ein gewöhnliches Projekt mit gesetztem `projects.persoenlich_fuer`; deshalb erscheint es überall dort, wo Projekte ohnehin vorkommen (Übersicht, Fälligkeitsliste, Suche, MCP), ohne dass eine App dafür etwas tun müsste.

Vier Regeln, alle in `sql/modul/09` erzwungen — nicht in der Oberfläche:

- **Keine Firma.** `company_id` ist dort null (der CHECK `projects_firma_oder_persoenlich` lässt genau eine der beiden Spalten gesetzt sein). Eine Person ist nicht die Firma, für die sie arbeitet — und in Terramay gibt es die Zuordnung gar nicht. Folge: dort gibt es keine Tags, denn Tags gehören zur Firma.
- **Ein Mitglied.** Jede Aufgabe darin ist dieser Person zugewiesen; ein Trigger setzt das, statt es abzulehnen. Wer eine Aufgabe dorthin umhängt, meint «das mache ich selbst».
- **Privat.** Auch Administratoren sehen weder das Projekt noch seine Aufgaben, Notizen oder Anhänge. Jede Admin-Blankopolicy des Moduls ist um «ausser persönlichen Projekten» ergänzt.
- **Nicht verwaltet.** Es wird nicht umbenannt, archiviert, gelöscht oder um Mitglieder ergänzt — auch von der Person selbst nicht. Es entsteht mit `persoenliches_projekt_anlegen()` und verschwindet mit dem Profil (`ON DELETE CASCADE`). Aufgaben darin darf die Person löschen; dafür gibt es keinen Verwalter.

Angelegt wird es an drei Stellen: einmalig bei der Migration für alle Berechtigten, danach durch einen Trigger auf `profiles` für jede Person, die das Modul-Recht bekommt — und als Notnagel durch die Oberfläche selbst, die `persoenliches_projekt_sichern()` aufruft, wenn das eigene Projekt in der Liste fehlt.

**Für die Apps heisst das:** `projects.company_id` kann jetzt null sein. Wo eine Seite daraus etwas ableitet — typischerweise `.eq('company_id', project.company_id)` beim Laden der Tags —, muss der Fall abgefangen werden; ein `eq` gegen null scheitert in PostgREST. Die Typprüfung der App zeigt nach dem Versionssprung genau diese Stellen an.

Die Spalte `persoenlich_fuer` muss eine Seite dagegen **nicht** mitladen. Die Oberfläche erkennt das persönliche Projekt auch an der fehlenden Firma — die beiden Kennzeichen sind dank des CHECK gleichwertig. Wer nur einzelne Spalten auswählt statt `*`, bekommt trotzdem die richtige Darstellung: eigener Block zuoberst statt einer Gruppe «Ohne Firma» mitten in der Liste.

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
