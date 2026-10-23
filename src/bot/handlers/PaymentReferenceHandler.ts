import type { IncomingMessage } from '../transport.js';
import type { Provider } from '../../domain/models.js';
import { Store } from '../../infrastructure/Store.js';
import { ServiceError } from '../../infrastructure/http.js';
import { PaymentService } from '../../domain/payment/PaymentStrategy.js';
import { SubscriptionAccess, PAYMENT_NOT_FOUND_MESSAGE } from '../../domain/payment/SubscriptionAccess.js';
import { SafeMessenger } from '../SafeMessenger.js';
export class PaymentReferenceHandler {
  private readonly busy=new Set<string>();
  constructor(private readonly store:Store,private readonly payments:PaymentService,private readonly messenger:SafeMessenger,
    private readonly access:SubscriptionAccess) {}
  async handle(message:IncomingMessage):Promise<boolean> {
    if(!message.phone) return false;
    const command=/^!pagamento(?:\s|$)/i.test(message.text);
    if(message.isGroup) {
      if(!command) return false;
      this.store.recordBotContact(message.phone);
      await this.messenger.sendPrivate(message.senderId,'Envie o número do pagamento somente nesta conversa privada: !pagamento <número>. No PagBank, use o ID do pedido ORDE_…');
      return true;
    }
    const raw=message.text.trim();
    const plain=this.store.awaitingPaymentReference(message.phone) && /^(?:\d{1,30}|ORDE_[A-Z0-9-]{1,80})$/i.test(raw);
    if(!command && !plain) return false;
    if(this.busy.has(message.phone)) return true;
    this.busy.add(message.phone);
    this.store.recordBotContact(message.phone);
    try {
      const match=/^(?:!pagamento\s+)?(?:(mercadopago|pagseguro)\s+)?(\d{1,30}|ORDE_[A-Z0-9-]{1,80})$/i.exec(raw);
      if(!match) {
        await this.messenger.sendPrivate(message.senderId,'Envie !pagamento <número>. Exemplo Mercado Pago: !pagamento 123456789. PagBank: !pagamento ORDE_… Não envie dados de cartão ou senhas.');return true;
      }
      const confirmed=await this.payments.reconcilePayment(message.phone,match[2]!,match[1]?.toLowerCase() as Provider | undefined);
      if(confirmed) await this.access.sendPaid(message.phone,message.senderId,'Pagamento confirmado para este número e mensalidade vigente. Você pode continuar usando !meoriente; o acesso ao grupo será enviado no privado.');
      else {
        this.store.awaitPaymentReference(message.phone);
        await this.messenger.sendPrivate(message.senderId,`Não conseguimos confirmar uma mensalidade vigente desse pagamento para este número. Confira o identificador ou aguarde a confirmação do provedor.\n\n${PAYMENT_NOT_FOUND_MESSAGE}`);
      }
    } catch(error) {
      await this.messenger.sendPrivate(message.senderId,error instanceof ServiceError ? error.message : 'Não foi possível confirmar agora. Tente novamente mais tarde.');
    } finally { this.busy.delete(message.phone); }
    return true;
  }
}
