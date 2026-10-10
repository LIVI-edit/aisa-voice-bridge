import test from 'node:test'; import assert from 'node:assert/strict';
import { loadConfig, validateRuntimeConfig, safeMessage } from '../src/config.js';
import { testEnv } from './fixtures/helpers.mjs';

test('T04 missing deployment route/policy keeps offline config loadable but blocks real start',()=>{
  const cfg=loadConfig({REAL_CALLS_ENABLED:'false'});assert.equal(cfg.realCallsEnabled,false);assert.equal(cfg.endpointAlias,null);assert.throws(()=>validateRuntimeConfig(cfg),/disabled/);
  const real=loadConfig({REAL_CALLS_ENABLED:'true',ASTERISK_OUTBOUND_ENDPOINT:'T',OUTBOUND_CALLER_ID:'+380441234567'});assert.throws(()=>validateRuntimeConfig(real),/policy|TELEPHONY/);
});
test('config preserves localhost ARI and loopback RTP only',()=>{
  assert.equal(loadConfig({}).ariUrl,'http://127.0.0.1:8088/ari');
  for(const env of [{ASTERISK_ARI_URL:'http://10.0.0.1:8088/ari'},{RTP_BIND_ADDRESS:'0.0.0.0'},{RTP_PAYLOAD_TYPE:'8'}])assert.throws(()=>loadConfig(env));
});
test('real runtime requires neutral endpoint, caller id, policy, approval and server secrets',()=>{
  const cfg=loadConfig(testEnv('/tmp/not-used.sqlite',true));assert.equal(validateRuntimeConfig(cfg),cfg);
  for(const key of ['ASTERISK_OUTBOUND_ENDPOINT','OUTBOUND_CALLER_ID','TELEPHONY_APPROVAL_REF','PRODUCTION_CALLING_POLICY_ID','ASTERISK_ARI_USER','ASTERISK_ARI_PASSWORD','OPENAI_API_KEY']){const env=testEnv('/tmp/x.sqlite',true);delete env[key];assert.throws(()=>validateRuntimeConfig(loadConfig(env)));}
});
test('T44 safe errors redact API/ARI auth and E.164 values',()=>{
  const cfg=loadConfig(testEnv('/tmp/x.sqlite',true));const basic=Buffer.from(`${cfg.ariUser}:${cfg.ariPassword}`).toString('base64');
  const m=safeMessage(new Error(`Bearer ${cfg.apiKey} Basic ${basic} password=${cfg.ariPassword} phone +380501234567`),cfg);
  assert.doesNotMatch(m,/sk-test|ari-test-secret|380501234567/);assert.match(m,/REDACTED|PHONE/);
});
