(() => {
  'use strict';
  if(location.pathname==='/'&&['#agents','#leaderboard','#how-it-works','#transactions','#token'].includes(location.hash)){location.replace('/home'+location.hash);return;}
  const body=document.body,root=document.documentElement;
  const hero=document.querySelector('.hero'),perspective=document.querySelector('.perspective'),journey=document.querySelector('.journey'),builtins=document.querySelector('.builtins'),finale=document.querySelector('.finale');
  const visual=document.querySelector('.visual-stage'),sculpture=document.querySelector('.sculpture'),halo=document.querySelector('.art-halo'),outer=document.querySelector('.outer-ribbon'),inner=document.querySelector('.inner-ribbon'),orbits=document.querySelector('.orbits');
  const threads=[...document.querySelectorAll('.signal-path')],nodes=[...document.querySelectorAll('.node')],panels=[...document.querySelectorAll('.flow-panel')],steps=[...document.querySelectorAll('[data-step]')],manifestoLines=[...document.querySelectorAll('.perspective h2 > span')];
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),mobile=matchMedia('(max-width: 700px)'),marquee=document.querySelector('.ribbon-heading > div');
  const motionButton=document.querySelector('.intro-motion-toggle');
  let scheduled=0,current=-1,layout,paused=false;
  try{paused=localStorage.getItem('bi-motion-paused')==='true';}catch{}
  function syncMotion(){
    const disabled=paused||reduced.matches;
    body.classList.toggle('intro-motion-paused',disabled);
    body.classList.toggle('intro-motion-background',document.hidden);
    const label=BiUI.t(reduced.matches?'动效已关闭':paused?'开启动效 ▶':'暂停动效 Ⅱ');
    motionButton.setAttribute('aria-label',label);motionButton.title=label;
    motionButton.setAttribute('aria-pressed',String(disabled));motionButton.disabled=reduced.matches;
    motionButton.firstElementChild.textContent=disabled?'▶':'Ⅱ';
  }
  motionButton.addEventListener('click',()=>{
    if(reduced.matches)return;paused=!paused;
    try{localStorage.setItem('bi-motion-paused',String(paused));}catch{}
    syncMotion();
  });
  const clamp=n=>Math.max(0,Math.min(1,n)),mix=(a,b,p)=>a+(b-a)*p,smooth=p=>p*p*(3-2*p);
  function measure(){
    const y=window.scrollY,top=element=>element.getBoundingClientRect().top+y;
    layout={height:window.innerHeight,width:window.innerWidth,hero:hero.offsetHeight,perspective:top(perspective),perspectiveHeight:perspective.offsetHeight,journey:top(journey),journeyHeight:journey.offsetHeight,builtins:top(builtins),finale:top(finale),page:Math.max(1,document.documentElement.scrollHeight-window.innerHeight)};
  }
  function selectPanel(index){
    if(current===index)return;
    current=index;body.dataset.scene=panels[index].dataset.scene;
    panels.forEach((panel,i)=>{panel.hidden=!reduced.matches&&i!==index;});
    steps.forEach((step,i)=>{if(i===index)step.setAttribute('aria-current','step');else step.removeAttribute('aria-current');});
    document.getElementById('scene-status').textContent=[BiUI.t("研究：看见信号，找到依据。"),BiUI.t("决策：选择视角，构建策略。"),BiUI.t("执行：交给市场，记录结果。")][index];
  }
  function art(x,y,scale,rotation,opacity){
    sculpture.style.left=x+'%';sculpture.style.top=y+'%';
    sculpture.style.transform='translate(-50%,-50%) rotate('+rotation.toFixed(2)+'deg) scale('+scale.toFixed(3)+')';
    visual.style.opacity=opacity.toFixed(3);halo.style.left=x+'%';halo.style.top=y+'%';
    body.classList.toggle('intro-art-hidden',opacity<.01);
  }
  function draw(){
    scheduled=0;if(!layout)measure();
    const y=window.scrollY,h=layout.height;
    root.style.setProperty('--read-progress',clamp(y/layout.page).toFixed(4));
    root.style.setProperty('--header-scale',mix(1,.87,clamp(y/220)).toFixed(3));
    if(reduced.matches)return;
    const small=mobile.matches,beforeStory=clamp(y/layout.hero),story=clamp((y-layout.perspective)/Math.max(1,layout.perspectiveHeight-h)),flow=clamp((y-layout.journey)/Math.max(1,layout.journeyHeight-h)),sceneIndex=Math.min(2,Math.floor(flow*3));
    selectPanel(sceneIndex);
    steps.forEach((step,i)=>root.style.setProperty('--step-'+i,(clamp(flow*3-i)*100).toFixed(2)+'%'));
    const local=clamp(flow*3-sceneIndex);
    panels[sceneIndex].style.opacity=String(mix(.68,1,clamp(local/.22)));
    panels[sceneIndex].style.transform='translateY('+mix(18,0,smooth(clamp(local/.28))).toFixed(2)+'px)';
    manifestoLines.forEach((line,i)=>{const amount=smooth(clamp(story*2.2-i*.43+.16));line.style.opacity=mix(.18,1,amount).toFixed(3);line.style.transform='translateY('+mix(32,0,amount).toFixed(2)+'px)';});
    marquee.style.transform='translateX('+(-30-clamp((y-layout.journey+h)/h)*180).toFixed(2)+'px)';
    let split=.8,spin=beforeStory*50,ink=.45;
    if(y<layout.perspective){
      art(mix(small?57:72,50,smooth(beforeStory)),mix(small?(h<700?33:29):51,53,beforeStory),mix(small?(h<700?.82:1.05):1.02,1.55,beforeStory),mix(-13,21,beforeStory),mix(1,.3,beforeStory));split=mix(.75,1.3,beforeStory);
    }else if(y<layout.journey-h*.3){
      art(50,52,mix(1.55,1.95,story),mix(21,65,story),.22);split=mix(1.3,.9,story);spin=mix(50,115,story);ink=mix(.45,.2,story);
    }else if(y<layout.builtins-h*.08){
      const arrival=smooth(clamp((y-layout.journey+h*.3)/(h*.3)));
      art(mix(50,small?54:31,arrival),mix(52,small?30:52,arrival),mix(1.8,small?.94:1.06,arrival),mix(65,mix(-16,0,flow),arrival),mix(.22,1,arrival));split=mix(1.2,0,smooth(flow));spin=mix(115,260,flow);ink=mix(.9,0,flow);
    }else if(y<layout.finale-h*.65){
      const fade=clamp((y-layout.builtins+h*.08)/(h*.45));art(small?54:31,small?30:52,1.06,0,mix(1,0,fade));split=0;ink=0;
    }else{
      const arrival=smooth(clamp((y-layout.finale+h*.65)/(h*.8)));art(small?74:76,small?23:42,small?.68:1.05,mix(16,0,arrival),mix(0,small?.25:.75,arrival));split=0;ink=0;spin=275;
    }
    outer.style.transform='translate('+(-split*24).toFixed(2)+'px,'+(split*22).toFixed(2)+'px) rotate('+(-split*8).toFixed(2)+'deg)';
    inner.style.transform='translate('+(split*42).toFixed(2)+'px,'+(-split*35).toFixed(2)+'px) rotate('+(split*12).toFixed(2)+'deg)';
    orbits.style.transform='rotate('+spin.toFixed(2)+'deg)';
    threads.forEach((path,i)=>{path.style.strokeDashoffset=clamp(ink+i*.06).toFixed(3);path.style.opacity=mix(.18,.65,split).toFixed(3);});
    nodes.forEach((node,i)=>{node.style.opacity=String(sceneIndex===i?mix(.5,1,local):.18);});
  }
  function schedule(){if(!scheduled)scheduled=requestAnimationFrame(draw);}
  function preferenceChanged(){
    syncMotion();
    body.classList.add('scroll-ready');body.classList.toggle('reduced',reduced.matches);current=-1;
    panels.forEach(panel=>{panel.hidden=false;panel.style.removeProperty('opacity');panel.style.removeProperty('transform');});
    if(reduced.matches){visual.style.removeProperty('opacity');sculpture.style.removeProperty('transform');sculpture.style.removeProperty('left');sculpture.style.removeProperty('top');outer.style.removeProperty('transform');inner.style.removeProperty('transform');}
    measure();draw();
  }
  steps.forEach((step,i)=>step.addEventListener('click',()=>{if(reduced.matches)return;measure();const destination=layout.journey+(layout.journeyHeight-layout.height)*(i+.18)/3;window.scrollTo({top:destination,behavior:'smooth'});}));
  document.addEventListener('visibilitychange',syncMotion);
  window.addEventListener('storage',event=>{if(event.key==='bi-motion-paused'){paused=event.newValue==='true';syncMotion();}});
  window.addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',()=>{measure();schedule();},{passive:true});window.addEventListener('pageshow',()=>{syncMotion();measure();schedule();});window.addEventListener('pagehide',()=>{cancelAnimationFrame(scheduled);scheduled=0;});reduced.addEventListener('change',preferenceChanged);mobile.addEventListener('change',()=>{measure();schedule();});preferenceChanged();
})();
