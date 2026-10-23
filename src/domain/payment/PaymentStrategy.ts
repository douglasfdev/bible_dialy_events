import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import axios from 'axios';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { addMonth, isEntitled, type Provider, type User } from '../models.js';
import { Store } from '../../infrastructure/Store.js';
import { externalHttp, ServiceError } from '../../infrastructure/http.js';
export interface Checkout { id: string; url: string; provider: Provider; billingMode: 'recurring' | 'one_time' }
export interface WebhookInput { body: unknown; rawBody: string; headers: Record<string, string | undefined>; query: Record<string, unknown> }
export interface PaymentEvent { id: string; subscriptionId: string; userId: string; kind: 'paid' | 'canceled' | 'ignored'; periodEnd?: string }
export interface IPaymentGateway {
  readonly provider: Provider;
  createSubscription(user: User): Promise<Checkout>;
  processWebhook(input: WebhookInput): Promise<PaymentEvent>;
  verifyPayment(reference:string,user:User):Promise<PaymentEvent>;
}
export class UnavailableBeforeCreation extends ServiceError {}
const object = z.record(z.string(),z.unknown());
function secureEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a,b);
}
function ignored(): PaymentEvent { return { id:'',subscriptionId:'',userId:'',kind:'ignored' }; }
const checkoutSchema = z.object({ id: z.string(), init_point: z.url() });
export class MercadoPagoGateway implements IPaymentGateway {
  readonly provider = 'mercadopago' as const;
  constructor(private readonly cfg: Config) {}
  private headers() { return { Authorization: `Bearer ${this.cfg.MERCADOPAGO_ACCESS_TOKEN}` }; }
  async createSubscription(user: User): Promise<Checkout> {
    if (!this.cfg.MERCADOPAGO_ACCESS_TOKEN) throw new UnavailableBeforeCreation('Mercado Pago não configurado');
    // Probe before financial mutation: safe point to select another provider.
    try { await externalHttp.get('https://api.mercadopago.com/users/me',{ headers:this.headers() }); }
    catch(e) {
      if (axios.isAxiosError(e) && (!e.response || e.response.status >= 500 || e.response.status === 429))
        throw new UnavailableBeforeCreation('Mercado Pago indisponível antes da cobrança');
      throw e;
    }
    const result = await externalHttp.post('https://api.mercadopago.com/preapproval',{
      reason:'Apoio espiritual — assinatura mensal', external_reference:user.id,
      payer_email:user.email, back_url:this.cfg.PAYMENT_RETURN_URL,
      auto_recurring:{ frequency:1,frequency_type:'months',transaction_amount:5.99,currency_id:'BRL' },
      status:'pending',
    },{ headers:{...this.headers(),'X-Idempotency-Key':createHash('sha256').update(`${user.id}:${user.current_period_end ?? 'initial'}`).digest('hex')} });
    const data = checkoutSchema.parse(result.data);
    return {id:data.id,url:data.init_point,provider:this.provider,billingMode:'recurring'};
  }
  async verifyPayment(reference:string,user:User):Promise<PaymentEvent> {
    if(!this.cfg.MERCADOPAGO_ACCESS_TOKEN) throw new ServiceError('Consulta de pagamentos indisponível');
    if(!/^\d{1,30}$/.test(reference) || !user.subscription_id) return ignored();
    const {data}=await externalHttp.get(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(reference)}`,{headers:this.headers()});
    const payment=z.object({id:z.union([z.string(),z.number()]),status:z.string(),currency_id:z.string(),transaction_amount:z.number(),
      external_reference:z.string().nullable(),date_approved:z.iso.datetime({offset:true}).nullable()}).parse(data);
    if(String(payment.id)!==reference || payment.status!=='approved' || payment.currency_id!=='BRL' || payment.transaction_amount!==5.99 ||
      payment.external_reference!==user.id || !payment.date_approved || Date.parse(payment.date_approved)>Date.now()) return ignored();
    const sub=z.object({id:z.string(),external_reference:z.string(),auto_recurring:z.object({currency_id:z.literal('BRL'),transaction_amount:z.literal(5.99)})})
      .parse((await externalHttp.get(`https://api.mercadopago.com/preapproval/${encodeURIComponent(user.subscription_id)}`,{headers:this.headers()})).data);
    if(sub.id!==user.subscription_id || sub.external_reference!==user.id) return ignored();
    return {id:`mp:payment:${payment.id}`,subscriptionId:sub.id,userId:user.id,kind:'paid',periodEnd:addMonth(new Date(payment.date_approved))};
  }
  async processWebhook(input: WebhookInput): Promise<PaymentEvent> {
    if(!this.cfg.MERCADOPAGO_WEBHOOK_SECRET) throw new ServiceError('Webhook não configurado');
    const dataId = input.query['data.id'];
    const signature = input.headers['x-signature'] ?? '';
    const requestId = input.headers['x-request-id'] ?? '';
    const parts = Object.fromEntries(signature.split(',').map(s => s.trim().split('=')));
    const ts = parts.ts; const v1 = parts.v1;
    const timestamp = Number(ts);
    const epoch = timestamp > 1e12 ? timestamp : timestamp*1000;
    if(typeof dataId !== 'string' || !requestId || !ts || !v1 || !Number.isFinite(epoch) || Math.abs(Date.now()-epoch)>300_000)
      throw new ServiceError('Assinatura inválida',401,'INVALID_SIGNATURE');
    const expected = createHmac('sha256',this.cfg.MERCADOPAGO_WEBHOOK_SECRET)
      .update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
    if(!secureEqual(v1,expected)) throw new ServiceError('Assinatura inválida',401,'INVALID_SIGNATURE');
    const body = object.parse(input.body);
    if(String((object.safeParse(body.data).success ? object.parse(body.data).id : '') ?? '') !== dataId)
      throw new ServiceError('Identificador divergente',400,'INVALID_EVENT');
    if(body.type === 'subscription_preapproval') {
      const {data} = await externalHttp.get(`https://api.mercadopago.com/preapproval/${encodeURIComponent(dataId)}`,{headers:this.headers()});
      const subscription = z.object({id:z.string(),external_reference:z.string(),status:z.string()}).parse(data);
      return { id:`mp:subscription:${dataId}`,subscriptionId:subscription.id,userId:subscription.external_reference,
        kind:subscription.status === 'cancelled' ? 'canceled' : 'ignored' };
    }
    if(body.type !== 'subscription_authorized_payment') return ignored();
    const {data} = await externalHttp.get(`https://api.mercadopago.com/authorized_payments/${encodeURIComponent(dataId)}`,{headers:this.headers()});
    const authorized = z.object({id:z.union([z.string(),z.number()]),preapproval_id:z.string(),payment:z.object({id:z.union([z.string(),z.number()]),status:z.string()})}).parse(data);
    if(authorized.payment.status !== 'approved') return ignored();
    const [subscriptionResult,paymentResult] = await Promise.all([
      externalHttp.get(`https://api.mercadopago.com/preapproval/${encodeURIComponent(authorized.preapproval_id)}`,{headers:this.headers()}),
      externalHttp.get(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(authorized.payment.id)}`,{headers:this.headers()}),
    ]);
    const sub = z.object({id:z.string(),external_reference:z.string(),auto_recurring:z.object({currency_id:z.literal('BRL'),transaction_amount:z.literal(5.99)})}).parse(subscriptionResult.data);
    const payment = z.object({id:z.union([z.number(),z.string()]),status:z.literal('approved'),currency_id:z.literal('BRL'),transaction_amount:z.literal(5.99),date_approved:z.iso.datetime({offset:true})}).parse(paymentResult.data);
    return { id:`mp:payment:${payment.id}`,subscriptionId:sub.id,userId:sub.external_reference,kind:'paid',periodEnd:addMonth(new Date(payment.date_approved)) };
  }
}
export class PagSeguroGateway implements IPaymentGateway {
  readonly provider = 'pagseguro' as const;
  constructor(private readonly cfg: Config) {}
  private get base(): string { return this.cfg.PAGSEGURO_SANDBOX ? 'https://sandbox.api.pagseguro.com' : 'https://api.pagseguro.com'; }
  private headers() { return { Authorization:`Bearer ${this.cfg.PAGSEGURO_TOKEN}` }; }
  async createSubscription(user: User): Promise<Checkout> {
    // PagBank hosted checkout below sells one paid month; it does not authorize recurring debits.
    if(!this.cfg.PAGSEGURO_TOKEN || !this.cfg.PAGSEGURO_ALLOW_ONE_TIME_FALLBACK)
      throw new UnavailableBeforeCreation('Fallback PagBank avulso não habilitado');
    const {data} = await externalHttp.post(`${this.base}/checkouts`,{
      reference_id:user.id,
      customer:{name:user.name,email:user.email},customer_modifiable:true,
      items:[{reference_id:'spiritual-month',name:'Acesso por 1 mês — renovação manual',quantity:1,unit_amount:599}],
      payment_methods:[{type:'PIX'},{type:'CREDIT_CARD'}],
      redirect_url:this.cfg.PAYMENT_RETURN_URL,
      notification_urls:[`${this.cfg.PUBLIC_URL}/webhooks/pagseguro`],
      payment_notification_urls:[`${this.cfg.PUBLIC_URL}/webhooks/pagseguro`],
    },{headers:{...this.headers(),'x-idempotency-key':createHash('sha256').update(`${user.id}:${user.current_period_end ?? 'initial'}`).digest('hex')}});
    const checkout = z.object({id:z.string(),links:z.array(z.object({rel:z.string(),href:z.url()}))}).parse(data);
    const pay = checkout.links.find(link => link.rel === 'PAY');
    if(!pay) throw new ServiceError('PagBank não retornou link de pagamento');
    return {id:checkout.id,url:pay.href,provider:this.provider,billingMode:'one_time'};
  }
  async processWebhook(input: WebhookInput): Promise<PaymentEvent> {
    if(!this.cfg.PAGSEGURO_TOKEN) throw new ServiceError('Webhook não configurado');
    const expected = createHash('sha256').update(`${this.cfg.PAGSEGURO_TOKEN}-${input.rawBody}`).digest('hex');
    if(!secureEqual(input.headers['x-authenticity-token'] ?? '',expected)) throw new ServiceError('Assinatura inválida',401,'INVALID_SIGNATURE');
    const body = z.object({id:z.string()}).parse(input.body);
    return this.canonicalOrder(body.id);
  }
  async verifyPayment(reference:string,_user:User):Promise<PaymentEvent> { return this.canonicalOrder(reference); }
  private async canonicalOrder(reference:string):Promise<PaymentEvent> {
    if(!this.cfg.PAGSEGURO_TOKEN) throw new ServiceError('Consulta de pagamentos indisponível');
    if(!/^ORDE_[A-Z0-9-]{1,80}$/i.test(reference)) return ignored();
    const {data} = await externalHttp.get(`${this.base}/orders/${encodeURIComponent(reference)}`,{headers:this.headers()});
    const order = z.object({id:z.string(),reference_id:z.string(),charges:z.array(z.object({id:z.string(),status:z.string(),paid_at:z.iso.datetime({offset:true}).optional(),amount:z.object({value:z.number(),currency:z.string()})}))}).parse(data);
    const paid = order.charges.find(c => c.status === 'PAID' && c.amount.value === 599 && c.amount.currency === 'BRL' && c.paid_at);
    if(!paid?.paid_at) return ignored();
    // Bind the canonical order's reference to an existing checkout, never trust webhook user data.
    const checkout = z.object({id:z.string(),reference_id:z.string(),orders:z.array(z.object({id:z.string()}))}).parse(
      (await externalHttp.get(`${this.base}/checkouts/${encodeURIComponent(this.lookupCheckout(order.reference_id))}`,{headers:this.headers()})).data);
    if(checkout.reference_id !== order.reference_id || !checkout.orders.some(o=>o.id === order.id)) throw new ServiceError('Pedido sem vínculo ao checkout',400,'INVALID_EVENT');
    return {id:`pagbank:${paid.id}`,subscriptionId:checkout.id,userId:order.reference_id,kind:'paid',periodEnd:addMonth(new Date(paid.paid_at))};
  }
  // Installed by composition root; permits canonical order-to-checkout reconciliation.
  lookupCheckout: (userId: string) => string = () => { throw new ServiceError('Checkout não encontrado',400); };
}
export class PaymentService {
  private readonly inflight = new Map<string,Promise<Checkout>>();
  constructor(private readonly primary: IPaymentGateway,private readonly fallback: IPaymentGateway,private readonly store: Store) {
    store.db.exec('CREATE TABLE IF NOT EXISTS payment_attempts(user_id TEXT PRIMARY KEY,state TEXT NOT NULL)');
  }
  createSubscription(user: User): Promise<Checkout> {
    const pending = this.inflight.get(user.id); if(pending) return pending;
    const task = this.create(user).finally(()=>this.inflight.delete(user.id));
    this.inflight.set(user.id,task); return task;
  }
  private async create(user: User): Promise<Checkout> {
    let cached = this.store.checkout(user.id);
    // A recurring agreement may still retry renewal. Never create a second one just because the month expired.
    if(cached && cached.billing_mode==='one_time' && user.current_period_end && Date.parse(user.current_period_end)<=Date.now() && Date.parse(cached.created_at)<Date.parse(user.current_period_end)) {
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        this.store.db.prepare('DELETE FROM checkouts WHERE user_id=?').run(user.id);
        this.store.db.prepare('DELETE FROM payment_attempts WHERE user_id=?').run(user.id);
        this.store.db.exec('COMMIT'); cached=undefined;
      } catch(e) { this.store.db.exec('ROLLBACK'); throw e; }
    }
    if(cached) return {id:cached.subscription_id,url:cached.url,provider:cached.provider,billingMode:cached.billing_mode};
    const claimed = this.store.db.prepare("INSERT OR IGNORE INTO payment_attempts VALUES(?,'pending')").run(user.id).changes;
    if(!claimed) throw new ServiceError('Cobrança aguardando conciliação. Não gere outro pagamento.',409,'PAYMENT_RECONCILIATION_REQUIRED');
    try {
      let checkout: Checkout;
      try { checkout = await this.primary.createSubscription(user); }
      catch(e) { if(!(e instanceof UnavailableBeforeCreation)) throw e; checkout = await this.fallback.createSubscription(user); }
      if(!checkout.url.startsWith('https://')) throw new ServiceError('Link de pagamento inseguro');
      this.store.saveCheckout(user.id,checkout.provider,checkout.id,checkout.url,checkout.billingMode);
      this.store.db.prepare("UPDATE payment_attempts SET state='completed' WHERE user_id=?").run(user.id);
      return checkout;
    } catch(e) {
      // Retain pending attempts: financial timeouts must be reconciled, not retried across providers.
      if(e instanceof UnavailableBeforeCreation)
        this.store.db.prepare('DELETE FROM payment_attempts WHERE user_id=?').run(user.id);
      throw e;
    }
  }
  async reconcilePayment(phone:string,reference:string,provider?:Provider):Promise<boolean> {
    const user=this.store.userByPhone(phone);
    if(!user?.provider || !user.subscription_id || (provider && provider!==user.provider)) return false;
    if(!(user.provider==='mercadopago' ? /^\d{1,30}$/.test(reference) : /^ORDE_[A-Z0-9-]{1,80}$/i.test(reference))) return false;
    if(this.store.recentPaymentClaims(phone)>=3) throw new ServiceError('Aguarde 15 minutos antes de consultar novamente.',429,'PAYMENT_LOOKUP_RATE_LIMIT');
    const claim=this.store.paymentClaim(phone,user.provider,reference);
    const gateway=user.provider===this.primary.provider ? this.primary : this.fallback;
    try {
      const event=await gateway.verifyPayment(reference,user);
      if(event.kind!=='paid' || event.userId!==user.id || event.subscriptionId!==user.subscription_id || !event.periodEnd ||
        !Number.isFinite(Date.parse(event.periodEnd)) || Date.parse(event.periodEnd)<=Date.now()) {
        this.store.finishPaymentClaim(claim,'NOT_FOUND');return false;
      }
      this.store.activate(event.id,user,event.periodEnd);
      const verified=isEntitled(this.store.userByPhone(phone));
      if(verified) this.store.clearPaymentReference(phone);
      this.store.finishPaymentClaim(claim,verified ? 'VERIFIED' : 'NOT_FOUND');return verified;
    } catch(error) {
      if(axios.isAxiosError(error) && error.response?.status===404) { this.store.finishPaymentClaim(claim,'NOT_FOUND');return false; }
      this.store.finishPaymentClaim(claim,'UNAVAILABLE');
      throw new ServiceError('Não foi possível consultar seu pagamento agora. Tente novamente mais tarde.');
    }
  }
  async processWebhook(gateway: IPaymentGateway,input: WebhookInput): Promise<void> {
    const event = await gateway.processWebhook(input);
    if(event.kind === 'ignored') return;
    const user = this.store.userBySubscription(gateway.provider,event.subscriptionId);
    if(!user || user.id !== event.userId) throw new ServiceError('Assinatura desconhecida',409,'UNKNOWN_SUBSCRIPTION');
    if(event.kind === 'canceled') this.store.cancel(user.id);
    else if(event.periodEnd) this.store.activate(event.id,user,event.periodEnd);
  }
}
