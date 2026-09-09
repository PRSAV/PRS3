const $ = id => document.getElementById(id);
// ---- BACKEND -------------------------------------------------------------
// V3 points at the SAME Cloudflare Worker as V2, so both apps read and write
// the same companies, members, records and photos. That is what lets you move
// across gradually. To give V3 its own separate database instead, deploy a
// second Worker with its own D1 and R2 bindings and put its URL here.
const WORKER_URL = 'https://pv-capture-ai-v2.mahipal-office21.workers.dev';
const SESSION_KEY = 'prs-assetverify-session-v30';
const STICKY_PREFIX = 'prs-assetverify-sticky-v30-';
const CONDITIONS = ['Good','Fair','Poor','Damaged','Under Repair'];
const STATUSES = ['Found','Not Found','Pending'];
const NOT_FOUND_REASONS = ['','Missing','Disposed','Transferred','Stolen','Under Maintenance'];
const R2_FREE_BYTES = 10 * 1024 * 1024 * 1024;

const PERMISSION_CATALOG = [
  ['verification.view','Verification - View','Open the verification workspace and saved records'],
  ['verification.capture_photo','Verification - Take Photo','Capture a new verification photo'],
  ['verification.upload_gallery','Verification - Gallery Upload','Upload a photo from the device gallery'],
  ['verification.scan','Verification - Scan QR / Barcode','Use Scan & Verify'],
  ['verification.save','Verification - Save','Save a new verification record'],
  ['verification.edit','Verification - Edit','Edit an existing verification record'],
  ['verification.delete','Verification - Delete','Delete a verification record and photo'],
  ['verification.view_images','Verification - View Images','View stored verification photos'],
  ['records.search','Records - Search & Filters','Search and filter verification records'],
  ['records.export','Reports - Export Excel','Export the company verification report to Excel'],
  ['records.view_usage','Reports - Usage','View company photo storage usage'],
  ['audit.view','Governance - Audit Trail','View immutable company audit events'],
  ['backup.manage','Data Protection - Backup & Restore','Download and restore complete company backups'],
  ['members.view','Members - View','View company team members'],
  ['members.create','Members - Add','Add a company team member'],
  ['members.edit','Members - Edit','Edit a team member or assigned role'],
  ['members.delete','Members - Delete','Delete a team member'],
  ['roles.view','Roles - View','View roles and their permissions'],
  ['roles.create','Roles - Create','Create a custom role'],
  ['roles.edit','Roles - Edit','Edit system/custom role name, permissions and assignments'],
  ['roles.delete','Roles - Delete','Delete an unused custom role'],
  ['roles.assign','Roles - Assign','Assign roles to team members'],
  ['masters.view','Setting & Master - View','View sticky and variable field masters'],
  ['masters.edit','Setting & Master - Edit','Add, edit or delete sticky / variable fields'],
  ['company.edit','Company - Edit','Edit company details and credentials'],
  ['company.delete','Company - Delete','Permanently delete the company workspace']
];

let session = null;
let companies = [];
let records = [];
let users = [];
let roles = [];
let fields = {sticky:[], variable:[], allFields:[], schemaVersion:1};
let exportColumns = [];
let exportHistory = [];
let selectedCompany = null;
let deleteTargetCompany = null;
let pendingRecord = null;
let editingRecord = null;
let editingUser = null;
let editingRole = null;
let editingField = null;
let editingFieldGroup = null;
let aiSeq = 0;
let activeStatus = 'ALL';
let scannerStream = null;
let scannerDetector = null;
let scannerLoopTimer = null;
let scannerCanvas = null;
let scannerRunning = false;
let scannerScanBusy = false;
let scannerAutoProceed = false;
let scannerFrameCount = 0;
let scannerStartedAt = 0;
let appendPhotoMode = false;
let scanCodes = [];
let scanEvidenceFiles = [];
let scanMetaByCode = {};        // code value -> { format, symbology, gs1 } from the V3 engine
let scanLastLatencyMs = 0;
let auditEvents = [];
let selectedMemberForPin = null;
let syncRunning = false;
const OFFLINE_DB_NAME = 'prs-assetverify-offline-v30';
const OFFLINE_DB_VERSION = 1;

function toast(message, ms=2800){const e=$('toast');e.textContent=message;e.classList.remove('hidden');clearTimeout(e._t);e._t=setTimeout(()=>e.classList.add('hidden'),ms)}
function escapeHtml(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function pad(n){return String(n).padStart(2,'0')}
function fmtDate(d){d=new Date(d);return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`}
function fmtTime(d){d=new Date(d);return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`}
function isoDateInput(d){const x=new Date(d);return `${x.getFullYear()}-${pad(x.getMonth()+1)}-${pad(x.getDate())}`}
function timeInput(d){const x=new Date(d);return `${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`}
function combineDateTime(date,time){const d=new Date(`${date}T${time || '00:00:00'}`);return Number.isNaN(d.getTime())?new Date().toISOString():d.toISOString()}
function uid(){return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}
function bytesLabel(n){if(n<1024*1024)return `${(n/1024).toFixed(1)} KB`;if(n<1024*1024*1024)return `${(n/1024/1024).toFixed(1)} MB`;return `${(n/1024/1024/1024).toFixed(2)} GB`}
function hasPermission(code){const p=session?.member?.permissions||[];return p.includes('*')||p.includes(code)}
function authHeaders(body=false){const h={};if(body)h['Content-Type']='application/json';if(session?.token)h.Authorization=`Bearer ${session.token}`;return h}
async function api(path,options={}){
  const opts={...options,headers:{...authHeaders(!!options.body),...(options.headers||{})}};
  try{
    const r=await fetch(`${WORKER_URL}${path}`,opts);
    if(r.status===401&&session){clearSession();showWelcome();toast('Company session expired. Please login again.')}
    return r;
  }catch(error){
    console.error('PRS API connection error:',path,error);
    throw new Error(navigator.onLine
      ? 'Could not reach the PRS cloud server. Please retry in a moment.'
      : 'You are offline. Reconnect to use this cloud feature.');
  }
}
async function apiJson(path,options={}){
  const r=await api(path,options);
  const text=await r.text().catch(()=>'');
  let d={};
  if(text){try{d=JSON.parse(text)}catch{d={}}}
  if(!r.ok)throw new Error(d.error||`Cloud request failed (${r.status})`);
  return d;
}
function saveSession(){localStorage.setItem(SESSION_KEY,JSON.stringify(session))}
function clearSession(){session=null;localStorage.removeItem(SESSION_KEY)}
function loadSession(){try{return JSON.parse(localStorage.getItem(SESSION_KEY)||'null')}catch{return null}}

const allViews=['welcomeView','createCompanyView','existingCompanyView','verifyView','searchView','usersView','rolesView','mastersView','downloadHistoryView','auditView','backupView','usageView','editCompanyView'];
const menuSubviewIds=new Set(['searchView','usersView','rolesView','mastersView','downloadHistoryView','auditView','backupView','usageView','editCompanyView']);
function showView(id){allViews.forEach(v=>$(v).classList.toggle('hidden',v!==id));const showExit=id!=='welcomeView'&&id!=='verifyView';$('viewExitBtn').classList.toggle('hidden',!showExit);$('viewExitBtn').dataset.currentView=id;closeDrawer()}
function showWelcome(){showView('welcomeView');$('menuBtn').classList.add('hidden');$('logoutBtn').classList.add('hidden');$('syncBadge').classList.add('hidden');$('companySubtitle').textContent=''}
function openDrawer(){$('drawer').classList.remove('hidden');$('drawerBackdrop').classList.remove('hidden')}
function closeDrawer(){$('drawer').classList.add('hidden');$('drawerBackdrop').classList.add('hidden')}
function updateShell(){if(!session)return;$('menuBtn').classList.remove('hidden');$('logoutBtn').classList.remove('hidden');$('syncBadge').classList.remove('hidden');$('companySubtitle').textContent=session.company.name;$('drawerCompany').textContent=session.company.name;$('drawerUser').textContent=session.member?`${session.member.name} · ${session.member.roleName}`:'Team member not selected';document.querySelectorAll('[data-permission]').forEach(e=>e.classList.toggle('hidden',!hasPermission(e.dataset.permission)));document.querySelectorAll('[data-permission-button]').forEach(e=>{const ok=hasPermission(e.dataset.permissionButton);e.classList.toggle('hidden',!ok);e.disabled=!ok});updateOfflineNotice();updateSyncUi()}

$('menuBtn').onclick=openDrawer;$('drawerBackdrop').onclick=closeDrawer;$('closeDrawerBtn').onclick=closeDrawer;$('viewExitBtn').onclick=()=>{const current=$('viewExitBtn').dataset.currentView;if(current==='createCompanyView'||current==='existingCompanyView'){showWelcome();return}if(session?.member){showView('verifyView');renderStickyFields();renderRecent()}else if(session){showView('existingCompanyView');loadCompanies()}else showWelcome()};$('logoutBtn').onclick=async()=>{try{await apiJson('/auth/logout',{method:'POST'})}catch{}clearSession();showWelcome()};

document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=async()=>{const n=b.dataset.nav;if(n==='verify'){showView('verifyView');renderStickyFields();renderRecent()}if(n==='search'){showView('searchView');populateFilters();renderSearch()}if(n==='users'){showView('usersView');await refreshUsers();renderUsers()}if(n==='roles'){showView('rolesView');await refreshRoles();renderRoles()}if(n==='masters'){showView('mastersView');await Promise.all([refreshFields(),refreshExportColumns()]);renderMasters()}if(n==='downloadHistory'){showView('downloadHistoryView');await refreshDownloadHistory()}if(n==='audit'){showView('auditView');await refreshAudit()}if(n==='backup'){showView('backupView')}if(n==='usage'){showView('usageView');await loadUsage()}if(n==='editCompany'){fillCompanyEdit();showView('editCompanyView')}if(n==='switchMember'){await refreshUsers();showMemberSelector()}if(n==='switchCompany'){clearSession();showView('existingCompanyView');await loadCompanies()}if(n==='welcome'){clearSession();showWelcome()}});

// ---------- Company creation / login ----------
function createMemberRow(data={},locked=false){
  const wrap=document.createElement('div');
  wrap.className='member-row member-row-v6';
  wrap.innerHTML=`<label>Full Name *<input class="cm-name" value="${escapeHtml(data.name||'')}" placeholder="Member name"></label><label>Initial Role *<select class="cm-role"><option value="ADMIN" ${data.role==='ADMIN'?'selected':''}>Admin</option><option value="VERIFIER" ${data.role==='VERIFIER'?'selected':''}>Verifier</option></select></label><label>Member PIN *<input class="cm-pin" type="password" inputmode="numeric" maxlength="6" placeholder="4–6 digits"></label><button class="remove-member" type="button" ${locked?'disabled':''}>✕</button>`;
  const role=wrap.querySelector('.cm-role');
  role.dataset.lastValue=role.value;
  role.addEventListener('change',()=>{
    const hasAdmin=[...$('createMembers').querySelectorAll('.cm-role')].some(select=>select.value==='ADMIN');
    if(!hasAdmin){
      role.value=role.dataset.lastValue||'ADMIN';
      toast('At least one Admin is compulsory. The last Admin cannot be changed to Verifier.',4200);
      return;
    }
    role.dataset.lastValue=role.value;
  });
  wrap.querySelector('.remove-member').onclick=()=>{
    const rolesNow=[...$('createMembers').querySelectorAll('.member-row')];
    const thisIsAdmin=role.value==='ADMIN';
    const adminCount=rolesNow.filter(row=>row.querySelector('.cm-role')?.value==='ADMIN').length;
    if(thisIsAdmin&&adminCount<=1){toast('At least one Admin is compulsory.');return;}
    wrap.remove();
  };
  return wrap;
}
function resetCreateCompany(){$('newCompanyName').value='';$('newCompanyStartDate').value=isoDateInput(new Date());$('newCompanyUsername').value='';$('newCompanyPassword').value='';$('createMembers').innerHTML='';$('createMembers').appendChild(createMemberRow({role:'ADMIN'},true));$('createMembers').appendChild(createMemberRow({role:'VERIFIER'}))}
function collectCreateMembers(){return [...$('createMembers').querySelectorAll('.member-row')].map(r=>({name:r.querySelector('.cm-name').value.trim(),role:r.querySelector('.cm-role').value,pin:r.querySelector('.cm-pin').value.trim()}))}
$('openCreateCompanyBtn').onclick=()=>{resetCreateCompany();showView('createCompanyView')};$('openExistingCompanyBtn').onclick=async()=>{showView('existingCompanyView');await loadCompanies()};document.querySelectorAll('[data-back-welcome]').forEach(b=>b.onclick=showWelcome);$('addCreateMemberBtn').onclick=()=>$('createMembers').appendChild(createMemberRow({role:'VERIFIER'}));
$('createCompanyBtn').onclick=async()=>{const name=$('newCompanyName').value.trim(),startDate=$('newCompanyStartDate').value,username=$('newCompanyUsername').value.trim(),password=$('newCompanyPassword').value,members=collectCreateMembers();if(!name||!startDate||!username||!password){toast('Complete company name, start date, username and password.');return}if(password.length<6){toast('Company password must be at least 6 characters.');return}if(members.some(m=>!m.name)||!members.some(m=>m.role==='ADMIN')){toast('Every member needs a name and at least one Admin is required.');return}if(members.some(m=>!/^\d{4,6}$/.test(m.pin))){toast('Set a 4–6 digit personal PIN for every team member.');return}const btn=$('createCompanyBtn');btn.disabled=true;btn.textContent='Creating Company…';try{const d=await apiJson('/public/companies',{method:'POST',body:JSON.stringify({name,startDate,username,password,members})});session=d.session;saveSession();await enterCompany()}catch(e){toast(e.message,4500)}finally{btn.disabled=false;btn.textContent='Create Company'}};

async function loadCompanies(){try{const d=await apiJson('/public/companies');companies=d.companies||[];$('companyList').innerHTML=companies.map(c=>`<div class="company-row company-row-v9"><button class="company-open-btn" data-company="${c.id}"><strong>${escapeHtml(c.name)}</strong><span>${escapeHtml(c.code)}</span></button><span class="company-users">${c.memberCount} member${c.memberCount===1?'':'s'}</span><span class="company-start">Start: ${escapeHtml(c.startDate)}</span><span class="status-active">Active</span><button class="danger mini-btn company-delete-public" data-public-delete-company="${c.id}">Delete</button></div>`).join('');$('noCompanies').classList.toggle('hidden',companies.length>0);document.querySelectorAll('[data-company]').forEach(b=>b.onclick=()=>openLogin(b.dataset.company));document.querySelectorAll('[data-public-delete-company]').forEach(b=>b.onclick=e=>{e.stopPropagation();openPublicDeleteCompany(b.dataset.publicDeleteCompany)})}catch(e){toast(e.message)}}
function openPublicDeleteCompany(id){deleteTargetCompany=companies.find(c=>String(c.id)===String(id));if(!deleteTargetCompany)return;$('publicDeleteCompanyTitle').textContent=`Delete ${deleteTargetCompany.name}`;$('publicDeleteAdminName').value='';$('publicDeleteAdminPin').value='';$('publicDeleteCompanyModal').classList.remove('hidden')}
$('confirmPublicDeleteCompanyBtn').onclick=async()=>{if(!deleteTargetCompany)return;const adminName=$('publicDeleteAdminName').value.trim(),pin=$('publicDeleteAdminPin').value.trim();if(!adminName||!/^[0-9]{4,6}$/.test(pin)){toast('Enter the company Admin name and 4–6 digit PIN.');return}if(!confirm(`Permanently delete ${deleteTargetCompany.name} and all of its cloud data?`))return;try{await apiJson('/public/delete-company',{method:'POST',body:JSON.stringify({companyId:deleteTargetCompany.id,adminName,pin})});$('publicDeleteCompanyModal').classList.add('hidden');toast('Company permanently deleted.');deleteTargetCompany=null;await loadCompanies()}catch(e){toast(e.message,4500)}};
function openLogin(id){selectedCompany=companies.find(c=>String(c.id)===String(id));if(!selectedCompany)return;$('loginCompanyName').textContent=selectedCompany.name;$('loginUsername').value='';$('loginPassword').value='';$('loginModal').classList.remove('hidden')}
$('loginBtn').onclick=async()=>{try{const d=await apiJson('/auth/login',{method:'POST',body:JSON.stringify({companyId:selectedCompany.id,username:$('loginUsername').value.trim(),password:$('loginPassword').value})});session=d.session;saveSession();$('loginModal').classList.add('hidden');await enterCompany()}catch(e){toast(e.message,4200)}};
$('forgotPasswordBtn').onclick=()=>{$('loginModal').classList.add('hidden');$('forgotStep1').classList.remove('hidden');$('forgotStep2').classList.add('hidden');$('forgotUsername').value=$('loginUsername').value.trim();$('forgotModal').classList.remove('hidden')};
$('sendResetBtn').onclick=async()=>{try{const d=await apiJson('/auth/forgot',{method:'POST',body:JSON.stringify({companyId:selectedCompany.id,username:$('forgotUsername').value.trim()})});$('forgotStep1').classList.add('hidden');$('forgotStep2').classList.remove('hidden');toast(d.emailConfigured?'Reset code sent.':'Reset request created, but email delivery is not configured yet.',4500)}catch(e){toast(e.message,4200)}};
$('resetPasswordBtn').onclick=async()=>{try{await apiJson('/auth/reset',{method:'POST',body:JSON.stringify({companyId:selectedCompany.id,username:$('forgotUsername').value.trim(),code:$('resetCode').value.trim(),newPassword:$('newPassword').value})});$('forgotModal').classList.add('hidden');toast('Company password changed.');openLogin(selectedCompany.id)}catch(e){toast(e.message,4200)}};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).classList.add('hidden'));

async function restoreSession(){session=loadSession();if(!session){showWelcome();return}if(!navigator.onLine){toast('Offline mode: using the last signed-in session.',3500);await enterCompany();return}try{const d=await apiJson('/auth/me');session=d.session;saveSession();await enterCompany()}catch(e){if(isNetworkError(e)){toast('Network unavailable. Opening cached company data.',3500);await enterCompany()}else{clearSession();showWelcome()}}}
async function enterCompany(){
  updateShell();
  await refreshUsers();
  if(!session.member){showMemberSelector();return}
  await Promise.all([refreshRoles(),refreshFields(),refreshExportColumns(),refreshRecords()]);
  renderStickyFields();
  showView('verifyView');
  if(navigator.onLine){await syncQueue();await refreshRecords()}
}
function showMemberSelector(){$('memberSelectList').innerHTML=users.filter(u=>u.active!==0).map(u=>`<button class="member-select-btn" data-member-select="${u.id}"><span>${escapeHtml(u.name)}</span><small>${escapeHtml(u.roleName||'Role')} · PIN protected</small></button>`).join('');$('memberSelectModal').classList.remove('hidden');document.querySelectorAll('[data-member-select]').forEach(b=>b.onclick=()=>requestMemberPin(b.dataset.memberSelect))}
$('closeMemberSelectBtn').onclick=()=>{$('memberSelectModal').classList.add('hidden');if(!session?.member){clearSession();showView('existingCompanyView');loadCompanies()}};
function requestMemberPin(id){if(!navigator.onLine){toast('Reconnect to the internet to switch team members and validate the PIN.',4200);return}selectedMemberForPin=users.find(u=>String(u.id)===String(id));if(!selectedMemberForPin)return;$('memberPinTitle').textContent=`Enter PIN for ${selectedMemberForPin.name}`;$('memberPinHint').textContent=`Role: ${selectedMemberForPin.roleName||'Member'}`;$('memberPinInput').value='';$('memberPinModal').classList.remove('hidden');setTimeout(()=>$('memberPinInput').focus(),50)}
async function selectMember(id,pin){try{const d=await apiJson('/auth/select-member',{method:'POST',body:JSON.stringify({memberId:id,pin})});session=d.session;saveSession();$('memberPinModal').classList.add('hidden');$('memberSelectModal').classList.add('hidden');updateShell();await Promise.all([refreshUsers(),refreshRoles(),refreshFields(),refreshExportColumns(),refreshRecords()]);renderStickyFields();showView('verifyView');syncQueue()}catch(e){toast(e.message,4200)}}
$('confirmMemberPinBtn').onclick=()=>{const pin=$('memberPinInput').value.trim();if(!/^\d{4,6}$/.test(pin)){toast('Enter your 4–6 digit member PIN.');return}if(selectedMemberForPin)selectMember(selectedMemberForPin.id,pin)};$('memberPinInput').addEventListener('keydown',e=>{if(e.key==='Enter')$('confirmMemberPinBtn').click()});

// ---------- Dynamic fields ----------
function fieldDefaultValue(def){if(def.type==='number')return '';return ''}
function stickyKey(){return STICKY_PREFIX + session.company.id}
function loadSticky(){try{return JSON.parse(localStorage.getItem(stickyKey())||'{}')}catch{return {}}}
function saveStickyFromDom(){const out={};fields.sticky.forEach(f=>{const el=$(`sticky_${f.id}`);if(el)out[f.id]=el.value});localStorage.setItem(stickyKey(),JSON.stringify(out));return out}
function fieldInputHtml(def,value='',idPrefix='field'){const id=`${idPrefix}_${def.id}`;const val=escapeHtml(value??'');if(def.type==='textarea')return `<label class="dynamic-field">${escapeHtml(def.label)}<textarea id="${id}" rows="3">${val}</textarea></label>`;if(def.type==='select'){const opts=(def.options||[]).map(o=>`<option ${String(o)===String(value)?'selected':''}>${escapeHtml(o)}</option>`).join('');return `<label class="dynamic-field">${escapeHtml(def.label)}<select id="${id}"><option value=""></option>${opts}</select></label>`}if(def.type==='member'){const opts=users.filter(u=>u.active!==0).map(u=>`<option value="${u.id}" ${String(u.id)===String(value)?'selected':''}>${escapeHtml(u.name)}</option>`).join('');return `<label class="dynamic-field">${escapeHtml(def.label)}<select id="${id}"><option value=""></option>${opts}</select></label>`}return `<label class="dynamic-field">${escapeHtml(def.label)}<input id="${id}" type="${def.type==='number'?'number':'text'}" value="${val}" /></label>`}
function renderStickyFields(){const c=$('stickyFieldsContainer');if(!c)return;const vals=loadSticky();c.innerHTML=fields.sticky.map(f=>fieldInputHtml(f,vals[f.id]??fieldDefaultValue(f),'sticky')).join('')||'<div class="empty">No sticky fields configured.</div>';fields.sticky.forEach(f=>{const el=$(`sticky_${f.id}`);if(el)el.addEventListener('change',saveStickyFromDom)})}
function collectFieldValues(group,prefix){const defs=fields[group];const out={};defs.forEach(f=>{const el=$(`${prefix}_${f.id}`);if(el)out[f.id]=el.value});return out}
function renderVariableFields(containerId,values={},prefix='variable'){$(containerId).innerHTML=fields.variable.map(f=>fieldInputHtml(f,values[f.id]??(f.systemKey==='clickedBy'?session.member?.id:''),prefix)).join('')||'<div class="empty">No variable fields configured.</div>'}
function captureStickyValues(){return collectFieldValues('sticky','captureSticky')}
function saveCaptureStickyValues(){const values=captureStickyValues();localStorage.setItem(stickyKey(),JSON.stringify(values));return values}
function areCaptureStickyFieldsComplete(){if(!fields.sticky.length)return true;return fields.sticky.every(f=>{const el=$(`captureSticky_${f.id}`);return !!String(el?.value??'').trim()})}
function updateGuidedCaptureFlow(scrollWhenRevealed=false){if(!pendingRecord||!$('detailStep2'))return;const complete=areCaptureStickyFieldsComplete();const hint=$('stickyCompletionHint');if(complete){saveCaptureStickyValues();if(hint)hint.textContent=fields.sticky.length?'✓ Sticky Fields complete. Variable Fields are now available below.':'No Sticky Fields are configured. Variable Fields are available below.';const wasHidden=$('detailStep2').classList.contains('hidden');$('detailStep2').classList.remove('hidden');if(wasHidden&&scrollWhenRevealed)requestAnimationFrame(()=>$('detailStep2').scrollIntoView({behavior:'smooth',block:'start'}))}else{const missing=fields.sticky.filter(f=>!String($(`captureSticky_${f.id}`)?.value??'').trim()).map(f=>f.label);if(hint)hint.textContent=`Complete Sticky Fields to continue: ${missing.join(', ')}`;$('detailStep2').classList.add('hidden')}}
function renderCaptureStickyFields(overrides={}){const c=$('captureStickyFieldsContainer');if(!c)return;const vals={...loadSticky(),...overrides};c.innerHTML=fields.sticky.map(f=>fieldInputHtml(f,vals[f.id]??fieldDefaultValue(f),'captureSticky')).join('')||'<div class="empty">No sticky fields configured.</div>';fields.sticky.forEach(f=>{const el=$(`captureSticky_${f.id}`);if(!el)return;el.addEventListener('input',()=>updateGuidedCaptureFlow(true));el.addEventListener('change',()=>updateGuidedCaptureFlow(true))});updateGuidedCaptureFlow(false)}
function fieldLabelById(id){return [...fields.sticky,...fields.variable].find(f=>String(f.id)===String(id))?.label||id}

