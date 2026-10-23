import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac,createHash } from 'node:crypto';
import { AxiosError,type AxiosAdapter } from 'axios';
import { Store } from '../src/infrastructure/Store.js';
import { externalHttp } from '../src/infrastructure/http.js';
import { MercadoPagoGateway,PagSeguroGateway,PaymentService,UnavailableBeforeCreation } from '../src/domain/payment/PaymentStrategy.js';
import { cfg,FakeGateway,emptyWebhook } from './helpers.js';
function fixture() { const store=new Store(':memory:'); const user=store.lead('Ana','5511999999999','ana@example.com'); return {store,user}; }
test('fallback before mutation, concurrent calls coalesce and checkout is reused',async()=>{
  const {store,user}=fixture(); const primary=new FakeGateway('mercadopago'); primary.error=new UnavailableBeforeCreation('indisponível');
  const fallback=new FakeGateway('pagseguro'); const service=new PaymentService(primary,fallback,store);
  const [a,b]=await Promise.all([service.createSubscription(user),service.createSubscription(user)]);
  assert.equal(a.provider,'pagseguro'); assert.deepEqual(a,b); assert.equal(primary.calls,1); assert.equal(fallback.calls,1);
  await service.createSubscription(user); assert.equal(fallback.calls,1); store.close();
});
test('ambiguous financial timeout never switches providers or resubmits after restart',async()=>{
  const {store,user}=fixture(); const primary=new FakeGateway('mercadopago'); primary.error=new AxiosError('timeout','ECONNABORTED');
  const fallback=new FakeGateway('pagseguro'); const service=new PaymentService(primary,fallback,store);
  await assert.rejects(service.createSubscription(user));
  await assert.rejects(new PaymentService(primary,fallback,store).createSubscription(user),/conciliação/);
  assert.equal(primary.calls,1); assert.equal(fallback.calls,0); store.close();
});
test('webhook activation is idempotent; stale payment cannot shorten paid access',async()=>{
  const {store,user}=fixture(); const primary=new FakeGateway('mercadopago'); const service=new PaymentService(primary,new FakeGateway('pagseguro'),store);
  await service.createSubscription(user);
  primary.event={id:'paid-1',kind:'paid',subscriptionId:'subscription-1',userId:user.id,periodEnd:'2030-03-01T00:00:00.000Z'};
  await service.processWebhook(primary,emptyWebhook); await service.processWebhook(primary,emptyWebhook);
  primary.event={...primary.event,id:'paid-2',periodEnd:'2030-02-01T00:00:00.000Z'};
  await service.processWebhook(primary,emptyWebhook);
  assert.equal(store.userById(user.id)?.status,'ACTIVE'); assert.equal(store.userById(user.id)?.current_period_end,'2030-03-01T00:00:00.000Z');
  assert.equal(store.pendingDeliveries().length,2); store.close();
});
test('provider and subscription ownership must match before activation',async()=>{
  const {store,user}=fixture(); const primary=new FakeGateway('mercadopago'); const fallback=new FakeGateway('pagseguro');
  const service=new PaymentService(primary,fallback,store); await service.createSubscription(user);
  fallback.event={id:'spoof',kind:'paid',subscriptionId:'subscription-1',userId:user.id,periodEnd:'2030-01-01T00:00:00.000Z'};
  await assert.rejects(service.processWebhook(fallback,emptyWebhook),/desconhecida/); assert.equal(store.userById(user.id)?.status,'PENDING_PAYMENT'); store.close();
});
test('Mercado Pago rejects absent, tampered and stale webhook signatures',async()=>{
  const gateway=new MercadoPagoGateway(cfg({MERCADOPAGO_WEBHOOK_SECRET:'test-secret'}));
  await assert.rejects(gateway.processWebhook(emptyWebhook),/Assinatura inválida/);
  const ts=String(Math.floor(Date.now()/1000)); const id='abc'; const request='request-1';
  const v1=createHmac('sha256','test-secret').update(`id:${id};request-id:${request};ts:${ts};`).digest('hex');
  await assert.rejects(gateway.processWebhook({body:{type:'ignored',data:{id:'other'}},rawBody:'',query:{'data.id':id},headers:{'x-request-id':request,'x-signature':`ts=${ts},v1=${v1}`}}),/divergente/);
  await assert.rejects(gateway.processWebhook({body:{},rawBody:'',query:{'data.id':id},headers:{'x-request-id':request,'x-signature':`ts=1,v1=${v1}`}}),/inválida/);
});
test('signed recurring payment is fetched canonically; activation date comes from payment',async()=>{
  const previous=externalHttp.defaults.adapter;
  const responses:Record<string,unknown>={
    '/authorized_payments/abc':{id:'abc',preapproval_id:'sub1',payment:{id:123,status:'approved'}},
    '/preapproval/sub1':{id:'sub1',external_reference:'user1',auto_recurring:{currency_id:'BRL',transaction_amount:5.99}},
    '/v1/payments/123':{id:123,status:'approved',currency_id:'BRL',transaction_amount:5.99,date_approved:'2026-01-31T12:00:00Z'},
  };
  externalHttp.defaults.adapter=(async config=>({data:responses[new URL(config.url!).pathname],status:200,statusText:'OK',headers:{},config})) satisfies AxiosAdapter;
  try {
    const ts=String(Math.floor(Date.now()/1000)); const signature=createHmac('sha256','key').update(`id:abc;request-id:req;ts:${ts};`).digest('hex');
    const result=await new MercadoPagoGateway(cfg({MERCADOPAGO_WEBHOOK_SECRET:'key'})).processWebhook({body:{type:'subscription_authorized_payment',data:{id:'abc'}},rawBody:'',query:{'data.id':'abc'},headers:{'x-request-id':'req','x-signature':`ts=${ts},v1=${signature}`}});
    assert.equal(result.userId,'user1'); assert.equal(result.id,'mp:payment:123'); assert.equal(result.periodEnd,'2026-02-28T12:00:00.000Z');
  } finally { externalHttp.defaults.adapter=previous; }
});
test('PagBank validates raw signed body and reconciles order with canonical checkout',async()=>{
  const previous=externalHttp.defaults.adapter;
  const body=JSON.stringify({id:'ORDE_1'}); const token=createHash('sha256').update(`key-${body}`).digest('hex');
  const gateway=new PagSeguroGateway(cfg({PAGSEGURO_TOKEN:'key'})); gateway.lookupCheckout=()=> 'CHEC_1';
  externalHttp.defaults.adapter=(async config=>({data:config.url!.includes('/orders/') ? {id:'ORDE_1',reference_id:'u1',charges:[{id:'CHAR_1',status:'PAID',paid_at:'2026-10-23T12:00:00Z',amount:{value:599,currency:'BRL'}}]} : {id:'CHEC_1',reference_id:'u1',orders:[{id:'ORDE_1'}]},status:200,statusText:'OK',headers:{},config})) satisfies AxiosAdapter;
  try {
    const event=await gateway.processWebhook({body:JSON.parse(body),rawBody:body,query:{},headers:{'x-authenticity-token':token}});
    assert.equal(event.kind,'paid'); assert.equal(event.subscriptionId,'CHEC_1');
    await assert.rejects(gateway.processWebhook({body:{id:'ORDE_1'},rawBody:`${body} `,query:{},headers:{'x-authenticity-token':token}}),/Assinatura inválida/);
  } finally { externalHttp.defaults.adapter=previous; }
});
test('PagBank one-time fallback requires explicit enablement',async()=>{
  const {store,user}=fixture(); await assert.rejects(new PagSeguroGateway(cfg()).createSubscription(user),/não habilitado/); store.close();
});
test('expiration enqueues one revocation; cancellation preserves the paid period',()=>{
  const {store,user}=fixture();store.activate('paid',user,'2026-01-01T00:00:00.000Z');store.cancel(user.id);
  assert.equal(store.userById(user.id)?.status,'CANCELED'); assert.equal(store.expire('2025-12-01T00:00:00.000Z'),0);
  assert.equal(store.expire('2026-01-02T00:00:00.000Z'),1);assert.equal(store.expire('2026-01-02T00:00:00.000Z'),0);
  assert.equal(store.pendingDeliveries().filter(d=>d.kind === 'revoke').length,1); store.close();
});
