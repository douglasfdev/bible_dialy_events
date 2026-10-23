import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import cron from 'node-cron';
import { config } from './config.js';
import { Store } from './infrastructure/Store.js';
import { safeFailure } from './infrastructure/http.js';
import { isEntitled } from './domain/models.js';
import { MercadoPagoGateway, PagSeguroGateway, PaymentService } from './domain/payment/PaymentStrategy.js';
import { BaileysTransport } from './bot/BaileysTransport.js';
import { SafeMessenger } from './bot/SafeMessenger.js';
import { OpenAIAdvisor } from './bot/SpiritualAdvisor.js';
import { OrientationsHandler } from './bot/handlers/OrientationsHandler.js';
import { ChurchEventsScraper } from './scraper/ChurchEventsScraper.js';
import { NominatimGeocoder } from './scraper/Geocoder.js';
import { DailyVerseBroadcaster } from './jobs/DailyVerseBroadcaster.js';
import { SubscriptionJobs } from './jobs/SubscriptionJobs.js';
import { createApp } from './http/app.js';
const dir=resolve(config.DATA_DIR); mkdirSync(dir,{recursive:true,mode:0o700});
const store=new Store(resolve(dir,'app.sqlite'));
const primary=new MercadoPagoGateway(config),fallback=new PagSeguroGateway(config);
fallback.lookupCheckout=id=>{
  const user=store.userById(id);
  if(user?.provider !== 'pagseguro' || !user.subscription_id) throw new Error('Checkout não encontrado');
  return user.subscription_id;
};
const payments=new PaymentService(primary,fallback,store);
const transport=new BaileysTransport(resolve(dir,'whatsapp-auth'),config.WHATSAPP_GROUP_IDS);
const messenger=new SafeMessenger(transport);
const scraper=new ChurchEventsScraper(store,await ChurchEventsScraper.loadSources(config.EVENT_SOURCES_FILE),config.GEOCODING_CONTACT ? new NominatimGeocoder(store,config.GEOCODING_CONTACT) : undefined);
const advisor=new OpenAIAdvisor(config.OPENAI_API_KEY,config.OPENAI_MODEL);
const orientations=new OrientationsHandler(store,transport,messenger,advisor,scraper,config);
const subscriptions=new SubscriptionJobs(store,transport,messenger,config);
store.db.exec('CREATE TABLE IF NOT EXISTS incoming_messages(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL)');
transport.onJoinRequest=async(_group,participant)=>{
  if(!participant.endsWith('@s.whatsapp.net')) return false;
  return isEntitled(store.userByPhone(participant.split('@')[0]!));
};
transport.onMessage=async message=>{
  store.db.prepare('DELETE FROM incoming_messages WHERE created_at<?').run(Date.now()-86400000);
  if(!store.db.prepare('INSERT OR IGNORE INTO incoming_messages VALUES(?,?)').run(`${message.chatId}:${message.id}`,Date.now()).changes) return;
  const begin=/^!iniciar\s+([0-9a-f-]{36})$/i.exec(message.text);
  if(begin && !message.isGroup && message.phone) {
    const user=store.userById(begin[1]!);
    if(!user || user.phone !== message.phone) {
      await messenger.sendPrivate(message.senderId,'Faça sua inscrição usando este mesmo número de WhatsApp.'); return;
    }
    if(isEntitled(user)) {
      store.enqueue(`access:${user.id}:${message.id}`,'welcome',user.phone,'Seu acesso está ativo.');
      await subscriptions.run(); return;
    }
    try {
      const checkout=await payments.createSubscription(user);
      const terms=checkout.billingMode === 'recurring' ? 'Assinatura mensal de R$ 5,99, com cobrança recorrente no cartão.' : 'Pagamento avulso de R$ 5,99 por um mês de acesso. A renovação é manual.';
      await messenger.sendPrivate(message.senderId,`${terms}\nPague com segurança no provedor:\n${checkout.url}\nO convite é enviado após a confirmação do pagamento.`);
    } catch(error) {
      console.error('Falha ao gerar checkout',safeFailure(error));
      await messenger.sendPrivate(message.senderId,'Não foi possível gerar seu pagamento agora. Se uma cobrança já foi iniciada, aguarde a conciliação antes de tentar novamente.');
    }
    return;
  }
  await orientations.handle(message);
};
if(!cron.validate(config.EXPIRATION_CRON)) throw new Error('Cron de expiração inválido');
const daily=new DailyVerseBroadcaster(store,transport,config.WHATSAPP_GROUP_IDS,config.TZ);
const tasks=[daily.start(config.DAILY_CRON),
  cron.schedule(config.EXPIRATION_CRON,()=>subscriptions.run(),{timezone:config.TZ,noOverlap:true}),
  cron.schedule('*/30 * * * * *',()=>subscriptions.run(),{timezone:config.TZ,noOverlap:true}),
  cron.schedule('0 * * * *',()=>scraper.refresh().then(()=>undefined).catch(()=>console.error('Fontes de eventos indisponíveis')),{timezone:config.TZ,noOverlap:true})];
if(config.WHATSAPP_ENABLED) await transport.start();
await subscriptions.run();
await scraper.refresh().catch(()=>console.error('Fontes de eventos indisponíveis no início'));
const server=createApp(config,store,payments,[primary,fallback],transport).listen(config.PORT,'0.0.0.0',()=>console.info(`Servidor iniciado na porta ${config.PORT}`));
let stopping=false;
function stop(): void {
  if(stopping) return; stopping=true;
  for(const task of tasks) void task.stop();
  transport.stop(); server.close(()=>{store.close();process.exit(0);});
  setTimeout(()=>process.exit(1),10000).unref();
}
process.on('SIGTERM',stop); process.on('SIGINT',stop);
