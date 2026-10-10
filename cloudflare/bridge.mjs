export async function handleFetch(app,request,ip){
 const url=new URL(request.url),headers=Object.fromEntries(request.headers);headers.host=url.host;
 const req={url:url.pathname+url.search,method:request.method,headers,socket:{remoteAddress:ip},async *[Symbol.asyncIterator](){
  if(!request.body)return;const reader=request.body.getReader();try{while(true){const {done,value}=await reader.read();if(done)return;yield Buffer.from(value);}}finally{reader.releaseLock();}
 }};
 const out=new Headers();let status=200,body=null;
 const res={setHeader(name,value){out.set(name,value);},writeHead(code,values){status=code;for(const [k,v]of Object.entries(values??{}))out.set(k,v);},end(value){body=value??null;}};
 await app.handler(req,res);return new Response(body,{status,headers:out});
}