async function refreshFields(){if(!session?.member)return;try{const d=await apiJson('/fields');fields={sticky:d.sticky||[],variable:d.variable||[],allFields:d.allFields||[...(d.sticky||[]),...(d.variable||[])],schemaVersion:Number(d.schemaVersion||1)};await cacheSet('fields',fields);if(!$('mastersView').classList.contains('hidden'))renderMasters()}catch(e){const cached=await cacheGet('fields');if(cached)fields={sticky:cached.sticky||[],variable:cached.variable||[],allFields:cached.allFields||[...(cached.sticky||[]),...(cached.variable||[])],schemaVersion:Number(cached.schemaVersion||1)};else if(navigator.onLine)console.error(e);if(!$('mastersView').classList.contains('hidden'))renderMasters()}}
async function refreshExportColumns(){if(!session?.member)return;try{const d=await apiJson('/export-columns');exportColumns=d.columns||[];await cacheSet('exportColumns',exportColumns);if(!$('mastersView').classList.contains('hidden'))renderMasters()}catch(e){const cached=await cacheGet('exportColumns');if(cached)exportColumns=cached;else if(navigator.onLine)console.error(e)}}
function renderMasters(){const render=(list,group,target)=>{$(target).innerHTML=list.map(f=>`<div class="master-item"><div><strong>${escapeHtml(f.label)}</strong><small>${escapeHtml(f.type)} · schema ${Number(f.createdSchemaVersion||1)}${f.options?.length?` · ${escapeHtml(f.options.join(', '))}`:''}${f.systemKey?` · default: ${escapeHtml(f.systemKey)}`:''}</small></div><div class="master-actions">${hasPermission('masters.edit')?`<button class="secondary mini-btn" data-field-edit="${f.id}" data-field-group="${group}">Edit</button><button class="danger mini-btn" data-field-delete="${f.id}" data-field-group="${group}">Deactivate</button>`:''}</div></div>`).join('')||'<div class="empty">No fields configured.</div>'};render(fields.sticky,'sticky','stickyMasterList');render(fields.variable,'variable','variableMasterList');const ec=$('exportColumnMasterList');if(ec){ec.innerHTML=exportColumns.map(c=>`<div class="master-item"><div><strong>${escapeHtml(c.label)}</strong><small>${escapeHtml(c.key)}${c.locked?' · locked':''} · ${c.active?'Active':'Inactive for current schema'}</small></div><div class="master-actions">${c.locked?'<span class="pill">Required</span>':hasPermission('masters.edit')?`<button class="${c.active?'danger':'secondary'} mini-btn" data-export-column-toggle="${escapeHtml(c.key)}">${c.active?'Deactivate':'Activate'}</button>`:''}</div></div>`).join('')||'<div class="empty">No export columns configured.</div>'}document.querySelectorAll('[data-field-edit]').forEach(b=>b.onclick=()=>openFieldModal(b.dataset.fieldGroup,b.dataset.fieldEdit));document.querySelectorAll('[data-field-delete]').forEach(b=>b.onclick=()=>deleteField(b.dataset.fieldGroup,b.dataset.fieldDelete));document.querySelectorAll('[data-export-column-toggle]').forEach(b=>b.onclick=()=>toggleExportColumn(b.dataset.exportColumnToggle))}
async function toggleExportColumn(key){const col=exportColumns.find(c=>c.key===key);if(!col||col.locked)return;try{await apiJson(`/export-columns/${encodeURIComponent(key)}`,{method:'PUT',body:JSON.stringify({active:!col.active})});await Promise.all([refreshExportColumns(),refreshFields()]);renderMasters();toast(`${col.label} ${col.active?'deactivated':'activated'} for the current schema. Historical export columns remain preserved.`,4200)}catch(e){toast(e.message,4200)}}
$('addStickyFieldBtn').onclick=()=>openFieldModal('sticky');$('addVariableFieldBtn').onclick=()=>openFieldModal('variable');$('fieldType').onchange=()=>$('fieldOptionsWrap').classList.toggle('hidden',$('fieldType').value!=='select');
function openFieldModal(group,id=null){editingFieldGroup=group;editingField=id?fields[group].find(f=>String(f.id)===String(id)):null;$('fieldModalTitle').textContent=`${editingField?'Edit':'Add'} ${group==='sticky'?'Sticky':'Variable'} Field`;$('fieldLabel').value=editingField?.label||'';$('fieldType').value=editingField?.type||'text';$('fieldOptions').value=(editingField?.options||[]).join(', ');$('fieldOptionsWrap').classList.toggle('hidden',$('fieldType').value!=='select');$('fieldModal').classList.remove('hidden')}
$('saveFieldBtn').onclick=async()=>{const payload={group:editingFieldGroup,label:$('fieldLabel').value.trim(),type:$('fieldType').value,options:$('fieldType').value==='select'?$('fieldOptions').value.split(',').map(x=>x.trim()).filter(Boolean):[]};if(!payload.label){toast('Field label is required.');return}try{if(editingField)await apiJson(`/fields/${editingField.id}`,{method:'PUT',body:JSON.stringify(payload)});else await apiJson('/fields',{method:'POST',body:JSON.stringify(payload)});$('fieldModal').classList.add('hidden');await refreshFields();renderMasters();renderStickyFields();toast('Field master updated. Historical field versions remain preserved.')}catch(e){toast(e.message,4200)}};
async function deleteField(group,id){const f=fields[group].find(x=>String(x.id)===String(id));if(!confirm(`Delete field "${f?.label||id}"? Existing historical values remain stored but the field will no longer appear.`))return;try{await apiJson(`/fields/${id}`,{method:'DELETE'});await refreshFields();renderMasters();renderStickyFields();toast('Field deactivated. Its historical Excel column is preserved.')}catch(e){toast(e.message,4200)}}

// ---------- GPS (2.0: iOS-friendly automatic warm-up, always optional) ----------
let gpsWarmup = { startedAt: 0, best: null, watchId: null, promise: null, finish: null };

function gpsFromPosition(p){
  return {
    latitude:Number(p.coords.latitude).toFixed(7),
    longitude:Number(p.coords.longitude).toFixed(7),
    accuracy:Math.round(Number(p.coords.accuracy)||0),
    error:''
  };
}
function betterGps(a,b){
  if(!a)return b;
  if(!b)return a;
  const aa=Number(a.accuracy||999999),ba=Number(b.accuracy||999999);
  return ba<aa?b:a;
}
function stopGpsWatch(){
  if(gpsWarmup.watchId!==null&&navigator.geolocation){try{navigator.geolocation.clearWatch(gpsWarmup.watchId)}catch{}}
  gpsWarmup.watchId=null;
}
function primeGpsCapture(){
  if(!navigator.geolocation){gpsWarmup={startedAt:Date.now(),best:null,watchId:null,promise:Promise.resolve({latitude:'',longitude:'',accuracy:'',error:'Geolocation is not supported on this device.'}),finish:null};return gpsWarmup.promise}
  if(gpsWarmup.promise&&Date.now()-gpsWarmup.startedAt<30000)return gpsWarmup.promise;
  stopGpsWatch();
  gpsWarmup.startedAt=Date.now();gpsWarmup.best=null;
  gpsWarmup.promise=new Promise(resolve=>{
    let finished=false;
    const finish=(fallback='GPS unavailable')=>{
      if(finished)return;finished=true;stopGpsWatch();
      resolve(gpsWarmup.best||{latitude:'',longitude:'',accuracy:'',error:fallback});
    };
    gpsWarmup.finish=finish;
    const success=p=>{
      gpsWarmup.best=betterGps(gpsWarmup.best,gpsFromPosition(p));
      // A reasonably accurate fix is enough; otherwise keep watching for a better iPhone fix.
      if(Number(gpsWarmup.best.accuracy||9999)<=35)finish('');
    };
    const error=e=>{if(e?.code===1)finish('Location permission was denied. GPS is optional.');};
    try{
      gpsWarmup.watchId=navigator.geolocation.watchPosition(success,error,{enableHighAccuracy:true,maximumAge:0,timeout:20000});
      navigator.geolocation.getCurrentPosition(success,()=>{}, {enableHighAccuracy:true,maximumAge:0,timeout:12000});
      // Safari/iPhone can occasionally stall on high-accuracy. Ask for a network-assisted fix too.
      setTimeout(()=>{if(!finished)navigator.geolocation.getCurrentPosition(success,()=>{}, {enableHighAccuracy:false,maximumAge:0,timeout:9000})},4500);
      setTimeout(()=>finish('Location could not be determined. GPS is optional.'),22000);
    }catch(e){finish(e?.message||'GPS unavailable');}
  });
  return gpsWarmup.promise;
}

async function getCurrentGps(){
  const recent=Date.now()-gpsWarmup.startedAt<30000;
  if(recent&&gpsWarmup.promise)return gpsWarmup.promise;
  return primeGpsCapture();
}

async function captureGpsForPendingRecord(captureToken){
  if(!pendingRecord||pendingRecord.captureToken!==captureToken)return {latitude:'',longitude:'',accuracy:'',error:'Verification is no longer active.'};
  $('gpsNote').textContent='Detecting GPS automatically… On iPhone, allow location when Safari asks. You may continue without it.';
  const gps=await getCurrentGps();
  if(!pendingRecord||pendingRecord.captureToken!==captureToken)return gps;
  pendingRecord.gps=gps;
  if(!$('latitude').value.trim())$('latitude').value=gps.latitude||'';
  if(!$('longitude').value.trim())$('longitude').value=gps.longitude||'';
  if(!$('gpsAccuracy').value.trim())$('gpsAccuracy').value=gps.accuracy||'';
  $('gpsNote').textContent=gps.error
    ? `GPS not captured: ${gps.error} You can still save because location is optional.`
    : `GPS detected automatically with approximately ${gps.accuracy} m accuracy. Latitude / Longitude / Accuracy remain optional and editable.`;
  return gps;
}

function currentGpsFromForm(){return {latitude:$('latitude').value.trim(),longitude:$('longitude').value.trim(),accuracy:$('gpsAccuracy').value.trim()}}

// ---------- Image / asset rows ----------
function assetDefault(){return {rowId:uid(),assetName:'',quantity:1,condition:'Good',verificationStatus:'Found',notFoundReason:'',serialNumber:'',barcode:''}}
function statusClass(s){return s==='Found'?'found':s==='Not Found'?'notfound':'pending'}
function assetRowHtml(a={},edit=false){const p=edit?'e-':'';return `<div class="asset-row" data-row="${escapeHtml(a.rowId||uid())}"><div class="grid two"><label>Asset Name *<input class="${p}asset-name" value="${escapeHtml(a.assetName||a.name||'')}"></label><label>Quantity<input class="${p}qty" type="number" min="1" value="${Number(a.quantity)||1}"></label><label>Condition<select class="${p}condition">${CONDITIONS.map(x=>`<option ${x===a.condition?'selected':''}>${x}</option>`).join('')}</select></label><label>Found Status<select class="${p}status">${STATUSES.map(x=>`<option ${x===a.verificationStatus?'selected':''}>${x}</option>`).join('')}</select></label><label class="reason-wrap">Not Found Reason<select class="${p}reason">${NOT_FOUND_REASONS.map(x=>`<option ${x===a.notFoundReason?'selected':''}>${x}</option>`).join('')}</select></label><label>Serial Number<input class="${p}serial" value="${escapeHtml(a.serialNumber||'')}"></label><label>Barcode / QR / Asset Tag<input class="${p}barcode" value="${escapeHtml(a.barcode||'')}"></label></div><button type="button" class="remove-asset danger mini-btn">Remove</button></div>`}
function wireAssetRows(container){container.querySelectorAll('.remove-asset').forEach(b=>b.onclick=()=>b.closest('.asset-row').remove());container.querySelectorAll('select[class$="status"]').forEach(s=>{const sync=()=>{const w=s.closest('.asset-row').querySelector('.reason-wrap');w.classList.toggle('hidden',s.value!=='Not Found')};s.addEventListener('change',sync);sync()})}
function renderAssetRows(list,edit=false){const c=$(edit?'editAssetRows':'assetRows');c.innerHTML=(list?.length?list:[assetDefault()]).map(a=>assetRowHtml(a,edit)).join('');wireAssetRows(c)}
function collectAssetRows(edit=false){const p=edit?'e-':'';return [...$(edit?'editAssetRows':'assetRows').querySelectorAll('.asset-row')].map(r=>({rowId:r.dataset.row||uid(),assetName:r.querySelector(`.${p}asset-name`).value.trim(),quantity:Math.max(1,Number(r.querySelector(`.${p}qty`).value)||1),condition:r.querySelector(`.${p}condition`).value,verificationStatus:r.querySelector(`.${p}status`).value,notFoundReason:r.querySelector(`.${p}reason`).value,serialNumber:r.querySelector(`.${p}serial`).value.trim(),barcode:r.querySelector(`.${p}barcode`).value.trim()})).filter(a=>a.assetName)}
async function fileToDataUrl(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file)})}
function blobToDataUrl(blob){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(blob)})}
async function decodePhotoSource(file){
  // Avoid turning the original camera photo into a huge base64 string before
  // compression. This materially lowers memory pressure on iPhone/Android.
  if(typeof createImageBitmap==='function'){
    try{
      const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
      return {image:bitmap,width:bitmap.width,height:bitmap.height,cleanup:()=>{try{bitmap.close?.()}catch{}}};
    }catch{}
  }
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('This image format could not be decoded on this device.'));i.src=url});
    return {image:img,width:img.naturalWidth||img.width,height:img.naturalHeight||img.height,cleanup:()=>URL.revokeObjectURL(url)};
  }catch(e){URL.revokeObjectURL(url);throw e}
}
function dataUrlToBlobLocal(dataUrl){
  try{
    const parts=String(dataUrl||'').split(',');
    if(parts.length!==2)return null;
    const mime=(parts[0].match(/^data:([^;]+);base64$/i)||[])[1]||'image/jpeg';
    const binary=atob(parts[1]),bytes=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
    return new Blob([bytes],{type:mime});
  }catch{return null}
}
async function canvasToJpegBlobLocal(canvas,quality){
  let blob=null;
  if(typeof canvas?.toBlob==='function'){
    try{
      blob=await Promise.race([
        new Promise(resolve=>{try{canvas.toBlob(resolve,'image/jpeg',quality)}catch{resolve(null)}}),
        new Promise(resolve=>setTimeout(()=>resolve(null),1800))
      ]);
    }catch{}
  }
  if(blob)return blob;
  try{return dataUrlToBlobLocal(canvas.toDataURL('image/jpeg',quality))}catch{return null}
}
async function compressPhoto(file){
  const decoded=await decodePhotoSource(file);
  try{
    let w=Number(decoded.width||0),h=Number(decoded.height||0);
    if(!w||!h)throw new Error('Image dimensions are unavailable.');
    const maxDimension=1280,targetBytes=500*1024,minDimension=640;
    if(Math.max(w,h)>maxDimension){const scale=maxDimension/Math.max(w,h);w=Math.max(1,Math.round(w*scale));h=Math.max(1,Math.round(h*scale))}
    let quality=.78,blob=null;
    const canvas=document.createElement('canvas');
    const ctx=canvas.getContext('2d',{alpha:false});
    if(!ctx)throw new Error('Image compression is unavailable on this browser.');
    for(let pass=0;pass<9;pass++){
      canvas.width=w;canvas.height=h;
      ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(decoded.image,0,0,w,h);
      blob=await canvasToJpegBlobLocal(canvas,quality);
      if(!blob)throw new Error('Image compression failed.');
      if(blob.size<=targetBytes||Math.max(w,h)<=minDimension)break;
      if(quality>.54)quality-=.07;else{w=Math.max(1,Math.round(w*.86));h=Math.max(1,Math.round(h*.86));quality=.68}
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    const result={dataUrl:await blobToDataUrl(blob),size:blob.size,width:w,height:h,compressed:true};
    canvas.width=1;canvas.height=1;
    return result;
  }finally{try{decoded.cleanup?.()}catch{}}
}

function stickySnapshotText(sticky){return fields.sticky.map(f=>`${f.label}: ${sticky[f.id]||'—'}`).join(' · ')}
function setCaptureDateTime(iso){const d=new Date(iso);$('capturedDateInput').value=isoDateInput(d);$('capturedTimeInput').value=timeInput(d)}

let nativeCaptureBusy=false;
function releaseScannerForNativeCapture(){
  // Synchronous cleanup preserves the user's tap gesture, which is important
  // because iOS/Android may refuse to open a file/camera picker after an await.
  clearTimeout(scannerLoopTimer);scannerLoopTimer=null;
  scannerRunning=false;scannerScanBusy=false;scannerDetector=null;
  stopTracksSynchronously();
  if(scannerCanvas){try{scannerCanvas.width=1;scannerCanvas.height=1}catch{};scannerCanvas=null}
}
function openNativeCapture(input,{append=false}={}){
  if(nativeCaptureBusy||!input)return;
  nativeCaptureBusy=true;appendPhotoMode=append;
  releaseScannerForNativeCapture();
  // A rendered off-screen input is more reliable than display:none on iPhone.
  input.hidden=false;input.tabIndex=-1;input.setAttribute('aria-hidden','true');
  Object.assign(input.style,{position:'fixed',left:'-10000px',top:'0',width:'1px',height:'1px',opacity:'0.001',pointerEvents:'none',zIndex:'-1'});
  try{input.value=''}catch{}
  try{
    if(typeof input.showPicker==='function')input.showPicker();
    else input.click();
  }catch(error){
    try{input.click()}catch(second){nativeCaptureBusy=false;toast(`Camera could not open: ${second?.message||error?.message||'browser blocked the picker'}`,5000);return}
  }
  setTimeout(()=>{nativeCaptureBusy=false},1800);
}
$('takePhotoBtn').onclick=()=>{if(!hasPermission('verification.capture_photo'))return;openNativeCapture($('cameraInput'),{append:false})};
$('uploadPhotoBtn').onclick=()=>{if(!hasPermission('verification.upload_gallery'))return;openNativeCapture($('galleryInput'),{append:false})};
$('addCameraPhotoBtn').onclick=()=>openNativeCapture($('cameraInput'),{append:true});
$('addGalleryPhotosBtn').onclick=()=>openNativeCapture($('galleryInput'),{append:true});
$('cameraInput').onchange=async e=>{nativeCaptureBusy=false;const files=[...(e.target.files||[])];e.target.value='';if(!files.length)return;if(appendPhotoMode)await appendPendingPhotos(files,'camera');else await preparePhotos(files,'camera')};
$('galleryInput').onchange=async e=>{nativeCaptureBusy=false;const files=[...(e.target.files||[])];e.target.value='';if(!files.length)return;if(appendPhotoMode)await appendPendingPhotos(files,'gallery');else await preparePhotos(files,'gallery')};
$('cameraInput').addEventListener('cancel',()=>{nativeCaptureBusy=false});$('galleryInput').addEventListener('cancel',()=>{nativeCaptureBusy=false});window.addEventListener('focus',()=>setTimeout(()=>{nativeCaptureBusy=false},120));

async function compressFiles(files,source){const list=[...(files||[])].filter(Boolean).slice(0,12);const out=[];for(const file of list){const c=await compressPhoto(file);out.push({id:uid(),dataUrl:c.dataUrl,size:c.size,name:file.name||'photo.jpg',source})}return out}
function renderPendingPhotoPreview(){const photos=pendingRecord?.photos||[];const has=photos.length>0;$('photoPreviewArea').classList.toggle('hidden',!has);$('photoPreview').classList.toggle('hidden',!has);if(has)$('photoPreview').src=photos[0].dataUrl;$('photoThumbs').innerHTML=photos.map((p,i)=>`<div class="photo-thumb ${i===0?'active':''}"><img src="${p.dataUrl}" alt="Photo ${i+1}"><button type="button" data-remove-pending-photo="${p.id}" aria-label="Remove photo">✕</button><span>${i+1}</span></div>`).join('');document.querySelectorAll('[data-remove-pending-photo]').forEach(b=>b.onclick=()=>{if(!pendingRecord)return;pendingRecord.photos=pendingRecord.photos.filter(p=>String(p.id)!==String(b.dataset.removePendingPhoto));const first=pendingRecord.photos[0];pendingRecord.dataUrl=first?.dataUrl||null;pendingRecord.size=pendingRecord.photos.reduce((n,p)=>n+(p.size||0),0);pendingRecord.photoName=first?.name||'';renderPendingPhotoPreview()})}
function openPendingDetailStep1(){
  $('detailModal').classList.remove('hidden');
  requestAnimationFrame(()=>{
    const sheet=$('detailModal').querySelector('.modal-sheet');
    if(sheet)sheet.scrollTop=0;
  });
  updateGuidedCaptureFlow(false);
}

async function preparePhotos(files,source){
  if(!files?.length)return;
  toast(`Preparing ${files.length} photo${files.length===1?'':'s'}…`,3500);
  try{
    // Compress first. Do not block the next step on GPS or AI.
    const photos=await compressFiles(files,source);
    if(!photos.length)return;
    const d=new Date(),first=photos[0],captureToken=uid();
    pendingRecord={
      captureToken,
      photos,
      dataUrl:first.dataUrl,
      size:photos.reduce((n,p)=>n+p.size,0),
      source,
      capturedAt:d.toISOString(),
      photoName:first.name,
      scanCode:'',
      gps:{latitude:'',longitude:'',accuracy:'',error:'GPS detection is in progress…'}
    };
    $('detailTitle').textContent=photos.length>1?`Review ${photos.length} photos`:'Review captured photo';
    renderPendingPhotoPreview();
    $('scanOnlyPreview').classList.add('hidden');
    $('retryAiBtn').classList.remove('hidden');
    setCaptureDateTime(d);
    $('latitude').value='';
    $('longitude').value='';
    $('gpsAccuracy').value='';
    $('gpsNote').textContent='GPS detection started automatically. Latitude, Longitude and GPS Accuracy are optional; you can save even if location is unavailable.';
    renderCaptureStickyFields();
    renderVariableFields('variableFieldsContainer',{},'variable');
    renderAssetRows([assetDefault()]);
    $('aiStatus').textContent=`${photos.length} photo${photos.length===1?'':'s'} ready (${bytesLabel(pendingRecord.size)}). AI analysis is running in the background.`;
    openPendingDetailStep1();

    pendingRecord.gpsPromise=captureGpsForPendingRecord(captureToken);

    runAi();
  }catch(e){
    console.error(e);
    toast('Could not prepare photo(s). Please try again.',4200);
  }
}
async function appendPendingPhotos(files,source){appendPhotoMode=false;if(!pendingRecord||!files?.length)return;try{toast(`Adding ${files.length} photo${files.length===1?'':'s'}…`,3500);const extra=await compressFiles(files,source);pendingRecord.photos=[...(pendingRecord.photos||[]),...extra].slice(0,12);const first=pendingRecord.photos[0];pendingRecord.dataUrl=first?.dataUrl||null;pendingRecord.size=pendingRecord.photos.reduce((n,p)=>n+(p.size||0),0);pendingRecord.photoName=first?.name||'';renderPendingPhotoPreview();$('aiStatus').textContent=`${pendingRecord.photos.length} photos attached. Re-run AI if you want all images analysed.`}catch(e){toast('Could not add photo(s).',4200)}}
async function runAi(){const photos=(pendingRecord?.photos||[]).filter(p=>p.dataUrl);if(!photos.length)return;const seq=++aiSeq;$('retryAiBtn').disabled=true;if(!navigator.onLine){$('aiStatus').textContent='Offline mode: AI identification will be available after reconnecting. Enter assets manually.';$('retryAiBtn').disabled=false;return}try{const merged=new Map();for(let i=0;i<photos.length;i++){if(seq!==aiSeq||!pendingRecord)return;$('aiStatus').textContent=`AI analysing image ${i+1} of ${photos.length}…`;const d=await apiJson('/ai',{method:'POST',body:JSON.stringify({image:photos[i].dataUrl})});for(const x of d.assets||[]){const key=String(x.name||'').trim().toLowerCase();if(!key)continue;const prior=merged.get(key);if(!prior||Number(x.quantity||1)>Number(prior.quantity||1))merged.set(key,{name:x.name,quantity:x.quantity||1})}}if(seq!==aiSeq||!pendingRecord)return;const list=[...merged.values()].map(x=>({...assetDefault(),assetName:x.name||'',quantity:x.quantity||1}));if(list.length){renderAssetRows(list);$('aiStatus').textContent=`AI analysed ${photos.length} image${photos.length===1?'':'s'} and detected ${list.length} asset type${list.length===1?'':'s'}. Verify and edit if required.`}else $('aiStatus').textContent='AI found no clear fixed asset. Add manually.'}catch(e){console.error(e);$('aiStatus').textContent='AI could not identify reliably. Enter assets manually.'}finally{$('retryAiBtn').disabled=false}}
$('retryAiBtn').onclick=runAi;
$('addAssetRowBtn').onclick=()=>{$('assetRows').insertAdjacentHTML('beforeend',assetRowHtml(assetDefault()));wireAssetRows($('assetRows'))};
$('discardPhotoBtn').onclick=()=>{pendingRecord=null;appendPhotoMode=false;aiSeq++;$('detailModal').classList.add('hidden')};

function clickedByFromVariable(variable){const f=fields.variable.find(x=>x.systemKey==='clickedBy');return f&&variable[f.id]?variable[f.id]:session.member.id}
$('savePhotoBtn').onclick=async()=>{
  if(!pendingRecord||!hasPermission('verification.save'))return;
  if(pendingRecord.source==='scan'&&!(pendingRecord.photos||[]).length){toast('Cannot save a scanned tag without its evidence photo. Please scan again.',5000);return;}
  if(!areCaptureStickyFieldsComplete()){
    toast('Complete all Sticky Fields first. Variable Fields will then appear automatically.',4200);
    updateGuidedCaptureFlow(false);
    return;
  }

  // 2.0: GPS detection runs in the background and never blocks saving. Blank Latitude / Longitude / Accuracy are valid.

  const assets=collectAssetRows();
  if(!assets.length){
    toast('Enter at least one asset name.');
    return;
  }

  const sticky=saveCaptureStickyValues();
  const variable=collectFieldValues('variable','variable');
  const clientId=uid();
  const photos=(pendingRecord.photos||[]).map(p=>({
    dataUrl:p.dataUrl,
    name:p.name||'photo.jpg',
    source:p.source||pendingRecord.source,
    size:p.size||0
  }));

  const payload={
    clientId,
    photos,
    photo:photos[0]?.dataUrl||null,
    photoSize:photos.reduce((n,p)=>n+(p.size||0),0),
    photoName:photos[0]?.name||'',
    capturedAt:combineDateTime($('capturedDateInput').value,$('capturedTimeInput').value),
    source:pendingRecord.source,
    scanCode:pendingRecord.scanCode||'',
    latitude:$('latitude').value.trim(),
    longitude:$('longitude').value.trim(),
    gpsAccuracy:$('gpsAccuracy').value.trim(),
    sticky,
    variable,
    clickedByMemberId:clickedByFromVariable(variable),
    assets
  };

  try{
    if(!navigator.onLine)throw new TypeError('Offline');
    await apiJson('/records',{method:'POST',body:JSON.stringify(payload)});
    pendingRecord=null;
    $('detailModal').classList.add('hidden');
    await refreshRecords();
    toast('Verification saved. It is now included in Export Excel.',4200);
  }catch(e){
    if(isNetworkError(e)||!navigator.onLine){
      await queueOfflineAction('POST','/records',payload,buildOptimisticRecord(payload));
      pendingRecord=null;
      $('detailModal').classList.add('hidden');
      await refreshRecords();
      toast('Verification saved offline. It will sync automatically and then be available in Export Excel.',5000);
    }else{
      toast(e.message,4500);
    }
  }
};

// ---------- Scanner auto-fill helpers ----------
function normalizeScanKey(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'')}
function parseScanPayload(raw,meta){
  // V3: delegate to the GS1-aware parser in prs-scan.js. It understands GS1
  // element strings (GS1-128, GS1 DataMatrix, GS1 QR, GS1 DataBar) in addition
  // to JSON / URL / key=value, and returns the same {raw,data,structured}
  // shape this file already consumes. The original parser stays below as a
  // fallback if prs-scan.js has not loaded.
  if(window.PRSScan&&typeof window.PRSScan.payloadToData==='function'){
    try{
      const out=window.PRSScan.payloadToData(raw,meta||scanMetaByCode[String(raw||'').trim()]||{},{conditions:CONDITIONS,statuses:STATUSES});
      if(out&&out.data)return out;
    }catch(error){console.debug('V3 payload parse fell back:',error)}
  }
  const text=String(raw||'').trim();
  if(!text)return {raw:text,data:{},structured:false};
  try{const parsed=JSON.parse(text);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))return {raw:text,data:parsed,structured:true}}catch{}
  try{
    const u=new URL(text);
    const data={};u.searchParams.forEach((v,k)=>data[k]=v);
    if(Object.keys(data).length)return {raw:text,data,structured:true};
  }catch{}
  const data={};
  for(const line of text.split(/[\n\r;]+/)){
    const m=line.match(/^\s*([^:=]+?)\s*[:=]\s*(.+?)\s*$/);
    if(m)data[m[1].trim()]=m[2].trim();
  }
  if(Object.keys(data).length)return {raw:text,data,structured:true};
  return {raw:text,data:{barcode:text},structured:false};
}
function scanValue(obj,keys){for(const key of keys){const target=normalizeScanKey(key);for(const [k,v] of Object.entries(obj||{})){if(normalizeScanKey(k)===target&&v!==undefined&&v!==null)return String(v)}}return ''}
function scanPayloadToAsset(parsed){
  const d=parsed.data||{};
  const assetName=scanValue(d,['assetName','asset','name','item','itemName','description']);
  const qty=Math.max(1,Number(scanValue(d,['quantity','qty','count']))||1);
  const condition=scanValue(d,['condition']);
  const status=scanValue(d,['verificationStatus','status','foundStatus']);
  const reason=scanValue(d,['notFoundReason','reason']);
  const serial=scanValue(d,['serialNumber','serial','srNo','serialNo']);
  const barcode=scanValue(d,['barcode','qr','qrCode','assetTag','tag','code','id'])||(!parsed.structured?parsed.raw:'');
  return {...assetDefault(),assetName,quantity:qty,condition:CONDITIONS.includes(condition)?condition:'Good',verificationStatus:STATUSES.includes(status)?status:'Found',notFoundReason:NOT_FOUND_REASONS.includes(reason)?reason:'',serialNumber:serial,barcode};
}
function scanDynamicValues(parsedList){
  const sticky={},variable={};
  const defs=[...(fields.sticky||[]),...(fields.variable||[])];
  const aliases=new Map();
  for(const f of defs){
    for(const key of [f.id,f.label,f.systemKey])if(key)aliases.set(normalizeScanKey(key),f);
  }
  for(const parsed of parsedList){
    for(const [key,value] of Object.entries(parsed.data||{})){
      const f=aliases.get(normalizeScanKey(key));
      if(!f)continue;
      const target=f.group==='variable'||fields.variable.some(x=>String(x.id)===String(f.id))?variable:sticky;
      target[f.id]=String(value??'');
    }
  }
  return {sticky,variable};
}

