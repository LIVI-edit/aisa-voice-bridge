import test from 'node:test';import assert from 'node:assert/strict';
import { CallSession } from '../src/call-session.js';import { preparedFixture, FakeAri, FakeLive, FakeUdp } from './fixtures/helpers.mjs';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));async function until(fn,ms=300){for(let i=0;i<ms/2;i++){if(fn())return;await sleep(2)}throw new Error('condition timeout')}
function sessionFixture({ariOpts={},configPatch={},timers}={}){const f=preparedFixture({real:true});Object.assign(f.config,configPatch);const ari=new FakeAri(ariOpts),live=new FakeLive(),udp=new FakeUdp();const facts=[];const s=new CallSession(f.config,f.call,{ari,live,udp,onFact:x=>facts.push(x),timers:timers||undefined});return {f,ari,live,udp,facts,s};}
async function hangupAfterReady(x,event={type:'ChannelDestroyed',cause:16}){const p=x.s.run();await until(()=>x.live.greetings.length===1);x.ari.emit('event',{...event,channel:{id:x.f.call.phone_channel_id}});return p;}
test('neutral answered call uses saved route, callerId, mixing bridge, ExternalMedia and Asterisk absolute variable',async()=>{const x=sessionFixture();try{const r=await hangupAfterReady(x);const o=x.ari.requests.find(q=>q.method==='POST'&&q.path==='/channels');assert.equal(o.params.endpoint,'PJSIP/+380501234567@TEST_TRUNK');assert.equal(o.params.callerId,'+380441234567');assert.deepEqual(o.options.variables,{'TIMEOUT(absolute)':'375'});assert.equal(r.telephonyOutcome,'answered');assert.equal(r.cleanupState.phone,'absent');}finally{x.f.store.close()}});
test('T16 Up before bridge failure remains answered while processing fails',async()=>{const x=sessionFixture({ariOpts:{failBridge:true}});try{const r=await x.s.run();assert.equal(r.telephonyOutcome,'answered');assert.equal(r.failed,true);assert.ok(r.answeredAt);}finally{x.f.store.close()}});
test('T17 duplicate carrier events and late audio cross one cleanup fence and delete each known resource once',async()=>{const x=sessionFixture();try{const p=x.s.run();await until(()=>x.live.greetings.length===1);const e={type:'ChannelDestroyed',channel:{id:x.f.call.phone_channel_id},cause:16};x.ari.emit('event',e);x.ari.emit('event',e);x.live.emit('audio',Buffer.alloc(160,1));const r=await p;assert.equal(r.telephonyOutcome,'answered');for(const id of [x.f.call.phone_channel_id,x.f.call.media_channel_id])assert.equal(x.ari.requests.filter(q=>q.method==='DELETE'&&q.path===`/channels/${id}`).length,1);assert.equal(x.ari.requests.filter(q=>q.method==='DELETE'&&q.path===`/bridges/${x.f.call.bridge_id}`).length,1);assert.equal(x.udp.sent.length,0);}finally{x.f.store.close()}});
test('T18 StasisEnd followed by late ChannelDestroyed cause is retained during drain',async()=>{const x=sessionFixture();try{const p=x.s.run();await until(()=>x.live.greetings.length===1);x.ari.emit('event',{type:'StasisEnd',channel:{id:x.f.call.phone_channel_id}});x.ari.emit('event',{type:'ChannelDestroyed',channel:{id:x.f.call.phone_channel_id},cause:21});const r=await p;assert.equal(r.ariCause,21);assert.equal(r.telephonyOutcome,'answered');}finally{x.f.store.close()}});
test('T19 cleanup DELETE 500/timeout is unknown, not falsely absent',async()=>{const x=sessionFixture();try{const p=x.s.run();await until(()=>x.live.greetings.length===1);x.ari.deleteStatus[`/channels/${x.f.call.phone_channel_id}`]=500;x.ari.emit('event',{type:'ChannelDestroyed',channel:{id:x.f.call.phone_channel_id},cause:16});const r=await p;assert.equal(r.cleanupState.phone,'unknown');assert.equal(r.failed,true);}finally{x.f.store.close()}});
test('T20 OpenAI fault mid-call stops phone and does not fake finalization',async()=>{const x=sessionFixture();try{const p=x.s.run();await until(()=>x.live.greetings.length===1);x.live.close=async()=>({confirmed:false,latestUsageSeconds:1,finalUsageSeconds:null});x.live.emit('fault',new Error('provider lost'));const r=await p;assert.equal(r.telephonyOutcome,'answered');assert.equal(r.openaiFinalization,'unconfirmed');assert.equal(r.failed,true);}finally{x.f.store.close()}});
test('T21 process signal during setup uses bounded cleanup and no second start',async()=>{const x=sessionFixture();try{const p=x.s.run();await until(()=>x.ari.requests.some(q=>q.path==='/channels'));await x.s.cleanup('process_signal');const r=await p;assert.equal(r.terminationReason,'process_signal');assert.equal(x.ari.requests.filter(q=>q.method==='POST'&&q.path==='/channels').length,1);}finally{x.f.store.close()}});
test('T23 missing inbound RTP triggers media transport stop through independent timer',async()=>{let mediaCb;const timers={setTimeout:(fn,ms)=>{if(ms===15000)mediaCb=fn;return {fn,ms}},clearTimeout:()=>{}};const x=sessionFixture({timers});try{const p=x.s.run();await until(()=>x.live.greetings.length===1);assert.equal(typeof mediaCb,'function');mediaCb();const r=await p;assert.equal(r.failed,true);assert.equal(r.terminationReason,'media_error');}finally{x.f.store.close()}});
test('input RTP accepts current PCMU source and rejects foreign/stale packets',async()=>{const x=sessionFixture();try{const p=x.s.run();await until(()=>x.live.greetings.length===1);x.s.receiveRtp(Buffer.from([0x80,0x00,0,1,0,0,0,0,0,0,0,1,1,2]),{address:'127.0.0.1',port:9999});assert.equal(x.s.stats.foreign_packets,1);x.ari.emit('event',{type:'ChannelDestroyed',channel:{id:x.f.call.phone_channel_id},cause:16});await p;}finally{x.f.store.close()}});

