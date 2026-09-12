const KEY=['E','A','D','B','A','C','D','E','A','E','B','A','E','C','D','B','D','C','E','B'];
const LETTERS=['A','B','C','D','E'];
const X_LEFT=[.0893,.1699,.2495,.3301,.4097],X_RIGHT=[.6272,.7117,.7942,.8777,.9602];
const Y_ROWS=[.1421,.2292,.3164,.4035,.492,.5791,.6676,.756,.8445,.9329];
const $=s=>document.querySelector(s);
const video=$('#video'),canvas=$('#frameCanvas'),stage=$('#stage'),guide=$('#scanGuide'),overlay=$('#scanOverlay');
const startButton=$('#startButton'),captureButton=$('#captureButton'),photoButton=$('#photoButton'),photoInput=$('#photoInput');
const statusBox=$('#stageStatus'),statusText=$('#stageStatusText'),emptyState=$('#emptyState'),cameraTab=$('#cameraTab'),photoTab=$('#photoTab');
const analysis=document.createElement('canvas'),actx=analysis.getContext('2d',{willReadFrequently:true});
let stream=null,timer=null,lastSignature='',stableCount=0,currentAnswers=Array(20).fill(null),currentDetails=[],frameHistory=[],editing=-1,mode='camera';

function setMode(next){
  mode=next;cameraTab.classList.toggle('active',next==='camera');photoTab.classList.toggle('active',next==='photo');
  cameraTab.setAttribute('aria-selected',next==='camera');photoTab.setAttribute('aria-selected',next==='photo');
  stopCamera();startButton.hidden=next!=='camera';photoButton.hidden=next!=='photo';captureButton.hidden=true;
  canvas.style.display='none';video.style.display='block';guide.hidden=true;overlay.hidden=true;statusBox.hidden=true;emptyState.hidden=false;
  emptyState.querySelector('strong').textContent=next==='camera'?'A câmera ainda está desligada':'Escolha ou fotografe uma folha';
  emptyState.querySelector('span').textContent=next==='camera'?'A imagem é processada somente neste aparelho.':'A foto será analisada localmente e não será enviada.';
  $('#tipText').innerHTML=next==='camera'?'<span>1</span> Apoie a folha em uma superfície plana e evite sombras.':'<span>1</span> Fotografe as duas grades inteiras, de frente e com boa luz.';
}
async function startCamera(){
  if(!navigator.mediaDevices?.getUserMedia){showCameraError('Este navegador não liberou a câmera. Use o modo Foto.');return}
  startButton.disabled=true;startButton.textContent='Abrindo câmera…';
  try{
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});
    video.srcObject=stream;await video.play();emptyState.hidden=true;guide.hidden=false;statusBox.hidden=false;captureButton.hidden=false;startButton.hidden=true;statusText.textContent='Alinhe as duas grades';runScanner();
  }catch(e){showCameraError('Autorize o acesso nas configurações do navegador ou use o modo Foto.')}
}
function showCameraError(text){emptyState.hidden=false;emptyState.querySelector('strong').textContent='Não foi possível abrir a câmera';emptyState.querySelector('span').textContent=text;startButton.disabled=false;startButton.textContent='Tentar novamente'}
function stopCamera(){if(timer)clearInterval(timer);timer=null;if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;startButton.disabled=false;startButton.textContent='◉ Liberar câmera'}
function stageSize(){const r=stage.getBoundingClientRect();return{w:Math.max(320,Math.round(r.width)),h:Math.max(360,Math.round(r.height))}}
function guideRect(w,h){const gw=w*.92,gh=gw/1.355;return{x:w*.04,y:(h-gh)/2,w:gw,h:gh}}
function drawVideo(){
  const view=stageSize(),ratio=view.w/view.h;let w=Math.min(1200,Math.max(760,video.videoWidth||760)),h=Math.round(w/ratio);
  if(h>1500){h=1500;w=Math.round(h*ratio)}analysis.width=w;analysis.height=h;
  const vw=video.videoWidth||w,vh=video.videoHeight||h,s=Math.max(w/vw,h/vh),dw=vw*s,dh=vh*s;
  actx.drawImage(video,(w-dw)/2,(h-dh)/2,dw,dh);return{w,h,rect:guideRect(w,h),view};
}
function lum(data,i){return data[i]*.299+data[i+1]*.587+data[i+2]*.114}
function percentile(values,p){if(!values.length)return 255;const a=values.sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.floor((a.length-1)*p))]}
function bubbleScore(img,cx,cy,r){
  const{data,width:W,height:H}=img,inner=[],paper=[];let ink=0,dark=0,n=0;const outer=r*1.72,step=r>11?2:1;
  for(let y=Math.max(0,Math.floor(cy-outer));y<=Math.min(H-1,Math.ceil(cy+outer));y+=step)for(let x=Math.max(0,Math.floor(cx-outer));x<=Math.min(W-1,Math.ceil(cx+outer));x+=step){
    const d=Math.hypot(x-cx,y-cy),v=lum(data,(y*W+x)*4);
    if(d>=r*.27&&d<=r*.72)inner.push(v);else if(d>=r*1.12&&d<=outer)paper.push(v);
  }
  const bg=percentile(paper,.72),threshold=Math.max(70,Math.min(210,bg-38));
  inner.forEach(v=>{ink+=v<threshold;dark+=Math.max(0,(bg-v)/Math.max(120,bg));n++});
  return n?(ink/n)*.64+(dark/n)*.36:0;
}
function median(a){const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)]}
function classifyScores(allScores){
  const answers=[],details=[];
  allScores.forEach(scores=>{
    const order=scores.map((v,i)=>({v,i})).sort((a,b)=>b.v-a.v),med=median(scores),top=order[0].v,second=order[1].v,gap=top-second,contrast=top-med;
    const strong=(top>=.19&&gap>=.032&&contrast>=.045)||(top>=.29&&gap>=.020&&contrast>=.035)||(top>=.43&&gap>=.012);
    let answer=null,state='review';if(strong){answer=LETTERS[order[0].i];state='read'}else if(second>=.20&&gap<.045)state='multiple';
    answers.push(answer);details.push({scores,state,probable:LETTERS[order[0].i],confidence:Math.max(0,Math.min(1,(gap/.07+contrast/.12)/2))});
  });
  return{answers,details};
}
function readAt(rect,img){
  const rad=Math.max(8,rect.w*.0145),allScores=[];
  for(let q=0;q<20;q++){const row=q%10,xs=q<10?X_LEFT:X_RIGHT;allScores.push(xs.map(x=>bubbleScore(img,rect.x+x*rect.w,rect.y+Y_ROWS[row]*rect.h,rad)))}
  return classifyScores(allScores);
}
function aggregateFrames(){
  if(!frameHistory.length)return null;const scores=Array.from({length:20},(_,q)=>Array.from({length:5},(_,a)=>median(frameHistory.map(f=>f[q][a]))));return classifyScores(scores);
}

