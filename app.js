const API_URL = "https://script.google.com/macros/s/AKfycbwQDj9KEekj0b3kXZlQhfuFKZa8p5bNgSkrS-oJJ6yoDpInhN2UxLV-F8xxQ2KspwrNzw/exec";

let donneesBrutes = [];
let refs = { enfants: [], types: [], intervenants: [], lieux: [], periodes: [] };
let enfantsInfo = {};
let mapIdToPrenom = {};
let mapIntervenantIdToNom = {};
let mapLieuIdToNom = {};
let enfantsModalSelectionnes = [];
let evenementEnEdition = null;
let payloadEnAttente = null;
let analyseEnAttente = null;
let cacheKey = 'tribu_planning_v6';
let filtreEnfant = localStorage.getItem('tribu_filtreEnfant') || 'Tous';
let filtreIntervenant = localStorage.getItem('tribu_filtreIntervenant') || 'Tous';
let filtrePeriode = localStorage.getItem('tribu_filtrePeriode') || 'Tous';

let datePlageDebut = null;
let datePlageFin = null;
let chargementScrollEnCours = false;

window.addEventListener('load', initialiser);

function initialiser() {
  ['modalEvt','modalConflit','modalSuppression'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
  chargerReferences();
  chargerDonnees(true);
}

function esc(v) {
  return String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function parseDateSecurisee(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  let s = String(v).trim();
  if (!s) return null;
  if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) {
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) return new Date(+m[3], +m[2]-1, +m[1], +(m[4]||0), +(m[5]||0), +(m[6]||0));
  }
  const d = new Date(s.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

function formatForInput(d) {
  const x = d instanceof Date ? d : parseDateSecurisee(d);
  if (!x) return '';
  const p = n => String(n).padStart(2,'0');
  return `${x.getFullYear()}-${p(x.getMonth()+1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
}
function formatDateFR(d) { return d.toLocaleDateString('fr-FR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'}); }
function formatHeure(d) { return d.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}); }
function formatRange(a,b) {
  if (!a) return '';
  if (!b || a.getTime() === b.getTime()) return formatHeure(a);
  const sameDay = a.toDateString() === b.toDateString();
  return sameDay ? `${formatHeure(a)} → ${formatHeure(b)}` : `${formatHeure(a)} → ${b.toLocaleDateString('fr-FR',{weekday:'short',day:'2-digit',month:'2-digit'})} ${formatHeure(b)}`;
}
function dateKey(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

function apiJsonp(action, params={}, timeout=20000) {
  return new Promise((resolve,reject) => {
    const cb = `gt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    let timer;
    const cleanup = () => { clearTimeout(timer); script.remove(); try { delete window[cb]; } catch(e){} };
    window[cb] = data => { cleanup(); if (!data || data.success === false) reject(new Error(data?.message || 'Erreur API')); else resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('Impossible de joindre l’API Apps Script.')); };
    timer = setTimeout(() => { cleanup(); reject(new Error('Délai dépassé pour l’API.')); }, timeout);
    const q = new URLSearchParams({action, callback:cb, _:Date.now(), ...params});
    script.src = `${API_URL}?${q}`;
    document.head.appendChild(script);
  });
}
async function apiGet(action, params={}) { return apiJsonp(action, params); }
async function apiPost(action, payload) { return apiJsonp(action, {payload:JSON.stringify(payload||{})}, 30000); }

