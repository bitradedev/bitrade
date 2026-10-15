// Motion only. This controller never invents trades or a real runtime status.
const profiles=[
  {observe:[1.0,2.1],think:[1.6,2.8],type:[1.8,3.0],mouse:[3.6,5.8],rest:[4,6],gaze:.036,baseYaw:-.075},
  {observe:[1.2,2.5],think:[1.8,3.2],type:[1.6,2.6],mouse:[3.4,5.5],rest:[4.5,7],gaze:.029,baseYaw:-.055},
  {observe:[.9,1.8],think:[1.4,2.5],type:[1.7,3.2],mouse:[3.8,6.2],rest:[4,6],gaze:.045,baseYaw:-.065}
];
const transitions={
  observe:[['mouse',.78],['type',.22]],
  think:[['mouse',.70],['type',.30]],
  mouse:[['type',.44],['observe',.38],['think',.18]],
  type:[['mouse',.78],['observe',.22]],
  rest:[['mouse',1]]
};
const realActivities=new Set(['reading','analyzing','executing','waiting','paused','unavailable']);
const damp=(a,b,speed,dt)=>a+(b-a)*(1-Math.exp(-speed*dt));
const pulse=(t,start,duration)=>{const p=(t-start)/duration;return p>=0&&p<=1?Math.sin(p*Math.PI)**2:0;};

export function createWorkBehavior({variant=0,random=Math.random}={}){
  const profile=profiles[variant]||profiles[0];
  const range=(a,b)=>a+(b-a)*random();
  let state='observe',since=0,until=range(.55,1.1),signal=null,signalSince=null,signalChanged=false;
  let hasOperated=false,nextTyping=range(4.5,7.5),nextBreak=range(65,100);
  let nextGaze=range(2.8,5.8),gazeYaw=0,gazePitch=0,targetYaw=0,targetPitch=0;
  let nextPosture=range(15,26),posture=0,targetPosture=0;
  let nextBlink=range(2.6,5.8),blinkAt=-100,blinkLength=.19,doubleBlink=false;
  let nextPointer=0,mouseX=.64,mouseZ=.89,targetMouseX=.64,targetMouseZ=.89,clickAt=-100;
  let nextKey=0,keyAt=[-100,-100],keyLength=[.1,.1],keyX=[0,0],keyZ=[0,0],keyCount=0,lastHand=1;
  let nextEar=range(9,17),earAt=-100;
  function enter(next,t){
    state=next;since=t;until=t+range(...profile[state]);nextGaze=t+range(.8,2.5);
    if(state==='type'){nextKey=t+range(.22,.35);keyCount=0;nextTyping=until+range(6,10);hasOperated=true;}
    if(state==='mouse'){nextPointer=t+range(.1,.25);hasOperated=true;}
  }
  function chooseNext(){
    if(!hasOperated)return 'mouse';
    let r=random();for(const [next,weight] of transitions[state]){r-=weight;if(r<=0)return next;}return 'observe';
  }
  return{
    setActivity(activity){
      if(activity!==null&&!realActivities.has(activity))throw Error('Unknown work activity');
      if(activity===signal)return;
      signal=activity;signalSince=null;signalChanged=true;
    },
    sample(t,dt=.016){
      if(signal!==null){
        if(signalSince===null)signalSince=t;signalChanged=false;
        const next=signal==='analyzing'?'think':signal==='executing'?(t-signalSince<1.35?'type':'observe'):signal==='reading'?'observe':'rest';
        if(next!==state)enter(next,t);
      }else{
        if(signalChanged){signalSince=null;signalChanged=false;enter('observe',t);nextTyping=t+range(4.5,7.5);nextBreak=t+range(65,100);}
        if(t>=until&&['mouse','type'].includes(state)&&t>=nextBreak){enter('rest',t);nextBreak=until+range(65,100);}
        else if(state!=='rest'&&state!=='type'&&t>=nextTyping)enter('type',t);
        else if(t>=until)enter(chooseNext(),t);
      }
      if(t>=nextGaze){
        const amount=state==='think'?.35:state==='rest'?.55:1;
        targetYaw=range(-profile.gaze,profile.gaze)*amount;targetPitch=range(-.012,.013)*amount;
        nextGaze=t+range(state==='think'?4:2.8,state==='think'?8.5:6.4);
      }
      gazeYaw=damp(gazeYaw,targetYaw,2.1,dt);gazePitch=damp(gazePitch,targetPitch,2.1,dt);
      if(t>=nextPosture){targetPosture=range(-.009,.01);nextPosture=t+range(16,30);}
      posture=damp(posture,targetPosture,1.5,dt);
      if(t>=nextBlink){
        blinkAt=t;blinkLength=range(.16,.22);
        if(doubleBlink){nextBlink=t+range(3.2,7.2);doubleBlink=false;}
        else{doubleBlink=random()<.09;nextBlink=t+(doubleBlink?.31:range(3.2,7.2));}
      }
      if(state==='type'&&t>=nextKey){
        const hand=random()<.82?1-lastHand:lastHand;lastHand=hand;keyAt[hand]=t;keyLength[hand]=range(.16,.23);keyCount++;
        keyX[hand]=range(-.035,.035);keyZ[hand]=range(-.018,.022);
        nextKey=t+(keyCount%5===0?range(.35,.55):range(.18,.29));
      }
      if(state==='mouse'&&t>=nextPointer){
        targetMouseX=.64+range(-.065,.065);targetMouseZ=.89+range(-.045,.045);
        if(random()<.6)clickAt=t+range(.25,.45);
        nextPointer=t+range(.55,1.05);
      }
      mouseX=damp(mouseX,targetMouseX,6,dt);mouseZ=damp(mouseZ,targetMouseZ,6,dt);
      if(t>=nextEar){earAt=t;nextEar=t+range(10,22);}
      return{
        state,since,until,source:signal===null?'demo':'runtime',baseYaw:profile.baseYaw,
        gazeYaw,gazePitch,posture,blink:pulse(t,blinkAt,blinkLength),
        taps:keyAt.map((start,i)=>state==='type'?pulse(t,start,keyLength[i]):0),keyX,keyZ,
        mouseX,mouseZ,click:state==='mouse'?pulse(t,clickAt,.16):0,ear:pulse(t,earAt,.32)
      };
    }
  };
}
