export type UserStatus = 'PENDING_PAYMENT' | 'ACTIVE' | 'CANCELED' | 'OVERDUE';
export type Provider = 'mercadopago' | 'pagseguro';
export interface User {
  id: string; name: string; phone: string; email: string;
  status: UserStatus; subscription_id: string | null; provider: Provider | null;
  current_period_end: string | null; createdAt: string;
}
export interface ChurchEvent {
  id: string; churchName: string; address: string; latitude: number; longitude: number;
  serviceTimes: string[]; description: string; sourceUrl: string;
  startsAt: string; endsAt: string; fetchedAt: string;
}
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export function addMonth(date: Date): string {
  const d = new Date(date); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last)); return d.toISOString();
}
export function isEntitled(user: User | undefined, now = Date.now()): user is User {
  return !!user?.current_period_end && Date.parse(user.current_period_end) > now;
}
