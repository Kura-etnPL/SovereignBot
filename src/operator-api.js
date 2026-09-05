import { createOperatorFacade, OPERATOR_ACTORS } from "./operator-facade.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

// One facade per runtime; construction fixes the transport's actor identity.
const facades = new WeakMap();
function facadeFor(runtime) {
    let facade = facades.get(runtime);
    if (!facade) {
        facade = createOperatorFacade(runtime, { actor: OPERATOR_ACTORS.console });
        facades.set(runtime, facade);
    }
    return facade;
}

function send(response, status, value) {
    const body = JSON.stringify(value, null, 2);
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(body);
}
async function readBody(request) { const chunks=[]; let total=0; for await(const chunk of request){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk); total+=buffer.length; if(total>MAX_BODY_BYTES) throw new Error("operator request body is too large"); chunks.push(buffer)} return chunks.length?JSON.parse(Buffer.concat(chunks).toString("utf8")):{} }
function bearer(request){const value=request.headers.authorization; return typeof value==="string"&&value.startsWith("Bearer ")?value.slice(7).trim():""}
function loopbackHost(value){const host=String(value??"").toLowerCase().replace(/^\[|\]$/g,""); return host==="127.0.0.1"||host==="localhost"||host==="::1"||host==="0.0.0.0"}
function loopbackRemote(value, host){if(host==="0.0.0.0") return true; const address=String(value??"").toLowerCase(); return address==="127.0.0.1"||address==="::1"||address==="::ffff:127.0.0.1"}
function expectedOrigin(request){return `http://${request.headers.host}`}
function requireSameOrigin(request){const origin=request.headers.origin; if(!origin) return; const host=request.headers.host; if(origin===`http://${host}`||origin===`https://${host}`) return; throw Object.assign(new Error("cross-origin operator mutation refused"),{statusCode:403})}
function parts(pathname){return pathname.split("/").filter(Boolean).map(decodeURIComponent)}
async function requireSession(runtime,request,response){const bindHost=runtime.config.bindHost??"127.0.0.1"; if(!loopbackHost(bindHost)||!loopbackRemote(request.socket.remoteAddress, bindHost)){send(response,403,{error:"operator console is available only on loopback"}); return} const token=bearer(request); if(!await runtime.operatorSessions.authenticate(token)){send(response,401,{error:"invalid or expired operator session"}); return} return token}

export async function handleOperatorApiRequest(runtime,request,response,url){
    const sessionToken=await requireSession(runtime,request,response); if(!sessionToken)return;
    const facade=facadeFor(runtime);
    const p=parts(url.pathname);
    try{
        if(request.method==="GET"&&url.pathname==="/operator/session"){send(response,200,{ok:true,scope:"operator-console"});return}
        if(request.method==="POST"&&url.pathname==="/operator/session/revoke"){requireSameOrigin(request);await runtime.operatorSessions.revoke(sessionToken);send(response,200,{revoked:true});return}
        if(request.method==="GET"&&url.pathname==="/operator/overview"){send(response,200,await facade.getOverview());return}
        if(request.method==="GET"&&url.pathname==="/operator/workers"){send(response,200,await facade.getWorkers());return}
        if(request.method==="GET"&&url.pathname==="/operator/audit"){send(response,200,await facade.getAudit({limit:url.searchParams.get("limit")??100}));return}
        if(request.method==="GET"&&url.pathname==="/operator/memory"){send(response,200,await facade.searchMemory({scope:url.searchParams.get("scope"),query:url.searchParams.get("q")}));return}
        if(request.method==="GET"&&url.pathname==="/operator/policy"){send(response,200,await facade.getPolicy());return}
        if(request.method==="GET"&&p[0]==="operator"&&p[1]==="policy"&&p[2]==="versions"&&p[3]){send(response,200,await facade.getPolicyVersion(p[3]));return}
        if(request.method==="POST"&&url.pathname==="/operator/policy/validate"){requireSameOrigin(request);const body=await readBody(request);send(response,200,await facade.validatePolicy(body.policy));return}
        if(request.method==="POST"&&url.pathname==="/operator/policy/dry-run"){requireSameOrigin(request);const body=await readBody(request);send(response,200,await facade.dryRunPolicy(body));return}
        if(request.method==="POST"&&url.pathname==="/operator/policy/apply"){requireSameOrigin(request);const body=await readBody(request);send(response,200,await facade.applyPolicy({policy:body.policy,checks:body.checks,label:body.label}));return}
        if(request.method==="POST"&&url.pathname==="/operator/policy/rollback"){requireSameOrigin(request);const body=await readBody(request);send(response,200,await facade.rollbackPolicy({versionId:body.versionId}));return}
        if(request.method==="GET"&&p[0]==="operator"&&p[1]==="tasks"&&p[2]&&p[3]==="graph"){send(response,200,await facade.getTaskGraph(p[2]));return}
        if(request.method==="GET"&&p[0]==="operator"&&p[1]==="tasks"&&p[2]&&p[3]==="events"){send(response,200,await facade.getTaskEvents(p[2]));return}
        if(request.method==="POST"&&p[0]==="operator"&&p[1]==="computers"&&p[2]&&p[3]==="control"&&["take","release"].includes(p[4])){requireSameOrigin(request);await readBody(request);send(response,200,await facade.computerControl(p[2],p[4]));return}
        if(request.method==="POST"&&p[0]==="operator"&&p[1]==="computers"&&p[2]&&p[3]==="lifecycle"&&["start","stop","reset"].includes(p[4])){requireSameOrigin(request);await readBody(request);send(response,200,await facade.computerLifecycle(p[2],p[4]));return}
        if(request.method==="POST"&&p[0]==="operator"&&p[1]==="computers"&&p[2]&&p[3]==="secrets"&&p[4]&&p[5]==="supply"){requireSameOrigin(request);const body=await readBody(request);try{send(response,200,await facade.supplySecret(p[2],p[4],body.value))}catch(error){send(response,400,{error:error.message})}return}
        send(response,404,{error:"not found"});
    }catch(error){send(response,error.statusCode??400,{error:error.message})}
}
export {loopbackHost,loopbackRemote};
