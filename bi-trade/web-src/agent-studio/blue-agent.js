import { createTrendCharacter } from './characters/trend.js';
import { createReboundCharacter } from './characters/rebound.js';
import { createRotationCharacter } from './characters/rotation.js';
const characterFactories=[createTrendCharacter,createReboundCharacter,createRotationCharacter];
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const V=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z);
const clamp=THREE.MathUtils.clamp;
const smooth=(a,b,t)=>THREE.MathUtils.smoothstep(t,a,b);
const blue=new THREE.Color('#89c6ec'), cream=new THREE.Color('#fff7e9');
const material=(color,roughness=.65,metalness=0)=>new THREE.MeshStandardMaterial({color,roughness,metalness});
function mesh(parent,geometry,mat,pos=[0,0,0]){
  const m=new THREE.Mesh(geometry,mat);m.position.set(...pos);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;
}
function round(parent,size,pos,mat,radius=.04){return mesh(parent,new RoundedBoxGeometry(...size,3,Math.min(radius,...size.map(n=>n/3))),mat,pos);}
function ball(parent,scale,pos,mat,segments=40){const m=mesh(parent,new THREE.SphereGeometry(1,segments,28),mat,pos);m.scale.set(...scale);return m;}
function cyl(parent,r1,r2,h,pos,mat){return mesh(parent,new THREE.CylinderGeometry(r1,r2,h,32),mat,pos);}
function tube(parent,points,radius,mat){return mesh(parent,new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p=>V(...p))),32,radius,8,false),mat);}
function bone(name,pos,parent){const b=new THREE.Bone();b.name=name;b.position.set(...pos);parent.add(b);return b;}
function solveArm(arm,target){
  const {shoulder,elbow,wrist,upper,lower,l1,l2,side}=arm;
  shoulder.parent.updateWorldMatrix(true,false);
  const origin=shoulder.getWorldPosition(V()),direction=target.clone().sub(origin),distance=clamp(direction.length(),.08,l1+l2-.006);direction.normalize();
  const pole=V(side*.8,-.45,-.45);pole.addScaledVector(direction,-pole.dot(direction)).normalize();
  const along=(l1*l1-l2*l2+distance*distance)/(2*distance),height=Math.sqrt(Math.max(0,l1*l1-along*along));
  const middle=origin.clone().addScaledVector(direction,along).addScaledVector(pole,height);
  const inv=shoulder.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
  shoulder.quaternion.setFromUnitVectors(upper.clone().normalize(),middle.clone().sub(origin).normalize().applyQuaternion(inv));shoulder.updateWorldMatrix(false,true);
  const invShoulder=shoulder.getWorldQuaternion(new THREE.Quaternion()).invert();
  elbow.quaternion.setFromUnitVectors(lower.clone().normalize(),target.clone().sub(middle).normalize().applyQuaternion(invShoulder));elbow.updateWorldMatrix(false,true);
  wrist.quaternion.copy(elbow.getWorldQuaternion(new THREE.Quaternion()).invert());wrist.updateWorldMatrix(false,true);
}
function chartTexture(kind=0,variant=0){
  const c=document.createElement('canvas');c.width=768;c.height=448;const ctx=c.getContext('2d');const texture=new THREE.CanvasTexture(c);texture.colorSpace=THREE.SRGBColorSpace;
  function draw(t){
    ctx.fillStyle='#14223a';ctx.fillRect(0,0,768,448);ctx.fillStyle='#1d304c';ctx.fillRect(0,0,768,52);
    ctx.fillStyle='#b7c9e5';ctx.font='bold 18px sans-serif';ctx.fillText('bi trade  /  '+(kind?'STRATEGY':['TREND','REBOUND','ROTATION'][variant]),25,33);ctx.font='12px monospace';ctx.fillStyle='#7290b5';ctx.fillText('PAPER · DEMO',600,33);
    if(kind){
      ctx.font='12px monospace';ctx.fillStyle='#7290b5';ctx.fillText('MARKET OBSERVATION',25,85);
      for(let k=0;k<6;k++){const y=116+k*48;ctx.fillStyle='#d8e7fa';ctx.font='bold 15px monospace';ctx.fillText(['BNB','MEME','VOLUME','FLOW','TREND','RISK'][k],25,y);ctx.fillStyle='#294163';ctx.fillRect(170,y-13,430,13);ctx.fillStyle=k===5?'#c9ae7f':'#84afe7';ctx.fillRect(170,y-13,100+140*(1+Math.sin(t*.5+k)),13);}
    }else{
      ctx.font='12px monospace';ctx.fillStyle='#7290b5';ctx.fillText('SYNTHETIC CHART / NO LIVE DATA',25,83);
      ctx.strokeStyle='#273c59';ctx.lineWidth=1;for(let x=30;x<750;x+=70){ctx.beginPath();ctx.moveTo(x,110);ctx.lineTo(x,380);ctx.stroke();}for(let y=118;y<391;y+=53){ctx.beginPath();ctx.moveTo(25,y);ctx.lineTo(745,y);ctx.stroke();}
      const yAt=x=>285-x*.11-Math.sin(x*.014+t*.25)*35-Math.sin(x*.04)*11;
      const gradient=ctx.createLinearGradient(0,120,0,390);gradient.addColorStop(0,'#7ba8e853');gradient.addColorStop(1,'#7ba8e800');
      ctx.beginPath();ctx.moveTo(25,385);for(let x=25;x<745;x+=5)ctx.lineTo(x,yAt(x));ctx.lineTo(740,385);ctx.fillStyle=gradient;ctx.fill();
      ctx.strokeStyle=['#8db9f5','#cbb5e8','#a8d8c0'][variant];ctx.lineWidth=3;ctx.beginPath();for(let x=25;x<745;x+=5){if(x===25)ctx.moveTo(x,yAt(x));else ctx.lineTo(x,yAt(x));}ctx.stroke();
      for(let k=0;k<38;k++){const x=27+k*18.5,h=10+Math.abs(Math.sin(k*1.5+t*.2))*35;ctx.fillStyle=k%4?'#4b7f72':'#806e69';ctx.fillRect(x,423-h,10,h);}
    }
    texture.needsUpdate=true;
  }draw(0);return{texture,draw};
}
function makeWorkstation(scene,variant=0){
  const creamMat=material('#f1f3f8',.75),wood=material('#cdb591',.65),woodDark=material('#aa8b65',.7),metal=material('#768ca9',.42,.4),chairMat=material('#d2deef',.96),dark=material('#1c304c',.42),light=material('#e8edf5',.75);
  const base=cyl(scene,2.58,2.58,.16,[0,-.09,.35],material('#dce5f1',.94));base.receiveShadow=true;
  cyl(scene,2.60,2.60,.045,[0,-.185,.35],material('#cad6e6',.85));
  const chair=new THREE.Group();chair.position.z=-.3;scene.add(chair);
  round(chair,[.9,.14,.76],[0,.685,0],chairMat,.10);
  const back=round(chair,[.87,.82,.12],[0,1.05,-.39],chairMat,.085);back.rotation.x=-.12;
  round(chair,[.65,.03,.05],[0,.925,-.308],material('#b9cae1',.95),.01);
  cyl(chair,.06,.06,.47,[0,.40,0],metal);cyl(chair,.14,.14,.065,[0,.17,0],metal);
  for(let i=0;i<5;i++){
    const angle=i*Math.PI*2/5;const p=V(Math.sin(angle)*.38,.14,Math.cos(angle)*.38);
    const leg=round(chair,[.045,.055,.46],[p.x*.55,.15,p.z*.55],metal,.01);leg.rotation.y=angle;
    const wheel=cyl(chair,.065,.065,.053,[p.x,.068,p.z],dark);wheel.rotation.z=Math.PI/2;
  }
  const desk=new THREE.Group();scene.add(desk);
  round(desk,[2.87,.14,1.05],[0,1.145,1.11],wood,.06);
  round(desk,[2.70,.045,.94],[0,1.047,1.11],woodDark,.01);
  for(const x of [-1.22,1.22]){round(desk,[.08,1.02,.08],[x,.54,1.38],creamMat,.015);round(desk,[.11,.045,.57],[x,.035,1.22],creamMat,.017);}
  // Discreet wood grain is geometry, not a downloaded image.
  for(let i=0;i<12;i++)round(desk,[2.58,.001,.002],[0,1.215,.73+i*.072],material(i%3?'#c7ad88':'#dbc6a5',.9),.0003);
  round(desk,[1.55,.018,.51],[.2,1.223,.87],material('#bfcee4',.94),.02);
  round(desk,[.83,.04,.30],[0,1.25,.82],light,.023);
  const keys=new THREE.InstancedMesh(new RoundedBoxGeometry(.050,.018,.046,2,.006),material('#f7f6ed',.56),46);let n=0;const obj=new THREE.Object3D();
  for(let r=0;r<4;r++)for(let k=0;k<(r===3?10:12);k++){obj.position.set(-.345+k*.063,1.282,.735+r*.064);obj.updateMatrix();keys.setMatrixAt(n++,obj.matrix);}keys.castShadow=keys.receiveShadow=true;desk.add(keys);
  round(desk,[.27,.020,.046],[0,1.285,.953],material('#e1dac4',.6),.006);
  const mouse=ball(desk,[.094,.045,.14],[.64,1.28,.89],light,28);tube(desk,[[.64,1.328,.8],[.64,1.326,.88]],.003,metal);
  const charts=[];
  function monitor(x,y,z,yaw,w,h,kind){
    const group=new THREE.Group();group.position.set(x,y,z);group.rotation.y=yaw;scene.add(group);
    round(group,[w,h,.07],[0,0,0],dark,.035);
    round(group,[w*.90,h*.84,.012],[0,.012,.041],material('#172b48',.45),.015);
    const chart=chartTexture(kind,variant);charts.push(chart);
    const face=mesh(group,new THREE.PlaneGeometry(w*.89,h*.82),new THREE.MeshBasicMaterial({map:chart.texture}),[0,.012,.05]);face.castShadow=false;
    round(group,[.045,.012,.007],[0,-h*.455,.041],new THREE.MeshBasicMaterial({color:'#8bb5ef'}),.003);
    round(scene,[.055,.31,.055],[x,y-h*.5-.10,z],metal,.01);
    round(scene,[.34,.025,.22],[x,1.232,z],dark,.018);
  }
  monitor(-.78,1.735,1.38,1.54,1.10,.70,0);
  monitor(-1.26,1.60,.93,1.51,.64,.65,1);
  // Small details give scale without competing with the character.
  const mug=cyl(desk,.079,.063,.15,[1.075,1.30,1.31],creamMat);cyl(desk,.064,.064,.006,[1.075,1.379,1.31],material('#665443',.9));
  const handle=mesh(desk,new THREE.TorusGeometry(.051,.014,8,24),creamMat,[1.172,1.307,1.31]);handle.rotation.y=Math.PI/2;
  round(desk,[.31,.045,.25],[.93,1.247,.88],material('#7891ad',.92),.017);
  round(desk,[.29,.006,.23],[.93,1.273,.88],creamMat,.012);
  const pen=cyl(desk,.008,.008,.24,[.93,1.284,.88],metal);pen.rotation.z=Math.PI/2;pen.rotation.y=.3;
  tube(scene,[[-.8,1.42,1.40],[-.83,1.2,1.46],[-1.00,1.01,1.48],[-1.23,.53,1.39]],.009,material('#678581',.85));
  const pot=cyl(scene,.19,.145,.31,[-1.66,.155,-.54],material('#dfd4b7',.9));cyl(scene,.165,.165,.01,[-1.66,.315,-.54],material('#71684e',.97));
  const green=material('#789b7c',.86);
  for(let i=0;i<6;i++){
    const angle=i*2.4;const leaf=ball(scene,[.055,.23,.014],[-1.66+Math.sin(angle)*.09,.46+i*.027,-.54+Math.cos(angle)*.09],green,24);leaf.rotation.z=Math.sin(angle)*.5;leaf.rotation.x=Math.cos(angle)*.5;
  }
  return{charts,mouse};
}