function normaliserReponsePlanning(r) {
  const arr = Array.isArray(r) ? r : (Array.isArray(r?.evenements) ? r.evenements : Array.isArray(r?.data?.evenements) ? r.data.evenements : []);
  return arr.map(e => {
    let enfants = e.enfantsIds;
    if (typeof enfants === 'string') { try { enfants = JSON.parse(enfants); } catch(x) { enfants = enfants.split(',').map(s=>s.trim()).filter(Boolean); } }
    if (!Array.isArray(enfants)) enfants = [];
    let idsInt = e.idsIntervenants ?? e.intervenantsIds;
    if (typeof idsInt === 'string') { try { idsInt = JSON.parse(idsInt); } catch(x) { idsInt = idsInt.split(',').map(s=>s.trim()).filter(Boolean); } }
    if (!Array.isArray(idsInt)) idsInt = e.idIntervenant ? [e.idIntervenant] : [];
    return {...e,
      id:String(e.id ?? e.idEvenement ?? '').trim(),
      idEvenement:String(e.idEvenement ?? e.id ?? '').trim(),
      idSerie:String(e.idSerie ?? '').trim(),
      responsable:String(e.responsable ?? e.responsableTexte ?? '').trim(),
      responsableTexte:String(e.responsableTexte ?? e.responsable ?? '').trim(),
      type:String(e.type ?? '').trim(), titre:String(e.titre ?? '').trim(),
      lieu:String(e.lieu ?? e.lieuTexte ?? '').trim(), lieuTexte:String(e.lieuTexte ?? e.lieu ?? '').trim(),
      idIntervenant:String(e.idIntervenant ?? idsInt[0] ?? '').trim(),
      idsIntervenants:idsInt.map(String), intervenantsIds:idsInt.map(String),
      enfantsIds:enfants.map(String), idPeriode:String(e.idPeriode ?? '').trim(), statut:String(e.statut ?? 'Confirmé'),
      controleOccurrence:e.controleOccurrence || null
    };
  }).filter(e => e.id || e.debut);
}

async function chargerReferences() {
  try {
    const r = await fetch('./referentiels.json',{cache:'no-store'});
    if (!r.ok) throw new Error('HTTP '+r.status);
    refs = await r.json();
  } catch(e) {
    refs = {types:['Garde','École','Activité','Santé','Transport','Maison','Événement','Autre'], intervenants:[], enfants:[], lieux:[], periodes:[]};
  }
  refs.enfants = refs.enfants || []; refs.types = refs.types || []; refs.intervenants = refs.intervenants || []; refs.lieux = refs.lieux || []; refs.periodes = refs.periodes || [];
  enfantsInfo = {}; mapIdToPrenom = {}; mapIntervenantIdToNom = {}; mapLieuIdToNom = {};
  refs.enfants.filter(e=>e.actif !== false && e.actif !== 'Non').forEach(e => { enfantsInfo[e.prenom]={id:e.id,color:e.couleur||'#64748B',emoji:e.emoji||'👤'}; mapIdToPrenom[e.id]=e.prenom; });
  refs.intervenants.filter(i=>i.actif !== false && i.actif !== 'Non').forEach(i => { mapIntervenantIdToNom[i.id]=i.nom; });
  refs.lieux.forEach(l => { mapLieuIdToNom[l.id]=l.nom; });
  genererFiltres(); majSelectsModal();
}

function sauvegarderFiltres() {
  localStorage.setItem('tribu_filtreEnfant',filtreEnfant); localStorage.setItem('tribu_filtreIntervenant',filtreIntervenant); localStorage.setItem('tribu_filtrePeriode',filtrePeriode);
}
function toggleFilters() { const p=document.getElementById('filterPanel'), a=document.getElementById('arrowFilter'); const show=p.style.display==='none'; p.style.display=show?'block':'none'; a.innerText=show?'expand_less':'expand_more'; }
function genererFiltres() {
  const c=document.getElementById('childFilters'); c.innerHTML='<div class="chip '+(filtreEnfant==='Tous'?'active':'')+'" onclick="setChildFilter(\'Tous\')">Tous</div>' + refs.enfants.filter(e=>e.actif!==false&&e.actif!=='Non').map(e=>`<div class="chip ${filtreEnfant===e.id?'active':''}" onclick="setChildFilter('${esc(e.id)}')">${esc(e.emoji||'👤')} ${esc(e.prenom)}</div>`).join('');
  const i=document.getElementById('intervenantFilters'); i.innerHTML='<div class="chip '+(filtreIntervenant==='Tous'?'active':'')+'" onclick="setIntervenantFilter(\'Tous\')">Tous</div>' + refs.intervenants.filter(x=>x.actif!==false&&x.actif!=='Non').map(x=>`<div class="chip ${filtreIntervenant===x.id?'active':''}" onclick="setIntervenantFilter('${esc(x.id)}')">${esc(x.nom)}</div>`).join('');
  const p=document.getElementById('periodeFilters'); p.innerHTML='<div class="chip '+(filtrePeriode==='Tous'?'active':'')+'" onclick="setPeriodeFilter(\'Tous\')">Toutes</div><div class="chip '+(filtrePeriode==='HORS_VACANCES'?'active':'')+'" onclick="setPeriodeFilter(\'HORS_VACANCES\')">Hors vacances</div>' + refs.periodes.map(x=>`<div class="chip ${filtrePeriode===x.id?'active':''}" onclick="setPeriodeFilter('${esc(x.id)}')">${esc(x.nom||x.libelle||x.id)}</div>`).join('');
}
function setChildFilter(v){filtreEnfant=v;sauvegarderFiltres();genererFiltres();afficherTimeline();}
function setIntervenantFilter(v){filtreIntervenant=v;sauvegarderFiltres();genererFiltres();afficherTimeline();}
function setPeriodeFilter(v){filtrePeriode=v;sauvegarderFiltres();genererFiltres();afficherTimeline();}
function reinitialiserFiltres(){filtreEnfant='Tous';filtreIntervenant='Tous';filtrePeriode='Tous';sauvegarderFiltres();genererFiltres();afficherTimeline();}

