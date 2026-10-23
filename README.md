# Palavra Diária

Base SaaS em TypeScript para apoio espiritual via WhatsApp, criada neste repositório a partir da especificação. Node.js 24, Express 5, SQLite persistente, Baileys, OpenAI, axios/cheerio e node-cron. Preço: R$ 5,99.

## Executar

```bash
cd /workspace/bible_dialy_events
npm_config_cache=/workspace/.npm npm ci --no-audit --no-fund
npm run check
npm start
```

O servidor usa a porta 3000 por padrão. `GET /health` informa o estado HTTP e a conexão do bot. Sem credenciais, a landing page e o servidor funcionam; inscrições retornam 503 até o WhatsApp estar conectado. Nenhum pagamento ou envio externo é simulado em produção. Os dublês existem somente nos testes.

Para desenvolvimento com recarga: `npm run dev`. Para configurações locais, copie `.env.example` para `.env` **apenas se `.env` ainda não existir** e preencha os campos necessários. Nunca versione `.env`, `data/` ou a sessão do WhatsApp.

## Módulos

| Arquivo | Responsabilidade |
| --- | --- |
| `src/domain/payment/PaymentStrategy.ts` | Interface dos gateways, Mercado Pago, PagBank, fallback, conciliação de webhooks e idempotência |
| `src/bot/handlers/OrientationsHandler.ts` | `!meoriente`, sessões privadas, histórico, `!esquecer` e localização |
| `src/scraper/ChurchEventsScraper.ts` | Agendas JSON-LD, cache, busca de eventos do dia e Haversine |
| `src/scraper/Geocoder.ts` | Geocodificação opcional Nominatim, cache de 30 dias e intervalo mínimo de 1,1 s |
| `src/jobs/DailyVerseBroadcaster.ts` | Versículos às 06h no fuso configurado, exclusivamente em grupos administrados |
| `src/jobs/SubscriptionJobs.ts` | Expiração, fila persistente de convites/remoções e retenção do histórico |
| `src/bot/BaileysTransport.ts` | Conexão, QR, reconexão, administração e aprovação de entrada |
| `src/server.ts` | Composição dos módulos, inicialização e desligamento |
| `src/http/app.ts` | Landing page, leads, saúde, webhooks, limites e validação |
| `src/infrastructure/Store.ts` | SQLite, transações, assinaturas, sessões e filas |

## Jornada

1. A landing page coleta nome, WhatsApp, e-mail exigido pelo pagamento e consentimento.
2. `POST /api/lead` retorna um link `wa.me` com `!iniciar <UUID>`. A criação do cadastro não gera cobrança.
3. O bot confere se o remetente corresponde ao número cadastrado e então entrega o checkout no privado.
4. O webhook autenticado consulta o estado canônico no provedor. Somente um pagamento aprovado de BRL 5,99 libera um mês de acesso.
5. A fila persistente envia o convite. O grupo deve exigir aprovação: o bot só aprova números com período pago vigente.
6. `!meoriente <mensagem>` no grupo tenta excluir a mensagem original e responde exclusivamente na DM. A exclusão não impede que outros já tenham lido a mensagem. No privado, uma sessão dura 30 minutos por padrão.
7. Para cultos, solicita localização nativa no privado e lista eventos de hoje no raio configurado. Coordenadas do cliente não são gravadas no histórico ou enviadas à OpenAI.
8. Pagamentos duplicados não estendem o período; cancelamento interrompe renovação e preserva o acesso já pago. A expiração agenda a remoção de todos os grupos configurados.

## Configurar WhatsApp e serviços

