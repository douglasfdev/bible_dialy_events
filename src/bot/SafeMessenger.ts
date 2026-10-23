import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { WhatsAppTransport } from './transport.js';
export class SafeMessenger {
  private queue: Promise<void> = Promise.resolve();
  private readonly windows = new Map<string,{count:number;until:number}>();
  private queued = 0;
  constructor(private readonly transport: WhatsAppTransport,private readonly sleep:(ms:number)=>Promise<unknown> = delay) {}
  sendPrivate(recipientId: string,text: string): Promise<void> {
    const now = Date.now();
    for(const [key,value] of this.windows) if(value.until<=now) this.windows.delete(key);
    let window = this.windows.get(recipientId);
    if(!window || window.until<now) { window={count:0,until:now+60000}; this.windows.set(recipientId,window); }
    if(window.count>=6 || this.queued>=100) return Promise.reject(new Error('Limite de mensagens privadas atingido'));
    window.count++; this.queued++;
    const result = this.queue.catch(()=>undefined).then(async()=>{
      await this.sleep(randomInt(2000,5001)); await this.transport.sendPrivate(recipientId,text.slice(0,12000));
    }).finally(()=>{this.queued--;});
    this.queue=result; return result;
  }
}
