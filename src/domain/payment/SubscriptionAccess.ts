import { isEntitled } from '../models.js';
import { Store } from '../../infrastructure/Store.js';
import { DeliveryGuardError, SafeMessenger } from '../../bot/SafeMessenger.js';
import { PAYMENT_NOT_FOUND_MESSAGE } from './messages.js';
export { PAYMENT_NOT_FOUND_MESSAGE } from './messages.js';
export class SubscriptionAccess {
  constructor(private readonly store:Store,private readonly messenger:SafeMessenger) {}
  allowed(phone:string):boolean { return isEntitled(this.store.userByPhone(phone)); }
  async requestPayment(phone:string,recipient:string,prefix=''):Promise<void> {
    this.store.recordBotContact(phone);
    this.store.awaitPaymentReference(phone);
    try { await this.messenger.sendPrivate(recipient,prefix ? `${prefix}\n\n${PAYMENT_NOT_FOUND_MESSAGE}` : PAYMENT_NOT_FOUND_MESSAGE,
      ()=>!this.allowed(phone));
    } catch(error) {
      if(error instanceof DeliveryGuardError && this.allowed(phone)) { this.store.clearPaymentReference(phone);return; }
      throw error;
    }
    this.store.markPaymentPrompt(phone);
  }
  async require(phone:string,recipient:string):Promise<boolean> {
    if(this.allowed(phone)) return true;
    await this.requestPayment(phone,recipient); return false;
  }
  sendPaid(phone:string,recipient:string,text:string):Promise<void> {
    if(recipient !== `${phone}@s.whatsapp.net`) return Promise.reject(new Error('Destinatário não corresponde ao assinante'));
    return this.messenger.sendPrivate(recipient,text,()=>this.allowed(phone));
  }
}
