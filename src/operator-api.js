import { dryRunPolicy, validatePolicyDraft } from "./policy-dry-run.js";
import { publicMemoryRecords, publicTaskGraphView, publicTaskListView } from "./task-view.js";
import { collectWorkerTelemetry } from "./worker-telemetry.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function send(response, status, value) {
    const body = JSON.stringify(value, null, 2);
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(body);
}
async function readBody(request) { const chunks=[]; let total=0; for await(const chunk of request){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk); total+=buffer.length; if(total>MAX_BODY_BYTES) throw new Error("operator request body is too large"); chunks.push(buffer)} return chunks.length?JSON.parse(Buffer.concat(chunks).toString("utf8")):{} }
function bearer(request){const value=request.headers.authorization; return typeof value==="string"&&value.startsWith("Bearer ")?value.slice(7).trim():""}
function loopbackHost(value){const host=String(value??"").toLowerCase().replace(/^\[|\]$/g,""); return host==="127.0.0.1"||host==="localhost"||host==="::1"}
function loopbackRemote(value){const address=String(value??"").toLowerCase(); return address==="127.0.0.1"||address==="::1"||address==="::ffff:127.0.0.1"}
function expectedOrigin(request){return `http://${request.headers.host}`}
function requireSameOrigin(request){const origin=request.headers.origin; if(origin&&origin!==expectedOrigin(request)) throw Object.assign(new Error("cross-origin operator mutation refused"),{statusCode:403})}
function parts(pathname){return pathname.split("/").filter(Boolean).map(decodeURIComponent)}
async function requireSession(runtime,request,response){if(!loopbackHost(runtime.config.bindHost??"127.0.0.1")||!loopbackRemote(request.socket.remoteAddress)){send(response,403,{error:"operator console is available only on loopback"}); return} const token=bearer(request); if(!await runtime.operatorSessions.authenticate(token)){send(response,401,{error:"invalid or expired operator session"}); return} return token}
async function computerDetails(runtime){const computers=await runtime.computer.listComputers(); return Promise.all(computers.map(async computer=>{const pending=await runtime.computerRegistry.secretRequest(computer.agentId); let lifecycle; try{lifecycle=await runtime.computerLifecycle.status(computer.agentId)}catch(error){lifecycle={managed:false,running:false,error:error.message}} return {...computer,lifecycle,pendingSecret:pending?{id:pending.id,taskId:pending.taskId,label:pending.label,createdAt:pending.createdAt,ref:pending.ref}:undefined}}))}

