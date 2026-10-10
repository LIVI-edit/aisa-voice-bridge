import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDialRoute, validateE164, validateEndpointAlias, validateDialNumberFormat } from '../src/telephony-route.js';

const phone='+380501234567', caller='+380441234567';
test('T01 neutral e164 route keeps plus and trusted alias/callerId',()=>{
  const r=buildDialRoute(phone,{endpointAlias:'TRUNK_1',dialNumberFormat:'e164',outboundCallerId:caller});
  assert.deepEqual(r,{endpoint:'PJSIP/+380501234567@TRUNK_1',callerId:caller,dialNumber:'+380501234567',targetE164:phone});
});
test('T02 international_digits removes only first plus and never mutates stored E.164',()=>{
  const r=buildDialRoute(phone,{endpointAlias:'TRUNK-2',dialNumberFormat:'international_digits',outboundCallerId:caller});
  assert.equal(r.endpoint,'PJSIP/380501234567@TRUNK-2');assert.equal(r.dialNumber,'380501234567');assert.equal(phone,'+380501234567');
});
test('T03 route rejects endpoint/URI/header/shell injection and malformed phone',()=>{
  for(const bad of ['x@y','x/../../','x;dial','x y','PJSIP/x',''])assert.throws(()=>validateEndpointAlias(bad));
  for(const bad of ['380501234567','+0123456789','+38050;rm -rf /','+38050@evil'])assert.throws(()=>validateE164(bad));
  assert.throws(()=>validateDialNumberFormat('custom_template')); assert.throws(()=>buildDialRoute(phone,{endpointAlias:'bad@x',dialNumberFormat:'e164',outboundCallerId:caller}));
});