async function chargerDonnees(instantane=false) {
  const loader=document.getElementById('loader');
  if (instantane) {
    try { const c=JSON.parse(localStorage.getItem(cacheKey)||'null'); if(Array.isArray(c)){donneesBrutes=normaliserReponsePlanning(c); afficherTimeline(); loader.style.display='none';} } catch(e){}
  }
  if (!donneesBrutes.length) loader.style.display='block';
  try {
    const now=new Date(); 
    datePlageDebut=new Date(now); datePlageDebut.setDate(datePlageDebut.getDate()-15); datePlageDebut.setHours(0,0,0,0);
    datePlageFin=new Date(now); datePlageFin.setDate(datePlageFin.getDate()+60); datePlageFin.setHours(23,59,59,999);
    
    const r=await apiGet('getPlanningData',{from:formatForInput(datePlageDebut),to:formatForInput(datePlageFin),includeRefs:'0'});
    donneesBrutes=normaliserReponsePlanning(r); localStorage.setItem(cacheKey,JSON.stringify(donneesBrutes));
    loader.style.display='none'; afficherTimeline();
  } catch(e) {
    loader.innerText='Erreur de chargement : '+e.message; loader.style.display='block';
  }
}

function evenementPasseOuFutur(e){const now=new Date(); const s=parseDateSecurisee(e.debut), f=parseDateSecurisee(e.fin)||s; return {start:s,end:f,current:s&&f&&s<=now&&now<f,future:s&&s>now,past:f&&f<now};}
function filtreOk(e){
  if(filtreEnfant!=='Tous' && !(e.enfantsIds||[]).includes(filtreEnfant)) return false;
  if(filtreIntervenant!=='Tous' && !(e.idsIntervenants||[]).includes(filtreIntervenant) && e.idIntervenant!==filtreIntervenant) return false;
  if(filtrePeriode!=='Tous' && String(e.idPeriode||'')!==filtrePeriode) return false;
  return true;
}

function genererOccurrences(){
  return donneesBrutes.filter(e=>e.debut && filtreOk(e)).map(e=>{
    const s=parseDateSecurisee(e.debut), f=parseDateSecurisee(e.fin)||s;
    const enfants=(e.enfantsIds||[]).map(id=>mapIdToPrenom[id]).filter(Boolean);
    const state=evenementPasseOuFutur(e);
    return {...e,dStart:s,dEnd:f,enfantsPrenoms:enfants,enfants:enfants, ...state};
  }).filter(e=>e.dStart).sort((a,b)=>a.dStart-b.dStart);
}

