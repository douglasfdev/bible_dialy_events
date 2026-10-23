import express, {type ErrorRequestHandler} from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Store } from '../infrastructure/Store.js';
import { ServiceError, safeFailure } from '../infrastructure/http.js';
import type { IPaymentGateway, PaymentService, WebhookInput } from '../domain/payment/PaymentStrategy.js';
import type { WhatsAppTransport } from '../bot/transport.js';
import { resolve } from 'node:path';
const leadSchema=z.object({name:z.string().trim().min(2).max(100),
  phone:z.string().regex(/^\+?[1-9]\d{7,14}$/).transform(s=>s.replace(/^\+/,'')),
  email:z.email().max(254),consent:z.literal(true)});
export function createApp(cfg: Config,store: Store,payments: PaymentService,gateways: IPaymentGateway[],transport: WhatsAppTransport) {
  const app=express(); app.disable('x-powered-by'); app.set('trust proxy',cfg.TRUST_PROXY); app.use(helmet());
  app.use(express.json({limit:'32kb',verify:(req,_res,buf)=>{(req as typeof req & {rawBody:string}).rawBody=buf.toString('utf8');}}));
  app.get('/health',(_req,res)=>res.json({status:'ok',whatsapp:transport.connected ? 'connected' : cfg.WHATSAPP_ENABLED ? 'disconnected' : 'disabled',
    paymentsConfigured:!!cfg.MERCADOPAGO_ACCESS_TOKEN,aiConfigured:!!cfg.OPENAI_API_KEY}));
  app.post('/api/lead',rateLimit({windowMs:60000,limit:5,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res)=>{
    const lead=leadSchema.parse(req.body);
    if(!cfg.WHATSAPP_BOT_PHONE || !transport.connected) throw new ServiceError('Inscrições indisponíveis: WhatsApp ainda não conectado');
    const user=store.lead(lead.name,lead.phone,lead.email);
    // Phone ownership is verified by the bot before generating or disclosing a checkout.
    const whatsappUrl=`https://wa.me/${cfg.WHATSAPP_BOT_PHONE}?text=${encodeURIComponent(`!iniciar ${user.id}`)}`;
    res.status(201).json({whatsappUrl});
  });
  for(const gateway of gateways) {
    app.post(`/webhooks/${gateway.provider}`,rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res)=>{
      const headers: WebhookInput['headers']={};
      for(const name of ['x-signature','x-request-id','x-authenticity-token']) headers[name]=req.get(name);
      await payments.processWebhook(gateway,{body:req.body,rawBody:(req as typeof req & {rawBody?:string}).rawBody ?? '',headers,query:req.query});
      res.sendStatus(204);
    });
  }
  app.use(express.static(resolve('public')));
  app.use((_req,res)=>res.status(404).json({error:'NOT_FOUND'}));
  const errorHandler: ErrorRequestHandler=(error:unknown,_req,res,_next)=>{
    if(error instanceof z.ZodError) { res.status(400).json({error:'INVALID_INPUT'}); return; }
    if(error instanceof ServiceError) { res.status(error.status).json({error:error.code,message:error.message}); return; }
    if(error instanceof SyntaxError) { res.status(400).json({error:'INVALID_JSON'}); return; }
    console.error('Falha de requisição',safeFailure(error));
    res.status(503).json({error:'SERVICE_UNAVAILABLE'});
  };
  app.use(errorHandler); return app;
}