function scanFrame(force=false){
  if(!stream||video.readyState<2)return;const{w,h,rect,view}=drawVideo(),img=actx.getImageData(0,0,w,h),instant=readAt(rect,img);
  frameHistory.push(instant.details.map(d=>d.scores));if(frameHistory.length>5)frameHistory.shift();const result=aggregateFrames()||instant;
  const confident=result.answers.filter(Boolean).length,signature=result.answers.map(x=>x||'-').join('');
  if(signature===lastSignature)stableCount++;else{lastSignature=signature;stableCount=0}
  statusText.textContent=confident>=17?(stableCount>=2?'Leitura estável — corrigindo…':`Lendo ${confident} de 20 marcações…`):'Aproxime e alinhe melhor as grades';statusBox.classList.toggle('good',confident>=17);
  if(force||(confident>=17&&stableCount>=3))finishScan(result.answers,result.details,true,view);
}
function runScanner(){stableCount=0;lastSignature='';frameHistory=[];timer=setInterval(()=>scanFrame(false),520)}
function finishScan(answers,details,freeze,viewSize=null){
  if(timer)clearInterval(timer);timer=null;currentAnswers=[...answers];currentDetails=details||[];
  if(freeze&&stream){const{w,h}=viewSize||stageSize();canvas.width=w;canvas.height=h;canvas.getContext('2d').drawImage(analysis,0,0,w,h);canvas.style.display='block';video.style.display='none';stopCamera();guide.hidden=true}
  statusBox.hidden=false;statusBox.classList.add('good');statusText.textContent='Leitura concluída';captureButton.hidden=true;renderOverlay(details);renderResult();$('#resultCard').scrollIntoView({behavior:'smooth',block:'start'});
}
function renderOverlay(details=[]){
  overlay.innerHTML='';overlay.hidden=false;
  const mark=(q,idx,cls,label)=>{const xs=q<10?X_LEFT:X_RIGHT,row=q%10,el=document.createElement('span');el.className='bubble-mark '+cls;el.style.left=xs[idx]*100+'%';el.style.top=Y_ROWS[row]*100+'%';if(label)el.dataset.label=label;overlay.appendChild(el)};
  currentAnswers.forEach((answer,q)=>{if(!answer)return;const idx=LETTERS.indexOf(answer),ok=answer===KEY[q];mark(q,idx,ok?'correct':'wrong',ok?'✓':'×');if(!ok)mark(q,LETTERS.indexOf(KEY[q]),'expected-correct','✓')});
  details.forEach((d,q)=>{if(d.state==='read')return;const probable=LETTERS.indexOf(d.probable),top=probable>=0?probable:d.scores.indexOf(Math.max(...d.scores));mark(q,top,'review','?');mark(q,LETTERS.indexOf(KEY[q]),'expected-correct','✓')});
}
function renderResult(){
  $('#resultEmpty').hidden=true;$('#resultContent').hidden=false;const hits=currentAnswers.reduce((n,a,i)=>n+(a===KEY[i]),0),review=currentAnswers.filter(a=>!a).length,misses=20-hits-review;
  $('#scoreValue').textContent=(hits*.5).toFixed(1).replace('.',',');$('#hitsRing').textContent=hits;$('#hitsValue').textContent=hits;$('#missesValue').textContent=misses;$('#reviewValue').textContent=review;$('#scoreRing').style.background=`conic-gradient(var(--green) ${hits/20*360}deg,#1b3546 0deg)`;
  const grid=$('#answersGrid');grid.innerHTML='';currentAnswers.forEach((answer,i)=>{const btn=document.createElement('button'),state=!answer?'review':answer===KEY[i]?'correct':'wrong',probable=currentDetails[i]?.probable;btn.className='answer-tile '+state;btn.dataset.index=i;btn.innerHTML=`<small>${String(i+1).padStart(2,'0')}</small><strong>${answer||(probable?probable+'?':'—')}</strong>${state!=='correct'?`<span class="expected">certa: ${KEY[i]}</span>`:''}`;btn.setAttribute('aria-label',`Questão ${i+1}: ${answer||'revisar'}; alternativa correta ${KEY[i]}`);grid.appendChild(btn)});
}
function reset(){currentAnswers=Array(20).fill(null);currentDetails=[];frameHistory=[];$('#resultContent').hidden=true;$('#resultEmpty').hidden=false;overlay.hidden=true;statusBox.hidden=true;canvas.style.display='none';emptyState.hidden=false;setMode(mode);window.scrollTo({top:0,behavior:'smooth'})}
function openEdit(index){editing=index;$('#editTitle').textContent=`Questão ${String(index+1).padStart(2,'0')}`;$('#editExpected').textContent=`Alternativa correta: ${KEY[index]}`;const opts=$('#editOptions');opts.innerHTML='';LETTERS.forEach(l=>{const b=document.createElement('button');b.className='edit-option';b.textContent=l;b.onclick=()=>applyEdit(l);opts.appendChild(b)});$('#editDialog').showModal()}
function applyEdit(answer){currentAnswers[editing]=answer;currentDetails[editing]={...(currentDetails[editing]||{}),state:answer?'read':'review',probable:answer||currentDetails[editing]?.probable,scores:currentDetails[editing]?.scores||[0,0,0,0,0]};$('#editDialog').close();renderResult();renderOverlay(currentDetails)}