function statusBadges(e){
  const c=e.controleOccurrence; if(!c) return '';
  let out='';
  (c.conflits||[]).forEach(x=>{ if(x.type==='ENFANT') out+='<span class="conflict-badge blocking">⚠ Enfant</span>'; else if(x.type==='INTERVENANT') out+='<span class="conflict-badge warning">⚠ Intervenant</span>'; else if(x.type==='DOUBLON') out+='<span class="conflict-badge blocking">⚠ Doublon</span>'; });
  return out?`<div class="status-line">${out}</div>`:'';
}
function enfantsBadges(enfants){return `<div class="enfants-badges-container">${(enfants||[]).map(n=>{const x=enfantsInfo[n]||{emoji:'👤',color:'#64748B'};return `<span class="badge-enfant" style="background:${x.color}15;color:${x.color};border:1px solid${x.color}40">${x.emoji}${esc(n)}</span>`}).join('')}</div>`;}
function telLiens(intervenantId){const x=refs.intervenants.find(i=>i.id===intervenantId); if(!x) return ''; const nums=[x.telephone,x.telephone2,x.tel,x.tel2].filter(Boolean); if(!nums.length)return ''; return nums.map((n,k)=>{const t=String(n).replace(/\s+/g,'');return `<a class="action-btn-phone" href="tel:${esc(t)}">📞 ${k?'Appel 2':'Appel'}</a><a class="action-btn-phone" href="sms:${esc(t)}">💬 ${k?'SMS 2':'SMS'}</a>`}).join('');}

function afficherTimeline(){
  const c=document.getElementById('timeline'); c.innerHTML='';
  const events=genererOccurrences();
  const active=events.find(e=>e.current); const upcoming=events.find(e=>e.future);
  document.getElementById('contextLine').innerText=active?`En cours : ${formatHeure(active.dStart)} · ${active.titre||active.type||'Événement'}`:upcoming?`Prochain : ${formatDateFR(upcoming.dStart)} · ${formatHeure(upcoming.dStart)}`:'Aucun événement à venir sur la période chargée.';
  if(!events.length){c.innerHTML='<div style="text-align:center;color:#64748B;padding:50px 15px;">Aucun événement correspondant aux filtres.</div>';return;}
  const groups={}; events.forEach(e=>{const k=dateKey(e.dStart);(groups[k]||(groups[k]=[])).push(e)});
  let focusEl=null;
  Object.keys(groups).sort().forEach(k=>{
    const list=groups[k]; const h=document.createElement('div'); h.className='date-header-container'; h.innerHTML=`<div class="date-header">${esc(formatDateFR(list[0].dStart))}</div><span class="date-count-badge">${list.length} créneau${list.length>1?'x':''}</span>`; c.appendChild(h);
    list.forEach(e=>{
      const card=document.createElement('div'); card.className='event-card '+(e.current?'highlight-encours':e===upcoming?'highlight-upcoming':'')+' focus-anchor'; card.dataset.id=e.id;
      if((e.current||e===upcoming)&&!focusEl) focusEl=card;
      const info=e.idsIntervenants?.length?mapIntervenantIdToNom[e.idsIntervenants[0]]:e.responsable; const children=e.enfantsPrenoms||[];
      const color=children.length===1?(enfantsInfo[children[0]]?.color||'#64748B'):'#64748B';
      const badge=e.current?'<span class="badge-encours">En cours</span>':e===upcoming?'<span class="badge-upcoming">Prochain</span>':'';
      card.innerHTML=`<div class="event-color-bar" style="background:${color}"></div><div class="event-content"><div class="event-header"><div class="event-resp">👤 ${esc(info||'Responsable non renseigné')}</div><div style="display:flex;gap:5px;align-items:center"><span class="event-type-badge">${esc(e.type||'Autre')}</span>${badge}</div></div><div class="action-links-container">${telLiens(e.idsIntervenants?.[0]||e.idIntervenant)}</div><div class="sub-slot-item" onclick="editerEvenement('${esc(e.id)}')"><div class="sub-slot-header"><span class="event-time-pill">schedule ${esc(formatRange(e.dStart,e.dEnd))}</span>${enfantsBadges(children)}</div><div class="sub-slot-body">${e.titre?`<div class="sub-slot-title">${esc(e.titre)}</div>`:''}${e.lieu?`<div class="sub-slot-location">📍 ${esc(e.lieu)}</div>`:''}</div><div class="sub-slot-footer"><div style="font-size:12px;color:#64748B">${e.details?esc(e.details):''}</div><span class="edit-icon-btn">✎</span></div></div>${statusBadges(e)}</div>`;
      c.appendChild(card);
    });
  });
  if(focusEl) setTimeout(()=>{document.querySelectorAll('.focus-anchor').forEach(x=>x.classList.remove('focus-anchor'));focusEl.classList.add('focus-anchor');const r=focusEl.getBoundingClientRect();const header=document.querySelector('header');const top=window.scrollY+r.top-(header?.getBoundingClientRect().height||0)-8;window.scrollTo({top:Math.max(0,top),behavior:'smooth'});},180);
}