- Defina `WHATSAPP_ENABLED=true`, `WHATSAPP_BOT_PHONE` sem `+` e `WHATSAPP_GROUP_IDS` separados por vírgulas. Inicie o servidor e pareie pelo QR exibido somente no terminal privado.
- Torne o bot administrador e habilite aprovação de novos participantes em cada grupo. A emissão de convites falha sem essa aprovação, pois um link compartilhado não controla sozinho o acesso pago.
- Baileys é uma integração não oficial; limites e delays não garantem ausência de bloqueios. Esta implementação envia versículos **somente a grupos**, nunca a DMs. Canais e comunidades como entidades próprias ainda não possuem adaptador.
- Identificadores LID não são tratados como números. Mensagens e solicitações sem identidade telefônica verificável são recusadas; compatibilidade de LIDs deve ser homologada na conta real.
- `MERCADOPAGO_ACCESS_TOKEN`: token com permissão de assinaturas. `MERCADOPAGO_WEBHOOK_SECRET`: segredo real para HMAC local, não um placeholder de proxy. Configure notificações dos tipos `subscription_preapproval` e `subscription_authorized_payment` para `/webhooks/mercadopago`, com os parâmetros assinados e cabeçalhos fornecidos pelo provedor.
- `PUBLIC_URL` e `PAYMENT_RETURN_URL`: endereços HTTPS públicos reais para notificações e retorno. A porta local de desenvolvimento não recebe webhooks da Internet por si só.
- `SPIRITUAL_AI_API_KEY` (ou `OPENAI_API_KEY` local) e `OPENAI_MODEL=gpt-4o-mini`: habilitam orientação por IA. A chave alternativa permite um nome sem prefixo reservado em configurações de proxy.
- `PAGSEGURO_TOKEN`: token **real acessível ao processo**, também usado para verificar SHA-256 de `token-corpo_bruto`. Um placeholder de proxy não permite verificar essa assinatura localmente. `PAGSEGURO_SANDBOX=true` usa sandbox.
- Mantenha um único processo da aplicação por banco/conta de WhatsApp. Replicação exige coordenação de sessão, fila e cron externa.

Nenhuma credencial foi encontrada ou criada durante a implementação. Não envie segredos pelo chat. Configure-os no mecanismo seguro de execução ou em `.env` protegido fora do versionamento; confira como o mecanismo fornece valores reais versus placeholders antes de habilitar verificação local de webhooks.

## Pagamentos: escopo e diferenças importantes

**Mercado Pago:** checkout de assinatura mensal no cartão via `/preapproval`. Criar ou autorizar uma assinatura não ativa acesso: a aplicação aguarda uma cobrança de assinatura aprovada, consulta `/authorized_payments`, `/preapproval` e `/v1/payments` e verifica valor/moeda. Não há armazenamento de cartões.

**PagBank/PagSeguro:** o adaptador implementa checkout hospedado `/checkouts` de **um mês avulso**, Pix ou cartão, com renovação manual. Só habilite conscientemente com `PAGSEGURO_ALLOW_ONE_TIME_FALLBACK=true`. Esse recurso **não implementa assinatura recorrente PagBank** e fica desligado por padrão. Recorrência real nesse provedor exige um módulo adicional usando o produto de pagamentos recorrentes habilitado na conta e seu fluxo de tokenização/homologação. Não apresentamos Pix avulso como recorrente.

O fallback acontece quando o primário não está configurado ou quando a sondagem de disponibilidade falha **antes** de enviar a criação financeira. Erros de autenticação/validação não trocam de provedor. Timeout, erro 5xx ou resposta inválida **após** a criação deixam uma tentativa pendente: o provedor pode ter aceitado a cobrança mesmo sem resposta. A aplicação devolve `PAYMENT_RECONCILIATION_REQUIRED` em novas tentativas e não faz cobrança duplicada em outro gateway.

Para conciliar uma tentativa pendente, investigue o cliente (`external_reference`/`reference_id` = UUID do usuário) no painel do provedor. Vincule a cobrança/checkout confirmado com uma ferramenta administrativa revisada ou, **somente após confirmar ausência/cancelamento no provedor**, libere a tentativa pendente. Não apague registros automaticamente nem repita POSTs financeiros para resolver um timeout. Não há interface administrativa de conciliação nesta base.

