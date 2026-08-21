import { subscribeHarnessActivity } from "./harness.js";
import { loopbackHost, loopbackRemote } from "./operator-api.js";

export const OPERATOR_STREAM_SESSION_CHECK_MS = 1000;
export const OPERATOR_STREAM_HEARTBEAT_MS = 10_000;

function sendJson(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(body);
}
function bearer(request){const value=request.headers.authorization;return typeof value==="string"&&value.startsWith("Bearer ")?value.slice("Bearer ".length).trim():""}
function expectedOrigin(request){return `http://${request.headers.host}`}
function originAllowed(request){const origin=request.headers.origin;return !origin||origin===expectedOrigin(request)}

export async function handleOperatorStream(runtime,request,response){
    if(request.method!=="GET"){sendJson(response,405,{error:"method not allowed"});return}
    if(!loopbackHost(runtime.config.bindHost??"127.0.0.1")||!loopbackRemote(request.socket.remoteAddress)){sendJson(response,403,{error:"operator telemetry is available only on loopback"});return}
    if(!originAllowed(request)){sendJson(response,403,{error:"cross-origin operator telemetry refused"});return}
    const sessionToken=bearer(request);
    if(!await runtime.operatorSessions.authenticate(sessionToken)){sendJson(response,401,{error:"invalid or expired operator session"});return}

    response.writeHead(200,{"content-type":"application/x-ndjson; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","x-accel-buffering":"no",connection:"keep-alive"});
    response.flushHeaders?.();
    let closed=false;let streamSeq=0;let checkingSession=false;
    const emit=(notification)=>{if(closed||response.destroyed||response.writableEnded)return false;streamSeq+=1;response.write(`${JSON.stringify({streamSeq,...notification})}\n`);return true};
    const removeTaskListener=runtime.taskEvents.subscribe((event)=>emit({source:"task",type:event.type,taskId:event.taskId,sourceSeq:event.seq,at:event.at}));
    const removeAuditListener=runtime.audit.subscribe((record)=>emit({source:"audit",type:record.type,sourceSeq:record.seq,at:record.at}));
    const removeHarnessListener=subscribeHarnessActivity(runtime.config.agents,(activity)=>emit({source:"worker",type:"harness.activity",agentId:activity.agentId,inFlightHarnessCount:activity.inFlightHarnessCount,at:activity.at}));

    let sessionTimer;let heartbeatTimer;
    const cleanup=()=>{if(closed)return;closed=true;clearInterval(sessionTimer);clearInterval(heartbeatTimer);removeTaskListener();removeAuditListener();removeHarnessListener()};
    response.once("close",cleanup);request.once("aborted",cleanup);
    emit({source:"system",type:"connected",at:new Date().toISOString()});
    heartbeatTimer=setInterval(()=>emit({source:"system",type:"heartbeat",at:new Date().toISOString()}),OPERATOR_STREAM_HEARTBEAT_MS);heartbeatTimer.unref?.();
    sessionTimer=setInterval(async()=>{if(closed||checkingSession)return;checkingSession=true;try{const valid=await runtime.operatorSessions.authenticate(sessionToken);if(!valid&&!closed){emit({source:"system",type:"session-ended",at:new Date().toISOString()});cleanup();response.end()}}catch{if(!closed){emit({source:"system",type:"session-ended",at:new Date().toISOString()});cleanup();response.end()}}finally{checkingSession=false}},OPERATOR_STREAM_SESSION_CHECK_MS);sessionTimer.unref?.();
}
