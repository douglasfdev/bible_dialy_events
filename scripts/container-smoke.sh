#!/usr/bin/env bash
# Uses isolated volumes and dummy configuration; never touches production credentials.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
: "${APP_IMAGE:=bible-daily-events:local}"
export APP_IMAGE
project="bible-ci-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
work=$(mktemp -d)
export APP_ENV_FILE="$work/app.env" EVENT_SOURCES_PATH="$PWD/docs/event-sources.example.json"
export DATA_VOLUME_NAME="$project-data" TRUST_PROXY=0
export APP_DOMAIN=example.org ACME_EMAIL=ci@example.org
cp deploy/app.env.example "$APP_ENV_FILE"
cat > "$work/override.yml" <<'YAML'
services:
  app:
    ports:
      - "127.0.0.1::3000"
YAML
compose() { docker compose --project-name "$project" -f docker-compose.yml -f "$work/override.yml" "$@"; }
cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then
    compose ps >&2 || true
    compose logs --tail=60 app >&2 || true
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
compose config --quiet
compose --profile proxy run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
compose up -d --no-build --wait --wait-timeout 120 app
port=$(compose port app 3000)
export SMOKE_URL="http://$port"
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const url=process.env.SMOKE_URL;
const response=await fetch(`${url}/health`);
assert.equal(response.status,200);
const body=await response.json();assert.equal(body.status,'ok');assert.equal(body.whatsapp,'disabled');
const landing=await fetch(url);assert.equal(landing.status,200);assert.match(await landing.text(),/Palavra Diária/);
const lead=await fetch(`${url}/api/lead`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Smoke Test',phone:'5511999999999',email:'smoke@example.com',consent:true})});
assert.equal(lead.status,503);assert.equal((await lead.json()).error,'SERVICE_UNAVAILABLE');
const webhook=await fetch(`${url}/webhooks/mercadopago`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
assert.equal(webhook.status,503); // No credentials configured: never accept an unverified webhook.
console.log('Container: landing, health, enrollment guard and webhook guard passed.');
JS
# Exercise volume persistence and container replacement, without creating real users.
compose exec -T app node -e 'require("node:fs").writeFileSync("/app/data/.smoke-marker", "persisted")'
compose up -d --no-build --force-recreate --wait --wait-timeout 120 app
compose exec -T app node -e '
  if(process.getuid()===0)process.exit(1);
  const fs=require("node:fs"); if(fs.readFileSync("/app/data/.smoke-marker","utf8")!=="persisted")process.exit(1);
  const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync("/app/data/app.sqlite");
  if(db.prepare("PRAGMA integrity_check").get().integrity_check!=="ok")process.exit(1); db.close();
'
echo 'Container: volume persisted after recreation and SQLite integrity check passed.'

# Exercise the same stopped-volume backup used on the VM, then restore separately.
compose stop app
mkdir "$work/backup"
docker run --rm --network none --user 0:0 --read-only --cap-drop ALL --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges:true --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --mount "type=volume,source=$DATA_VOLUME_NAME,target=/source,readonly" \
  --mount "type=bind,source=$work/backup,target=/backup" \
  --entrypoint /bin/sh "$APP_IMAGE" -ec '
    umask 077
    tar -czf /backup/snapshot.tgz -C /source .
    mkdir /tmp/restore
    tar --no-same-owner --no-same-permissions -xzf /backup/snapshot.tgz -C /tmp/restore
    test "$(cat /tmp/restore/.smoke-marker)" = persisted
    node -e "const {DatabaseSync}=require(\"node:sqlite\");const db=new DatabaseSync(\"/tmp/restore/app.sqlite\");if(db.prepare(\"PRAGMA integrity_check\").get().integrity_check!==\"ok\")process.exit(1);db.close();"
  '
echo 'Container: stopped-volume backup restored with marker and SQLite intact.'