// ---------- Scan & Verify ----------
// 2.0.11 MOBILE SCANNER ENGINE
// iPhone/iPad deliberately uses the native iOS camera capture UI instead of a
// getUserMedia live stream. This is far more reliable in Safari/PWA mode and
// still preserves the captured photo as verification evidence. Android/desktop
// keep the live BarcodeDetector scanner when available.
function renderScanCodes(){
  const manual=$('manualScanCode').value.trim();
  const all=[...new Set([...scanCodes,...(manual?[manual]:[])])];
  $('scanDetectedList').innerHTML=all.length
    ?all.map(c=>`<span class="scan-code-chip">${escapeHtml(c)}${scanCodes.includes(c)?`<button type="button" data-remove-scan="${escapeHtml(c)}">✕</button>`:''}</span>`).join('')
    :'<span class="muted">No codes captured yet.</span>';
  document.querySelectorAll('[data-remove-scan]').forEach(b=>b.onclick=()=>{
    scanCodes=scanCodes.filter(c=>c!==b.dataset.removeScan);
    renderScanCodes();
  });
}

function isIOSDevice(){
  return /iPhone|iPad|iPod/i.test(navigator.userAgent||'') ||
    (navigator.platform==='MacIntel' && Number(navigator.maxTouchPoints||0)>1);
}

function cameraErrorMessage(error){
  const name=String(error?.name||'');
  const message=String(error?.message||'');
  if(name==='NotAllowedError'||name==='PermissionDeniedError'){
    return isIOSDevice()
      ?'Camera permission is blocked. In Safari open Website Settings for this site, set Camera to Allow, reload, and try again.'
      :'Camera permission is blocked. Allow Camera for this website in Chrome site settings, then try again.';
  }
  if(name==='NotFoundError'||name==='DevicesNotFoundError')return 'No usable camera was found on this device.';
  if(name==='NotReadableError'||name==='TrackStartError'||name==='AbortError')return 'The camera is busy. Close other camera apps/tabs, wait a few seconds, then try again.';
  if(name==='OverconstrainedError'||name==='ConstraintNotSatisfiedError')return 'Rear camera mode was not accepted by the browser.';
  if(name==='SecurityError')return 'The browser blocked camera access. Open PRS2 using its HTTPS GitHub Pages address.';
  return message||name||'Unknown camera error';
}

function makePickerRenderable(input){
  if(!input)return;
  input.hidden=false;
  input.tabIndex=-1;
  input.setAttribute('aria-hidden','true');
  Object.assign(input.style,{
    position:'fixed',left:'-10000px',top:'0',width:'1px',height:'1px',
    opacity:'0.001',pointerEvents:'none',zIndex:'-1'
  });
}

function invokePickerNow(input){
  if(!input)throw new Error('Camera input is unavailable.');
  makePickerRenderable(input);
  try{input.value=''}catch{}
  let firstError=null;
  if(typeof input.showPicker==='function'){
    try{input.showPicker();return}catch(error){firstError=error}
  }
  try{input.click();return}catch(error){throw firstError||error}
}

$('scanVerifyBtn').onclick=()=>openScanner();
$('closeScannerBtn').onclick=closeScanner;
$('startScannerBtn').onclick=startScanner;
$('manualScanCode').addEventListener('input',renderScanCodes);
$('barcodeTypeSelect').addEventListener('change',async()=>{
  if(window.PRSScan&&scannerRunning){await stopScanner({preserveStatus:true});await startScanner()}
});
$('barcodeTypeSelect')?.addEventListener('change',()=>{if(!$('scannerModal').classList.contains('hidden'))$('scanStatus').textContent=`${patch14Cfg().label} selected. Capture the complete symbol; partial reads will not be accepted.`});

function loadImageElement(file){
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file);
    const img=new Image();
    img.onload=()=>resolve({img,url});
    img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('Image could not be opened'))};
    img.src=url;
  });
}

let scannerEngineLoadPromise=null;
let scannerEngineSource='';
let zxingEngineLoadPromise=null;
let quaggaEngineLoadPromise=null;
let jsBarcodeEngineLoadPromise=null;
let sythosEngineLoadPromise=null;
const barcodeEngineState={zxing:'idle',quagga:'idle',sythos:'idle',js:'idle',legacy:'idle',special:'ready'};
function barcodeEngineSummary(){return `Engines — ZXing: ${barcodeEngineState.zxing}; Quagga2: ${barcodeEngineState.quagga}; Extended 1D: ${barcodeEngineState.sythos}; JS fallback: ${barcodeEngineState.js}; Special marks: ${barcodeEngineState.special}`;}

// V2 PATCH 13 — EXTENDED LINEAR CODE DECODER
// Patch 10's reliable iPhone native-camera flow remains unchanged. Patch 13
// extends Patch 12's barcode-first decoder without weakening Code 128. It adds
// dedicated passes for Code 11, MSI, Telepen Alpha, Code 39 Full ASCII and the
// 2-of-5 family, plus conservative image decoders for Pharmacode Two-Track and
// fixed 9-position Flattermarken.
//
// Primary engine: ZXing-C++ WASM (all linear formats, original photo first).
// Secondary engine: Quagga2 (specialised 1D locator/decoder on prepared images).
// Tertiary engine: browser BarcodeDetector / ZBar fallback.
// Final linear fallback: javascript-barcode-reader (incl. MSI).
//
// Important for 1D symbols: prepared passes NEVER crop the left/right edges of
// the image. Quiet zones on both sides of a barcode are part of the symbol and
// cutting them is a common reason QR succeeds while Code128/EAN/UPC fails.
const ZXING_WASM_VERSION='3.1.3';
const ZXING_IIFE_URLS=[
  `https://cdn.jsdelivr.net/npm/zxing-wasm@${ZXING_WASM_VERSION}/dist/iife/reader/index.js`,
  `https://unpkg.com/zxing-wasm@${ZXING_WASM_VERSION}/dist/iife/reader/index.js`
];
const QUAGGA_VERSION='1.12.1';
const QUAGGA_URLS=[
  `https://cdn.jsdelivr.net/npm/@ericblade/quagga2@${QUAGGA_VERSION}/dist/quagga.min.js`,
  `https://unpkg.com/@ericblade/quagga2@${QUAGGA_VERSION}/dist/quagga.min.js`
];
const JS_BARCODE_READER_URLS=[
  'https://cdn.jsdelivr.net/npm/javascript-barcode-reader@1.0.0/dist/javascript-barcode-reader.umd.min.js',
  'https://unpkg.com/javascript-barcode-reader@1.0.0/dist/javascript-barcode-reader.umd.min.js',
  'https://unpkg.com/javascript-barcode-reader@1.0.0'
];
const SYTHOS_VERSION='1.6.3';
const SYTHOS_ESM_URLS=[
  `https://cdn.jsdelivr.net/npm/@sythos/js_barcode_universal@${SYTHOS_VERSION}/+esm`,
  `https://esm.sh/@sythos/js_barcode_universal@${SYTHOS_VERSION}`
];
const SYTHOS_LINEAR_FORMAT_GROUPS=[
  ['code11'],
  ['msi'],
  ['telepen'],
  ['code39'],
  ['code93'],
  ['code128','gs1-128'],
  ['itf','itf14'],
  ['code-25','code2of5','standard-2-of-5','industrial-2-of-5','iata-2-of-5'],
  ['codabar']
];
const ZXING_LINEAR_FORMATS=['AllLinear'];
const ZXING_EXTENDED_LINEAR_FORMATS=['Code39Ext','Code39Std','Telepen','Code128','Code93','ITF','Codabar','EAN13','EAN8','UPCA','UPCE','DataBar'];
const QUAGGA_ALL_READERS=[
  'code_128_reader','code_39_reader','code_93_reader','codabar_reader',
  'ean_reader','ean_8_reader','upc_reader','upc_e_reader',
  'i2of5_reader','2of5_reader','code_32_reader','pharmacode_reader'
];
const QUAGGA_GROUPS=[
  ['code_128_reader','code_39_reader','code_93_reader','codabar_reader'],
  ['ean_reader','ean_8_reader','upc_reader','upc_e_reader'],
  ['i2of5_reader','2of5_reader','code_32_reader','pharmacode_reader']
];
const JS_BARCODE_TYPES=[
  ['code-128','Code128'],['code-39','Code39'],['code-93','Code93'],
  ['ean-13','EAN13'],['upc-a','UPCA'],['ean-8','EAN8'],['upc-e','UPCE'],
  ['code-2of5','ITF','interleaved'],['code-2of5','Code2of5','industrial'],['codabar','Codabar'],['msi','MSI'],['pharmacode','Pharmacode']
];

function scannerPolyfillClass(){
  return window.__prsBarcodeDetectorPolyfill || window.barcodeDetectorPolyfill?.BarcodeDetectorPolyfill || null;
}

function nativeScannerClass(){
  return typeof window.BarcodeDetector === 'function' ? window.BarcodeDetector : null;
}

function scannerScriptLoaded(url){
  return [...document.scripts].some(s=>s.src===url && s.dataset.prsScannerLoaded==='1');
}

function loadScannerScript(url,timeoutMs=20000){
  return new Promise((resolve,reject)=>{
    if(scannerScriptLoaded(url)){resolve();return}
    const existing=[...document.scripts].find(s=>s.src===url);
    if(existing){
      if(existing.dataset.prsScannerLoaded==='1'){resolve();return}
      if(existing.dataset.prsScannerFailed==='1'){try{existing.remove()}catch{}}
      else{
        const timer=setTimeout(()=>reject(new Error(`Scanner dependency timed out: ${url}`)),timeoutMs);
        existing.addEventListener('load',()=>{clearTimeout(timer);existing.dataset.prsScannerLoaded='1';resolve()},{once:true});
        existing.addEventListener('error',()=>{clearTimeout(timer);existing.dataset.prsScannerFailed='1';reject(new Error(`Scanner dependency failed: ${url}`))},{once:true});
        return;
      }
    }
    const script=document.createElement('script');
    script.src=url;script.async=true;script.crossOrigin='anonymous';script.dataset.prsScannerRuntime='1';
    const timer=setTimeout(()=>{
      script.dataset.prsScannerFailed='1';
      try{script.remove()}catch{}
      reject(new Error(`Scanner dependency timed out: ${url}`));
    },timeoutMs);
    script.onload=()=>{clearTimeout(timer);script.dataset.prsScannerLoaded='1';resolve()};
    script.onerror=()=>{clearTimeout(timer);script.dataset.prsScannerFailed='1';try{script.remove()}catch{};reject(new Error(`Scanner dependency failed: ${url}`))};
    document.head.appendChild(script);
  });
}

async function ensureZXingWasmEngine(){
  if(window.ZXingWASM?.readBarcodes){barcodeEngineState.zxing='ready';return window.ZXingWASM;}
  if(zxingEngineLoadPromise)return zxingEngineLoadPromise;
  zxingEngineLoadPromise=(async()=>{
    let lastError=null;
    for(const url of ZXING_IIFE_URLS){
      try{
        await loadScannerScript(url,24000);
        if(window.ZXingWASM?.readBarcodes){barcodeEngineState.zxing='ready';return window.ZXingWASM;}
        throw new Error('ZXingWASM did not expose readBarcodes');
      }catch(error){lastError=error;barcodeEngineState.zxing='failed';console.warn('ZXing barcode engine load failed:',url,error)}
    }
    throw lastError||new Error('ZXing-C++ barcode engine could not load');
  })();
  try{return await zxingEngineLoadPromise}
  finally{if(!window.ZXingWASM?.readBarcodes)zxingEngineLoadPromise=null}
}

async function ensureQuaggaEngine(){
  if(window.Quagga?.decodeSingle){barcodeEngineState.quagga='ready';return window.Quagga;}
  if(quaggaEngineLoadPromise)return quaggaEngineLoadPromise;
  quaggaEngineLoadPromise=(async()=>{
    let lastError=null;
    for(const url of QUAGGA_URLS){
      try{
        await loadScannerScript(url,24000);
        if(window.Quagga?.decodeSingle){barcodeEngineState.quagga='ready';return window.Quagga;}
        throw new Error('Quagga did not expose decodeSingle');
      }catch(error){lastError=error;barcodeEngineState.quagga='failed';console.warn('Quagga2 barcode engine load failed:',url,error)}
    }
    throw lastError||new Error('Quagga2 barcode engine could not load');
  })();
  try{return await quaggaEngineLoadPromise}
  finally{if(!window.Quagga?.decodeSingle)quaggaEngineLoadPromise=null}
}

async function ensureJSBarcodeEngine(){
  if(typeof window.javascriptBarcodeReader==='function'){barcodeEngineState.js='ready';return window.javascriptBarcodeReader;}
  if(jsBarcodeEngineLoadPromise)return jsBarcodeEngineLoadPromise;
  jsBarcodeEngineLoadPromise=(async()=>{
    let lastError=null;
    for(const url of JS_BARCODE_READER_URLS){
      try{
        await loadScannerScript(url,18000);
        if(typeof window.javascriptBarcodeReader==='function'){barcodeEngineState.js='ready';return window.javascriptBarcodeReader;}
      }catch(error){lastError=error;barcodeEngineState.js='failed';console.warn('JS barcode fallback load failed:',url,error)}
    }
    throw lastError||new Error('Javascript barcode reader unavailable');
  })();
  try{return await jsBarcodeEngineLoadPromise}
  finally{if(typeof window.javascriptBarcodeReader!=='function')jsBarcodeEngineLoadPromise=null}
}

async function ensureSythosEngine(){
  if(window.__prsSythosBarcode?.decode){barcodeEngineState.sythos='ready';return window.__prsSythosBarcode;}
  if(sythosEngineLoadPromise)return sythosEngineLoadPromise;
  sythosEngineLoadPromise=(async()=>{
    let lastError=null;
    for(const url of SYTHOS_ESM_URLS){
      try{
        const mod=await import(url);
        if(typeof mod?.decode==='function'){window.__prsSythosBarcode=mod;barcodeEngineState.sythos='ready';return mod;}
        throw new Error('Extended 1D module did not expose decode()');
      }catch(error){lastError=error;barcodeEngineState.sythos='failed';console.warn('Extended linear barcode engine load failed:',url,error)}
    }
    throw lastError||new Error('Extended linear barcode engine unavailable');
  })();
  try{return await sythosEngineLoadPromise}
  finally{if(!window.__prsSythosBarcode?.decode)sythosEngineLoadPromise=null}
}

async function detectSythosLinear(source){
  let engine;
  try{engine=await ensureSythosEngine()}catch{return []}
  const image=sourceImageData(source,2800);
  if(!image)return [];
  const out=[];
  for(const formats of SYTHOS_LINEAR_FORMAT_GROUPS){
    try{
      const hits=engine.decode(image,{formats,tryHarder:true})||[];
      for(const hit of hits){
        const value=String(hit?.text??hit?.rawValue??'').trim();
        const format=String(hit?.format||formats[0]||'');
        if(value&&barcodeCandidateValid(value,format)&&!out.some(x=>x.rawValue===value)){
          out.push({rawValue:value,text:value,format,symbology:format,confidence:Number(hit?.confidence||0)});
        }
      }
      if(out.length)return out;
    }catch(error){console.debug('Extended 1D decode pass failed:',formats.join(','),error)}
  }
  return out;
}

function sourceImageData(source,maxSide=2600){
  if(typeof ImageData!=='undefined'&&source instanceof ImageData)return source;
  if(source?.data instanceof Uint8ClampedArray&&source?.width&&source?.height)return source;
  if(typeof HTMLCanvasElement!=='undefined'&&source instanceof HTMLCanvasElement){
    const ctx=source.getContext('2d',{willReadFrequently:true});
    try{return ctx?.getImageData(0,0,source.width,source.height)||null}catch{return null}
  }
  const sw=Number(source?.videoWidth||source?.naturalWidth||source?.width||0);
  const sh=Number(source?.videoHeight||source?.naturalHeight||source?.height||0);
  if(!sw||!sh)return null;
  const scale=Math.min(1,maxSide/Math.max(sw,sh));
  const w=Math.max(1,Math.round(sw*scale)),h=Math.max(1,Math.round(sh*scale));
  const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
  const ctx=canvas.getContext('2d',{willReadFrequently:true,alpha:false});
  if(!ctx)return null;
  ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(source,0,0,w,h);
  try{return ctx.getImageData(0,0,w,h)}catch{return null}
}

async function zxingInputFromSource(source){
  if(typeof Blob!=='undefined'&&source instanceof Blob)return source;
  if(source instanceof ArrayBuffer||source instanceof Uint8Array)return source;
  return sourceImageData(source,3000);
}

function normalizeZXingResults(results){
  return (results||[]).filter(r=>r?.isValid!==false).map(r=>({
    rawValue:String(r?.text??r?.rawValue??'').trim(),
    text:String(r?.text??r?.rawValue??'').trim(),
    format:String(r?.format||''),symbology:String(r?.symbology||''),isValid:r?.isValid!==false
  })).filter(r=>r.rawValue);
}

function eanUpcChecksumValid(value){
  const s=String(value||'');
  if(!/^\d+$/.test(s)||![8,12,13].includes(s.length))return true;
  const digits=[...s].map(Number),check=digits.pop();
  let sum=0,weight=3;
  for(let i=digits.length-1;i>=0;i--){sum+=digits[i]*weight;weight=weight===3?1:3}
  return (10-(sum%10))%10===check;
}

function barcodeCandidateValid(value,format=''){
  const text=String(value??'').trim();
  if(!text||text.length<2||text.length>400)return false;
  const f=String(format||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  if(f.includes('ean13')||f==='ean')return /^\d{13}$/.test(text)&&eanUpcChecksumValid(text);
  if(f.includes('ean8'))return /^\d{8}$/.test(text)&&eanUpcChecksumValid(text);
  if(f.includes('upca')||f==='upc')return /^\d{12}$/.test(text)&&eanUpcChecksumValid(text);
  if(f.includes('upce'))return /^\d{6,8}$/.test(text);
  if(f.includes('itf')||f.includes('2of5'))return /^\d{4,}$/.test(text);
  if(f.includes('code11'))return /^[0-9-]{1,140}$/.test(text);
  if(f.includes('msi'))return /^\d{3,}$/.test(text);
  if(f.includes('pharmacode2')){const n=Number(text);return /^\d+$/.test(text)&&n>=4&&n<=64570080;}
  if(f.includes('pharmacode')){const n=Number(text);return /^\d+$/.test(text)&&n>=3&&n<=131070;}
  if(f.includes('flattermarken'))return /^\d{9}$/.test(text);
  if(f.includes('telepen'))return text.length>0&&text.length<=500;
  return true;
}

async function createZXingBarcodeDetector(){
  const engine=await ensureZXingWasmEngine();
  scannerEngineSource=`ZXing-C++ linear ${ZXING_WASM_VERSION}`;
  return {
    async detect(source){
      const input=await zxingInputFromSource(source);
      if(!input)return [];
      const profiles=[
        {formats:ZXING_LINEAR_FORMATS,tryHarder:true,tryRotate:true,tryInvert:true,tryDownscale:true,tryDenoise:true,minLineCount:1,maxNumberOfSymbols:16,validateOptionalChecksum:false,textMode:'HRI'},
        // Keep every narrow module at source resolution. This protects Code 128,
        // Code 11-like narrow patterns and small industrial labels from merging.
        {formats:ZXING_LINEAR_FORMATS,tryHarder:true,tryRotate:true,tryInvert:true,tryDownscale:false,tryDenoise:false,minLineCount:1,maxNumberOfSymbols:16,validateOptionalChecksum:false,textMode:'HRI'},
        // Explicit extended pass. Newer ZXing-C++ distinguishes Code39Ext from
        // Code39Std; Telepen is also explicitly selected here. If a particular
        // runtime rejects one of these names this pass fails harmlessly and the
        // AllLinear passes above remain active.
        {formats:ZXING_EXTENDED_LINEAR_FORMATS,tryHarder:true,tryRotate:true,tryInvert:true,tryDownscale:false,minLineCount:1,maxNumberOfSymbols:16,validateOptionalChecksum:false,textMode:'HRI',tryCode39ExtendedMode:true}
      ];
      let firstError=null;
      for(const options of profiles){
        try{
          const results=normalizeZXingResults(await engine.readBarcodes(input,options));
          const valid=results.filter(r=>barcodeCandidateValid(r.rawValue,r.format));
          if(valid.length)return valid;
        }catch(error){if(!firstError)firstError=error;console.debug('ZXing linear pass failed:',error)}
      }
      if(firstError)throw firstError;
      return [];
    }
  };
}

async function loadScannerPair(base,label){
  const zbar=`${base}/@undecaf/zbar-wasm@0.9.15/dist/index.js`;
  const poly=`${base}/@undecaf/barcode-detector-polyfill@0.9.23/dist/index.js`;
  await loadScannerScript(zbar);
  await loadScannerScript(poly);
  const Polyfill=scannerPolyfillClass();
  if(!Polyfill)throw new Error(`${label} loaded but did not expose BarcodeDetectorPolyfill`);
  scannerEngineSource=label;
  return Polyfill;
}

async function ensureScannerFallbackEngine(){
  if(scannerPolyfillClass())return scannerPolyfillClass();
  if(scannerEngineLoadPromise)return scannerEngineLoadPromise;
  scannerEngineLoadPromise=(async()=>{
    const attempts=[['https://cdn.jsdelivr.net/npm','jsDelivr ZBar'],['https://unpkg.com','unpkg ZBar']];
    for(const [base,label] of attempts){
      try{return await loadScannerPair(base,label)}catch(error){console.warn(`Scanner ${label} load failed`,error)}
    }
    throw new Error('Fallback barcode recognition could not load.');
  })();
  try{return await scannerEngineLoadPromise}
  finally{if(!scannerPolyfillClass())scannerEngineLoadPromise=null}
}

async function createLegacyDetector(){
  // Keep QR / matrix formats here as a final compatibility fallback so Patch 12
  // improves barcodes without taking away the QR capability that already worked.
  const requested=['aztec','code_128','code_39','code_93','codabar','data_matrix','ean_13','ean_8','itf','pdf417','qr_code','upc_a','upc_e'];
  const Native=nativeScannerClass();
  if(Native){
    try{
      let supported=requested;
      if(typeof Native.getSupportedFormats==='function'){try{supported=await Native.getSupportedFormats()}catch{}}
      const usable=requested.filter(f=>!Array.isArray(supported)||supported.includes(f));
      try{return new Native(usable.length?{formats:usable}:undefined)}catch{return new Native()}
    }catch(error){console.warn('Native BarcodeDetector could not be initialised.',error)}
  }
  const Polyfill=scannerPolyfillClass() || await ensureScannerFallbackEngine();
  let supported=requested;
  if(typeof Polyfill.getSupportedFormats==='function'){try{supported=await Polyfill.getSupportedFormats()}catch{}}
  const usable=requested.filter(f=>!Array.isArray(supported)||supported.includes(f));
  try{return new Polyfill(usable.length?{formats:usable}:undefined)}catch{return new Polyfill()}
}

function quaggaResultValue(result){
  const value=String(result?.codeResult?.code||'').trim();
  const format=String(result?.codeResult?.format||'');
  if(!barcodeCandidateValid(value,format))return null;
  return value?{rawValue:value,text:value,format,symbology:format}:null;
}

async function quaggaDecodeDataUrl(src,readers=QUAGGA_ALL_READERS,{locate=true,patchSize='large',timeoutMs=10000}={}){
  const Quagga=await ensureQuaggaEngine();
  return new Promise(resolve=>{
    let settled=false;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value)};
    const timer=setTimeout(()=>finish(null),timeoutMs);
    try{
      Quagga.decodeSingle({
        src,
        numOfWorkers:0,
        locate,
        inputStream:{size:0,singleChannel:false},
        locator:{halfSample:false,patchSize,willReadFrequently:true},
        decoder:{readers,multiple:false}
      },result=>finish(quaggaResultValue(result)));
    }catch(error){console.debug('Quagga decode pass failed:',error);finish(null)}
  });
}

