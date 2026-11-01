import {unpackFiles,importBoard,projectPoint} from './importer.js';
import {zipSync,strToU8} from 'fflate';

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={entries:[],model:null,selected:null,focused:null,face:'both',language:'en',busy:false,operation:0,request:0,urls:[],name:'board',mappings:{bom:{},placement:{}},tableNames:{}};
const zh={local:'文件只在本地处理',headline:'导入板图。<br>找到每颗物料。<span class="english-title">（Gerber in. Parts in place.）</span>',intro:'板图、物料清单和贴片位置，放进同一个手工焊接工作台。',import:'导入 Gerber + BOM + 贴片坐标',drop:'拖入 ZIP 或选择多个文件，全程在浏览器本地解析。',demo:'试用示例板',downloadDemo:'下载示例文件',loading:'正在加载示例工作台…',parts:'物料',emptyParts:'导入板图后，在这里选择物料。',selected:'当前物料',noSelection:'选择一种物料',needed:'个位号',both:'正反两面',top:'正面',bottom:'背面',labels:'显示位号',export:'导出离线贴片图',emptyBoard:'这里将显示导入的二维板图。',topNote:'器件面朝向你。',bottomNote:'已左右镜像，对应将实物板翻过来直视。',settings:'文件、列映射与坐标校准',units:'坐标单位',defaultSide:'没有板面列时',offsetX:'X 偏移（mm）',offsetY:'Y 偏移（mm）',invertY:'坐标 Y 向下递增',bottomMirrored:'背面 X 已经做过镜像',mirrorOrigin:'镜像轴 X（mm，仅限已镜像坐标）',apply:'应用并重新绘图',alignmentNote:'请用相同原点导出 Gerber 和贴片坐标。焊接前用一个非对称器件核对方向。',howTitle:'Gerber 提供板图。<br>BOM 和坐标提供物料位置。',howText:'普通 Gerber 通常不含完整的物料参数和器件中心。补充 BOM 和贴片坐标（CPL / PnP / .pos）后，才能准确归组和定位。',supports:'RS-274X Gerber · Excellon 钻孔 · ZIP · CSV / TSV · KiCad .pos',privacy:'无需账号，无追踪，不上传板文件，所有处理都在本地完成。',help:'查看 KiCad / 嘉立创 / Altium 的导出方法',star:'在焊接台上用得顺手？欢迎点个 Star。',credits:'开源组件致谢'};
const en=Object.fromEntries([...document.querySelectorAll('[data-i18n]')].map(el=>[el.dataset.i18n,el.innerHTML]));
const t=(english,chinese)=>state.language==='zh'?chinese:english;
function setLanguage(language){state.language=language;document.documentElement.lang=language==='zh'?'zh-CN':'en';document.querySelectorAll('[data-i18n]').forEach(el=>el.innerHTML=(language==='zh'?zh:en)[el.dataset.i18n]||en[el.dataset.i18n]);$('language').textContent=language==='zh'?'English':'中文';$('search').placeholder=t('Search value, reference, part number','搜索规格、位号或料号');if(state.model){renderList();select(state.selected,state.focused);showIssues();renderFiles();if(!state.busy&&!$('status').classList.contains('error'))status(summary(state.model,state.name));}}
function status(message,error=false){$('status').removeAttribute('data-i18n');$('status').textContent=message;$('status').classList.toggle('error',error);$('status').classList.toggle('busy',state.busy&&!error);}
function summary(model,name){const b=model.boundsMm;return `${name} — ${b.width.toFixed(1)} × ${b.height.toFixed(1)} mm · ${model.layers.length} ${t('layers','图层')} · ${model.components.length} ${t('references','位号')}${model.dataIssues.length?t(' · Check data mapping below',' · 请检查下方数据映射'):''}`;}
function setBusy(busy){state.busy=busy;if(!busy)$('status').classList.remove('busy');$('demo').disabled=busy;$('apply-settings').disabled=busy||!state.entries.length;$('export').disabled=busy||!state.model?.groups.length;}
function settings(){
  const placementOptions={mapping:state.mappings.placement,offsetXmm:Number($('offset-x').value),offsetYmm:Number($('offset-y').value),yAxis:$('invert-y').checked?'down':'up',bottomXMirrored:$('bottom-mirrored').checked,mirrorOriginXmm:Number($('mirror-origin').value)};
  if($('units').value!=='auto')placementOptions.units=$('units').value;
  if($('default-side').value)placementOptions.side=$('default-side').value;
  return {placementOptions,bomOptions:{mapping:state.mappings.bom},bomName:state.tableNames.bom,placementName:state.tableNames.placement};
}
function resetSettings(){state.mappings={bom:{},placement:{}};state.tableNames={};$('units').value='auto';$('default-side').value='';for(const id of ['offset-x','offset-y','mirror-origin'])$(id).value='0';$('invert-y').checked=false;$('bottom-mirrored').checked=false;}
async function renderEntries(entries,name,reset=false){
  const operation=++state.operation;setBusy(true);status(t('Reading layers and rendering locally…','正在本地解析图层并生成板图…'));
  await new Promise(resolve=>requestAnimationFrame(resolve));
  const previousMappings=state.mappings,previousTables=state.tableNames;
  const previousForm=['units','default-side','offset-x','offset-y','invert-y','bottom-mirrored','mirror-origin'].map(id=>({id,value:$(id).value,checked:$(id).checked}));
  if(reset)resetSettings();
  let timeout;
  try{
    const result=await Promise.race([importBoard(entries,globalThis.pcbStackup,settings()),new Promise((_,reject)=>timeout=setTimeout(()=>reject(new Error(t('Rendering timed out. Try fewer/smaller Gerber files.','绘图超时，请尝试减少图层或文件大小。'))),45000))]);
    if(operation!==state.operation)return;
    const urls=[result.topSvg,result.bottomSvg].map(svg=>URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'})));
    try{await Promise.all(urls.map(url=>new Promise((resolve,reject)=>{const img=new Image();img.onload=resolve;img.onerror=()=>reject(new Error(t('A rendered board image could not be decoded.','生成的板图无法解码。')));img.src=url;})));}catch(error){urls.forEach(URL.revokeObjectURL);throw error;}
    if(operation!==state.operation){urls.forEach(URL.revokeObjectURL);return;}
    const old=state.urls;state.urls=urls;state.entries=entries;state.model=result;state.name=name;state.focused=null;
    for(const [i,side] of ['top','bottom'].entries()){
      const image=$(side+'-image'),view=result.views[side];image.width=Math.round(view.viewBox[2]);image.height=Math.round(view.viewBox[3]);image.src=urls[i];$(side+'-picture').classList.add('ready');
    }
    old.forEach(URL.revokeObjectURL);
    state.selected=result.groups[0]?.id||null;$('search').value='';renderList();select(state.selected);renderFiles();renderMapping();showIssues();
    status(summary(result,name));
  }catch(error){
    if(operation!==state.operation)return;
    if(reset){state.mappings=previousMappings;state.tableNames=previousTables;previousForm.forEach(item=>{$(item.id).value=item.value;$(item.id).checked=item.checked;});}
    status(`${error.code?error.code+': ':''}${error.message}${state.model?t(' Previous board kept.',' 已保留上一块板图。'):''}`,true);
  }finally{clearTimeout(timeout);if(operation===state.operation)setBusy(false);}
}
async function importFiles(files){
  files=Array.from(files||[]);
  if(!files?.length)return;
  const request=++state.request;
  ++state.operation;
  try{setBusy(true);status(t('Opening your files locally…','正在本地读取文件…'));const entries=await unpackFiles(files);if(request!==state.request)return;await renderEntries(entries,files.length===1?files[0].name:t(`${files.length} files`,`${files.length} 个文件`),true);}
  catch(error){if(request!==state.request)return;status(`${error.code?error.code+': ':''}${error.message}${state.model?t(' Previous board kept.',' 已保留上一块板图。'):''}`,true);setBusy(false);}
}
async function demo(){
  if(state.busy)return;
  const request=state.request;
  try{setBusy(true);status(t('Opening the synthetic sample board…','正在打开合成示例板…'));const response=await fetch('./demo.zip');if(request!==state.request)return;if(!response.ok)throw new Error(t('Sample files unavailable. Import your own board or reload.','示例文件不可用，请导入自己的板图或刷新。'));const bytes=await response.arrayBuffer();if(request!==state.request)return;await importFiles([new File([bytes],'GerberPick-demo.zip')]);}
  catch(error){if(request!==state.request)return;setBusy(false);status(error.message,true);}
}
function renderList(){
  const model=state.model;if(!model)return;
  const query=$('search').value.trim().toLowerCase();
  const groups=model.groups.filter(g=>[g.value,g.footprint,g.mpn,g.supplierPart,...g.refs].join(' ').toLowerCase().includes(query));
  $('total').textContent=`${groups.length} / ${model.groups.length}`;
  $('groups').innerHTML=groups.map(g=>`<button class="part" data-id="${esc(g.id)}" aria-pressed="${g.id===state.selected}"><span class="part-name">${esc(g.value)}${g.dnp?'<span class="badge">DNP</span>':''}</span><span class="part-qty">${g.quantity}</span><small>${esc(g.footprint||t('No package','未提供封装'))}<br>${esc(g.mpn||g.supplierPart||t('No part number','未提供料号'))}</small><small class="part-refs">${esc(g.refs.slice(0,10).join(', '))}${g.refs.length>10?'…':''}</small></button>`).join('')||`<p class="empty">${t('No matching materials.','没有匹配的物料。')}</p>`;
  const placed=model.components.filter(c=>c.placed).length,dnp=model.components.filter(c=>c.dnp).length;
  $('inventory-foot').textContent=t(`${model.components.length} references · ${placed} with positions · ${dnp} DNP`,`${model.components.length} 个位号 · ${placed} 个有坐标 · ${dnp} 个不贴`);
}
function select(id,focused=null){
  const model=state.model;if(!model)return;
  const group=model.groups.find(g=>g.id===id);state.selected=group?.id||null;state.focused=focused;
  $('groups').querySelectorAll('.part').forEach(b=>b.setAttribute('aria-pressed',b.dataset.id===state.selected));
  if(group){
    $('selection-title').textContent=group.value;$('selection-count').textContent=group.quantity;
    $('selection-detail').textContent=[group.footprint,group.mpn||group.supplierPart,`${t('Top','正面')} ${group.top} / ${t('Bottom','背面')} ${group.bottom}`,group.unplaced?`${group.unplaced} ${t('without coordinates','个缺坐标')}`:'',group.dnp?t('DNP — do not fit','DNP — 不装配'):group.unknown?t('Unclassified material; verify its identity','物料信息不完整，请核对'):'' ].filter(Boolean).join(' · ');
    $('refs').innerHTML=group.refs.map(ref=>`<button class="ref${ref===focused?' focused':''}" data-ref="${esc(ref)}">${esc(ref)}</button>`).join('');
  }else{$('selection-title').textContent=t('Board view','板图查看');$('selection-count').textContent='—';$('selection-detail').textContent=t('Add a BOM and placement file to locate materials.','补充 BOM 和贴片坐标后可定位物料。');$('refs').innerHTML='';}
  for(const side of ['top','bottom']){
    const parts=model.components.filter(c=>c.placed&&c.side===side&&c.groupId===state.selected);
    let visible=0;
    $(side+'-overlay').innerHTML=parts.map(c=>{const p=projectPoint(c,model.views[side]);if(!p||p.u<0||p.u>1||p.v<0||p.v>1)return '';visible++;return `<button class="marker${c.ref===focused?' focused':''}${c.dnp?' dnp':''}" data-ref="${esc(c.ref)}" aria-label="${esc(c.ref)}" title="${esc(c.ref)}" style="left:${p.u*100}%;top:${p.v*100}%"><span>${esc(c.ref)}</span></button>`;}).join('');
    $(side+'-count').textContent=`${visible} ${t('highlighted','处高亮')}${parts.length!==visible?` / ${parts.length-visible} ${t('off-image','处超出图像')}`:''}`;
  }
}
function showIssues(){const m=state.model;if(!m)return;$('issues').innerHTML=[...m.dataIssues.map(i=>`<p class="issue">${esc(i.name)}: ${esc(i.message)}</p>`),...m.warnings.map(w=>`<p>${esc(w)}</p>`)].join('');}
function renderFiles(){const m=state.model;if(!m)return;const types=new Map(m.layers.map(l=>[l.name,`${l.side} ${l.type}`]));$('file-list').innerHTML=state.entries.map(e=>`<span title="${esc(types.get(e.name)||m.tables.find(t=>t.name===e.name)?.kind||'data')}">${esc(e.name)}</span>`).join('');}
const roles={bom:['refs','value','footprint','mpn','supplierPart','dnp','quantity'],placement:['ref','x','y','rotation','side','value','footprint']};
function renderMapping(){
  const model=state.model;if(!model)return;
  $('mapping').innerHTML=['bom','placement'].map(kind=>{
    const info=model.tableInfo[kind],table=model.tables.find(t=>t.name===state.tableNames[kind])||info,headers=table?.headers||[];
    return `<div class="mapping-block"><h4>${kind==='bom'?'BOM':t('Placement / CPL','贴片坐标 / CPL')}</h4><select class="table-select" data-table="${kind}" aria-label="${kind} file"><option value="">${t('Auto-detect file','自动识别文件')}</option>${model.tables.map(t=>`<option value="${esc(t.name)}" ${state.tableNames[kind]===t.name?'selected':''}>${esc(t.name)} (${esc(t.kind||'table')})</option>`).join('')}</select><div class="mapping-grid">${roles[kind].map(role=>{
      const current=state.mappings[kind][role];const guessed=table?.mapping?.[role];
      return `<label>${esc(role)}<select data-map-kind="${kind}" data-map-role="${role}"><option value="__auto__">${t('Auto','自动')}${guessed?`: ${esc(guessed)}`:''}</option><option value="__none__" ${current===null?'selected':''}>${t('Not used','不使用')}</option>${headers.map((h,index)=>`<option value="${index}" ${current===index?'selected':''}>${esc(h)}</option>`).join('')}</select></label>`;
    }).join('')}</div></div>`;
  }).join('');
}
function setFace(face){state.face=face;$('boards').classList.toggle('single',face!=='both');document.querySelectorAll('.face').forEach(e=>e.hidden=face!=='both'&&e.dataset.side!==face);document.querySelectorAll('[data-face]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.face===face));}
function download(bytes,name,type='application/zip'){const url=URL.createObjectURL(new Blob([bytes],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function exportMap(){
  const model=state.model;if(!model?.groups.length)return;
  const marker=(c,side)=>{const p=projectPoint(c,model.views[side]);if(!p||p.u<0||p.u>1||p.v<0||p.v>1)return '';return `<span class="mark" style="left:${p.u*100}%;top:${p.v*100}%">${esc(c.ref)}</span>`;};
  const panels=model.groups.map(g=>`<section id="${esc(g.id)}" class="panel"><h2>${esc(g.value)} — ${g.quantity}${g.dnp?' · DNP / DO NOT FIT':''}</h2><p>${esc(g.footprint)} · ${esc(g.mpn||g.supplierPart)} · ${g.unplaced} without coordinates</p><div class="faces">${['top','bottom'].map(side=>`<div><h3>${side==='top'?'Top':'Bottom — flipped horizontally'}</h3><div class="picture"><img src="${side}.svg" alt="${side} board">${model.components.filter(c=>c.groupId===g.id&&c.placed&&c.side===side).map(c=>marker(c,side)).join('')}</div></div>`).join('')}</div></section>`).join('');
  const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'"><title>GerberPick assembly map</title><style>*{box-sizing:border-box}body{margin:0;color:#234351;background:#eef3f5;font:14px Arial,sans-serif}header{padding:18px;background:white}main{display:grid;grid-template-columns:260px 1fr}nav{padding:10px;max-height:90vh;overflow:auto;position:sticky;top:0;align-self:start}nav a{display:block;padding:12px;border-bottom:1px solid #ccdce5;color:#245d7c;text-decoration:none}article{padding:18px;min-width:0}.panel{display:none}.panel:target{display:block}.panel:target~.initial{display:none}.initial{display:block}.faces{display:grid;grid-template-columns:1fr 1fr;gap:16px}.picture{position:relative;background:white}.picture img{display:block;width:100%;height:auto}.mark{position:absolute;transform:translate(-50%,-50%);background:#bb3d1e;color:white;padding:3px;border:2px solid #ff9363;border-radius:12px;font-size:11px}p{line-height:1.7}a:focus-visible{outline:3px solid blue}@media(max-width:700px){main{display:block}nav{position:static;max-height:180px}.faces{grid-template-columns:1fr}}</style><header><b>GerberPick assembly map</b> · Generated locally · Verify origin and orientation before assembly.</header><main><nav>${model.groups.map(g=>`<a href="#${esc(g.id)}">${esc(g.value)} · ${g.quantity}${g.dnp?' · DNP':''}<br><small>${esc(g.refs.join(', '))}</small></a>`).join('')}</nav><article>${panels}<section class="panel initial"><h2>Select a material</h2><div class="faces"><img src="top.svg" alt="Top" style="width:100%"><img src="bottom.svg" alt="Bottom" style="width:100%"></div></section></article></main></html>`;
  download(zipSync({'index.html':strToU8(html),'top.svg':strToU8(model.topSvg),'bottom.svg':strToU8(model.bottomSvg),'README.txt':strToU8('Unzip all files and open index.html. All processing was local. Counts are references in the imported BOM/CPL, not a manufacturing verification. DNP means do not fit.\n')}),'GerberPick-assembly-map.zip');
}
$('files').addEventListener('change',e=>{importFiles(e.target.files);e.target.value='';});
$('demo').addEventListener('click',demo);$('language').addEventListener('click',()=>setLanguage(state.language==='en'?'zh':'en'));
$('search').addEventListener('input',renderList);
$('groups').addEventListener('click',e=>{const b=e.target.closest('[data-id]');if(b)select(b.dataset.id);});
for(const id of ['refs','top-overlay','bottom-overlay'])$(id).addEventListener('click',e=>{const b=e.target.closest('[data-ref]');if(!b)return;const c=state.model?.components.find(c=>c.ref===b.dataset.ref);if(c){select(c.groupId,c.ref);if(c.placed&&state.face!=='both'&&state.face!==c.side)setFace(c.side);}});
document.querySelectorAll('[data-face]').forEach(b=>b.addEventListener('click',()=>setFace(b.dataset.face)));
$('show-labels').addEventListener('change',()=>document.querySelectorAll('.overlay').forEach(el=>el.classList.toggle('hide-labels',!$('show-labels').checked)));
$('mapping').addEventListener('change',e=>{const el=e.target;if(el.dataset.table){state.tableNames[el.dataset.table]=el.value||undefined;state.mappings[el.dataset.table]={};renderMapping();}else if(el.dataset.mapKind){const mapping=state.mappings[el.dataset.mapKind];if(el.value==='__auto__')delete mapping[el.dataset.mapRole];else mapping[el.dataset.mapRole]=el.value==='__none__'?null:Number(el.value);}});
$('apply-settings').addEventListener('click',()=>renderEntries(state.entries,state.name));$('export').addEventListener('click',exportMap);
let dragDepth=0;document.addEventListener('dragenter',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();dragDepth++;document.body.classList.add('dragging');}});document.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files'))e.preventDefault();});document.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;document.body.classList.remove('dragging');}});document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;document.body.classList.remove('dragging');importFiles(e.dataTransfer.files);});
if(navigator.language?.toLowerCase().startsWith('zh'))setLanguage('zh');
demo();
