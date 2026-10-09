import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { testEnv, TEST_PHONE } from './fixtures/helpers.mjs';

function ioCapture(){ const lines=[]; return {lines,io:{log:(x)=>lines.push(String(x)),warn:(x)=>lines.push(String(x)),error:(x)=>lines.push(String(x))}}; }
function parsedLast(cap){return JSON.parse(cap.lines.at(-1));}
function makeCliFixture(){
  const dir=mkdtempSync(join(tmpdir(),'aisa-cli-test-')); const dbPath=join(dir,'pilot.sqlite'); const csv=join(dir,'contacts.csv');
  writeFileSync(csv,`contact_id,company_id,company_name,person_name,role_title,phone_e164,language_preference,company_context,contact_context,phone_source_ref,context_source_ref\n,,Acme,Olena,CEO,${TEST_PHONE},uk,retail,decision maker,p-ref,c-ref\n`);
  const env=testEnv(dbPath,false,{ASTERISK_OUTBOUND_ENDPOINT:'',OUTBOUND_CALLER_ID:'',TELEPHONY_APPROVAL_REF:'',PRODUCTION_CALLING_POLICY_ID:'',ASTERISK_ARI_USER:'',ASTERISK_ARI_PASSWORD:'',OPENAI_API_KEY:''});
  return {dir,dbPath,csv,env};
}

test('T04 CLI offline import/list/approve/prepare/export works without ARI/OpenAI/provider deployment config',async()=>{
  const f=makeCliFixture(); let networkClients=0;
  const c1=ioCapture(); assert.equal(await runCli(['contacts','import-csv',f.csv],{env:f.env,io:c1.io,sessionFactory:()=>{networkClients++;},ariFactory:()=>{networkClients++;}}),0);
  assert.equal(parsedLast(c1).imported,1);
  const c2=ioCapture(); await runCli(['contacts','list'],{env:f.env,io:c2.io}); const contacts=parsedLast(c2); assert.equal(contacts.length,1); const id=contacts[0].contact_id;
  const c3=ioCapture(); await runCli(['contacts','approve',id,'--basis','test_authorized','--evidence','fixture-evidence','--policy','test-policy-v1'],{env:f.env,io:c3.io}); assert.equal(parsedLast(c3).contact_id,id);
  const c4=ioCapture(); await runCli(['calls','prepare',id,'--objective','initial_intro_operator'],{env:f.env,io:c4.io}); const call=parsedLast(c4); assert.equal(call.scenario_id,'initial_intro_operator'); assert.equal(call.config_snapshot.endpoint_alias,null); assert.equal(call.config_snapshot.real_calls_enabled,false);
  const jsonPath=join(f.dir,'export.json'); const c5=ioCapture(); await runCli(['export','json',jsonPath],{env:f.env,io:c5.io}); assert.equal(JSON.parse(readFileSync(jsonPath,'utf8')).contacts.length,1);
  assert.equal(networkClients,0);
});

test('T05 legacy raw-number invocation is removed and cannot originate',async()=>{
  const f=makeCliFixture(); let made=0; const cap=ioCapture();
  await assert.rejects(()=>runCli([TEST_PHONE],{env:f.env,io:cap.io,sessionFactory:()=>{made++;},ariFactory:()=>{made++;}}),/Unknown command/);
  assert.equal(made,0);
});

test('calls start requires stored call id and exact confirm-phone, while REAL_CALLS_ENABLED=false blocks before network',async()=>{
  const f=makeCliFixture();
  let cap=ioCapture(); await runCli(['contacts','import-csv',f.csv],{env:f.env,io:cap.io});
  cap=ioCapture(); await runCli(['contacts','list'],{env:f.env,io:cap.io}); const id=parsedLast(cap)[0].contact_id;
  cap=ioCapture(); await runCli(['contacts','approve',id,'--basis','test_authorized','--evidence','fixture-evidence','--policy','test-policy-v1'],{env:f.env,io:cap.io});
  cap=ioCapture(); await runCli(['calls','prepare',id,'--objective','initial_intro'],{env:f.env,io:cap.io}); const call=parsedLast(cap);
  let made=0;
  await assert.rejects(()=>runCli(['calls','start',call.call_id,'--confirm-phone',call.target_e164],{env:f.env,io:ioCapture().io,sessionFactory:()=>{made++;}}),/Real calls are disabled/);
  assert.equal(made,0);
});

test('review actor supplied in JSON is replaced by OS actor',async()=>{
  const f=makeCliFixture(); let captured=null;
  class FakeStore { constructor(){} applyReview(review){captured=review;return {ok:true};} close(){} }
  const resultId='00000000-0000-4000-8000-000000000001';
  const reviewPath=join(f.dir,'review.json');
  writeFileSync(reviewPath,JSON.stringify({
    review_id:'00000000-0000-4000-8000-000000000002',call_id:'00000000-0000-4000-8000-000000000003',result_id:resultId,
    expected_contact_revision:1,actor:{uid:999,user:'forged'},reviewed_at:'2026-10-09T02:00:00.000Z',decision:'inconclusive',dnc_action:'keep',
    corrected_semantic:null,accepted_next_action:null,contact_updates:{person_name:null,role_title:null,phone_e164:null},notes:'',evidence_event_ids:[]
  }));
  await runCli(['reviews','apply',resultId,'--file',reviewPath],{env:f.env,io:ioCapture().io,Store:FakeStore});
  assert.ok(captured); assert.notEqual(captured.actor.user,'forged'); assert.notEqual(captured.actor.uid,999);
});
