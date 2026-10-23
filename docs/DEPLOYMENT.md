# Deploy na Oracle Cloud por SSH

A pipeline está em **um único arquivo**, `.github/workflows/pipeline.yml`. O destino é uma VM Oracle Linux/Ubuntu com Docker; não usa Kubernetes nem exige credenciais da API OCI. O Dockerfile e o Compose também permitem executar a mesma solução localmente.

## Etapas e acionamento

1. Pull request para `main`: instalação pelo lockfile, tipagem, testes, compilação, análise dos scripts, build Docker e smoke test com Compose. Não publica imagem e não acessa a VM.
2. Push em `main` ou execução manual selecionando `main`: repete as validações e publica no GHCR uma imagem `linux/amd64` + `linux/arm64`, com tag `sha-<commit>`.
3. Com `ENABLE_ORACLE_DEPLOY=true`, o job `deploy` usa o environment GitHub `production`, autentica SSH com host conhecido, copia a release e atualiza a VM usando **o digest publicado**, não uma tag mutável.
4. O script remoto puxa as imagens, para o único processo da aplicação, faz backup do volume se ele já existir, inicia os serviços e exige healthcheck e resposta da landing page. Só então atualiza o link `current`.
5. Se a troca falhar, tenta iniciar a imagem anterior e mantém o job com falha. O rollback não substitui banco nem configurações compartilhadas.

A publicação de uma imagem não significa que houve deploy. Sem habilitar a variável, o job de deploy fica **skipped**. A concorrência do workflow e `flock` na VM impedem dois deploys simultâneos; execuções em curso não são canceladas no meio do backup. Existe uma breve indisponibilidade durante backup e troca, necessária para preservar um único escritor SQLite/sessão WhatsApp.

## Secrets e variables do GitHub

Cadastre em Settings → Secrets and variables → Actions. Crie também o environment `production`; restrinja-o a `main`. Se a equipe desejar revisão manual, configure revisores nesse environment; o workflow não exige uma aprovação extra por conta própria.

| Nome | Tipo/local | Uso |
| --- | --- | --- |
| `ORACLE_HOST` | Secret em `production` | IP público IPv4 ou hostname da VM; sem protocolo, caminho ou porta |
| `ORACLE_USER` | Secret em `production` | Usuário Linux, por exemplo `ubuntu` ou `opc` |
| `ORACLE_SSH_PRIVATE_KEY` | Secret em `production` | Chave privada SSH dedicada, formato OpenSSH, sem passphrase para execução automática |
| `ORACLE_SSH_KNOWN_HOSTS` | Secret em `production` | Linha(s) conhecidas do servidor, verificadas por um canal confiável; porta não padrão usa `[host]:porta` |
| `ENABLE_ORACLE_DEPLOY` | **Repository variable** | `true` habilita deploy; ausente ou outro valor mantém somente CI/publicação |
| `ORACLE_SSH_PORT` | Repository/environment variable | Porta SSH; padrão `22` |
| `ORACLE_DEPLOY_PATH` | Repository/environment variable | Diretório absoluto da aplicação; padrão `/opt/bible-daily-events`, sem espaços ou `..` |
| `GITHUB_TOKEN` | Automático do Actions | `packages:write` para publicar e `packages:read` no deploy; não criar PAT adicional |

O job só pode consultar `ENABLE_ORACLE_DEPLOY` no nível de repositório/organização, porque decide iniciar antes de entrar no environment. O token GHCR passa por stdin via SSH, nunca em argumento, é guardado em configuração Docker temporária na VM e apagado ao sair. O material SSH do runner também é removido. O script não usa `StrictHostKeyChecking=no` nem obtém confiança automaticamente com `ssh-keyscan` durante o deploy. Se usar `ssh-keyscan` na preparação, confira sua fingerprint com o console/administrador da VM antes de cadastrar o resultado.

O pacote GHCR herda as permissões do repositório quando criado pela pipeline. Se já existir, permita acesso de leitura/escrita a este repositório nas configurações do pacote. Políticas da organização podem exigir habilitar publicação de packages. A imagem incorpora código, dependências de produção e arquivos públicos; não contém `.env`, banco, sessão WhatsApp ou chaves SSH.

## Preparação inicial da VM

Recomendação: Ubuntu 24.04 ou Oracle Linux compatível, arquitetura x86_64 ou aarch64, espaço para imagens/backups e acesso HTTPS de saída. Instale Docker Engine e o plugin **Docker Compose >= 2.30** pelo procedimento oficial da distribuição. `format: raw` no env_file exige essa versão. Tenha `bash`, `python3`, `flock` (util-linux), `tar` e ferramentas SSH disponíveis. O usuário de deploy precisa executar Docker sem prompt de sudo. Pertencer ao grupo Docker equivale a acesso administrativo: use uma conta dedicada e chave restrita ao ambiente.

