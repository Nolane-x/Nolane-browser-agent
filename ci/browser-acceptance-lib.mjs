import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const POLICY_PATHS=Object.freeze([
  '/etc/chromium/policies/managed/000_policy_merge.json',
  '/etc/chromium/policies/managed/policies.json',
  '/etc/opt/chrome/policies/managed/policies.json',
]);

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const safeArray=value=>Array.isArray(value)?value.filter(item=>typeof item==='string').slice(0,256):[];
const safePolicy=value=>{
  const source=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  return Object.freeze({
    ExtensionInstallBlocklist:Object.freeze(safeArray(source.ExtensionInstallBlocklist)),
    ExtensionInstallAllowlist:Object.freeze(safeArray(source.ExtensionInstallAllowlist)),
    ExtensionInstallForcelist:Object.freeze(safeArray(source.ExtensionInstallForcelist)),
    DeveloperToolsAvailability:Number.isInteger(source.DeveloperToolsAvailability)?source.DeveloperToolsAvailability:null,
  });
};

export function classifyExtensionPolicy(policy={}){
  const normalized=safePolicy(policy);
  if(normalized.ExtensionInstallBlocklist.includes('*')){
    return Object.freeze({status:'BLOCKED',code:'EXTENSION_INSTALL_BLOCKED_BY_POLICY',policy:normalized});
  }
  return Object.freeze({status:'CLEAR',code:'NO_EXTENSION_POLICY_BLOCK',policy:normalized});
}

export function readChromiumManagedPolicy({paths=POLICY_PATHS}={}){
  const merged={};
  const sources=[];
  for(const candidate of paths){
    try{
      const parsed=JSON.parse(fs.readFileSync(candidate,'utf8'));
      if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)){Object.assign(merged,parsed);sources.push(path.resolve(candidate));}
    }catch{}
  }
  return Object.freeze({policy:safePolicy(merged),sources:Object.freeze(sources)});
}

