# Fluxo de entrega e execução

A aplicação é entregue em uma única imagem Docker, com um único processo para Express, bot, tarefas agendadas e filas. O Caddy é o segundo serviço do Compose, responsável por TLS e encaminhamento HTTP. O banco e a sessão WhatsApp permanecem no volume durante trocas da imagem.

## Pipeline

```mermaid
flowchart TD
    A[Pull request ou push main ou execução manual] --> B[Node 24: npm ci]
    B --> C[Validar tipagem]
    C --> D[Testes automatizados]
    D --> E[Compilar TypeScript e analisar scripts]
    E --> F[Build Docker nativo]
    F --> G[Smoke com Compose: HTTP e persistência]
    G --> H{main e evento de publicação?}
    H -->|Não: pull request| I[Fim da validação]
    H -->|Sim| J[Build amd64 e arm64]
    J --> K[Publicar GHCR com tag SHA e digest]
    K --> ENV[Entrar no environment production]
    ENV --> L{Secret ou variable ENABLE_ORACLE_DEPLOY=true?}
    L -->|Não| M[SSH skipped com motivo no resumo]
    L -->|Sim| N[SSH com chave e host conhecido]
    N --> O[Upload Compose, Caddyfile e script]
    O --> P[Lock, login temporário GHCR e pull por digest]
    P --> Q[Parar app e fazer backup do volume]
    Q --> R[Recriar serviços e aguardar healthcheck]
    R --> S{HTTP e landing aprovados?}
    S -->|Sim| T[Atualizar current para a release]
    S -->|Não| U[Tentar imagem anterior e falhar job]
```

Pull requests não recebem secrets de produção, não publicam imagens e não fazem deploy. A etapa `validate` precisa passar para `image`; `deploy` depende de `image`. A imagem nativa é executada no CI; as duas arquiteturas são publicadas, mas a execução ARM deve ser homologada em uma VM ARM. Não há deploy concorrente nem atualização de código por `git pull` na VM.

## Aplicação na Oracle

```mermaid
flowchart LR
    USER[Usuário / Navegador] -->|HTTPS 443| CADDY[Caddy: certificado ACME]
    MP[Mercado Pago] -->|Webhook HTTPS autenticado| CADDY
    PAG[PagBank] -->|Webhook HTTPS autenticado| CADDY
    CADDY -->|Rede interna: 3000| APP[App Node 24 / Express]
    APP --> DB[(Volume: SQLite e WAL)]
    APP --> AUTH[(Mesmo volume: sessão WhatsApp)]
    APP --> BOT[Baileys: DMs e grupos]
    BOT --> WA[WhatsApp]
    APP --> AI[OpenAI: orientação privada]
    APP --> SCRAPER[Scraper e geocodificação opcional]
    SCRAPER --> SITES[Agendas revisadas / Nominatim]
    APP --> JOBS[Cron e fila persistente]
    JOBS --> BOT
    VMENV[shared/app.env e compose.env] -.-> APP
    GHA[GitHub Actions] -->|SSH verificado| VM[VM Oracle: Docker Compose]
    GHCR[GHCR: imagem por digest] --> VM
    VM --> APP
    VM --> CADDY
```

Somente 80/443 são publicados pelo Compose; 80 atende redirecionamento/ACME. O Express confia em um proxy quando `TRUST_PROXY=1`, e o Caddy sobrescreve os cabeçalhos de origem. O host SSH é acessado pela porta configurada fora do Compose. Credenciais financeiras e da IA ficam em `shared/app.env`, nunca na imagem. O GitHub precisa apenas dos dados de conexão SSH; o token de leitura do registry dura o job.

O healthcheck confirma que o processo HTTP responde, não a disponibilidade das integrações. A confirmação de pagamento é persistida antes da resposta HTTP, e convites/remoções aguardam o bot estar conectado. O rollback troca a imagem/Compose e preserva o estado; uma eventual reversão de dados exige revisão separada.