const MODE_NAMES={type:'专注敲键盘',observe:'抬头观察走势',mouse:'操作鼠标',rest:'放松一下',greet:'向你打招呼'};
export function mountTrendStudio(container,{onStatus=()=>{},initialView='hero',compact=false,variant=0,interactive=true,greetOnEntry=false}={}){
  if(!container)throw Error('A scene container is required');
  const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,compact?1.3:1.75));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.90;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);renderer.domElement.setAttribute('aria-label',`${['蓝色趋势','紫色回弹','绿色轮动'][variant]} Agent 的 3D 坐姿工位`);renderer.domElement.setAttribute('role','img');renderer.domElement.tabIndex=0;
  container.querySelector('.fallback')?.setAttribute('hidden','');const fallback=container.querySelector('.fallback');if(fallback)fallback.style.display='none';
  const scene=new THREE.Scene();const camera=new THREE.PerspectiveCamera(33,1,.1,50);
  const pmrem=new THREE.PMREMGenerator(renderer),roomEnvironment=new RoomEnvironment();const env=pmrem.fromScene(roomEnvironment,.045);scene.environment=env.texture;scene.environmentIntensity=.27;roomEnvironment.dispose();pmrem.dispose();
  scene.add(new THREE.HemisphereLight('#ecf3ff','#a6b4c8',1.05));
  const key=new THREE.DirectionalLight('#fffaf3',2.3);key.position.set(-3,6,5);key.castShadow=true;key.shadow.mapSize.set(compact?1024:2048,compact?1024:2048);Object.assign(key.shadow.camera,{left:-3.3,right:3.3,top:3.5,bottom:-3.5,near:1,far:15});key.shadow.normalBias=.025;key.shadow.bias=-.00015;scene.add(key);
  const rim=new THREE.DirectionalLight('#d5eaff',.9);rim.position.set(3,3,-4);scene.add(rim);
  const fill=new THREE.DirectionalLight('#f1f5ff',.55);fill.position.set(1,2,5);scene.add(fill);
  const ground=mesh(scene,new THREE.PlaneGeometry(200,200),material('#edf2fa',1),[0,-.214,0]);ground.rotation.x=-Math.PI/2;ground.castShadow=false;
  scene.fog=new THREE.Fog('#edf2fa',13,30);
  const desk=makeWorkstation(scene,variant),agent=characterFactories[variant](scene);
  const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.dampingFactor=.08;controls.enablePan=false;controls.enabled=interactive;controls.minDistance=3.0;controls.maxDistance=11;controls.minPolarAngle=.48;controls.maxPolarAngle=1.46;controls.target.set(0,1.07,.42);controls.update();
  renderer.domElement.tabIndex=interactive?0:-1;
  const presets={hero:{position:compact?[4.65,3.12,7.35]:(agent.heroCamera??[4.3,3.25,5.6]),target:[-.05,1.12,.45]},face:{position:[2.1,2.57,4.45],target:[0,1.63,-.15]},screen:{position:[2.15,2.66,3.52],target:[-.54,1.54,1.04]}};
  let userPaused=false,dirty=true,lastPaint=0;
  let desiredCamera=null,disposed=false,visible=true,paused=matchMedia('(prefers-reduced-motion: reduce)').matches,mode='auto',t=0,last=0,frames=0,lastChart=-1,lastName='';
  const blend={type:0,observe:0,mouse:0,greet:0,rest:1};
  function setView(view,immediate=false){const p=presets[view]||presets.hero;desiredCamera={position:V(...p.position),target:V(...p.target)};if(immediate){camera.position.copy(desiredCamera.position);controls.target.copy(desiredCamera.target);desiredCamera=null;controls.update();}}
  setView(initialView,true);controls.addEventListener('start',()=>{desiredCamera=null;});
  const reduceMotion=matchMedia('(prefers-reduced-motion: reduce)');
  const motionChange=()=>{paused=userPaused||reduceMotion.matches;dirty=true;};reduceMotion.addEventListener('change',motionChange);
  function pose(dt){
    const introEnd=greetOnEntry?3.5+variant*.45:0,phase=Math.max(0,t-introEnd)%25;
    const routine=variant===1?(phase<5?'observe':phase<11?'type':phase<18?'rest':phase<21?'mouse':'observe'):variant===2?(phase<6?'mouse':phase<10?'observe':phase<17?'type':'rest'):(phase<8?'type':phase<13?'observe':phase<19?'mouse':'rest');
    const current=greetOnEntry&&t<introEnd?'greet':mode==='auto'?routine:mode;
    for(const k in blend)blend[k]=THREE.MathUtils.damp(blend[k],Number(k===current),7,dt);
    if(lastName!==current){lastName=current;onStatus(MODE_NAMES[current],current);}
    const breathing=Math.sin(t*1.7)*.008;
    agent.spine.rotation.x=-.032-blend.type*.026+breathing;agent.chest.rotation.z=Math.sin(t*(variant===2?.96:.61))*(variant===2?.019:.008);
    agent.neck.rotation.y=-.12-blend.observe*(variant===2?.23*Math.sin(t*.85):.20+.1*Math.sin(t*.65))+blend.greet*.46;
    agent.neck.rotation.x=.06+blend.type*.065-blend.observe*.15-blend.greet*.04;
    agent.neck.rotation.z=Math.sin(t*.9)*.012+blend.greet*.045;
    agent.updateHead?.(t,blend);
    const period=4.7+Math.sin(Math.floor(t/5)*1.7)*.65,blinkTime=t%period;
    const blink=(Math.exp(-Math.pow((blinkTime-.15)/.073,2))+Math.exp(-Math.pow((t%13.7-.39)/.075,2)));
    agent.eyes.forEach(e=>e.scale.y=(agent.eyeOpenHeight??.103)*Math.max(.07,1-Math.min(1,blink)*.96));
    agent.applyBlink?.(blink);
    agent.ears.forEach((e,i)=>{const side=i?1:-1;e.rotation.z=side*(agent.earTilt??-.22)+Math.sin(t*1.3+i*.8)*.021+blend.greet*side*.035;e.rotation.x=Math.sin(t*1.4+i*.9)*.026;});
    agent.updateExpression?.(t,blend);
    agent.tail1.rotation.y=Math.sin(t*.94+variant)*.13;
    if(agent.tail2)agent.tail2.rotation.x=Math.sin(t*1.08+.7)*.11;
    if(agent.tail3)agent.tail3.rotation.z=Math.sin(t*1.3+1)*.08;
    agent.root.updateMatrixWorld(true);
    agent.arms.forEach((a,i)=>{
      const side=a.side,target=V(side*.28,1.284,.77);
      // Different rhythms, rest intervals, and tiny finger contacts avoid a mirrored loop.
      const tap=Math.max(0,Math.sin(t*(variant===1?(i?5.8:5.2):i?10.3:8.7)+i*2.2))*Math.max(0,Math.sin(t*.9+i)+.35);
      target.y+=blend.type*(.014+tap*.025);target.x+=blend.type*Math.sin(t*1.3+i)*.021;target.z+=blend.type*Math.sin(t*1.7+i)*.012;
      if(i===1){target.lerp(V(.64+Math.sin(t*1.2)*.04,1.328-Math.max(0,Math.sin(t*4.1))*.011,.90+Math.cos(t*.83)*.035),blend.mouse);}
      const observation=agent.observeTarget?agent.observeTarget(i,t):variant===1&&i===0?V(-.47,1.56,.46):V(side*.32,1.31,.70);
      target.lerp(observation,blend.observe*(agent.observeTarget?1:variant===1&&i===0?1:.6));
      target.lerp(V(side*.35,1.15,.52),blend.rest*.85);
      if(i===1){target.lerp(agent.greetingTarget?agent.greetingTarget(t):V(.98+Math.sin(t*5.8)*.03,1.49+Math.sin(t*5.8)*.07,.47),blend.greet);}
      a.target.copy(target);solveArm(a,target);
    });
    desk.mouse.position.x=.64+blend.mouse*Math.sin(t*1.2)*.04;desk.mouse.position.z=.89+blend.mouse*Math.cos(t*.83)*.035;
    const tick=Math.floor(t*5);if(tick!==lastChart){lastChart=tick;desk.charts.forEach(chart=>chart.draw(t));}
  }
  function resize(){const w=Math.max(1,container.clientWidth),h=Math.max(1,container.clientHeight);renderer.setSize(w,h,false);camera.aspect=w/h;camera.fov=w/h<.9?44:33;camera.updateProjectionMatrix();dirty=true;}
  const resizeObserver=new ResizeObserver(resize);resizeObserver.observe(container);resize();
  const observer=new IntersectionObserver(e=>{visible=e[0]?.isIntersecting??false;last=0;},{threshold:.01});observer.observe(container);
  function render(now){
    if(disposed)return;if(document.hidden||!visible){last=now;return;}if(now-lastPaint<1000/30)return;lastPaint=now;if(paused&&!dirty&&!desiredCamera)return;dirty=false;
    const dt=last?Math.min((now-last)/1000,.055):.016;last=now;
    if(!paused){t+=dt;pose(dt);}else if(frames===0)pose(1);
    if(desiredCamera){const amount=1-Math.exp(-dt*5);camera.position.lerp(desiredCamera.position,amount);controls.target.lerp(desiredCamera.target,amount);if(camera.position.distanceTo(desiredCamera.position)<.008)desiredCamera=null;}
    controls.update();renderer.render(scene,camera);frames++;
    if(frames%20===0){renderer.domElement.dataset.frames=String(frames);renderer.domElement.dataset.mode=lastName;renderer.domElement.dataset.wristError=String(Math.max(...agent.arms.map(a=>a.wrist.getWorldPosition(V()).distanceTo(a.target))).toFixed(3));renderer.domElement.dataset.drawCalls=String(renderer.info.render.calls);}
  }
  pose(1);renderer.render(scene,camera);renderer.setAnimationLoop(render);
  const contextLost=e=>{e.preventDefault();paused=true;renderer.domElement.hidden=true;if(fallback){fallback.hidden=false;fallback.style.display='grid';}};renderer.domElement.addEventListener('webglcontextlost',contextLost);
  const rigHelper=new THREE.SkeletonHelper(agent.root);rigHelper.visible=false;scene.add(rigHelper);
  return{
    setMode(value){if(!['auto','type','observe','mouse','greet'].includes(value))throw Error('Unsupported animation mode');mode=value;paused=false;},
    setView, setPaused(value){userPaused=Boolean(value);paused=userPaused||reduceMotion.matches;dirty=true;},get paused(){return paused;},
    setTheme(value){const dark=value==='dark';ground.material.color.set(dark?'#142238':'#edf2fa');scene.fog.color.set(dark?'#142238':'#edf2fa');dirty=true;},
    setRigVisible(value){rigHelper.visible=Boolean(value);},
    diagnostics(){return {version:THREE.REVISION,mode,paused,time:t,frames,visible,boneCount:agent.boneCount,skinnedMeshes:agent.skinnedMeshes,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,canvas:[renderer.domElement.width,renderer.domElement.height],wristPositions:agent.arms.map(a=>a.wrist.getWorldPosition(V()).toArray()),wristTargets:agent.arms.map(a=>a.target.toArray()),headRotation:agent.neck.rotation.toArray(),eyeScale:agent.eyes.map(e=>e.scale.y)};},
    dispose(){
      if(disposed)return;disposed=true;renderer.setAnimationLoop(null);resizeObserver.disconnect();observer.disconnect();reduceMotion.removeEventListener('change',motionChange);controls.dispose();renderer.domElement.removeEventListener('webglcontextlost',contextLost);
      const geometries=new Set(),materials=new Set(),textures=new Set();scene.traverse(o=>{if(o.geometry)geometries.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[]){materials.add(m);for(const v of Object.values(m))if(v?.isTexture)textures.add(v);}});
      geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(tx=>tx.dispose());env.dispose();renderer.dispose();renderer.domElement.remove();
    }
  };
}
