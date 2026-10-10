import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { executeResearchJob, type ResearchWorkerJob } from './research.js';

// Importing this module on main is harmless. No filesystem/API/SQLite writes here.
if (!isMainThread && parentPort) {
  try { parentPort.postMessage({ok:true,value:executeResearchJob(workerData as ResearchWorkerJob)}); }
  catch (error) { parentPort.postMessage({ok:false,error:error instanceof Error?error.message:String(error)}); }
}
