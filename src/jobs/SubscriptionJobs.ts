import type { Config } from '../config.js';
import { isEntitled } from '../domain/models.js';
import { PAYMENT_NOT_FOUND_MESSAGE } from '../domain/payment/messages.js';
import { SubscriptionAccess } from '../domain/payment/SubscriptionAccess.js';
import { Store } from '../infrastructure/Store.js';
import type { WhatsAppTransport } from '../bot/transport.js';
import { SafeMessenger } from '../bot/SafeMessenger.js';
export class SubscriptionJobs {
  private working=false;
  private readonly access:SubscriptionAccess;
  constructor(private readonly store: Store,private readonly transport: WhatsAppTransport,private readonly messenger: SafeMessenger,private readonly cfg: Config) {
    this.access=new SubscriptionAccess(store,messenger);
  }
  async run(): Promise<void> {
    this.store.expire(); this.store.pruneHistory(this.cfg.HISTORY_RETENTION_DAYS);
    if(this.working || !this.transport.connected) return;
    this.working=true;
    try {
      for(const task of this.store.pendingDeliveries(true)) {
        try {
          const user=this.store.userByPhone(task.recipient);
          if(task.kind === 'welcome') {
            if(!isEntitled(user)) { this.store.delivered(task.id); continue; }
            if(!this.cfg.WHATSAPP_GROUP_IDS.length) throw new Error('Grupo não configurado');
            const invites=await Promise.all(this.cfg.WHATSAPP_GROUP_IDS.map(id=>this.transport.invite(id)));
            await this.access.sendPaid(task.recipient,`${task.recipient}@s.whatsapp.net`,`${task.content}\n\n${invites.join('\n')}\nA entrada depende da aprovação da assinatura.`);
          } else if(task.kind==='revoke' || task.kind==='payment_missing') {
            if(isEntitled(user)) { this.store.delivered(task.id); continue; }
            let removed=true;
            if(task.kind==='revoke') for(const group of this.cfg.WHATSAPP_GROUP_IDS) {
              if(this.access.allowed(task.recipient)) break;
              try { await this.transport.remove(group,task.recipient); } catch { removed=false; }
            }
            if(!this.access.allowed(task.recipient) && this.store.canNotifyMissingPayment(task.recipient)) {
              this.store.awaitPaymentReference(task.recipient);
              await this.messenger.sendPrivate(`${task.recipient}@s.whatsapp.net`,PAYMENT_NOT_FOUND_MESSAGE,
                ()=>this.store.hasBotContact(task.recipient) && !this.access.allowed(task.recipient));
              this.store.markPaymentPrompt(task.recipient);
            }
            if(!removed) throw new Error('Remoção pendente');
          } else throw new Error('Tipo de entrega desconhecido');
          this.store.delivered(task.id);
        } catch { this.store.deliveryFailed(task.id); }
      }
    } finally { this.working=false; }
  }
}
