import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
export const json=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x);
export const canonicalJson=v=>json(v===null||typeof v!=='object'?v:Array.isArray(v)?v.map(x=>JSON.parse(canonicalJson(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonicalJson(v[k]))])));
export const digest=v=>createHash('sha256').update(v).digest('hex');
export const identifier=()=>randomBytes(16).toString('hex');
export const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function fields(v,allowed){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k)))throw fail('请求参数无效');return v;}
export const raw=v=>{if(typeof v!=='string'||!/^\d{1,78}$/.test(v)||BigInt(v)<=0n)throw fail('金额须为正整数字符串');return BigInt(v);};
export class PlatformStore{
 constructor(directory){mkdirSync(directory,{recursive:true});this.path=resolve(directory,'platform.sqlite');this.db=new DatabaseSync(this.path);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS credentials(hash TEXT PRIMARY KEY,kind TEXT NOT NULL,owner TEXT NOT NULL,agent TEXT,expires INTEGER NOT NULL,csrf TEXT);
 CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY,owner TEXT,address TEXT NOT NULL,purpose TEXT NOT NULL,target TEXT,message TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS intents(agent TEXT NOT NULL,requestKey TEXT NOT NULL,signature TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(agent,requestKey));
 CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,owner TEXT,agent TEXT,kind TEXT NOT NULL,message TEXT NOT NULL);
 `);this.depth=0;}
 get(kind,id){const r=this.db.prepare('SELECT payload FROM entities WHERE kind=? AND id=?').get(kind,id);return r?JSON.parse(r.payload):null;}
 all(kind){return this.db.prepare('SELECT payload FROM entities WHERE kind=? ORDER BY rowid').all(kind).map(r=>JSON.parse(r.payload));}
 put(kind,value){this.db.prepare('INSERT INTO entities VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload').run(kind,value.id,json(value));return value;}
 transaction(fn){if(this.depth)return fn();this.db.exec('BEGIN IMMEDIATE');this.depth++;try{const value=fn();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}finally{this.depth--;}}
 audit(owner,agent,kind,message){this.db.prepare('INSERT INTO audit(at,owner,agent,kind,message) VALUES(?,?,?,?,?)').run(Date.now(),owner??null,agent??null,kind,message);}
 close(){this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');this.db.close();}
}
