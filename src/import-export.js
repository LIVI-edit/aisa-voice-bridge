import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateE164 } from './telephony-route.js';
const HEADERS=['contact_id','company_id','company_name','person_name','role_title','phone_e164','language_preference','company_context','contact_context','phone_source_ref','context_source_ref'];
const MAX=5*1024*1024, MAX_ROWS=10000;

export function parseCsv(text){
  if(typeof text!=='string')throw new Error('CSV must be UTF-8 text.'); if(Buffer.byteLength(text)>MAX)throw new Error('CSV exceeds 5MiB.'); if(text.charCodeAt(0)===0xfeff)text=text.slice(1);
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){field+='"';i++;}else if(c==='"')quoted=false;else field+=c;}else if(c==='"'){if(field)throw new Error('Malformed CSV quote.');quoted=true;}else if(c===','){row.push(field);field='';}else if(c==='\n'){row.push(field);rows.push(row);row=[];field='';}else if(c==='\r'){if(text[i+1]==='\n')continue;row.push(field);rows.push(row);row=[];field='';}else field+=c;}
  if(quoted)throw new Error('Unclosed CSV quote.'); if(field||row.length){row.push(field);rows.push(row)} return rows;
}
export function planContactImport(text,{now=()=>new Date().toISOString()}={}){
  const rows=parseCsv(text); if(!rows.length)throw new Error('CSV is empty.'); if(rows.length-1>MAX_ROWS)throw new Error('CSV exceeds 10000 rows.');
  if(rows[0].length!==HEADERS.length||rows[0].some((h,i)=>h!==HEADERS[i]))throw new Error(`CSV header must be exactly: ${HEADERS.join(',')}`);
  const companies=new Map(),contacts=[],mapping=[],seenPhones=new Set(),seenContacts=new Set();
  for(let r=1;r<rows.length;r++){const vals=rows[r];if(vals.length===1&&vals[0]==='')continue;if(vals.length!==HEADERS.length)throw new Error(`Row ${r+1}: wrong column count.`);const x=Object.fromEntries(HEADERS.map((h,i)=>[h,vals[i]]));
    validateE164(x.phone_e164,`Row ${r+1} phone_e164`); if(!['uk','ru','unknown',''].includes(x.language_preference))throw new Error(`Row ${r+1}: invalid language_preference.`); if(!x.company_name||!x.phone_source_ref||!x.context_source_ref)throw new Error(`Row ${r+1}: company_name and source refs are required.`);
    const companyId=x.company_id||randomUUID(),contactId=x.contact_id||randomUUID(); if(seenPhones.has(x.phone_e164)||seenContacts.has(contactId))throw new Error(`Row ${r+1}: duplicate phone/id in file.`);seenPhones.add(x.phone_e164);seenContacts.add(contactId);
    const at=now(); const source=(reference)=>({kind:'owner_supplied',reference,captured_at:at,supplied_by:'csv_import'}); const company={company_id:companyId,name:x.company_name,context:x.company_context,source:source(x.context_source_ref),created_at:at,updated_at:at};
    const prev=companies.get(companyId);if(prev&&(prev.name!==company.name||prev.context!==company.context))throw new Error(`Row ${r+1}: company id conflict in file.`);companies.set(companyId,prev||company);
    contacts.push({contact_id:contactId,company_id:companyId,person_name:x.person_name||null,role_title:x.role_title||null,phone_e164:x.phone_e164,language_preference:x.language_preference||'unknown',context:x.contact_context,phone_source:source(x.phone_source_ref),context_source:source(x.context_source_ref),created_at:at,updated_at:at});
    mapping.push({row:r+1,company_id:companyId,contact_id:contactId});
  }
  return {companies:[...companies.values()],contacts,mapping};
}
export function importContactsCsv(store,file){const bytes=readFileSync(file);let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw new Error('CSV must be valid UTF-8.')}const plan=planContactImport(text);store.addImportPlan(plan);return {imported:plan.contacts.length,mapping:plan.mapping};}
function csvEscape(v){if(v==null)return '';const s=typeof v==='string'?v:JSON.stringify(v);return /[",\r\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s}
function spreadsheetSafe(v){const s=v==null?'':String(v);return /^[=+\-@\t\r]/.test(s)?`'${s}`:s}
function tableCsv(rows,safe=false){const headers=rows.length?Object.keys(rows[0]):[];return [headers.join(','),...rows.map(r=>headers.map(h=>csvEscape(safe?spreadsheetSafe(r[h]):r[h])).join(','))].join('\n')+'\n'}
export function exportJson(store,path){const data=store.exportAll();writeFileSync(path,JSON.stringify(data,null,2)+'\n',{mode:0o600});return data}
export function exportCsv(store,dir,{spreadsheetSafe:sf=false}={}){mkdirSync(dir,{recursive:true,mode:0o700});const data=store.exportAll();for(const key of ['companies','contacts','authorizations','calls','call_events','transcript_segments','post_call_results','reviews'])writeFileSync(join(dir,`${key}.csv`),tableCsv(data[key],sf),{mode:0o600});writeFileSync(join(dir,'EXPORT_INFO.json'),JSON.stringify({schema_version:'1',spreadsheet_safe:sf,transformed:sf,exported_at:data.exported_at},null,2)+'\n',{mode:0o600});return {directory:dir,spreadsheet_safe:sf}}
export { HEADERS };
