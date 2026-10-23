import type { Config } from '../../config.js';
import { isEntitled } from '../../domain/models.js';
import { Store } from '../../infrastructure/Store.js';
import { ChurchEventsScraper } from '../../scraper/ChurchEventsScraper.js';
import type { Advisor } from '../SpiritualAdvisor.js';
import { SafeMessenger } from '../SafeMessenger.js';
import type { IncomingMessage, WhatsAppTransport } from '../transport.js';
export class OrientationsHandler {
  private readonly busy = new Set<string>();
  constructor(private readonly store: Store,private readonly transport: WhatsAppTransport,private readonly messenger: SafeMessenger,
    private readonly advisor: Advisor,private readonly scraper: ChurchEventsScraper,private readonly cfg: Config) {}
  async handle(message: IncomingMessage): Promise<boolean> {
    const command = /^!meoriente(?:\s|$)/i.test(message.text);
    const forget = /^!esquecer\s*$/i.test(message.text);
    if(forget && !message.isGroup && message.phone) {
      this.store.clearHistory(message.phone); await this.messenger.sendPrivate(message.senderId,'Seu histórico e sua sessão foram apagados.'); return true;
    }
    if(!command && message.isGroup) return false;
    if(!message.phone) return false;
    const session = this.store.session(message.phone);
    if(!command && !session) return false;
    if(command && message.isGroup) {
      try { if(await this.transport.isGroupAdmin(message.chatId)) await this.transport.deleteMessage(message); } catch { /* Continue only in private even if deletion is unavailable. */ }
    }
    if(this.busy.has(message.phone)) return true;
    this.busy.add(message.phone);
    try {
      if(!isEntitled(this.store.userByPhone(message.phone))) {
        await this.messenger.sendPrivate(message.senderId,'Para iniciar ou renovar seu acesso, use a página de inscrição.'); return true;
      }
      const prompt = command ? message.text.replace(/^!meoriente\s*/i,'').trim() : message.text.trim();
      const ttl = this.cfg.SESSION_TTL_MINUTES*60000;
      if(command) await this.messenger.sendPrivate(message.senderId,'Vamos conversar por aqui, no privado. Mensagens do grupo podem já ter sido vistas. Não envie dados sensíveis. Use !esquecer para apagar seu histórico.');
      if(message.location && !message.isGroup && session?.location_pending) {
        this.store.setSession(message.phone,ttl,false);
        const events = await this.scraper.nearest(message.location.latitude,message.location.longitude,this.cfg.EVENT_RADIUS_KM,new Date(),this.cfg.TZ);
        const text = events.length ? events.map(e=>`${e.churchName} — ${e.distanceKm.toFixed(1)} km\n${e.address}\n${new Date(e.startsAt).toLocaleString('pt-BR',{timeZone:this.cfg.TZ})}\nFonte: ${e.sourceUrl}`).join('\n\n') : 'Não encontrei eventos confirmados para hoje nesse raio nas fontes configuradas. Confirme os horários diretamente com as igrejas.';
        await this.messenger.sendPrivate(message.senderId,text); return true;
      }
      if(/\b(culto|cultos|igreja|igrejas|evento|eventos)\b/i.test(prompt)) {
        this.store.setSession(message.phone,ttl,true);
        await this.messenger.sendPrivate(message.senderId,'Para buscar cultos de hoje por perto, envie sua localização atual nesta conversa privada: toque no clipe ou + → Localização → Enviar localização atual. As coordenadas serão usadas somente nesta busca.'); return true;
      }
      this.store.setSession(message.phone,ttl,!!session?.location_pending);
      if(!prompt) { await this.messenger.sendPrivate(message.senderId,'Como posso acolher você hoje? Conte apenas o que se sentir confortável em compartilhar.'); return true; }
      const answer = await this.advisor.reply(this.store.history(message.phone),prompt.slice(0,4000));
      this.store.append(message.phone,'user',prompt); this.store.append(message.phone,'assistant',answer);
      await this.messenger.sendPrivate(message.senderId,answer); return true;
    } catch {
      await this.messenger.sendPrivate(message.senderId,'Não consegui concluir agora. Tente novamente em alguns minutos. Se houver risco imediato, procure ajuda de emergência: 192 ou 190; apoio emocional: CVV 188.').catch(()=>undefined);
      return true;
    } finally { this.busy.delete(message.phone); }
  }
}