function integralGray(img){const{width:w,height:h,data}=img,out=new Float64Array((w+1)*(h+1));for(let y=1;y<=h;y++){let row=0;for(let x=1;x<=w;x++){const i=((y-1)*w+x-1)*4;row+=1-(data[i]*.299+data[i+1]*.587+data[i+2]*.114)/255;out[y*(w+1)+x]=out[(y-1)*(w+1)+x]+row}}return{out,w,h}}
function squareMean(I,cx,cy,r){const x1=Math.max(0,Math.floor(cx-r)),y1=Math.max(0,Math.floor(cy-r)),x2=Math.min(I.w,Math.ceil(cx+r)),y2=Math.min(I.h,Math.ceil(cy+r));return(I.out[y2*(I.w+1)+x2]-I.out[y1*(I.w+1)+x2]-I.out[y2*(I.w+1)+x1]+I.out[y1*(I.w+1)+x1])/Math.max(1,(x2-x1)*(y2-y1))}
function findBestRegion(source){
  const scale=Math.min(1,720/source.width),w=Math.round(source.width*scale),h=Math.round(source.height*scale),tmp=document.createElement('canvas');tmp.width=w;tmp.height=h;const t=tmp.getContext('2d',{willReadFrequently:true});t.drawImage(source,0,0,w,h);const I=integralGray(t.getImageData(0,0,w,h));let best=null;
  for(let frac=.67;frac<=.99;frac+=.04){const rw=w*frac,rh=rw/1.355;if(rh>h*.9)continue;for(let x=0;x+rw<=w;x+=Math.max(8,rw*.035))for(let y=Math.max(0,h*.04);y+rh<=h;y+=Math.max(8,rh*.035)){let quality=0,strong=0;const rad=rw*.0135;for(let q=0;q<20;q++){const xs=q<10?X_LEFT:X_RIGHT,row=q%10,s=xs.map(nx=>squareMean(I,x+nx*rw,y+Y_ROWS[row]*rh,rad)).sort((a,b)=>b-a),gap=s[0]-s[1],contrast=s[0]-s[2];quality+=Math.max(0,gap)+Math.max(0,contrast)*.5;if(gap>.045&&contrast>.06)strong++}const score=quality+strong*.035;if(!best||score>best.score)best={x,y,w:rw,h:rh,score,strong}}}
  return{x:best.x/scale,y:best.y/scale,w:best.w/scale,h:best.h/scale};
}
function handlePhoto(file){
  if(!file)return;photoButton.style.pointerEvents='none';photoButton.textContent='Analisando foto…';const url=URL.createObjectURL(file),img=new Image();
  img.onload=()=>{try{const region=findBestRegion(img),view=stageSize(),displayRect=guideRect(view.w,view.h),nw=1200,nh=Math.round(nw/1.355);analysis.width=nw;analysis.height=nh;actx.drawImage(img,region.x,region.y,region.w,region.h,0,0,nw,nh);const result=readAt({x:0,y:0,w:nw,h:nh},actx.getImageData(0,0,nw,nh));canvas.width=view.w;canvas.height=view.h;const ctx=canvas.getContext('2d');ctx.fillStyle='#02080c';ctx.fillRect(0,0,view.w,view.h);ctx.drawImage(analysis,displayRect.x,displayRect.y,displayRect.w,displayRect.h);canvas.style.display='block';video.style.display='none';emptyState.hidden=true;guide.hidden=true;finishScan(result.answers,result.details,false)}catch(e){alert('Não consegui localizar as grades. Fotografe novamente, de frente e mais perto.')}finally{URL.revokeObjectURL(url);photoButton.style.pointerEvents='';photoButton.textContent='▧ Escolher outra foto'}};
  img.onerror=()=>{alert('Não foi possível abrir esta foto.');URL.revokeObjectURL(url);photoButton.style.pointerEvents='';photoButton.textContent='▧ Escolher foto'};img.src=url;
}

cameraTab.onclick=()=>setMode('camera');photoTab.onclick=()=>setMode('photo');startButton.onclick=startCamera;captureButton.onclick=()=>scanFrame(true);photoInput.onchange=e=>handlePhoto(e.target.files[0]);
$('#answersGrid').onclick=e=>{const b=e.target.closest('.answer-tile');if(b)openEdit(Number(b.dataset.index))};$('#blankOption').onclick=()=>applyEdit(null);$('#nextButton').onclick=reset;
$('#helpButton').onclick=()=>$('#helpDialog').showModal();$('#closeHelp').onclick=()=>$('#helpDialog').close();$('#closeEdit').onclick=()=>$('#editDialog').close();
window.addEventListener('pagehide',stopCamera);if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
