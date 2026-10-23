import type { Config } from '../src/config.js';
import { config } from '../src/config.js';
import type { GroupParticipant,IncomingMessage,WhatsAppTransport } from '../src/bot/transport.js';
import type { Checkout,IPaymentGateway,PaymentEvent,WebhookInput } from '../src/domain/payment/PaymentStrategy.js';
export function cfg(overrides: Partial<Config> = {}): Config { return {...config,...overrides}; }
export class FakeTransport implements WhatsAppTransport {
  connected=true; admin=true; privateMessages:{to:string;text:string}[]=[]; groupMessages:{to:string;text:string}[]=[];
  participants:GroupParticipant[]=[{id:'5511000000000@s.whatsapp.net',phone:'5511000000000',isSelf:true}];
  async groupParticipants(_group:string) { return this.participants.map(p=>({...p})); }
  deleted:IncomingMessage[]=[]; removed:string[]=[];
  async sendPrivate(to:string,text:string) { this.privateMessages.push({to,text}); }
  async sendGroup(to:string,text:string) { this.groupMessages.push({to,text}); }
  async isGroupAdmin(_group:string) { return this.admin; }
  async deleteMessage(message:IncomingMessage) { this.deleted.push(message); }
  async invite(group:string) { return `https://chat.whatsapp.com/${group}`; }
  async remove(_group:string,phone:string) { this.removed.push(phone); this.participants=this.participants.filter(p=>p.phone!==phone); }
}
export class FakeGateway implements IPaymentGateway {
  calls=0; error?:Error; event:PaymentEvent={id:'event-1',kind:'ignored',subscriptionId:'subscription-1',userId:''};
  constructor(readonly provider:'mercadopago'|'pagseguro') {}
  async createSubscription():Promise<Checkout> { this.calls++; if(this.error) throw this.error; return {id:'subscription-1',url:'https://pay.example/1',provider:this.provider,billingMode:'recurring'}; }
  async processWebhook(_input:WebhookInput) { return this.event; }
  async verifyPayment() { if(this.error) throw this.error; return this.event; }
}
export const emptyWebhook:WebhookInput={body:{},rawBody:'{}',headers:{},query:{}};
