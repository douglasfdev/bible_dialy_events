import 'dotenv/config';
import { z } from 'zod';
const bool = z.enum(['true', 'false']).transform(v => v === 'true');
const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.url().default('http://localhost:3000'),
  DATA_DIR: z.string().default('./data'),
  TZ: z.string().default('America/Sao_Paulo'),
  WHATSAPP_ENABLED: bool.default(false),
  WHATSAPP_BOT_PHONE: z.string().regex(/^$|^[1-9]\d{7,14}$/).default(''),
  WHATSAPP_GROUP_IDS: z.string().default('').transform(s => s.split(',').map(v => v.trim()).filter(Boolean)),
  DAILY_CRON: z.string().default('0 6 * * *'),
  EXPIRATION_CRON: z.string().default('*/10 * * * *'),
  MERCADOPAGO_ACCESS_TOKEN: z.string().default(''),
  MERCADOPAGO_WEBHOOK_SECRET: z.string().default(''),
  PAYMENT_RETURN_URL: z.url().default('https://example.com/obrigado'),
  PAGSEGURO_TOKEN: z.string().default(''),
  PAGSEGURO_SANDBOX: bool.default(true),
  PAGSEGURO_ALLOW_ONE_TIME_FALLBACK: bool.default(false),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  EVENT_SOURCES_FILE: z.string().default(''),
  GEOCODING_CONTACT: z.string().default(''),
  EVENT_RADIUS_KM: z.coerce.number().positive().max(100).default(20),
  SESSION_TTL_MINUTES: z.coerce.number().positive().default(30),
  HISTORY_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
});
export const config = schema.parse({...process.env,OPENAI_API_KEY:process.env.SPIRITUAL_AI_API_KEY || process.env.OPENAI_API_KEY});
export type Config = z.infer<typeof schema>;
