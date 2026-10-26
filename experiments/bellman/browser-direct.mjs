// Real desktop-browser engine regression. Isolated loopback harness, not OAuth,
// public coordinator acceptance, or an independent-operator rehearsal.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BellmanPassRunner } from '../../apps/verifier-worker/dist/bellman-runner.js';
const [input, playwrightPath] = process.argv.slice(2);
if (!input || !playwrightPath) throw new Error('usage: node browser-direct.mjs BELLMAN_GENESIS PLAYWRIGHT_MODULE');
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)).href);
async function digest(path) { const h = createHash('sha256'); for await (const chunk of createReadStream(path)) h.update(chunk); return { sha256: h.digest('hex'), byteLength: (await stat(path)).size }; }
let head = resolve(input), count = 0, upload, candidate;
let metadata = await digest(head);
const directory = await mkdtemp(join(tmpdir(), 'moss-browser-direct-'));
const runner = new BellmanPassRunner(resolve('packages/bellman-verify/target/release/moss-bellman-verify'));
const server = createServer(async (request,response) => {
  try {
    if (request.url === '/') { response.setHeader('content-type','text/html'); response.end('<!doctype html><title>Isolated Bellman worker test</title>'); }
    else if (request.url === '/worker.js') { response.setHeader('content-type','text/javascript'); createReadStream('packages/crypto/dist/worker/contribute.worker.js').pipe(response); }
    else if (request.url === '/head') { response.setHeader('content-length',metadata.byteLength); createReadStream(head).pipe(response); }
    else if (request.url === '/metadata') { response.setHeader('content-type','application/json'); response.end(JSON.stringify(metadata)); }
    else if (request.url === '/upload' && request.method === 'POST') {
      candidate = join(directory, `candidate-${count+1}.params`);
      const file = await open(candidate,'wx',0o600); let length=0;
      try { for await (const bytes of request) { length+=bytes.length; if(length>metadata.byteLength+384) throw new Error('size'); await file.writeFile(bytes); } }
      finally { await file.close(); }
      assert.equal(length,metadata.byteLength+384); upload=await digest(candidate); response.end('{}');
    } else if (request.url === '/verify' && request.method === 'POST') {
      let bytes=''; for await (const chunk of request) { bytes+=chunk.toString(); if(bytes.length>2048) throw new Error('bound'); }
      const claim=JSON.parse(bytes); assert.equal(claim.zkeyHash,`0x${upload.sha256}`);
      const result=await runner.run({ predecessorPath:head,candidatePath:candidate,genesisPath:'',ptauPath:'',
        expectedContributionName:'browser-test',expectedContributionHashBlake2b512:claim.contributionHash.replace(/^0x/,''),maxPredecessorContributions:count },300000);
      assert.equal(result.result,'valid'); head=candidate; metadata=upload; count++;
      response.end(JSON.stringify({ verified:true,count }));
    } else { response.statusCode=404; response.end(); }
  } catch { response.statusCode=500; response.end('test failed'); }
});
await new Promise(resolveListen => server.listen(0,'127.0.0.1',resolveListen));
const port=server.address().port;
let browser;
try {
  browser=await chromium.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true });
  const page=await browser.newPage(); await page.goto(`http://127.0.0.1:${port}`);
  for(let i=1;i<=3;i++) {
    const result=await page.evaluate(async () => {
      const metadata=await (await fetch('/metadata')).json(); const start=performance.now();
      const output=await new Promise((resolveWorker,reject) => {
        const worker=new Worker('/worker.js',{type:'module'});
        worker.onerror=()=>{worker.terminate();reject(new Error('worker failed'));};
        worker.onmessage=({data})=>{
          if(data.type==='error'){worker.terminate();reject(new Error('worker rejected input'));}
          else if(data.type==='opfsResult'){worker.terminate();resolveWorker(data);}
        };
        worker.postMessage({type:'contributeOpfs',artifactFormat:'bellman',source:{kind:'download',url:new URL('/head',location.href).href,expectedSize:metadata.byteLength,expectedSha256:`0x${metadata.sha256}`},entropy:crypto.getRandomValues(new Uint8Array(64)),name:'browser-test'});
      });
      const computeAndDownloadMs=Math.round(performance.now()-start);
      const file=await output.outputFile.getFile();
      if(!(await fetch('/upload',{method:'POST',body:file})).ok)throw new Error('upload failed');
      const response=await fetch('/verify',{method:'POST',body:JSON.stringify({zkeyHash:output.zkeyHash,contributionHash:output.contributionHash})});
      if(!response.ok)throw new Error('verification failed');
      const verification=await response.json();
      await (await navigator.storage.getDirectory()).removeEntry(output.outputFileName);
      return { verified:verification.verified,generation:verification.count,outputSize:output.outputSize,computeAndDownloadMs };
    });
    assert.equal(result.verified,true); assert.equal(result.generation,i);
    console.log(JSON.stringify(result));
  }
  console.log('PASS: three integrated OPFS Bellman browser contributions, each directly verified; no zkey import.');
} finally { await browser?.close(); await new Promise(r=>server.close(r)); await rm(directory,{recursive:true,force:true}); }
