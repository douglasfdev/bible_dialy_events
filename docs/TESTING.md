# Como testamos a aplicação

A validação é dividida em regras de negócio, HTTP, contêiner/persistência e homologação externa. Os testes automatizados usam dublês explícitos de WhatsApp e provedores; não enviam mensagens nem criam pagamentos reais. Um serviço HTTP saudável não demonstra que as integrações estão disponíveis.

## 1. Reproduzir as verificações locais

Pré-requisitos: Node.js 24 e npm; Docker Engine/Compose >=2.30 para contêineres. O lockfile inclui uma dependência pública Git via SSH; em máquinas sem chave GitHub, configure o transporte HTTPS antes da instalação:

```bash
git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run build
```

`npm run check` executa tipagem, testes e build em sequência e preserva falhas. Não usa credenciais. O workflow roda os comandos em etapas separadas para identificar onde ocorreu a falha. Uma suíte vazia não é um resultado de aprovação desta aplicação.

| Arquivo | Evidência exigida |
| --- | --- |
| `tests/deployment.test.ts` | Shell remoto real com Docker controlado: backup antes da troca, avanço de release só após saúde, rollback com falha preservada, limpeza do token e configuração obrigatória antes de parar o app |
| `tests/payments.test.ts` | Fallback antes de cobrança, coalescência de chamadas concorrentes, checkout reutilizado, timeout pendente após reinício, titularidade da assinatura, eventos duplicados, valores/moeda canônicos, HMAC Mercado Pago, assinatura PagBank, cancelamento e expiração |
| `tests/bot.test.ts` | Respostas só em DM, exclusão no grupo quando permitida, bloqueio para não assinantes, localização apenas em sessão pendente, exclusão de histórico, limites e delays de 2–5 s, disparo só para grupo/admin e remoção após reconexão |
| `tests/http.test.ts` | Lead e consentimento, validação de entrada, recusa com bot desconectado, webhook persistido antes de 204 e rate limiting por IP atrás de um proxy |
| `tests/scraper.test.ts` | JSON-LD/graph, eventos válidos e expirados, coordenadas inválidas, Haversine, raio/dia local e endereço com geocodificação fornecida |

O teste `failed daily send...` imprime intencionalmente a mensagem de falha de envio para conferir que um resultado incerto não provoca reenvio automático; esse log acompanhado de teste aprovado é esperado. A aprovação global exige exit code zero, contagem de testes e ausência de testes falhos, skipped ou cancelados.

## 2. Validar pipeline e scripts

```bash
bash -n deploy/remote-deploy.sh scripts/container-smoke.sh
shellcheck deploy/remote-deploy.sh scripts/container-smoke.sh
# Opcional local; também valida referências e sintaxe do workflow:
actionlint .github/workflows/pipeline.yml
```

A pipeline chama Bash e ShellCheck. As actions usadas estão fixadas em commits; atualizações devem revisar os hashes oficiais e executar novamente a validação. `pull_request` usa ambiente sem secrets de produção e não pode publicar/deployar; a publicação/deploy somente acontece em `main` e a ativação do SSH exige a variável documentada em [DEPLOYMENT.md](DEPLOYMENT.md).

## 3. Testar a imagem e o Compose

```bash
docker build -t bible-daily-events:local .
APP_IMAGE=bible-daily-events:local bash scripts/container-smoke.sh
```

O script não exige criar arquivos de credenciais locais. Ele usa `deploy/app.env.example` num diretório temporário, um projeto Compose separado, porta loopback aleatória e um volume de teste com nome próprio. Remove somente os seus recursos ao terminar.

Verifica:

O script também executa `caddy validate` com domínio/e-mail de teste, sem emitir certificado ou abrir portas públicas.

1. O contêiner com usuário não root e filesystem read-only fica saudável.
2. `GET /health` retorna 200, `status=ok` e `whatsapp=disabled` na configuração sem credenciais.
3. A landing retorna 200 e seu conteúdo esperado.
4. `POST /api/lead` válido retorna 503 quando o bot não está configurado/conectado.
5. Webhook Mercado Pago sem configuração retorna 503 e não ativa usuário.
6. Um marcador gravado no volume permanece depois de recriar o contêiner.
7. O SQLite persistido passa em `PRAGMA integrity_check` após a recriação.
8. Com o app parado, o volume é arquivado e restaurado em diretório temporário isolado; marcador e integridade SQLite são conferidos novamente.

