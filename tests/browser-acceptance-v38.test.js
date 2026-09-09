import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';

const mod=await import('../scripts/browser-acceptance-lib.mjs');
const {classifyExtensionPolicy,findExtensionServiceWorker,buildChromiumArgs,normalizeAcceptanceReport,createCdpPipeClient}=mod;

test('v38 browser acceptance classifies wildcard enterprise extension blocklist as BLOCKED',()=>{
  const result=classifyExtensionPolicy({ExtensionInstallBlocklist:['*'],DeveloperToolsAvailability:0});
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.code,'EXTENSION_INSTALL_BLOCKED_BY_POLICY');
  assert.equal(result.policy.ExtensionInstallBlocklist[0],'*');
});

test('v38 browser acceptance does not treat unrelated managed policies as extension block',()=>{
  const result=classifyExtensionPolicy({URLBlocklist:['*'],DeveloperToolsAvailability:0});
  assert.equal(result.status,'CLEAR');
  assert.equal(result.code,'NO_EXTENSION_POLICY_BLOCK');
});

test('v38 browser acceptance finds MV3 service worker and derives extension id',()=>{
  const targets=[
    {type:'page',url:'about:blank'},
    {type:'service_worker',url:'chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/background/service-worker.js',webSocketDebuggerUrl:'ws://example/sw'},
  ];
  const found=findExtensionServiceWorker(targets,'src/background/service-worker.js');
  assert.equal(found.extensionId,'abcdefghijklmnopabcdefghijklmnop');
  assert.equal(found.target.type,'service_worker');
});

test('v38 browser acceptance rejects ambiguous or wrong service-worker evidence',()=>{
  assert.equal(findExtensionServiceWorker([], 'src/background/service-worker.js'),null);
  assert.equal(findExtensionServiceWorker([{type:'service_worker',url:'https://example.com/sw.js'}], 'src/background/service-worker.js'),null);
});

test('v38 browser acceptance uses modern CDP pipe extension installation instead of removed Chrome flags',()=>{
  const args=buildChromiumArgs({extensionDir:'/tmp/ext',profileDir:'/tmp/profile',port:9444,startUrl:'about:blank'});
  assert.ok(args.includes('--user-data-dir=/tmp/profile'));
  assert.ok(args.includes('--remote-debugging-pipe'));
  assert.ok(args.includes('--enable-unsafe-extension-debugging'));
  assert.equal(args.some(value=>value.startsWith('--remote-debugging-port=')),false);
  assert.equal(args.some(value=>value.startsWith('--load-extension=')),false);
  assert.equal(args.some(value=>value.startsWith('--disable-extensions-except=')),false);
  assert.equal(args.at(-1),'about:blank');
});

test('v38 browser acceptance adds no-sandbox only for root Linux launch',()=>{
  const rootLinux=buildChromiumArgs({extensionDir:'/tmp/ext',profileDir:'/tmp/profile',port:9444,startUrl:'about:blank',platform:'linux',uid:0});
  assert.ok(rootLinux.includes('--no-sandbox'));
  const regularLinux=buildChromiumArgs({extensionDir:'/tmp/ext',profileDir:'/tmp/profile',port:9444,startUrl:'about:blank',platform:'linux',uid:1000});
  assert.equal(regularLinux.includes('--no-sandbox'),false);
  const windows=buildChromiumArgs({extensionDir:'C:\\ext',profileDir:'C:\\profile',port:9444,startUrl:'about:blank',platform:'win32',uid:0});
  assert.equal(windows.includes('--no-sandbox'),false);
});

test('v38 browser acceptance uses Chrome new-headless on Linux so CDP pipe owns fd3/fd4 directly',()=>{
  const linux=buildChromiumArgs({extensionDir:'/tmp/ext',profileDir:'/tmp/profile',port:9444,startUrl:'about:blank',platform:'linux',uid:1000});
  assert.ok(linux.includes('--headless=new'));
  const windows=buildChromiumArgs({extensionDir:'C:\\ext',profileDir:'C:\\profile',port:9444,startUrl:'about:blank',platform:'win32',uid:1000});
  assert.equal(windows.includes('--headless=new'),false);
});

test('v38 CDP pipe client sends null-delimited commands and resolves matching responses',async()=>{
  const commandPipe=new PassThrough();
  const responsePipe=new PassThrough();
  const client=createCdpPipeClient({commandPipe,responsePipe,timeoutMs:1000});
  const seen=new Promise(resolve=>commandPipe.once('data',chunk=>resolve(String(chunk))));
  const pending=client.send('Browser.getVersion');
  const raw=await seen;
  assert.equal(raw.endsWith('\0'),true);
  const request=JSON.parse(raw.slice(0,-1));
  assert.equal(request.method,'Browser.getVersion');
  responsePipe.write(`${JSON.stringify({id:request.id,result:{product:'Chrome/152.0.0.0'}})}\0`);
  const result=await pending;
  assert.equal(result.product,'Chrome/152.0.0.0');
  client.close();
});

