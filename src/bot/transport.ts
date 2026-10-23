export interface IncomingMessage {
  id: string; chatId: string; senderId: string; phone?: string; text: string; isGroup: boolean;
  location?: { latitude:number; longitude:number };
  rawKey?: unknown;
}
export interface GroupParticipant { id:string; phone?:string; isSelf:boolean }
export interface WhatsAppTransport {
  readonly connected: boolean;
  sendPrivate(recipientId: string,text: string): Promise<void>;
  sendGroup(groupId: string,text: string): Promise<void>;
  groupParticipants(groupId:string):Promise<GroupParticipant[]>;
  isGroupAdmin(groupId: string): Promise<boolean>;
  deleteMessage(message: IncomingMessage): Promise<void>;
  invite(groupId: string): Promise<string>;
  remove(groupId: string,phone: string): Promise<void>;
}