async function detectJSBarcodeReader(source){
  let reader;
  try{reader=await ensureJSBarcodeEngine()}catch{return []}
  const image=sourceImageData(source,2400);
  if(!image)return [];
  for(const [type,format,barcodeType] of JS_BARCODE_TYPES){
    try{
      const options={useAdaptiveThreshold:true,detectRotation:true,locateBarcode:true,singlePass:false};
      const args={image,barcode:type,options};
      if(type==='code-2of5')args.barcodeType=barcodeType||'interleaved';
      const result=await reader(args);
      const value=String(result?.text??result?.code??result?.value??result??'').trim();
      if(value&&barcodeCandidateValid(value,format))return [{rawValue:value,text:value,format,symbology:format}];
    }catch{}
  }
  return [];
}

async function createScannerDetector(){
  let primary=null,legacy=null,legacyAttempted=false;
  try{primary=await createZXingBarcodeDetector()}catch(error){console.warn('ZXing linear engine unavailable; fallback will be used.',error)}
  const getLegacy=async()=>{
    if(legacyAttempted)return legacy;
    legacyAttempted=true;
    try{legacy=await createLegacyDetector()}catch(error){console.warn('Legacy barcode engine unavailable.',error);legacy=null}
    return legacy;
  };
  if(!primary)await getLegacy();
  if(!primary&&!legacy)throw new Error('Barcode recognition could not initialise. Check internet once and retry.');
  return {
    async detect(source){
      let results=[];
      if(primary){try{results=await primary.detect(source)}catch(error){console.debug('ZXing barcode pass failed:',error)}}
      if(results?.length)return results;
      // Extended 1D pass adds Code 11, MSI and Telepen Alpha without changing the
      // successful Code 128 path. It runs only after ZXing returns no result.
      try{results=await detectSythosLinear(source)}catch(error){console.debug('Extended 1D fallback pass failed:',error)}
      if(results?.length)return results;
      let fallbackSource=source,bitmap=null;
      if(typeof Blob!=='undefined'&&source instanceof Blob&&typeof createImageBitmap==='function'){
        try{bitmap=await createImageBitmap(source,{imageOrientation:'from-image'});fallbackSource=bitmap}catch{}
      }
      try{
        const fallback=await getLegacy();
        if(fallback){try{results=await fallback.detect(fallbackSource)}catch(error){console.debug('BarcodeDetector fallback pass failed:',error)}}
        if(results?.length)return results;
        return await detectJSBarcodeReader(fallbackSource);
      }finally{try{bitmap?.close?.()}catch{}}
    }
  };
}

function scanRawValue(item){
  return String(item?.rawValue ?? item?.raw_value ?? item?.text ?? '').trim();
}

function scannerResultsValues(results){
  const out=[];
  for(const result of results||[]){
    const value=scanRawValue(result);
    if(value&&barcodeCandidateValid(value,result?.format||result?.symbology||'')&&!out.includes(value))out.push(value);
  }
  return out;
}

async function detectWithDetector(detector,source){
  if(!detector)return [];
  const results=await detector.detect(source);
  return scannerResultsValues(results);
}

async function detectWithScannerDetector(source){
  const values=await detectWithDetector(scannerDetector,source);
  return values[0]||'';
}

function applyOtsuThreshold(canvas){
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  if(!ctx)return canvas;
  let image;
  try{image=ctx.getImageData(0,0,canvas.width,canvas.height)}catch{return canvas}
  const data=image.data,hist=new Uint32Array(256);
  for(let i=0;i<data.length;i+=4){
    const y=Math.max(0,Math.min(255,Math.round(.299*data[i]+.587*data[i+1]+.114*data[i+2])));hist[y]++;
  }
  const total=canvas.width*canvas.height;
  let sum=0;for(let i=0;i<256;i++)sum+=i*hist[i];
  let sumB=0,wB=0,maxVar=-1,threshold=128;
  for(let t=0;t<256;t++){
    wB+=hist[t];if(!wB)continue;
    const wF=total-wB;if(!wF)break;
    sumB+=t*hist[t];
    const mB=sumB/wB,mF=(sum-sumB)/wF,d=mB-mF,v=wB*wF*d*d;
    if(v>maxVar){maxVar=v;threshold=t}
  }
  for(let i=0;i<data.length;i+=4){
    const y=.299*data[i]+.587*data[i+1]+.114*data[i+2];const v=y<threshold?0:255;
    data[i]=data[i+1]=data[i+2]=v;data[i+3]=255;
  }
  ctx.putImageData(image,0,0);return canvas;
}

function makeBarcodeVariantCanvas(img,{band=1,center=.5,rotate=0,contrast=1,threshold=false,maxSide=2800}={}){
  const iw=Number(img.naturalWidth||img.width||0),ih=Number(img.naturalHeight||img.height||0);
  if(!iw||!ih)return null;
  const safeBand=Math.max(.25,Math.min(1,Number(band)||1));
  const sh=Math.max(1,Math.round(ih*safeBand));
  const sy=Math.max(0,Math.min(ih-sh,Math.round((ih-sh)*Math.max(0,Math.min(1,Number(center)||.5)))));
  // Deliberately preserve the FULL source width. Do not cut barcode quiet zones.
  const sw=iw,sx=0;
  const rot=Math.abs(Number(rotate)||0)%180===90;
  const baseW=rot?sh:sw,baseH=rot?sw:sh;
  let scale=Math.min(maxSide/Math.max(baseW,baseH),1.55);
  if(Math.max(baseW,baseH)>=maxSide)scale=Math.min(scale,1);
  const contentW=Math.max(1,Math.round(baseW*scale)),contentH=Math.max(1,Math.round(baseH*scale));
  const pad=Math.max(24,Math.round(Math.min(contentW,contentH)*.025));
  const canvas=document.createElement('canvas');canvas.width=contentW+pad*2;canvas.height=contentH+pad*2;
  const ctx=canvas.getContext('2d',{willReadFrequently:true,alpha:false});
  if(!ctx)return null;
  ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.save();
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  ctx.filter=contrast!==1?`grayscale(1) contrast(${contrast})`:'none';
  if(rot){
    ctx.translate(pad+contentW/2,pad+contentH/2);
    ctx.rotate((Number(rotate)>0?1:-1)*Math.PI/2);
    ctx.drawImage(img,sx,sy,sw,sh,-contentH/2,-contentW/2,contentH,contentW);
  }else{
    ctx.drawImage(img,sx,sy,sw,sh,pad,pad,contentW,contentH);
  }
  ctx.restore();
  if(threshold)applyOtsuThreshold(canvas);
  return canvas;
}

function barcodeVariantDescriptors(){
  return [
    {name:'full',band:1,center:.5,contrast:1,maxSide:3000},
    {name:'centre-wide',band:.72,center:.5,contrast:1,maxSide:3000},
    {name:'centre-tight',band:.46,center:.5,contrast:1,maxSide:3000},
    {name:'upper-band',band:.58,center:.18,contrast:1.25,maxSide:2800},
    {name:'lower-band',band:.58,center:.82,contrast:1.25,maxSide:2800},
    {name:'contrast',band:.62,center:.5,contrast:1.65,maxSide:2600},
    {name:'threshold',band:.58,center:.5,contrast:1.15,threshold:true,maxSide:2200},
    {name:'rotated',band:1,center:.5,rotate:90,contrast:1.2,maxSide:2800},
    {name:'rotated-band',band:.64,center:.5,rotate:90,contrast:1.45,maxSide:2400}
  ];
}

async function canvasDataUrl(canvas){
  try{return canvas.toDataURL('image/png')}catch{return canvas.toDataURL('image/jpeg',.96)}
}

