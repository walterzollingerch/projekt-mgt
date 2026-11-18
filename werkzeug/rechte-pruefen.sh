#!/usr/bin/env bash
# ============================================================
# Rechte-Prüfung gegen eine frische Datenbank im Container.
#
# Baut aus `werkzeug/pruefung/00_host_attrappe.sql` und allen
# Migrationen aus `sql/modul/` eine leere Datenbank auf und spielt
# darin den Angriff aus der Portal-Aufgabe nach — samt Gegenproben,
# dass die erlaubten Wege weiter gehen.
#
#   npm run rechte-pruefen
#
# Braucht nur Docker. Der Container heisst `projekt-mgt-rechte` und
# wird am Ende gelöscht. Es wird NIE eine echte Datenbank angefasst.
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."

NAME=projekt-mgt-rechte
BILD=${POSTGRES_BILD:-postgres:17-alpine}

aufraeumen() {
  # Zum Nachschauen: PRUEFUNG_BEHALTEN=1 lässt den Container stehen
  if [ "${PRUEFUNG_BEHALTEN:-}" = "1" ]; then
    echo "ℹ Container «$NAME» bleibt stehen (docker rm -f $NAME zum Aufräumen)"
    return
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap aufraeumen EXIT
docker rm -f "$NAME" >/dev/null 2>&1 || true

echo "▶ Datenbank starten ($BILD)"
docker run -d --name "$NAME" \
  -e POSTGRES_PASSWORD=pruefung -e POSTGRES_DB=pruefung \
  "$BILD" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres -d pruefung >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -d pruefung >/dev/null

psql_datei() {
  docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -q -U postgres -d pruefung "$@"
}

echo "▶ Host-Attrappe und Migrationen einspielen"
psql_datei -f - < werkzeug/pruefung/00_host_attrappe.sql >/dev/null
for datei in sql/modul/*.sql; do
  printf '  %s\n' "$datei"
  psql_datei -f - < "$datei" >/dev/null
done

echo "▶ Angriff und Gegenproben"
psql_datei -f - < werkzeug/pruefung/90_task_schutz.sql