test('T22 talk/overall deadline callbacks converge on one cleanup and do not duplicate resource deletion',async()=>{
  const callbacks=new Map();
  const timers={setTimeout:(fn,ms)=>{const h={fn,ms,id:Math.random()};if(!callbacks.has(ms))callbacks.set(ms,[]);callbacks.get(ms).push(h);return h;},clearTimeout:()=>{}};
  const x=sessionFixture({timers});
  try{
    const p=x.s.run(); await until(()=>x.live.greetings.length===1);
    assert.ok(callbacks.get(300000)?.length); assert.ok(callbacks.get(360000)?.length);
    callbacks.get(300000)[0].fn(); callbacks.get(360000)[0].fn();
    const r=await p; assert.equal(r.terminationReason,'max_duration');
    for(const id of [x.f.call.phone_channel_id,x.f.call.media_channel_id]) assert.equal(x.ari.requests.filter(q=>q.method==='DELETE'&&q.path===`/channels/${id}`).length,1);
  }finally{x.f.store.close()}
});

test('T23 stalled UDP bind is bounded and ExternalMedia end after answer is a processing failure',async()=>{
  {
    const f=preparedFixture({real:true}); const ari=new FakeAri(),live=new FakeLive(),udp=new FakeUdp(); udp.bind=()=>{}; f.config.requestTimeoutMs=5;
    const s=new CallSession(f.config,f.call,{ari,live,udp});
    try{const r=await s.run();assert.equal(r.failed,true);assert.equal(r.telephonyOutcome,'unknown_unanswered');assert.equal(ari.requests.filter(q=>q.method==='POST'&&q.path==='/channels').length,0);}finally{f.store.close()}
  }
  {
    const x=sessionFixture(); try{const p=x.s.run();await until(()=>x.live.greetings.length===1);x.ari.emit('event',{type:'StasisEnd',channel:{id:x.f.call.media_channel_id}});const r=await p;assert.equal(r.telephonyOutcome,'answered');assert.equal(r.terminationReason,'media_error');assert.equal(r.failed,true);}finally{x.f.store.close()}
  }
});

test('T45 transcript persistence failure triggers controlled stop and partial transcript instead of fake success',async()=>{
  const f=preparedFixture({real:true});const ari=new FakeAri(),live=new FakeLive(),udp=new FakeUdp();
  const s=new CallSession(f.config,f.call,{ari,live,udp,persistSegment:()=>{throw new Error('disk full on transcript')}});
  try{
    const p=s.run();await until(()=>live.greetings.length===1);
    live.emit('transcript',{eventId:'evt-segment-fail',speaker:'user',startMs:0,endMs:100,delta:'Тест'});
    const r=await p;assert.equal(r.failed,true);assert.equal(r.terminationReason,'persistence_error');assert.equal(r.telephonyOutcome,'answered');assert.equal(r.transcriptEnvelope.state,'partial');assert.ok(r.transcriptEnvelope.issues.includes('persistence_error'));
  }finally{f.store.close()}
});