// ---- Patch 13 specialised linear marks ------------------------------------
// These two formats do not have dependable open browser-camera support in the
// engines above, so they use conservative geometry decoders. They return a value
// only when the image strongly matches the requested mark grammar; otherwise they
// deliberately return no result rather than inventing an asset number.
function otsuBinaryFromSource(source,maxSide=2200){
  const image=sourceImageData(source,maxSide);if(!image)return null;
  const {width:w,height:h,data}=image,hist=new Uint32Array(256),gray=new Uint8Array(w*h);
  let sum=0;
  for(let p=0,i=0;i<data.length;i+=4,p++){
    const y=Math.max(0,Math.min(255,Math.round(.299*data[i]+.587*data[i+1]+.114*data[i+2])));gray[p]=y;hist[y]++;sum+=y;
  }
  const total=w*h;let sumB=0,wB=0,maxVar=-1,t=128;
  for(let x=0;x<256;x++){wB+=hist[x];if(!wB)continue;const wF=total-wB;if(!wF)break;sumB+=x*hist[x];const mb=sumB/wB,mf=(sum-sumB)/wF,d=mb-mf,v=wB*wF*d*d;if(v>maxVar){maxVar=v;t=x}}
  const bin=new Uint8Array(w*h);for(let i=0;i<gray.length;i++)bin[i]=gray[i]<t?1:0;
  return {width:w,height:h,bin,threshold:t};
}
function rowInkProfile(b){const a=new Float32Array(b.height);for(let y=0;y<b.height;y++){let n=0,o=y*b.width;for(let x=0;x<b.width;x++)n+=b.bin[o+x];a[y]=n/b.width}return a}
function strongestBarcodeBand(b){
  const p=rowInkProfile(b),sm=new Float32Array(p.length);for(let y=0;y<p.length;y++){let s=0,n=0;for(let k=-2;k<=2;k++){const yy=y+k;if(yy>=0&&yy<p.length){s+=p[yy];n++}}sm[y]=s/n}
  const peak=Math.max(...sm);if(peak<.015)return null;const cut=Math.max(.012,peak*.28);let best=null,start=-1;
  for(let y=0;y<=sm.length;y++){const on=y<sm.length&&sm[y]>=cut;if(on&&start<0)start=y;if((!on||y===sm.length)&&start>=0){const end=y-1,len=end-start+1;if(!best||len>best.len)best={start,end,len};start=-1}}
  if(!best||best.len<Math.max(12,b.height*.05))return null;const pad=Math.round(best.len*.12);return {y0:Math.max(0,best.start-pad),y1:Math.min(b.height-1,best.end+pad)};
}
function verticalRunsForBand(b,band,minOccupancy=.34){
  const h=band.y1-band.y0+1,profile=new Float32Array(b.width);
  for(let x=0;x<b.width;x++){let n=0;for(let y=band.y0;y<=band.y1;y++)n+=b.bin[y*b.width+x];profile[x]=n/h}
  const runs=[];let s=-1;for(let x=0;x<=b.width;x++){const on=x<b.width&&profile[x]>=minOccupancy;if(on&&s<0)s=x;if((!on||x===b.width)&&s>=0){const e=x-1;if(e-s+1>=1)runs.push({x0:s,x1:e,w:e-s+1,c:(s+e)/2});s=-1}}
  // Merge tiny anti-alias gaps inside one printed bar.
  const merged=[];for(const r of runs){const last=merged[merged.length-1];if(last&&r.x0-last.x1<=2){last.x1=r.x1;last.w=last.x1-last.x0+1;last.c=(last.x0+last.x1)/2}else merged.push({...r})}return merged;
}
function median(nums){if(!nums.length)return 0;const a=[...nums].sort((x,y)=>x-y);const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
function cv(nums){if(nums.length<2)return 0;const m=nums.reduce((a,b)=>a+b,0)/nums.length;if(!m)return 99;const v=nums.reduce((a,b)=>a+(b-m)*(b-m),0)/nums.length;return Math.sqrt(v)/m}

function detectPharmacodeTwoTrack(source){
  const b=otsuBinaryFromSource(source,2200);if(!b)return [];
  const band=strongestBarcodeBand(b);if(!band)return [];
  const runs=verticalRunsForBand(b,band,.26).filter(r=>r.w>=2);
  if(runs.length<2||runs.length>16)return [];
  if(cv(runs.map(r=>r.w))>.48)return [];
  const bandH=band.y1-band.y0+1,mid=(band.y0+band.y1)/2;
  const digits=[];let classScore=0;
  for(const r of runs){
    const xa=Math.max(r.x0,Math.round(r.c-r.w*.25)),xb=Math.min(r.x1,Math.round(r.c+r.w*.25));
    let top=0,topN=0,bot=0,botN=0;
    const topEnd=Math.floor(mid-bandH*.08),botStart=Math.ceil(mid+bandH*.08);
    for(let y=band.y0;y<=topEnd;y++)for(let x=xa;x<=xb;x++){top+=b.bin[y*b.width+x];topN++}
    for(let y=botStart;y<=band.y1;y++)for(let x=xa;x<=xb;x++){bot+=b.bin[y*b.width+x];botN++}
    const tr=topN?top/topN:0,br=botN?bot/botN:0;let d=0,score=0;
    if(tr>.48&&br>.48){d=3;score=Math.min(tr,br)}
    else if(tr>.52&&br<.28){d=2;score=(tr+(1-br))/2}
    else if(br>.52&&tr<.28){d=1;score=(br+(1-tr))/2}
    else return [];
    digits.push(d);classScore+=score;
  }
  classScore/=digits.length;
  const gaps=runs.slice(1).map((r,i)=>r.x0-runs[i].x1-1).filter(x=>x>0);if(gaps.length&&cv(gaps)>.72)return [];
  const value=digits.reduce((n,d)=>n*3+d,0);
  if(value<4||value>64570080||classScore<.70)return [];
  return [{rawValue:String(value),text:String(value),format:'PharmacodeTwoTrack',symbology:'Pharmacode Two-Track',confidence:classScore}];
}

function detectFlattermarken9(source){
  const b=otsuBinaryFromSource(source,2200);if(!b)return [];
  const band=strongestBarcodeBand(b);if(!band)return [];
  let runs=verticalRunsForBand(b,band,.42).filter(r=>r.w>=2);
  if(runs.length<1||runs.length>9)return [];
  const widths=runs.map(r=>r.w),m0=median(widths);if(m0<1||cv(widths)>.32)return [];
  // Flattermarken uses equal-width marks positioned in one of nine module slots
  // per digit. We fit observed mark centres to a 9 x 9 module lattice and only
  // accept a fit that explains every mark with one mark maximum per digit cell.
  let best=null;
  for(const mul of [.82,.88,.94,1,1.06,1.12,1.18]){
    const m=m0*mul;if(m<1)continue;
    for(const seed of runs){
      for(let j=0;j<81;j++){
        const off=seed.c-j*m;const digits=new Array(9).fill(0),used=new Set();let err=0,ok=true;
        for(const r of runs){
          const q=(r.c-off)/m,ji=Math.round(q),res=Math.abs(q-ji);
          if(ji<0||ji>80||res>.34){ok=false;break}
          const cell=Math.floor(ji/9),pos=ji%9+1;if(used.has(cell)){ok=false;break}used.add(cell);digits[cell]=pos;err+=res;
        }
        if(!ok)continue;
        const left=off-.5*m,right=off+80.5*m;
        if(left<-b.width*.08||right>b.width*1.08)continue;
        const span=right-left;if(span<b.width*.18||span>b.width*1.05)continue;
        const score=1-err/Math.max(1,runs.length);
        // Prefer a lattice whose field centre is near the photographed mark field.
        const barCenter=(runs[0].c+runs[runs.length-1].c)/2,fieldCenter=(left+right)/2;
        const centerPenalty=Math.min(.25,Math.abs(fieldCenter-barCenter)/Math.max(span,1));
        const final=score-centerPenalty;
        if(!best||final>best.score)best={digits,score:final,m,left,right};
      }
    }
  }
  if(!best||best.score<.68)return [];
  const text=best.digits.join('');
  return [{rawValue:text,text,format:'Flattermarken',symbology:'Flattermarken',confidence:best.score}];
}

function detectSpecialLinearMarks(source){
  const out=[];
  for(const hit of detectPharmacodeTwoTrack(source))out.push(hit);
  // Avoid interpreting a proven two-track Pharmacode as Flattermarken.
  if(!out.length)for(const hit of detectFlattermarken9(source))out.push(hit);
  return out;
}

async function detectCodesFromImageFile(file){
  const found=[];
  const push=(value,format='')=>{
    const v=String(value||'').trim();
    if(v&&barcodeCandidateValid(v,format)&&!found.includes(v))found.push(v);
  };

  // Warm independent engines in parallel. Failure of one engine never blocks the others.
  const [zxingResult,quaggaResult,sythosResult]=await Promise.allSettled([createZXingBarcodeDetector(),ensureQuaggaEngine(),ensureSythosEngine()]);
  const zxing=zxingResult.status==='fulfilled'?zxingResult.value:null;
  const quaggaReady=quaggaResult.status==='fulfilled';
  const sythosReady=sythosResult.status==='fulfilled';

  // 1) Always try the ORIGINAL iPhone/Android photo first. ZXing receives the
  // encoded file at full resolution, preserving every narrow bar and quiet zone.
  if(zxing){
    try{
      const results=await zxing.detect(file);
      for(const r of results||[])push(scanRawValue(r),r?.format||'');
      if(found.length)return found;
    }catch(error){console.debug('Original barcode photo ZXing pass failed:',error)}
  }
  if(sythosReady){
    try{
      const results=await detectSythosLinear(file);
      for(const r of results||[])push(scanRawValue(r),r?.format||'');
      if(found.length)return found;
    }catch(error){console.debug('Original photo extended-linear pass failed:',error)}
  }

  let item=null,legacy=null;
  try{
    item=await loadImageElement(file);
    const descriptors=barcodeVariantDescriptors();
    for(let i=0;i<descriptors.length&&!found.length;i++){
      const desc=descriptors[i];
      if($('scanStatus')&&!$('scannerModal').classList.contains('hidden')){
        $('scanStatus').textContent=`Reading barcode… pass ${i+1} of ${descriptors.length}. Keep the complete left/right margins of the barcode visible.`;
      }
      const canvas=makeBarcodeVariantCanvas(item.img,desc);
      if(!canvas)continue;
      try{
        // 2) Quagga2 is specialised for 1D barcode localisation and is the first
        // decoder on prepared horizontal-band images.
        if(quaggaReady){
          const src=await canvasDataUrl(canvas);
          let qr=await quaggaDecodeDataUrl(src,QUAGGA_ALL_READERS,{locate:true,patchSize:i<3?'large':'x-large',timeoutMs:9000});
          if(!qr&&i===2){
            // A locator can occasionally miss a barcode that already fills the
            // centre band; targeted no-locator passes read scan lines directly.
            for(const group of QUAGGA_GROUPS){
              qr=await quaggaDecodeDataUrl(src,group,{locate:false,patchSize:'large',timeoutMs:6000});
              if(qr)break;
            }
          }
          if(qr)push(qr.rawValue,qr.format);
        }
        if(found.length)return found;

        // 3) ZXing again on each lossless/preprocessed pass. This covers DataBar,
        // GS1-128, ITF-14 and other linear formats not handled by Quagga.
        if(zxing){
          try{
            const results=await zxing.detect(canvas);
            for(const r of results||[])push(scanRawValue(r),r?.format||'');
          }catch(error){console.debug('Prepared barcode ZXing pass failed:',error)}
        }
        if(found.length)return found;

        // 4) Extended linear engine — targeted Code 11 / MSI / Telepen / Code39
        // Full ASCII and 2-of-5 variants. Run on the strongest prepared passes.
        if(sythosReady&&(i<=2||desc.threshold||desc.rotate)){
          try{
            const results=await detectSythosLinear(canvas);
            for(const r of results||[])push(scanRawValue(r),r?.format||'');
          }catch(error){console.debug('Prepared extended-linear pass failed:',error)}
        }
        if(found.length)return found;

        // 5) Conservative geometry decoders for Pharmacode Two-Track and
        // Flattermarken. These run late so they never steal a valid standard code.
        if(i===0||i===1||desc.threshold){
          try{
            const results=detectSpecialLinearMarks(canvas);
            for(const r of results||[])push(scanRawValue(r),r?.format||'');
          }catch(error){console.debug('Special linear-mark pass failed:',error)}
        }
        if(found.length)return found;

        // 6) Browser BarcodeDetector/ZBar fallback on the strongest centre passes.
        if(i<=2||desc.threshold){
          if(!legacy){try{legacy=await createLegacyDetector()}catch{legacy=null}}
          if(legacy){
            try{
              const results=await legacy.detect(canvas);
              for(const r of results||[])push(scanRawValue(r),r?.format||'');
            }catch{}
          }
        }
        if(found.length)return found;

        // 7) Pure-JS decoder fallback (MSI + one-track Pharmacode) on the centre/threshold pass.
        if(i===2||desc.threshold){
          const results=await detectJSBarcodeReader(canvas);
          for(const r of results||[])push(scanRawValue(r),r?.format||'');
          if(found.length)return found;
        }
      }finally{
        try{canvas.width=1;canvas.height=1}catch{}
      }
      await new Promise(resolve=>setTimeout(resolve,0));
    }

    // Final compatibility pass: preserve the QR/matrix behavior that worked before.
    if(!found.length){
      if(!legacy){try{legacy=await createLegacyDetector()}catch{legacy=null}}
      if(legacy){
        try{
          const results=await legacy.detect(item.img);
          for(const r of results||[])push(scanRawValue(r),r?.format||'');
        }catch{}
      }
    }
    return found;
  }finally{
    if(item?.url)try{URL.revokeObjectURL(item.url)}catch{}
  }
}


// ---------------------------------------------------------------------------
// V2 PATCH 15 — NATIVE CODE 11 DECODER
// ---------------------------------------------------------------------------
// Code 11 is deliberately decoded locally instead of depending on a generic
// browser barcode library. Each symbol has five alternating bar/space elements
// plus one narrow inter-character space. The shared start/stop pattern is 11221.
// We require BOTH start and stop and decode the complete payload in between.
const PRS_CODE11_PATTERNS={
  '0':[1,1,1,1,2], '1':[2,1,1,1,2], '2':[1,2,1,1,2], '3':[2,2,1,1,1],
  '4':[1,1,2,1,2], '5':[2,1,2,1,1], '6':[1,2,2,1,1], '7':[1,1,1,2,2],
  '8':[2,1,1,2,1], '9':[2,1,1,1,1], '-':[1,1,2,1,1], 'S':[1,1,2,2,1]
};
function prsCode11Otsu(values){
  const hist=new Uint32Array(256);let total=0,sum=0;
  for(const raw of values){const v=Math.max(0,Math.min(255,Math.round(raw)));hist[v]++;total++;sum+=v}
  if(!total)return 127;
  let sumB=0,wB=0,best=127,maxVar=-1;
  for(let t=0;t<256;t++){
    wB+=hist[t];if(!wB)continue;
    const wF=total-wB;if(!wF)break;
    sumB+=t*hist[t];const mB=sumB/wB,mF=(sum-sumB)/wF,d=mB-mF,v=wB*wF*d*d;
    if(v>maxVar){maxVar=v;best=t}
  }
  return best;
}
function prsCode11Runs(bits){
  if(!bits?.length)return [];
  const runs=[];let black=!!bits[0],width=1;
  for(let i=1;i<bits.length;i++){
    const b=!!bits[i];
    if(b===black)width++;
    else{runs.push({black,width});black=b;width=1}
  }
  runs.push({black,width});
  let changed=true;
  while(changed){
    changed=false;
    for(let i=1;i<runs.length-1;i++){
      if(runs[i].width<=1&&runs[i-1].black===runs[i+1].black){
        runs[i-1].width+=runs[i].width+runs[i+1].width;runs.splice(i,2);changed=true;break;
      }
    }
  }
  return runs;
}
function prsCode11Fit(widths,pattern){
  let nSum=0,nCount=0,wSum=0,wCount=0;
  for(let i=0;i<5;i++){
    if(pattern[i]===1){nSum+=widths[i];nCount++}else{wSum+=widths[i];wCount++}
  }
  if(!nCount||!wCount)return {score:999,narrow:0,wide:0};
  const narrow=nSum/nCount,wide=wSum/wCount,ratio=wide/Math.max(.001,narrow);
  if(ratio<1.42||ratio>5.2)return {score:999,narrow,wide};
  let err=0;
  for(let i=0;i<5;i++){
    const expected=pattern[i]===1?narrow:wide;
    const d=(widths[i]-expected)/Math.max(1,expected);err+=d*d;
  }
  return {score:Math.sqrt(err/5),narrow,wide};
}
function prsCode11Classify(widths){
  let best={score:999,char:'',narrow:0,wide:0};
  for(const [char,pattern] of Object.entries(PRS_CODE11_PATTERNS)){
    const fit=prsCode11Fit(widths,pattern);if(fit.score<best.score)best={...fit,char};
  }
  return best;
}
function prsCode11DecodeRuns(runs){
  const out=[];
  for(let start=0;start+11<runs.length;start++){
    if(!runs[start].black)continue;
    const first=runs.slice(start,start+5);
    if(first.length<5||first.some((r,i)=>r.black!==(i%2===0)))continue;
    const sf=prsCode11Classify(first.map(r=>r.width));
    if(sf.char!=='S'||sf.score>.31)continue;
    let j=start,totalScore=0,symbols=0,data=[],started=false,lastNarrow=sf.narrow;
    while(j+5<=runs.length){
      const five=runs.slice(j,j+5);
      if(five.some((r,i)=>r.black!==(i%2===0)))break;
      const fit=prsCode11Classify(five.map(r=>r.width));
      if(fit.score>.34)break;
      totalScore+=fit.score;symbols++;lastNarrow=fit.narrow;j+=5;
      if(fit.char==='S'){
        if(!started)started=true;
        else{
          const value=data.join('');
          if(value&&/^[0-9-]+$/.test(value)&&value.length<=80){
            const leftQuiet=start>0&&!runs[start-1].black?runs[start-1].width:0;
            const rightQuiet=j<runs.length&&!runs[j].black?runs[j].width:0;
            const quietScore=Math.min(leftQuiet,rightQuiet)/Math.max(1,lastNarrow);
            out.push({value,score:totalScore/Math.max(1,symbols),symbols,start,end:j,quietScore});
          }
          break;
        }
      }else{
        if(!started)break;data.push(fit.char);
      }
      if(j>=runs.length)break;
      const sep=runs[j];if(sep.black)break;
      if(sep.width>Math.max(fit.narrow*2.8,fit.narrow+6))break;
      j++;
    }
  }
  return out;
}
function prsCode11ScanImageData(image,selected=false){
  if(!image?.data||!image.width||!image.height)return [];
  const {data,width:w,height:h}=image,votes=new Map(),yCount=81,half=Math.max(1,Math.min(4,Math.round(h/900)));
  for(let yi=0;yi<yCount;yi++){
    const y=Math.max(0,Math.min(h-1,Math.round((.07+(.86*yi/(yCount-1)))*(h-1))));
    const profile=new Float32Array(w);
    for(let x=0;x<w;x++){
      let sum=0,n=0;
      for(let dy=-half;dy<=half;dy++){
        const yy=y+dy;if(yy<0||yy>=h)continue;
        const k=(yy*w+x)*4;sum+=.299*data[k]+.587*data[k+1]+.114*data[k+2];n++;
      }
      profile[x]=sum/Math.max(1,n);
    }
    const otsu=prsCode11Otsu(profile);
    for(const threshold of [otsu,Math.max(15,otsu-9),Math.min(240,otsu+9)]){
      const bits=new Uint8Array(w);for(let x=0;x<w;x++)bits[x]=profile[x]<threshold?1:0;
      for(const c of prsCode11DecodeRuns(prsCode11Runs(bits))){
        if(!selected&&c.quietScore>0&&c.quietScore<3.0)continue;
        let v=votes.get(c.value);
        if(!v){v={value:c.value,lines:new Set(),hits:0,bestScore:999,bestQuiet:0};votes.set(c.value,v)}
        v.lines.add(y);v.hits++;v.bestScore=Math.min(v.bestScore,c.score);v.bestQuiet=Math.max(v.bestQuiet,c.quietScore||0);
      }
    }
  }
  return [...votes.values()].map(v=>({...v,lineVotes:v.lines.size,confidence:Math.min(1,(v.lines.size/6)+Math.max(0,.30-v.bestScore))}))
    .filter(v=>selected?(v.lineVotes>=2||v.bestScore<=.17):(v.lineVotes>=3&&v.bestScore<=.27))
    .sort((a,b)=>b.lineVotes-a.lineVotes||a.bestScore-b.bestScore||b.value.length-a.value.length);
}
function prsDetectCode11Direct(source,{selected=false}={}){
  const image=sourceImageData(source,3200);if(!image)return [];
  return prsCode11ScanImageData(image,selected).map(x=>({rawValue:x.value,text:x.value,format:'code11',symbology:'Code 11',confidence:x.confidence,lineVotes:x.lineVotes,bestScore:x.bestScore,engine:'PRS native Code11'}));
}

// ---------------------------------------------------------------------------
// V2 PATCH 14 — STRICT FULL-LENGTH LINEAR BARCODE DECODER
// ---------------------------------------------------------------------------
// Patch 13 could accept the first plausible value from a permissive fallback.
// On a clipped 1D symbol that can be only the final 1–2 digits. Patch 14 changes
// that rule: mobile scanning uses a still photo and only accepts a complete,
// structurally validated result. Uncommon formats can be selected explicitly so
// a Code 11 / MSI / Telepen pattern is never guessed as another symbology.
let patch14LastDetection={mode:'auto',accepted:null,rejected:[],engines:[]};

const PATCH14_MODES={
  auto:{label:'Auto',zxing:['LinearCodes'],sythos:['code128','gs1128','code39','code93','itf','code11','msi','telepen'],min:3},
  code128:{label:'Code 128',zxing:['Code128'],sythos:['code128'],min:2},
  gs1128:{label:'GS1-128',zxing:['Code128'],sythos:['gs1128'],min:2},
  code11:{label:'Code 11',zxing:[],sythos:['code11'],min:2},
  itf:{label:'Interleaved 2 of 5',zxing:['ITF'],sythos:['itf'],min:4,numeric:true},
  code39:{label:'Code 39',zxing:['Code39'],sythos:['code39'],min:2},
  code39ext:{label:'Code 39 Full ASCII',zxing:['Code39'],sythos:['code39'],min:2,code39Extended:true},
  code93:{label:'Code 93',zxing:['Code93'],sythos:['code93'],min:2},
  msi:{label:'MSI Plessey',zxing:[],sythos:['msi'],min:3,numeric:true},
  telepen:{label:'Telepen Alpha',zxing:['Telepen'],sythos:['telepen'],min:2},
  pharmacode1:{label:'Pharmacode One-Track',zxing:[],sythos:[],min:1,numeric:true,special:'pharmacode1'},
  pharmacode2:{label:'Pharmacode Two-Track',zxing:[],sythos:[],min:1,numeric:true,special:'pharmacode2'},
  flattermarken:{label:'Flattermarken',zxing:[],sythos:[],min:9,numeric:true,special:'flattermarken'}
};

function patch14Mode(){
  const key=String($('barcodeTypeSelect')?.value||'auto');
  return PATCH14_MODES[key]?key:'auto';
}
function patch14Cfg(mode=patch14Mode()){return PATCH14_MODES[mode]||PATCH14_MODES.auto}
function isAndroidDevice(){return /Android/i.test(navigator.userAgent||'')}
function isMobileBarcodeDevice(){return isIOSDevice()||isAndroidDevice()}
function patch14CleanText(value){
  let s=String(value??'').replace(/\u0000/g,'').trim();
  // Preserve the GS1 separator semantically but make it visible/editable.
  s=s.replace(/\x1D/g,'<GS>');
  return s;
}
function patch14TextFromZXing(result){
  let text=patch14CleanText(result?.text??result?.rawValue??'');
  const bogus=!text||/^[?\uFFFD]+$/.test(text);
  const bytes=result?.bytes;
  if(bogus&&bytes&&typeof TextDecoder==='function'){
    try{
      const arr=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
      for(const enc of ['utf-8','windows-1252']){
        try{
          const candidate=patch14CleanText(new TextDecoder(enc,{fatal:enc==='utf-8'}).decode(arr));
          if(candidate&&!/^[?\uFFFD]+$/.test(candidate)){text=candidate;break}
        }catch{}
      }
    }catch{}
  }
  return text;
}
function patch14Family(format=''){
  const f=String(format||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  if(f.includes('gs1128'))return 'gs1128';
  if(f.includes('code128'))return 'code128';
  if(f.includes('code11'))return 'code11';
  if(f.includes('code39'))return 'code39';
  if(f.includes('code93'))return 'code93';
  if(f.includes('telepen'))return 'telepen';
  if(f.includes('itf')||f.includes('2of5'))return 'itf';
  if(f.includes('msi'))return 'msi';
  if(f.includes('pharmacode2'))return 'pharmacode2';
  if(f.includes('pharmacode'))return 'pharmacode1';
  if(f.includes('flatter'))return 'flattermarken';
  if(f.includes('ean13'))return 'ean13';
  if(f.includes('ean8'))return 'ean8';
  if(f.includes('upca'))return 'upca';
  if(f.includes('upce'))return 'upce';
  if(f.includes('databar'))return 'databar';
  if(f.includes('codabar'))return 'codabar';
  return f||'unknown';
}
function patch14Compatible(mode,family){
  if(mode==='auto')return ['code128','gs1128','code11','itf','code39','code93','msi','telepen','ean13','ean8','upca','upce','databar','codabar'].includes(family);
  if(mode==='code39ext')return family==='code39';
  if(mode==='gs1128')return family==='gs1128'||family==='code128';
  return mode===family;
}
function patch14CandidateValid(value,format='',mode=patch14Mode(),engine=''){
  const cfg=patch14Cfg(mode),text=patch14CleanText(value),family=patch14Family(format);
  if(!text||text.length>500)return false;
  if(/^[?\uFFFD]+$/.test(text))return false;
  if(text.includes('\uFFFD'))return false;
  if(!patch14Compatible(mode,family)&&family!=='unknown')return false;
  // Auto mode deliberately rejects very short reads. These are the exact
  // partial-suffix failures observed on Android and are not safe to auto-save.
  if(mode==='auto'&&text.length<3)return false;
  if(text.length<Number(cfg.min||1))return false;
  if(cfg.numeric&&!/^\d+$/.test(text))return false;
  if(family==='ean13'&&(!/^\d{13}$/.test(text)||!eanUpcChecksumValid(text)))return false;
  if(family==='ean8'&&(!/^\d{8}$/.test(text)||!eanUpcChecksumValid(text)))return false;
  if(family==='upca'&&(!/^\d{12}$/.test(text)||!eanUpcChecksumValid(text)))return false;
  if(family==='upce'&&!/^\d{6,8}$/.test(text))return false;
  if((family==='itf'||mode==='itf')&&!/^\d{4,}$/.test(text))return false;
  if((family==='msi'||mode==='msi')&&!/^\d{3,}$/.test(text))return false;
  if(mode==='flattermarken'&&!/^\d{9}$/.test(text))return false;
  if(mode==='pharmacode1'){
    const n=Number(text);if(!/^\d+$/.test(text)||n<3||n>131070)return false;
  }
  if(mode==='pharmacode2'){
    const n=Number(text);if(!/^\d+$/.test(text)||n<4||n>64570080)return false;
  }
  return true;
}
function patch14AddCandidate(list,{value,format='',engine='',confidence=0,pass='',strict=false,mode=patch14Mode()}){
  const text=patch14CleanText(value),family=patch14Family(format);
  if(!patch14CandidateValid(text,format,mode,engine)){
    patch14LastDetection.rejected.push({value:text.slice(0,80),format,family,engine,pass,reason:'validation'});
    return;
  }
  list.push({value:text,format,family,engine,confidence:Number(confidence||0),pass,strict,mode});
}
function patch14Choose(candidates,mode=patch14Mode()){
  if(!candidates.length)return null;
  const byValue=new Map();
  for(const c of candidates){
    const k=c.value;
    if(!byValue.has(k))byValue.set(k,{value:k,items:[],engines:new Set(),passes:new Set(),score:0});
    const g=byValue.get(k);g.items.push(c);g.engines.add(c.engine);g.passes.add(c.pass);
    let w=c.strict?5:2;
    if(c.engine==='ZXing-C++')w+=4;
    if(c.engine==='Sythos-camera')w+=4;
    if(c.engine==='Sythos-consensus')w+=3;
    if(c.engine==='Quagga-consensus')w+=2;
    w+=Math.min(2,Math.max(0,c.confidence||0)*2);
    g.score+=w;
  }
  const ranked=[...byValue.values()].sort((a,b)=>b.score-a.score||b.items.length-a.items.length||b.value.length-a.value.length);
  for(const g of ranked){
    const top=g.items[0];
    // A trusted structural decoder may stand alone. Permissive/custom fallbacks
    // must repeat the SAME full value on independent image passes.
    const trusted=g.items.some(x=>x.engine==='ZXing-C++'||x.engine==='Sythos-camera'||x.engine==='PRS-Code11');
    const consensus=g.passes.size>=2||g.engines.size>=2;
    if(trusted||consensus){
      const best=[...g.items].sort((a,b)=>(b.strict-a.strict)||(b.confidence-a.confidence))[0];
      return {...best,votes:g.items.length,score:g.score};
    }
  }
  return null;
}
async function patch14ZXing(source,mode,candidates,pass){
  const cfg=patch14Cfg(mode);if(!cfg.zxing?.length)return;
  let engine;try{engine=await ensureZXingWasmEngine()}catch{return}
  let input;try{input=await zxingInputFromSource(source)}catch{return}
  if(!input)return;
  const formatSets=[];
  if(mode==='auto')formatSets.push(['LinearCodes'],['AllLinear']);
  else formatSets.push(cfg.zxing);
  for(const formats of formatSets){
    const options={formats,tryHarder:true,tryRotate:true,tryInvert:true,tryDownscale:false,tryDenoise:false,minLineCount:2,maxNumberOfSymbols:8,validateOptionalChecksum:false,textMode:'Plain'};
    if(cfg.code39Extended)options.tryCode39ExtendedMode=true;
    try{
      const results=await engine.readBarcodes(input,options)||[];
      for(const r of results){
        if(r?.isValid===false)continue;
        const text=patch14TextFromZXing(r),format=String(r?.format||'');
        patch14AddCandidate(candidates,{value:text,format,engine:'ZXing-C++',confidence:1,pass,strict:true,mode});
      }
    }catch(error){console.debug('Patch14 ZXing pass failed',formats,error)}
    if(candidates.some(c=>c.engine==='ZXing-C++'&&c.pass===pass))break;
  }
}
async function patch14Sythos(source,mode,candidates,pass,{camera=true}={}){
  const cfg=patch14Cfg(mode);if(!cfg.sythos?.length)return;
  let engine;try{engine=await ensureSythosEngine()}catch{return}
  const image=sourceImageData(source,3000);if(!image)return;
  const options={formats:cfg.sythos,tryHarder:true};
  if(camera)options.profile='camera';
  try{
    const hits=engine.decode(image,options)||[];
    for(const hit of hits){
      const text=patch14CleanText(hit?.text??hit?.rawValue??''),format=String(hit?.format||cfg.sythos[0]||'');
      patch14AddCandidate(candidates,{value:text,format,engine:camera?'Sythos-camera':'Sythos-consensus',confidence:Number(hit?.confidence||0),pass,strict:camera,mode});
    }
  }catch(error){console.debug('Patch14 Sythos pass failed',mode,pass,error)}
}
async function patch14QuaggaPharmacode(source,candidates,pass,mode){
  if(mode!=='pharmacode1')return;
  try{
    const canvas=source instanceof HTMLCanvasElement?source:null;
    if(!canvas)return;
    const src=await canvasDataUrl(canvas);
    const hit=await quaggaDecodeDataUrl(src,['pharmacode_reader'],{locate:true,patchSize:'large',timeoutMs:7000});
    if(hit)patch14AddCandidate(candidates,{value:hit.rawValue,format:'pharmacode',engine:'Quagga-consensus',pass,strict:false,mode});
  }catch(error){console.debug('Patch14 pharmacode pass failed',error)}
}
function patch14Special(source,candidates,pass,mode){
  try{
    let hits=[];
    if(mode==='pharmacode2')hits=detectPharmacodeTwoTrack(source);
    else if(mode==='flattermarken')hits=detectFlattermarken9(source);
    for(const hit of hits||[])patch14AddCandidate(candidates,{value:scanRawValue(hit),format:hit?.format||mode,engine:'Special-consensus',confidence:Number(hit?.confidence||0),pass,strict:false,mode});
  }catch(error){console.debug('Patch14 special pass failed',mode,error)}
}
async function patch14DecodeFile(file,mode=patch14Mode()){
  patch14LastDetection={mode,accepted:null,rejected:[],engines:[]};
  const candidates=[];
  let chosen=null,item=null;
  try{
    item=await loadImageElement(file);

    // Patch 15: native Code-11 runs BEFORE generic decoders, including in Auto.
    // This prevents Code-11 from being misidentified as a short fragment of a
    // different linear symbology. Start + stop are mandatory.
    if(mode==='code11'||mode==='auto'){
      try{
        const direct=prsDetectCode11Direct(item.img,{selected:mode==='code11'});
        for(const hit of direct)patch14AddCandidate(candidates,{value:hit.rawValue,format:'code11',engine:'PRS-Code11',confidence:Number(hit.confidence||1),pass:`native-${hit.lineVotes||0}-lines`,strict:true,mode});
        chosen=patch14Choose(candidates,mode);
        if(chosen){patch14LastDetection.accepted=chosen;return [chosen.value]}
      }catch(error){console.debug('Patch15 native Code11 pass failed',error)}
    }

    // Other barcode families keep Patch 14's high-fidelity original-file ZXing
    // pass after Code-11 has had the first chance to identify its own grammar.
    await patch14ZXing(file,mode,candidates,'original');
    chosen=patch14Choose(candidates,mode);if(chosen){patch14LastDetection.accepted=chosen;return [chosen.value]}

    const variants=[
      {name:'full',band:1,center:.5,contrast:1,maxSide:3200},
      {name:'wide',band:.78,center:.5,contrast:1,maxSide:3200},
      {name:'centre',band:.55,center:.5,contrast:1.2,maxSide:3000},
      {name:'contrast',band:.72,center:.5,contrast:1.65,maxSide:2800},
      {name:'threshold',band:.68,center:.5,contrast:1.15,threshold:true,maxSide:2600},
      {name:'rot90',band:1,center:.5,rotate:90,contrast:1.15,maxSide:3000}
    ];
    for(let i=0;i<variants.length;i++){
      const d=variants[i],canvas=makeBarcodeVariantCanvas(item.img,d);if(!canvas)continue;
      try{
        if($('scanStatus')&&!$('scannerModal').classList.contains('hidden'))$('scanStatus').textContent=`Reading full ${patch14Cfg(mode).label}… validation pass ${i+1}/${variants.length}.`;
        if(mode==='code11'||mode==='auto'){
          try{
            const direct=prsDetectCode11Direct(canvas,{selected:mode==='code11'});
            for(const hit of direct)patch14AddCandidate(candidates,{value:hit.rawValue,format:'code11',engine:'PRS-Code11',confidence:Number(hit.confidence||1),pass:`native-${d.name}-${hit.lineVotes||0}`,strict:true,mode});
          }catch(error){console.debug('Patch15 native Code11 variant failed',d.name,error)}
        }
        // Strict camera profile first. Upstream intentionally returns [] instead
        // of partial/low-confidence 1D payloads in this profile.
        await patch14Sythos(canvas,mode,candidates,d.name,{camera:true});
        await patch14ZXing(canvas,mode,candidates,d.name);
        if(mode==='pharmacode1')await patch14QuaggaPharmacode(canvas,candidates,d.name,mode);
        if(mode==='pharmacode2'||mode==='flattermarken')patch14Special(canvas,candidates,d.name,mode);
        chosen=patch14Choose(candidates,mode);if(chosen){patch14LastDetection.accepted=chosen;return [chosen.value]}
      }finally{try{canvas.width=1;canvas.height=1}catch{}}
      await new Promise(r=>setTimeout(r,0));
    }
    // Some real Code 11/MSI labels omit the optional check digit. Strict camera
    // mode can reject them by design. For an explicitly selected type only, do a
    // permissive scan but require the exact same complete value on >=2 passes.
    if(['code11','msi','itf','telepen','code39','code39ext','code93','gs1128'].includes(mode)){
      for(const d of variants.slice(0,5)){
        const canvas=makeBarcodeVariantCanvas(item.img,d);if(!canvas)continue;
        try{await patch14Sythos(canvas,mode,candidates,'loose-'+d.name,{camera:false})}finally{try{canvas.width=1;canvas.height=1}catch{}}
      }
      chosen=patch14Choose(candidates,mode);if(chosen){patch14LastDetection.accepted=chosen;return [chosen.value]}
    }
    return [];
  }finally{if(item?.url)try{URL.revokeObjectURL(item.url)}catch{}}
}

// Replace Patch 13's permissive first-hit image routine with strict arbitration.
async function detectCodesFromImageFile(file){
  // V3 first: one pass that covers QR, Micro QR, rMQR, DataMatrix, Aztec,
  // PDF417, MaxiCode, DataBar and every linear format. The Patch 15 pipeline
  // below still runs for Code 11, MSI, Telepen, Pharmacode and Flattermarken,
  // which ZXing does not implement.
  if(window.PRSScan&&typeof window.PRSScan.decodeImage==='function'){
    try{
      const mode=patch14Mode();
      const results=await window.PRSScan.decodeImage(file,mode);
      const values=(results||[]).map(r=>String(r.value||'').trim()).filter(Boolean);
      if(values.length){
        (results||[]).forEach(r=>{const v=String(r.value||'').trim();if(v)scanMetaByCode[v]={format:r.format||'',symbology:r.symbology||'',gs1:!!r.gs1}});
        return [...new Set(values)];
      }
    }catch(error){console.debug('V3 still-image decode fell back:',error)}
  }
  return patch14DecodeFile(file,patch14Mode());
}
function patch14DetectionSummary(){
  const a=patch14LastDetection?.accepted;
  if(a)return `${patch14Cfg(patch14LastDetection.mode).label} · ${a.engine} · ${a.format||a.family||'linear'} · full-code validated`;
  const rej=(patch14LastDetection?.rejected||[]).slice(-3).map(x=>`${x.engine}:${x.value||'∅'}`).join(', ');
  return rej?`Rejected partial/invalid candidates: ${rej}`:'No structurally complete candidate returned';
}


function showCapturedScanPhoto(file){
  const root=$('qrReader');
  if(!root||!file)return;
  const url=URL.createObjectURL(file);
  root.innerHTML=`<div style="position:relative;width:100%;min-height:280px;background:#050914;border-radius:14px;overflow:hidden;display:flex;align-items:center;justify-content:center;"><img id="prsIOSScanPhoto" alt="Captured scan evidence" style="display:block;max-width:100%;max-height:min(58vh,520px);object-fit:contain;"><div style="position:absolute;left:10px;right:10px;bottom:10px;padding:7px 9px;background:rgba(0,0,0,.58);border-radius:8px;text-align:center;color:#fff;font-size:12px;font-weight:700;">Evidence photo captured</div></div>`;
  const img=$('prsIOSScanPhoto');
  if(img){img.onload=()=>setTimeout(()=>{try{URL.revokeObjectURL(url)}catch{}},1000);img.onerror=()=>{try{URL.revokeObjectURL(url)}catch{}};img.src=url}
}

let iosScanCameraInput=null;
let iosScanCaptureBusy=false;

function ensureIOSScanCameraInput(){
  if(iosScanCameraInput&&document.body.contains(iosScanCameraInput))return iosScanCameraInput;
  const input=document.createElement('input');
  input.type='file';input.accept='image/*';input.setAttribute('capture','environment');input.id='prsIOSScanCameraInput';
  makePickerRenderable(input);
  input.addEventListener('cancel',()=>{
    iosScanCaptureBusy=false;
    $('startScannerBtn').disabled=false;
    $('startScannerBtn').textContent='Open Camera & Scan';
    const label=$('iosScanCameraLabel');if(label)label.textContent='Open Camera & Scan';
    $('scanStatus').textContent='Camera closed without a photo. Tap Open Camera & Scan to try again.';
  });
  input.addEventListener('change',async e=>{
    iosScanCaptureBusy=false;
    const file=e.target.files?.[0]||null;
    try{e.target.value=''}catch{}
    const button=$('startScannerBtn');button.disabled=false;button.textContent='Retake Camera';const label=$('iosScanCameraLabel');if(label)label.textContent='Retake Camera';
    if(!file){$('scanStatus').textContent='No photo was captured. Tap Open Camera & Scan to try again.';return}

    scanEvidenceFiles=[file];
    showCapturedScanPhoto(file);
    $('scanStatus').textContent=`Photo captured. Reading ${patch14Cfg().label} with strict full-code validation…`;
    let codes=[];
    try{codes=await detectCodesFromImageFile(file)}catch(error){console.error('Captured-image barcode scan failed:',error)}
    if(codes.length){
      scanCodes=[...new Set(codes)];
      $('manualScanCode').value=scanCodes[0]||'';
      renderScanCodes();
      scannerAutoProceed=true;
      $('scanStatus').textContent=`Code detected: ${scanCodes[0]}. ${patch14DetectionSummary()}. Photo attached. Opening verification…`;
      try{navigator.vibrate?.(100)}catch{}
      const finalCodes=[...scanCodes];
      await closeScanner();
      await prepareScanRecord(finalCodes,[file]);
      return;
    }
    scannerAutoProceed=false;
    renderScanCodes();
    $('scanStatus').textContent=`Photo captured, but no COMPLETE ${patch14Cfg().label} value passed validation. Retake with the whole symbol and both quiet margins visible. ${patch14DetectionSummary()}. The evidence photo is already attached.`;
  });
  document.body.appendChild(input);
  iosScanCameraInput=input;
  return input;
}

function startIOSNativeScanCamera(){
  if(iosScanCaptureBusy)return;
  const button=$('startScannerBtn');
  const input=ensureIOSScanCameraInput();
  iosScanCaptureBusy=true;
  scannerAutoProceed=false;
  button.disabled=true;button.textContent='Opening Camera…';
  $('scanStatus').textContent=`Opening rear camera… capture the COMPLETE ${patch14Cfg().label} symbol, including blank margins on both sides.`;
  try{
    invokePickerNow(input);
    // Safari returns control after the camera UI closes. A timer only prevents a
    // permanently disabled button if the browser does not fire cancel/change.
    setTimeout(()=>{if(iosScanCaptureBusy){iosScanCaptureBusy=false;button.disabled=false;button.textContent='Open Camera & Scan'}},5000);
  }catch(error){
    iosScanCaptureBusy=false;button.disabled=false;button.textContent='Open Camera & Scan';
    $('scanStatus').textContent=`Camera could not open. ${cameraErrorMessage(error)}`;
  }
}

$('scanImageInput').onchange=async e=>{
  const files=[...(e.target.files||[])];
  e.target.value='';
  if(!files.length)return;
  scanEvidenceFiles=[...scanEvidenceFiles,...files].slice(0,12);
  let found=0;
  for(const f of files){
    try{
      const codes=await detectCodesFromImageFile(f);
      for(const code of codes){if(code&&!scanCodes.includes(code)){scanCodes.push(code);found++}}
    }catch(error){console.debug('Image scan did not find a code:',error?.name||error?.message||error)}
  }
  if(scanCodes.length&&!$('manualScanCode').value.trim())$('manualScanCode').value=scanCodes[0];
  renderScanCodes();
  $('scanStatus').textContent=found
    ?`${found} new code${found===1?'':'s'} detected. Image evidence attached.`
    :'Image evidence attached, but no readable barcode was found. Retake closer/sharper with the entire barcode and blank side margins visible, or enter the code manually.';
};

$('scanImageBtn').onclick=()=>{
  const input=$('scanImageInput');
  makePickerRenderable(input);
  try{input.removeAttribute('capture')}catch{}
  try{invokePickerNow(input)}catch(error){toast(`Image picker could not open: ${error?.message||error}`,4500)}
};

$('useScanCodeBtn').onclick=async()=>{
  const manual=$('manualScanCode').value.trim();
  const codes=[...new Set([...scanCodes,...(manual?[manual]:[])])];
  if(!codes.length){toast('Scan or enter at least one code first.');return}

  let evidence=[...scanEvidenceFiles].filter(Boolean);
  if(!evidence.length&&scannerRunning){
    $('scanStatus').textContent='Capturing evidence photo from the live scanner…';
    for(let attempt=0;attempt<3&&!evidence.length;attempt++){
      const photo=await captureScannerEvidenceFile();
      if(photo)evidence=[photo];
      else await new Promise(resolve=>setTimeout(resolve,100+attempt*100));
    }
    if(evidence.length)scanEvidenceFiles=[...evidence];
  }
  if(!evidence.length){
    scannerAutoProceed=false;
    toast('A photo is compulsory for every scanned tag.',4500);
    $('scanStatus').textContent=isMobileBarcodeDevice()
      ?'No evidence photo exists yet. Tap Open Camera & Scan, take the photo, then scan/enter the code.'
      :'No evidence photo was captured. Keep the camera open and try Use Code(s) & Verify again, or use Scan Image.';
    return;
  }
  await closeScanner();
  await prepareScanRecord(codes,evidence);
};

function openScanner(){
  if(!hasPermission('verification.scan'))return;
  scanCodes=[];scanEvidenceFiles=[];scanMetaByCode={};scannerAutoProceed=false;scannerFrameCount=0;scanLastLatencyMs=0;
  $('manualScanCode').value='';renderScanCodes();$('qrReader').innerHTML='';
  $('scannerModal').classList.remove('hidden');
  const startBtn=$('startScannerBtn');
  const captureLabel=$('iosScanCameraLabel');
  const engineReady=!!(window.PRSScan&&window.PRSScan.start);

  if(engineReady){
    // V3 uses one live path on every platform, iPhone included. The still-photo
    // capture stays available as a fallback for awkward labels.
    ensureIOSScanCameraInput();
    startBtn.hidden=false;startBtn.disabled=false;startBtn.textContent='Start Camera';
    if(captureLabel){captureLabel.hidden=false;captureLabel.textContent='Photo Fallback'}
    $('scanStatus').textContent='Universal scanner V3 ready — linear, QR and GS1 2D. Tap Start Camera and hold the code in view.';
    // Warming now means the WASM decoder is already resident when the camera opens.
    try{window.PRSScan.warm()}catch(error){console.debug('Scanner warm-up skipped:',error)}
    if(navigator.onLine)setTimeout(()=>{Promise.allSettled([ensureZXingWasmEngine()]).then(()=>console.debug('legacy still-image engines warmed'))},0);
    return;
  }

  // prs-scan.js missing: fall back to the Patch 15 still-photo pipeline.
  const mobile=isMobileBarcodeDevice();
  if(mobile){
    ensureIOSScanCameraInput();
    startBtn.hidden=true;
    if(captureLabel){captureLabel.hidden=false;captureLabel.textContent='Open Camera & Scan'}
    $('scanStatus').textContent='Still-photo scanner ready. Choose Barcode Type, then tap Open Camera & Scan.';
    if(navigator.onLine)setTimeout(()=>Promise.allSettled([ensureZXingWasmEngine(),ensureSythosEngine()]).then(()=>console.debug('engines warmed')),0);
  }else{
    startBtn.hidden=false;startBtn.textContent='Start Camera';startBtn.disabled=false;
    if(captureLabel)captureLabel.hidden=true;
    $('scanStatus').textContent='Live scanner ready.';
  }
}

function dataUrlToBlobForScanner(dataUrl){
  try{
    const parts=String(dataUrl||'').split(',');if(parts.length!==2)return null;
    const mime=(parts[0].match(/^data:([^;]+);base64$/i)||[])[1]||'image/jpeg';
    const binary=atob(parts[1]),bytes=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
    return new Blob([bytes],{type:mime});
  }catch{return null}
}

async function canvasToJpegBlobForScanner(canvas,quality=.76){
  let blob=null;
  if(typeof canvas?.toBlob==='function'){
    blob=await Promise.race([
      new Promise(resolve=>{try{canvas.toBlob(resolve,'image/jpeg',quality)}catch{resolve(null)}}),
      new Promise(resolve=>setTimeout(()=>resolve(null),1800))
    ]);
  }
  if(blob)return blob;
  try{return dataUrlToBlobForScanner(canvas.toDataURL('image/jpeg',quality))}catch{return null}
}

async function captureScannerEvidenceFile(){
  const video=$('prsMobileScanVideo');
  if(!video||video.readyState<2||!video.videoWidth||!video.videoHeight)return null;
  try{
    const srcW=video.videoWidth,srcH=video.videoHeight,maxSide=1024;
    const scale=Math.min(1,maxSide/Math.max(srcW,srcH)),w=Math.max(1,Math.round(srcW*scale)),h=Math.max(1,Math.round(srcH*scale));
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)return null;
    ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(video,0,0,w,h);
    const blob=await canvasToJpegBlobForScanner(canvas,.76);canvas.width=1;canvas.height=1;
    if(!blob||!blob.size)return null;
    const name=`scan-${new Date().toISOString().replace(/[:.]/g,'-')}.jpg`;
    try{return new File([blob],name,{type:'image/jpeg',lastModified:Date.now()})}catch{try{blob.name=name}catch{};return blob}
  }catch(error){console.warn('Could not capture scanner evidence frame:',error);return null}
}

function handleScannerDecoded(decoded){
  // V3 hands over an object; older paths still pass a bare string.
  const detail=(decoded&&typeof decoded==='object')?decoded:{value:decoded};
  const value=String(detail.value||'').trim();
  if(!value||scannerAutoProceed)return;
  scanMetaByCode[value]={format:detail.format||'',symbology:detail.symbology||'',gs1:!!detail.gs1};
  scanLastLatencyMs=Number(detail.latencyMs||0);
  scannerAutoProceed=true;scanCodes=[value];$('manualScanCode').value=value;renderScanCodes();
  try{navigator.vibrate?.(100)}catch{}
  $('scanStatus').textContent=`${detail.format?detail.format+' ':''}code read${scanLastLatencyMs?` in ${scanLastLatencyMs} ms`:''}: ${value}. Capturing evidence photo…`;
  (async()=>{
    try{
      let evidence=null;
      for(let attempt=0;attempt<3&&!evidence;attempt++){
        evidence=await captureScannerEvidenceFile();
        if(!evidence)await new Promise(resolve=>setTimeout(resolve,100+attempt*90));
      }
      if(!evidence){
        scannerAutoProceed=false;
        if(window.PRSScan&&typeof window.PRSScan.resume==='function'){try{window.PRSScan.resume()}catch{}}
        $('scanStatus').textContent=`Code detected: ${value}, but the evidence photo was not captured. Keep the camera open and tap Use Code(s) & Verify to retry.`;
        return;
      }
      scanEvidenceFiles=[evidence,...scanEvidenceFiles].slice(0,12);
      $('scanStatus').textContent=`Code detected: ${value}. Photo captured. Opening verification…`;
      await stopScanner({preserveStatus:true});$('scannerModal').classList.add('hidden');
      await prepareScanRecord([value],scanEvidenceFiles);
    }catch(error){console.error('Automatic scan continuation failed:',error);scannerAutoProceed=false;$('scanStatus').textContent='The code was read but verification could not open. Tap Use Code(s) & Verify.'}
  })();
}

function buildScannerVideo(){
  const root=$('qrReader');
  root.innerHTML=`<div style="position:relative;width:100%;min-height:320px;background:#050914;border-radius:14px;overflow:hidden;">`
    +`<video id="prsMobileScanVideo" playsinline webkit-playsinline autoplay muted style="display:block;width:100%;height:min(66vh,560px);object-fit:cover;background:#050914;"></video>`
    +`<div style="position:absolute;left:8%;right:8%;top:26%;bottom:26%;border:3px solid rgba(255,255,255,.95);border-radius:16px;box-shadow:0 0 0 9999px rgba(0,0,0,.16);pointer-events:none;"></div>`
    +`<button type="button" id="scanTorchBtn" hidden style="position:absolute;top:10px;right:10px;z-index:3;border:0;border-radius:999px;padding:9px 14px;font-weight:700;font-size:13px;background:rgba(15,23,42,.78);color:#fff;">Torch</button>`
    +`<div id="scanLiveBadge" style="position:absolute;top:10px;left:10px;z-index:3;border-radius:999px;padding:6px 12px;font-weight:700;font-size:12px;background:rgba(15,23,42,.78);color:#7dd3fc;">Scanning…</div>`
    +`<div style="position:absolute;left:6%;right:6%;bottom:12px;text-align:center;color:white;font-size:13px;font-weight:700;text-shadow:0 1px 3px #000;pointer-events:none;">Hold the whole code inside the box — barcodes need the blank margin at both ends</div>`
    +`</div>`;
  const torchBtn=$('scanTorchBtn');
  if(torchBtn)torchBtn.onclick=async()=>{
    if(!window.PRSScan)return;
    const on=torchBtn.dataset.on!=='1';
    const ok=await window.PRSScan.toggleTorch(on);
    if(ok){torchBtn.dataset.on=on?'1':'0';torchBtn.textContent=on?'Torch off':'Torch'}
  };
  return $('prsMobileScanVideo');
}

function stopTracksSynchronously(){
  try{if(scannerStream?.getTracks)for(const track of scannerStream.getTracks())try{track.stop()}catch{}}catch{}
  scannerStream=null;
  const old=$('prsMobileScanVideo');if(old){try{old.pause()}catch{};try{old.srcObject=null}catch{}}
}

async function tuneMobileCamera(video){
  try{
    const track=video?.srcObject?.getVideoTracks?.()[0];if(!track)return;
    const caps=track.getCapabilities?.()||{};
    if(Array.isArray(caps.focusMode)&&caps.focusMode.includes('continuous'))try{await track.applyConstraints({advanced:[{focusMode:'continuous'}]})}catch{}
  }catch(error){console.debug('Optional camera tuning unavailable:',error)}
}

function waitForVideoReady(video,timeoutMs=6500){
  return new Promise((resolve,reject)=>{
    if(video.readyState>=2&&video.videoWidth>0&&video.videoHeight>0){resolve();return}
    let done=false;
    const finish=(ok,error)=>{if(done)return;done=true;clearTimeout(timer);video.removeEventListener('loadedmetadata',onReady);video.removeEventListener('canplay',onReady);ok?resolve():reject(error||new Error('Camera preview did not become ready'))};
    const onReady=()=>{if(video.videoWidth>0&&video.videoHeight>0)finish(true)};
    video.addEventListener('loadedmetadata',onReady);video.addEventListener('canplay',onReady);
    const timer=setTimeout(()=>finish(false,new Error('Camera preview timed out')),timeoutMs);
  });
}

function scannerCrop(video,contrast=false){
  const vw=Number(video.videoWidth||0),vh=Number(video.videoHeight||0);if(!vw||!vh)return null;
  if(!scannerCanvas)scannerCanvas=document.createElement('canvas');
  // Barcode-first live crop: preserve almost the entire frame WIDTH so Code128,
  // EAN/UPC, ITF etc. keep their mandatory left/right quiet zones. Only trim
  // vertically to concentrate decoder work on a horizontal barcode band.
  const cropW=Math.max(1,Math.floor(vw*.96)),cropH=Math.max(1,Math.floor(vh*.50));
  const sx=Math.floor((vw-cropW)/2),sy=Math.floor((vh-cropH)/2),maxSide=1500,scale=Math.min(maxSide/cropW,maxSide/cropH,1.45);
  const outW=Math.max(640,Math.floor(cropW*scale)),outH=Math.max(260,Math.floor(cropH*scale));
  scannerCanvas.width=outW;scannerCanvas.height=outH;
  const ctx=scannerCanvas.getContext('2d',{willReadFrequently:true,alpha:false});
  if(!ctx)return null;
  ctx.fillStyle='#fff';ctx.fillRect(0,0,outW,outH);
  ctx.save();ctx.filter=contrast?'grayscale(1) contrast(1.55)':'none';ctx.drawImage(video,sx,sy,cropW,cropH,0,0,outW,outH);ctx.restore();
  return scannerCanvas;
}

async function scanOneLiveFrame(){
  if(!scannerRunning||scannerScanBusy||scannerAutoProceed)return;
  const video=$('prsMobileScanVideo');if(!video||video.readyState<2||!video.videoWidth)return;
  scannerScanBusy=true;scannerFrameCount++;
  try{
    let value='';const crop=scannerCrop(video,false);if(crop)value=await detectWithScannerDetector(crop);
    if(!value&&scannerFrameCount%4===0)value=await detectWithScannerDetector(video);
    if(!value&&scannerFrameCount%6===0){const contrastCrop=scannerCrop(video,true);if(contrastCrop)value=await detectWithScannerDetector(contrastCrop)}
    if(value){handleScannerDecoded(value);return}
    const elapsed=(Date.now()-scannerStartedAt)/1000;
    if(scannerFrameCount%10===0&&!scannerAutoProceed)$('scanStatus').textContent=elapsed>8?'Camera is scanning continuously. Move the barcode closer so the bars fill most of the box width, but keep the blank left/right margins visible.':`Camera live • scanning… (${scannerFrameCount} frames analysed)`;
  }catch(error){console.debug('Mobile barcode frame decode:',error?.name||error?.message||error)}finally{scannerScanBusy=false}
}

function scheduleScannerLoop(delay=170){
  clearTimeout(scannerLoopTimer);if(!scannerRunning)return;
  scannerLoopTimer=setTimeout(async()=>{await scanOneLiveFrame();scheduleScannerLoop(170)},delay);
}

async function startScanner(){
  if(window.PRSScan&&typeof window.PRSScan.start==='function'){
    if(scannerRunning){await stopScanner();return}
    const button=$('startScannerBtn');
    button.disabled=true;button.textContent='Opening Camera…';
    $('scanStatus').textContent='Opening rear camera — allow the Camera permission if prompted.';
    scannerAutoProceed=false;scannerFrameCount=0;
    try{
      const video=buildScannerVideo();
      await window.PRSScan.start({
        video,
        mode:$('barcodeTypeSelect').value||'auto',
        onDecode:detail=>handleScannerDecoded(detail),
        onStatus:text=>{$('scanStatus').textContent=text}
      });
      scannerRunning=true;scannerStream=window.PRSScan.state.stream;
      button.disabled=false;button.textContent='Stop Camera';
      const torchBtn=$('scanTorchBtn');
      if(torchBtn&&window.PRSScan.torchAvailable())torchBtn.hidden=false;
      const badge=$('scanLiveBadge');if(badge)badge.textContent='Scanning…';
      $('scanStatus').textContent='Live scanner running — linear, QR, DataMatrix, PDF417, Aztec and GS1 2D are all active. Hold the code inside the box.';
    }catch(error){
      console.error('V3 scanner start failed:',error);
      scannerRunning=false;
      try{window.PRSScan.stop()}catch{}
      $('qrReader').innerHTML='';
      button.disabled=false;button.textContent='Start Camera';
      $('scanStatus').textContent=`Camera could not start. ${cameraErrorMessage(error)}`;
    }
    return;
  }
  return startScannerLegacy();
}

async function startScannerLegacy(){
  // IMPORTANT: iPhone uses native capture. This call remains fully synchronous
  // until the picker is opened, preserving Safari's required user gesture.
  if(isIOSDevice()){
    startIOSNativeScanCamera();
    return;
  }
  if(scannerRunning){await stopScanner();return}
  if(!window.isSecureContext){$('scanStatus').textContent='Camera requires HTTPS. Open the PRS2 GitHub Pages website.';return}
  if(!navigator.mediaDevices?.getUserMedia){$('scanStatus').textContent='Live camera is unavailable. Use Scan Image or enter the code manually.';return}
  const button=$('startScannerBtn');button.disabled=true;button.textContent='Opening Camera…';$('scanStatus').textContent='Opening rear camera… allow Camera permission if prompted.';
  scannerAutoProceed=false;scannerScanBusy=false;scannerFrameCount=0;
  let stream;
  try{
    stopTracksSynchronously();clearTimeout(scannerLoopTimer);
    try{stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'}}})}
    catch(error){if(String(error?.name||'')==='OverconstrainedError')stream=await navigator.mediaDevices.getUserMedia({audio:false,video:true});else throw error}
    scannerStream=stream;
    const video=buildScannerVideo();video.srcObject=stream;video.muted=true;video.setAttribute('playsinline','');video.setAttribute('webkit-playsinline','');
    try{const p=video.play();p?.catch?.(()=>{})}catch{}
    await waitForVideoReady(video);tuneMobileCamera(video).catch(()=>{});
    scannerRunning=true;scannerStartedAt=Date.now();button.disabled=false;button.textContent='Stop Camera';$('scanStatus').textContent='Camera is live. Preparing barcode-first recognition…';
    try{scannerDetector=await createScannerDetector()}catch(error){scannerDetector=null;console.error('Scanner decoder failed while camera stayed open:',error)}
    if(!scannerRunning)return;
    if(!scannerDetector){$('scanStatus').textContent='Camera is live but automatic recognition could not load. Enter the code manually and tap Use Code(s) & Verify; the evidence photo will be captured from the live camera.';return}
    $('scanStatus').textContent=`Barcode-first scanner is live${scannerEngineSource?` (${scannerEngineSource})`:''}. Hold the complete barcode steady inside the box and keep the blank margins on both sides visible.`;scheduleScannerLoop(180);
  }catch(error){
    console.error('Mobile scanner start failed:',error);scannerRunning=false;scannerScanBusy=false;scannerDetector=null;clearTimeout(scannerLoopTimer);scannerLoopTimer=null;
    if(stream?.getTracks)for(const track of stream.getTracks())try{track.stop()}catch{};stopTracksSynchronously();$('qrReader').innerHTML='';button.disabled=false;button.textContent='Start Camera';$('scanStatus').textContent=`Camera scanner could not start. ${cameraErrorMessage(error)}`;
  }
}

async function stopScanner(options={}){
  const button=$('startScannerBtn');clearTimeout(scannerLoopTimer);scannerLoopTimer=null;scannerRunning=false;scannerScanBusy=false;scannerDetector=null;
  if(window.PRSScan&&typeof window.PRSScan.stop==='function'){try{window.PRSScan.stop()}catch(error){console.debug('V3 scanner stop:',error)}}
  stopTracksSynchronously();
  if(scannerCanvas){try{scannerCanvas.width=1;scannerCanvas.height=1}catch{};scannerCanvas=null}
  if(!isIOSDevice())$('qrReader').innerHTML='';
  const v3=!!(window.PRSScan&&window.PRSScan.start);
  if(button){button.disabled=false;button.textContent=(v3||!isIOSDevice())?'Start Camera':'Open Camera & Scan';button.hidden=v3?false:isIOSDevice()}
  const iosLabel=$('iosScanCameraLabel');
  if(iosLabel){iosLabel.hidden=v3?false:!isIOSDevice();iosLabel.textContent=v3?'Photo Fallback':'Open Camera & Scan'}
  if(!options.preserveStatus&&!$('scannerModal').classList.contains('hidden'))$('scanStatus').textContent=scanCodes.length?`${scanCodes.length} code${scanCodes.length===1?'':'s'} captured.`:(isIOSDevice()?'Tap Open Camera & Scan to capture the tag.':'Camera stopped. Tap Start Camera to scan again.');
}

async function closeScanner(){
  scannerAutoProceed=false;iosScanCaptureBusy=false;await stopScanner();$('scannerModal').classList.add('hidden');
}

window.addEventListener('pagehide',()=>{try{releaseScannerForNativeCapture()}catch{}});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&scannerRunning)try{releaseScannerForNativeCapture()}catch{}});