export function resolveChromiumPath({platform=process.platform,env=process.env,exists=fs.existsSync,explicit=''}={}){
  const candidates=[];
  if(explicit)candidates.push(explicit);
  if(platform==='win32'){
    const join=(base,...rest)=>base?path.win32.join(base,...rest):'';
    candidates.push(
      join(env.ProgramFiles,'Google','Chrome','Application','chrome.exe'),
      join(env['ProgramFiles(x86)'],'Google','Chrome','Application','chrome.exe'),
      join(env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe'),
      join(env.ProgramFiles,'Chromium','Application','chrome.exe'),
      join(env['ProgramFiles(x86)'],'Chromium','Application','chrome.exe')
    );
  }else if(platform==='darwin'){
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium');
  }else{
    candidates.push('/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser');
  }
  for(const candidate of candidates){if(candidate&&exists(candidate))return candidate;}
  const error=new Error('No supported Chrome/Chromium binary was found');error.code='CHROMIUM_NOT_FOUND';throw error;
}

export function findExtensionServiceWorker(targets,expectedPath='src/background/service-worker.js'){
  if(!Array.isArray(targets))return null;
  const escaped=String(expectedPath).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern=new RegExp(`^chrome-extension://([a-p]{32})/${escaped}$`);
  const matches=[];
  for(const target of targets){
    if(!target||target.type!=='service_worker'||typeof target.url!=='string')continue;
    const match=target.url.match(pattern);if(match)matches.push({extensionId:match[1],target});
  }
  return matches.length===1?Object.freeze(matches[0]):null;
}

export function buildChromiumArgs({extensionDir,profileDir,port,startUrl='about:blank',platform=process.platform,uid=process.getuid?.()}={}){
  if(!extensionDir||!profileDir||!Number.isSafeInteger(port)||port<1024||port>65535)throw new TypeError('browser acceptance launch arguments are invalid');
  const profile=path.resolve(profileDir);
  const args=[
    `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run','--no-default-browser-check','--disable-gpu','--disable-dev-shm-usage',
  ];
  if(platform==='linux')args.push('--headless=new');
  if(platform==='linux'&&uid===0)args.push('--no-sandbox');
  args.push(String(startUrl||'about:blank'));
  return args;
}

export function createCdpPipeClient({commandPipe,responsePipe,timeoutMs=3000}={}){
  if(!commandPipe?.write||!responsePipe?.on)throw new TypeError('CDP pipe streams are required');
  let nextId=1;
  let closed=false;
  let buffered=Buffer.alloc(0);
  const pending=new Map();
  const rejectAll=error=>{for(const {reject,timer} of pending.values()){clearTimeout(timer);reject(error);}pending.clear();};
  const onData=chunk=>{
    const incoming=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    buffered=buffered.length?Buffer.concat([buffered,incoming]):incoming;
    for(;;){
      const end=buffered.indexOf(0);
      if(end<0)break;
      const frame=buffered.subarray(0,end).toString('utf8');
      buffered=buffered.subarray(end+1);
      if(!frame)continue;
      let message;
      try{message=JSON.parse(frame);}catch{continue;}
      if(!Number.isSafeInteger(message?.id))continue;
      const waiter=pending.get(message.id);
      if(!waiter)continue;
      pending.delete(message.id);clearTimeout(waiter.timer);
      if(message.error){
        const error=Object.assign(new Error(message.error.message||'CDP command failed'),{code:'CDP_COMMAND_FAILED',cdpCode:message.error.code,details:message.error.data});
        waiter.reject(error);
      }else waiter.resolve(message.result||{});
    }
  };
  const onClose=()=>{if(closed)return;closed=true;rejectAll(Object.assign(new Error('CDP pipe closed'),{code:'CDP_PIPE_CLOSED'}));};
  const onError=error=>{if(closed)return;closed=true;rejectAll(Object.assign(error instanceof Error?error:new Error(String(error||'CDP pipe failed')),{code:'CDP_PIPE_FAILED'}));};
  responsePipe.on('data',onData);responsePipe.on('close',onClose);responsePipe.on('error',onError);commandPipe.on?.('error',onError);
  const send=(method,params={},options={})=>new Promise((resolve,reject)=>{
    if(closed)return reject(Object.assign(new Error('CDP pipe is closed'),{code:'CDP_PIPE_CLOSED'}));
    if(typeof method!=='string'||!method)return reject(new TypeError('CDP method is required'));
    const id=nextId++;
    const timeout=Number.isFinite(options.timeoutMs)&&options.timeoutMs>0?options.timeoutMs:timeoutMs;
    const timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(new Error(`CDP command timed out: ${method}`),{code:'CDP_COMMAND_TIMEOUT',method}));},timeout);
    pending.set(id,{resolve,reject,timer});
    const message={id,method,params:params&&typeof params==='object'?params:{}};
    if(typeof options.sessionId==='string'&&options.sessionId)message.sessionId=options.sessionId;
    try{commandPipe.write(`${JSON.stringify(message)}\0`);}catch(error){clearTimeout(timer);pending.delete(id);reject(error);}
  });
  const close=()=>{
    if(closed)return;closed=true;
    responsePipe.off?.('data',onData);responsePipe.off?.('close',onClose);responsePipe.off?.('error',onError);commandPipe.off?.('error',onError);
    rejectAll(Object.assign(new Error('CDP pipe client closed'),{code:'CDP_PIPE_CLOSED'}));
  };
  return Object.freeze({send,close});
}

export function normalizeAcceptanceReport(input={}){
  const policy=input.policy==='BLOCKED'?'BLOCKED':'CLEAR';
  if(policy==='BLOCKED')return Object.freeze({status:'BLOCKED',code:input.code||'EXTENSION_INSTALL_BLOCKED_BY_POLICY'});
  const versionMatch=typeof input.expectedVersion==='string'&&input.expectedVersion.length>0&&input.version===input.expectedVersion;
  const pass=input.browserStarted===true&&input.serviceWorker===true&&input.sidePanel===true&&versionMatch;
  return Object.freeze({status:pass?'PASS':'FAIL',code:pass?'BROWSER_ACCEPTANCE_PASSED':'BROWSER_ACCEPTANCE_INCOMPLETE',browserStarted:input.browserStarted===true,serviceWorker:input.serviceWorker===true,sidePanel:input.sidePanel===true,version:String(input.version||''),expectedVersion:String(input.expectedVersion||'')});
}

export async function cdpEvaluate(webSocketDebuggerUrl,expression,{timeoutMs=3000}={}){
  if(typeof WebSocket!=='function')throw Object.assign(new Error('WebSocket is unavailable'),{code:'CDP_WEBSOCKET_UNAVAILABLE'});
  return await new Promise((resolve,reject)=>{
    const ws=new WebSocket(webSocketDebuggerUrl);const id=1;let settled=false;
    const done=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);try{ws.close();}catch{}fn(value);};
    const timer=setTimeout(()=>done(reject,Object.assign(new Error('CDP evaluate timed out'),{code:'CDP_EVALUATE_TIMEOUT'})),timeoutMs);
    ws.onerror=()=>done(reject,Object.assign(new Error('CDP websocket failed'),{code:'CDP_WEBSOCKET_FAILED'}));
    ws.onopen=()=>ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));
    ws.onmessage=event=>{let msg;try{msg=JSON.parse(String(event.data));}catch{return;}if(msg?.id!==id)return;if(msg.error)return done(reject,Object.assign(new Error(msg.error.message||'CDP evaluate failed'),{code:'CDP_EVALUATE_FAILED'}));if(msg.result?.exceptionDetails)return done(reject,Object.assign(new Error(msg.result.exceptionDetails.text||'CDP expression threw'),{code:'CDP_EXPRESSION_FAILED'}));done(resolve,msg.result?.result?.value);};
  });
}

function launchChromium({chromiumPath,extensionDir,profileDir,port,logPath}){
  const args=buildChromiumArgs({extensionDir,profileDir,port});
  const out=fs.openSync(logPath,'a');
  const child=spawn(chromiumPath,args,{stdio:['ignore',out,out,'pipe','pipe'],detached:false,env:{...process.env}});
  child.once('exit',()=>{try{fs.closeSync(out);}catch{}});
  return Object.freeze({child,commandPipe:child.stdio[3],responsePipe:child.stdio[4]});
}

const evaluationValue=result=>result?.result?.value;

async function waitForExtensionServiceWorker(client,expectedPath,timeoutMs){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const targetResult=await client.send('Target.getTargets',{}, {timeoutMs:Math.min(3000,Math.max(250,deadline-Date.now()))});
    const found=findExtensionServiceWorker(targetResult?.targetInfos,expectedPath);
    if(found)return found;
    await sleep(150);
  }
  return null;
}

async function waitForPanelReady(client,sessionId,expectedVersion,timeoutMs=5000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const evaluated=await client.send('Runtime.evaluate',{expression:'({ready:document.readyState,body:document.body instanceof HTMLElement,version:chrome.runtime.getManifest().version})',returnByValue:true,awaitPromise:true},{sessionId,timeoutMs:Math.min(3000,Math.max(250,deadline-Date.now()))});
    const info=evaluationValue(evaluated);
    if(Boolean(info?.body)&&['interactive','complete'].includes(info?.ready)&&info?.version===expectedVersion)return true;
    await sleep(100);
  }
  return false;
}

export async function runBrowserAcceptance({extensionDir,chromiumPath='',policyPaths=POLICY_PATHS,port=9444,timeoutMs=20000,workDir}={}){
  const manifest=JSON.parse(fs.readFileSync(path.join(extensionDir,'manifest.json'),'utf8'));
  const resolvedChromium=resolveChromiumPath({explicit:chromiumPath});
  const policyEvidence=readChromiumManagedPolicy({paths:policyPaths});
  const policyClass=classifyExtensionPolicy(policyEvidence.policy);
  if(policyClass.status==='BLOCKED')return Object.freeze({status:'BLOCKED',code:policyClass.code,policy:policyClass.policy,policySources:policyEvidence.sources,expectedVersion:String(manifest.version||'')});
  const base=workDir||fs.mkdtempSync(path.join(process.cwd(),'.browser-acceptance-'));
  const profileDir=path.join(base,'profile');fs.mkdirSync(profileDir,{recursive:true});const logPath=path.join(base,'chromium.log');
  const launched=launchChromium({chromiumPath:resolvedChromium,extensionDir,profileDir,port,logPath});
  const {child,commandPipe,responsePipe}=launched;
  const client=createCdpPipeClient({commandPipe,responsePipe,timeoutMs});
  let browserStarted=false;
  let browserVersion='';
  let extensionId='';
  let stage='browser_start';
  try{
    const versionInfo=await client.send('Browser.getVersion',{}, {timeoutMs});
    browserStarted=true;browserVersion=String(versionInfo?.product||'');
    stage='extension_install';
    const installed=await client.send('Extensions.loadUnpacked',{path:path.resolve(extensionDir)},{timeoutMs});
    extensionId=String(installed?.id||'');
    if(!/^[a-p]{32}$/.test(extensionId))throw Object.assign(new Error('Chrome did not return a valid unpacked extension id'),{code:'EXTENSION_INSTALL_ID_INVALID'});
    stage='service_worker';
    const sw=await waitForExtensionServiceWorker(client,manifest.background?.service_worker||'src/background/service-worker.js',timeoutMs);
    if(!sw){
      const report=normalizeAcceptanceReport({policy:'CLEAR',browserStarted:true,serviceWorker:false,sidePanel:false,expectedVersion:String(manifest.version||'')});
      return Object.freeze({...report,extensionId,browserVersion,extensionLoadMethod:'cdp_pipe',failureStage:stage,logPath});
    }
    if(sw.extensionId!==extensionId)throw Object.assign(new Error('Observed service worker belongs to an unexpected extension id'),{code:'EXTENSION_ID_MISMATCH'});
    const attachedSw=await client.send('Target.attachToTarget',{targetId:sw.target.targetId,flatten:true},{timeoutMs:5000});
    const swInfoResult=await client.send('Runtime.evaluate',{expression:'({id:chrome.runtime.id,version:chrome.runtime.getManifest().version})',returnByValue:true,awaitPromise:true},{sessionId:attachedSw.sessionId,timeoutMs:5000});
    const swInfo=evaluationValue(swInfoResult);
    stage='side_panel';
    const sidePanelPath=manifest.side_panel?.default_path||'src/sidepanel/index.html';
    const sideUrl=`chrome-extension://${extensionId}/${sidePanelPath}`;
    const panelTarget=await client.send('Target.createTarget',{url:sideUrl},{timeoutMs:5000});
    let panelReady=false;
    if(panelTarget?.targetId){
      const attachedPanel=await client.send('Target.attachToTarget',{targetId:panelTarget.targetId,flatten:true},{timeoutMs:5000});
      if(attachedPanel?.sessionId)panelReady=await waitForPanelReady(client,attachedPanel.sessionId,String(manifest.version||''),5000);
    }
    const report=normalizeAcceptanceReport({policy:'CLEAR',browserStarted:true,serviceWorker:swInfo?.id===extensionId,sidePanel:panelReady,version:swInfo?.version,expectedVersion:String(manifest.version||'')});
    return Object.freeze({...report,extensionId,browserVersion,extensionLoadMethod:'cdp_pipe',failureStage:report.status==='PASS'?'':stage,logPath});
  }catch(error){
    const report=normalizeAcceptanceReport({policy:'CLEAR',browserStarted,serviceWorker:false,sidePanel:false,expectedVersion:String(manifest.version||'')});
    return Object.freeze({...report,browserVersion,extensionId,extensionLoadMethod:'cdp_pipe',failureStage:stage,errorCode:String(error?.code||'BROWSER_ACCEPTANCE_ERROR'),errorMessage:String(error?.message||error||'browser acceptance failed'),logPath});
  }finally{
    client.close();
    try{child.kill('SIGTERM');}catch{}
    await sleep(100);
    try{if(!child.killed)child.kill('SIGKILL');}catch{}
  }
}

export const browserAcceptancePolicyPaths=POLICY_PATHS;