function genererSelectorEnfantsModal(){
  const c=document.getElementById('formEnfantSelector'); c.innerHTML='';
  const all=document.createElement('div'); all.className='child-chip'; all.innerText='Tous'; all.onclick=()=>{enfantsModalSelectionnes=refs.enfants.filter(e=>e.actif!==false&&e.actif!=='Non').map(e=>e.prenom);majRenduPucesModal()}; c.appendChild(all);
  refs.enfants.filter(e=>e.actif!==false&&e.actif!=='Non').forEach(e=>{const b=document.createElement('div');b.className='child-chip';b.dataset.prenom=e.prenom;b.innerText=`${e.emoji||'👤'} ${e.prenom}`;b.onclick=()=>toggleFormEnfant(e.prenom);c.appendChild(b)}); majRenduPucesModal();
}
function toggleFormEnfant(n){if(enfantsModalSelectionnes.includes(n)) enfantsModalSelectionnes=enfantsModalSelectionnes.filter(x=>x!==n); else enfantsModalSelectionnes.push(n);majRenduPucesModal();}
function majRenduPucesModal(){
  document.querySelectorAll('#formEnfantSelector .child-chip').forEach(b=>{
    const n=b.dataset.prenom;
    const isSelected = n && enfantsModalSelectionnes.includes(n);
    b.classList.toggle('selected', isSelected);
    if(n){
      const x=enfantsInfo[n];
      if(isSelected && x){
        b.style.background=x.color;
        b.style.color='#FFFFFF';
        b.style.borderColor=x.color;
      } else {
        b.style.background='#F1F5F9';
        b.style.color='#475569';
        b.style.borderColor='#E2E8F0';
      }
    }
  });
}
function majSelectsModal(){
  const t=document.getElementById('formTypeSelect'); if(t){t.innerHTML='<option value="">-- Choisir --</option>'+refs.types.map(x=>`<option value="${esc(typeof x==='string'?x:(x.nom||x.libelle||x.id))}">${esc(typeof x==='string'?x:(x.nom||x.libelle||x.id))}</option>`).join('')+'<option value="NOUVEAU">+ Ajouter un type...</option>';}
  const r=document.getElementById('formResponsableSelect'); if(r){r.innerHTML='<option value="">-- Choisir --</option>'+refs.intervenants.filter(x=>x.actif!==false&&x.actif!=='Non').map(x=>`<option value="${esc(x.nom)}" data-id="${esc(x.id)}">${esc(x.nom)}</option>`).join('')+'<option value="NOUVEAU">+ Ajouter...</option>';}
  const p=document.getElementById('formPeriodeSelect'); if(p){p.innerHTML='<option value="">-- Hors vacances --</option>'+refs.periodes.map(x=>`<option value="${esc(x.id)}">${esc(x.nom||x.libelle||x.id)}</option>`).join('');}
}
function gererTypeSelect(){const v=document.getElementById('formTypeSelect').value;const i=document.getElementById('formTypeInput');i.style.display=v==='NOUVEAU'?'block':'none';if(v!=='NOUVEAU')i.value=v;}
function gererResponsableSelect(){const v=document.getElementById('formResponsableSelect').value;const i=document.getElementById('formResponsableInput');i.style.display=v==='NOUVEAU'?'block':'none';if(v!=='NOUVEAU')i.value=v;}
function toggleRecurrenceOpt(e){
  const chk=document.getElementById('chkRecurent');
  if(e && e.target !== chk){ chk.checked = !chk.checked; }
  document.getElementById('recurrenceFields').style.display = chk.checked ? 'block' : 'none';
}
function surChangementDebut(){const s=document.getElementById('formDebut').value;if(s&&!document.getElementById('formId').value){const d=new Date(s);d.setHours(d.getHours()+1);document.getElementById('formFin').value=formatForInput(d)}validerControleDates()}
function validerControleDates(){const a=parseDateSecurisee(document.getElementById('formDebut').value),b=parseDateSecurisee(document.getElementById('formFin').value),bad=!a||!b||b<=a;document.getElementById('dateError').style.display=bad?'flex':'none';return !bad;}