Os contratos HTTP foram testados com respostas controladas; Pix, cartão, renovação e assinaturas dos provedores **não foram homologados em sandbox/produção**, pois faltam credenciais e configuração externa. O portal de documentação PagBank respondeu bloqueio de rede neste ambiente; confira especialmente a representação canônica de pedidos no checkout e os eventos habilitados na sua conta antes da homologação. Eventos de reembolso/chargeback e cancelamento pelo próprio aplicativo ainda precisam de fluxos específicos; o cancelamento atual é feito no provedor e refletido por webhook Mercado Pago.

## Agendas de igrejas

Defina `EVENT_SOURCES_FILE` para um JSON com fontes públicas previamente revisadas:

```json
[
  {"url":"https://agenda.sua-igreja.example/agenda", "allowedHost":"agenda.sua-igreja.example"}
]
```

O domínio acima é ilustrativo: nenhuma agenda real foi inventada ou pré-carregada. Cada fonte precisa publicar JSON-LD `Event` com `startDate` ISO contendo fuso e `location.address`, além de `location.geo.latitude/longitude` ou geocodificação habilitada. Também são aceitos arrays e `@graph`. Eventos sem fim têm duração presumida de duas horas. Eventos explicitamente cancelados são descartados. Sites com outra estrutura precisam de adaptadores de extração específicos; horários semanais sem datas não são inferidos.

`GEOCODING_CONTACT` com e-mail do operador habilita Nominatim para **endereços públicos de igrejas** sem coordenadas. O resultado deve ser conferido pelo operador. Respeite a política do serviço, termos e regras de coleta de cada fonte. Atualização horária e sob demanda com cache de uma hora. Falhas preservam eventos ainda válidos, mas uma falha em todas as fontes impede uma busca nova de afirmar que não existem cultos.

Destinos de rede utilizados: `registry.npmjs.org`, GitHub e hosts de artefatos das dependências; `api.mercadopago.com`, `api.pagseguro.com`, `sandbox.api.pagseguro.com`, `api.openai.com` e, se habilitado, `nominatim.openstreetmap.org`. Acrescente somente os domínios das agendas configuradas à allowlist. Não há acesso arbitrário a URLs enviadas por usuários.

## Persistência, operação e validação

- `data/app.sqlite` contém cadastros, pagamentos recebidos, filas e histórico. `data/whatsapp-auth/` contém credenciais da sessão. Proteja e faça backup consistente destes arquivos, incluindo o estado WAL quando necessário.
- Agendamentos usam `America/Sao_Paulo`; altere `TZ` e os crons se necessário. A fila é processada a cada 30 segundos; expiração e limpeza são executadas junto dela, além do cron de manutenção configurado.
- O histórico retém no máximo 16 mensagens por pessoa e é limpo após `HISTORY_RETENTION_DAYS` (padrão 7). `!esquecer` apaga mensagens e sessão local. O conteúdo da conversa não é escrito nos logs.
- Convites/remoções falhos ficam na fila. Uma falha após envio e antes da confirmação local pode repetir uma mensagem transacional; disparos diários de resultado incerto ficam marcados para revisão e não são repetidos automaticamente.
- Os testes usam provedores/WhatsApp controlados, banco em memória e requisições HTTP locais. Cobrem privacidade, pagamento duplicado, assinatura de webhook, conciliação de valores, timeout, expiração, delay, limite de mensagens, eventos e distância.

```bash
npm run typecheck
npm test
npm run build
npm_config_cache=/workspace/.npm npm audit --omit=dev --audit-level=high
```

Antes de abrir inscrições reais: homologar os provedores e o número WhatsApp, cadastrar fontes verificadas, validar a remoção/aprovação no grupo real e completar a identificação do responsável/canal de atendimento no aviso de privacidade. O trabalho entregue é uma base funcional de desenvolvimento; integrações externas e operação comercial não estão declaradas prontas.
