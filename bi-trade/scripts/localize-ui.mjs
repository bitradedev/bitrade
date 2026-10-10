import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(resolve(project,'../paper-terminal/package.json'));
const ts=require('typescript');
const hasHan=s=>/[\u4e00-\u9fff]/.test(s);
const pieces=new Set();
function collect(s){
 if(!hasHan(s))return;
 if(!/<[a-z/!][^>]*>/i.test(s)){pieces.add(s);return;}
 for(const bit of s.split(/(<[^>]*>)/g)){
  if(bit.startsWith('<')){for(const m of bit.matchAll(/(?:aria-label|title|alt|placeholder|value)\s*=\s*(["'])(.*?)\1/g))if(hasHan(m[2]))pieces.add(m[2]);}
  else if(hasHan(bit))pieces.add(bit);
 }
}
const files=['app.js','home.js','intro.js'];
function nodesFor(source,name){
 const tree=ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),nodes=[];
 function walk(node){
  if((ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)||node.kind===ts.SyntaxKind.TemplateHead||node.kind===ts.SyntaxKind.TemplateMiddle||node.kind===ts.SyntaxKind.TemplateTail)&&hasHan(node.text??''))nodes.push(node);
  ts.forEachChild(node,walk);
 }walk(tree);return nodes;
}
for(const name of files){const source=readFileSync(resolve(project,'web',name),'utf8');for(const node of nodesFor(source,name))collect(node.text);}
for(const name of ['index.html','intro.html'])collect(readFileSync(resolve(project,'web',name),'utf8'));
const list=[...pieces].sort((a,b)=>b.length-a.length);
mkdirSync(resolve(project,'data/ui-work'),{recursive:true});
writeFileSync(resolve(project,'data/ui-work/strings.json'),JSON.stringify(list,null,2));
console.log(JSON.stringify({strings:list.length}));
if(process.argv.includes('--apply')){
 for(const name of files){
  let source=readFileSync(resolve(project,'web',name),'utf8');const changes=[];
  for(const node of nodesFor(source,name)){
   const start=node.getStart(),end=node.getEnd();
   if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)){
    if(node.parent&&((ts.isPropertyAssignment(node.parent)&&node.parent.name===node)||ts.isElementAccessExpression(node.parent)))continue;
    if(node.parent&&ts.isCallExpression(node.parent)&&node.parent.expression.getText().startsWith('BiUI.'))continue;
    changes.push({start,end,text:'BiUI.t('+JSON.stringify(node.text)+')'});
   }else{
    const prefix=node.kind===ts.SyntaxKind.TemplateHead?1:1,suffix=node.kind===ts.SyntaxKind.TemplateTail?1:2;
    changes.push({start:start+prefix,end:end-suffix,text:'${BiUI.t('+JSON.stringify(node.text)+')}'});
   }
  }
  for(const change of changes.sort((a,b)=>b.start-a.start))source=source.slice(0,change.start)+change.text+source.slice(change.end);
  writeFileSync(resolve(project,'web',name),source);
  console.log(name+': '+changes.length+' localized literals');
 }
}
