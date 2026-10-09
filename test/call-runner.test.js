import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareCall, startCall, recoverCalls, extractCall, validateDeploymentPolicy } from '../src/call-runner.js';
import { preparedFixture, makeFixture, testEnv, FakeAri, FakeLive, FakeUdp } from './fixtures/helpers.mjs';
import { CallSession } from '../src/call-session.js';
import { loadConfig } from '../src/config.js';

function fakeResult(call,{answered=true,cleanup={phone:'absent',media:'absent',bridge:'absent'},failed=false,reason='remote_hangup'}={}){
  return {
    failed,
    telephonyOutcome: answered ? 'answered' : (reason==='no_answer_timeout' ? 'no_answer' : 'failed'),
    terminationReason: reason,
    cleanupState: cleanup,
    transcriptEnvelope: {...call.transcript_envelope,state:answered?'unavailable':'not_applicable'},
    audioStats: call.audio_stats,
    openaiFinalization:'confirmed', latestUsageSeconds:1, finalUsageSeconds:1,
    answeredAt: answered?'2026-10-09T01:00:01.000Z':null, mediaReadyAt:answered?'2026-10-09T01:00:02.000Z':null,
    ariCause:null,dialstatus:null,
  };
}
function successfulSessionFactory(counter,{answered=true,cleanup,failed=false,reason}={}){
  return (_cfg,call,deps)=>({
    async run(){
      counter.created++;
      deps.beforeOriginate(); counter.originate++;
      deps.afterOriginate();
      if(answered) deps.onFact({kind:'answered',at:'2026-10-09T01:00:01.000Z'});
      return fakeResult(call,{answered,cleanup,failed,reason});
    },
    cleanup(){counter.signalCleanup=(counter.signalCleanup||0)+1;},
  });
}

test('T04 real start requires an enabled matching deployment policy while offline prepare remains possible',()=>{
  const f=makeFixture({real:false});
  try {
    const call=prepareCall({store:f.store,config:f.config,policy:f.policy,contactId:f.contactId,scenarioId:'initial_intro'});
    assert.equal(call.config_snapshot.real_calls_enabled,false);
    assert.throws(()=>validateDeploymentPolicy(f.config,f.policy),/Real calls disabled|Production calling policy|runtime/i);
    const realCfg=loadConfig(testEnv(f.dbPath,true));
    assert.throws(()=>validateDeploymentPolicy(realCfg,{...f.policy,real_calls_enabled:false}),/not enabled/);
    assert.throws(()=>validateDeploymentPolicy(realCfg,{...f.policy,production_calling_policy_id:'other'}),/mismatched/);
    assert.equal(validateDeploymentPolicy(realCfg,f.policy),true);
  } finally { f.store.close(); }
});

test('T07 gate changes block before any session/network client is created',async()=>{
  const f=preparedFixture({real:true}); let created=0;
  try {
    f.store.blockContact(f.contactId,{reason:'operator DNC',actor:{uid:1,user:'t'}});
    await assert.rejects(()=>startCall({store:f.store,config:f.config,policy:f.policy,callId:f.call.call_id,confirmPhone:f.call.target_e164,sessionFactory:()=>{created++;throw new Error('network client created')}}),/gate blocked|phone_hold/i);
    assert.equal(created,0);
    assert.equal(f.store.getCall(f.call.call_id).originate_intent_at,null);
  } finally { f.store.close(); }
});

test('T08 exact --confirm-phone mismatch is rejected before durable intent',async()=>{
  const f=preparedFixture({real:true}); let created=0;
  try {
    await assert.rejects(()=>startCall({store:f.store,config:f.config,policy:f.policy,callId:f.call.call_id,confirmPhone:'+380671111111',sessionFactory:()=>{created++;}}),/does not match/);
    assert.equal(created,0); assert.equal(f.store.getCall(f.call.call_id).originate_intent_at,null);
  } finally { f.store.close(); }
});

test('T09 one successful start dispatches at most one originate and replay cannot dispatch again',async()=>{
  const f=preparedFixture({real:true}); const counter={created:0,originate:0};
  try {
    const final=await startCall({store:f.store,config:f.config,policy:f.policy,callId:f.call.call_id,confirmPhone:f.call.target_e164,sessionFactory:successfulSessionFactory(counter)});
    assert.equal(final.state,'terminal'); assert.equal(final.telephony_outcome,'answered'); assert.equal(counter.originate,1);
    await assert.rejects(()=>startCall({store:f.store,config:f.config,policy:f.policy,callId:f.call.call_id,confirmPhone:f.call.target_e164,sessionFactory:successfulSessionFactory(counter)}),/not startable|prepared/i);
    assert.equal(counter.originate,1);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM call_events WHERE call_id=? AND kind='originate_intent'").get(f.call.call_id).n,1);
  } finally { f.store.close(); }
});

test('T12 crash after durable intent but before HTTP remains ambiguous and is never auto-redialed',async()=>{
  const f=preparedFixture({real:true}); let factoryCalls=0;
  try {
    await assert.rejects(()=>startCall({store:f.store,config:f.config,policy:f.policy,callId:f.call.call_id,confirmPhone:f.call.target_e164,sessionFactory:()=>{factoryCalls++;throw new Error('simulated crash before POST')}}),/simulated crash/);
    const stuck=f.store.getCall(f.call.call_id); assert.ok(stuck.originate_intent_at); assert.equal(stuck.originate_dispatched_at,null); assert.equal(factoryCalls,1);
    await assert.rejects(()=>startCall({store:f.store,config:f.config,policy:f.policy,callId:f.call.call_id,confirmPhone:f.call.target_e164,sessionFactory:()=>{factoryCalls++;}}),/not startable|prepared/i);
    assert.equal(factoryCalls,1);
    class A{async connect(){}async request(){return null}async exists(){return false}close(){}}
    const recovered=await recoverCalls({store:f.store,config:f.config,ariFactory:()=>new A(),isPidAlive:()=>false});
    assert.equal(recovered.recovered,1); assert.equal(f.store.getCall(f.call.call_id).termination_reason,'process_interrupted');
    assert.equal(f.store.getCall(f.call.call_id).end_observed_at,null);
  } finally { f.store.close(); }
});


