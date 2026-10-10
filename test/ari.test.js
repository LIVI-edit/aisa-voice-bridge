import test from 'node:test'; import assert from 'node:assert/strict'; import { EventEmitter } from 'node:events';
import { AriClient, waitForAriEvent } from '../src/ari.js';
const config={ariUrl:'http://127.0.0.1:8088/ari',ariUser:'bridge',ariPassword:'dummy-password',requestTimeoutMs:50,connectTimeoutMs:50};
test('ARI REST encodes route query, Basic auth, and variables use JSON body',async()=>{
 const req=[];const ari=new AriClient(config,'app',{fetchImpl:async(url,options)=>{req.push({url:new URL(url),options});return new Response(JSON.stringify({value:'123'}),{status:200})}});
 await ari.request('POST','/channels',{endpoint:'PJSIP/+380501234567@TEST_TRUNK',app:'app'},{variables:{'TIMEOUT(absolute)':'375'}});
 assert.equal(req[0].url.searchParams.get('endpoint'),'PJSIP/+380501234567@TEST_TRUNK');assert.equal(req[0].url.searchParams.has('variables'),false);assert.deepEqual(JSON.parse(req[0].options.body),{variables:{'TIMEOUT(absolute)':'375'}});assert.equal(req[0].options.headers['Content-Type'],'application/json');
 assert.equal(req[0].options.headers.Authorization,`Basic ${Buffer.from('bridge:dummy-password').toString('base64')}`);
});
test('cleanup accepts only 404 as absent and never exposes response body',async()=>{
 let status=404;const ari=new AriClient(config,'app',{fetchImpl:async()=>new Response('secret-body',{status})});assert.equal(await ari.request('DELETE','/channels/id',{}, {ignoreMissing:true}),null);
 status=401;await assert.rejects(ari.request('DELETE','/channels/id',{}, {ignoreMissing:true}),e=>e.status===401&&!/secret-body/.test(e.message));status=500;await assert.rejects(ari.request('GET','/channels/id'),e=>e.status===500);
});
test('ARI fetch transport failure is bounded safe error',async()=>{const ari=new AriClient(config,'app',{fetchImpl:async()=>{throw new Error('secret')}});await assert.rejects(ari.request('GET','/channels'),e=>/unavailable/.test(e.message)&&!/secret/.test(e.message));});
test('ARI event wait subscribes before action and releases listeners on success/abort/fault/timeout',async()=>{
 const ok=new EventEmitter(),ac=new AbortController();const w=waitForAriEvent(ok,e=>e.channel?.id==='x',100,ac.signal);ok.emit('event',{channel:{id:'x'}});assert.equal((await w).channel.id,'x');assert.equal(ok.listenerCount('event'),0);
 for(const mode of ['abort','fault','timeout']){const a=new EventEmitter(),s=new AbortController(),p=waitForAriEvent(a,()=>false,5,s.signal);if(mode==='abort')s.abort();if(mode==='fault')a.emit('fault',new Error('x'));await assert.rejects(p);assert.equal(a.listenerCount('event'),0)}
});
