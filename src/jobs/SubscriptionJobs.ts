import type { Config } from '../config.js';
import { isEntitled } from '../domain/models.js';
import { Store } from '../infrastructure/Store.js';
import type { WhatsAppTransport } from '../bot/transport.js';
import { SafeMessenger } from '../bot/SafeMessenger.js';
export class SubscriptionJobs {
  private working=false;
  constructor(private readonly store: Store,private readonly transport: WhatsAppTransport,private readonly messenger: SafeMessenger,private readonly cfg: Config) {}
  async run(): Promise<void> {
    this.store.expire(); this.store.pruneHistory(this.cfg.HISTORY_RETENTION_DAYS);
    if(this.working || !this.transport.connected) return;
    this.working=true;
    try {
      for(const task of this.store.pendingDeliveries()) {
        try {
          const user=this.store.userByPhone(task.recipient);
          if(task.kind === 'welcome') {
            if(!isEntitled(user)) { this.store.delivered(task.id); continue; }
            if(!this.cfg.WHATSAPP_GROUP_IDS.length) throw new Error('Grupo não configurado');
            const invites=await Promise.all(this.cfg.WHATSAPP_GROUP_IDS.map(id=>this.transport.invite(id)));
            await this.messenger.sendPrivate(`${task.recipient}@s.whatsapp.net`,`${task.content}\n\n${invites.join('\n')}\nA entrada depende da aprovação da assinatura.`);
          } else {
            if(isEntitled(user)) { this.store.delivered(task.id); continue; }
            for(const group of this.cfg.WHATSAPP_GROUP_IDS) await this.transport.remove(group,task.recipient);
            await this.messenger.sendPrivate(`${task.recipient}@s.whatsapp.net`,task.content);
          }
          this.store.delivered(task.id);
        } catch { this.store.deliveryFailed(task.id); }
      }
    } finally { this.working=false; }
  }
}
