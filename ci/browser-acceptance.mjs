import fs from 'node:fs';
import path from 'node:path';
import {runBrowserAcceptance} from './browser-acceptance-lib.mjs';

const args=process.argv.slice(2);const valueOf=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:'';};
const extensionDir=path.resolve(valueOf('--extension-dir')||process.cwd());
const chromiumPath=valueOf('--chromium')||'';
const reportPath=path.resolve(valueOf('--report')||path.join(process.cwd(),'browser-acceptance-report.json'));
const report=await runBrowserAcceptance({extensionDir,chromiumPath});
fs.writeFileSync(reportPath,`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify(report,null,2));
if(report.status==='FAIL')process.exitCode=1;
else if(report.status==='BLOCKED')process.exitCode=2;
