#!/usr/bin/env node
// ============================================================
// Vergleicht ein Übersetzungs-Wörterbuch mit den Texten, die die
// Oberfläche tatsächlich benutzt.
//
//   node werkzeug/texte-pruefen.mjs <pfad-zum-woerterbuch.ts>
//
// Meldet zweierlei:
//   FEHLT     — das Paket zeigt den Text, das Wörterbuch kennt ihn
//               nicht. Er erscheint dann auf Deutsch.
//   VERWAIST  — das Wörterbuch übersetzt etwas, das es im Paket
//               nicht (mehr) gibt. Meist ein Rest nach einer
//               Textänderung.
//
// Ohne Argument werden nur die Texte des Pakets aufgelistet.
// ============================================================

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const wurzel = join(dirname(fileURLToPath(import.meta.url)), '..')

function dateien(verzeichnis) {
  return readdirSync(verzeichnis, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? dateien(join(verzeichnis, e.name))
    : e.name.endsWith('.tsx') ? [join(verzeichnis, e.name)] : []
  )
}

// Alle Zeichenketten einsammeln, die als Argument in einem
// txt(…)-Aufruf stehen. Nicht nur `txt('…')`: die Oberfläche
// übergibt Texte auch als Ausdruck, etwa
//   txt(n === 1 ? '{0} Mitglied' : '{0} Mitglieder', n)
// Deshalb wird die schliessende Klammer gesucht und alles darin
// ausgewertet — ein blosses Muster auf `txt('` übersieht diese Fälle
// und meldet die Einträge dann fälschlich als verwaist.
function textenAusAufrufen(quelle) {
  const gefunden = []
  let i = 0
  while ((i = quelle.indexOf('txt(', i)) !== -1) {
    let tiefe = 0, j = i + 3, inZeichenkette = null, argument = ''
    for (; j < quelle.length; j++) {
      const c = quelle[j]
      if (inZeichenkette) {
        if (c === '\\') { argument += c + quelle[++j]; continue }
        if (c === inZeichenkette) { inZeichenkette = null; continue }
        argument += c
        continue
      }
      if (c === "'" || c === '"') { inZeichenkette = c; argument = ''; continue }
      if (c === '(') tiefe++
      else if (c === ')') { if (--tiefe === 0) break }
      // Ende eines Literals: merken
      if (argument && (c === ',' || c === ':' || c === '?' || c === ')')) { gefunden.push(argument); argument = '' }
    }
    if (argument) gefunden.push(argument)
    i = j + 1
  }
  return gefunden
}

const imPaket = new Set()
for (const f of dateien(join(wurzel, 'src/ui'))) {
  for (const t of textenAusAufrufen(readFileSync(f, 'utf8'))) imPaket.add(t)
}

const pfad = process.argv[2]
if (!pfad) {
  console.log(`${imPaket.size} Texte in der Oberfläche:`)
  for (const t of [...imPaket].sort()) console.log('  ' + t)
  process.exit(0)
}

// Schlüssel des Wörterbuchs: 'schlüssel': oder "schlüssel":
const quelle = readFileSync(pfad, 'utf8')
const imBuch = new Set()
for (const m of quelle.matchAll(/^\s*'((?:[^'\\]|\\.)*)':/gm)) imBuch.add(m[1])

const fehlt = [...imPaket].filter(t => !imBuch.has(t)).sort()
const verwaist = [...imBuch].filter(t => !imPaket.has(t)).sort()

console.log(`Oberfläche: ${imPaket.size} Texte · Wörterbuch: ${imBuch.size} Einträge`)
if (fehlt.length) {
  console.log(`\nFEHLT (${fehlt.length}) — erscheint auf Deutsch:`)
  for (const t of fehlt) console.log('  ' + t)
}
if (verwaist.length) {
  console.log(`\nVERWAIST (${verwaist.length}) — im Paket nicht mehr vorhanden:`)
  for (const t of verwaist) console.log('  ' + t)
}
if (!fehlt.length && !verwaist.length) console.log('\nvollständig und ohne Reste')
process.exit(fehlt.length ? 1 : 0)
