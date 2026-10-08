import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const gatewayEntry = require.resolve("@the-next-ai/ai-gateway");
const gatewayPackage = JSON.parse(await readFile(resolve(dirname(gatewayEntry), "../package.json"), "utf8"));

if (gatewayPackage.version !== "1.0.21") {
  throw new Error(`Refusing to patch @the-next-ai/ai-gateway ${gatewayPackage.version}; expected 1.0.21.`);
}

// The bundled gateway's buffered protocol conversion paths build a raw trace
// from the converted body but omit the actual upstream Response status/headers.
// Keep the upstream HTTP outcome, including through retries and tool loops.
const replacements = [
  [
    "if(Ae.ok)an=Ae.transformedPayload,he=Ae.standardPayload,Bn={ok:!0,value:Ae.standardResponse};",
    "if(Ae.ok)an=Ae.transformedPayload,he=Ae.standardPayload,ke=Ae.upstreamResponse,He=Ae.upstreamRequest,Bn={ok:!0,value:Ae.standardResponse};"
  ],
  [
    "{upstreamRequest:He,upstreamResponseBody:qe})",
    "{upstreamRequest:He,upstreamResponseBody:qe,upstreamResponseStatus:ke.status,upstreamResponseHeaders:hC(ke.headers)})"
  ],
  [
    "initialUpstreamResponseBody:Bo,initialAttemptSequence:Ur",
    "initialUpstreamResponseBody:Bo,initialUpstreamResponse:ut,initialAttemptSequence:Ur"
  ],
  [
    "let n=e.config.transparentToolExecution,t=e.state.upstreamAttemptSequence,r=e.initialStandardRequest,o=e.initialStandardResponse,i=e.initialUpstreamRequest,s=e.initialAttemptSequence,a=e.initialUpstreamResponseBody,u=o.usage;",
    "let n=e.config.transparentToolExecution,t=e.state.upstreamAttemptSequence,r=e.initialStandardRequest,o=e.initialStandardResponse,i=e.initialUpstreamRequest,s=e.initialAttemptSequence,a=e.initialUpstreamResponseBody,p=e.initialUpstreamResponse,u=o.usage;"
  ],
  [
    "let{upstreamRequest:R,upstreamResponse:C}=_;i=R,t+=1",
    "let{upstreamRequest:R,upstreamResponse:C}=_;i=R,p=C,t+=1"
  ],
  [
    "i=v.upstreamRequest,a=v.transformedPayload,s=v.attemptSequence,o=v.standardResponse",
    "i=v.upstreamRequest,p=v.upstreamResponse,a=v.transformedPayload,s=v.attemptSequence,o=v.standardResponse"
  ],
  [
    "{upstreamRequest:de.upstreamRequest,upstreamResponseBody:Hr}",
    "{upstreamRequest:de.upstreamRequest,upstreamResponseBody:Hr,upstreamResponseStatus:de.upstreamResponse.status,upstreamResponseHeaders:hC(de.upstreamResponse.headers)}"
  ],
  [
    "yn.ok&&(X=yn.upstreamRequest,xe=yn.attemptSequence,tr=yn.transformedPayload,Ur=yn.standardResponse)",
    "yn.ok&&(X=yn.upstreamRequest,Se=yn.upstreamResponse,xe=yn.attemptSequence,tr=yn.transformedPayload,Ur=yn.standardResponse)"
  ],
  [
    "CP(d.profile,Dc(te,k.toolOwners,ce),se,oe),u,j,_,X)",
    "CP(d.profile,Dc(te,k.toolOwners,ce),se,oe),u,j,_,X,Se)"
  ],
  [
    "async function _P(e,n,t,r,o,i,s,a,u,d,c,f,g,y){",
    "async function _P(e,n,t,r,o,i,s,a,u,d,c,f,g,y,z){"
  ],
  [
    "{upstreamRequest:y,upstreamResponseBody:k}",
    "{upstreamRequest:y,upstreamResponseBody:k,upstreamResponseStatus:z.status,upstreamResponseHeaders:hC(z.headers)}"
  ],
  [
    "{upstreamRequest:y,upstreamResponseBody:h}",
    "{upstreamRequest:y,upstreamResponseBody:h,upstreamResponseStatus:z.status,upstreamResponseHeaders:hC(z.headers)}"
  ]
];

let source = await readFile(gatewayEntry, "utf8");
let changed = false;

for (const [before, after] of replacements) {
  if (source.includes(after)) continue;
  const first = source.indexOf(before);
  const expectedCount = before.startsWith("CP(d.profile,Dc(") ? 2 : 1;
  const count = source.split(before).length - 1;
  if (first < 0 || count !== expectedCount) {
    throw new Error(`Unable to apply the raw trace status patch uniquely: ${before}`);
  }
  source = source.replaceAll(before, after);
  changed = true;
}

const rKStart = source.indexOf("async function rK(e){");
const rKEnd = source.indexOf("function $g(e,n,t){", rKStart);
if (rKStart < 0 || rKEnd < 0) throw new Error("Unable to locate the gateway tool-loop trace path.");
let rK = source.slice(rKStart, rKEnd);
const beforeReturn = "upstreamRequest:i,attemptSequence:s,upstreamAttemptSequence:t}";
const afterReturn = "upstreamRequest:i,upstreamResponse:p,attemptSequence:s,upstreamAttemptSequence:t}";
if (!rK.includes(afterReturn)) {
  const count = rK.split(beforeReturn).length - 1;
  if (count !== 3) throw new Error(`Expected 3 tool-loop success returns, found ${count}.`);
  rK = rK.replaceAll(beforeReturn, afterReturn);
  source = source.slice(0, rKStart) + rK + source.slice(rKEnd);
  changed = true;
}

if (changed) {
  await writeFile(gatewayEntry, source, "utf8");
  console.log("Patched @the-next-ai/ai-gateway buffered raw trace upstream status/headers.");
}
