import makeWASocket, { DisconnectReason, jidNormalizedUser, useMultiFileAuthState, type WASocket, type WAMessageKey, normalizeMessageContent } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import type { GroupParticipant, IncomingMessage, WhatsAppTransport } from './transport.js';
export class BaileysTransport implements WhatsAppTransport {
  private socket?: WASocket;
  private ready = false;
  private stopped = false;
  private reconnect?: ReturnType<typeof setTimeout>;
  private retry = 0;
  onMessage?: (message: IncomingMessage)=>Promise<void>;
  onJoinRequest?: (groupId: string,participant: string)=>Promise<boolean>;
  constructor(private readonly authDir: string,private readonly allowedGroups: string[]) {}
  get connected(): boolean { return this.ready; }
  async start(): Promise<void> {
    const {state,saveCreds} = await useMultiFileAuthState(this.authDir);
    const socket = makeWASocket({auth:state,logger:pino({level:'silent'}),markOnlineOnConnect:false,syncFullHistory:false});
    this.socket=socket;
    socket.ev.on('creds.update',saveCreds);
    socket.ev.on('connection.update',update=>{
      if(update.qr) { console.info('WhatsApp: escaneie o QR apenas no terminal privado deste ambiente.'); qrcode.generate(update.qr,{small:true}); }
      if(update.connection === 'open') { this.ready=true; this.retry=0; console.info('WhatsApp conectado'); }
      if(update.connection === 'close') {
        this.ready=false;
        const status = (update.lastDisconnect?.error as {output?:{statusCode?:number}} | undefined)?.output?.statusCode;
        if(!this.stopped && status !== DisconnectReason.loggedOut) {
          this.reconnect=setTimeout(()=>void this.start().catch(()=>console.error('Falha ao reconectar WhatsApp')),Math.min(60000,2000*2**this.retry++));
        } else if(status === DisconnectReason.loggedOut) console.error('WhatsApp desconectado: novo pareamento necessário.');
      }
    });
    socket.ev.on('messages.upsert',async({messages,type})=>{
      if(type !== 'notify') return;
      for(const message of messages) {
        if(message.key.fromMe || !message.key.id || !message.key.remoteJid || !message.message) continue;
        const chatId=message.key.remoteJid;
        const isGroup=chatId.endsWith('@g.us');
        if(isGroup && !this.allowedGroups.includes(chatId)) continue;
        if(!isGroup && !chatId.endsWith('@s.whatsapp.net')) continue;
        const senderId=jidNormalizedUser(isGroup ? message.key.participant ?? '' : chatId);
        const phone=senderId.endsWith('@s.whatsapp.net') ? senderId.split('@')[0] : undefined;
        // LID identifiers are not phone numbers. Never guess identity or disclose subscriber data.
        if(!phone || !/^\d{8,15}$/.test(phone)) continue;
        const content=normalizeMessageContent(message.message);
        const text=content?.conversation ?? content?.extendedTextMessage?.text ?? '';
        const location=content?.locationMessage;
        const incoming: IncomingMessage={id:message.key.id,chatId,senderId,phone,text,isGroup,rawKey:message.key};
        if(location?.degreesLatitude != null && location.degreesLongitude != null)
          incoming.location={latitude:location.degreesLatitude,longitude:location.degreesLongitude};
        try { await this.onMessage?.(incoming); } catch { console.error('Falha ao processar mensagem WhatsApp'); }
      }
    });
    socket.ev.on('group.join-request',async event=>{
      if(!this.allowedGroups.includes(event.id) || event.action !== 'created') return;
      for(const participant of [event.participant]) {
        try {
          const allowed=await this.onJoinRequest?.(event.id,participant);
          await socket.groupRequestParticipantsUpdate(event.id,[participant],allowed ? 'approve' : 'reject');
        } catch { console.error('Falha ao avaliar solicitação de entrada'); }
      }
    });
  }
  private active(): WASocket { if(!this.ready || !this.socket) throw new Error('WhatsApp desconectado'); return this.socket; }
  async sendPrivate(recipientId: string,text: string): Promise<void> {
    if(!/^\d{8,15}@s\.whatsapp\.net$/.test(recipientId)) throw new Error('Destinatário privado inválido');
    await this.active().sendMessage(recipientId,{text});
  }
  async groupParticipants(groupId:string):Promise<GroupParticipant[]> {
    if(!this.allowedGroups.includes(groupId)) throw new Error('Grupo não autorizado');
    const socket=this.active();const own=jidNormalizedUser(socket.user?.id ?? '');
    const metadata=await socket.groupMetadata(groupId);
    return metadata.participants.map(participant=>{
      const id=jidNormalizedUser(participant.id);
      return {id,isSelf:id===own,phone:/^\d{8,15}@s\.whatsapp\.net$/.test(id) ? id.split('@')[0] : undefined};
    });
  }
  async isGroupAdmin(groupId: string): Promise<boolean> {
    if(!this.allowedGroups.includes(groupId) || !groupId.endsWith('@g.us')) return false;
    const socket=this.active(); const metadata=await socket.groupMetadata(groupId);
    const own=jidNormalizedUser(socket.user?.id ?? '');
    return metadata.participants.some(p=>jidNormalizedUser(p.id) === own && (p.admin === 'admin' || p.admin === 'superadmin'));
  }
  async sendGroup(groupId: string,text: string): Promise<void> {
    if(!await this.isGroupAdmin(groupId)) throw new Error('Bot precisa ser administrador de um grupo autorizado');
    await this.active().sendMessage(groupId,{text});
  }
  async deleteMessage(message: IncomingMessage): Promise<void> {
    if(message.rawKey && message.isGroup) await this.active().sendMessage(message.chatId,{delete:message.rawKey as WAMessageKey});
  }
  async invite(groupId: string): Promise<string> {
    if(!await this.isGroupAdmin(groupId)) throw new Error('Sem permissão de administrador');
    const metadata=await this.active().groupMetadata(groupId);
    if(!metadata.joinApprovalMode) throw new Error('Ative aprovação de novos participantes para proteger o acesso pago');
    const code=await this.active().groupInviteCode(groupId);
    if(!code) throw new Error('Convite não disponível');
    return `https://chat.whatsapp.com/${code}`;
  }
  async remove(groupId: string,phone: string): Promise<void> {
    if(!await this.isGroupAdmin(groupId)) throw new Error('Sem permissão de administrador');
    const jid=`${phone}@s.whatsapp.net`;
    const metadata=await this.active().groupMetadata(groupId);
    if(!metadata.participants.some(p=>jidNormalizedUser(p.id) === jid)) return;
    const result=await this.active().groupParticipantsUpdate(groupId,[jid],'remove');
    if(result.some(r=>r.status !== '200')) throw new Error('Falha ao remover participante');
  }
  stop(): void { this.stopped=true; this.ready=false; if(this.reconnect) clearTimeout(this.reconnect); this.socket?.end(new Error('Encerramento')); }
}
