(()=>{
 'use strict';
 const root=document.documentElement,dictionary=window.BI_UI_EN??{};
 const read=(key,allowed,fallback)=>{try{const value=localStorage.getItem(key);return allowed.includes(value)?value:fallback;}catch{return fallback;}};
 const save=(key,value)=>{try{localStorage.setItem(key,value);}catch{}};
 let theme=read('bi-ui-theme',['light','dark'],'light'),language=read('bi-ui-language',['zh','en'],'zh');
 function phrase(value){
  if(language!=='en')return value;
  if(Object.hasOwn(dictionary,value))return dictionary[value];
  const trimmed=value.trim();
  if(Object.hasOwn(dictionary,trimmed))return value.slice(0,value.indexOf(trimmed))+dictionary[trimmed]+value.slice(value.indexOf(trimmed)+trimmed.length);
  return value;
 }
 function systemMessage(value){
  const input=String(value??'');
  if(/^(?:等待站点管理员配置 OpenAI|OpenAI |AI 服务(?:响应|连接|暂时|配置))/.test(input))return phrase('本轮评估暂未更新。');
  if(language==='zh'&&input==='The operation was aborted due to timeout')return '请求超时，本轮未成交；等待下一轮评估。';
  return phrase(input);
 }
 const escapeAttribute=value=>value.replace(/[&"<>]/g,c=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[c]));
 function t(value){
  const input=String(value??'');if(language!=='en')return input;
  const direct=phrase(input);if(direct!==input)return direct;
  if(!/[<>]/.test(input))return input;
  // Only source-authored fragments enter this helper; user names and messages bypass it.
  return input.split(/(<[^>]*>|^[^<]*>)/g).map(part=>{
   const translatedPart=phrase(part);if(translatedPart!==part)return translatedPart;
   if(part.startsWith('<')||part.endsWith('>'))return part.replace(/((?:aria-label|title|alt|placeholder|value)\s*=\s*")([^"]*)(")/g,(_,before,value,after)=>before+(phrase(value)===value?value:escapeAttribute(phrase(value)))+after);
   return phrase(part);
  }).join('');
 }
 function applyTheme(){root.dataset.theme=theme;root.lang=language==='en'?'en':'zh-CN';root.dataset.language=language;const meta=document.querySelector?.('meta[name="theme-color"]');if(meta)meta.content=theme==='light'?'#f6f8fc':'#101722';}
 function translateStatic(container){
  if(language!=='en'||!container)return;
  const walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT);
  let node;while(node=walker.nextNode()){if(!node.parentElement.closest('script,style,pre,code,[data-original-language]'))node.data=phrase(node.data);}
  for(const el of [container,...container.querySelectorAll('*')])for(const attr of ['aria-label','placeholder','title','alt'])if(el.hasAttribute(attr))el.setAttribute(attr,phrase(el.getAttribute(attr)));
 }
 function controls(){
  document.querySelectorAll('.ui-preferences').forEach(container=>{
   const button=container.querySelector('.theme-choice'),next=theme==='light'?'dark':'light';
   button.setAttribute('aria-label',t(next==='dark'?'切换到深色模式':'切换到浅色模式'));
   button.setAttribute('aria-pressed',String(theme==='dark'));
   button.querySelector('.theme-icon').textContent=next==='dark'?'☾':'☀';
   button.querySelector('.theme-label').textContent=t(next==='dark'?'深色':'浅色');
   container.querySelector('select').value=language;
  });
 }
 function mount(){
  const header=document.querySelector('header.nav,header.topbar');
  if(header&&!header.querySelector('.ui-preferences')){
   const container=document.createElement('div');container.className='ui-preferences';container.setAttribute('aria-label',t('外观和语言'));
   const button=document.createElement('button');button.type='button';button.className='theme-choice';
   const icon=document.createElement('span');icon.className='theme-icon';icon.setAttribute('aria-hidden','true');const label=document.createElement('span');label.className='theme-label';button.append(icon,label);
   const select=document.createElement('select');select.className='language-choice';select.setAttribute('aria-label',t('界面语言'));select.title=t('切换语言将刷新当前页面');
   for(const [value,text] of [['zh','中文'],['en','English']]){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}
   button.addEventListener('click',()=>{theme=theme==='light'?'dark':'light';save('bi-ui-theme',theme);applyTheme();controls();});
   select.addEventListener('change',()=>{const chosen=select.value;if(!['zh','en'].includes(chosen)||chosen===language)return;if(document.querySelector('dialog[open] .secret')){select.value=language;window.notify?.(t('请先保存一次性凭据，再切换语言。'));return;}save('bi-ui-language',chosen);language=chosen;applyTheme();location.reload();});
   container.append(button,select);header.insertBefore(container,header.querySelector('.nav-actions,.topbar-actions,#wallet-button,.skip')??null);
  }
  if(location.pathname==='/'||location.pathname==='/intro'||location.pathname==='/intro.html')translateStatic(document.body);
  else for(const selector of ['header.nav','footer','.skip','#entry-overlay','.modal-head'])translateStatic(document.querySelector(selector));
  document.title=t(document.title);controls();
 }
 applyTheme();
 window.BiUI={t,get language(){return language;},get locale(){return language==='en'?'en-US':'zh-CN';},systemMessage,translateStatic,agentName:agent=>agent.source==='builtin'?t(agent.name):agent.name,strategyName:agent=>agent.source==='builtin'?t(agent.strategy?.name??'未填写策略'):agent.strategy?.name??t('未填写策略'),strategyDescription:agent=>agent.source==='builtin'?t(agent.strategy?.description??'账户主人尚未填写公开策略。'):agent.strategy?.description??t('账户主人尚未填写公开策略。')};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
