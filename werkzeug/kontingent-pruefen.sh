#!/usr/bin/env bash
# ============================================================
# Kontingent-Prüfung des MCP-Servers gegen eine frische Datenbank
# im Container.
#
# Spielt den Angriff aus der Portal-Aufgabe nach — JSON-RPC-Stapel
# und gleichzeitige Einzelanfragen gegen die Grenze von 300
# Werkzeugaufrufen in 10 Minuten — samt Gegenproben, dass der
# erlaubte Betrieb weiter geht, inklusive eines echten Clients der
# offiziellen MCP-SDK.
#
#   npm run kontingent-pruefen
#
# Braucht Docker. Aufgebaut wird:
#
#   Postgres  ← Host-Attrappe + sql/modul/*.sql + Testdaten
#   PostgREST ← dieselbe REST-Schnittstelle, die Supabase anbietet
#   Node      ← der MCP-Server dieses Moduls (mcpPost) über HTTP
#
# Die Container heissen `projekt-mgt-kontingent-*` und werden am
# Ende gelöscht. Es wird NIE eine echte Datenbank angefasst — schon
# weil PostgREST hier ohne jede Authentifizierung als `postgres`
# arbeitet.
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."

NETZ=projekt-mgt-kontingent
DB=projekt-mgt-kontingent-db
REST=projekt-mgt-kontingent-rest
POSTGRES_BILD=${POSTGRES_BILD:-postgres:17-alpine}
POSTGREST_BILD=${POSTGREST_BILD:-postgrest/postgrest:v12.2.3}
REST_PORT=${REST_PORT:-54331}

aufraeumen() {
  if [ "${PRUEFUNG_BEHALTEN:-}" = "1" ]; then
    echo "ℹ Container «$DB» und «$REST» bleiben stehen (docker rm -f $DB $REST zum Aufräumen)"
    return
  fi
  docker rm -f "$DB" "$REST" >/dev/null 2>&1 || true
  docker network rm "$NETZ" >/dev/null 2>&1 || true
}
trap aufraeumen EXIT
docker rm -f "$DB" "$REST" >/dev/null 2>&1 || true
docker network rm "$NETZ" >/dev/null 2>&1 || true
docker network create "$NETZ" >/dev/null

echo "▶ Datenbank starten ($POSTGRES_BILD)"
docker run -d --name "$DB" --network "$NETZ" \
  -e POSTGRES_PASSWORD=pruefung -e POSTGRES_DB=pruefung \
  "$POSTGRES_BILD" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$DB" pg_isready -U postgres -d pruefung >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$DB" pg_isready -U postgres -d pruefung >/dev/null

psql_datei() {
  docker exec -i "$DB" psql -v ON_ERROR_STOP=1 -q -U postgres -d pruefung -f -
}

echo "▶ Host-Attrappe, Migrationen und Testdaten einspielen"
psql_datei < werkzeug/pruefung/00_host_attrappe.sql >/dev/null
for datei in sql/modul/*.sql; do
  printf '  %s\n' "$datei"
  psql_datei < "$datei" >/dev/null
done
psql_datei < werkzeug/pruefung/91_kontingent_daten.sql >/dev/null

echo "▶ PostgREST starten ($POSTGREST_BILD)"
# Ohne JWT: jede Anfrage läuft als `postgres` und umgeht damit die
# RLS — genau wie der Service-Role-Schlüssel in Supabase, mit dem der
# MCP-Server arbeitet. Die Hülle in kontingent.ts nimmt die
# Supabase-Kopfzeilen weg, damit PostgREST sie nicht als JWT liest.
docker run -d --name "$REST" --network "$NETZ" \
  -p "127.0.0.1:${REST_PORT}:3000" \
  -e PGRST_DB_URI="postgres://postgres:pruefung@${DB}:5432/pruefung" \
  -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=postgres \
  -e PGRST_DB_POOL=30 \
  -e PGRST_SERVER_PORT=3000 \
  "$POSTGREST_BILD" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${REST_PORT}/mcp_tokens?limit=1" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${REST_PORT}/mcp_tokens?limit=1" >/dev/null

echo "▶ Angriff und Gegenproben"
POSTGREST_URL="http://127.0.0.1:${REST_PORT}" DB_CONTAINER="$DB" \
  npx --yes tsx@4 werkzeug/pruefung/kontingent.ts
