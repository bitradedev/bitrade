import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
const content=readFileSync('.dev.vars','utf8'),values={};
for(const line of content.split('\n')){const i=line.indexOf('=');if(i>0)values[line.slice(0,i)]=line.slice(i+1).trim();}
const secrets=Object.fromEntries(['BI_TRADE_VAULT_KEY','BI_TRADE_AI_API_KEY','GMGN_API_KEY','BI_TRADE_MIGRATION_TOKEN'].filter(k=>values[k]).map(k=>[k,values[k]]));
if(!secrets.BI_TRADE_VAULT_KEY)throw Error('Vault secret is required');
const child=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'secret','bulk'],{stdio:['pipe','inherit','inherit'],windowsHide:true});child.stdin.end(JSON.stringify(secrets));child.on('exit',code=>process.exitCode=code??1);