export async function handleOperatorApiRequest(runtime,request,response,url){
    const sessionToken=await requireSession(runtime,request,response); if(!sessionToken)return; const p=parts(url.pathname);
    try{
        if(request.method==="GET"&&url.pathname==="/operator/session"){send(response,200,{ok:true,scope:"operator-console"});return}
        if(request.method==="POST"&&url.pathname==="/operator/session/revoke"){requireSameOrigin(request);await runtime.operatorSessions.revoke(sessionToken);send(response,200,{revoked:true});return}
        if(request.method==="GET"&&url.pathname==="/operator/overview"){const tasks=publicTaskListView(await runtime.orchestrator.listTasks());const agents=runtime.orchestrator.listAgents().map(agent=>({id:agent.id,name:agent.name,role:agent.role,capabilities:agent.capabilities,governedTools:agent.governedTools,harnessKind:agent.harness?.kind}));send(response,200,{tasks,agents,computers:await computerDetails(runtime),audit:await runtime.audit.verify()});return}
        if(request.method==="GET"&&url.pathname==="/operator/workers"){send(response,200,await collectWorkerTelemetry(runtime.orchestrator));return}
        if(request.method==="GET"&&url.pathname==="/operator/audit"){const limit=Math.max(1,Math.min(500,Number(url.searchParams.get("limit")??100)));const rows=await runtime.audit.readAll();send(response,200,rows.slice(-limit).reverse());return}
        if(request.method==="GET"&&url.pathname==="/operator/memory"){const scope=url.searchParams.get("scope")||undefined;const query=url.searchParams.get("q")||undefined;const records=await runtime.memory.search({scope,query,limit:100});const tasks=await runtime.orchestrator.listTasks();send(response,200,publicMemoryRecords(records,tasks));return}
        if(request.method==="GET"&&url.pathname==="/operator/policy"){const snapshot=await runtime.policyManager.snapshot();send(response,200,{...snapshot,editable:false,note:"Draft editing and dry-run are side-effect free. Apply/rollback require explicit same-origin operator mutations."});return}
        if(request.method==="GET"&&p[0]==="operator"&&p[1]==="policy"&&p[2]==="versions"&&p[3]){send(response,200,await runtime.policyManager.getVersion(p[3]));return}
        if(request.method==="POST"&&url.pathname==="/operator/policy/validate"){requireSameOrigin(request);const body=await readBody(request);const policy=validatePolicyDraft(body.policy);send(response,200,{ok:true,ruleCount:policy.rules.length,repeatWindowMs:policy.repeatWindowMs??180000,repeatMaxActiveFingerprints:policy.repeatMaxActiveFingerprints??10000});return}
        if(request.method==="POST"&&url.pathname==="/operator/policy/dry-run"){requireSameOrigin(request);const body=await readBody(request);send(response,200,dryRunPolicy({policy:body.policy,action:body.action,repeatCount:body.repeatCount??1}));return}
        if(request.method==="POST"&&url.pathname==="/operator/policy/apply"){requireSameOrigin(request);const body=await readBody(request);send(response,200,await runtime.policyManager.apply({policy:body.policy,checks:body.checks,label:body.label,actor:"operator-console"}));return}
        if(request.method==="POST"&&url.pathname==="/operator/policy/rollback"){requireSameOrigin(request);const body=await readBody(request);send(response,200,await runtime.policyManager.rollback({versionId:body.versionId,actor:"operator-console"}));return}
        if(request.method==="GET"&&p[0]==="operator"&&p[1]==="tasks"&&p[2]&&p[3]==="graph"){send(response,200,publicTaskGraphView(await runtime.orchestrator.getTaskGraph(p[2])));return}
        if(request.method==="GET"&&p[0]==="operator"&&p[1]==="tasks"&&p[2]&&p[3]==="events"){send(response,200,await runtime.orchestrator.listTaskEvents(p[2]));return}
        if(request.method==="POST"&&p[0]==="operator"&&p[1]==="computers"&&p[2]&&p[3]==="control"&&["take","release"].includes(p[4])){requireSameOrigin(request);const body=await readBody(request);const actorId=String(body.actorId??"operator-console").slice(0,120);send(response,200,p[4]==="take"?await runtime.computer.takeControl(p[2],actorId):await runtime.computer.releaseControl(p[2],actorId));return}
        if(request.method==="POST"&&p[0]==="operator"&&p[1]==="computers"&&p[2]&&p[3]==="lifecycle"&&["start","stop","reset"].includes(p[4])){requireSameOrigin(request);const body=await readBody(request);send(response,200,await runtime.computerLifecycle[p[4]](p[2],String(body.actorId??"operator-console").slice(0,120)));return}
        if(request.method==="POST"&&p[0]==="operator"&&p[1]==="computers"&&p[2]&&p[3]==="secrets"&&p[4]&&p[5]==="supply"){requireSameOrigin(request);const body=await readBody(request);try{send(response,200,await runtime.computer.supplySecret(p[2],String(body.actorId??"operator-console").slice(0,120),p[4],String(body.value??"")))}catch{send(response,400,{error:"secret supply failed"})}return}
        send(response,404,{error:"not found"});
    }catch(error){send(response,error.statusCode??400,{error:error.message})}
}
export {loopbackHost,loopbackRemote};
