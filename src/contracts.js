import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const contractsSchema = JSON.parse(readFileSync(resolve(here, '../schemas/contracts.v1.schema.json'), 'utf8'));
export const postCallSemanticSchema = JSON.parse(readFileSync(resolve(here, '../schemas/post-call-semantics.v1.schema.json'), 'utf8'));
const require = createRequire(import.meta.url);

function internalValidate(schema, data, root, path = '$') {
  const errors = [];
  const visit = (s, v, p) => {
    if (s.$ref) {
      const m = /^#\/definitions\/([^/]+)$/.exec(s.$ref);
      if (!m) { errors.push(`${p}: unsupported ref`); return; }
      return visit(root.definitions[m[1]], v, p);
    }
    if (s.anyOf) {
      const variants = s.anyOf.map((x) => { const before=errors.length; const local=[]; const save=errors.splice(0); visit(x,v,p); const added=errors.splice(0); errors.push(...save); return added; });
      if (!variants.some((x)=>x.length===0)) errors.push(`${p}: no anyOf variant matched`);
      return;
    }
    if ('const' in s && v !== s.const) errors.push(`${p}: must equal const`);
    if (s.type === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${p}: expected object`); return; }
      for (const req of s.required || []) if (!(req in v)) errors.push(`${p}.${req}: required`);
      if (s.additionalProperties === false) for (const k of Object.keys(v)) if (!s.properties?.[k]) errors.push(`${p}.${k}: additional property`);
      for (const [k,child] of Object.entries(s.properties||{})) if (k in v) visit(child,v[k],`${p}.${k}`);
    } else if (s.type === 'array') {
      if (!Array.isArray(v)) { errors.push(`${p}: expected array`); return; }
      if (s.maxItems != null && v.length > s.maxItems) errors.push(`${p}: too many items`);
      if (s.minItems != null && v.length < s.minItems) errors.push(`${p}: too few items`);
      v.forEach((x,i)=>visit(s.items,x,`${p}[${i}]`));
    } else if (s.type === 'string') {
      if (typeof v !== 'string') { errors.push(`${p}: expected string`); return; }
      if (s.minLength != null && v.length < s.minLength) errors.push(`${p}: too short`);
      if (s.maxLength != null && v.length > s.maxLength) errors.push(`${p}: too long`);
      if (s.pattern && !(new RegExp(s.pattern)).test(v)) errors.push(`${p}: pattern mismatch`);
      if (s.enum && !s.enum.includes(v)) errors.push(`${p}: invalid enum`);
    } else if (s.type === 'integer') {
      if (!Number.isInteger(v)) errors.push(`${p}: expected integer`);
      else { if (s.minimum != null && v < s.minimum) errors.push(`${p}: below minimum`); if (s.maximum != null && v > s.maximum) errors.push(`${p}: above maximum`); }
    } else if (s.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${p}: expected number`);
      else if (s.minimum != null && v < s.minimum) errors.push(`${p}: below minimum`);
    } else if (s.type === 'boolean') { if (typeof v !== 'boolean') errors.push(`${p}: expected boolean`); }
    else if (s.type === 'null') { if (v !== null) errors.push(`${p}: expected null`); }
    if (s.enum && !s.enum.includes(v)) errors.push(`${p}: invalid enum`);
  };
  visit(schema,data,path); return errors;
}

