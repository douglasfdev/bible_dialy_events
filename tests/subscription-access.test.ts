import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/infrastructure/Store.js';
import {isEntitled} from '../src/domain/models.js';
import {PaymentService} from '../src/domain/payment/PaymentStrategy.js';
import {SubscriptionAccess,PAYMENT_NOT_FOUND_MESSAGE} from '../src/domain/payment/SubscriptionAccess.js';
import {SafeMessenger,DeliveryGuardError} from '../src/bot/SafeMessenger.js';
import {PaymentReferenceHandler} from '../src/bot/handlers/PaymentReferenceHandler.js';
import {OrientationsHandler} from '../src/bot/handlers/OrientationsHandler.js';
import {BotMessageRouter} from '../src/bot/BotMessageRouter.js';
import {SubscriptionJobs} from '../src/jobs/SubscriptionJobs.js';
import {DailyVerseBroadcaster} from '../src/jobs/DailyVerseBroadcaster.js';
import {ChurchEventsScraper} from '../src/scraper/ChurchEventsScraper.js';
import {cfg,FakeGateway,FakeTransport} from './helpers.js';
const phone='5511999999999',jid=`${phone}@s.whatsapp.net`;
const message=(text:string,id='1',isGroup=false)=>({id,phone,senderId:jid,chatId:isGroup?'123@g.us':jid,isGroup,text});
function fixture() {
  const store=new Store(':memory:');const user=store.lead('Ana',phone,'ana@example.com');
  store.saveCheckout(user.id,'mercadopago','sub','https://pay.example','recurring');
  const transport=new FakeTransport(),messenger=new SafeMessenger(transport,async()=>{});
  const primary=new FakeGateway('mercadopago'),fallback=new FakeGateway('pagseguro');
  const payments=new PaymentService(primary,fallback,store),access=new SubscriptionAccess(store,messenger);
  const references=new PaymentReferenceHandler(store,payments,messenger,access);
  const advisor={calls:0,async reply(){this.calls++;return 'Orientação paga';}};
  const orientations=new OrientationsHandler(store,transport,messenger,advisor,new ChurchEventsScraper(store,[]),cfg(),access);
  const jobs=new SubscriptionJobs(store,transport,messenger,cfg({WHATSAPP_GROUP_IDS:['123@g.us']}));
  const router=new BotMessageRouter(store,payments,messenger,orientations,jobs);
  const paid=(id='paid-renewal')=>{primary.event={id,userId:user.id,subscriptionId:'sub',kind:'paid',periodEnd:'2099-01-01T00:00:00.000Z'};};
  return {store,user,transport,messenger,primary,fallback,payments,access,references,advisor,orientations,jobs,router,paid};
}
test('first private contact without a valid payment receives the exact requested text',async()=>{
  const f=fixture();try {
    await f.router.handle(message('oi'));
    assert.equal(f.transport.privateMessages[0]?.text,PAYMENT_NOT_FOUND_MESSAGE);
    assert.equal(f.store.hasBotContact(phone),true);assert.equal(f.store.awaitingPaymentReference(phone),true);
    assert.equal(f.advisor.calls,0);
  } finally {f.store.close();}
});
test('new onboarding sends checkout and asks for the payment reference without granting access',async()=>{
  const f=fixture();try {
    await f.router.handle(message(`!iniciar ${f.user.id}`));
    assert.match(f.transport.privateMessages[0]!.text,/https:\/\/pay.example/);
    assert.ok(f.transport.privateMessages[0]!.text.endsWith(PAYMENT_NOT_FOUND_MESSAGE));
    assert.equal(f.access.allowed(phone),false);
  } finally {f.store.close();}
});
test('paid webhook before first contact queues access but sends no unsolicited welcome',async()=>{
  const f=fixture();try {
    f.paid();await f.payments.processWebhook(f.primary,{body:{},rawBody:'{}',query:{},headers:{}});
    await f.jobs.run();assert.equal(f.transport.privateMessages.length,0);assert.equal(f.store.hasPendingWelcome(phone),true);
    await f.router.handle(message('oi'));
    assert.equal(f.transport.privateMessages.length,1);assert.match(f.transport.privateMessages[0]!.text,/Seu pagamento foi confirmado/);
    assert.equal(f.store.hasPendingWelcome(phone),false);
  } finally {f.store.close();}
});
test('plain payment number after prompt is verified and restores normal private orientation',async()=>{
  const f=fixture();try {
    await f.router.handle(message('oi'));f.paid();await f.router.handle(message('123456','2'));
    assert.equal(f.access.allowed(phone),true);assert.equal(f.store.awaitingPaymentReference(phone),false);
    assert.ok(f.transport.privateMessages.some(m=>m.text.startsWith('Pagamento confirmado')));
    await f.router.handle(message('!meoriente preciso conversar','3'));
    assert.equal(f.advisor.calls,1);assert.equal(f.transport.privateMessages.at(-1)?.text,'Orientação paga');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM payment_events').get()?.n,1);
    assert.ok(!f.store.history(phone).some(m=>m.content.includes('123456')));
  } finally {f.store.close();}
});
test('a foreign payment or an old paid month never unlocks the phone',async()=>{
  const f=fixture();try {
    f.paid();f.primary.event={...f.primary.event,userId:'another-user'};
    assert.equal(await f.payments.reconcilePayment(phone,'123'),false);
    f.paid();f.primary.event={...f.primary.event,periodEnd:'2020-01-01T00:00:00.000Z'};
    assert.equal(await f.payments.reconcilePayment(phone,'124'),false);
    assert.equal(f.access.allowed(phone),false);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM payment_events').get()?.n,0);
  } finally {f.store.close();}
});
test('repeated lookup cannot extend the same monthly payment and is rate limited persistently',async()=>{
  const f=fixture();try {
    f.paid();assert.equal(await f.payments.reconcilePayment(phone,'123'),true);
    assert.equal(await f.payments.reconcilePayment(phone,'123'),true);
    assert.equal(await f.payments.reconcilePayment(phone,'123'),true);
    assert.equal(f.store.userByPhone(phone)?.current_period_end,'2099-01-01T00:00:00.000Z');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM payment_events').get()?.n,1);
    await assert.rejects(new PaymentService(f.primary,f.fallback,f.store).reconcilePayment(phone,'123'),/15 minutos/);
  } finally {f.store.close();}
});
test('provider outage during reference lookup keeps access blocked and records an unavailable claim',async()=>{
  const f=fixture();try {
    f.primary.error=new Error('offline');await f.references.handle(message('!pagamento 123'));
    assert.equal(f.access.allowed(phone),false);assert.match(f.transport.privateMessages[0]!.text,/Não foi possível consultar/);
    assert.equal(f.store.db.prepare('SELECT status FROM payment_claims').get()?.status,'UNAVAILABLE');
  } finally {f.store.close();}
});
test('payment references posted in group are not verified or forwarded to AI',async()=>{
  const f=fixture();try {
    await f.router.handle(message('!pagamento 123','1',true));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM payment_claims').get()?.n,0);
    assert.equal(f.transport.groupMessages.length,0);assert.match(f.transport.privateMessages[0]!.text,/somente nesta conversa privada/);
    assert.equal(f.advisor.calls,0);
  } finally {f.store.close();}
});
test('expiry prompts existing contacts privately and a renewed subscription suppresses stale reminders',async()=>{
  const f=fixture();try {
    f.store.recordBotContact(phone);f.store.activate('old',f.user,'2020-01-01T00:00:00.000Z');
    await f.jobs.run();assert.equal(f.transport.privateMessages[0]!.text,PAYMENT_NOT_FOUND_MESSAGE);
    assert.equal(f.store.awaitingPaymentReference(phone),true);assert.ok(f.transport.removed.includes(phone));
    f.store.queuePaymentReminder(phone);f.paid();await f.payments.reconcilePayment(phone,'123');await f.jobs.run();
    assert.equal(f.transport.privateMessages.filter(m=>m.text===PAYMENT_NOT_FOUND_MESSAGE).length,1);
    assert.equal(f.access.allowed(phone),true);
  } finally {f.store.close();}
});
test('removal is attempted without contact but no automatic DM is sent until the user initiates',async()=>{
  const f=fixture();try {
    f.store.activate('old',f.user,'2020-01-01T00:00:00.000Z');await f.jobs.run();
    assert.ok(f.transport.removed.includes(phone));assert.equal(f.transport.privateMessages.length,0);
  } finally {f.store.close();}
});
test('automatic missing-payment notices are capped at one per 24 hours',async()=>{
  const f=fixture();try {
    f.store.recordBotContact(phone);f.store.queuePaymentReminder(phone);await f.jobs.run();
    f.store.enqueue('another-reminder','payment_missing',phone,PAYMENT_NOT_FOUND_MESSAGE);await f.jobs.run();
    assert.equal(f.transport.privateMessages.length,1);
  } finally {f.store.close();}
});
test('a private reply is blocked if access expires while waiting in the send queue',async()=>{
  const f=fixture();try {
    f.store.activate('paid',f.user,'2099-01-01T00:00:00.000Z');
    const messenger=new SafeMessenger(f.transport,async()=>{f.store.db.prepare("UPDATE users SET current_period_end='2020-01-01T00:00:00.000Z' WHERE phone=?").run(phone);});
    await assert.rejects(new SubscriptionAccess(f.store,messenger).sendPaid(phone,jid,'Conteúdo pago'),DeliveryGuardError);
    assert.equal(f.transport.privateMessages.length,0);
  } finally {f.store.close();}
});
test('daily broadcast removes unpaid members before sending and only queues reminders for contacts',async()=>{
  const f=fixture();try {
    f.store.recordBotContact(phone);f.transport.participants.push({id:jid,phone,isSelf:false});
    const stranger='5511888888888';f.transport.participants.push({id:`${stranger}@s.whatsapp.net`,phone:stranger,isSelf:false});
    await new DailyVerseBroadcaster(f.store,f.transport,['123@g.us'],'UTC').broadcast();
    assert.deepEqual(f.transport.removed,[phone,stranger]);assert.equal(f.transport.groupMessages.length,1);
    assert.equal(f.transport.privateMessages.length,0);
    const reminders=f.store.pendingDeliveries().filter(d=>d.kind==='payment_missing');assert.deepEqual(reminders.map(d=>d.recipient),[phone]);
    await f.jobs.run();assert.equal(f.transport.privateMessages[0]?.text,PAYMENT_NOT_FOUND_MESSAGE);
  } finally {f.store.close();}
});
test('group broadcast fails closed on failed removal, unknown identity or failed membership fetch',async()=>{
  const f=fixture();try {
    const job=new DailyVerseBroadcaster(f.store,f.transport,['123@g.us'],'UTC');
    f.transport.participants.push({id:jid,phone,isSelf:false});f.transport.remove=async()=>{throw new Error('no permission');};
    await job.broadcast();assert.equal(f.transport.groupMessages.length,0);
    f.transport.participants=[{id:'bot',isSelf:true},{id:'123@lid',isSelf:false}];
    await job.broadcast();assert.equal(f.transport.groupMessages.length,0);
    let reads=0;f.transport.groupParticipants=async()=>++reads===1 ? [{id:'bot',isSelf:true}] : [];
    await job.broadcast();assert.equal(f.transport.groupMessages.length,0);
    f.transport.groupParticipants=async()=>{throw new Error('offline');};await job.broadcast();assert.equal(f.transport.groupMessages.length,0);
  } finally {f.store.close();}
});
test('active renewed members stay in group and canceled subscriptions retain their paid period',async()=>{
  const f=fixture();try {
    f.store.activate('renewal',f.user,'2099-01-01T00:00:00.000Z');f.store.cancel(f.user.id);
    f.transport.participants.push({id:jid,phone,isSelf:false});
    await new DailyVerseBroadcaster(f.store,f.transport,['123@g.us'],'UTC').broadcast();
    assert.equal(f.transport.groupMessages.length,1);assert.equal(f.transport.removed.length,0);
    assert.equal(isEntitled(f.store.userByPhone(phone)),true);
    f.store.db.prepare("UPDATE users SET status='OVERDUE' WHERE phone=?").run(phone);assert.equal(f.access.allowed(phone),false);
  } finally {f.store.close();}
});