test('v38 CDP pipe client preserves sessionId for target-scoped commands',async()=>{
  const commandPipe=new PassThrough();
  const responsePipe=new PassThrough();
  const client=createCdpPipeClient({commandPipe,responsePipe,timeoutMs:1000});
  const seen=new Promise(resolve=>commandPipe.once('data',chunk=>resolve(String(chunk))));
  const pending=client.send('Runtime.evaluate',{expression:'1+1'},{sessionId:'session-1'});
  const raw=await seen;
  const request=JSON.parse(raw.slice(0,-1));
  assert.equal(request.sessionId,'session-1');
  responsePipe.write(`${JSON.stringify({id:request.id,sessionId:'session-1',result:{result:{value:2}}})}\0`);
  const result=await pending;
  assert.equal(result.result.value,2);
  client.close();
});

test('v38 browser acceptance report is fail-closed when required runtime evidence is incomplete',()=>{
  assert.deepEqual(normalizeAcceptanceReport({policy:'CLEAR',browserStarted:true,serviceWorker:false,sidePanel:false,version:'38.0.0'}).status,'FAIL');
  assert.deepEqual(normalizeAcceptanceReport({policy:'CLEAR',browserStarted:true,serviceWorker:true,sidePanel:true,version:'38.0.0',expectedVersion:'38.0.0'}).status,'PASS');
  assert.deepEqual(normalizeAcceptanceReport({policy:'BLOCKED',code:'EXTENSION_INSTALL_BLOCKED_BY_POLICY'}).status,'BLOCKED');
});

test('v38 browser acceptance resolves Chrome path portably across Windows and Linux',()=>{
  const {resolveChromiumPath}=mod;
  const exists=value=>value==='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'||value==='/usr/bin/chromium';
  assert.equal(resolveChromiumPath({platform:'win32',env:{ProgramFiles:'C:\\Program Files'},exists}), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(resolveChromiumPath({platform:'linux',env:{},exists}),'/usr/bin/chromium');
});

test('v38 browser acceptance fails closed when no supported Chrome binary exists',()=>{
  const {resolveChromiumPath}=mod;
  assert.throws(()=>resolveChromiumPath({platform:'win32',env:{},exists:()=>false}),error=>error?.code==='CHROMIUM_NOT_FOUND');
});

test('v38 browser acceptance waits for service-worker runtime readiness after target discovery',async()=>{
  const {waitForExtensionServiceWorkerRuntime}=mod;
  let evaluateCalls=0;
  const client={
    async send(method){
      if(method==='Target.getTargets')return {targetInfos:[{targetId:'sw-1',type:'service_worker',url:'chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/background/service-worker.js'}]};
      if(method==='Target.attachToTarget')return {sessionId:'session-1'};
      if(method==='Runtime.evaluate'){
        evaluateCalls+=1;
        if(evaluateCalls===1)return {result:{type:'undefined'}};
        return {result:{type:'object',value:{id:'abcdefghijklmnopabcdefghijklmnop',version:'38.0.6'}}};
      }
      throw new Error(`unexpected method ${method}`);
    }
  };
  const result=await waitForExtensionServiceWorkerRuntime(client,{
    expectedPath:'src/background/service-worker.js',
    expectedExtensionId:'abcdefghijklmnopabcdefghijklmnop',
    expectedVersion:'38.0.6',
    timeoutMs:500,
    pollMs:1,
  });
  assert.equal(result?.ready,true);
  assert.equal(result?.info?.version,'38.0.6');
  assert.equal(evaluateCalls,2);
});

test('v38 browser acceptance retries transient worker evaluation failures before declaring incomplete',async()=>{
  const {waitForExtensionServiceWorkerRuntime}=mod;
  let evaluateCalls=0;
  const client={
    async send(method){
      if(method==='Target.getTargets')return {targetInfos:[{targetId:'sw-2',type:'service_worker',url:'chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/background/service-worker.js'}]};
      if(method==='Target.attachToTarget')return {sessionId:'session-2'};
      if(method==='Runtime.evaluate'){
        evaluateCalls+=1;
        if(evaluateCalls===1)throw Object.assign(new Error('Execution context was destroyed'),{code:'CDP_COMMAND_FAILED'});
        return {result:{type:'object',value:{id:'abcdefghijklmnopabcdefghijklmnop',version:'38.0.6'}}};
      }
      throw new Error(`unexpected method ${method}`);
    }
  };
  const result=await waitForExtensionServiceWorkerRuntime(client,{
    expectedPath:'src/background/service-worker.js',
    expectedExtensionId:'abcdefghijklmnopabcdefghijklmnop',
    expectedVersion:'38.0.6',
    timeoutMs:500,
    pollMs:1,
  });
  assert.equal(result?.ready,true);
  assert.equal(evaluateCalls,2);
});