No console OCI, configure subnet pública/IP, Security List ou NSG e o firewall do sistema para TCP 80/443. Permita a porta SSH aos runners autorizados (runner próprio ou allowlist de saída controlada, quando necessário). Não exponha TCP 3000. Aponte o DNS do domínio para a VM. O Caddy obtém o certificado por ACME; DNS incorreto ou portas bloqueadas impedem a emissão. Não deixe um registro AAAA apontando para um destino IPv6 indisponível.

Conectado como o usuário de deploy:

```bash
sudo install -d -m 700 -o "$USER" -g "$(id -gn)" \
  /opt/bible-daily-events /opt/bible-daily-events/releases \
  /opt/bible-daily-events/shared /opt/bible-daily-events/shared/backups
```

Antes do primeiro deploy, instale os três arquivos abaixo no diretório `shared`, usando os exemplos do repositório como base e preenchendo-os pelo canal seguro de administração. Não sobrescreva arquivos existentes sem revisar suas configurações.

| Arquivo na VM | Exemplo no repositório | Permissão |
| --- | --- | --- |
| `shared/app.env` | `deploy/app.env.example` | `600`, proprietário usuário de deploy |
| `shared/compose.env` | `deploy/compose.env.example` | `600`, proprietário usuário de deploy |
| `shared/event-sources.json` | `docs/event-sources.example.json` (`[]`) | `644` ou legível por UID 1000 do contêiner |

`shared` fica com `700`, restringindo acesso externo. O arquivo JSON precisa ser legível pelo usuário `node` (UID 1000), pois é montado read-only dentro do contêiner. App e Compose env são lidos pelo Docker, não precisam ser legíveis diretamente pelo usuário do contêiner.

A estrutura resultante é:

```text
/opt/bible-daily-events/
├── current -> releases/<commit>-<run>-<attempt>
├── deploy.lock
├── releases/
│   └── <commit>-<run>-<attempt>/
│       ├── docker-compose.yml
│       ├── image.ref
│       └── deploy/{Caddyfile,remote-deploy.sh}
└── shared/
    ├── app.env
    ├── compose.env
    ├── event-sources.json
    └── backups/<release>.tgz
```

## Todas as variáveis da solução

### Interpolação do Docker Compose (`shared/compose.env`)

| Variável | Valor/padrão | Observação |
| --- | --- | --- |
| `APP_DOMAIN` | domínio público, sem `https://` | Obrigatório para HTTPS público; default local `localhost` |
| `ACME_EMAIL` | e-mail do operador | Usado pelo Caddy/ACME |
| `TRUST_PROXY` | `1` em produção; `0` direto | Confia em um único proxy. Seguro porque somente o Caddy está exposto e ele sobrescreve os cabeçalhos |
| `DATA_VOLUME_NAME` | `bible-daily-events-data` | Não mudar durante atualização: outro nome cria um volume vazio |
| `APP_IMAGE` | digest GHCR definido pelo deploy | Localmente: `bible-daily-events:local` |
| `APP_ENV_FILE` | caminho absoluto definido pelo deploy | Localmente: `./deploy/app.env` |
| `EVENT_SOURCES_PATH` | caminho absoluto definido pelo deploy | Localmente: `./docs/event-sources.example.json` |

### Aplicação (`shared/app.env`)

O Compose usa `env_file` com formato **raw**: valores de uma linha, sem aspas; `$`, `#` e espaços são preservados. Não use `source app.env` nem execute esse arquivo como shell. Os valores confidenciais ficam somente na VM; não são GitHub Variables, build args nem parte da imagem.