function ouvrirModal(){
  evenementEnEdition=null; document.getElementById('modalTitle').innerText='Nouvel Événement';
  ['formId','formIdSerie','formTitre','formLieu','formDetails','formDate','formRecurFin'].forEach(id=>document.getElementById(id).value='');
  const now=new Date();now.setMinutes(now.getMinutes()-now.getTimezoneOffset());document.getElementById('formDebut').value=formatForInput(now);const f=new Date(now);f.setHours(f.getHours()+1);document.getElementById('formFin').value=formatForInput(f);
  document.getElementById('formTypeSelect').value='';document.getElementById('formTypeInput').style.display='none';document.getElementById('formResponsableSelect').value='';document.getElementById('formResponsableInput').style.display='none';document.getElementById('formPeriodeSelect').value='';document.getElementById('chkRecurent').checked=false;document.getElementById('recurrenceFields').style.display='none';document.getElementById('secOptionSerie').style.display='none';document.getElementById('btnDelete').style.display='none';
  enfantsModalSelectionnes=[];genererSelectorEnfantsModal();document.getElementById('modalEvt').style.display='flex';
}
function fermerModal(){document.getElementById('modalEvt').style.display='none';}
function editerEvenement(id){
  const e=donneesBrutes.find(x=>String(x.id)===String(id));if(!e)return;evenementEnEdition=e;document.getElementById('modalTitle').innerText='Modifier l’événement';
  document.getElementById('formId').value=e.id;document.getElementById('formIdSerie').value=e.idSerie||'';document.getElementById('formTitre').value=e.titre||'';document.getElementById('formDebut').value=formatForInput(e.debut);document.getElementById('formFin').value=formatForInput(e.fin);document.getElementById('formLieu').value=e.lieu||'';document.getElementById('formDetails').value=e.details||'';document.getElementById('formPeriodeSelect').value=e.idPeriode||'';
  const typeKnown=refs.types.some(x=>(typeof x==='string'?x:(x.nom||x.libelle||x.id))===e.type);document.getElementById('formTypeSelect').value=typeKnown?e.type:'NOUVEAU';document.getElementById('formTypeInput').value=e.type||'';document.getElementById('formTypeInput').style.display=typeKnown?'none':'block';
  const int=refs.intervenants.find(x=>x.id===e.idIntervenant)||refs.intervenants.find(x=>x.nom===e.responsable);if(int){document.getElementById('formResponsableSelect').value=int.nom;document.getElementById('formResponsableInput').style.display='none'}else{document.getElementById('formResponsableSelect').value='NOUVEAU';document.getElementById('formResponsableInput').value=e.responsable||'';document.getElementById('formResponsableInput').style.display='block'}
  enfantsModalSelectionnes=(e.enfantsIds||[]).map(x=>mapIdToPrenom[x]).filter(Boolean);genererSelectorEnfantsModal();document.getElementById('chkRecurent').checked=false;document.getElementById('recurrenceFields').style.display='none';document.getElementById('secOptionSerie').style.display=e.idSerie?'block':'none';document.getElementById('btnDelete').style.display='block';validerControleDates();document.getElementById('modalEvt').style.display='flex';
}
function collectPayload(){
  let type=document.getElementById('formTypeSelect').value; if(type==='NOUVEAU'||!type) type=document.getElementById('formTypeInput').value;
  let resp=document.getElementById('formResponsableSelect').value; if(resp==='NOUVEAU'||!resp) resp=document.getElementById('formResponsableInput').value;
  const opt=document.querySelector('input[name="optSerieAction"]:checked');
  const ints=refs.intervenants.filter(i=>i.nom===resp).map(i=>i.id);
  return {id:document.getElementById('formId').value,idSerie:document.getElementById('formIdSerie').value,modeModifSerie:opt?.value||'UNIQUE',enfantsIds:enfantsModalSelectionnes.map(n=>enfantsInfo[n]?.id).filter(Boolean),type:String(type||'').trim(),responsable:String(resp||'').trim(),idIntervenant:ints[0]||'',idsIntervenants:ints,titre:document.getElementById('formTitre').value.trim(),debut:document.getElementById('formDebut').value,fin:document.getElementById('formFin').value,lieu:document.getElementById('formLieu').value.trim(),idLieu:(evenementEnEdition?.idLieu||''),details:document.getElementById('formDetails').value.trim(),idPeriode:document.getElementById('formPeriodeSelect').value,statut:'Confirmé',isRecurent:document.getElementById('chkRecurent').checked,intervalleRecurrence:document.getElementById('formRecurIntervalle').value,uniteRecurrence:document.getElementById('formRecurUnite').value,dateFinRecurrence:document.getElementById('formRecurFin').value,confirmerConflits:false};
}
async function soumettre(){
  if(!validerControleDates()){return} const p=collectPayload();
  if(!p.enfantsIds.length){alert('Sélectionne au moins un enfant.');return} if(!p.type||!p.responsable){alert('Merci de renseigner le type et le responsable.');return}
  payloadEnAttente=p; await demanderAnalyseEtSauvegarde(false);
}
async function demanderAnalyseEtSauvegarde(confirmer){
  try{
    const r=await apiPost('analyserConflits',{...payloadEnAttente,confirmerConflits:confirmer});
    if(r.requiresConfirmation){analyseEnAttente=r;ouvrirModalConflit(r);return}
    if(r.success===false){alert(r.message||'Erreur de validation');return}
    if(confirmer) payloadEnAttente.confirmerConflits=true;
    await executerEnregistrement(payloadEnAttente);
  }catch(e){alert('Erreur de contrôle : '+e.message)}
}

