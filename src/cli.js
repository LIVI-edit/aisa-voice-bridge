import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VoiceStore } from './store.js';
import { loadConfig, safeMessage } from './config.js';
import { importContactsCsv, exportJson, exportCsv } from './import-export.js';
import { actorFromOs, loadPilotPolicy, prepareCall, startCall, recoverCalls, extractCall } from './call-runner.js';
import { validateDefinition, validatePostCallSemantics } from './contracts.js';

function parseFlags(args) { const pos=[]; const flags={}; for(let i=0;i<args.length;i++){const a=args[i]; if(a.startsWith('--')){const k=a.slice(2); if(k==='transcript'||k==='spreadsheet-safe'){flags[k]=true;continue;} if(i+1>=args.length||args[i+1].startsWith('--'))throw new Error(`Missing value for --${k}`); flags[k]=args[++i];} else pos.push(a);} return {pos,flags}; }
function out(io, value){io.log(typeof value==='string'?value:JSON.stringify(value,null,2));}
function requireArg(value,name){if(!value)throw new Error(`${name} is required.`);return value}

export async function runCli(argv, { env=process.env, io=console, Store=VoiceStore, sessionFactory, ariFactory, extractor, signalRegistrar } = {}) {
  const config=loadConfig(env); const policy=loadPilotPolicy(config.pilotPolicyPath); const actor=actorFromOs();
  const [area, action, ...rest]=argv; if(!area) throw new Error('Command required.');
  const offline = !(area==='calls' && ['start','recover','extract'].includes(action));
  const store=new Store(config.dbPath); try {
    if(area==='contacts'&&action==='import-csv'){const {pos}=parseFlags(rest);out(io,importContactsCsv(store,resolve(requireArg(pos[0],'FILE'))));return 0;}
    if(area==='contacts'&&action==='list'){out(io,store.listContacts());return 0;}
    if(area==='contacts'&&action==='show'){const {pos}=parseFlags(rest);out(io,store.showContact(requireArg(pos[0],'CONTACT_ID')));return 0;}
    if(area==='contacts'&&action==='approve'){const {pos,flags}=parseFlags(rest); const basis=requireArg(flags.basis,'--basis'); const evidenceRef=requireArg(flags.evidence,'--evidence'); const policyVersion=requireArg(flags.policy,'--policy'); out(io,store.approveContact(requireArg(pos[0],'CONTACT_ID'),{basis,evidenceRef,policyVersion,actor}));return 0;}
    if(area==='contacts'&&action==='block'){const {pos,flags}=parseFlags(rest);out(io,store.blockContact(requireArg(pos[0],'CONTACT_ID'),{reason:requireArg(flags.reason,'--reason'),actor}));return 0;}
    if(area==='calls'&&action==='prepare'){const {pos,flags}=parseFlags(rest);const call=prepareCall({store,config,policy,contactId:requireArg(pos[0],'CONTACT_ID'),scenarioId:requireArg(flags.objective,'--objective'),actor});out(io,call);return 0;}
    if(area==='calls'&&action==='show'){const {pos,flags}=parseFlags(rest);const call=store.getCall(requireArg(pos[0],'CALL_ID'));if(!call)throw new Error('Call not found.');out(io,flags.transcript?{call,transcript:store.getTranscript(call.call_id)}:call);return 0;}
    if(area==='calls'&&action==='start'){const {pos,flags}=parseFlags(rest);const call=await startCall({store,config,policy,callId:requireArg(pos[0],'CALL_ID'),confirmPhone:requireArg(flags['confirm-phone'],'--confirm-phone'),sessionFactory,signalRegistrar});out(io,call);return call.processing_status==='ok'?0:1;}
    if(area==='calls'&&action==='recover'){const result=await recoverCalls({store,config,ariFactory});out(io,result);return result.results?.some((x)=>x.status==='hold_unknown_cleanup')?1:0;}
    if(area==='calls'&&action==='extract'){const {pos}=parseFlags(rest);const result=await extractCall({store,config,callId:requireArg(pos[0],'CALL_ID'),extractor});out(io,result);return 0;}
    if(area==='reviews'&&action==='apply'){const {pos,flags}=parseFlags(rest);const resultId=requireArg(pos[0],'RESULT_ID');const file=resolve(requireArg(flags.file,'--file'));const review=JSON.parse(readFileSync(file,'utf8'));if(review.result_id!==resultId)throw new Error('Review result_id does not match CLI RESULT_ID.');review.actor=actor;validateDefinition('HumanReview',review);if(review.corrected_semantic)validatePostCallSemantics(review.corrected_semantic);out(io,store.applyReview(review));return 0;}
    if(area==='export'&&action==='json'){const {pos}=parseFlags(rest);out(io,{path:resolve(requireArg(pos[0],'PATH')),schema_version:exportJson(store,resolve(pos[0])).schema_version});return 0;}
    if(area==='export'&&action==='csv'){const {pos,flags}=parseFlags(rest);out(io,exportCsv(store,resolve(requireArg(pos[0],'DIRECTORY')),{spreadsheetSafe:!!flags['spreadsheet-safe']}));return 0;}
    if (offline) throw new Error(`Unknown command: ${argv.join(' ')}`);
    throw new Error(`Unknown command: ${argv.join(' ')}`);
  } finally { store.close(); }
}
export function formatCliError(error, config){return safeMessage(error,config)}