| Variável | Padrão/exemplo | Uso |
| --- | --- | --- |
| `TZ` | `America/Sao_Paulo` | Fuso dos jobs e eventos |
| `PUBLIC_URL` | `https://fe.seudominio.com.br` | Origem pública dos webhooks |
| `PAYMENT_RETURN_URL` | URL HTTPS de retorno | URL real existente no seu site após checkout; o caminho `/obrigado` do exemplo deve ser criado/configurado pelo operador |
| `WHATSAPP_ENABLED` | `false` | Habilitar após preparar conta, grupos e pareamento |
| `WHATSAPP_BOT_PHONE` | dígitos E.164, sem `+` | Número do bot |
| `WHATSAPP_GROUP_IDS` | IDs separados por vírgulas | Apenas grupos administrados com aprovação de entrada |
| `DAILY_CRON` | `0 6 * * *` | Versículo diário |
| `EXPIRATION_CRON` | `*/10 * * * *` | Manutenção adicional à fila de 30 s |
| `MERCADOPAGO_ACCESS_TOKEN` | segredo real | Token Mercado Pago para a API |
| `MERCADOPAGO_WEBHOOK_SECRET` | segredo real | HMAC local; não pode ser placeholder de proxy |
| `PAGSEGURO_TOKEN` | segredo real | API e validação local de assinatura SHA-256 |
| `PAGSEGURO_SANDBOX` | `true` | Mantenha sandbox durante homologação |
| `PAGSEGURO_ALLOW_ONE_TIME_FALLBACK` | `false` | Opt-in para um mês avulso; não é recorrência PagBank |
| `SPIRITUAL_AI_API_KEY` | segredo real | Credencial OpenAI |
| `OPENAI_API_KEY` | alias opcional | Só é usado se `SPIRITUAL_AI_API_KEY` não estiver preenchido |
| `OPENAI_MODEL` | `gpt-4o-mini` | Modelo de orientação |
| `GEOCODING_CONTACT` | vazio | E-mail identificador; vazio desabilita Nominatim |
| `EVENT_RADIUS_KM` | `20` | Raio de busca; máximo 100 |
| `SESSION_TTL_MINUTES` | `30` | Duração da sessão privada |
| `HISTORY_RETENTION_DAYS` | `7` | Retenção local; entre 1 e 30 |

O Compose fixa `NODE_ENV=production`, `PORT=3000`, `DATA_DIR=/app/data`, `EVENT_SOURCES_FILE=/app/config/event-sources.json` e `TRUST_PROXY` a partir da configuração do proxy. Não tente sobrescrever essas variáveis em `app.env`. Fora do Docker, continuam válidos os defaults de `.env.example`. `NODE_IMAGE` e `NODE_BUILD_IMAGE` são argumentos opcionais de build do Dockerfile; a pipeline usa o default oficial Node 24, e as releases são fixadas pelo digest final publicado.

## Primeira publicação, operação e rollback

1. Cadastre os secrets/variables e os arquivos `shared` da VM. Deixe `WHATSAPP_ENABLED=false` para o primeiro smoke test.
2. Habilite `ENABLE_ORACLE_DEPLOY=true` no repositório e execute o workflow em `main`.
3. Confira no Actions o digest publicado e o resultado do deploy. Valide externamente `https://<domínio>/health` e a landing page, inclusive o certificado; o smoke remoto interno não verifica DNS/ACME nem serviços externos.
4. Habilite as integrações gradualmente e recrie o contêiner após alterar `app.env`. A autenticação do WhatsApp exige pareamento no terminal privado da VM: use os logs do serviço localmente; não copie QR/sessão para logs públicos do Actions. `/health` deve informar `connected`, e um usuário de teste deve concluir a jornada.

Comandos operacionais na VM, sem exibir variáveis resolvidas ou segredos:

```bash
cd /opt/bible-daily-events/current
export APP_IMAGE="$(cat image.ref)"
export APP_ENV_FILE=/opt/bible-daily-events/shared/app.env
export EVENT_SOURCES_PATH=/opt/bible-daily-events/shared/event-sources.json
docker compose --env-file /opt/bible-daily-events/shared/compose.env --profile proxy ps
# Use o caminho absoluto para evitar depender de como o shell resolve o symlink current:
docker compose --env-file /opt/bible-daily-events/shared/compose.env --profile proxy \
  up -d --no-build --wait --wait-timeout 180 app caddy
```

Não execute `docker compose config` sem `--quiet` em logs: ele pode expandir segredos. Não use `down --volumes` em produção. A aplicação usa volume nomeado com UID 1000; backups preservam SQLite/WAL e sessão WhatsApp, e são gerados com a aplicação parada. Os arquivos de backup podem pertencer a root e conter credenciais; use `sudo` para administração. Defina retenção, criptografia e cópia externa conforme a operação, pois o deploy preserva backups/releases sem apagá-los automaticamente. Volume local não protege contra perda da VM.

Para rollback manual, registre o digest de uma release anterior, confira compatibilidade do esquema e use `docker compose` a partir daquela release com seu `image.ref`, mantendo os mesmos caminhos `shared` e volume. Pare o app antes da troca e execute `up --wait`; só atualize `current` depois do sucesso. O rollback automático faz isso em falhas durante a atualização. Não há restauração automática de banco/variáveis: ela poderia apagar pagamentos recebidos depois do backup. Migrações futuras devem ser compatíveis com a versão anterior ou exigir procedimento próprio de restauração.

## Limites da validação

O pipeline valida HTTP e persistência, mas não afirma que o WhatsApp está pareado ou que pagamentos reais funcionam. Faltam credenciais e VM para executar SSH/ACME neste ambiente. Homologação externa, recurring PagBank, chargeback e demais limitações funcionais continuam descritos no README. Consulte [TESTING.md](TESTING.md) e [ARCHITECTURE.md](ARCHITECTURE.md).
