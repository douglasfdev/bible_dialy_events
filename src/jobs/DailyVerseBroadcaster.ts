import cron, {type ScheduledTask} from 'node-cron';
import type { WhatsAppTransport } from '../bot/transport.js';
import { isEntitled } from '../domain/models.js';
import { Store } from '../infrastructure/Store.js';
const verses = [
  'O Senhor é o meu pastor; nada me faltará. — Salmos 23:1 (Almeida)',
  'Deus é o nosso refúgio e fortaleza, socorro bem presente na angústia. — Salmos 46:1 (Almeida)',
  'O meu socorro vem do Senhor, que fez o céu e a terra. — Salmos 121:2 (Almeida)',
  'O Senhor te guardará de todo o mal; ele guardará a tua alma. — Salmos 121:7 (Almeida)',
  'Alegrai-vos na esperança, sede pacientes na tribulação, perseverai na oração. — Romanos 12:12 (Almeida)',
];
export class DailyVerseBroadcaster {
  constructor(private readonly store: Store,private readonly transport: WhatsAppTransport,private readonly groups: string[],private readonly timezone: string) {
    if(groups.some(g=>!/^\d+(?:-\d+)?@g\.us$/.test(g))) throw new Error('Disparos diários aceitam apenas grupos WhatsApp');
  }
  start(expression: string): ScheduledTask {
    if(!cron.validate(expression)) throw new Error('Cron diário inválido');
    return cron.schedule(expression,()=>this.broadcast(),{timezone:this.timezone,noOverlap:true});
  }
  private async verifyMembers(group:string):Promise<boolean> {
    const members=await this.transport.groupParticipants(group);
    if(!members.some(member=>member.isSelf)) return false;
    let verified=true;
    for(const member of members) {
      if(member.isSelf) continue;
      if(!member.phone) { verified=false;continue; }
      if(isEntitled(this.store.userByPhone(member.phone))) continue;
      this.store.queuePaymentReminder(member.phone);
      try { await this.transport.remove(group,member.phone); } catch { verified=false; }
    }
    if(!verified) return false;
    const updated=await this.transport.groupParticipants(group);
    return updated.some(member=>member.isSelf) && updated.every(member=>member.isSelf ||
      (!!member.phone && isEntitled(this.store.userByPhone(member.phone))));
  }
  async broadcast(now = new Date()): Promise<void> {
    if(!this.transport.connected) return;
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:this.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
    const index=Math.floor(Date.parse(`${day}T12:00:00Z`)/86400000)%verses.length;
    for(const group of new Set(this.groups)) {
      try {
        if(!await this.transport.isGroupAdmin(group) || !await this.verifyMembers(group)) continue;
      } catch { console.error('Não foi possível conferir assinaturas do grupo; disparo bloqueado.');continue; }
      const id=`${day}:${group}`;
      // Claim before send: if process dies after send, do not risk repeating a broadcast.
      if(!this.store.claimBroadcast(id)) continue;
      try { await this.transport.sendGroup(group,`Bom dia! 🌿\n\n${verses[index]}`); this.store.broadcastState(id,'sent'); }
      catch { this.store.broadcastState(id,'uncertain'); console.error('Disparo diário falhou; verifique antes de reenviar.'); }
    }
  }
}
