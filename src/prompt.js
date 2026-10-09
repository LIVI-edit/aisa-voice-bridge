import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here=dirname(fileURLToPath(import.meta.url));
const policyText=readFileSync(resolve(here,'../prompts/voice-policy.v1.md'),'utf8');
const facts=JSON.parse(readFileSync(resolve(here,'../prompts/aisa-facts.v1.json'),'utf8'));
const registry=JSON.parse(readFileSync(resolve(here,'../prompts/objectives.v1.json'),'utf8'));
export const POLICY_VERSION='1';

function boundedString(value,max,label){ if(value==null) return null; if(typeof value!=='string') throw new Error(`${label} must be string/null.`); if(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)||value.includes('\u001b')) throw new Error(`${label} contains control characters.`); if(Buffer.byteLength(value)>max) throw new Error(`${label} too large.`); return value; }
export function listScenarios(){ return structuredClone(registry.scenarios); }
export function getScenario(scenarioId){ const s=registry.scenarios.find((x)=>x.scenario_id===scenarioId); if(!s) throw new Error(`Unknown scenario/profile: ${scenarioId}`); return structuredClone(s); }
export function composePrompt({ contact, company, reviewedHistory=[], scenarioId }) {
  const s=getScenario(scenarioId);
  if(reviewedHistory.length>3) throw new Error('At most 3 reviewed history summaries.');
  const data={
    contact:{ contact_id:contact.contact_id, person_name:boundedString(contact.person_name,256,'person_name'), role_title:boundedString(contact.role_title,256,'role_title'), language_preference:contact.language_preference, context:boundedString(contact.context||'',12000,'contact context') },
    company:{ company_id:company.company_id, name:boundedString(company.name,512,'company name'), context:boundedString(company.context||'',16000,'company context') },
    reviewed_history:reviewedHistory.map((h)=>({call_id:h.call_id,summary:boundedString(h.summary,1000,'history summary'),review_id:h.review_id})),
    scenario:{ scenario_id:s.scenario_id, version:s.version, variant_label:s.variant_label, presentation_mode:s.presentation_mode, goal:s.goal, max_discovery_questions:s.max_discovery_questions, allowed_next_steps:s.allowed_next_steps }
  };
  const inputDataJson=JSON.stringify(data);
  if(Buffer.byteLength(inputDataJson)>65536) throw new Error('Prompt data context exceeds 64KiB.');
  const instructions=[policyText.trim(),`\nVerified product facts (${facts.version}):`,...facts.facts.map((x)=>`- ${x}`),`\nSelected scenario: ${s.scenario_id}@${s.version}. Goal: ${s.goal}. Max discovery questions: ${s.max_discovery_questions}. Allowed proposed next steps: ${s.allowed_next_steps.join(', ')}.`].join('\n');
  if(Buffer.byteLength(instructions)>32768) throw new Error('Instructions exceed 32KiB.');
  const greeting=`The phone media path is ready. Use this reviewed opener now, in Ukrainian: ${JSON.stringify(s.opener)} Continue under the selected scenario and trusted policy.`;
  const base={ policy_version:POLICY_VERSION, facts_version:facts.version, objective_version:s.version, scenario_id:s.scenario_id, scenario_version:s.version, variant_label:s.variant_label, presentation_mode:s.presentation_mode, instructions, greeting, input_data_json:inputDataJson };
  const sha256=createHash('sha256').update(JSON.stringify(base)).digest('hex');
  return {...base,sha256};
}
