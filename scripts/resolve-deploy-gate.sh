#!/usr/bin/env bash
# Run inside the production environment, after GitHub has injected its secrets/vars.
set -euo pipefail
value=${DEPLOY_ENABLED:-false}
value=${value//[[:space:]]/}
case "${value,,}" in
  true)
    echo 'deploy=enabled' >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT required}"
    echo 'Deploy Oracle ativado; a conexão SSH será validada.'
    echo '### Oracle: deploy ativado pelo environment' >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY required}"
    ;;
  false|'')
    echo 'deploy=disabled' >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT required}"
    echo '::notice::Deploy Oracle desabilitado. Configure ENABLE_ORACLE_DEPLOY=true como secret ou variable no environment production.'
    echo '### Oracle: SSH não executado — ENABLE_ORACLE_DEPLOY está desabilitado ou ausente' >> "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY required}"
    ;;
  *)
    echo '::error::ENABLE_ORACLE_DEPLOY precisa conter true ou false, sem aspas. Confira o secret/variable do environment production.' >&2
    exit 2
    ;;
esac