async function prepareScanRecord(codes,evidenceFiles=[]){
  const evidence=[...(evidenceFiles||[])].filter(Boolean);
  if(!evidence.length){scannerAutoProceed=false;toast('Evidence photo is required for every scanned tag.',4500);return false}
  toast('QR / barcode read. Preparing verification with photo…',2800);
  try{
    const photos=await compressFiles(evidence,'scan-image');
    if(!photos.length)throw new Error('Evidence photo could not be prepared');
    const d=new Date(),joined=codes.join(' | '),first=photos[0],captureToken=uid();
    const parsedCodes=codes.map(c=>parseScanPayload(c,scanMetaByCode[c])),mapped=scanDynamicValues(parsedCodes),assets=parsedCodes.map(scanPayloadToAsset);
    pendingRecord={captureToken,photos,dataUrl:first.dataUrl,size:photos.reduce((n,p)=>n+p.size,0),source:'scan',capturedAt:d.toISOString(),photoName:first.name||'',scanCode:joined,gps:{latitude:'',longitude:'',accuracy:'',error:'GPS detection is in progress…'}};
    $('detailTitle').textContent=codes.length>1?`Scan & Verify · ${codes.length} codes`:'Scan & Verify Details';renderPendingPhotoPreview();$('scanOnlyPreview').classList.remove('hidden');$('scanOnlyCode').textContent=joined;$('retryAiBtn').classList.add('hidden');
    const filledCount=Object.keys(mapped.sticky).length+Object.keys(mapped.variable).length+assets.reduce((n,a)=>n+[a.assetName,a.serialNumber,a.barcode].filter(Boolean).length,0);
    $('aiStatus').textContent=filledCount?`Scanner auto-filled ${filledCount} recognised value${filledCount===1?'':'s'}. Evidence photo attached. Review before saving.`:'QR / barcode text captured. Evidence photo attached. Review before saving.';
    setCaptureDateTime(d);$('latitude').value='';$('longitude').value='';$('gpsAccuracy').value='';$('gpsNote').textContent='GPS detection starts after scanning. Latitude, Longitude and GPS Accuracy remain optional.';
    renderCaptureStickyFields(mapped.sticky);renderVariableFields('variableFieldsContainer',mapped.variable,'variable');renderAssetRows(assets.length?assets:[assetDefault()]);openPendingDetailStep1();updateGuidedCaptureFlow(false);
    pendingRecord.gpsPromise=captureGpsForPendingRecord(captureToken);
    return true;
  }catch(e){console.error(e);scannerAutoProceed=false;toast('Could not prepare the scan photo. Please retake the scan.',4500);return false}
}

// ---------- Records ----------
async function refreshRecords(){if(!session?.member)return;let base=[];try{const d=await apiJson('/records');base=d.records||[];await cacheSet('records',base)}catch(e){base=(await cacheGet('records'))||[];if(!isNetworkError(e)&&navigator.onLine)console.error(e)}records=await applyQueueOverlay(base);renderRecent();populateFilters();if(!$('searchView').classList.contains('hidden'))renderSearch();updateSyncUi()}
function flattenAssets(){return records.flatMap(r=>(r.assets||[]).map(a=>({record:r,asset:a})))}
function canViewPhotos(){return hasPermission('verification.view_images')||hasPermission('verification.view')||hasPermission('records.export')}
function currentPhotoUrl(url){
  if(!url)return '';
  if(String(url).startsWith('data:image/'))return url;
  try{
    const u=new URL(url,WORKER_URL);
    if(session?.token)u.searchParams.set('access',session.token);
    u.searchParams.set('pv','20');
    return u.toString();
  }catch{return url}
}
function currentPhotoUrls(r){return (r?.photoUrls?.length?r.photoUrls:(r?.photoUrl?[r.photoUrl]:[])).map(currentPhotoUrl).filter(Boolean)}

