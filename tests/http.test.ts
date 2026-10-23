import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/infrastructure/Store.js';
import { PaymentService } from '../src/domain/payment/PaymentStrategy.js';
import { createApp } from '../src/http/app.js';
import type { Config } from '../src/config.js';
import { cfg,FakeGateway,FakeTransport } from './helpers.js';
async function fixture(overrides:Partial<Config>={}) {
  const store=new Store(':memory:');const transport=new FakeTransport();
  const gateway=new FakeGateway('mercadopago');const fallback=new FakeGateway('pagseguro');
  const payments=new PaymentService(gateway,fallback,store);
  const app=createApp(cfg({WHATSAPP_BOT_PHONE:'5511888888888',...overrides}),store,payments,[gateway,fallback],transport);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {store,transport,gateway,url,async close(){await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));store.close();}};
}
const lead={name:'Ana',phone:'+5511999999999',email:'ana@example.com',consent:true};
test('HTTP lead returns a WhatsApp onboarding link and never creates a financial charge',async()=>{
  const f=await fixture();try {
    const response=await fetch(`${f.url}/api/lead`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(lead)});
    assert.equal(response.status,201);const body=await response.json() as {whatsappUrl:string};
    assert.ok(body.whatsappUrl.startsWith('https://wa.me/5511888888888?text='));
    assert.match(decodeURIComponent(body.whatsappUrl),/!iniciar /);assert.equal(f.gateway.calls,0);
    assert.equal(f.store.userByPhone('5511999999999')?.status,'PENDING_PAYMENT');
  } finally {await f.close();}
});
test('HTTP rejects malformed input and missing consent',async()=>{
  const f=await fixture();try {
    for(const invalid of [{...lead,phone:'bad'},{...lead,consent:false},{...lead,email:'bad'}]) {
      const response=await fetch(`${f.url}/api/lead`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(invalid)});
      assert.equal(response.status,400);
    }
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n,0);
  } finally {await f.close();}
});
test('HTTP refuses enrollment while WhatsApp is disconnected',async()=>{
  const f=await fixture();try {
    f.transport.connected=false;
    const response=await fetch(`${f.url}/api/lead`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(lead)});
    assert.equal(response.status,503);assert.equal(f.store.userByPhone('5511999999999'),undefined);
  } finally {await f.close();}
});
test('HTTP webhook activates subscriber and responds 204 after durable state update',async()=>{
  const f=await fixture();try {
    const user=f.store.lead('Ana','5511999999999','ana@example.com');f.store.saveCheckout(user.id,'mercadopago','sub','https://pay.example','recurring');
    f.gateway.event={id:'paid',subscriptionId:'sub',userId:user.id,kind:'paid',periodEnd:'2099-01-01T00:00:00.000Z'};
    const response=await fetch(`${f.url}/webhooks/mercadopago`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(response.status,204);assert.equal(f.store.userById(user.id)?.status,'ACTIVE');assert.equal(f.store.pendingDeliveries().length,1);
  } finally {await f.close();}
});

test('rate limiting distinguishes client IPs behind the single trusted proxy',async()=>{
  const f=await fixture({TRUST_PROXY:1});try {
    for(let i=0;i<5;i++) {
      const response=await fetch(`${f.url}/api/lead`,{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':'198.51.100.1'},body:JSON.stringify(lead)});
      assert.equal(response.status,201);
    }
    const denied=await fetch(`${f.url}/api/lead`,{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':'198.51.100.1'},body:JSON.stringify(lead)});
    assert.equal(denied.status,429);
    const other=await fetch(`${f.url}/api/lead`,{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':'198.51.100.2'},body:JSON.stringify(lead)});
    assert.equal(other.status,201);
  } finally {await f.close();}
});
