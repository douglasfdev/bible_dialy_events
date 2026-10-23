import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChurchEvent, Provider, User } from '../domain/models.js';
export class Store {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT', subscription_id TEXT, provider TEXT,
        current_period_end TEXT, createdAt TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS subscription_idx ON users(provider, subscription_id);
      CREATE TABLE IF NOT EXISTS checkouts(user_id TEXT PRIMARY KEY REFERENCES users(id), provider TEXT NOT NULL,
        subscription_id TEXT NOT NULL, url TEXT NOT NULL, billing_mode TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payment_events(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, phone TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_phone_idx ON messages(phone, created_at);
      CREATE TABLE IF NOT EXISTS sessions(phone TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, location_pending INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, latitude REAL NOT NULL, longitude REAL NOT NULL,
        starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_geo_idx ON events(latitude, longitude);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, kind TEXT NOT NULL, recipient TEXT NOT NULL,
        content TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS broadcasts(id TEXT PRIMARY KEY, state TEXT NOT NULL);
    `);
  }
  close(): void { this.db.close(); }
  userByPhone(phone: string): User | undefined { return this.db.prepare('SELECT * FROM users WHERE phone=?').get(phone) as unknown as User | undefined; }
  userById(id: string): User | undefined { return this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as unknown as User | undefined; }
  userBySubscription(provider: Provider, id: string): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE provider=? AND subscription_id=?').get(provider, id) as unknown as User | undefined;
  }
  lead(name: string, phone: string, email: string): User {
    const existing = this.userByPhone(phone);
    if (existing) return existing;
    const id = randomUUID();
    this.db.prepare('INSERT INTO users(id,name,phone,email,createdAt) VALUES(?,?,?,?,?)').run(id,name,phone,email,new Date().toISOString());
    return this.userById(id)!;
  }
  checkout(userId: string): { provider: Provider; subscription_id: string; url: string; billing_mode: 'recurring' | 'one_time'; created_at: string } | undefined {
    return this.db.prepare('SELECT * FROM checkouts WHERE user_id=?').get(userId) as ReturnType<Store['checkout']>;
  }
  saveCheckout(userId: string, provider: Provider, id: string, url: string, mode: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE users SET provider=?, subscription_id=? WHERE id=?').run(provider,id,userId);
      this.db.prepare('INSERT OR REPLACE INTO checkouts VALUES(?,?,?,?,?,?)').run(userId,provider,id,url,mode,new Date().toISOString());
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  activate(eventId: string, user: User, periodEnd: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const added = this.db.prepare('INSERT OR IGNORE INTO payment_events VALUES(?,?,?)').run(eventId,user.id,new Date().toISOString()).changes;
      if (!added) { this.db.exec('COMMIT'); return false; }
      // Never shorten paid access when duplicate/out-of-order events arrive.
      this.db.prepare(`UPDATE users SET status='ACTIVE', current_period_end=MAX(COALESCE(current_period_end,''),?) WHERE id=?`).run(periodEnd,user.id);
      this.enqueue(`welcome:${eventId}`, 'welcome', user.phone, 'Seu pagamento foi confirmado. Seu acesso à comunidade está disponível.');
      this.db.exec('COMMIT'); return true;
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  cancel(userId: string): void { this.db.prepare("UPDATE users SET status='CANCELED' WHERE id=?").run(userId); }
  expire(now = new Date().toISOString()): number {
    const users = this.db.prepare("SELECT * FROM users WHERE current_period_end<=? AND status IN ('ACTIVE','CANCELED')").all(now) as unknown as User[];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const user of users) {
        this.db.prepare("UPDATE users SET status='OVERDUE' WHERE id=?").run(user.id);
        this.enqueue(`revoke:${user.id}:${user.current_period_end}`, 'revoke',user.phone,'Seu período de acesso terminou. Renove para voltar à comunidade.');
      }
      this.db.exec('COMMIT'); return users.length;
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  enqueue(id: string, kind: string, phone: string, content: string): void {
    this.db.prepare('INSERT OR IGNORE INTO deliveries(id,kind,recipient,content) VALUES(?,?,?,?)').run(id,kind,phone,content);
  }
  pendingDeliveries(): { id: string; kind: string; recipient: string; content: string }[] {
    return this.db.prepare('SELECT * FROM deliveries WHERE delivered=0 ORDER BY rowid LIMIT 20').all() as ReturnType<Store['pendingDeliveries']>;
  }
  delivered(id: string): void { this.db.prepare('UPDATE deliveries SET delivered=1 WHERE id=?').run(id); }
  deliveryFailed(id: string): void { this.db.prepare('UPDATE deliveries SET attempts=attempts+1 WHERE id=?').run(id); }
  session(phone: string): { expires_at: number; location_pending: number } | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE phone=? AND expires_at>?').get(phone,Date.now()) as ReturnType<Store['session']>;
  }
  setSession(phone: string, ttl: number, pending = false): void {
    this.db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?)').run(phone,Date.now()+ttl,Number(pending));
  }
  clearHistory(phone: string): void {
    this.db.prepare('DELETE FROM messages WHERE phone=?').run(phone);
    this.db.prepare('DELETE FROM sessions WHERE phone=?').run(phone);
  }
  history(phone: string): ChatMessage[] {
    return (this.db.prepare('SELECT role,content FROM messages WHERE phone=? ORDER BY id DESC LIMIT 16').all(phone) as unknown as ChatMessage[]).reverse();
  }
  append(phone: string, role: ChatMessage['role'], content: string): void {
    this.db.prepare('INSERT INTO messages(phone,role,content,created_at) VALUES(?,?,?,?)').run(phone,role,content.slice(0,6000),Date.now());
    this.db.prepare('DELETE FROM messages WHERE phone=? AND id NOT IN (SELECT id FROM messages WHERE phone=? ORDER BY id DESC LIMIT 16)').run(phone,phone);
  }
  pruneHistory(days: number): void {
    this.db.prepare('DELETE FROM messages WHERE created_at<?').run(Date.now()-days*86400000);
    this.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
  }
  cacheEvents(events: ChurchEvent[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const event of events) this.db.prepare('INSERT OR REPLACE INTO events VALUES(?,?,?,?,?,?)').run(event.id,event.latitude,event.longitude,event.startsAt,event.endsAt,JSON.stringify(event));
      this.db.prepare('DELETE FROM events WHERE ends_at<?').run(new Date().toISOString());
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  nearbyCandidates(lat: number, lon: number, radius: number, start: string, end: string): ChurchEvent[] {
    const dlat = radius/111.195; const dlon = Math.min(180, radius/(111.195*Math.max(0.001,Math.cos(lat*Math.PI/180))));
    return this.db.prepare(`SELECT json FROM events WHERE latitude BETWEEN ? AND ?
      AND (ABS(longitude-?)<=? OR ABS(longitude-?)>=?) AND starts_at<=? AND ends_at>=?`).all(lat-dlat,lat+dlat,lon,dlon,lon,360-dlon,end,start).map(r => JSON.parse(r.json as string) as ChurchEvent);
  }
  claimBroadcast(id: string): boolean {
    return !!this.db.prepare("INSERT OR IGNORE INTO broadcasts VALUES(?,'sending')").run(id).changes;
  }
  broadcastState(id: string, state: string): void { this.db.prepare('UPDATE broadcasts SET state=? WHERE id=?').run(state,id); }
}