function rendreTexteLisible(txt) {
  if (!txt) return '';
  let s = String(txt);
  Object.keys(mapIntervenantIdToNom).forEach(id => {
    if (id && mapIntervenantIdToNom[id]) {
      s = s.replace(new RegExp('\\b' + id + '\\b', 'g'), mapIntervenantIdToNom[id]);
    }
  });
  Object.keys(mapIdToPrenom).forEach(id => {
    if (id && mapIdToPrenom[id]) {
      s = s.replace(new RegExp('\\b' + id + '\\b', 'g'), mapIdToPrenom[id]);
    }
  });
  s = s.replace(/(?:l[’']|l')?événement\s+(\w+)/gi, (m, evId) => {
    const ev = donneesBrutes.find(x => String(x.id) === String(evId));
    if (ev) {
      const desc = ev.titre || ev.type || 'Événement';
      return `l'événement « ${desc} »`;
    }
    return m;
  });
  return s;
}

function ouvrirModalConflit(r){
  const a=r.analysis||{};
  document.getElementById('conflitTitle').innerHTML = `<span class="material-symbols-outlined" style="color:#F59E0B; font-size:22px; vertical-align:sub; margin-right:6px;">warning</span> ${esc(a.title || 'Avertissement')}`;
  
  let html = `<div style="font-size:14px; margin-bottom:12px; color:#334155;">${esc(rendreTexteLisible(a.message || 'Des chevauchements existent mais peuvent être autorisés.'))}</div>`;
  
  if (a.conflits?.length) {
    html += '<ul style="margin:10px 0 0 0; padding-left:18px; font-size:13px; color:#475569; display:flex; flex-direction:column; gap:6px;">';
    a.conflits.forEach(x => {
      html += `<li><strong>${esc(x.libelle || x.type)} :</strong> ${esc(rendreTexteLisible(x.detail || ''))}</li>`;
    });
    html += '</ul>';
  }
  
  if (a.plan?.length) {
    html += '<div style="margin-top:14px; padding:10px; background:#F8FAFC; border-radius:8px; border:1px solid #E2E8F0; font-size:12px;"><strong>Réorganisation proposée :</strong><ul style="margin:6px 0 0 16px;">';
    a.plan.forEach(x => {
      html += `<li>${esc(rendreTexteLisible(x.actionTexte || 'Ajustement'))}</li>`;
    });
    html += '</ul></div>';
  }
  
  document.getElementById('conflitMessage').innerHTML = html;
  document.getElementById('btnConflitAction').innerText = 'Enregistrer quand même';
  document.getElementById('modalConflit').style.display = 'flex';
}
function fermerModalConflit(){document.getElementById('modalConflit').style.display='none';}
async function confirmerConflitEtEnregistrer(){fermerModalConflit();payloadEnAttente.confirmerConflits=true;await demanderAnalyseEtSauvegarde(true);}
async function executerEnregistrement(p){const b=document.getElementById('btnSubmit');b.disabled=true;b.innerText='Enregistrement…';try{const r=await apiPost('sauvegarderEvenement',p);if(!r.success)throw new Error(r.message||'Enregistrement impossible');fermerModal();localStorage.removeItem(cacheKey);await chargerDonnees(false)}catch(e){alert('Erreur d’enregistrement : '+e.message)}finally{b.disabled=false;b.innerText='Enregistrer'}}

function supprimer(){
  const id=document.getElementById('formId').value;
  const idSerie=document.getElementById('formIdSerie').value;
  if(!id)return;
  document.getElementById('supprModalMessage').innerHTML = idSerie ? 'Cet événement appartient à une série. Choisis ce que tu veux supprimer.' : 'Voulez-vous vraiment supprimer cet événement ?';
  document.getElementById('supprSerieOptions').style.display = idSerie ? 'block' : 'none';
  document.getElementById('modalSuppression').style.display = 'flex';
}

function fermerModalSuppression(){document.getElementById('modalSuppression').style.display='none';}

async function confirmerSuppressionEffective() {
  const id = document.getElementById('formId').value;
  const idSerie = document.getElementById('formIdSerie').value;
  let mode = 'UNIQUE';
  
  if (idSerie) {
    mode = document.querySelector('input[name="optSupprSerie"]:checked')?.value || 'UNIQUE';
  }
  
  fermerModalSuppression();
  
  try {
    const r = await apiPost('supprimerLigne', { id, modeSupprSerie: mode });
    if (!r.success) throw new Error(r.message || 'Suppression impossible');
    
    fermerModal();
    localStorage.removeItem(cacheKey);
    await chargerDonnees(false); 
  } catch(e) {
    alert('Erreur de suppression : ' + e.message);
  }
}

// --- LOGIQUE DE DÉFILEMENT (INFINITE SCROLL) ---
window.addEventListener('scroll', async () => {
  if (chargementScrollEnCours || !datePlageDebut || !datePlageFin) return;
  
  const scrollY = window.scrollY;
  const windowHeight = window.innerHeight;
  const documentHeight = document.documentElement.scrollHeight;

  if (scrollY + windowHeight >= documentHeight - 150) {
    await chargerPlusDeDonnees('futur');
  } 
  else if (scrollY <= 0) {
    await chargerPlusDeDonnees('passe');
  }
});

async function chargerPlusDeDonnees(direction) {
  chargementScrollEnCours = true;
  document.getElementById('loader').style.display = 'block';
  
  try {
    let from, to;
    if (direction === 'futur') {
      from = new Date(datePlageFin); from.setDate(from.getDate() + 1);
      to = new Date(from); to.setDate(to.getDate() + 30); to.setHours(23, 59, 59, 999);
    } else {
      to = new Date(datePlageDebut); to.setDate(to.getDate() - 1);
      from = new Date(to); from.setDate(from.getDate() - 30); from.setHours(0, 0, 0, 0);
    }

    const r = await apiGet('getPlanningData', { from: formatForInput(from), to: formatForInput(to), includeRefs: '0' });
    const nouvellesDonnees = normaliserReponsePlanning(r);

    if (nouvellesDonnees.length > 0) {
      const idsExistants = new Set(donneesBrutes.map(e => String(e.id)));
      const aAjouter = nouvellesDonnees.filter(e => !idsExistants.has(String(e.id)));
      
      if (aAjouter.length > 0) {
        donneesBrutes = [...donneesBrutes, ...aAjouter];
        donneesBrutes.sort((a, b) => new Date(a.debut || a.debutDate) - new Date(b.debut || b.debutDate));

        const scrollAvant = window.scrollY; 
        const hauteurAvant = document.documentElement.scrollHeight;
        
        afficherTimeline(); 
        
        if (direction === 'passe') {
          const hauteurApres = document.documentElement.scrollHeight;
          window.scrollTo(0, scrollAvant + (hauteurApres - hauteurAvant)); 
        }
      }
    }
    
    if (direction === 'futur') datePlageFin = to;
    else datePlageDebut = from;

  } catch(e) { 
    console.error("Erreur de défilement :", e); 
  } finally {
    document.getElementById('loader').style.display = 'none';
    setTimeout(() => { chargementScrollEnCours = false; }, 800);
  }
}