function recordCard(r){const tags=(r.assets||[]).map(a=>`<span class="asset-tag ${statusClass(a.verificationStatus)}">${escapeHtml(a.assetName)} × ${a.quantity} · ${escapeHtml(a.condition)} · ${escapeHtml(a.verificationStatus)}</span>`).join('');const sticky=fields.sticky.map(f=>`${escapeHtml(f.label)}: ${escapeHtml(r.sticky?.[f.id]||'')}`).filter(x=>!x.endsWith(': ')).join(' · ');const gps=r.latitude&&r.longitude?`<span class="gps-chip">GPS ${escapeHtml(r.latitude)}, ${escapeHtml(r.longitude)}</span>`:'';const urls=currentPhotoUrls(r);const img=urls[0]&&canViewPhotos()?`<div class="record-photo-wrap"><img src="${escapeHtml(urls[0])}" alt="Verification photo" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('.record-photo-wrap').classList.add('photo-load-error');this.alt='Photo could not be loaded';">${urls.length>1?`<span class="photo-count-badge">${urls.length} photos</span>`:''}</div>`:'';return `<article class="record ${img?'':'no-photo'} ${r.localPending?'local-pending':''}">${img}<div class="record-body">${r.localPending?'<span class="pending-sync-chip">Pending cloud sync</span>':''}<div class="record-source">${escapeHtml(r.source||'record')}</div><h3>${escapeHtml((r.assets?.[0]?.assetName)||r.scanCode||'Verification')}</h3><p>${sticky||'No sticky fields'}</p><p>${fmtDate(r.capturedAt)} ${fmtTime(r.capturedAt)} · By ${escapeHtml(r.clickedByName||'')}</p>${gps}${r.scanCode?`<p>Scanned Code(s): ${escapeHtml(r.scanCode)}</p>`:''}<div class="asset-tags">${tags}</div></div><div class="record-actions">${hasPermission('verification.edit')?`<button class="secondary mini-btn" data-edit-record="${r.id}">Edit</button>`:''}${hasPermission('verification.delete')?`<button class="danger mini-btn" data-delete-record="${r.id}">Delete</button>`:''}</div></article>`}
function renderRecent(){const list=records.slice().sort((a,b)=>new Date(b.capturedAt)-new Date(a.capturedAt));$('photoCount').textContent=list.length;$('assetCount').textContent=flattenAssets().length;$('recordsEmpty').classList.toggle('hidden',list.length>0);$('recordList').innerHTML=list.slice(0,50).map(recordCard).join('');wireRecordActions($('recordList'))}
function wireRecordActions(container){container.querySelectorAll('[data-edit-record]').forEach(b=>b.onclick=()=>openEditRecord(b.dataset.editRecord));container.querySelectorAll('[data-delete-record]').forEach(b=>b.onclick=()=>deleteRecord(b.dataset.deleteRecord))}
async function deleteRecord(id){if(!confirm('Delete this verification record and its stored photo?'))return;const local=records.find(r=>String(r.id)===String(id));if(local?.localPending&&local.clientId){await removePendingCreate(local.clientId);toast('Offline verification removed from this device.');await refreshRecords();return}try{if(!navigator.onLine)throw new TypeError('Offline');await apiJson(`/records/${id}`,{method:'DELETE'});toast('Record deleted.');await refreshRecords()}catch(e){if(isNetworkError(e)||!navigator.onLine){await queueOfflineAction('DELETE',`/records/${id}`,null,{id,deleted:true});toast('Delete queued. It will sync automatically.',4000);await refreshRecords()}else toast(e.message,4200)}}
function renderEditSticky(values){$('editStickyFields').innerHTML=fields.sticky.map(f=>fieldInputHtml(f,values?.[f.id]||'','editSticky')).join('')}
function openEditRecord(id){editingRecord=records.find(r=>String(r.id)===String(id));if(!editingRecord)return;const urls=currentPhotoUrls(editingRecord);if(urls.length){$('editPreview').src=urls[0];$('editPreview').classList.remove('hidden');$('editScanPreview').classList.add('hidden');$('editPhotoThumbs').innerHTML=urls.map((u,i)=>`<img src="${escapeHtml(u)}" data-edit-photo-thumb="${i}" class="${i===0?'active':''}" alt="Photo ${i+1}">`).join('');document.querySelectorAll('[data-edit-photo-thumb]').forEach(img=>img.onclick=()=>{$('editPreview').src=urls[Number(img.dataset.editPhotoThumb)];document.querySelectorAll('[data-edit-photo-thumb]').forEach(x=>x.classList.remove('active'));img.classList.add('active')})}else{$('editPreview').classList.add('hidden');$('editPhotoThumbs').innerHTML='';$('editScanPreview').classList.remove('hidden');$('editScanPreview').textContent=`Scanned Code(s): ${editingRecord.scanCode||'—'}`}renderEditSticky(editingRecord.sticky||{});renderVariableFields('editVariableFields',editingRecord.variable||{},'editVariable');const d=new Date(editingRecord.capturedAt);$('editCapturedDate').value=isoDateInput(d);$('editCapturedTime').value=timeInput(d);$('editLatitude').value=editingRecord.latitude||'';$('editLongitude').value=editingRecord.longitude||'';$('editGpsAccuracy').value=editingRecord.gpsAccuracy||'';renderAssetRows(editingRecord.assets||[],true);$('editRecordModal').classList.remove('hidden')}
$('editAddAssetBtn').onclick=()=>{$('editAssetRows').insertAdjacentHTML('beforeend',assetRowHtml(assetDefault(),true));wireAssetRows($('editAssetRows'))};$('saveRecordEditBtn').onclick=async()=>{if(!editingRecord)return;const assets=collectAssetRows(true);if(!assets.length){toast('At least one asset is required.');return}const sticky=collectFieldValues('sticky','editSticky'),variable=collectFieldValues('variable','editVariable'),payload={capturedAt:combineDateTime($('editCapturedDate').value,$('editCapturedTime').value),latitude:$('editLatitude').value.trim(),longitude:$('editLongitude').value.trim(),gpsAccuracy:$('editGpsAccuracy').value.trim(),sticky,variable,clickedByMemberId:clickedByFromVariable(variable),assets};if(editingRecord.localPending&&editingRecord.clientId){await updatePendingCreate(editingRecord.clientId,payload);$('editRecordModal').classList.add('hidden');toast('Offline verification updated.');await refreshRecords();return}try{if(!navigator.onLine)throw new TypeError('Offline');await apiJson(`/records/${editingRecord.id}`,{method:'PUT',body:JSON.stringify(payload)});$('editRecordModal').classList.add('hidden');toast('Record updated.');await refreshRecords()}catch(e){if(isNetworkError(e)||!navigator.onLine){const optimistic={...editingRecord,...payload,clickedByName:users.find(u=>String(u.id)===String(payload.clickedByMemberId))?.name||editingRecord.clickedByName,localPending:true};await queueOfflineAction('PUT',`/records/${editingRecord.id}`,payload,optimistic);$('editRecordModal').classList.add('hidden');toast('Changes saved offline and queued for sync.',4200);await refreshRecords()}else toast(e.message,4200)}};

// ---------- Search & filters ----------
function uniqueFieldVals(fieldId){return [...new Set(records.map(r=>r.sticky?.[fieldId]).filter(Boolean))].sort((a,b)=>String(a).localeCompare(String(b)))}
function populateFilters(){$('dynamicFilters').innerHTML=fields.sticky.map(f=>`<label>${escapeHtml(f.label)}<select data-filter-field="${f.id}"><option value="">All ${escapeHtml(f.label)}</option>${uniqueFieldVals(f.id).map(v=>`<option>${escapeHtml(v)}</option>`).join('')}</select></label>`).join('');$('dynamicFilters').querySelectorAll('select').forEach(s=>s.addEventListener('change',renderSearch))}
function renderStatusTabs(){const rows=flattenAssets();const items=[['ALL','All',rows.length],['Found','Found',rows.filter(x=>x.asset.verificationStatus==='Found').length],['Not Found','Not Found',rows.filter(x=>x.asset.verificationStatus==='Not Found').length],['Pending','Pending',rows.filter(x=>x.asset.verificationStatus==='Pending').length],['IMAGES','📷 With Images',records.filter(r=>(r.photoUrls?.length||r.photoUrl)).length]];$('statusTabs').innerHTML=items.map(([k,l,n])=>`<button class="${activeStatus===k?'active':''}" data-status="${k}">${l} (${n})</button>`).join('');$('statusTabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{activeStatus=b.dataset.status;renderSearch()})}
function searchFilteredRecords(){const q=$('searchText').value.trim().toLowerCase(),condition=$('filterCondition').value,filters=[...$('dynamicFilters').querySelectorAll('select')].map(s=>[s.dataset.filterField,s.value]).filter(x=>x[1]);return records.filter(r=>{for(const [id,v] of filters)if(String(r.sticky?.[id]||'')!==v)return false;if(activeStatus==='IMAGES'&&!(r.photoUrls?.length||r.photoUrl))return false;const assets=r.assets||[];const assetMatch=assets.some(a=>{if(condition&&a.condition!==condition)return false;if(activeStatus!=='ALL'&&activeStatus!=='IMAGES'&&a.verificationStatus!==activeStatus)return false;const hay=[a.assetName,a.serialNumber,a.barcode,a.condition,a.verificationStatus,a.notFoundReason,r.scanCode,r.latitude,r.longitude,r.clickedByName,...Object.values(r.sticky||{}),...Object.values(r.variable||{})].join(' ').toLowerCase();return !q||hay.includes(q)});return assetMatch||(!assets.length&&!q)})}
function renderSearch(){renderStatusTabs();const found=searchFilteredRecords();$('searchResults').innerHTML=found.map(recordCard).join('');$('searchEmpty').classList.toggle('hidden',found.length>0);wireRecordActions($('searchResults'))}
$('searchText').addEventListener('input',renderSearch);$('filterCondition').addEventListener('change',renderSearch);$('clearFiltersBtn').onclick=()=>{$('searchText').value='';$('filterCondition').value='';$('dynamicFilters').querySelectorAll('select').forEach(s=>s.value='');activeStatus='ALL';renderSearch()};

// ---------- Roles & permissions ----------
function roleById(id){return roles.find(r=>String(r.id)===String(id))||null}
function adminRole(){return roles.find(r=>String(r.systemKey||'').toUpperCase()==='ADMIN')||null}
function activeAdmins(){return users.filter(u=>u.active!==0&&String(u.roleSystemKey||'').toUpperCase()==='ADMIN')}
function wouldRemoveLastAdmin(targetRoleId,memberIds=[]){
  const target=roleById(targetRoleId),selected=new Set(memberIds.map(String)),admins=activeAdmins();
  if(!admins.length)return true;
  if(String(target?.systemKey||'').toUpperCase()==='ADMIN')return users.filter(u=>u.active!==0&&selected.has(String(u.id))).length<1;
  return admins.filter(u=>!selected.has(String(u.id))).length<1;
}
async function refreshRoles(){if(!session?.member)return;try{const d=await apiJson('/roles');roles=d.roles||[];await cacheSet('roles',roles)}catch(e){const cached=await cacheGet('roles');if(cached)roles=cached;else if(navigator.onLine)console.error(e)}if(!$('rolesView').classList.contains('hidden'))renderRoles();fillRoleSelects()}
function fillRoleSelects(){const opts=roles.map(r=>`<option value="${r.id}">${escapeHtml(r.name)}${r.systemRole?' · System':''}</option>`).join('');$('userRole').innerHTML=opts}
function renderRoles(){$('roleCards').innerHTML=roles.map(r=>`<article class="role-card"><h3>${escapeHtml(r.name)}</h3><p>${escapeHtml(r.description||'')}</p><div class="role-meta"><span class="pill">${r.systemRole?'System':'Custom'}</span>${r.systemKey?`<span class="pill">${escapeHtml(r.systemKey)}</span>`:''}<span class="pill">${r.memberCount||0} member(s)</span><span class="pill">${r.permissions?.length||0} permission(s)</span></div><div class="role-actions">${hasPermission('roles.edit')?`<button class="secondary mini-btn" data-role-edit="${r.id}">Edit Role</button>`:''}${hasPermission('roles.delete')&&!r.systemRole?`<button class="danger mini-btn" data-role-delete="${r.id}">Delete</button>`:''}</div></article>`).join('');document.querySelectorAll('[data-role-edit]').forEach(b=>b.onclick=()=>openRoleModal(b.dataset.roleEdit));document.querySelectorAll('[data-role-delete]').forEach(b=>b.onclick=()=>deleteRole(b.dataset.roleDelete))}
$('createRoleBtn').onclick=()=>openRoleModal();
function openRoleModal(id=null){editingRole=id?roleById(id):null;$('roleModalTitle').textContent=editingRole?(editingRole.systemRole?`Edit System Role · ${editingRole.systemKey||''}`:'Edit Role'):'Create Role';$('roleName').value=editingRole?.name||'';$('roleDescription').value=editingRole?.description||'';const current=new Set(editingRole?.permissions||[]);$('permissionChecklist').innerHTML=PERMISSION_CATALOG.map(([code,label,desc])=>`<label class="permission-item"><input type="checkbox" value="${code}" ${current.has(code)?'checked':''}><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(desc)}</small></span></label>`).join('');const assigned=new Set(users.filter(u=>String(u.roleId)===String(editingRole?.id)).map(u=>String(u.id)));$('roleMemberAssignments').innerHTML=users.filter(u=>u.active!==0).map(u=>`<label class="assignment-item"><input type="checkbox" value="${u.id}" ${assigned.has(String(u.id))?'checked':''}>${escapeHtml(u.name)} <small>· ${escapeHtml(u.roleName||'Role')}</small></label>`).join('');$('roleModal').classList.remove('hidden')}
$('saveRoleBtn').onclick=async()=>{const name=$('roleName').value.trim(),description=$('roleDescription').value.trim(),permissions=[...$('permissionChecklist').querySelectorAll('input:checked')].map(x=>x.value),assignMembers=[...$('roleMemberAssignments').querySelectorAll('input:checked')].map(x=>x.value);if(!name){toast('Role name is required.');return}if(editingRole&&wouldRemoveLastAdmin(editingRole.id,assignMembers)){toast('At least one active Admin is compulsory. The last Admin cannot be reassigned.',4500);return}if(!editingRole&&activeAdmins().some(u=>assignMembers.includes(String(u.id)))&&activeAdmins().length===assignMembers.filter(id=>activeAdmins().some(u=>String(u.id)===String(id))).length){toast('At least one active Admin is compulsory. The last Admin cannot be moved to this role.',4500);return}if(!navigator.onLine){toast('Role changes require an internet connection.');return}const btn=$('saveRoleBtn');btn.disabled=true;const oldText=btn.textContent;btn.textContent='Saving…';try{const payload={name,description,permissions,assignMembers};const d=editingRole?await apiJson(`/roles/${editingRole.id}`,{method:'PUT',body:JSON.stringify(payload)}):await apiJson('/roles',{method:'POST',body:JSON.stringify(payload)});if(d.session){session=d.session;saveSession();updateShell()}$('roleModal').classList.add('hidden');await Promise.all([refreshRoles(),refreshUsers()]);renderRoles();renderUsers();toast('Role saved.')}catch(e){toast(e.message,4500)}finally{btn.disabled=false;btn.textContent=oldText}};
async function deleteRole(id){if(!navigator.onLine){toast('Role changes require an internet connection.');return}if(!confirm('Delete this custom role? It must not be assigned to any member.'))return;try{await apiJson(`/roles/${id}`,{method:'DELETE'});await refreshRoles();renderRoles();toast('Role deleted.')}catch(e){toast(e.message,4200)}}

// ---------- Team members ----------
async function refreshUsers(){if(!session)return;try{const d=await apiJson('/members');users=d.members||[];await cacheSet('users',users)}catch(e){const cached=await cacheGet('users');if(cached)users=cached;else if(navigator.onLine)console.error(e)}if(!$('usersView').classList.contains('hidden'))renderUsers()}
function renderUsers(){$('userCards').innerHTML=users.map(u=>`<article class="user-card"><div class="user-top"><div class="avatar">${escapeHtml((u.name||'?')[0].toUpperCase())}</div><div><h3>${escapeHtml(u.name)}</h3><span class="role-badge ${String(u.roleSystemKey||'').toUpperCase()==='ADMIN'?'admin':''}">${escapeHtml(u.roleName||'Role')}</span> ${u.roleSystemKey?`<span class="pin-status">${escapeHtml(u.roleSystemKey)}</span>`:'<span class="pin-status">PIN</span>'}</div></div><div class="user-stats"><div><strong>${u.photoCount||0}</strong><small>Records</small></div><div><strong>${u.assetCount||0}</strong><small>Asset rows</small></div></div><div class="user-actions">${hasPermission('members.edit')?`<button class="secondary mini-btn" data-user-edit="${u.id}">Edit</button>`:''}${hasPermission('members.delete')&&String(u.id)!==String(session.member?.id)?`<button class="danger mini-btn" data-user-delete="${u.id}">Delete</button>`:''}</div></article>`).join('');document.querySelectorAll('[data-user-edit]').forEach(b=>b.onclick=()=>openUserModal(b.dataset.userEdit));document.querySelectorAll('[data-user-delete]').forEach(b=>b.onclick=()=>deleteUser(b.dataset.userDelete))}
$('addUserBtn').onclick=()=>openUserModal();
function openUserModal(id=null){editingUser=id?users.find(u=>String(u.id)===String(id)):null;$('userModalTitle').textContent=editingUser?'Edit Team Member':'Add Team Member';$('userName').value=editingUser?.name||'';$('userPin').value='';fillRoleSelects();if(editingUser)$('userRole').value=editingUser.roleId;$('userModal').classList.remove('hidden')}
$('saveUserBtn').onclick=async()=>{const pin=$('userPin').value.trim();const payload={name:$('userName').value.trim(),roleId:$('userRole').value,...(pin?{pin}:{})};if(!payload.name||!payload.roleId){toast('Name and role are required.');return}if((!editingUser&&!/^\d{4,6}$/.test(pin))||(pin&&!/^\d{4,6}$/.test(pin))){toast('Member PIN must be 4–6 digits.');return}const selectedRole=roleById(payload.roleId);if(editingUser&&String(editingUser.roleSystemKey||'').toUpperCase()==='ADMIN'&&String(selectedRole?.systemKey||'').toUpperCase()!=='ADMIN'&&activeAdmins().length<=1){$('userRole').value=editingUser.roleId;toast('At least one active Admin is compulsory. The last Admin cannot be changed to another role.',4500);return}if(!navigator.onLine){toast('Team member changes require an internet connection.');return}const btn=$('saveUserBtn');btn.disabled=true;const oldText=btn.textContent;btn.textContent='Saving…';try{let d;if(editingUser)d=await apiJson(`/members/${editingUser.id}`,{method:'PUT',body:JSON.stringify(payload)});else d=await apiJson('/members',{method:'POST',body:JSON.stringify(payload)});if(d.session){session=d.session;saveSession();updateShell()}$('userModal').classList.add('hidden');await Promise.all([refreshUsers(),refreshRoles()]);renderUsers();renderRoles();toast('Team member saved.')}catch(e){toast(e.message,4200)}finally{btn.disabled=false;btn.textContent=oldText}};
async function deleteUser(id){const target=users.find(u=>String(u.id)===String(id));if(String(target?.roleSystemKey||'').toUpperCase()==='ADMIN'&&activeAdmins().length<=1){toast('At least one active Admin is compulsory. The last Admin cannot be deleted.',4500);return}if(!navigator.onLine){toast('Team member changes require an internet connection.');return}if(!confirm('Delete this team member? Historical records retain the saved Clicked By name.'))return;try{await apiJson(`/members/${id}`,{method:'DELETE'});await Promise.all([refreshUsers(),refreshRoles()]);renderUsers();renderRoles();toast('Team member deleted.')}catch(e){toast(e.message,4200)}}

// ---------- Company / usage ----------
function fillCompanyEdit(){$('editCompanyName').value=session.company.name;$('editCompanyStartDate').value=session.company.startDate;$('editCompanyCode').value=session.company.code;$('editCompanyUsername').value=session.company.username||'';$('editCompanyPassword').value=''}
$('saveCompanyBtn').onclick=async()=>{try{const d=await apiJson('/company',{method:'PUT',body:JSON.stringify({name:$('editCompanyName').value.trim(),startDate:$('editCompanyStartDate').value,username:$('editCompanyUsername').value.trim(),newPassword:$('editCompanyPassword').value})});session.company=d.company;saveSession();updateShell();toast('Company details updated.')}catch(e){toast(e.message,4200)}};
$('deleteCompanyBtn').onclick=async()=>{const name=session.company.name;if(prompt(`Type DELETE ${name} to permanently delete this company`)!==`DELETE ${name}`)return;try{await apiJson('/company',{method:'DELETE'});clearSession();showWelcome();toast('Company deleted.')}catch(e){toast(e.message,4200)}};
async function loadUsage(){try{const d=await apiJson('/usage');const pct=Math.min(100,(d.usedBytes/R2_FREE_BYTES)*100);$('usageText').textContent=`${bytesLabel(d.usedBytes)} of 10 GB`;$('usagePercent').textContent=`${pct.toFixed(2)}%`;$('usageBar').style.width=`${pct}%`;$('usagePhotos').textContent=d.photoCount;$('usageAssets').textContent=d.assetCount;$('usageBytes').textContent=bytesLabel(d.usedBytes)}catch(e){toast(e.message)}}

// ---------- Excel export 2.0: field history, 30 MB parts, persisted download history ----------
const MAX_XLSX_BYTES=30*1000*1000;
const EXPORT_SOFT_TARGET=23*1024*1024;
const XLSX_MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const exportPhotoCache=new Map();
let exportBusy=false;

async function urlToBase64(url){
  if(String(url).startsWith('data:image/'))return url;
  const target=currentPhotoUrl(url);
  if(exportPhotoCache.has(target))return exportPhotoCache.get(target);
  const promise=(async()=>{
    const r=await fetch(target,{headers:authHeaders(false),cache:'no-store',credentials:'omit'});
    if(!r.ok){let msg='';try{const d=await r.json();msg=d.error||''}catch{}throw new Error(msg||`Photo fetch failed (${r.status})`)}
    const blob=await r.blob();if(!String(blob.type||'').startsWith('image/'))throw new Error('Photo response was not an image');
    return blobToDataUrl(blob);
  })();
  exportPhotoCache.set(target,promise);
  try{return await promise}catch(e){exportPhotoCache.delete(target);throw e}
}
function fallbackExportColumns(){return [
  {key:'srNo',label:'Sr No',active:true,sortOrder:5},{key:'photo',label:'Photo',active:true,locked:true,sortOrder:10},{key:'photoCount',label:'Photo Count',active:true,sortOrder:20},{key:'company',label:'Company',active:true,sortOrder:30},
  {key:'latitude',label:'Latitude',active:true,sortOrder:40},{key:'longitude',label:'Longitude',active:true,sortOrder:50},{key:'gpsAccuracy',label:'GPS Accuracy (m)',active:true,sortOrder:60},
  {key:'source',label:'Source',active:true,sortOrder:70},{key:'scanCode',label:'Scanned Code(s)',active:true,sortOrder:80},{key:'assetName',label:'Asset Name',active:true,sortOrder:90},
  {key:'quantity',label:'Quantity',active:true,sortOrder:100},{key:'condition',label:'Condition',active:true,sortOrder:110},{key:'verificationStatus',label:'Found Status',active:true,sortOrder:120},
  {key:'notFoundReason',label:'Not Found Reason',active:true,sortOrder:130},{key:'serialNumber',label:'Serial Number',active:true,sortOrder:140},{key:'barcode',label:'Barcode / QR / Asset Tag',active:true,sortOrder:150},
  {key:'clickedBy',label:'Clicked By',active:true,sortOrder:160},{key:'date',label:'Date',active:true,sortOrder:170},{key:'time',label:'Time',active:true,sortOrder:180},{key:'schemaVersion',label:'Schema Version',active:true,sortOrder:190}
]}
function exportColumnList(all=true){const list=(exportColumns.length?exportColumns:fallbackExportColumns()).slice().sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0));return all?list:list.filter(x=>x.active||x.locked)}
function uniqueFieldHeaders(defs){const counts=new Map();return defs.map(f=>{const base=String(f.label||'Field').trim()||'Field';const key=base.toLowerCase();const n=(counts.get(key)||0)+1;counts.set(key,n);const historical=!f.active||n>1;return {...f,exportHeader:historical?`${base} [schema ${Number(f.createdSchemaVersion||1)}]`:base}})}
function dynamicFieldValue(r,f){let v=(r.sticky&&r.sticky[f.id]!==undefined)?r.sticky[f.id]:(r.variable&&r.variable[f.id]!==undefined?r.variable[f.id]:'');if(f.type==='member'&&v)v=users.find(u=>String(u.id)===String(v))?.name||v;return v??''}
function standardExportValue(key,r,a){switch(key){case'photoCount':return currentPhotoUrls(r).length;case'company':return session.company.name;case'latitude':return r.latitude||'';case'longitude':return r.longitude||'';case'gpsAccuracy':return r.gpsAccuracy||'';case'source':return r.source||'';case'scanCode':return r.scanCode||'';case'assetName':return a?.assetName||'';case'quantity':return a?.quantity??'';case'condition':return a?.condition||'';case'verificationStatus':return a?.verificationStatus||'';case'notFoundReason':return a?.notFoundReason||'';case'serialNumber':return a?.serialNumber||'';case'barcode':return a?.barcode||'';case'clickedBy':return r.clickedByName||'';case'date':return fmtDate(r.capturedAt);case'time':return fmtTime(r.capturedAt);case'schemaVersion':return Number(r.schemaVersion||1);default:return ''}}
function roughRecordBytes(r,withPhotos){const rows=Math.max(1,(r.assets||[]).length);const photoBytes=withPhotos?Math.max(Number(r.photoSize||0),currentPhotoUrls(r).length*250000):0;return 6000+rows*2500+photoBytes*1.08}
function groupForExport(source,withPhotos){const groups=[];let cur=[],est=0;for(const r of source){const add=roughRecordBytes(r,withPhotos);if(cur.length&&est+add>EXPORT_SOFT_TARGET){groups.push(cur);cur=[];est=0}cur.push(r);est+=add}if(cur.length)groups.push(cur);return groups}
function workbookFileName(variant,partNo,totalParts=0){const v=variant==='with_photos'?'With_Photos':'Without_Photos';const suffix=totalParts>1?`_Part_${String(partNo).padStart(2,'0')}`:'';return `${session.company.code}_Physical_Verification_${v}_${isoDateInput(new Date())}${suffix}.xlsx`}

