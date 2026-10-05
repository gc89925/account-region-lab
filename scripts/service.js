import { startWorkspace } from './launch.js';
import { launchSettings } from '../lib/workspace.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let logFile;
function record(message) {
  const line=`${new Date().toISOString()} ${message}\n`;
  if(logFile) appendFileSync(logFile,line,{mode:0o600});
  else console.error(line.trim());
}
try {
  const settings=launchSettings();
  const logDir=join(settings.dataDir,'logs');mkdirSync(logDir,{recursive:true,mode:0o700});logFile=join(logDir,'service.log');
  const workspace=await startWorkspace(settings);
  record(`Service ${workspace.reused?'already running':'started'}: ${workspace.url}`);
  if(!workspace.reused) for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>workspace.close().finally(()=>{record('Service stopped.');process.exit(0);}));
} catch(error) {
  record(`Startup failed: ${error.message}`);
  process.exitCode=1;
}
