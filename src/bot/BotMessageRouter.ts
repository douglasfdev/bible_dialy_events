import { isEntitled } from '../domain/models.js';
import { PaymentService } from '../domain/payment/PaymentStrategy.js';
import { SubscriptionAccess } from '../domain/payment/SubscriptionAccess.js';
import { Store } from '../infrastructure/Store.js';
import { SubscriptionJobs } from '../jobs/SubscriptionJobs.js';
import { SafeMessenger } from './SafeMessenger.js';
import type { IncomingMessage } from './transport.js';
import { OrientationsHandler } from './handlers/OrientationsHandler.js';
import { PaymentReferenceHandler } from './handlers/PaymentReferenceHandler.js';
export class BotMessageRouter {
  private readonly access:SubscriptionAccess;
  private readonly references:PaymentReferenceHandler;
  constructor(private readonly store:Store,private readonly payments:PaymentService,private readonly messenger:SafeMessenger,
    private readonly orientations:OrientationsHandler,private readonly subscriptions:SubscriptionJobs) {
    this.access=new SubscriptionAccess(store,messenger);
    this.references=new PaymentReferenceHandler(store,payments,messenger,this.access);
  }
  async handle(message:IncomingMessage):Promise<void> {
    if(!message.phone || message.senderId!==`${message.phone}@s.whatsapp.net`) return;
    this.store.db.prepare('DELETE FROM incoming_messages WHERE created_at<?').run(Date.now()-86400000);
    if(!this.store.db.prepare('INSERT OR IGNORE INTO incoming_messages VALUES(?,?)').run(`${message.chatId}:${message.id}`,Date.now()).changes) return;
    const initiated=!message.isGroup || /^!(?:meoriente|pagamento)(?:\s|$)/i.test(message.text);
    const firstContact=initiated && this.store.recordBotContact(message.phone);
    if(await this.references.handle(message)) { await this.subscriptions.run();return; }
    const begin=/^!iniciar\s+([0-9a-f-]{36})$/i.exec(message.text);
    if(begin && !message.isGroup) {
      const user=this.store.userById(begin[1]!);
      if(!user || user.phone!==message.phone) {
        await this.messenger.sendPrivate(message.senderId,'Faça sua inscrição usando este mesmo número de WhatsApp.');return;
      }
      if(isEntitled(user)) {
        if(!this.store.hasPendingWelcome(user.phone)) this.store.enqueue(`access:${user.id}:${message.id}`,'welcome',user.phone,'Seu acesso está ativo.');
        await this.subscriptions.run();return;
      }
      let prefix:string;
      try {
        const checkout=await this.payments.createSubscription(user);
        const terms=checkout.billingMode==='recurring' ? 'Assinatura mensal de R$ 5,99, com cobrança recorrente no cartão.' : 'Pagamento avulso de R$ 5,99 por um mês de acesso. A renovação é manual.';
        prefix=`${terms}\nPague com segurança no provedor:\n${checkout.url}\nO convite é enviado após a confirmação do pagamento.`;
      } catch {
        prefix='Não foi possível gerar seu pagamento agora. Se já iniciou uma cobrança, aguarde a conciliação antes de tentar novamente.';
      }
      await this.access.requestPayment(message.phone,message.senderId,prefix);return;
    }
    if(await this.orientations.handle(message)) return;
    if(!message.isGroup) {
      if(!await this.access.require(message.phone,message.senderId)) return;
      if(firstContact) {
        const user=this.store.userByPhone(message.phone)!;
        if(!this.store.hasPendingWelcome(user.phone)) this.store.enqueue(`first-contact:${user.id}:${user.current_period_end}`,'welcome',user.phone,'Seu pagamento está confirmado. Use !meoriente para conversar no privado.');
        await this.subscriptions.run();
      }
    }
  }
}