async function addVerificationSheet(wb,name,subset,{withPhotos=false,currentSchema=false}={}){
  const ws=wb.addWorksheet(name);
  const allDefs=uniqueFieldHeaders(currentSchema?[...(fields.sticky||[]),...(fields.variable||[])]:[...(fields.allFields||[])]);
  const standards=exportColumnList(!currentSchema).filter(c=>c.key!=='photo');
  const photoEnabled=withPhotos&&exportColumnList(!currentSchema).some(c=>c.key==='photo'&&(c.active||c.locked));
  const maxPhotos=photoEnabled?Math.min(12,Math.max(1,...subset.map(r=>currentPhotoUrls(r).length))):0;

  // Version-1-style layout: Sr No first, then Photo column(s), then the rest.
  // This fixes the 2.x anchor bug where images were drawn one column to the
  // right of their Photo headers.
  const srDef=standards.find(c=>c.key==='srNo')||null;
  const otherStandards=standards.filter(c=>c.key!=='srNo');
  const srCols=srDef?[{header:srDef.label,key:'std_srNo',width:8,column:srDef}]:[];
  const photoCols=Array.from({length:maxPhotos},(_,i)=>({header:maxPhotos===1?'Photo':`Photo ${i+1}`,key:`photo_${i}`,width:24}));
  const stdCols=otherStandards.map(c=>({header:c.label,key:`std_${c.key}`,width:['company','assetName','scanCode','barcode'].includes(c.key)?28:16,column:c}));
  const dynCols=allDefs.map((f,i)=>({header:f.exportHeader,key:`dyn_${i}`,width:20,field:f}));
  ws.columns=[...srCols,...photoCols,...stdCols,...dynCols];
  ws.views=[{state:'frozen',ySplit:1}];
  ws.getRow(1).font={bold:true};
  ws.getRow(1).alignment={vertical:'middle',horizontal:'center',wrapText:true};
  ws.getRow(1).height=24;
  ws.autoFilter={from:{row:1,column:1},to:{row:1,column:ws.columns.length}};

  const photoStartCol=srCols.length; // zero-based ExcelJS drawing coordinate
  let sr=0,rowNo=2,embedded=0,failed=0;
  for(const r of subset){
    const assets=(r.assets&&r.assets.length)?r.assets:[{}];
    let photoIds=[];
    if(photoEnabled){
      const urls=currentPhotoUrls(r).slice(0,maxPhotos);
      for(const u of urls){
        try{
          const data=await urlToBase64(u);
          const match=String(data).match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
          if(!match)throw new Error('Unsupported image format');
          const ext=match[1].toLowerCase()==='png'?'png':'jpeg';
          photoIds.push(wb.addImage({base64:match[2],extension:ext}));embedded++;
        }catch(e){console.error('Excel photo embed failed:',e);photoIds.push(null);failed++}
      }
    }

    for(let ai=0;ai<assets.length;ai++){
      const a=assets[ai];sr++;
      const obj={};
      if(srDef)obj.std_srNo=sr;
      otherStandards.forEach(c=>obj[`std_${c.key}`]=standardExportValue(c.key,r,a));
      allDefs.forEach((f,i)=>obj[`dyn_${i}`]=dynamicFieldValue(r,f));
      const row=ws.addRow(obj);
      row.alignment={vertical:'middle',wrapText:true};

      if(photoEnabled){
        row.height=82;
        // As in Version 1, every exported asset row carries the record photo,
        // keeping the visual evidence aligned with the row it supports.
        photoIds.forEach((id,i)=>{
          if(id===null)return;
          ws.addImage(id,{
            tl:{col:photoStartCol+i+0.06,row:rowNo-1+0.06},
            ext:{width:140,height:96},
            editAs:'oneCell'
          });
        });
      }else row.height=20;
      rowNo++;
    }
  }
  return {embedded,failed};
}
function addFieldHistorySheet(wb){
  const ws=wb.addWorksheet('Field History');
  ws.columns=[{header:'Field ID',key:'id',width:38},{header:'Group',key:'group',width:12},{header:'Label',key:'label',width:28},{header:'Type',key:'type',width:14},{header:'Status',key:'status',width:12},{header:'Created Schema',key:'createdSchema',width:16},{header:'Deactivated Schema',key:'deactivatedSchema',width:19},{header:'Created At',key:'createdAt',width:22},{header:'Deactivated At',key:'deactivatedAt',width:22}];
  ws.getRow(1).font={bold:true};
  for(const f of fields.allFields||[])ws.addRow({id:f.id,group:f.group||((fields.sticky||[]).some(x=>x.id===f.id)?'sticky':'variable'),label:f.label,type:f.type,status:f.active?'Active':'Historical',createdSchema:Number(f.createdSchemaVersion||1),deactivatedSchema:f.deactivatedSchemaVersion??'',createdAt:f.createdAt||'',deactivatedAt:f.deactivatedAt||''});
}
function addExportInfoSheet(wb,variant,subset){const ws=wb.addWorksheet('Export Info');ws.columns=[{header:'Item',key:'item',width:26},{header:'Value',key:'value',width:50}];ws.getRow(1).font={bold:true};[['Company',session.company.name],['Company Code',session.company.code],['Variant',variant==='with_photos'?'With Photos':'Without Photos'],['Exported At',new Date().toISOString()],['Record Count',subset.length],['Current Schema Version',Number(fields.schemaVersion||1)],['Maximum Excel Part Size','30 MB']].forEach(([item,value])=>ws.addRow({item,value}))}
async function buildWorkbookBuffer(subset,variant){
  const wb=new ExcelJS.Workbook();wb.creator='PRS.AssetVerify 2.0';wb.created=new Date();
  const withPhotos=variant==='with_photos';
  const stats=await addVerificationSheet(wb,'All Records',subset,{withPhotos,currentSchema:false});
  await addVerificationSheet(wb,'Current Schema',subset,{withPhotos:false,currentSchema:true});
  addFieldHistorySheet(wb);addExportInfoSheet(wb,variant,subset);
  const buffer=await wb.xlsx.writeBuffer();return {buffer,stats};
}
async function buildSizedParts(subset,variant){
  const groups=groupForExport(subset,variant==='with_photos'),parts=[];
  async function fit(group){
    const built=await buildWorkbookBuffer(group,variant);
    if(built.buffer.byteLength<=MAX_XLSX_BYTES){parts.push({records:group,buffer:built.buffer,size:built.buffer.byteLength,stats:built.stats});return}
    if(group.length<=1)throw new Error('A single verification record exceeds the 30 MB Excel limit even after image compression. Reduce the number of photos on that record.');
    const mid=Math.max(1,Math.floor(group.length/2));await fit(group.slice(0,mid));await fit(group.slice(mid));
  }
  for(const group of groups)await fit(group);
  return parts;
}
async function uploadExportPart(exportId,variant,partNo,fileName,buffer){
  const q=new URLSearchParams({variant,part:String(partNo),name:fileName});
  let r;try{r=await fetch(`${WORKER_URL}/exports/${encodeURIComponent(exportId)}/files?${q}`,{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':XLSX_MIME},body:buffer})}catch(e){throw new Error(navigator.onLine?'Could not upload the generated Excel part to Download History.':'You went offline while saving the export history.')}
  const text=await r.text();let d={};try{d=JSON.parse(text)}catch{}if(!r.ok)throw new Error(d.error||`Export upload failed (${r.status})`);return d.file;
}
function saveBlob(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),3000)}
async function downloadBuffersTogether(parts,variant){
  if(parts.length===1){saveBlob(new Blob([parts[0].buffer],{type:XLSX_MIME}),parts[0].fileName);return}
  if(!window.JSZip)throw new Error('ZIP library is not loaded.');const zip=new JSZip();for(const p of parts)zip.file(p.fileName,p.buffer);const blob=await zip.generateAsync({type:'blob',compression:'STORE'});saveBlob(blob,`${session.company.code}_${variant==='with_photos'?'With_Photos':'Without_Photos'}_${isoDateInput(new Date())}.zip`)
}
async function generateExportSnapshot(preferredVariant){
  if(exportBusy)return;exportBusy=true;exportPhotoCache.clear();const progress=$('exportProgress');let exportId='';let completed=false;
  try{
    if(!navigator.onLine)throw new Error('Export history requires an internet connection.');
    if(!window.ExcelJS)throw new Error('Excel library is not loaded.');
    await Promise.all([refreshFields(),refreshExportColumns(),refreshRecords()]);
    if(!records.length)throw new Error('No records to export.');
    const start=await apiJson('/exports/start',{method:'POST',body:JSON.stringify({recordCount:records.length})});
    exportId=start.exportId;
    const order=preferredVariant==='without_photos'?['without_photos','with_photos']:['with_photos','without_photos'];
    const generated={with_photos:[],without_photos:[]};
    for(const variant of order){
      progress.textContent=`Building ${variant==='with_photos'?'export with photos':'export without photos'}…`;
      const built=await buildSizedParts(records.slice(),variant);
      for(let i=0;i<built.length;i++){
        const fileName=workbookFileName(variant,i+1,built.length);built[i].fileName=fileName;
        progress.textContent=`Saving ${variant==='with_photos'?'photo':'no-photo'} Excel part ${i+1} of ${built.length} to Download History…`;
        await uploadExportPart(exportId,variant,i+1,fileName,built[i].buffer);
      }
      generated[variant]=built;
    }
    await apiJson(`/exports/${encodeURIComponent(exportId)}/complete`,{method:'POST',body:'{}'});completed=true;
    progress.textContent='Both export variants are ready and stored in Download History.';
    await refreshDownloadHistory();
    await downloadBuffersTogether(generated[preferredVariant],preferredVariant);
    toast(`Export complete. Both variants are stored in Download History.`,5200);
    setTimeout(()=>$('exportModal').classList.add('hidden'),500);
  }catch(e){console.error(e);if(exportId&&!completed){try{await apiJson(`/exports/${encodeURIComponent(exportId)}`,{method:'DELETE'})}catch(cleanupError){console.warn('Export cleanup failed',cleanupError)}}progress.textContent=e.message||'Export failed.';toast(e.message||'Could not generate export.',5500)}finally{exportBusy=false}
}
$('exportBtn').onclick=()=>{if(!hasPermission('records.export'))return;if(!records.length){toast('No records to export.');return}$('exportProgress').textContent='Both variants will be generated and retained in Download History.';$('exportModal').classList.remove('hidden')};
$('exportWithPhotosBtn').onclick=()=>generateExportSnapshot('with_photos');
$('exportWithoutPhotosBtn').onclick=()=>generateExportSnapshot('without_photos');

async function refreshDownloadHistory(){
  if(!session?.member||!hasPermission('records.export'))return;
  try{const d=await apiJson('/exports');exportHistory=d.exports||[];renderDownloadHistory()}catch(e){toast(e.message||'Could not load download history.',4200)}
}
function renderDownloadHistory(){
  const c=$('downloadHistoryList'),empty=$('downloadHistoryEmpty');if(!c)return;
  empty.classList.toggle('hidden',exportHistory.length>0);
  c.innerHTML=exportHistory.map(job=>{const withCount=(job.files||[]).filter(f=>f.variant==='with_photos').length,noCount=(job.files||[]).filter(f=>f.variant==='without_photos').length;return `<article class="card download-history-item"><div><div class="eyebrow">${escapeHtml(fmtDate(job.createdAt))} · ${escapeHtml(fmtTime(job.createdAt))}</div><h3>${escapeHtml(job.memberName||'Member')} · ${Number(job.recordCount||0)} records</h3><p class="muted">Schema ${Number(job.schemaVersion||1)} · ${escapeHtml(job.status||'')}</p></div><div class="history-actions"><button class="primary mini-btn" data-history-download="${job.id}" data-history-variant="with_photos" ${withCount?'':'disabled'}>With Photos (${withCount})</button><button class="secondary mini-btn" data-history-download="${job.id}" data-history-variant="without_photos" ${noCount?'':'disabled'}>Without Photos (${noCount})</button></div></article>`}).join('');
  document.querySelectorAll('[data-history-download]').forEach(b=>b.onclick=()=>downloadHistoryVariant(b.dataset.historyDownload,b.dataset.historyVariant));
}
async function fetchStoredExportFile(jobId,file){
  const r=await fetch(`${WORKER_URL}/exports/${encodeURIComponent(jobId)}/file/${encodeURIComponent(file.id)}`,{headers:{Authorization:`Bearer ${session.token}`},cache:'no-store'});if(!r.ok){let d={};try{d=await r.json()}catch{}throw new Error(d.error||`Stored export download failed (${r.status})`)}return r.arrayBuffer();
}
async function downloadHistoryVariant(jobId,variant){
  const job=exportHistory.find(x=>String(x.id)===String(jobId));if(!job)return;const files=(job.files||[]).filter(f=>f.variant===variant).sort((a,b)=>a.partNo-b.partNo);if(!files.length){toast('This export variant has no stored files.');return}
  try{toast(`Preparing ${files.length} stored Excel file${files.length===1?'':'s'}…`,4000);if(files.length===1){const buf=await fetchStoredExportFile(jobId,files[0]);saveBlob(new Blob([buf],{type:XLSX_MIME}),files[0].fileName);return}if(!window.JSZip)throw new Error('ZIP library is not loaded.');const zip=new JSZip();for(let i=0;i<files.length;i++){const buf=await fetchStoredExportFile(jobId,files[i]);zip.file(files[i].fileName,buf)}const blob=await zip.generateAsync({type:'blob',compression:'STORE'});saveBlob(blob,`${session.company.code}_${variant==='with_photos'?'With_Photos':'Without_Photos'}_History_${isoDateInput(new Date(job.createdAt))}.zip`)}catch(e){toast(e.message||'Could not download stored export.',5000)}
}
$('refreshDownloadHistoryBtn').onclick=refreshDownloadHistory;

// ---------- Version 2.0 complete backup & restore ----------
$('downloadBackupBtn').onclick=async()=>{if(!hasPermission('backup.manage'))return;if(!navigator.onLine){toast('Reconnect to download a cloud backup.',3500);return}toast('Preparing complete company backup. Photos may take a moment…',6000);try{const d=await apiJson('/backup');const backup=d.backup;if(!backup)throw new Error('Backup data was not returned');const blob=new Blob([JSON.stringify(backup)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${session.company.code}_PRS_AssetVerify_Backup_${isoDateInput(new Date())}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),3000);toast('Complete company backup downloaded. Keep the file secure.',4500)}catch(e){toast(e.message||'Could not create backup.',4500)}};
$('restoreBackupBtn').onclick=async()=>{if(!hasPermission('backup.manage'))return;const file=$('restoreBackupInput').files?.[0];if(!file){toast('Select a PRS.AssetVerify backup JSON file first.');return}if(!navigator.onLine){toast('Restore requires an internet connection.');return}if(!confirm('Restore this backup? Current roles, members, masters, audit trail, records and photos in this company will be replaced. Company username/password and company code will remain unchanged.'))return;try{const backup=JSON.parse(await file.text());toast('Restoring backup and photos…',7000);const d=await apiJson('/restore',{method:'POST',body:JSON.stringify({backup})});session={...session,company:d.company||session.company,member:null};saveSession();roles=[];fields={sticky:[],variable:[],allFields:[],schemaVersion:1};exportColumns=[];exportHistory=[];records=[];await cacheSet('records',[]);await refreshUsers();$('restoreBackupInput').value='';updateShell();toast('Backup restored. Re-select a team member using the restored PIN.',5000);showMemberSelector()}catch(e){console.error(e);toast(e.message||'Restore failed.',5000)}};

// ---------- Offline database + automatic sync (2.0 isolated store) ----------
function openOfflineDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(OFFLINE_DB_NAME,OFFLINE_DB_VERSION);req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('cache'))db.createObjectStore('cache',{keyPath:'key'});if(!db.objectStoreNames.contains('queue')){const q=db.createObjectStore('queue',{keyPath:'id'});q.createIndex('companyId','companyId',{unique:false})}};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function idbGet(store,key){const db=await openOfflineDb();return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readonly'),req=tx.objectStore(store).get(key);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);tx.oncomplete=()=>db.close()})}
async function idbPut(store,value){const db=await openOfflineDb();return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value);tx.oncomplete=()=>{db.close();resolve(value)};tx.onerror=()=>{db.close();reject(tx.error)}})}
async function idbDelete(store,key){const db=await openOfflineDb();return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).delete(key);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>{db.close();reject(tx.error)}})}
async function idbAll(store){const db=await openOfflineDb();return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readonly'),req=tx.objectStore(store).getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);tx.oncomplete=()=>db.close()})}
function companyCacheKey(type){return `${session?.company?.id||'none'}:${type}`}
async function cacheSet(type,value){if(!session?.company?.id)return;try{await idbPut('cache',{key:companyCacheKey(type),value,updatedAt:new Date().toISOString()})}catch(e){console.warn('Offline cache write failed',e)}}
async function cacheGet(type){if(!session?.company?.id)return null;try{return (await idbGet('cache',companyCacheKey(type)))?.value??null}catch{return null}}
function isNetworkError(e){const m=String(e?.message||e||'');return !navigator.onLine||e instanceof TypeError||/Failed to fetch|NetworkError|Load failed|Offline/i.test(m)}
async function companyQueue(){if(!session?.company?.id)return [];try{return (await idbAll('queue')).filter(x=>String(x.companyId)===String(session.company.id)).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt))}catch{return []}}
async function queueOfflineAction(method,path,payload,tempRecord){const item={id:uid(),companyId:session.company.id,memberId:session.member?.id||'',method,path,payload,tempRecord,createdAt:new Date().toISOString(),attempts:0,lastError:''};await idbPut('queue',item);await updateSyncUi();return item}
function buildOptimisticRecord(payload){const clicked=users.find(u=>String(u.id)===String(payload.clickedByMemberId)),urls=(payload.photos||[]).map(p=>p.dataUrl).filter(Boolean);if(!urls.length&&payload.photo)urls.push(payload.photo);return {id:`local-${payload.clientId}`,clientId:payload.clientId,photoName:payload.photoName||'',photoSize:payload.photoSize||0,photoUrl:urls[0]||'',photoUrls:urls,photoCount:urls.length,capturedAt:payload.capturedAt,createdAt:new Date().toISOString(),source:payload.source||'camera',scanCode:payload.scanCode||'',latitude:payload.latitude||'',longitude:payload.longitude||'',gpsAccuracy:payload.gpsAccuracy||'',sticky:payload.sticky||{},variable:payload.variable||{},clickedByUserId:payload.clickedByMemberId||'',clickedByName:clicked?.name||session.member?.name||'',assets:payload.assets||[],schemaVersion:Number(fields.schemaVersion||1),localPending:true}}
async function applyQueueOverlay(base){let out=(base||[]).map(x=>({...x}));const q=await companyQueue();for(const item of q){if(item.method==='POST'&&item.path==='/records'&&item.tempRecord){if(!out.some(r=>String(r.clientId)===String(item.tempRecord.clientId)))out.push({...item.tempRecord,localPending:true})}else if(item.method==='PUT'&&item.tempRecord){const i=out.findIndex(r=>String(r.id)===String(item.tempRecord.id));if(i>=0)out[i]={...out[i],...item.tempRecord,localPending:true}}else if(item.method==='DELETE'){const id=item.path.split('/').pop();out=out.filter(r=>String(r.id)!==String(id))}}return out}
async function removePendingCreate(clientId){const q=await companyQueue();for(const item of q)if(item.method==='POST'&&String(item.payload?.clientId)===String(clientId))await idbDelete('queue',item.id);await updateSyncUi()}
async function updatePendingCreate(clientId,changes){const q=await companyQueue(),item=q.find(x=>x.method==='POST'&&String(x.payload?.clientId)===String(clientId));if(!item)return;item.payload={...item.payload,...changes};item.tempRecord={...buildOptimisticRecord(item.payload),id:item.tempRecord?.id||`local-${clientId}`,createdAt:item.tempRecord?.createdAt||new Date().toISOString()};await idbPut('queue',item);await updateSyncUi()}
async function syncQueue(){if(syncRunning||!navigator.onLine||!session?.member)return;syncRunning=true;await updateSyncUi();let synced=0,failed=0;try{const q=await companyQueue();for(const item of q){try{const options={method:item.method};if(item.payload!==null&&item.payload!==undefined)options.body=JSON.stringify(item.payload);await apiJson(item.path,options);await idbDelete('queue',item.id);synced++}catch(e){if(isNetworkError(e))break;item.attempts=(item.attempts||0)+1;item.lastError=String(e.message||e);await idbPut('queue',item);failed++;if(/Authentication required|session expired/i.test(item.lastError))break}}}finally{syncRunning=false;await updateSyncUi()}if(synced){toast(`${synced} offline item${synced===1?'':'s'} synced to cloud.`,3500);try{const d=await apiJson('/records');await cacheSet('records',d.records||[])}catch{}}if(failed)toast(`${failed} queued item${failed===1?'':'s'} still need attention.`,4200)}
async function updateSyncUi(){const badge=$('syncBadge');if(!badge)return;badge.classList.remove('offline','pending','syncing');const count=(await companyQueue()).length;if(!navigator.onLine){badge.textContent=count?`Offline · ${count} pending`:'Offline';badge.classList.add('offline')}else if(syncRunning){badge.textContent=count?`Syncing ${count}…`:'Syncing…';badge.classList.add('syncing')}else if(count){badge.textContent=`${count} pending`;badge.classList.add('pending')}else badge.textContent='Cloud'}
function updateOfflineNotice(){const n=$('offlineNotice');if(n)n.classList.toggle('hidden',navigator.onLine)}

// ---------- Audit Trail ----------
async function refreshAudit(){if(!session?.member)return;try{const d=await apiJson('/audit?limit=300');auditEvents=d.events||[];await cacheSet('audit',auditEvents)}catch(e){auditEvents=(await cacheGet('audit'))||[];if(navigator.onLine&&!isNetworkError(e))toast(e.message,3500)}renderAudit()}
function auditDetailsText(details){if(!details||typeof details!=='object')return '';const parts=[];for(const [k,v] of Object.entries(details)){if(v===null||v===undefined||v==='')continue;let txt=typeof v==='object'?JSON.stringify(v):String(v);if(txt.length>260)txt=txt.slice(0,257)+'…';parts.push(`${k}: ${txt}`)}return parts.join(' · ')}
function renderAudit(){const q=$('auditSearch').value.trim().toLowerCase();const rows=auditEvents.filter(e=>{const hay=[e.action,e.entityType,e.entityId,e.memberName,auditDetailsText(e.details)].join(' ').toLowerCase();return !q||hay.includes(q)});$('auditList').innerHTML=rows.map(e=>`<article class="audit-event"><div class="audit-event-head"><div><span class="audit-action">${escapeHtml(String(e.action||'event').replaceAll('.',' · '))}</span><h3>${escapeHtml(e.memberName||'System')}</h3><p>${escapeHtml(e.entityType||'')} ${e.entityId?`· ${escapeHtml(e.entityId)}`:''}</p><p>${escapeHtml(auditDetailsText(e.details))}</p></div><div class="audit-meta">${fmtDate(e.createdAt)}<br>${fmtTime(e.createdAt)}</div></div></article>`).join('');$('auditEmpty').classList.toggle('hidden',rows.length>0)}
$('refreshAuditBtn').onclick=refreshAudit;$('auditSearch').addEventListener('input',renderAudit);$('clearAuditBtn').onclick=()=>{$('auditSearch').value='';renderAudit()};

// ---------- Visual viewport / always reachable close buttons ----------
function setupVisualViewport(){const update=()=>{const vv=window.visualViewport;document.documentElement.style.setProperty('--visual-viewport-height',`${Math.round(vv?.height||window.innerHeight)}px`);document.documentElement.style.setProperty('--visual-viewport-offset-top',`${Math.round(vv?.offsetTop||0)}px`)};update();window.addEventListener('resize',update);window.addEventListener('orientationchange',update);if(window.visualViewport){window.visualViewport.addEventListener('resize',update);window.visualViewport.addEventListener('scroll',update)}}

document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;const visibleModal=[...document.querySelectorAll('.modal:not(.hidden)')].pop();if(visibleModal){if(visibleModal.id==='scannerModal'){closeScanner();return}if(visibleModal.id==='detailModal'){pendingRecord=null;aiSeq++;visibleModal.classList.add('hidden');return}if(visibleModal.id==='memberSelectModal'){ $('closeMemberSelectBtn').click(); return }visibleModal.classList.add('hidden');return}if(!$('drawer').classList.contains('hidden')){closeDrawer();return}if(!$('viewExitBtn').classList.contains('hidden'))$('viewExitBtn').click()});

async function health(){try{await fetch(WORKER_URL)}catch{}}
window.addEventListener('online',async()=>{updateOfflineNotice();await updateSyncUi();await syncQueue();await refreshRecords()});window.addEventListener('offline',()=>{updateOfflineNotice();updateSyncUi()});setupVisualViewport();health();restoreSession();if('serviceWorker' in navigator)window.addEventListener('load',async()=>{try{const reg=await navigator.serviceWorker.register('./sw.js?v=210');try{await reg.update()}catch{};let reloading=false;navigator.serviceWorker.addEventListener('controllerchange',()=>{if(reloading)return;reloading=true;location.reload()})}catch(error){console.error('Service worker registration failed',error)}});