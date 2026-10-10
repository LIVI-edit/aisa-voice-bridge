import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { VoiceStore } from '../../src/store.js';
import { importContactsCsv } from '../../src/import-export.js';
import { loadConfig } from '../../src/config.js';
import { prepareCall } from '../../src/call-runner.js';

export const TEST_PHONE = '+380501234567';
export const CALLER_ID = '+380441234567';
export const TEST_POLICY = Object.freeze({
  policy_version:'test-policy-v1', production_calling_policy_id:'owner-policy-1',
  allowed_authorization_basis_ids:['test_authorized'], test_authorization_basis_ids:['test_authorized'], real_calls_enabled:true,
});
export function testEnv(dbPath, real=false, extra={}) {
  return {
    AISA_VOICE_DB_PATH:dbPath, AISA_PILOT_POLICY_PATH:'./config/pilot-policy.example.json',
    ASTERISK_OUTBOUND_ENDPOINT:'TEST_TRUNK', DIAL_NUMBER_FORMAT:'e164', OUTBOUND_CALLER_ID:CALLER_ID,
    TELEPHONY_APPROVAL_REF:'provider-approval-test-ref', PRODUCTION_CALLING_POLICY_ID:'owner-policy-1',
    REAL_CALLS_ENABLED:String(real), ASTERISK_ARI_USER:'ari-test', ASTERISK_ARI_PASSWORD:'ari-test-secret', OPENAI_API_KEY:'sk-test-not-real',
    ...extra,
  };
}
export function makeFixture({real=false, phone=TEST_PHONE, approve=true, basis='test_authorized', now}={}) {
  const dir=mkdtempSync(join(tmpdir(),'aisa-voice-test-')); const dbPath=join(dir,'pilot.sqlite'); const csvPath=join(dir,'contacts.csv');
  writeFileSync(csvPath,`contact_id,company_id,company_name,person_name,role_title,phone_e164,language_preference,company_context,contact_context,phone_source_ref,context_source_ref\n,,Acme,Olena,CEO,${phone},uk,retail context,decision maker context,phone-ref,context-ref\n`);
  const store=new VoiceStore(dbPath,now?{now}:{}); const imported=importContactsCsv(store,csvPath); const contact=store.listContacts()[0];
  if(approve) store.approveContact(contact.contact_id,{basis,evidenceRef:'evidence-ref',policyVersion:'test-policy-v1',actor:{uid:1,user:'tester'}});
  const config=loadConfig(testEnv(dbPath,real));
  return {dir,dbPath,csvPath,store,contactId:contact.contact_id,companyId:contact.company_id,config,policy:{...TEST_POLICY},mapping:imported.mapping};
}
export function preparedFixture({real=false, scenarioId='initial_intro', ...opts}={}) {
  const f=makeFixture({real,...opts}); f.call=prepareCall({store:f.store,config:f.config,policy:f.policy,contactId:f.contactId,scenarioId,actor:{uid:1,user:'tester'}}); return f;
}

export class FakeLive extends EventEmitter {
  constructor(){super();this.latestUsageSeconds=0;this.finalUsageSeconds=0;this.closed=false;this.audio=[];this.greetings=[]}
  async connect(){this.emit('sessionStarted',{sessionId:'live_test_session'});}
  appendAudio(bytes){this.audio.push(Buffer.from(bytes));}
  greet(text){this.greetings.push(text);}
  async close(){this.closed=true;return {confirmed:true,latestUsageSeconds:this.latestUsageSeconds,finalUsageSeconds:this.finalUsageSeconds};}
}
export class FakeUdp extends EventEmitter {
  constructor(){super();this.port=25000;this.closed=false;this.sent=[]}
  bind(){queueMicrotask(()=>this.emit('listening'));}
  address(){return {address:'127.0.0.1',port:this.port};}
  send(buf,port,host,cb){this.sent.push({buf:Buffer.from(buf),port,host});cb?.();}
  close(cb){this.closed=true;cb?.();}
}
export class FakeAri extends EventEmitter {
  constructor({autoAnswer=true,failBridge=false,deleteStatus={},dialstatus=null,cause=null}={}){super();this.autoAnswer=autoAnswer;this.failBridge=failBridge;this.deleteStatus=deleteStatus;this.dialstatus=dialstatus;this.cause=cause;this.requests=[];this.resources=new Set();this.closed=false;}
  async connect(){}
  async request(method,path,params={},options={}){
    this.requests.push({method,path,params,options});
    if(method==='POST'&&path==='/channels'){
      this.resources.add(`/channels/${params.channelId}`);
      if(this.dialstatus)queueMicrotask(()=>this.emit('event',{type:'Dial',channel:{id:params.channelId},dialstatus:this.dialstatus}));
      if(this.autoAnswer)queueMicrotask(()=>this.emit('event',{type:'StasisStart',channel:{id:params.channelId,state:'Up'}}));
      return {id:params.channelId};
    }
    if(method==='POST'&&path.startsWith('/bridges/')&&!path.endsWith('/addChannel')){if(this.failBridge)throw new Error('bridge fail');this.resources.add(path);return {}}
    if(method==='POST'&&path==='/channels/externalMedia'){this.resources.add(`/channels/${params.channelId}`);queueMicrotask(()=>this.emit('event',{type:'StasisStart',channel:{id:params.channelId,state:'Up'}}));return {}}
    if(method==='GET'&&path.endsWith('/variable'))return {value:params.variable==='UNICASTRTP_LOCAL_ADDRESS'?'127.0.0.1':'26000'};
    if(method==='DELETE'){const forced=this.deleteStatus[path];if(forced)throw Object.assign(new Error('delete failed'),{status:forced});this.resources.delete(path);return null;}
    return {};
  }
  async exists(path){return this.resources.has(path);}
  close(){this.closed=true;}
}
