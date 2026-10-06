import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const gatewayEntry = require.resolve("@the-next-ai/ai-gateway");
const gatewayPackage = JSON.parse(
  await readFile(resolve(dirname(gatewayEntry), "../package.json"), "utf8")
);
const supportedVersion = "1.0.21";

if (gatewayPackage.version !== supportedVersion) {
  throw new Error(
    `Refusing to patch @the-next-ai/ai-gateway ${gatewayPackage.version}; expected ${supportedVersion}.`
  );
}

// ai-gateway otherwise sends native Anthropic SSE through its OpenAI-to-Anthropic
// converter in live virtual-model mode, which drops thinking/text blocks and the model.
const replacements = [
  [
    "function kg(e,n,t,r,o){",
    "function kg(e,n,t,r,o,s){"
  ],
  [
    'n.adapterKey==="anthropic_messages"?i=br.Readable.from(BL(t)):',
    'n.adapterKey==="anthropic_messages"?i=s?br.Readable.fromWeb(t.body):br.Readable.from(BL(t)):'
  ],
  [
    "kg(n,t,Ae,sn,i)",
    'kg(n,t,Ae,sn,i,x==="anthropic"&&E?.type==="anthropic_messages")'
  ],
  [
    "kg(n,t,Se,E,c)",
    'kg(n,t,Se,E,c,A==="anthropic"&&O?.type==="anthropic_messages")'
  ]
];

let source = await readFile(gatewayEntry, "utf8");
let changed = false;

for (const [before, after] of replacements) {
  if (source.includes(after)) {
    continue;
  }
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Unable to apply the Anthropic stream patch uniquely: ${before}`);
  }
  source = source.replace(before, after);
  changed = true;
}

if (changed) {
  await writeFile(gatewayEntry, source, "utf8");
  console.log("Patched @the-next-ai/ai-gateway native Anthropic stream passthrough.");
}
