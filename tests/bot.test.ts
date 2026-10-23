import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/infrastructure/Store.js';
import { SafeMessenger } from '../src/bot/SafeMessenger.js';
import { OrientationsHandler } from '../src/bot/handlers/OrientationsHandler.js';
import { DailyVerseBroadcaster } from '../src/jobs/DailyVerseBroadcaster.js';
import { SubscriptionJobs } from '../src/jobs/SubscriptionJobs.js';
import { ChurchEventsScraper } from '../src/scraper/ChurchEventsScraper.js';
import { cfg,FakeTransport } from './helpers.js';
const phone='5511999999999'; const jid=`${phone}@s.whatsapp.net`;
function fixture(active=true) {
  const store=new Store(':memory:');const user=store.lead('Ana',phone,'ana@example.com');
  if(active) store.activate('paid',user,'2099-01-01T00:00:00.000Z');
  const transport=new FakeTransport();const messenger=new SafeMessenger(transport,async()=>{});
  const advisor={calls:0,async reply(){this.calls++;return 'Estou aqui para ouvir você.';}};
  const scraper=new ChurchEventsScraper(store,[]);
  const handler=new OrientationsHandler(store,transport,messenger,advisor,scraper,cfg());
  return {store,user,transport,messenger,advisor,handler};
}
test('group orientation deletes original if possible and sends every reply only to sender DM',async()=>{
  const f=fixture();await f.handler.handle({id:'1',chatId:'123@g.us',senderId:jid,phone,text:'!meoriente preciso conversar',isGroup:true});
  assert.equal(f.transport.deleted.length,1); assert.equal(f.transport.groupMessages.length,0);
  assert.equal(f.transport.privateMessages.length,2); assert.ok(f.transport.privateMessages.every(m=>m.to === jid)); assert.equal(f.advisor.calls,1);
  assert.equal(f.store.history(phone).length,2);f.store.close();
});
test('non-admin bot keeps private behavior without trying group deletion',async()=>{
  const f=fixture();f.transport.admin=false;
  await f.handler.handle({id:'1',chatId:'123@g.us',senderId:jid,phone,text:'!meoriente oi',isGroup:true});
  assert.equal(f.transport.deleted.length,0);assert.equal(f.transport.groupMessages.length,0);f.store.close();
});
test('unpaid users cannot access AI and unrelated private messages are ignored',async()=>{
  const f=fixture(false);
  assert.equal(await f.handler.handle({id:'1',chatId:jid,senderId:jid,phone,text:'oi',isGroup:false}),false);
  await f.handler.handle({id:'2',chatId:jid,senderId:jid,phone,text:'!meoriente oi',isGroup:false});
  assert.equal(f.advisor.calls,0);assert.equal(f.transport.privateMessages.length,1);f.store.close();
});
test('location is requested in private, consumed only in pending session and not persisted',async()=>{
  const f=fixture();
  await f.handler.handle({id:'1',chatId:'123@g.us',senderId:jid,phone,text:'!meoriente onde tem culto hoje',isGroup:true});
  assert.equal(f.store.session(phone)?.location_pending,1);
  await f.handler.handle({id:'2',chatId:jid,senderId:jid,phone,text:'',isGroup:false,location:{latitude:-23.55,longitude:-46.63}});
  assert.equal(f.store.session(phone)?.location_pending,0);assert.equal(f.store.history(phone).length,0);assert.equal(f.advisor.calls,0);
  assert.match(f.transport.privateMessages.at(-1)!.text,/Não encontrei eventos/);f.store.close();
});
test('forget deletes history and session',async()=>{
  const f=fixture();f.store.append(phone,'user','teste');f.store.setSession(phone,60000);
  await f.handler.handle({id:'1',chatId:jid,senderId:jid,phone,text:'!esquecer',isGroup:false});
  assert.equal(f.store.history(phone).length,0);assert.equal(f.store.session(phone),undefined);f.store.close();
});
test('daily verses go only to configured admin groups, at most once per local day',async()=>{
  const f=fixture();const job=new DailyVerseBroadcaster(f.store,f.transport,['123@g.us'],'America/Sao_Paulo');
  await job.broadcast(new Date('2026-10-23T09:00:00Z'));await job.broadcast(new Date('2026-10-23T10:00:00Z'));
  assert.equal(f.transport.groupMessages.length,1);assert.equal(f.transport.privateMessages.length,0);
  f.transport.admin=false;await job.broadcast(new Date('2026-10-24T09:00:00Z'));assert.equal(f.transport.groupMessages.length,1);
  assert.throws(()=>new DailyVerseBroadcaster(f.store,f.transport,[jid],'UTC'));f.store.close();
});
test('failed daily send stays uncertain and is not retried blindly',async()=>{
  const f=fixture();f.transport.sendGroup=async()=>{throw new Error('ambiguous');};
  const job=new DailyVerseBroadcaster(f.store,f.transport,['123@g.us'],'UTC');await job.broadcast();await job.broadcast();
  const row=f.store.db.prepare('SELECT state FROM broadcasts').get();assert.equal(row?.state,'uncertain');f.store.close();
});
test('private queue enforces random 2–5 second delays and per-user limits',async()=>{
  const transport=new FakeTransport();const waits:number[]=[];
  const messenger=new SafeMessenger(transport,async ms=>{waits.push(ms);});
  await Promise.all(Array.from({length:6},(_,i)=>messenger.sendPrivate(jid,String(i))));
  await assert.rejects(messenger.sendPrivate(jid,'seventh'),/Limite/);
  assert.ok(waits.every(ms=>ms>=2000 && ms<=5000));assert.deepEqual(transport.privateMessages.map(m=>m.text),['0','1','2','3','4','5']);
});
test('revocation survives WhatsApp downtime and removes expired subscribers after reconnect',async()=>{
  const f=fixture(false);f.store.activate('old',f.user,'2020-01-01T00:00:00.000Z');
  const jobs=new SubscriptionJobs(f.store,f.transport,f.messenger,cfg({WHATSAPP_GROUP_IDS:['123@g.us']}));
  f.transport.connected=false;await jobs.run();assert.equal(f.store.userById(f.user.id)?.status,'OVERDUE');assert.equal(f.transport.removed.length,0);
  f.transport.connected=true;await jobs.run();assert.deepEqual(f.transport.removed,[phone]);assert.equal(f.store.pendingDeliveries().length,0);f.store.close();
});
