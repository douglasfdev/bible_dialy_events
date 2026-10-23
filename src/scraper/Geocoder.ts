import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Store } from '../infrastructure/Store.js';
import { externalHttp } from '../infrastructure/http.js';
export interface Coordinates { latitude:number; longitude:number }
export interface Geocoder { locate(address:string):Promise<Coordinates | undefined> }
export class NominatimGeocoder implements Geocoder {
  private queue:Promise<unknown>=Promise.resolve();
  constructor(private readonly store:Store,private readonly contact:string) {
    z.email().parse(contact);
    store.db.exec('CREATE TABLE IF NOT EXISTS geocoding(address_hash TEXT PRIMARY KEY,latitude REAL,longitude REAL,expires_at INTEGER NOT NULL)');
  }
  locate(address:string):Promise<Coordinates | undefined> {
    const task=this.queue.catch(()=>undefined).then(()=>this.lookup(address));
    this.queue=task;return task;
  }
  private async lookup(address:string):Promise<Coordinates | undefined> {
    const key=createHash('sha256').update(address.trim().toLowerCase()).digest('hex');
    const cached=this.store.db.prepare('SELECT * FROM geocoding WHERE address_hash=? AND expires_at>?').get(key,Date.now());
    if(cached) return typeof cached.latitude === 'number' && typeof cached.longitude === 'number' ? {latitude:cached.latitude,longitude:cached.longitude} : undefined;
    // Public Nominatim policy: identifiable client, cache and at most one request per second.
    await delay(1100);
    const {data}=await externalHttp.get('https://nominatim.openstreetmap.org/search',{
      params:{q:address,format:'jsonv2',limit:1,countrycodes:'br'},maxRedirects:0,
      headers:{'User-Agent':`BibleDailyEvents/0.1 (${this.contact})`},
    });
    const result=z.array(z.object({lat:z.coerce.number().min(-90).max(90),lon:z.coerce.number().min(-180).max(180)})).parse(data)[0];
    this.store.db.prepare('INSERT OR REPLACE INTO geocoding VALUES(?,?,?,?)').run(key,result?.lat ?? null,result?.lon ?? null,Date.now()+30*86400000);
    return result ? {latitude:result.lat,longitude:result.lon} : undefined;
  }
}