test('T12 response received but dispatch-state DB write fails: no retry and saved resource id is cleaned',async()=>{
  const f=preparedFixture({real:true}); const ari=new FakeAri(),live=new FakeLive(),udp=new FakeUdp();
  try{
    f.store.markOriginateDispatched=()=>{throw new Error('disk failure after originate response')};
    const final=await startCall({store:f.store,config:f.config,policy:f.policy,callId:f.call.call_id,confirmPhone:f.call.target_e164,sessionFactory:(cfg,call,deps)=>new CallSession(cfg,call,{...deps,ari,live,udp})});
    assert.equal(ari.requests.filter(q=>q.method==='POST'&&q.path==='/channels').length,1);
    assert.equal(final.state,'terminal'); assert.equal(final.originate_dispatched_at,null); assert.equal(final.processing_status,'failed');
    assert.equal(final.cleanup_state.phone,'absent');
    await assert.rejects(()=>startCall({store:f.store,config:f.config,policy:f.policy,callId:f.call.call_id,confirmPhone:f.call.target_e164,sessionFactory:()=>{throw new Error('must not retry')}}),/not startable|prepared/i);
  } finally { f.store.close(); }
});

test('T14 no-answer never invokes semantic extraction',async()=>{
  const f=preparedFixture({real:true}); const counter={created:0,originate:0}; let extracted=0;
  try {
    const final=await startCall({store:f.store,config:f.config,policy:f.policy,callId:f.call.call_id,confirmPhone:f.call.target_e164,sessionFactory:successfulSessionFactory(counter,{answered:false,reason:'no_answer_timeout'})});
    assert.equal(final.telephony_outcome,'no_answer'); assert.equal(final.transcript_state,'not_applicable');
    const result=await extractCall({store:f.store,config:f.config,callId:f.call.call_id,extractor:{extract:async()=>{extracted++;}}});
    assert.deepEqual(result,{skipped:true,reason:'not_answered'}); assert.equal(extracted,0);
  } finally { f.store.close(); }
});

test('T19 terminal unknown cleanup holds the global pilot and blocks another start',async()=>{
  const f=makeFixture({real:true}); const c={created:0,originate:0};
  try {
    const first=prepareCall({store:f.store,config:f.config,policy:f.policy,contactId:f.contactId,scenarioId:'initial_intro'});
    const final=await startCall({store:f.store,config:f.config,policy:f.policy,callId:first.call_id,confirmPhone:first.target_e164,sessionFactory:successfulSessionFactory(c,{answered:false,cleanup:{phone:'unknown',media:'absent',bridge:'absent'},failed:true,reason:'ari_error'})});
    assert.equal(final.cleanup_state.phone,'unknown');
    const second=prepareCall({store:f.store,config:f.config,policy:f.policy,contactId:f.contactId,scenarioId:'executive_intro'});
    let secondMade=0;
    await assert.rejects(()=>startCall({store:f.store,config:f.config,policy:f.policy,callId:second.call_id,confirmPhone:second.target_e164,sessionFactory:()=>{secondMade++;}}),/cleanup|active|lock/i);
    assert.equal(secondMade,0); assert.equal(f.store.getCall(second.call_id).originate_intent_at,null);
  } finally { f.store.close(); }
});

test('T34 answered call remains review-held even when post-call extraction fails',async()=>{
  const f=preparedFixture({real:true}); const c={created:0,originate:0};
  try {
    await startCall({store:f.store,config:f.config,policy:f.policy,callId:f.call.call_id,confirmPhone:f.call.target_e164,sessionFactory:successfulSessionFactory(c)});
    const result=await extractCall({store:f.store,config:f.config,callId:f.call.call_id,extractor:{extract:async()=>({status:'failed',error_code:'http_429',semantic:null})}});
    assert.equal(result.status,'failed'); assert.equal(f.store.getContact(f.contactId).review_pending,true);
    assert.throws(()=>prepareCall({store:f.store,config:f.config,policy:f.policy,contactId:f.contactId,scenarioId:'initial_intro'}),/review_pending/);
  } finally { f.store.close(); }
});

test('T45 reserve failure creates no network session and finalize failure is not reported as success',async()=>{
  const f=preparedFixture({real:true}); let made=0;
  try {
    const orig=f.store.acquireStart.bind(f.store); f.store.acquireStart=()=>{throw new Error('disk full at reserve')};
    await assert.rejects(()=>startCall({store:f.store,config:f.config,policy:f.policy,callId:f.call.call_id,confirmPhone:f.call.target_e164,sessionFactory:()=>{made++;}}),/disk full/); assert.equal(made,0);
    f.store.acquireStart=orig;
  } finally { f.store.close(); }

  const g=preparedFixture({real:true}); const c={created:0,originate:0};
  try {
    const origFinalize=g.store.finalizeCall.bind(g.store); g.store.finalizeCall=()=>{throw new Error('disk full at finalize')};
    await assert.rejects(()=>startCall({store:g.store,config:g.config,policy:g.policy,callId:g.call.call_id,confirmPhone:g.call.target_e164,sessionFactory:successfulSessionFactory(c)}),/disk full at finalize/);
    const row=g.store.getCall(g.call.call_id); assert.notEqual(row.state,'terminal');
    g.store.finalizeCall=origFinalize;
  } finally { g.store.close(); }
});