function buildCompiler() {
  try {
    const Ajv = require('ajv');
    const ajv = new Ajv({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
    ajv.addSchema(contractsSchema);
    return { engine:'ajv', compile:(_schema, name)=>{
      const validator = ajv.getSchema(`${contractsSchema.$id}#/definitions/${name}`);
      if (!validator) throw new Error(`Missing contract definition validator: ${name}`);
      return validator;
    } };
  } catch (error) {
    if (process.env.AISA_TEST_ALLOW_INTERNAL_SCHEMA_VALIDATOR !== '1') throw new Error(`Ajv 8.17.1 is required: ${error.code || error.message}`);
    return { engine:'test-internal-fallback', compile:(schema)=>{ const fn=(data)=>{ const errs=internalValidate(schema,data,contractsSchema); fn.errors=errs.length?errs:null; return errs.length===0; }; fn.errors=null; return fn; } };
  }
}
const compiler = buildCompiler();
export const validatorEngine = compiler.engine;

const validators = new Map();
for (const [name,schema] of Object.entries(contractsSchema.definitions)) validators.set(name, compiler.compile(schema,name));
const semanticValidator = compiler.engine === 'ajv'
  ? (()=>{ const Ajv=require('ajv'); const ajv=new Ajv({strict:true,allErrors:true,coerceTypes:false,useDefaults:false,removeAdditional:false}); return ajv.compile(postCallSemanticSchema); })()
  : (()=>{ const fn=(data)=>{ const errs=internalValidate(postCallSemanticSchema,data,{definitions:{}}); fn.errors=errs.length?errs:null; return !errs.length;}; return fn;})();

function validateWith(fn, value, name) {
  if (!fn(value)) { const e = new Error(`${name} schema validation failed: ${JSON.stringify(fn.errors).slice(0,1200)}`); e.code='schema_invalid'; e.validationErrors=fn.errors; throw e; }
  return structuredClone(value);
}
export function validateDefinition(name, value) { const fn=validators.get(name); if (!fn) throw new Error(`Unknown contract definition: ${name}`); return validateWith(fn,value,name); }
export function validatePostCallSemantics(value) { return validateWith(semanticValidator,value,'PostCallSemantics'); }

export function crossValidatePostCallSemantics(semantic, segments) {
  validatePostCallSemantics(semantic);
  const byId = new Map(segments.map((s)=>[s.event_id || s.eventId,s]));
  const requireEvidence = (ids, speaker, label, needed) => {
    if (new Set(ids).size !== ids.length) throw new Error(`${label}: duplicate evidence event id.`);
    if (needed && !ids.length) throw new Error(`${label}: evidence required.`);
    for (const id of ids) { const seg=byId.get(id); if (!seg) throw new Error(`${label}: unknown/cross-call evidence ${id}.`); if (speaker && seg.speaker !== speaker) throw new Error(`${label}: wrong evidence speaker.`); }
  };
  const known=(v)=>!['unknown',null].includes(v);
  requireEvidence(semantic.role_match.evidence_event_ids,'user','role_match',known(semantic.role_match.value));
  requireEvidence(semantic.interest.evidence_event_ids,'user','interest',known(semantic.interest.value));
  requireEvidence(semantic.rejection.evidence_event_ids,'user','rejection',semantic.rejection.value !== null);
  requireEvidence(semantic.do_not_call.evidence_event_ids,'user','do_not_call',semantic.do_not_call.value !== null);
  requireEvidence(semantic.next_step.evidence_event_ids,'user','next_step',semantic.next_step.kind!=='none' && semantic.next_step.kind!=='unknown');
  requireEvidence(semantic.callback.evidence_event_ids,'user','callback',semantic.callback.requested !== null);
  const referralUsed=[semantic.referral.person_text,semantic.referral.role_text,semantic.referral.phone_text,semantic.referral.contact_channel_text].some((x)=>x!=null);
  requireEvidence(semantic.referral.evidence_event_ids,'user','referral',referralUsed);
  for (const q of semantic.questions_for_human) requireEvidence(q.evidence_event_ids,null,'question',true);
  for (const c of semantic.commitments) requireEvidence(c.evidence_event_ids,'assistant','commitment',true);
  requireEvidence(semantic.summary.evidence_event_ids,null,'summary',false);
  if (semantic.next_step.status === 'agreed' && semantic.next_step.kind === 'none') throw new Error('Agreed next step cannot be none.');
  if (semantic.callback.requested === true && semantic.next_step.kind !== 'callback') throw new Error('Callback requested conflicts with next_step kind.');
  return structuredClone(semantic);
}

export function getSchema(name) { return structuredClone(name==='PostCallSemantics'?postCallSemanticSchema:contractsSchema.definitions[name]); }
export { contractsSchema };
