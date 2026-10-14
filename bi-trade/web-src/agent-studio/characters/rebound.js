// Independent rebound model. Shape/material changes in this file affect only this character.
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
function fibreTexture(){
  const c=document.createElement('canvas');c.width=c.height=128;const ctx=c.getContext('2d');
  const data=ctx.createImageData(128,128);let seed=1261;
  for(let i=0;i<data.data.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const v=140+((seed>>>24)%80);data.data[i]=data.data[i+1]=data.data[i+2]=v;data.data[i+3]=255;}
  ctx.putImageData(data,0,0);const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(9,9);return t;
}
function plushGeometry(scale,position,face=false,coat=blue,light=cream){
  const g=new THREE.SphereGeometry(1,64,40),p=g.attributes.position,colors=[];
  for(let i=0;i<p.count;i++){
    const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
    const sx=Math.sign(x)*Math.pow(Math.abs(x),.86), sy=Math.sign(y)*Math.pow(Math.abs(y),.88), sz=Math.sign(z)*Math.pow(Math.abs(z),.90);
    p.setXYZ(i,sx*scale[0]+position[0],sy*scale[1]+position[1],sz*scale[2]+position[2]);
    // Soft oval muzzle color follows the curved head surface without a hard polygon edge.
    const muzzleDistance=Math.hypot(x/.49,(y+.36)/.38);
    const patch=face?smooth(.43,.68,z)*(1-smooth(.79,1.17,muzzleDistance)):smooth(.44,.60,z)*(1-smooth(.61,.86,Math.hypot(x*1.4,y*1.2)));
    const color=coat.clone().lerp(light,patch);colors.push(color.r,color.g,color.b);
  }
  g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));g.computeVertexNormals();return g;
}
function skinBody(geometry,bones){
  const indices=[],weights=[],p=geometry.attributes.position;
  for(let i=0;i<p.count;i++){
    const h=p.getY(i),a=clamp((h-.81)/.32,0,1),b=clamp((h-1.13)/.3,0,1);
    indices.push(0,1,2,0);weights.push(1-a,a*(1-b),a*b,0);
  }
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(indices,4));geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));
  return new THREE.Skeleton(bones);
}
function skinTube(points,bones,radii,mat,parent,tail=false,coat=blue,light=cream){
  const curve=new THREE.CatmullRomCurve3(points),rings=40,sides=16,frames=curve.computeFrenetFrames(rings,false),positions=[],normals=[],uvs=[],indices=[],si=[],sw=[],cols=[];
  for(let i=0;i<=rings;i++){
    const t=i/rings,center=curve.getPointAt(t),f=t*(radii.length-1),k=Math.min(radii.length-2,Math.floor(f)),r=THREE.MathUtils.lerp(radii[k],radii[k+1],f-k);
    const sk=t*(bones.length-1),lo=Math.min(bones.length-2,Math.floor(sk)),weight=smooth(0,1,sk-lo);
    for(let j=0;j<=sides;j++){
      const a=j/sides*Math.PI*2,n=frames.normals[i].clone().multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i],Math.sin(a)),p=center.clone().addScaledVector(n,r);
      positions.push(p.x,p.y,p.z);normals.push(n.x,n.y,n.z);uvs.push(j/sides,t);si.push(lo,lo+1,0,0);sw.push(1-weight,weight,0,0);
      const color=coat.clone().lerp(light,tail?smooth(.67,.78,t):0);cols.push(color.r,color.g,color.b);
      // This Frenet ring increases counterclockwise; keep exterior faces outward.
      if(i<rings&&j<sides){const n0=i*(sides+1)+j,n1=n0+sides+1;indices.push(n0,n0+1,n1,n1,n0+1,n1+1);}
    }
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));g.setAttribute('color',new THREE.Float32BufferAttribute(cols,3));g.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(si,4));g.setAttribute('skinWeight',new THREE.Float32BufferAttribute(sw,4));g.setIndex(indices);g.computeVertexNormals();
  const m=new THREE.SkinnedMesh(g,mat);parent.add(m);m.castShadow=m.receiveShadow=true;parent.updateMatrixWorld(true);m.bind(new THREE.Skeleton(bones));return m;
}
function earGeometry(){
  const s=new THREE.Shape();s.moveTo(-.21,0);s.bezierCurveTo(-.24,.13,-.16,.32,-.035,.52);s.bezierCurveTo(-.01,.56,.022,.56,.042,.50);s.bezierCurveTo(.14,.31,.25,.1,.20,-.015);s.quadraticCurveTo(0,-.07,-.21,0);
  const g=new THREE.ExtrudeGeometry(s,{depth:.15,bevelEnabled:true,bevelSegments:5,steps:1,bevelSize:.055,bevelThickness:.048,curveSegments:16});g.translate(0,0,-.075);g.computeVertexNormals();return g;
}
function floppyEarGeometry(){
  // A solid teardrop lobe, wider at its rounded tip and curved out from the head.
  const g=new THREE.SphereGeometry(1,56,40),p=g.attributes.position;
  for(let i=0;i<p.count;i++){
    const x=p.getX(i),y=p.getY(i),z=p.getZ(i),width=.27*(.88-.16*y);
    p.setXYZ(i,x*width+.14*(1-y),y*.43-.15,z*.165+.015*(1-y));
  }
  g.computeVertexNormals();return g;
}
export function createReboundCharacter(scene){
  const variant=1;
  const root=new THREE.Group();root.name='TrendAgent';scene.add(root);
  const palette=['#cdb6ec','#fff8ef','#efe0fb'];
  const coat=new THREE.Color(palette[0]),light=new THREE.Color(palette[1]);
  root.name=['TrendAgent','ReboundAgent','RotationAgent'][variant];
  const texture=fibreTexture();const fur=new THREE.MeshPhysicalMaterial({color:'#ffffff',vertexColors:true,roughness:.94,sheen:1,sheenRoughness:.76,sheenColor:palette[2],bumpMap:texture,bumpScale:.006,emissive:'#483251',emissiveIntensity:.025});
  const plainFur=fur.clone();plainFur.vertexColors=false;plainFur.color.copy(coat);
  const whiteFur=plainFur.clone();whiteFur.color.copy(light);whiteFur.sheenColor.set('#fff9ef');
  const dark=new THREE.MeshPhysicalMaterial({color:'#151c27',roughness:.19,clearcoat:1,clearcoatRoughness:.13});
  const mouth=material('#303337',.64);
  const hip=bone('pelvis',[0,.83,-.25],root),spine=bone('spine',[0,.27,0],hip),chest=bone('chest',[0,.25,0],spine),neck=bone('head',[0,.47,.04],chest);
  const bodyG=plushGeometry([.43,.43,.34],[0,1.13,-.25],false,coat,light);const body=new THREE.SkinnedMesh(bodyG,fur);body.name='skinned_body';root.add(body);root.updateMatrixWorld(true);body.bind(skinBody(bodyG,[hip,spine,chest]));body.castShadow=body.receiveShadow=true;
  const headWidth=.77,headHeight=.60,headDepth=.59;
  const head=mesh(neck,plushGeometry([headWidth,headHeight,headDepth],[0,0,0],true,coat,light),fur);head.name='head_surface';
  const eyes=[],eyeRoots=[];
  for(const side of [-1,1]){
    const eyeRoot=new THREE.Group();eyeRoot.position.set(side*.242,.026,headDepth*.934);eyeRoot.rotation.y=side*.11;neck.add(eyeRoot);eyeRoots.push(eyeRoot);
    const eye=ball(eyeRoot,[.063,.116,.029],[0,0,.008],dark);eyes.push(eye);
    ball(eye,[.23,.105,.35],[-.24,.38,.78],new THREE.MeshBasicMaterial({color:'#fffefa'}),20);
  }
  const noseG=new THREE.SphereGeometry(1,40,28);const noseP=noseG.attributes.position;
  for(let i=0;i<noseP.count;i++){const y=noseP.getY(i);noseP.setX(i,noseP.getX(i)*(.74+.26*y));}noseG.computeVertexNormals();
  const nose=mesh(neck,noseG,dark,[0,-.151,headDepth*.970]);nose.scale.set(.101,.064,.037);nose.name='nose';
  const front=headDepth;
  tube(neck,[[0,-.199,front*.975],[0,-.251,front*.95],[-.055,-.286,front*.935],[-.115,-.28,front*.91],[-.156,-.238,front*.902]],.013,mouth);
  tube(neck,[[0,-.251,front*.95],[.055,-.286,front*.935],[.115,-.28,front*.91],[.156,-.238,front*.902]],.013,mouth);
  const wink=new THREE.Group();neck.add(wink);wink.visible=false;
  tube(wink,[[-.315,.061,front*.944],[-.246,.046,front*.966],[-.196,.017,front*.970],[-.25,-.006,front*.970],[-.315,-.029,front*.949]],.019,mouth);
  const ears=[];
  for(const side of [-1,1]){
    const e=bone(side<0?'ear_L':'ear_R',[side*.62,.23,-.04],neck);
    if(variant===0){e.rotation.z=-side*.24;const outer=mesh(e,earGeometry(),plainFur);outer.scale.set(.94,.88,.91);const inner=mesh(e,earGeometry(),whiteFur,[0,.025,.137]);inner.scale.set(.57,.58,.15);}
    else if(variant===1){const outer=mesh(e,floppyEarGeometry(),plainFur);outer.scale.x=side;}
    else{ball(e,[.275,.27,.15],[side*.045,0,0],plainFur);ball(e,[.145,.15,.04],[side*.045,-.01,.15],whiteFur);}
    ears.push(e);
  }
  if(variant===0){
    const tuft=ball(neck,[.23,.105,.16],[-.035,.578,.13],plainFur);tuft.rotation.z=-.36;
    const lock=ball(neck,[.23,.08,.105],[.085,.465,.395],plainFur);lock.rotation.z=-.5;lock.rotation.x=-.3;
    const tiny=ball(neck,[.13,.065,.13],[-.07,.592,.27],plainFur);tiny.rotation.z=.3;
  }else if(variant===1){
    const scarfMaterial=plainFur.clone();scarfMaterial.color.set('#bca0df');
    const scarf=mesh(chest,new THREE.TorusGeometry(.30,.073,16,56),scarfMaterial,[0,-.09,.08]);scarf.rotation.x=Math.PI/2;
    const tip=ball(chest,[.115,.22,.065],[.34,-.24,.12],scarfMaterial);tip.rotation.z=-.35;
  }else{
    ball(chest,[.10,.11,.07],[0,.18,.33],new THREE.MeshPhysicalMaterial({color:'#81bfe3',metalness:.12,roughness:.29,clearcoat:1}));
  }
  const arms=[];
  for(const side of [-1,1]){
    const shoulderPosition=V(side*.365,1.355,-.135),elbowPosition=V(side*.46,1.145,.28),wristPosition=V(side*.28,1.265,.70);
    const shoulder=bone(side<0?'shoulder_L':'shoulder_R',[side*.365,.005,.115],chest);
    const elbow=bone(side<0?'elbow_L':'elbow_R',elbowPosition.clone().sub(shoulderPosition).toArray(),shoulder);
    const wrist=bone(side<0?'wrist_L':'wrist_R',wristPosition.clone().sub(elbowPosition).toArray(),elbow);
    root.updateMatrixWorld(true);
    skinTube([shoulderPosition,elbowPosition,wristPosition],[shoulder,elbow,wrist],[.145,.135,.099],fur,root,false,coat,light);
    const paw=ball(wrist,[.143,.105,.154],[0,0,.02],whiteFur);paw.name=side<0?'paw_L':'paw_R';
    arms.push({side,shoulder,elbow,wrist,upper:elbow.position.clone(),lower:wrist.position.clone(),l1:elbow.position.length(),l2:wrist.position.length(),target:wristPosition.clone()});
  }
  for(const side of [-1,1]){
    const points=[V(side*.23,.83,-.25),V(side*.275,.64,.13),V(side*.28,.30,.25)];
    const thigh=bone(side<0?'thigh_L':'thigh_R',[side*.23,0,0],hip),knee=bone(side<0?'knee_L':'knee_R',points[1].clone().sub(points[0]).toArray(),thigh),ankle=bone(side<0?'ankle_L':'ankle_R',points[2].clone().sub(points[1]).toArray(),knee);
    root.updateMatrixWorld(true);skinTube(points,[thigh,knee,ankle],[.18,.15,.10],fur,root,false,coat,light);
    const foot=ball(ankle,[.175,.11,.22],[0,-.035,.06],whiteFur);foot.name='foot';
    ball(ankle,[.075,.02,.08],[0,-.133,.09],whiteFur);
  }
  let tail1,tail2,tail3;
  if(variant===0){
    const tailPoints=[V(-.30,.87,-.46),V(-.55,.90,-.65),V(-.85,1.09,-.57),V(-.98,1.38,-.38)];
    tail1=bone('tail_base',tailPoints[0].clone().sub(V(0,.83,-.25)).toArray(),hip);tail2=bone('tail_mid',tailPoints[1].clone().sub(tailPoints[0]).toArray(),tail1);tail3=bone('tail_upper',tailPoints[2].clone().sub(tailPoints[1]).toArray(),tail2);const tail4=bone('tail_tip',tailPoints[3].clone().sub(tailPoints[2]).toArray(),tail3);
    root.updateMatrixWorld(true);skinTube(tailPoints,[tail1,tail2,tail3,tail4],[.065,.24,.23,.007],fur,root,true,coat,light);
  }else{
    tail1=bone('tail_base',[variant===1?0:.34,-.02,-.25],hip);
    ball(tail1,variant===1?[.14,.14,.15]:[.16,.17,.16],[0,0,-.09],plainFur);
  }
  root.updateMatrixWorld(true);
  let boneCount=0,skinnedMeshes=0;root.traverse(o=>{if(o.isBone)boneCount++;if(o.isSkinnedMesh)skinnedMeshes++;});
  return {root,hip,spine,chest,neck,eyes,ears,arms,tail1,tail2,tail3,texture,boneCount,skinnedMeshes,variant,
    eyeOpenHeight:.116,earTilt:.17,heroCamera:[3.25,3.10,6.4],
    greetingTarget(t){return V(.94+Math.sin(t*5.3)*.025,1.51+Math.sin(t*5.3)*.055,.43);},
    observeTarget(i){return V(i===0?-.25:.29,1.31,.69);},
    updateExpression(t,blend){const isWink=blend.greet>.45;eyeRoots[0].visible=!isWink;wink.visible=isWink;},
    updateHead(t,blend){neck.rotation.y=-.035-blend.observe*(.075+.025*Math.sin(t*.55))+blend.greet*.27;neck.rotation.x=.045+blend.type*.045-blend.observe*.035;neck.rotation.z=Math.sin(t*.66)*.008+blend.greet*.022;}
  };
}
