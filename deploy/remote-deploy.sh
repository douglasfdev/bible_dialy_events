#!/usr/bin/env bash
# Executado na VM, com o token GHCR SOMENTE em stdin; nunca em argumentos/arquivos.
set -Eeuo pipefail
umask 077
root=${1:?deploy root required}
release_id=${2:?release ID required}
image=${3:?immutable image reference required}
registry_user=${4:?registry user required}
[[ "$root" =~ ^/[a-zA-Z0-9_/-]+$ && "$root" != / && "$root" != *..* ]] || exit 2
[[ "$release_id" =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || exit 2
[[ "$image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || exit 2
[[ "$registry_user" =~ ^[a-zA-Z0-9_-]+(\[bot\])?$ ]] || exit 2
release="$root/releases/$release_id"
shared="$root/shared"
[[ -f "$release/docker-compose.yml" && -f "$shared/app.env" && -f "$shared/compose.env" && -f "$shared/event-sources.json" ]] || {
  echo 'Configure shared/app.env, shared/compose.env e shared/event-sources.json antes do deploy.' >&2
  exit 2
}
# Serialize manual operations as well as GitHub Actions deployments.
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Outro deploy está em andamento.' >&2; exit 2; }
chmod 600 "$shared/app.env" "$shared/compose.env"
mkdir -p "$shared/backups"
chmod 700 "$shared/backups"
[[ ! -e "$shared/backups/$release_id.tgz" ]] || { echo "ID de release já usado em um backup; gere uma nova tentativa." >&2; exit 2; }
export APP_ENV_FILE="$shared/app.env" EVENT_SOURCES_PATH="$shared/event-sources.json"
export DOCKER_CONFIG
DOCKER_CONFIG=$(mktemp -d "$release/.docker.XXXXXX")
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
# Registry access is job-scoped. The config is removed even on a failed deploy.
docker login ghcr.io --username "$registry_user" --password-stdin
compose() {
  APP_IMAGE="$image" docker compose --env-file "$shared/compose.env" \
    --project-name bible-daily-events --file "$release/docker-compose.yml" --profile proxy "$@"
}
# --quiet validates without printing resolved secret environment values.
compose config --quiet
compose pull app caddy
previous=''
if [[ -L "$root/current" ]]; then
  previous=$(readlink -f "$root/current")
  [[ "$previous" == "$root"/releases/* && -f "$previous/image.ref" ]] || { echo 'Release anterior inválida.' >&2; exit 2; }
fi
rollback() {
  local status=$?
  trap - ERR
  set +e
  echo 'Deploy falhou. Tentando reativar a imagem anterior; o banco não será sobrescrito.' >&2
  if [[ -n "$previous" ]]; then
    release=$previous
    image=$(cat "$release/image.ref")
    if compose up -d --no-build --wait --wait-timeout 180 app caddy; then
      echo 'Rollback da aplicação concluído.' >&2
    else
      echo 'Rollback falhou; intervenção necessária. Backups foram preservados.' >&2
    fi
  else
    compose stop app
    echo 'Primeiro deploy sem versão anterior; aplicação interrompida para inspeção.' >&2
  fi
  exit "$status"
}
trap rollback ERR
# SQLite and Baileys must never be written by two releases concurrently.
compose stop app
# Fixed volume name in production: verified against the Compose resolved volume.
volume=$(compose config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["volumes"]["app_data"]["name"])')
if docker volume inspect "$volume" >/dev/null 2>&1; then
  # App is stopped: WAL, DB and WhatsApp session are copied as one consistent archive.
  docker run --rm --network none --user 0:0 --read-only --cap-drop ALL --cap-add DAC_OVERRIDE \
    --security-opt no-new-privileges:true --env "BACKUP_NAME=$release_id.tgz" \
    --mount "type=volume,source=$volume,target=/source,readonly" \
    --mount "type=bind,source=$shared/backups,target=/backup" \
    --entrypoint /bin/sh "$image" -c 'umask 077; tar -czf "/backup/$BACKUP_NAME" -C /source .'
fi
compose up -d --no-build --wait --wait-timeout 180 app caddy
# Verify HTTP semantics inside the container; this does not claim WhatsApp is paired.
compose exec -T app node --input-type=module -e '
  const r=await fetch("http://127.0.0.1:3000/health");
  const body=await r.json(); if(!r.ok||body.status!=="ok")process.exit(1);
  const page=await fetch("http://127.0.0.1:3000/");
  if(!page.ok||!(await page.text()).includes("Palavra Diária"))process.exit(1);
'
printf '%s\n' "$image" > "$release/image.ref"
ln -s "$release" "$root/.current-$release_id"
mv -Tf "$root/.current-$release_id" "$root/current"
trap - ERR
echo "Release $release_id implantada com healthcheck HTTP aprovado."
