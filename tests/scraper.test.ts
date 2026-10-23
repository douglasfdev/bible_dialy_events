import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/infrastructure/Store.js';
import { ChurchEventsScraper,haversine,parseEvents } from '../src/scraper/ChurchEventsScraper.js';
function markup(latitude:number,startDate='2090-01-01T12:00:00-03:00') {
  return `<script type="application/ld+json">${JSON.stringify({'@graph':[{'@type':'Event',name:'Culto',startDate,location:{name:'Igreja',address:{streetAddress:'Rua A',addressLocality:'São Paulo'},geo:{latitude,longitude:-46.63}}}]})}</script>`;
}
test('extracts JSON-LD graph with coordinates and rejects invalid/expired events',()=>{
  const now=new Date('2026-10-23T12:00:00Z');
  assert.equal(parseEvents(markup(-23.55),'https://church.example/agenda',now).length,1);
  assert.equal(parseEvents(markup(200),'https://church.example/agenda',now).length,0);
  assert.equal(parseEvents(markup(-23.55,'2020-01-01T10:00:00Z'),'https://church.example/agenda',now).length,0);
  assert.equal(parseEvents('<script type="application/ld+json">broken</script>','https://church.example',now).length,0);
});
test('Haversine returns zero for identical points and handles dateline',()=>{
  assert.equal(haversine({latitude:0,longitude:0},{latitude:0,longitude:0}),0);
  const distance=haversine({latitude:0,longitude:179.9},{latitude:0,longitude:-179.9});assert.ok(distance>22 && distance<23);
});
test('query filters local date and radius and sorts nearest first',async()=>{
  const store=new Store(':memory:');
  const date=new Date();date.setUTCDate(date.getUTCDate()+1);date.setUTCHours(12,0,0,0);const later=new Date(date.getTime()+30*60000).toISOString();
  const events=[...parseEvents(markup(-23.56,later),'https://church.example/near',date),...parseEvents(markup(-22,later),'https://church.example/far',date)];
  store.cacheEvents(events);const scraper=new ChurchEventsScraper(store,[]);
  const result=await scraper.nearest(-23.55,-46.63,20,date,'UTC');
  assert.equal(result.length,1);assert.ok(result[0]!.distanceKm<2);
  await assert.rejects(scraper.nearest(91,0));store.close();
});
test('geocoding supplies coordinates for a dated event whose source has only an address',()=>{
  const html=markup(-23.55).replace('"geo":{"latitude":-23.55,"longitude":-46.63}','"name":"Igreja"');
  const missing=new Set<string>();assert.equal(parseEvents(html,'https://church.example',new Date(),new Map(),missing).length,0);
  assert.deepEqual([...missing],['Rua A, São Paulo']);
  const coordinates=new Map([['Rua A, São Paulo',{latitude:-23.55,longitude:-46.63}]]);
  const events=parseEvents(html,'https://church.example',new Date(),coordinates);assert.equal(events.length,1);assert.equal(events[0]!.latitude,-23.55);
});
