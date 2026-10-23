import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { z } from 'zod';
import type { ChurchEvent } from '../domain/models.js';
import { Store } from '../infrastructure/Store.js';
import type { Coordinates, Geocoder } from './Geocoder.js';
import { externalHttp } from '../infrastructure/http.js';
const sourceSchema = z.object({
  url:z.url().refine(v=>new URL(v).protocol === 'https:'),
  allowedHost:z.string().min(1),
  // Configure vetted public sources only. JSON-LD Event avoids fragile invented selectors.
});
export type EventSource = z.infer<typeof sourceSchema>;
const eventSchema = z.object({
  name:z.string(),startDate:z.iso.datetime({offset:true}),endDate:z.iso.datetime({offset:true}).optional(),
  description:z.string().default(''),
  location:z.object({name:z.string().optional(),
    address:z.union([z.string(),z.object({streetAddress:z.string(),addressLocality:z.string().optional(),addressRegion:z.string().optional()})]),
    geo:z.object({latitude:z.coerce.number().min(-90).max(90),longitude:z.coerce.number().min(-180).max(180)}).optional()}),
});
export function haversine(a: {latitude:number;longitude:number}, b: {latitude:number;longitude:number}): number {
  const rad = (v:number)=>v*Math.PI/180;
  const dlat = rad(b.latitude-a.latitude), dlon = rad(b.longitude-a.longitude);
  const h = Math.sin(dlat/2)**2 + Math.cos(rad(a.latitude))*Math.cos(rad(b.latitude))*Math.sin(dlon/2)**2;
  return 6371.0088*2*Math.asin(Math.sqrt(Math.min(1,Math.max(0,h))));
}
export function parseEvents(html: string, sourceUrl: string, now = new Date(), coordinates = new Map<string,Coordinates>(), missingAddresses?: Set<string>): ChurchEvent[] {
  const $ = cheerio.load(html); const events: ChurchEvent[] = [];
  const visit = (node: unknown): void => {
    if(Array.isArray(node)) { node.forEach(visit); return; }
    if(!node || typeof node !== 'object') return;
    const value = node as Record<string,unknown>;
    if(value['@graph']) visit(value['@graph']);
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if(!types.some(type=>typeof type === 'string' && /(?:^|\/)Event$/.test(type))) return;
    const result = eventSchema.safeParse(value); if(!result.success) return;
    const event = result.data;
    const address = typeof event.location.address === 'string' ? event.location.address :
      [event.location.address.streetAddress,event.location.address.addressLocality,event.location.address.addressRegion].filter(Boolean).join(', ');
    const geo = event.location.geo ?? coordinates.get(address);
    if(!geo) { missingAddresses?.add(address); return; }
    if(typeof value.eventStatus === 'string' && value.eventStatus.endsWith('EventCancelled')) return;
    const end = event.endDate ?? new Date(Date.parse(event.startDate)+2*3600000).toISOString();
    if(Date.parse(end) < now.getTime() || Date.parse(end)<Date.parse(event.startDate)) return;
    events.push({id:createHash('sha256').update(`${sourceUrl}|${event.name}|${event.startDate}|${address}`).digest('hex'),
      churchName:event.location.name ?? event.name,address,latitude:geo.latitude,longitude:geo.longitude,
      serviceTimes:[event.startDate],description:cheerio.load(event.description).text().slice(0,1500),sourceUrl,
      startsAt:new Date(event.startDate).toISOString(),endsAt:new Date(end).toISOString(),fetchedAt:now.toISOString()});
  };
  $('script[type="application/ld+json"]').each((_,element)=>{ try { visit(JSON.parse($(element).text())); } catch { /* A broken block does not invalidate other events. */ } });
  return events;
}
export class ChurchEventsScraper {
  private refreshedAt = 0;
  private refreshing?: Promise<number>;
  constructor(private readonly store: Store,private readonly sources: EventSource[],private readonly geocoder?: Geocoder) {}
  static async loadSources(file: string): Promise<EventSource[]> {
    return file ? z.array(sourceSchema).parse(JSON.parse(await readFile(file,'utf8'))) : [];
  }
  refresh(): Promise<number> {
    if(this.refreshing) return this.refreshing;
    this.refreshing = this.fetchSources().finally(()=>{this.refreshing=undefined;});
    return this.refreshing;
  }
  private async fetchSources(): Promise<number> {
    let count = 0; let successes = 0;
    for(const source of this.sources) {
      const url = new URL(source.url);
      // Sources are operator configuration, never a URL from user chat. Disable redirects to avoid host escapes.
      if(url.protocol !== 'https:' || url.hostname !== source.allowedHost || url.username || url.password || url.port) throw new Error('Fonte de eventos inválida');
      try {
        const {data} = await externalHttp.get<string>(url.href,{maxRedirects:0,responseType:'text',headers:{'User-Agent':'BibleDailyEvents/0.1 (event calendar reader)'}});
        const missing = new Set<string>();
        const coordinates = new Map<string,Coordinates>();
        parseEvents(data,url.href,new Date(),coordinates,missing);
        if(this.geocoder) for(const address of missing) {
          const point=await this.geocoder.locate(address); if(point) coordinates.set(address,point);
        }
        const events = parseEvents(data,url.href,new Date(),coordinates); this.store.cacheEvents(events); count+=events.length; successes++;
      } catch { /* Keep cached valid events if an individual source is unavailable. */ }
    }
    if(this.sources.length && !successes) throw new Error('Nenhuma fonte de eventos pôde ser atualizada');
    this.refreshedAt=Date.now(); return count;
  }
  async nearest(latitude: number,longitude: number,radius = 20,now = new Date(),timezone = 'America/Sao_Paulo'): Promise<(ChurchEvent & {distanceKm:number})[]> {
    if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180) throw new Error('Coordenadas inválidas');
    if(Date.now()-this.refreshedAt>3600000) await this.refresh();
    // Broad UTC window followed by local-day filtering, including timezone boundaries.
    const day = (date:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
    const today = day(now);
    return this.store.nearbyCandidates(latitude,longitude,radius,new Date(now.getTime()-86400000).toISOString(),new Date(now.getTime()+86400000).toISOString())
      .filter(e=>day(new Date(e.startsAt)) === today && Date.parse(e.endsAt)>=now.getTime())
      .map(e=>({...e,distanceKm:haversine({latitude,longitude},e)})).filter(e=>e.distanceKm<=radius)
      .sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,5);
  }
}