Em ambientes de nuvem com proxy obrigatório, o build pode precisar de `--build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY` (variáveis já exportadas) e da rede apropriada ao builder. Para um proxy com CA própria, o Dockerfile aceita `--secret id=build_ca,src=/caminho/do/bundle-CA-confiavel.pem`: o certificado é montado só durante a instalação/prune e não é copiado para a imagem. Se o hostname interno do proxy não resolver no builder, forneça o mapeamento de host autorizado pelo administrador. Não coloque credenciais de proxy no Dockerfile nem desabilite TLS. Falhas de DNS/proxy impedem a validação da imagem e precisam ser distinguidas de falhas da aplicação.

## 4. Validar um deploy na VM de homologação

Antes de habilitar o deploy real, use uma VM e um domínio de homologação com dados próprios. Prepare `shared` e os secrets como documentado; mantenha `WHATSAPP_ENABLED=false`, tokens vazios e PagBank em sandbox no primeiro teste. Publique por execução do workflow em `main`.

Critérios de aprovação:

- Todas as etapas anteriores do Actions passaram e o digest consta no resumo da execução.
- `current/image.ref` corresponde ao digest entregue, e `docker compose ps` mostra app saudável.
- O domínio público apresenta certificado válido e landing/health respondem por HTTPS, sem expor porta 3000.
- Uma segunda execução recria a release preservando volume e `whatsapp-auth`, com backup antes da troca.
- Uma atualização com falha de inicialização em **homologação** deixa o job vermelho e a release anterior volta a responder. Pode-se testar essa falha temporariamente com uma configuração de cron inválida na VM de teste; depois restaure a configuração compartilhada. Como o env é compartilhado, o rollback de imagem só recupera o serviço se a configuração ainda for válida para a versão anterior.
- Teste também falha de SSH/host key e ausência de arquivos `shared`: devem interromper o deploy sem parar o app atual, pois acontecem antes da troca.

Não provoque falhas de rollback no ambiente de produção nem apague volumes para testar persistência. Um backup não garante restauração: confira um arquivo `.tgz` e valide a recuperação numa VM/volume separados antes de depender dele.

## 5. Homologação das integrações — execução manual, pendente

| Cenário | Como verificar | Resultado esperado |
| --- | --- | --- |
| WhatsApp | Parear em terminal privado, bot admin e aprovação de entrada habilitada | `/health` informa `connected`; não publicar QR/logs da sessão |
| Lead | Preencher landing com número do usuário de teste e enviar `!iniciar` | O bot confere titularidade e envia um checkout somente no privado |
| Mercado Pago | Cartão de teste e eventos reais do sandbox/conta de testes habilitada | Apenas cobrança aprovada por BRL 5,99 ativa e envia convite |
| Duplicidade | Reentrega autenticada pelo próprio provedor | Sem segundo período nem segunda cobrança |
| Cancelamento/expiração | Cancelar no provedor e aguardar fim do período de teste controlado | Acesso pago é preservado até vencer; depois o bot remove o usuário |
| PagBank | Habilitar opt-in do fallback avulso em sandbox e simular indisponibilidade **antes** da cobrança primária | Checkout de um mês, termos de renovação manual e ativação após evento assinado |
| Orientação | Enviar `!meoriente` no grupo com conta de teste | Resposta só na DM; sem exposição de histórico no grupo |
| Cultos | Configurar agenda real revisada e enviar localização nativa na DM solicitada | Eventos do dia, raio correto e fonte, sem persistir coordenadas do cliente |
| Versículo | Ajustar cron em homologação para um horário próximo | Um envio no grupo admin; nenhum disparo individual em massa |

Não simule assinatura financeira com payload fabricado contra produção. Webhooks reais precisam do segredo correto e consulta canônica bem-sucedida. O fallback PagBank atual não é recorrente; não existe um teste aprovado de recorrência PagBank nesta versão.

## Estado das evidências

Validação local de referência desta implementação (23/10/2026):

| Verificação | Resultado |
| --- | --- |
| `npm run check` | 30 testes passaram; 0 falhos, cancelados ou skipped; tipagem e compilação aprovadas |
| `actionlint`, `bash -n`, ShellCheck | Aprovados para o workflow e scripts |
| Dockerfile, arquitetura amd64 | Imagem compilada com a CA confiável do proxy fornecida por secret de build; TLS permaneceu ativo |
| Smoke Docker Compose | Caddy válido, HTTP aprovado, persistência após recriação, usuário não root, backup/restauração e integridade SQLite aprovados |
| Imagem final | Configuração com usuário `node`, sem variáveis de proxy/CA do builder |
| Execução ARM | Configurada na publicação multiarch; não executada localmente |
| Deploy SSH/Oracle e DNS/ACME público | Não executados: dependem da VM, secrets e ativação |
| WhatsApp, provedores e agendas reais | Homologação manual pendente de credenciais/fontes |

Os resultados acima correspondem à validação local, não à execução hospedada no GitHub. Consulte o histórico do Actions após publicar e habilitar a pipeline para evidência do CI/deploy reais.
