import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { postCallSemanticSchema, crossValidatePostCallSemantics } from './contracts.js';
const here=dirname(fileURLToPath(import.meta.url));
const prompt=readFileSync(resolve(here,'../prompts/post-call.v1.md'),'utf8');

function extractText(response){
  if(response.status==='incomplete')throw Object.assign(new Error('Responses extraction incomplete.'),{code:'extract_incomplete'});
  for(const item of response.output||[])if(item.type==='message')for(const c of item.content||[]){if(c.type==='refusal')throw Object.assign(new Error('Extractor refused.'),{code:'extract_refused'});if(c.type==='output_text'&&typeof c.text==='string')return c.text;}
  if(typeof response.output_text==='string')return response.output_text; throw Object.assign(new Error('Extractor returned no output text.'),{code:'extract_empty'});
}
export class PostCallExtractor{
  constructor(config,{fetchImpl=globalThis.fetch,timeoutMs=30000}={}){this.config=config;this.fetchImpl=fetchImpl;this.timeoutMs=timeoutMs}
  async extract({call,segments}){
    const result={result_id:randomUUID(),call_id:call.call_id,contact_id:call.contact_id,company_id:call.company_id,transcript_sha256:call.transcript_envelope.sha256,created_at:new Date().toISOString(),extractor_model:this.config.postCallModel,extractor_prompt_version:'1',schema_version:'1',status:'running',error_code:null,semantic:null,needs_review:true,review_id:null};
    if(!this.config.apiKey){result.status='unavailable';result.error_code='api_key_unavailable';return result;}
    const transcript=segments.map(s=>({event_id:s.event_id,speaker:s.speaker,start_ms:s.start_ms,end_ms:s.end_ms,phase:s.phase,delivery:s.delivery,text:s.delta}));
    const body={model:this.config.postCallModel,store:false,max_output_tokens:3000,input:[{role:'system',content:[{type:'input_text',text:prompt}]},{role:'user',content:[{type:'input_text',text:JSON.stringify({call_id:call.call_id,transcript_state:call.transcript_state,transcript})}]}],text:{format:{type:'json_schema',name:'aisa_post_call_semantics_v1',strict:true,schema:postCallSemanticSchema}}};
    let response;try{response=await this.fetchImpl('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${this.config.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(this.timeoutMs)});}catch{result.status='failed';result.error_code='network_or_timeout';return result}
    if(!response.ok){result.status=response.status===429?'failed':'failed';result.error_code=`http_${response.status}`;return result}
    let payload;try{payload=await response.json()}catch{result.status='failed';result.error_code='invalid_json';return result}
    try{const text=extractText(payload);const semantic=JSON.parse(text);crossValidatePostCallSemantics(semantic,segments);semantic.needs_review=true;result.status='validated';result.semantic=semantic;return result}catch(e){result.status=e.code==='extract_refused'?'refused':'failed';result.error_code=e.code||'semantic_invalid';return result}
  }
}
