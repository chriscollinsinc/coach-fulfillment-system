/* Coach Fulfillment System — frontend */
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MO = MONTHS.map(m=>m.slice(0,3));
const TODAY = new Date().toISOString().slice(0,10);
const fmt = iso => { if(!iso) return '—'; const [y,m,d]=iso.split('-'); return `${MO[+m-1]} ${+d}, ${y}`; };
const fmtW = iso => { const [y,m,d]=iso.split('-'); return `${MO[+m-1]} ${+d}`; };
const dayDiff = (a,b)=>(new Date(a)-new Date(b))/864e5;
const CYCLE_LEN = {'Monthly':12,'Semi-Monthly':6,'Quarterly':4,'Bi-Annual':2,'LID (Purchase)':1,'6 Visits Monthly':6,'Coaching Only':0};
const INTERVAL  = {'Monthly':1,'Semi-Monthly':2,'Quarterly':3,'Bi-Annual':6,'LID (Purchase)':0,'6 Visits Monthly':1,'Coaching Only':0};
const PROGRAMS = Object.keys(CYCLE_LEN);
const BLOCKKINDS = {home:'Home',off:'Off / Vacation',training:'Training',bootcamp:'Bootcamp',event:'Event (Top Dog / Virtual)',truck:'TRUCK',travel:'Travel',mag:'Mills (M.A.G.)',launch_open:'Launch slot held',soft_pencil:'Soft pencil hold (tentative launch)',not_hired:'Not hired yet',shadow:'Shadow',meeting:'Meeting',blocked:'Blocked',visit:'Legacy visit (from sheet)',visit_legacy:'Legacy visit (from sheet)'};

/* Avatar — initials on a color derived from the team name, so every coach on a team
   reads as visually related without needing an upload/storage pipeline. */
const AVATAR_PALETTE = ['#F15F43','#1d4f91','#c77d0a','#1e8e5a','#7a4fb5','#2a8a8a','#b93c22','#5a6a8a'];
function avatarColor(team){ let h=0; for(const ch of String(team||'')) h=(h*31+ch.charCodeAt(0))>>>0; return AVATAR_PALETTE[h%AVATAR_PALETTE.length]; }
function initials(name){ const parts=String(name||'').trim().split(/\s+/); return ((parts[0]?.[0]||'')+(parts[parts.length-1]?.[0]||'')).toUpperCase() || '?'; }
function avatarHtml(name, team, size){
  size = size || 32;
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:${avatarColor(team)};color:#fff;font-family:var(--head);font-weight:600;font-size:${Math.round(size*0.4)}px;flex:none;line-height:1">${esc(initials(name))}</span>`;
}

/* Mondays helpers */
function mondayOf(d){ const x=new Date(d); const dow=(x.getDay()+6)%7; x.setDate(x.getDate()-dow); return x.toISOString().slice(0,10); }
function addDays(iso,n){ const d=new Date(iso+'T12:00:00'); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }
function mondaysInMonth(y,m){ // m 0-based
  const out=[]; let w=mondayOf(new Date(Date.UTC(y,m,1,12)));
  if(+w.slice(5,7)!==m+1) w=addDays(w,7);
  while(+w.slice(5,7)===m+1 && +w.slice(0,4)===y){ out.push(w); w=addDays(w,7); }
  return out;
}
function mondaysRange(fromIso,toIso){ const out=[]; let w=mondayOf(new Date(fromIso+'T12:00:00')); if(w<fromIso) w=addDays(w,7); while(w<=toIso){ out.push(w); w=addDays(w,7);} return out; }

/* ---------- app state ---------- */
let D = null;   // server state {user, teams, coaches, blocks, visits, users?}
let ssoEnabled;  // undefined = not checked yet, else true/false — set once from /api/sso-config on the login screen
let st = {
  view:'dashboard', boardTeam:null,
  boardY:+TODAY.slice(0,4), boardM:+TODAY.slice(5,7)-1,
  placing:null, detail:null,
  invFilter:'attention', invSearch:'',
  due2027:false,
};
let occ = null; // occupancy map coach|week -> {type:'visit'|'block', ...}

async function api(method, url, body){
  const r = await fetch(url,{method, headers:{'Content-Type':'application/json'}, body:body?JSON.stringify(body):undefined});
  const j = await r.json().catch(()=>({}));
  if(r.status===401){ D=null; render(); throw new Error('signed out'); }
  if(!r.ok){
    const msg = j.error || (r.status===409 ? 'Someone else just changed this — refresh and try again'
      : r.status===403 ? "You don't have permission to do that"
      : r.status>=500 ? 'Something went wrong on the server — try again in a moment'
      : 'That didn\'t work — check the form and try again');
    toast(msg); throw new Error(msg);
  }
  return j;
}
async function refresh(){
  D = await api('GET','/api/state');
  _gsClients = null; // stale after any data change — refetched on next search keystroke
  occ = {};
  for(const b of D.blocks) occ[b.coach_id+'|'+b.week] = {type:'block', kind:b.kind, label:b.label};
  for(const v of D.visits) if(v.cal_coach && v.cal_week)
    occ[v.cal_coach+'|'+v.cal_week] = {type:'visit', v};
  if(!st.boardTeam) st.boardTeam = D.user.team || D.teams[0];
  render();
}
const coach = id => D.coaches.find(c=>c.id===id);
const status = v => v.completed?'completed': v.cal_week?'on_calendar': (v.due&&v.due<TODAY?'overdue': v.due?'needs_scheduling':'unknown');
const isOpen = (cid,w) => !occ[cid+'|'+w];
const canEdit = () => ['admin','lead'].includes(D.user.role);
// A coach can complete a visit only if they're the one who scheduled it (cal_coach)
// or the one permanently assigned to the client (client_assigned_coach_id) — this is
// a UI convenience mirror of the server-side check in server.js's canCompleteVisit;
// the server re-derives and enforces this independently, so this never has to be
// trusted as the real security boundary.
const ownsVisit = v => D.user.role==='coach' && ((v.cal_coach && v.cal_coach===D.user.coach_id) || (v.client_assigned_coach_id && v.client_assigned_coach_id===D.user.coach_id));
const myTeams = () => D.user.role==='admin' ? D.teams : [D.user.team];

function toast(msg, undo){
  const t=$('#toast');
  t.innerHTML = esc(msg) + (undo?` <button onclick="undoAction()">Undo</button>`:'');
  window._undo = undo||null;
  t.classList.add('show');
  clearTimeout(window._toastT);
  window._toastT = setTimeout(()=>t.classList.remove('show'), undo?6000:2600);
}
async function undoAction(){ if(window._undo){ const f=window._undo; window._undo=null; $('#toast').classList.remove('show'); await f(); await refresh(); toast('Undone'); } }
function openDlg(html){ const d=$('#dlg'); d.innerHTML=html; d.showModal(); }
function closeDlg(){ $('#dlg').close(); }
/* Styled stand-ins for window.alert/confirm — same look as the rest of the app,
   stack safely on top of an already-open dialog (#dlg2 over #dlg). */
function uiAlert(msg){
  return new Promise(res=>{
    const d=$('#dlg2');
    d.innerHTML=`<p style="font-size:13.5px;white-space:pre-wrap">${esc(msg)}</p>
      <div class="dlgrow"><button class="btn primary" id="ua-ok">OK</button></div>`;
    d.showModal();
    $('#ua-ok').onclick=()=>{ d.close(); res(); };
    $('#ua-ok').focus();
  });
}
function uiConfirm(msg, yesLabel){
  return new Promise(res=>{
    const d=$('#dlg2');
    d.innerHTML=`<p style="font-size:13.5px;white-space:pre-wrap">${esc(msg)}</p>
      <div class="dlgrow"><button class="btn" id="uc-no">Cancel</button>
      <button class="btn primary ${/delete|release/i.test(yesLabel||'')?'danger':''}" id="uc-yes">${esc(yesLabel||'Confirm')}</button></div>`;
    d.showModal();
    $('#uc-no').onclick=()=>{ d.close(); res(false); };
    $('#uc-yes').onclick=()=>{ d.close(); res(true); };
    d.oncancel=()=>res(false);
  });
}

/* ---------- shell ---------- */
function render(){
  const app=$('#app');
  // Preserve focus + cursor/selection across a full re-render. Several inputs (e.g.
  // the Inventory search box) call render() directly on every keystroke instead of
  // patching just their own section — without this, replacing innerHTML creates a
  // brand-new node each time and steals focus, so typing a second character requires
  // clicking back into the field first.
  const activeEl = document.activeElement;
  const focusId = activeEl && app.contains(activeEl) && activeEl.id ? activeEl.id : null;
  const selStart = focusId && typeof activeEl.selectionStart === 'number' ? activeEl.selectionStart : null;
  const selEnd = focusId && typeof activeEl.selectionEnd === 'number' ? activeEl.selectionEnd : null;
  const restoreFocus = () => {
    if(!focusId) return;
    const el = document.getElementById(focusId);
    if(!el) return;
    el.focus();
    if(selStart != null && typeof el.setSelectionRange === 'function'){
      try{ el.setSelectionRange(selStart, selEnd); }catch(e){}
    }
  };
  if(!D){
    const resetToken = new URLSearchParams(location.search).get('reset');
    app.innerHTML = resetToken ? resetView(resetToken) : loginView();
    return;
  }
  const views = {};
  const r = D.user.role;
  const hasPending = (r==='admin'||r==='lead');
  views.dashboard='Today';
  if(hasPending) views.board='Schedule Board';
  views.inventory = r==='coach' ? 'My Visits' : 'LID Inventory';
  views.clients='Clients'; // dropdown for admin/lead (Active Clients + Unassigned Clients); plain link otherwise
  views.availability='Availability';
  if(r==='coach'||D.user.coach_id) views.mysched='My Schedule';
  if(r==='coach' && D.user.coach_id) views.myprofile='My Profile';
  if(r==='admin') views.admin='Admin';
  views.faq='FAQ';
  if(!views[st.view] && st.view!=='clientprofile' && st.view!=='coachprofile' && !(st.view==='pending'&&hasPending)){
    // First landing: leads live on the Schedule Board day-to-day, not the capacity dashboard
    st.view = r==='lead' ? 'board' : Object.keys(views)[0];
  }
  const pendingN = D.pendingClientCount||0;
  const navHtml = Object.entries(views).map(([k,v])=>{
    if(k==='clients' && hasPending){
      const open = st.view==='clients'||st.view==='clientprofile'||st.view==='pending';
      return `<div class="navdrop${open?' open':''}">
        <button class="${open?'active':''}" onclick="toggleNavDrop(event)">Clients ▾</button>
        <div class="navdrop-menu">
          <a onclick="closeNavDrop();go('clients')">Active Clients</a>
          <a onclick="closeNavDrop();go('pending')">Unassigned Clients${pendingN?` (${pendingN})`:''}</a>
        </div>
      </div>`;
    }
    const active = st.view===k||(k==='clients'&&st.view==='clientprofile')||(k==='myprofile'&&st.view==='coachprofile'&&st.coachId===D.user.coach_id);
    return `<button class="${active?'active':''}" onclick="${k==='myprofile'?`openCoachProfile('${D.user.coach_id}')`:`go('${k}')`}">${v}</button>`;
  }).join('');
  app.innerHTML = `
  <header>
    <img class="logo" src="https://chriscollinsinc.com/wp-content/uploads/2020/03/logo-1.png" onerror="this.style.display='none'" alt="">
    <h1>Coach Fulfillment</h1>
    <nav>${navHtml}</nav>
    <div class="gsearch">
      <input id="gSearch" placeholder="Find a client or coach…" autocomplete="off"
        oninput="globalSearch(this.value)" onfocus="globalSearch(this.value)" onkeydown="if(event.key==='Escape'){this.value='';$('#gsResults').innerHTML='';this.blur()}">
      <div id="gsResults" class="gsearch-results"></div>
    </div>
    <div class="userchip" style="display:flex;align-items:center;gap:8px">
      ${avatarHtml(D.user.name, D.user.team, 30)}
      <span>${esc(D.user.name)} · ${D.user.role}${D.user.team?' · '+D.user.team:''}<br>
      <a onclick="pwDlg()">password</a> · <a onclick="logout()">sign out</a></span></div>
  </header>
  <main id="main"></main>`;
  const m=$('#main');
  if(st.view==='dashboard'){ m.innerHTML=dashboard(); loadToday(); }
  if(st.view==='board') m.innerHTML=board();
  if(st.view==='inventory') m.innerHTML=inventory();
  if(st.view==='pending'){ m.innerHTML=pendingView(); loadPending(); }
  if(st.view==='clients'){ m.innerHTML=clientsView(); loadClients(); }
  if(st.view==='clientprofile'){ m.innerHTML='<div class="panel">Loading…</div>'; loadClientProfile(st.clientId); }
  if(st.view==='coachprofile'){ m.innerHTML='<div class="panel">Loading…</div>'; loadCoachProfile(st.coachId); }
  if(st.view==='availability'){ m.innerHTML=availabilityView(); runAvail(); }
  if(st.view==='mysched') m.innerHTML=mySchedule();
  if(st.view==='admin'){
    m.innerHTML=adminView();
    const tab = st.adminTab || 'people';
    if(tab==='people'){ loadFormerCoaches(); }
    if(tab==='data'){ loadCancelledContracts(); loadDeletedClients(); loadRevenueHistory(); loadBackupStatus(); loadKeapEvents(); }
    if(tab==='history'){ loadAudit(); loadClientHistoryPeriods(); }
  }
  if(st.view==='faq') m.innerHTML=faqView();
  restoreFocus();
}
function go(v){ st.view=v; st.placing=null; st.detail=null; render(); }
/* ---------- global search: type any dealership or coach name from anywhere ---------- */
let _gsClients = null; // fetched once per session, on first keystroke
async function globalSearch(q){
  const out = $('#gsResults'); if(!out) return;
  q = norm(q);
  if(q.length < 2){ out.innerHTML=''; return; }
  if(!_gsClients){
    _gsClients = [];
    try{ _gsClients = await api('GET','/api/clients'); }catch(e){}
  }
  const canSeeCoaches = ['admin','lead'].includes(D.user.role);
  const clientHits = _gsClients.filter(c=>norm(c.name).includes(q)).slice(0,6);
  const coachHits = canSeeCoaches ? D.coaches.filter(c=>norm(c.name).includes(q)).slice(0,4) : [];
  if(!clientHits.length && !coachHits.length){ out.innerHTML = `<div class="gs-empty">No matches</div>`; return; }
  out.innerHTML =
    clientHits.map(c=>`<a onclick="gsGo('client',${c.id})"><b>${esc(c.name)}</b><span class="small"> · client${c.status==='active'?'':' · '+esc(c.status)}</span></a>`).join('') +
    coachHits.map(c=>`<a onclick="gsGo('coach','${c.id}')">${avatarHtml(c.name,c.team,18)} <b>${esc(c.name)}</b><span class="small"> · coach · ${esc(c.team)}</span></a>`).join('');
}
function gsGo(kind, id){
  $('#gSearch').value=''; $('#gsResults').innerHTML='';
  if(kind==='client') openClientProfile(id); else openCoachProfile(id);
}
document.addEventListener('click', e => {
  const out = $('#gsResults');
  if(out && !e.target.closest('.gsearch')) out.innerHTML='';
});
function toggleNavDrop(e){ e.stopPropagation(); const el=e.currentTarget.parentElement; document.querySelectorAll('.navdrop.open').forEach(x=>{ if(x!==el) x.classList.remove('open'); }); el.classList.toggle('open'); }
function closeNavDrop(){ document.querySelectorAll('.navdrop.open').forEach(x=>x.classList.remove('open')); }
document.addEventListener('click', closeNavDrop);
async function logout(){ await api('POST','/api/logout'); D=null; render(); }
function pwDlg(){
  openDlg(`<h3>Change password</h3>
    <label>New password</label><input type="password" id="pw1">
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="savePw()">Save</button></div>`);
}
async function savePw(){ const p=$('#pw1').value; if(p.length<8){uiAlert('Use at least 8 characters');return;}
  await api('PATCH','/api/users/'+D.user.id,{password:p}); closeDlg(); toast('Password changed'); }

/* ---------- login ---------- */
const SSO_ERRORS = {
  bad_state: 'That sign-in link expired or was already used — try again.',
  token_exchange_failed: 'Google sign-in failed. Please try again.',
  userinfo_failed: 'Google sign-in failed. Please try again.',
  email_not_verified: 'That Google account\'s email isn\'t verified — sign in with email/password instead.',
  wrong_domain: 'That Google account isn\'t on the right Workspace domain for this app.',
  no_account: 'No Coach Fulfillment System account exists for that email yet — ask an admin to create one, then try Google sign-in again.',
  server_error: 'Something went wrong on our end. Please try again or use email/password.',
};
function loginView(){
  if(ssoEnabled === undefined){
    ssoEnabled = null; // avoid firing the fetch twice while it's in flight
    fetch('/api/sso-config').then(r=>r.json()).then(j=>{ ssoEnabled = !!j.googleEnabled; render(); }).catch(()=>{ ssoEnabled = false; });
  }
  const ssoErr = new URLSearchParams(location.search).get('ssoerror');
  return `<div class="loginwrap"><div class="loginbox">
    <img src="https://chriscollinsinc.com/wp-content/uploads/2020/03/logo-1.png" onerror="this.style.display='none'" alt="">
    <h1>Coach Fulfillment System</h1>
    ${ssoErr ? `<div class="err">${esc(SSO_ERRORS[ssoErr] || 'Sign-in failed.')}</div>` : ''}
    ${ssoEnabled ? `<a href="/auth/google" class="gbtn">
      <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
      <span>Sign in with Google</span></a>
    <div class="small" style="text-align:center;margin-bottom:10px;color:var(--muted)">— or —</div>` : ''}
    <label>Email</label><input type="text" id="lEmail" autocomplete="username">
    <label>Password</label><input type="password" id="lPw" autocomplete="current-password" onkeydown="if(event.key==='Enter')doLogin()">
    <div class="err" id="lErr"></div>
    <button class="btn primary" onclick="doLogin()">Sign in</button>
    <div class="loginlinks"><a onclick="forgotDlg()">Forgot password?</a></div>
  </div></div>`;
}
async function doLogin(){
  try{
    const r = await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email:$('#lEmail').value,password:$('#lPw').value})});
    const j = await r.json();
    if(!r.ok){ $('#lErr').textContent=j.error||'Sign-in failed'; return; }
    await refresh();
  }catch(e){ $('#lErr').textContent='Could not reach the server'; }
}
function forgotDlg(){
  openDlg(`<h3>Forgot password</h3>
    <label>Email</label><input type="text" id="fpEmail" autocomplete="username">
    <div class="err" id="fpMsg"></div>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="doForgot()">Send reset link</button></div>`);
}
async function doForgot(){
  const email = $('#fpEmail').value;
  try{
    await fetch('/api/forgot-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});
    $('#fpMsg').textContent = 'If that email is registered, a reset link is on its way.';
  }catch(e){ $('#fpMsg').textContent = 'Could not reach the server'; }
}
function resetView(token){
  return `<div class="loginwrap"><div class="loginbox">
    <img src="https://chriscollinsinc.com/wp-content/uploads/2020/03/logo-1.png" onerror="this.style.display='none'" alt="">
    <h1>Set a new password</h1>
    <label>New password</label><input type="password" id="rPw1" autocomplete="new-password">
    <div class="err" id="rErr"></div>
    <button class="btn primary" onclick="doReset('${esc(token)}')">Set password</button>
  </div></div>`;
}
async function doReset(token){
  const password = $('#rPw1').value;
  if(password.length < 8){ $('#rErr').textContent = 'Use at least 8 characters'; return; }
  try{
    const r = await fetch('/api/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token,password})});
    const j = await r.json();
    if(!r.ok){ $('#rErr').textContent = j.error || 'Could not reset password'; return; }
    history.replaceState(null,'','/');
    toast('Password set — sign in below');
    render();
  }catch(e){ $('#rErr').textContent = 'Could not reach the server'; }
}

/* ---------- dashboard ---------- */
function rolling12(){ const out=[]; let y=+TODAY.slice(0,4), m=+TODAY.slice(5,7)-1;
  for(let i=0;i<12;i++){ out.push([y,m]); m++; if(m>11){m=0;y++;} } return out; }
function capacity(team,y,m){
  const weeks=mondaysInMonth(y,m); const members=D.coaches.filter(c=>c.team===team);
  let booked=0, open=0, other=0, launch=0;
  for(const c of members) for(const w of weeks){
    const o=occ[c.id+'|'+w];
    if(!o){ open++; continue; }
    if(o.type==='visit'){ booked++; continue; }
    if(o.kind==='visit'||o.kind==='mag'||o.kind==='visit_legacy'){ booked++; }
    else if(o.kind==='launch_open') launch++;
    else other++;
  }
  return {booked,open,launch,weeks:weeks.length*members.length};
}
/* Today — a role-aware action queue, not a report. Every number is clickable,
   every row carries the one button that fixes it. */
function dashboard(){
  return `<div id="todayOut"><div class="panel">Loading your day…</div></div>`;
}
async function loadToday(){
  let t;
  try{ t = await api('GET','/api/today'); }
  catch(e){ $('#todayOut').innerHTML = '<div class="panel">Could not load — refresh to try again.</div>'; return; }
  $('#todayOut').innerHTML = D.user.role==='coach' ? todayCoachView(t) : todayTeamView(t);
}
const invJump = f => `st.invFilter='${f}';st.invSel=new Set();go('inventory')`;
const placeJump = v => `st.view='board';st.boardTeam='${esc(v.team)}';${v.due?`st.boardY=${+v.due.slice(0,4)};st.boardM=${+v.due.slice(5,7)-1};`:''}st.placing=${v.id};render()`;
function todayRows(list, maxN, rowFn){
  return list.slice(0,maxN).map(rowFn).join('') +
    (list.length>maxN?`<tr><td colspan="9" class="small">…and ${list.length-maxN} more</td></tr>`:'');
}
function todayTeamView(t){
  const odDays = d => Math.floor(dayDiff(TODAY,d));
  let html=`<div class="cards">
    <div class="card ${t.overdueNoPlan.length?'bad':'ok'}" style="cursor:pointer" onclick="${invJump('overdue')};st.invFilter='attention'"><div class="k">${t.overdueNoPlan.length}</div><div class="l">Overdue — no plan</div></div>
    <div class="card" style="cursor:pointer" onclick="${invJump('oncal')}"><div class="k">${t.lateOnCalendar}</div><div class="l">Late but on calendar</div></div>
    <div class="card ${t.dueSoonUnscheduled.length?'warn':'ok'}" style="cursor:pointer" onclick="${invJump('needs')}"><div class="k">${t.dueSoonUnscheduled.length}</div><div class="l">Due in 30 days, unscheduled</div></div>
    <div class="card ok"><div class="k">${t.completedThisMonth}</div><div class="l">Completed this month${t.team?' — Team '+esc(t.team):''}</div></div>
  </div>`;
  if(t.pendingCount) html+=`<div class="panel" style="border-left:4px solid var(--primary);padding:10px 14px">
    <b>${t.pendingCount} new Keap subscription${t.pendingCount>1?'s':''}</b> waiting for assignment.
    <button class="btn tiny primary" style="margin-left:8px" onclick="go('pending')">Review →</button></div>`;

  html+=`<div class="panel"><h2>Fix first — overdue with no plan (${t.overdueNoPlan.length})</h2>`;
  html+= t.overdueNoPlan.length ? `<table><tr><th>Client</th><th>Visit</th><th>Was due</th><th>How late</th><th></th></tr>`+
    todayRows(t.overdueNoPlan, 10, v=>`<tr>
      <td><b>${v.client_id?`<a style="cursor:pointer;color:var(--primary);text-decoration:underline" onclick="openClientProfile(${v.client_id})">${esc(v.client)}</a>`:esc(v.client)}</b></td>
      <td>${esc(v.cycle)} ${esc(v.program)} · ${esc(v.team||'?')}</td><td class="mono">${fmt(v.due)}</td>
      <td><span class="pill p-over">${odDays(v.due)} days</span></td>
      <td>${v.team?`<button class="btn tiny primary" onclick="${placeJump(v)}">Place on calendar</button>`:''}
      <button class="btn tiny" onclick="visitDrawer(${v.id})">Details</button></td></tr>`)+`</table>`
    : `<p class="small">Nothing — every overdue visit has a calendar slot. ✔</p>`;
  html+=`</div>`;

  html+=`<div class="panel"><h2>Schedule next — due within 30 days (${t.dueSoonUnscheduled.length})</h2>`;
  html+= t.dueSoonUnscheduled.length ? `<table><tr><th>Client</th><th>Visit</th><th>Due</th><th></th></tr>`+
    todayRows(t.dueSoonUnscheduled, 10, v=>`<tr>
      <td><b>${v.client_id?`<a style="cursor:pointer;color:var(--primary);text-decoration:underline" onclick="openClientProfile(${v.client_id})">${esc(v.client)}</a>`:esc(v.client)}</b></td>
      <td>${esc(v.cycle)} ${esc(v.program)} · ${esc(v.team||'?')}</td><td class="mono">${fmt(v.due)}</td>
      <td>${v.team?`<button class="btn tiny primary" onclick="${placeJump(v)}">Place on calendar</button>`:''}</td></tr>`)+`</table>`
    : `<p class="small">Nothing coming due unscheduled in the next 30 days. ✔</p>`;
  html+=`</div>`;

  if(t.atRisk.length){
    html+=`<div class="panel"><h2>At-risk clients (${t.atRisk.length})</h2>
    <p class="small" style="margin-bottom:8px">Active, paying visit-clients with no completed visit in 60+ days and nothing on the calendar — the ones most likely to churn quietly.</p>
    <table><tr><th>Client</th><th>Assigned coach</th><th></th></tr>`+
    todayRows(t.atRisk, 8, c=>`<tr><td><b><a style="cursor:pointer;color:var(--primary);text-decoration:underline" onclick="openClientProfile(${c.id})">${esc(c.name)}</a></b></td>
      <td>${esc(coach(c.assigned_coach_id)?.name||'— unassigned —')}</td>
      <td><button class="btn tiny" onclick="openClientProfile(${c.id})">Open profile</button></td></tr>`)+`</table></div>`;
  }

  if(t.missingNotes.length){
    html+=`<div class="panel"><h2>Completed without a note (${t.missingNotes.length})</h2>
    <p class="small" style="margin-bottom:8px">Visits marked done in the last 30 days with no write-up — undocumented work is invisible work.</p>
    <table><tr><th>Client</th><th>Completed</th><th>Coach</th><th></th></tr>`+
    todayRows(t.missingNotes, 8, v=>`<tr><td><b>${esc(v.client)}</b></td><td class="mono">${fmt(v.completed_on)}</td>
      <td>${esc(coach(v.completed_by_coach_id)?.name||'—')}</td>
      <td>${v.client_id?`<button class="btn tiny" onclick="openClientProfile(${v.client_id})">Add note</button>`:''}</td></tr>`)+`</table></div>`;
  }

  if(t.holdsExpiring.length){
    html+=`<div class="panel"><h2>Soft-pencil holds expiring soon (${t.holdsExpiring.length})</h2>
    <table><tr><th>Prospect</th><th>Coach</th><th>Expires</th><th></th></tr>`+
    t.holdsExpiring.map(h=>`<tr><td><b>${esc(h.name)}</b></td><td>${esc(coach(h.coach_id)?.name||h.coach_id)}</td>
      <td><span class="pill p-over">${fmt(h.expires)}</span></td>
      <td><button class="btn tiny" onclick="go('availability')">Manage →</button></td></tr>`).join('')+`</table></div>`;
  }

  // Capacity planning — still here, but collapsed and trimmed to the actionable horizon.
  html+=`<details class="panel" style="display:block"><summary style="cursor:pointer;font-family:var(--head);font-size:16px;letter-spacing:1px;text-transform:uppercase">Capacity planning — next 6 months</summary><div style="margin-top:10px">`;
  for(const tm of myTeams()){
    html+=`<h3>Team ${tm}</h3><table><tr><th>Month</th><th class="num">Booked</th><th class="num">Open</th><th class="num">LIDs due</th><th>Load</th><th></th></tr>`;
    for(const [y,m] of rolling12().slice(0,6)){
      const c=capacity(tm,y,m);
      const due=D.visits.filter(v=>!v.completed&&v.team===tm&&v.due&&+v.due.slice(0,4)===y&&+v.due.slice(5,7)===m+1).length;
      const cap=c.booked+c.open, pct=cap?Math.round(c.booked/cap*100):0;
      const verdict=due>cap?`<span class="pill p-over">${due-cap} over</span>`
        : c.open>0?`<span class="pill p-done">${c.open} open</span>`:`<span class="pill p-due">full</span>`;
      html+=`<tr><td>${MO[m]} ${String(y).slice(2)}</td><td class="num">${c.booked}</td><td class="num">${c.open}</td><td class="num">${due}</td>
        <td><div class="bar"><div style="width:${pct}%;background:var(--primary)"></div><div style="width:${100-pct}%;background:var(--open)"></div></div></td>
        <td>${verdict} <button class="btn tiny" onclick="st.view='board';st.boardTeam='${tm}';st.boardY=${y};st.boardM=${m};render()">View that month's board →</button></td></tr>`;
    }
    html+=`</table>`;
  }
  html+=`<p class="small" style="margin-top:8px">Weeks with nothing scheduled or blocked count as open. For the full 12-month view, use Availability.</p></div></details>`;
  return html;
}
function todayCoachView(t){
  let html='';
  html+=`<div class="panel" style="border-left:4px solid var(--primary)"><h2>Your next visit</h2>`;
  html+= t.nextVisit ? `<p style="font-size:15px"><b>${esc(t.nextVisit.client)}</b> — week of ${fmtW(t.nextVisit.cal_week)} · ${esc(t.nextVisit.cycle)} ${esc(t.nextVisit.program)}</p>
    <div class="btnrow" style="margin-top:8px">
      ${t.nextVisit.client_id?`<button class="btn tiny" onclick="openClientProfile(${t.nextVisit.client_id})">Client profile &amp; notes</button>`:''}
      <button class="btn tiny primary" onclick="completeVisitDlg(${t.nextVisit.id})">Complete it</button></div>`
    : `<p class="small">Nothing on your calendar yet — check My Schedule or ask your lead.</p>`;
  html+=`</div>`;
  const sec=(title,list,empty)=>{
    let h=`<div class="panel"><h2>${title} (${list.length})</h2>`;
    h+= list.length ? `<table><tr><th>Client</th><th>Visit</th><th>Due</th><th></th></tr>`+
      todayRows(list, 10, v=>`<tr><td><b>${esc(v.client)}</b></td><td>${esc(v.cycle||'')} ${esc(v.program||'')}</td>
        <td class="mono">${fmt(v.due||v.completed_on)}</td>
        <td>${v.client_id?`<button class="btn tiny" onclick="openClientProfile(${v.client_id})">Open client</button>`:''}
        ${!v.completed_on?`<button class="btn tiny primary" onclick="completeVisitDlg(${v.id})">Complete</button>`:''}</td></tr>`)+`</table>`
      : `<p class="small">${empty}</p>`;
    return h+`</div>`;
  };
  html+=sec('Overdue from you', t.overdueMine, 'Nothing overdue. ✔');
  html+=sec('Due from you in the next 30 days', t.dueSoonMine, 'Nothing due soon. ✔');
  if(t.missingNotes.length){
    html+=`<div class="panel"><h2>You owe a note (${t.missingNotes.length})</h2>
    <p class="small" style="margin-bottom:8px">Visits you completed in the last 30 days with no write-up.</p>
    <table><tr><th>Client</th><th>Completed</th><th></th></tr>`+
    t.missingNotes.map(v=>`<tr><td><b>${esc(v.client)}</b></td><td class="mono">${fmt(v.completed_on)}</td>
      <td>${v.client_id?`<button class="btn tiny primary" onclick="openClientProfile(${v.client_id})">Add note</button>`:''}</td></tr>`).join('')+`</table></div>`;
  }
  return html;
}

const healthDot = cid => {
  const h = cid && D.clientHealth ? D.clientHealth[cid] : null;
  return h==='at_risk' ? '<span title="Client at risk — see their profile" style="color:var(--bad);font-size:11px">● </span>'
    : h==='behind' ? '<span title="Client behind — see their profile" style="color:var(--warn);font-size:11px">● </span>' : '';
};
/* ---------- schedule board ---------- */
function board(){
  const t=st.boardTeam, y=st.boardY, m=st.boardM;
  const weeks=mondaysInMonth(y,m);
  const members=D.coaches.filter(c=>c.team===t);
  const placing = st.placing ? D.visits.find(v=>v.id===st.placing) : null;

  /* to-schedule list: overdue first, then due this month, then next month */
  const nextM = m===11?[y+1,0]:[y,m+1];
  const inMonth=(v,yy,mm)=>v.due&&+v.due.slice(0,4)===yy&&+v.due.slice(5,7)===mm+1;
  const cand=D.visits.filter(v=>!v.completed&&!v.cal_week&&v.team===t);
  const overdue=cand.filter(v=>v.due&&v.due<TODAY&&!inMonth(v,y,m)).sort((a,b)=>a.due.localeCompare(b.due));
  const thisMo=cand.filter(v=>inMonth(v,y,m));
  const nextMo=cand.filter(v=>inMonth(v,nextM[0],nextM[1]));

  let html='';
  if(placing){
    html+=`<div class="placebanner">Placing <b>${esc(placing.client)}</b> — ${esc(placing.cycle)} ${esc(placing.program)}, due ${fmt(placing.due)}.
      Click any open week below. <button class="btn tiny" onclick="st.placing=null;render()">Cancel</button></div>`;
  }
  html+=`<div class="controls">
    ${myTeams().map(x=>`<button class="btn ${x===t?'primary':''}" onclick="st.boardTeam='${x}';st.placing=null;render()">${x}</button>`).join('')}
    <span style="flex:1"></span>
    <div class="monthnav">
      <button class="btn" onclick="bMonth(-1)">‹</button>
      <span class="mlabel">${MONTHS[m]} ${y}</span>
      <button class="btn" onclick="bMonth(1)">›</button>
      <button class="btn tiny" onclick="st.boardY=${+TODAY.slice(0,4)};st.boardM=${+TODAY.slice(5,7)-1};render()">Today</button>
    </div></div>
  <div class="boardlayout"><div class="panel" style="margin:0">
  <table class="bgrid"><tr><th style="text-align:left">Coach</th>`;
  weeks.forEach(w=>{ const now=TODAY>=w&&dayDiff(TODAY,w)<7;
    html+=`<th class="${now?'wk-now':''}">wk of ${fmtW(w)}${now?' ●':''}</th>`; });
  html+=`</tr>`;
  for(const c of members){
    html+=`<tr><td class="cname">${esc(c.name)}</td>`;
    for(const w of weeks){
      const o=occ[c.id+'|'+w]; const past=w<mondayOf(new Date());
      let cls='slot', inner='', click='';
      if(!o){
        cls+=' s-open'+(past?' s-past':'');
        if(placing && !past){ cls+=' target'; inner=''; click=` onclick="placeHere('${c.id}','${w}')"`; }
        else if(canEdit() && !past) click=` onclick="cellDlg('${c.id}','${w}')"`;
      } else if(o.type==='visit'){
        const v=o.v; cls+= v.completed?' s-done':' s-visit';
        inner=`<b>${v.completed?'':healthDot(v.client_id)}${esc(v.client)}</b><small>${esc(v.cycle)} ${esc(v.program)}${v.completed?' · done':''}</small>`;
        if(canEdit()) click=` onclick="st.detail=${v.id};st.placing=null;render()"`;
      } else {
        const kindCls = o.kind==='mag'?'s-mag' : (o.kind==='visit'||o.kind==='visit_legacy')?'s-legacy' : o.kind==='launch_open'?'s-launch_open' : o.kind==='soft_pencil'?'s-soft':'s-block';
        cls+=' '+kindCls+(past?' s-past':'');
        inner=`<b>${esc(o.label||BLOCKKINDS[o.kind]||o.kind)}</b><small>${o.kind==='visit'||o.kind==='visit_legacy'?'from sheet':esc(BLOCKKINDS[o.kind]||'')}</small>`;
        if(canEdit() && !past) click=` onclick="cellDlg('${c.id}','${w}')"`;
      }
      html+=`<td><div class="${cls}"${click}>${inner}</div></td>`;
    }
    html+=`</tr>`;
  }
  html+=`</table>
  <div class="legend"><span><i style="background:var(--visit)"></i>Visit</span><span><i style="background:var(--done)"></i>Completed</span>
    <span><i style="background:var(--open);border:1px dashed var(--openb)"></i>Open</span><span><i style="background:var(--launch)"></i>Launch slot</span>
    <span><i style="background:#e2f0f0"></i>Mills</span><span><i style="background:var(--offc)"></i>Blocked (home/off/etc.)</span></div>
  <p class="small">Click a visit to manage it · click an open or blocked week to set Home/Off/Training/etc. ·
  <span style="color:var(--bad)">●</span> client at risk · <span style="color:var(--warn)">●</span> client behind — hover a dot for details, open the client's profile for the full story.</p>
  </div>`;

  /* side rail */
  html+=`<div class="sidebox">`;
  if(st.detail){
    const v=D.visits.find(x=>x.id===st.detail);
    if(v) html+=`<div class="detailbox"><b>${esc(v.client)}</b>
      ${esc(v.cycle)} ${esc(v.program)} · due ${fmt(v.due)}<br>
      <span class="small">wk of ${fmtW(v.cal_week)} — ${esc(coach(v.cal_coach)?.name||'')}</span>
      <div class="btnrow">
        <button class="btn tiny primary" onclick="completeVisitDlg(${v.id})">Complete</button>
        <button class="btn tiny" onclick="st.placing=${v.id};st.detail=null;render()">Move</button>
        <button class="btn tiny" onclick="unscheduleV(${v.id})">Unschedule</button>
        <button class="btn tiny" onclick="st.detail=null;render()">Close</button>
      </div></div>`;
  }
  const section=(title,list)=>{
    if(!list.length) return '';
    let h=`<h2>${title} (${list.length})</h2>`;
    list.slice(0,40).forEach(v=>{
      h+=`<div class="duecard ${v.due&&v.due<TODAY?'over':''}"><b>${healthDot(v.client_id)}${esc(v.client)}</b>
        <div class="meta">${esc(v.cycle)} ${esc(v.program)} · due ${fmt(v.due)}</div>
        <button class="btn tiny primary" onclick="st.placing=${v.id};st.detail=null;render()">Place on calendar</button></div>`;
    });
    return h;
  };
  html+=section('Overdue / carryover',overdue);
  html+=section(`Due ${MO[m]}`,thisMo);
  html+=section(`Coming up · ${MO[nextM[1]]}`,nextMo);
  if(!overdue.length&&!thisMo.length&&!nextMo.length) html+=`<h2>To schedule</h2><p class="small">Nothing waiting for Team ${t} in this window. 🎉</p>`;
  html+=`</div></div>`;
  return html;
}
function bMonth(d){ st.boardM+=d; if(st.boardM>11){st.boardM=0;st.boardY++;} if(st.boardM<0){st.boardM=11;st.boardY--;} st.placing=null; st.detail=null; render(); }
async function placeHere(cid,w){
  const id=st.placing; if(!id) return;
  await api('POST',`/api/visits/${id}/place`,{coach:cid,week:w});
  st.placing=null;
  await refresh();
  toast(`Scheduled → ${coach(cid).name}, wk of ${fmtW(w)}`, async()=>api('POST',`/api/visits/${id}/unschedule`));
}
async function unscheduleV(id){
  const v=D.visits.find(x=>x.id===id); const old={coach:v.cal_coach,week:v.cal_week};
  await api('POST',`/api/visits/${id}/unschedule`); st.detail=null; await refresh();
  toast('Unscheduled — back in the to-schedule list', async()=>api('POST',`/api/visits/${id}/place`,old));
}
function completeVisitDlg(id){
  const v = D.visits.find(x=>x.id===id);
  openDlg(`<h3>Complete visit${v?' — '+esc(v.client):''}</h3>
    ${v?`<p class="small">${esc(v.cycle)} ${esc(v.program)} · due ${fmt(v.due)}</p>`:''}
    <label>Note for this visit (optional)</label>
    <textarea id="cvNote" rows="4" placeholder="What happened on this visit — this gets logged on the client's notes, tied to this specific visit."></textarea>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="doCompleteV(${id})">Mark complete</button></div>`);
}
async function doCompleteV(id){
  const note = ($('#cvNote')||{}).value || '';
  try{
    await api('POST',`/api/visits/${id}/complete`, note.trim() ? { note: note.trim() } : {});
  }catch(e){ closeDlg(); uiAlert(e.message||'Could not complete that visit'); return; }
  closeDlg(); st.detail=null; await refresh();
  toast('Marked complete', async()=>api('POST',`/api/visits/${id}/reopen`));
}
function cellDlg(cid,w){
  const o=occ[cid+'|'+w]; const cur=o&&o.type==='block'?o.kind:'open';
  const opts=[['open','Open (available)'],...Object.entries(BLOCKKINDS).filter(([k])=>!['visit','visit_legacy'].includes(k))]
    .map(([k,l])=>`<option value="${k}" ${cur===k?'selected':''}>${l}</option>`).join('');
  openDlg(`<h3>${esc(coach(cid).name)} — week of ${fmt(w)}</h3>
    <label>Week type</label><select id="ctKind">${opts}</select>
    <label>Label (optional)</label><input id="ctLabel" value="${esc(o&&o.type==='block'?o.label:'')}">
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveCell('${cid}','${w}')">Save</button></div>`);
}
async function saveCell(cid,w){
  await api('PUT','/api/blocks',{coach:cid,week:w,kind:$('#ctKind').value,label:$('#ctLabel').value.trim()});
  closeDlg(); await refresh();
}

/* ---------- inventory ---------- */
const hint = t => `<span title="${esc(t)}" style="cursor:help;color:var(--muted);border-bottom:1px dotted var(--muted)">?</span>`;
const INV_COLS = [
  { key:'client', label:'Client', get:v=>v.client||'' },
  { key:'team', label:'Team', get:v=>v.team||'' },
  { key:'program', label:'Program '+hint('How often this client gets visited — Quarterly means 4 visits per year, Semi-Monthly means 6, etc.'), get:v=>v.program||'' },
  { key:'cycle', label:'Cycle '+hint('Which visit this is within the contract — "3 of 4" means the 3rd of 4 contracted visits.'), get:v=>v.cycle||'' },
  { key:'due', label:'Due', get:v=>v.due||'' },
  { key:'scheduled', label:'Scheduled', get:v=>v.cal_week||'' },
  { key:'status', label:'Status', get:v=>status(v) },
];
function sortInventory(key){
  if(!st.invSort) st.invSort = { key:'due', dir:'asc' };
  if(st.invSort.key===key) st.invSort.dir = st.invSort.dir==='asc'?'desc':'asc';
  else st.invSort = { key, dir:'asc' };
  render();
}
/* Overdue aging: debt from months/years back shouldn't bury this month's work. */
const daysOverdue = v => (!v.completed && v.due && v.due < TODAY) ? Math.floor(dayDiff(TODAY, v.due)) : 0;
const isStale = v => daysOverdue(v) >= 90;
function inventory(){
  if(!st.invSort) st.invSort = { key:'due', dir:'asc' };
  const f=st.invFilter,q=norm(st.invSearch);
  const isCoach = D.user.role==='coach';
  let rows=D.visits.slice();
  const stf={
    attention:v=>!v.completed&&!isStale(v),
    active:v=>!v.completed,
    overdue:v=>status(v)==='overdue'&&!isStale(v),
    stale:v=>isStale(v),
    needs:v=>status(v)==='needs_scheduling',
    oncal:v=>status(v)==='on_calendar',
    completed:v=>!!v.completed,all:()=>true};
  rows=rows.filter(stf[f]||stf.attention);
  if(D.user.role==='lead') rows=rows.filter(v=>!v.team||v.team===D.user.team);
  // Coaches only ever see their own visits here — this page is where they complete
  // work, not a company-wide client roster.
  if(isCoach) rows=rows.filter(ownsVisit);
  if(q) rows=rows.filter(v=>norm(v.client).includes(q)||norm(v.coach_hist).includes(q));
  const { key, dir } = st.invSort;
  const col = INV_COLS.find(c=>c.key===key) || INV_COLS[4];
  rows.sort((a,b)=>{
    const av=(col.get(a)||'').toString().toLowerCase(), bv=(col.get(b)||'').toString().toLowerCase();
    if(av===bv) return (a.due||'9').localeCompare(b.due||'9');
    return dir==='asc'?av.localeCompare(bv):bv.localeCompare(av);
  });
  const base = isCoach ? D.visits.filter(ownsVisit) : D.visits;
  const count=fn=>base.filter(fn).length;
  const staleCount = count(isStale);
  const arrow = k => st.invSort.key===k ? (st.invSort.dir==='asc'?' ▲':' ▼') : '';
  const th = c => `<th style="cursor:pointer;user-select:none" onclick="sortInventory('${c.key}')">${c.label}<span class="small">${arrow(c.key)}</span></th>`;
  const sel = st.invSel || (st.invSel = new Set());
  const showChecks = canEdit();
  let html=`<div class="controls">
    ${canEdit() ? `<button class="btn primary" onclick="contractDlg()">＋ New contract</button>
    <button class="btn" onclick="visitDlg(0)">＋ Single visit</button>` : ''}
    <select onchange="st.invFilter=this.value;st.invSel=new Set();render()">
      <option value="attention" ${f==='attention'||!stf[f]?'selected':''}>Needs attention — ${count(stf.attention)}</option>
      <option value="overdue" ${f==='overdue'?'selected':''}>Overdue (last 90 days) — ${count(stf.overdue)}</option>
      <option value="stale" ${f==='stale'?'selected':''}>Stale (overdue 90+ days) — ${staleCount}</option>
      <option value="needs" ${f==='needs'?'selected':''}>Needs scheduling — ${count(stf.needs)}</option>
      <option value="oncal" ${f==='oncal'?'selected':''}>On calendar — ${count(stf.oncal)}</option>
      <option value="active" ${f==='active'?'selected':''}>All active — ${count(stf.active)}</option>
      <option value="completed" ${f==='completed'?'selected':''}>Completed — ${count(stf.completed)}</option>
      <option value="all" ${f==='all'?'selected':''}>Everything — ${base.length}</option></select>
    <input id="invSearchBox" placeholder="Search client or coach…" value="${esc(st.invSearch)}" oninput="st.invSearch=this.value;updateInventoryMain()" style="width:230px">
    <span class="small">${rows.length} rows</span></div>`;
  if(f!=='stale' && staleCount && !q){
    html+=`<div class="panel" style="border-left:4px solid var(--warn);padding:10px 14px;margin-bottom:12px">
      <span class="small"><b>${staleCount} visit(s) are 90+ days overdue</b> — old debt kept out of this view so current work stays visible.
      <a style="color:var(--primary);cursor:pointer;text-decoration:underline" onclick="st.invFilter='stale';st.invSel=new Set();render()">Review stale visits →</a></span></div>`;
  }
  if(showChecks && sel.size){
    html+=`<div class="panel" style="border-left:4px solid var(--primary);padding:10px 14px;margin-bottom:12px">
      <b>${sel.size} selected</b>
      <button class="btn tiny" style="margin-left:10px" onclick="bulkCompleteVisits()">Mark completed</button>
      <button class="btn tiny danger" onclick="bulkDeleteVisits()">Delete</button>
      <button class="btn tiny" onclick="st.invSel=new Set();render()">Clear selection</button></div>`;
  }
  html+=`<div class="panel" style="overflow-x:auto"><table class="invtable"><tr>${showChecks?`<th style="width:26px"><input type="checkbox" ${rows.length&&rows.slice(0,400).every(v=>sel.has(v.id))?'checked':''} onclick="toggleInvAll(this.checked)"></th>`:''}${INV_COLS.map(th).join('')}<th style="width:60px"></th></tr>`;
  rows.slice(0,400).forEach(v=>{
    const s=status(v);
    const od=daysOverdue(v);
    const sched=v.completed?(v.sched_hist||(v.cal_week?'wk of '+fmtW(v.cal_week):'—'))
      : v.cal_week?`wk of ${fmtW(v.cal_week)} — ${esc(coach(v.cal_coach)?.name||'')}`:'—';
    const pill=v.completed?'<span class="pill p-done">Completed</span>'
      :s==='overdue'?`<span class="pill p-over">Overdue — no plan${od>=30?` · ${od}d`:''}</span>`
      :s==='on_calendar'?(v.due&&v.due<TODAY?'<span class="pill p-due">Late — on calendar</span>':'<span class="pill p-cal">On calendar</span>')
      :s==='needs_scheduling'?'<span class="pill p-due">Needs scheduling</span>':'<span class="pill p-fut">—</span>';
    html+=`<tr style="cursor:pointer" onclick="visitDrawer(${v.id})">
      ${showChecks?`<td onclick="event.stopPropagation()"><input type="checkbox" ${sel.has(v.id)?'checked':''} onclick="toggleInvSel(${v.id},this.checked)"></td>`:''}
      <td><b>${esc(v.client)}</b></td><td>${esc(v.team||'?')}</td><td>${esc(v.program)}</td><td class="mono">${esc(v.cycle)}</td>
      <td class="mono">${fmt(v.due)}</td><td class="small">${sched}</td><td>${pill}</td>
      <td class="small" style="color:var(--muted)">Open ›</td></tr>`;
  });
  if(rows.length>400) html+=`<tr><td colspan="10" class="small">…first 400 of ${rows.length}</td></tr>`;
  html+=`</table></div>`;
  return html;
}
/* Root-cause fix for the search box, not just a patch over its symptom: a full
 * render() rebuilds the header, nav, and global search too on every single keystroke
 * — unnecessary work, and on a large Inventory list (hundreds of rows re-stringified
 * per character) it's real, visible lag even with focus preserved. This only rebuilds
 * #main, which is the one part of the page that actually depends on the search text. */
function updateInventoryMain(){
  const m = $('#main'); if(!m) return;
  const el = document.getElementById('invSearchBox');
  const selStart = el && typeof el.selectionStart === 'number' ? el.selectionStart : null;
  const selEnd = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : null;
  m.innerHTML = inventory();
  const el2 = document.getElementById('invSearchBox');
  if(el2){
    el2.focus();
    if(selStart != null && typeof el2.setSelectionRange === 'function'){
      try{ el2.setSelectionRange(selStart, selEnd); }catch(e){}
    }
  }
}
function toggleInvSel(id, on){ if(on) st.invSel.add(id); else st.invSel.delete(id); render(); }
function toggleInvAll(on){
  const f=st.invFilter,q=norm(st.invSearch);
  // Re-derive the visible rows the same way inventory() does, capped at the same 400
  const stf={attention:v=>!v.completed&&!isStale(v),active:v=>!v.completed,overdue:v=>status(v)==='overdue'&&!isStale(v),stale:v=>isStale(v),needs:v=>status(v)==='needs_scheduling',oncal:v=>status(v)==='on_calendar',completed:v=>!!v.completed,all:()=>true};
  let rows=D.visits.filter(stf[f]||stf.attention);
  if(D.user.role==='lead') rows=rows.filter(v=>!v.team||v.team===D.user.team);
  if(q) rows=rows.filter(v=>norm(v.client).includes(q)||norm(v.coach_hist).includes(q));
  st.invSel = on ? new Set(rows.slice(0,400).map(v=>v.id)) : new Set();
  render();
}
/* One place for everything about a visit — replaces the old four-buttons-per-row,
   which put Delete a pixel away from Complete. */
function visitDrawer(id){
  const v = D.visits.find(x=>x.id===id); if(!v) return;
  const s = status(v); const od = daysOverdue(v);
  const canDo = canEdit();
  openDlg(`<h3>${esc(v.client)}</h3>
    <p class="small" style="margin-bottom:10px">${esc(v.cycle)} ${esc(v.program)} · Team ${esc(v.team||'?')}<br>
    Due ${fmt(v.due)}${od?` — <b style="color:var(--bad)">${od} days overdue</b>`:''}<br>
    ${v.completed?`Completed ${fmt(v.completed_on)}`:v.cal_week?`On calendar: wk of ${fmtW(v.cal_week)} — ${esc(coach(v.cal_coach)?.name||'')}`:'Not scheduled yet'}</p>
    <div class="btnrow">
      ${v.client_id?`<button class="btn tiny" onclick="closeDlg();openClientProfile(${v.client_id})">View client</button>`:''}
      ${canDo?`<button class="btn tiny" onclick="closeDlg();visitDlg(${v.id})">Edit</button>`:''}
      ${canDo&&!v.completed&&!v.cal_week&&v.team?`<button class="btn tiny" onclick="closeDlg();st.view='board';st.boardTeam='${esc(v.team)}';${v.due?`st.boardY=${+v.due.slice(0,4)};st.boardM=${+v.due.slice(5,7)-1};`:''}st.placing=${v.id};render()">Place on calendar</button>`:''}
      ${!v.completed&&(canDo||ownsVisit(v))?`<button class="btn tiny primary" onclick="closeDlg();completeVisitDlg(${v.id})">Complete</button>`:''}
      ${canDo&&v.completed?`<button class="btn tiny" onclick="closeDlg();reopenVisit(${v.id})">Reopen</button>`:''}
    </div>
    <div class="dlgrow" style="justify-content:space-between;margin-top:16px">
      ${canDo?`<button class="btn tiny danger" onclick="closeDlg();delVisit(${v.id})">Delete visit</button>`:'<span></span>'}
      <button class="btn" onclick="closeDlg()">Close</button></div>`);
}
async function reopenVisit(id){ await api('POST',`/api/visits/${id}/reopen`); await refresh(); toast('Visit reopened'); }
async function bulkCompleteVisits(){
  const ids=[...st.invSel];
  if(!(await uiConfirm(`Mark ${ids.length} visit(s) completed? Use this for cleanup of old already-done work — no notes get attached.`,'Mark completed'))) return;
  let ok=0;
  for(const id of ids){ try{ await api('POST',`/api/visits/${id}/complete`,{}); ok++; }catch(e){} }
  st.invSel=new Set(); await refresh(); toast(`${ok} of ${ids.length} marked completed`);
}
async function bulkDeleteVisits(){
  const ids=[...st.invSel];
  if(!(await uiConfirm(`Delete ${ids.length} visit(s)? This can't be undone.`,'Delete'))) return;
  let ok=0;
  for(const id of ids){ try{ await api('DELETE',`/api/visits/${id}`); ok++; }catch(e){} }
  st.invSel=new Set(); await refresh(); toast(`${ok} of ${ids.length} deleted`);
}
const clientNames=()=>[...new Set(D.visits.map(v=>v.client))].sort();
const teamOpts=sel=>myTeams().map(t=>`<option ${t===sel?'selected':''}>${t}</option>`).join('');
const progOpts=sel=>PROGRAMS.map(p=>`<option ${p===sel?'selected':''}>${p}</option>`).join('');
function contractDlg(){
  openDlg(`<h3>New contract</h3>
    <label>Client / dealership</label><input id="cName" list="cl"><datalist id="cl">${clientNames().map(n=>`<option value="${esc(n)}">`).join('')}</datalist>
    <label>Program</label><select id="cProg" onchange="onContractProgramChange()">${progOpts('Quarterly')}</select>
    <div id="cVisitFields">
      <label>Number of visits</label><input type="number" id="cN" value="4" min="1" max="24">
      <label>First visit due</label><input type="date" id="cFirst" value="${TODAY}">
      <label>Team</label><select id="cTeam">${teamOpts(D.user.team)}</select>
    </div>
    <div id="cCoachFields" style="display:none">
      <label>Assigned coach</label><select id="cCoach">${coachOptsFor()}</select>
      <p class="small">Coaching Only — remote coaching, no LID visits will be scheduled.</p>
    </div>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveContract()">Create</button></div>`);
  onContractProgramChange();
}
function onContractProgramChange(){
  const prog = $('#cProg').value;
  const isCoachingOnly = prog === 'Coaching Only';
  $('#cN').value = CYCLE_LEN[prog] || 4;
  $('#cVisitFields').style.display = isCoachingOnly ? 'none' : '';
  $('#cCoachFields').style.display = isCoachingOnly ? '' : 'none';
}
async function saveContract(){
  const client = $('#cName').value.trim();
  if(!client){uiAlert('Client name required');return;}
  const program = $('#cProg').value;
  if(program==='Coaching Only'){
    const coachId = $('#cCoach').value;
    if(!coachId){ uiAlert('Pick a coach'); return; }
    const coach = D.coaches.find(c=>c.id===coachId);
    await api('POST','/api/contracts',{client, program, n:0, first:null, team:coach.team, coachId});
    closeDlg(); await refresh(); toast(`${client} added — Coaching Only, assigned to ${coach.name}`);
    return;
  }
  const b={client,program,n:+$('#cN').value,first:$('#cFirst').value,team:$('#cTeam').value};
  await api('POST','/api/contracts',b); closeDlg(); await refresh();
  toast(`${b.client}: ${b.n} ${b.program} visits added`);
}
function visitDlg(id){
  const v=D.visits.find(x=>x.id===id)||{client:'',program:'Quarterly',cycle:'1 of 1',due:TODAY,team:D.user.team||D.teams[0]};
  openDlg(`<h3>${id?'Edit visit':'Add single visit'}</h3>
    <label>Client</label><input id="vName" value="${esc(v.client)}" list="cl"><datalist id="cl">${clientNames().map(n=>`<option value="${esc(n)}">`).join('')}</datalist>
    <label>Program</label><select id="vProg">${progOpts(v.program)}</select>
    <label>Cycle label</label><input id="vCycle" value="${esc(v.cycle)}">
    <label>Due date</label><input type="date" id="vDue" value="${v.due||TODAY}">
    <label>Team</label><select id="vTeam">${teamOpts(v.team)}</select>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveVisit(${id||0})">Save</button></div>`);
}
async function saveVisit(id){
  const b={client:$('#vName').value.trim(),program:$('#vProg').value,cycle:$('#vCycle').value.trim(),due:$('#vDue').value||null,team:$('#vTeam').value};
  if(!b.client){uiAlert('Client name required');return;}
  let r = null;
  if(id) r = await api('PATCH','/api/visits/'+id,b); else await api('POST','/api/visits',b);
  closeDlg(); await refresh();
  toast(r && r.unscheduled ? `Saved — the visit was scheduled on the old team's coach, so it's back in Team ${b.team}'s to-schedule list for re-placing` : 'Saved');
}
async function delVisit(id){
  const v=D.visits.find(x=>x.id===id);
  if(!(await uiConfirm(`Delete ${v.client} — ${v.cycle} ${v.program}?`,'Delete'))) return;
  await api('DELETE','/api/visits/'+id); await refresh(); toast('Deleted');
}

/* ---------- availability ---------- */
function availabilityView(){
  return `<div class="panel"><h2>Sales availability</h2>
  <p class="small" style="margin-bottom:12px">Can we take a new client, and when could they start? Finds coaches with enough open weeks to absorb the full visit cadence, after all existing commitments.</p>
  <div class="controls">
    <label>Program</label><select id="aProg">${PROGRAMS.map(p=>`<option ${p==='Quarterly'?'selected':''}>${p}</option>`).join('')}</select>
    <label>Team</label><select id="aTeam"><option>Any</option>${D.teams.map(t=>`<option>${t}</option>`).join('')}</select>
    <label>Start no earlier than</label><input type="date" id="aFrom" value="${TODAY}">
    <label class="small" style="display:flex;align-items:center;gap:5px;text-transform:none;letter-spacing:0">
      <input type="checkbox" id="aFar" style="width:auto" ${st.due2027?'checked':''}> include unplanned months (2027+)</label>
    <button class="btn primary" onclick="runAvail()">Check availability</button>
  </div><div id="aOut"></div></div>
  <div class="panel"><h2>Open capacity by month</h2><div id="capOut"></div></div>
  <div class="panel"><h2>Active soft-pencil holds</h2>
  <p class="small" style="margin-bottom:8px">Tentative launch-date placeholders — reserve a coach's calendar for a prospect before the contract's signed, so nobody double-books that window. Release a hold to free those weeks back up.</p>
  <div id="softHoldsOut"></div></div>`;
}
function runAvail(){
  const prog=$('#aProg').value,team=$('#aTeam').value,from=$('#aFrom').value||TODAY;
  st.due2027=$('#aFar').checked;
  const lastPlanned = D.blocks.reduce((a,b)=>b.week>a?b.week:a,'2026-12-28');
  const horizon = st.due2027 ? addDays(TODAY,420) : lastPlanned;
  const interval=INTERVAL[prog],nVisits=CYCLE_LEN[prog];
  const results=[];
  for(const c of D.coaches.filter(c=>team==='Any'||c.team===team)){
    const open=mondaysRange(from<TODAY?TODAY:from,horizon).filter(w=>isOpen(c.id,w));
    if(!open.length) continue;
    let plan=null;
    for(const start of open){
      const used=new Set([start]);const seq=[start];let ok=true;
      for(let k=1;k<nVisits;k++){
        const target=new Date(start+'T12:00:00');target.setMonth(target.getMonth()+k*interval);
        if(target>new Date(horizon+'T12:00:00')) break;
        const tIso=target.toISOString().slice(0,10);
        const cand=open.filter(w=>!used.has(w)&&Math.abs(dayDiff(w,tIso))<=35)
          .sort((a,b)=>Math.abs(dayDiff(a,tIso))-Math.abs(dayDiff(b,tIso)))[0];
        if(!cand){ok=false;break;}
        used.add(cand);seq.push(cand);
      }
      if(ok){plan={start,seq};break;}
    }
    if(plan) results.push({coach:c,plan,spare:open.length-plan.seq.length});
  }
  results.sort((a,b)=>a.plan.start.localeCompare(b.plan.start));
  st.availResults = results; st.availProg = prog;
  let html='';
  if(!results.length){
    html=`<p style="color:var(--bad);font-weight:600">No coach can absorb a full ${prog} cadence before ${fmt(horizon)}${team!=='Any'?` on Team ${team}`:''}.</p>`;
  }else{
    html=`<p style="margin:8px 0"><b style="color:var(--ok)">Yes — ${results.length} coach${results.length>1?'es':''} can take a new ${prog} client.</b>
    Earliest start: <b>week of ${fmt(results[0].plan.start)}</b> with ${esc(results[0].coach.name)} (Team ${results[0].coach.team}).</p>
    <table><tr><th>Coach</th><th>Team</th><th>Earliest start</th><th>Projected visit weeks</th><th class="num">Spare open weeks</th><th></th></tr>`;
    results.slice(0,12).forEach((r,i)=>{
      html+=`<tr><td><b>${esc(r.coach.name)}</b></td><td>${r.coach.team}</td><td class="mono">${fmt(r.plan.start)}</td>
      <td>${r.plan.seq.map(w=>`<span class="result-week">${fmtW(w)}</span>`).join('')}</td><td class="num">${r.spare}</td>
      <td><button class="btn tiny" onclick="previewAvailCoach(${i})">Preview calendar</button></td></tr>`;
    });
    html+=`</table>`;
  }
  html+=`<p class="small" style="margin-top:8px">Planning horizon: through ${fmt(horizon)}. ${st.due2027?'Months past the current plan read as fully open — treat those as estimates.':'Check the box above to look into 2027 (not yet planned).'}</p>`;
  $('#aOut').innerHTML=html;
  closePreviewOverlay();
  loadSoftHolds();
  let cb='';
  for(const [y,m] of rolling12()){
    let open=0,total=0;
    for(const t of D.teams){const c=capacity(t,y,m);open+=c.open;total+=c.open+c.booked;}
    const pct=total?Math.round(open/total*100):0;
    cb+=`<div class="capbar-row"><div>${MO[m]} ${String(y).slice(2)}</div>
      <div class="bar"><div style="width:${100-pct}%;background:var(--primary)"></div><div style="width:${pct}%;background:var(--open)"></div></div>
      <div class="small mono">${open} open / ${total} workable</div></div>`;
  }
  $('#capOut').innerHTML=cb;
}

/* Preview one candidate coach's calendar — actual bookings plus the proposed cadence
   highlighted — over at least a 60-90 day window, extended further if the recurring
   visit cadence itself runs longer than that (e.g. a Quarterly plan's 4th visit lands
   9 months out). Lets whoever's placing the client see the whole picture — everything
   else already on that coach's book — before committing to a start date. */
function previewAvailCoach(i){
  const r = (st.availResults||[])[i]; if(!r) return;
  st.previewResult = r; st.previewDays = st.previewDays || 90;
  renderPreviewPanel();
  $('#previewOverlay').classList.add('show');
  document.body.style.overflow='hidden';
}
function closePreviewOverlay(){
  const ov = $('#previewOverlay'); if(ov) ov.classList.remove('show');
  document.body.style.overflow='';
}
function setPreviewWindow(days){ st.previewDays = days; renderPreviewPanel(); }
function renderPreviewPanel(){
  const r = st.previewResult; if(!r) return;
  const panel = $('#previewOverlay');
  const { coach, plan } = r;
  const lastSeqWeek = plan.seq[plan.seq.length-1];
  const minEnd = addDays(plan.start, st.previewDays);
  const end = lastSeqWeek > minEnd ? lastSeqWeek : minEnd;
  const weeks = mondaysRange(plan.start<TODAY?TODAY:plan.start, end);
  const suggestSet = new Set(plan.seq);
  let rows='';
  weeks.forEach(w=>{
    const o=occ[coach.id+'|'+w];
    const isSuggested = suggestSet.has(w);
    const visitNum = isSuggested ? plan.seq.indexOf(w)+1 : null;
    let cls='slot', label='', detail='';
    if(isSuggested && !o){ cls+=' suggest'; label=`<b>Suggested visit ${visitNum} of ${plan.seq.length}</b>`; detail='Open — would become this client\'s visit'; }
    else if(!o){ cls+=' s-open'; label='Open'; }
    else if(o.type==='visit'){ cls+= o.v.completed?' s-done':' s-visit'; label=`<b>${esc(o.v.client)}</b>`; detail=`${esc(o.v.cycle)} ${esc(o.v.program)}`; }
    else{
      const kindCls = o.kind==='mag'?'s-mag' : (o.kind==='visit'||o.kind==='visit_legacy')?'s-legacy' : o.kind==='launch_open'?'s-launch_open' : o.kind==='soft_pencil'?'s-soft':'s-block';
      cls+=' '+kindCls; label=`<b>${esc(o.label||BLOCKKINDS[o.kind]||o.kind)}</b>`; detail=esc(BLOCKKINDS[o.kind]||'');
      if(isSuggested) detail += ' — ⚠️ conflicts with the suggested cadence, pick a different start';
    }
    rows+=`<tr><td class="mono">${fmtW(w)}</td><td><div class="${cls}" style="min-height:36px;padding:4px 8px">${label}</div></td><td class="small">${detail}</td></tr>`;
  });
  panel.innerHTML = `<div class="previewbar">
      <button class="btn tiny" onclick="closePreviewOverlay()">← Back to results</button>
      <h2>${esc(coach.name)}'s calendar — Team ${esc(coach.team)}</h2>
      <span class="small" style="margin-left:auto">Showing ${fmt(weeks[0])} – ${fmt(weeks[weeks.length-1])}</span>
    </div>
    <div class="previewbody">
    <div class="controls" style="margin-bottom:8px">
      <label style="margin:0">Window</label>
      <button class="btn tiny ${st.previewDays===60?'primary':''}" onclick="setPreviewWindow(60)">60 days</button>
      <button class="btn tiny ${st.previewDays===90?'primary':''}" onclick="setPreviewWindow(90)">90 days</button>
    </div>
    <div class="legend" style="margin-bottom:8px">
      <span><i style="background:#fffaf0;border:1px dashed var(--gold)"></i>Suggested visit</span>
      <span><i style="background:var(--visit)"></i>Already booked</span>
      <span><i style="background:var(--open);border:1px dashed var(--openb)"></i>Open</span>
      <span><i style="background:#fdf6e3;border:1px dashed var(--gold)"></i>Soft pencil hold</span>
    </div>
    <div class="panel"><table><tr><th>Week of</th><th>Status</th><th>Detail</th></tr>${rows}</table></div>
    <div class="panel">
    <div class="controls">
      <label style="margin:0">Prospect / launch label</label><input id="softHoldLabel" placeholder="e.g. Acme Motors — Launch" style="min-width:220px">
      <button class="btn primary" onclick="placeSoftHold(${(st.availResults||[]).indexOf(r)})">Place soft pencil hold</button>
    </div>
    <p class="small" style="margin-top:6px">Reserves ${esc(coach.name)}'s ${plan.seq.length} suggested week(s) as tentative — visible to everyone on the Schedule Board, and blocked from being double-booked — without creating a real client or contract. Once the deal actually signs, use "Convert to client" from Availability → Active soft-pencil holds to open the New Contract form pre-filled, then place the real visits on the freed-up weeks.</p>
    </div></div>`;
}
async function placeSoftHold(i){
  const r = (st.availResults||[])[i]; if(!r) return;
  const name = ($('#softHoldLabel').value||'').trim();
  if(!name){ uiAlert('Enter the prospect\'s name so this hold is identifiable later.'); return; }
  const { coach, plan } = r;
  try{
    const resp = await api('POST','/api/prospect-holds',{ name, coachId: coach.id, program: st.availProg || 'Quarterly', weeks: plan.seq });
    await refresh();
    renderPreviewPanel();
    loadSoftHolds();
    toast(`Held ${resp.weeks.length} week(s) for ${name} — auto-releases ${fmt(resp.expires)} unless converted or extended`);
  }catch(e){ /* api() already toasted the error (e.g. a week was just taken) */ }
}
async function loadSoftHolds(){
  const out = $('#softHoldsOut'); if(!out) return;
  let holds = [];
  try{ holds = await api('GET','/api/prospect-holds'); }catch(e){ out.innerHTML='<p class="small">Could not load.</p>'; return; }
  st.holdList = holds;
  out.innerHTML = holds.length ? `<table><tr><th>Prospect</th><th>Coach</th><th>Program</th><th>Weeks held</th><th>Expires</th><th>Placed by</th><th></th></tr>` +
    holds.map(h=>{ const c=coach(h.coach_id);
      const daysLeft = h.expires ? Math.ceil((new Date(h.expires+'T12:00:00') - new Date())/864e5) : null;
      const expBadge = daysLeft===null ? '—'
        : daysLeft <= 7 ? `<span class="pill p-over">${fmt(h.expires)} · ${daysLeft}d left</span>`
        : `<span class="pill p-fut">${fmt(h.expires)}</span>`;
      return `<tr><td><b>${esc(h.name)}</b></td><td>${esc(c?c.name:h.coach_id)}${c?` <span class="small">(${esc(c.team)})</span>`:''}</td>
      <td>${esc(h.program)}</td>
      <td>${h.weeks.map(w=>`<span class="result-week">${fmtW(w)}</span>`).join('')}</td>
      <td>${expBadge}</td>
      <td class="small">${esc((h.created_by||'').split('@')[0])} · ${fmt(h.created.slice(0,10))}</td>
      <td class="actions-nowrap"><button class="btn tiny primary" onclick="convertHold(${h.id})">Convert to client</button>
      <button class="btn tiny danger" onclick="releaseHold(${h.id})">Release</button></td></tr>`;
    }).join('') + `</table>` : `<p class="small">No soft-pencil holds currently placed.</p>`;
}
async function releaseHold(id){
  const h = (st.holdList||[]).find(x=>x.id===id);
  if(!(await uiConfirm(`Release the hold for "${h?h.name:'this prospect'}"? Those weeks go back to open.`,'Release'))) return;
  await api('POST',`/api/prospect-holds/${id}/release`);
  await refresh();
  loadSoftHolds();
  if(st.view==='availability' && st.previewResult) renderPreviewPanel();
  toast('Hold released — weeks are open again');
}
/* Turning a soft pencil into the real thing: the server releases the held weeks and
   returns the hold's details; the contract itself is then created through the exact
   same New Contract form/route as every other client, so LID Inventory and Keap
   reconciliation work identically — a converted hold leaves no special residue. */
async function convertHold(id, prefillName){
  const h = (st.holdList||[]).find(x=>x.id===id);
  if(!(await uiConfirm(`Convert "${h?h.name:'this hold'}"? This frees the held week(s) and opens the New Contract form pre-filled — you'll place the real visits on those freed-up weeks afterward from the Schedule Board.`,'Convert'))) return;
  const r = await api('POST',`/api/prospect-holds/${id}/convert`);
  await refresh();
  loadSoftHolds();
  closePreviewOverlay();
  contractDlg();
  $('#cName').value = prefillName || r.name;
  $('#cProg').value = PROGRAMS.includes(r.program) ? r.program : 'Quarterly';
  onContractProgramChange();
  if(r.team) $('#cTeam').value = r.team;
  if(r.weeks && r.weeks.length) $('#cFirst').value = r.weeks[0];
  toast(`${(r.weeks||[]).length} week(s) freed up — finish creating the contract, then place the visits on those same weeks.`);
}

/* ---------- pending clients (new Keap subscriptions awaiting team assignment) ---------- */
function guessProgram(cycle, freq){
  const c=(cycle||'').toUpperCase(); const f=+freq||1;
  if(c==='MONTH'){
    if(f>=6) return 'Bi-Annual';
    if(f===3) return 'Quarterly';
    if(f===2) return 'Semi-Monthly';
    return 'Monthly';
  }
  if(c==='YEAR') return 'Bi-Annual';
  return 'Quarterly';
}
function pendingView(){
  const n = D.pendingClientCount || 0;
  return `<div class="panel"><h2>Unassigned clients</h2>
  <p class="small" style="margin-bottom:12px">New subscriptions from Keap land here first. Confirm the client name, program cadence,
  and team, then create the contract — same as adding a contract today, just pre-filled from Keap.</p>
  ${n>0 ? `<div class="controls" style="margin-bottom:10px"><button class="btn danger" onclick="ignoreAllPending()">Clear all${n?` (${n})`:''}</button></div>` : ''}
  <div id="pendingOut">Loading…</div></div>`;
}
async function ignoreAllPending(){
  const n = D.pendingClientCount || 0;
  if(!n){ toast('Nothing to ignore'); return; }
  if(!(await uiConfirm(`Clear all ${n} unassigned client(s)? This removes them outright rather than marking them ignored — use it to wipe out a bad batch (like a Backfill run from before the product filter was fixed). Because they're actually removed, not just hidden, running Backfill again afterward can cleanly re-queue anything that's genuinely a real Signature Coaching subscription.`,'Clear all'))) return;
  const r = await api('POST','/api/pending-clients/ignore-all',{});
  await refresh();
  toast(`Cleared ${r.count} item(s)`);
}
async function loadPending(){
  try{
    const rows = await api('GET','/api/pending-clients');
    st.pendingList = rows;
    $('#pendingOut').innerHTML = rows.length ? `<div style="overflow-x:auto"><table><tr><th>Company</th><th>Contact</th><th class="num">Amount</th><th>Billing</th><th>Started</th><th style="white-space:nowrap">Actions</th></tr>` +
      rows.map(r=>{
        const hm = r.hold_match;
        const matchRow = hm ? `<tr><td colspan="6" style="background:#fdf6e3;border-left:4px solid var(--gold);padding:8px 12px">
          <b>Looks like your soft-pencil hold:</b> "${esc(hm.name)}" with ${esc(hm.coachName)}${hm.team?` (Team ${esc(hm.team)})`:''} —
          ${hm.weeks.length} week(s) reserved starting ${fmtW(hm.weeks[0])}, ${esc(hm.program)}.
          <button class="btn tiny primary" style="margin-left:8px" onclick="assignPendingDlg(${r.id}, ${hm.id})">Use this hold</button>
        </td></tr>` : '';
        const future = r.start_date && r.start_date > TODAY;
        return `<tr><td><b>${esc(r.company_name||'(unknown)')}</b></td><td class="small">${esc(r.contact_name||'—')}</td>
        <td class="num">${r.billing_amount?'$'+r.billing_amount:'—'}</td><td class="small">${esc(r.billing_cycle||'—')} ×${r.billing_frequency||1}</td>
        <td class="small">${esc(r.start_date||'—')}${future?' <span class="pill p-fut">upcoming</span>':''}</td>
        <td style="white-space:nowrap"><button class="btn tiny primary" onclick="assignPendingDlg(${r.id})">Assign</button>
        <button class="btn tiny" onclick="ignorePending(${r.id})">Ignore</button>
        ${D.user.role==='admin'?`<button class="btn tiny" onclick="debugPendingClient(${r.id})">Debug</button>`:''}</td></tr>` + matchRow;
      }).join('') + `</table></div>`
      : `<p class="small">Nothing waiting — you're all caught up.</p>`;
  }catch(e){ $('#pendingOut').innerHTML = `<p class="small">Could not load.</p>`; }
}
function coachOptsFor(team){
  const list = D.coaches.filter(c=>!team||c.team===team);
  return `<option value="">— select —</option>` + list.map(c=>`<option value="${c.id}" data-team="${c.team}">${esc(c.name)} (${c.team})</option>`).join('');
}
function assignPendingDlg(id, holdId){
  const r = (st.pendingList||[]).find(x=>x.id===id); if(!r) return;
  const hm = holdId && r.hold_match && r.hold_match.id===holdId ? r.hold_match : null;
  st._pendingHoldId = hm ? hm.id : null;
  const guessed = hm && PROGRAMS.includes(hm.program) ? hm.program : guessProgram(r.billing_cycle, r.billing_frequency);
  openDlg(`<h3>Assign — ${esc(r.company_name||'(unknown)')}</h3>
    ${hm ? `<p class="small" style="background:#fdf6e3;padding:6px 10px;border-left:4px solid var(--gold)">Pre-filled from your hold "${esc(hm.name)}" — creating this contract will release the ${hm.weeks.length} reserved week(s) on ${esc(hm.coachName)}'s calendar so you can place the real visits there.</p>` : ''}
    <label>Client name</label><input id="pClient" value="${esc(r.company_name||r.contact_name||'')}">
    <label>Program</label><select id="pProg" onchange="onPendingProgramChange()">${PROGRAMS.map(p=>`<option ${p===guessed?'selected':''}>${p}</option>`).join('')}</select>
    <div id="pVisitFields">
      <label>Number of visits</label><input id="pN" type="number" value="${CYCLE_LEN[guessed]||4}">
      <label>First visit due</label><input id="pFirst" type="date" value="${(hm&&hm.weeks[0])||r.start_date||TODAY}">
      <label>Team</label><select id="pTeam">${teamOpts(hm?hm.team:undefined)}</select>
    </div>
    <div id="pCoachFields" style="display:none">
      <label>Assigned coach</label><select id="pCoach" onchange="onPendingCoachChange()">${coachOptsFor()}</select>
      <p class="small">Coaching Only — remote coaching, no LID visits will be scheduled.</p>
    </div>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveAssignPending(${id})">Create</button></div>`);
  onPendingProgramChange();
}
function onPendingProgramChange(){
  const isCoachingOnly = $('#pProg').value === 'Coaching Only';
  $('#pVisitFields').style.display = isCoachingOnly ? 'none' : '';
  $('#pCoachFields').style.display = isCoachingOnly ? '' : 'none';
}
function onPendingCoachChange(){
  const sel = $('#pCoach'); const opt = sel.options[sel.selectedIndex];
  st._pendingCoachTeam = opt ? opt.dataset.team : null;
}
/* If the assign came from a hold-match banner, converting the hold happens after the
   contract creation succeeds — freeing the coach's reserved weeks so the newly-created
   visits can be placed exactly there from the Schedule Board. */
async function finishPendingHold(){
  const holdId = st._pendingHoldId; st._pendingHoldId = null;
  if(!holdId) return '';
  try{
    const r = await api('POST',`/api/prospect-holds/${holdId}/convert`);
    return ` — ${(r.weeks||[]).length} reserved week(s) freed on ${esc(coach(r.coachId)?.name||'the coach')}'s calendar, place the visits there`;
  }catch(e){ return ' (could not auto-release the hold — release it from Availability)'; }
}
async function saveAssignPending(id){
  const client=$('#pClient').value.trim(); if(!client){uiAlert('Client name required');return;}
  const program=$('#pProg').value;
  if(program==='Coaching Only'){
    const coachId = $('#pCoach').value;
    if(!coachId){ uiAlert('Pick a coach'); return; }
    const coach = D.coaches.find(c=>c.id===coachId);
    await api('POST',`/api/pending-clients/${id}/assign`,{client, program, n:0, first:null, team:coach.team, coachId});
    const extra = await finishPendingHold();
    closeDlg(); await refresh(); toast(client+' added — Coaching Only, assigned to '+coach.name+extra);
    return;
  }
  const n=+$('#pN').value, first=$('#pFirst').value, team=$('#pTeam').value;
  if(!first||!(n>0)||!team){uiAlert('Program visit count, first due date and team are required');return;}
  await api('POST',`/api/pending-clients/${id}/assign`,{client,program,n,first,team});
  const extra = await finishPendingHold();
  closeDlg(); await refresh(); toast(client+' added — contract created'+extra);
}
async function ignorePending(id){
  if(!(await uiConfirm("Ignore this subscription? It won't be added to the LID Inventory.","Ignore"))) return;
  await api('POST',`/api/pending-clients/${id}/ignore`,{}); await refresh(); toast('Ignored');
}
async function debugPendingClient(id){
  openDlg(`<h3>Keap raw lookup</h3><p class="small">Fetching live from Keap…</p>`);
  try{
    const r = await api('GET', `/api/admin/pending-clients/${id}/keap-raw`);
    openDlg(`<h3>Keap raw lookup</h3>
      <p class="small">This is exactly what Keap returns right now for this pending item's subscription and contact — useful for figuring out why a field (like company name) isn't showing up correctly.</p>
      <h4 style="margin:10px 0 4px">Stored on this row</h4>
      <pre class="small mono" style="white-space:pre-wrap;background:var(--bg2,#f6f6f6);padding:8px;border-radius:6px;max-height:160px;overflow:auto">${esc(JSON.stringify({
        keap_subscription_id: r.pendingClient && r.pendingClient.keap_subscription_id,
        keap_contact_id: r.pendingClient && r.pendingClient.keap_contact_id,
        keap_company_id: r.pendingClient && r.pendingClient.keap_company_id,
        company_name: r.pendingClient && r.pendingClient.company_name,
        contact_name: r.pendingClient && r.pendingClient.contact_name,
      }, null, 2))}</pre>
      <h4 style="margin:10px 0 4px">Subscription</h4>
      <pre class="small mono" style="white-space:pre-wrap;background:var(--bg2,#f6f6f6);padding:8px;border-radius:6px;max-height:200px;overflow:auto">${esc(JSON.stringify(r.subscription||'(no keap_subscription_id on this row)', null, 2))}</pre>
      <h4 style="margin:10px 0 4px">Contact</h4>
      <pre class="small mono" style="white-space:pre-wrap;background:var(--bg2,#f6f6f6);padding:8px;border-radius:6px;max-height:200px;overflow:auto">${esc(JSON.stringify(r.contact||'(no keap_contact_id on this row)', null, 2))}</pre>
      <div class="dlgrow"><button class="btn" onclick="closeDlg()">Close</button></div>`);
  }catch(e){ openDlg(`<h3>Keap raw lookup</h3><p class="small" style="color:var(--bad,#c23b3b)">${esc(e.message||String(e))}</p><div class="dlgrow"><button class="btn" onclick="closeDlg()">Close</button></div>`); }
}

/* ---------- clients (profiles) ---------- */
const CLIENT_COLS = [
  { key:'name', label:'Client', type:'string' },
  { key:'health', label:'Health', type:'string' },
  { key:'status', label:'Status', type:'string' },
  { key:'programs', label:'Product type', type:'string' },
  { key:'revenue', label:'Revenue', type:'num' },
  { key:'active_contracts', label:'Active contracts', type:'num' },
  { key:'assigned_coach_name', label:'Assigned coach', type:'string' },
];
function clientsView(){
  if(!st.cliSort) st.cliSort = { key:'name', dir:'asc' };
  if(!st.cliSel) st.cliSel = new Set();
  return `<div class="panel"><h2>Clients</h2>
  <p class="small" style="margin-bottom:12px">Every dealership we've coached — with who's assigned, Keap-imported details, and a running notes history. Click a column header to sort.</p>
  <div class="controls"><input placeholder="Search client…" id="cliSearch" value="${esc(st.cliSearch||'')}" oninput="st.cliSearch=this.value;renderClientTable()" style="width:260px">
    ${['admin','lead'].includes(D.user.role) ? `<a class="btn tiny" href="/api/clients/export.csv">Export CSV</a>` : ''}
    ${D.user.role==='admin' ? `<button class="btn tiny" id="keapSyncBtn" onclick="syncWithKeap()">Sync with Keap</button>` : ''}
  </div>
  <div id="cliBulkOut"></div>
  <div id="clientsOut">Loading…</div></div>`;
}
async function syncWithKeap(){
  const btn = $('#keapSyncBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'Syncing…'; }
  try{
    const r = await api('POST','/api/keap/sync',{});
    const lines = [
      `Checked ${r.checked} Keap-linked contract(s).`,
      `Price updated: ${r.priceChanged}`,
      `Status changed: ${r.statusChanged}`,
      r.notFound ? `Not found in Keap: ${r.notFound}` : '',
      r.errors && r.errors.length ? `Errors: ${r.errors.length}\n  ${r.errors.slice(0,5).join('\n  ')}` : '',
      typeof r.totalRevenue==='number' ? `\nCurrent active revenue total: ${fmtMoney(r.totalRevenue)} across ${r.activeClients} active client(s).` : '',
    ].filter(Boolean).join('\n');
    uiAlert(lines);
    await loadClients();
  }catch(e){
    uiAlert('Sync failed: ' + (e.message||e));
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = 'Sync with Keap'; }
  }
}
async function loadClients(){
  try{ st.clientsList = await api('GET','/api/clients'); renderClientTable(); }
  catch(e){ $('#clientsOut').innerHTML = '<p class="small">Could not load.</p>'; }
}
function sortClients(key){
  if(st.cliSort.key===key) st.cliSort.dir = st.cliSort.dir==='asc'?'desc':'asc';
  else st.cliSort = { key, dir:'asc' };
  renderClientTable();
}
function fmtMoney(n){ return (n||n===0) ? '$'+Number(n).toLocaleString(undefined,{maximumFractionDigits:0}) : '—'; }
const healthPill = h =>
  h==='at_risk' ? '<span class="pill p-over">At risk</span>'
  : h==='behind' ? '<span class="pill p-due">Behind</span>'
  : h==='on_track' ? '<span class="pill p-done">On track</span>'
  : '<span class="pill p-fut">—</span>';
function noticePill(c){
  if(!c.notice_given_date || c.status==='cancelled') return '';
  const daysSince = Math.floor((Date.now() - new Date(c.notice_given_date+'T12:00:00').getTime()) / 86400000);
  return daysSince > 30 ? ' <span class="pill p-over">Notice expired — follow up</span>'
    : ` <span class="pill p-due">On notice — day ${daysSince}/30</span>`;
}
function renderClientTable(){
  const box = $('#clientsOut'); if(!box) return;
  const canBulk = ['admin','lead'].includes(D.user.role);
  const sel = st.cliSel || (st.cliSel = new Set());
  const q = norm(st.cliSearch||'');
  let rows = (st.clientsList||[]).slice();
  if(q) rows = rows.filter(c=>norm(c.name).includes(q));
  const { key, dir } = st.cliSort;
  const col = CLIENT_COLS.find(c=>c.key===key);
  rows.sort((a,b)=>{
    let av=a[key], bv=b[key];
    if(col.type==='num'){ av=+av||0; bv=+bv||0; return dir==='asc'?av-bv:bv-av; }
    av=(av||'').toString().toLowerCase(); bv=(bv||'').toString().toLowerCase();
    return dir==='asc'?av.localeCompare(bv):bv.localeCompare(av);
  });
  const totalRevenue = rows.reduce((s,c)=>s+(Number(c.revenue)||0),0);
  const arrow = k => st.cliSort.key===k ? (st.cliSort.dir==='asc'?' ▲':' ▼') : '';
  const th = c => `<th class="${c.type==='num'?'num':''}" style="cursor:pointer;user-select:none" onclick="sortClients('${c.key}')">${c.label}<span class="small">${arrow(c.key)}</span></th>`;
  const bulkOut = $('#cliBulkOut');
  if(bulkOut) bulkOut.innerHTML = (canBulk && sel.size) ? `<div class="panel" style="border-left:4px solid var(--primary);padding:10px 14px;margin-bottom:12px">
    <b>${sel.size} selected</b>
    <button class="btn tiny danger" style="margin-left:10px" onclick="giveNoticeDlg()">Give 30-day notice</button>
    <button class="btn tiny" onclick="st.cliSel=new Set();renderClientTable()">Clear selection</button></div>` : '';
  box.innerHTML = `<table><tr>${canBulk?`<th style="width:26px"><input type="checkbox" ${rows.length&&rows.every(c=>sel.has(c.id))?'checked':''} onclick="toggleClientAll(this.checked)"></th>`:''}${CLIENT_COLS.map(th).join('')}<th></th></tr>` +
    rows.map(c=>`<tr>${canBulk?`<td onclick="event.stopPropagation()"><input type="checkbox" ${sel.has(c.id)?'checked':''} onclick="toggleClientSel(${c.id},this.checked)"></td>`:''}<td><b>${esc(c.name)}</b>${noticePill(c)}</td>
      <td>${healthPill(c.health)}</td>
      <td>${c.status==='active'?'<span class="pill p-done">active</span>':c.status==='cancelled'?'<span class="pill p-over">cancelled</span>':'<span class="pill">inactive</span>'}</td>
      <td>${esc(c.programs||'—')}</td>
      <td class="num">${fmtMoney(c.revenue)}</td>
      <td class="num">${c.active_contracts}</td><td>${esc(c.assigned_coach_name||'—')}</td>
      <td><button class="btn tiny" onclick="openClientProfile(${c.id})">View profile →</button></td></tr>`).join('') +
    `<tr style="font-weight:600;border-top:2px solid var(--border,#ccc)">
      <td colspan="${canBulk?5:4}">Total — ${rows.length} client${rows.length===1?'':'s'}</td>
      <td class="num">${fmtMoney(totalRevenue)}</td><td></td><td></td><td></td></tr>` +
    `</table>` + (rows.length ? '' : `<p class="small">No clients match.</p>`);
}
function toggleClientSel(id, on){ if(on) st.cliSel.add(id); else st.cliSel.delete(id); renderClientTable(); }
function toggleClientAll(on){
  const q = norm(st.cliSearch||'');
  const visible = (st.clientsList||[]).filter(c=>!q||norm(c.name).includes(q));
  st.cliSel = on ? new Set(visible.map(c=>c.id)) : new Set();
  renderClientTable();
}
function giveNoticeDlg(){
  const ids = [...st.cliSel];
  if(!ids.length) return;
  const names = (st.clientsList||[]).filter(c=>ids.includes(c.id)).map(c=>c.name);
  openDlg(`<h3>Give 30-day notice</h3>
    <p class="small" style="margin-bottom:10px">For: ${names.map(esc).join(', ')}</p>
    <label>Date the notice email came in</label><input type="date" id="noticeDate" value="${TODAY}">
    <p class="small" style="margin:10px 0;color:var(--bad,#c23b3b)"><b>This deletes every one of their upcoming/unscheduled visits right now — permanently, not a soft delete.</b> The client's status and revenue are untouched (they're still active through their last paid month); this only stops scheduling new coaching work for them. If notice gets rescinded later, new visits have to be added by hand.</p>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn danger" onclick="doGiveNotice()">Confirm — remove their LIDs</button></div>`);
}
async function doGiveNotice(){
  const ids = [...st.cliSel];
  const noticeDate = $('#noticeDate').value || TODAY;
  closeDlg();
  try{
    const r = await api('POST','/api/clients/notice',{ clientIds: ids, noticeDate });
    st.cliSel = new Set();
    await refresh();
    toast(`${r.clientsUpdated} client(s) marked on notice — ${r.visitsDeleted} visit(s) removed`);
  }catch(e){}
}
async function clearClientNotice(id){
  if(!(await uiConfirm('Clear the notice marker for this client? This does not restore any visits that were already removed.','Clear notice'))) return;
  await api('POST',`/api/clients/${id}/notice/clear`,{});
  await refresh();
  toast('Notice cleared');
}
function openClientProfile(id){ st.view='clientprofile'; st.clientId=id; render(); }
async function loadClientProfile(id){
  try{
    const data = await api('GET','/api/clients/'+id);
    st.clientProfile = data;
    const notes = await api('GET','/api/clients/'+id+'/notes');
    st.clientNotes = notes;
    $('#main').innerHTML = clientProfileView(data, notes);
  }catch(e){ $('#main').innerHTML = '<div class="panel"><p class="small">Could not load this client.</p></div>'; }
}
const HEALTH_STYLE = {
  on_track: { bg:'#e2f4ea', border:'var(--ok)', ink:'#186b45' },
  behind:   { bg:'#fdeecd', border:'var(--warn)', ink:'#8a5b06' },
  at_risk:  { bg:'#fbe3e3', border:'var(--bad)', ink:'#a12626' },
  inactive: { bg:'#f0f0f1', border:'#9a9aa2', ink:'#55555c' },
};
function healthBanner(h){
  if(!h) return '';
  const s = HEALTH_STYLE[h.level] || HEALTH_STYLE.inactive;
  return `<div style="background:${s.bg};border-left:5px solid ${s.border};padding:12px 16px;margin-bottom:14px">
    <div style="font-family:var(--head);font-size:15px;letter-spacing:1px;text-transform:uppercase;color:${s.ink};font-weight:600">${esc(h.label)}</div>
    ${h.reasons.map(r=>`<div style="font-size:13px;margin-top:4px">• ${esc(r)}</div>`).join('')}
    ${h.warnings.map(w=>`<div style="font-size:12.5px;margin-top:4px;color:var(--muted)">⚠ ${esc(w)}</div>`).join('')}
  </div>`;
}
function clientProfileView(data, notes){
  const { client, assignedCoach, contracts, visits, visitProgress, health } = data;
  const pct = visitProgress.total ? Math.round(visitProgress.completed/visitProgress.total*100) : 0;
  const activeContract = contracts.find(c=>c.status==='active');
  let html = healthBanner(health);
  html += `<div class="panel">
    <div class="controls">
      <button class="btn tiny" onclick="go('clients')">← All clients</button>
      <span style="flex:1"></span>
      ${canEdit() && client.notice_given_date && client.status!=='cancelled' ? `<button class="btn tiny" onclick="clearClientNotice(${client.id})">Clear notice</button>` : ''}
      ${D.user.role==='admin' ? `<button class="btn tiny danger" onclick="deleteClientDlg(${client.id},'${esc(client.name).replace(/'/g,"\\'")}')">Delete client</button>` : ''}
    </div>
    <h2 style="margin-top:8px">${esc(client.name)}
      ${client.status==='active'?'<span class="pill p-done">active</span>':client.status==='cancelled'?'<span class="pill p-over">cancelled</span>':'<span class="pill">inactive</span>'}${noticePill(client)}
    </h2>
    ${client.notice_given_date ? `<p class="small" style="color:var(--muted)">30-day notice given ${fmt(client.notice_given_date)}${client.status!=='cancelled'?' — no open visits are scheduled for them':''}</p>` : ''}
    <div class="cards" style="margin-top:12px">
      <div class="card"><div class="k">${visitProgress.completed}/${visitProgress.total}</div><div class="l">Visits completed — ${visitProgress.year}</div></div>
      <div class="card"><div class="k">${contracts.filter(c=>c.status==='active').length}</div><div class="l">Active contracts</div></div>
      <div class="card"><div class="k">${fmt(client.billing_start)}</div><div class="l">First paid</div></div>
    </div>
    <div class="bar" style="margin-top:10px;max-width:400px"><div style="width:${pct}%;background:var(--primary)"></div><div style="width:${100-pct}%;background:var(--open)"></div></div>
  </div>`;

  html += `<div class="panel"><h2>Assignment &amp; Keap details</h2>`;
  if(canEdit()){
    html += `<label>Assigned coach</label>
      <select id="cliCoach" onchange="saveAssignedCoach(${client.id},this.value)">
        <option value="">— unassigned —</option>
        ${D.coaches.map(c=>`<option value="${c.id}" ${assignedCoach&&assignedCoach.id===c.id?'selected':''}>${esc(c.name)} (${c.team})</option>`).join('')}
      </select>`;
  } else {
    html += `<p><b>Assigned coach:</b> ${esc(assignedCoach?assignedCoach.name:'— unassigned —')}</p>`;
  }
  html += `<table style="margin-top:10px"><tr><th>Program</th><th>Cadence (visits)</th><th>Started</th><th class="num">Price</th><th>Status</th><th>Source</th></tr>` +
    contracts.map(c=>`<tr><td>${esc(c.program||'—')}</td><td class="num">${c.visits}</td><td class="mono">${fmt(c.start_date)}</td>
      <td class="num">${c.price?'$'+c.price:'—'}</td>
      <td>${c.status==='active'?'<span class="pill p-done">active</span>':c.status==='cancelled'?'<span class="pill p-over">cancelled</span>':'<span class="pill">completed</span>'}</td>
      <td class="small">${esc(c.source||'—')}</td></tr>`).join('') +
    `</table>
    <p class="small" style="margin-top:8px">Keap company ID: <span class="mono">${esc(client.keap_id||'—')}</span>${activeContract&&activeContract.keap_subscription_id?` · Active subscription ID: <span class="mono">${esc(activeContract.keap_subscription_id)}</span>`:''}</p>
  </div>`;

  html += `<div class="panel"><h2>Visit history</h2><table><tr><th>Due</th><th>Program</th><th>Cycle</th><th>Status</th></tr>` +
    visits.slice().reverse().map(v=>{
      const pill = v.completed?'<span class="pill p-done">completed</span>'
        : v.cal_week?(v.due&&v.due<TODAY?'<span class="pill p-due">late — on calendar</span>':'<span class="pill p-cal">on calendar</span>')
        : (v.due&&v.due<TODAY?'<span class="pill p-over">overdue — no plan</span>':'<span class="pill p-due">needs scheduling</span>');
      return `<tr><td class="mono">${fmt(v.due)}</td><td>${esc(v.program)}</td><td class="mono">${esc(v.cycle)}</td><td>${pill}</td></tr>`;
    }).join('') +
    `</table>${visits.length?'':'<p class="small">No visits recorded yet.</p>'}</div>`;

  html += `<div class="panel"><h2>Notes</h2>
    <p class="small" style="margin-bottom:10px">Any coach, lead, or admin can add a note here — this is meant to replace jotting notes in Keap going forward. Only admins can edit or delete a note.</p>
    <div class="controls" style="margin-bottom:6px">
      <label style="margin:0">Date</label><input type="date" id="cliNoteDate" value="${TODAY}" style="width:150px">
      <label style="margin:0">Type</label><select id="cliNoteType"><option>Coaching Call</option><option>LID</option></select>
    </div>
    <textarea id="cliNoteBody" rows="3" style="width:100%;box-sizing:border-box" placeholder="Add a note about this client…"></textarea>
    <div class="dlgrow" style="margin-top:6px">
      <button class="btn primary" onclick="saveClientNote(${client.id})">Add note</button>
      ${canEdit() && client.keap_id ? `<button class="btn" onclick="keapNotesPreviewDlg(${client.id})">Import from Keap…</button>` : ''}
    </div>
    <div style="margin-top:14px">${notes.length ? notes.map(n=>clientNoteCard(client.id, n)).join('') : '<p class="small">No notes yet.</p>'}</div>
  </div>`;

  html += `<div class="panel"><h2>Coming soon</h2>
    <p class="small">Zoom coaching call recordings/transcripts — coming soon once Zoom API access is set up.</p>
    <p class="small">Top Dog Underground daily tracking data — coming soon once that integration is available.</p>
  </div>`;
  return html;
}
function openCoachProfile(id){ st.view='coachprofile'; st.coachId=id; render(); }
async function loadCoachProfile(id){
  const data = await api('GET', '/api/coaches/'+id+'/profile');
  $('#main').innerHTML = coachProfileView(data);
}
function coachProfileView(data){
  const { coach, assignedClients, stats, visitHistory, upcoming, notes, todo } = data;
  const isSelf = D.user.role==='coach';
  const canManage = D.user.role==='admin' || D.user.role==='lead';
  let html = `<div class="panel">
    <div class="controls">
      ${!isSelf ? `<button class="btn tiny" onclick="go('admin')">← Admin</button>` : ''}
      <span style="flex:1"></span>
      ${canManage ? `<button class="btn tiny" onclick="editCoachDlg('${coach.id}')">Edit profile</button>` : ''}
      ${(canManage && coach.active) ? `<button class="btn tiny danger" onclick="removeCoach('${coach.id}','${esc(coach.name).replace(/'/g,"\\'")}')">Deactivate coach</button>` : ''}
    </div>
    <h2 style="margin-top:8px;display:flex;align-items:center;gap:10px">${avatarHtml(coach.name,coach.team,40)}
      <span>${esc(coach.name)} <span class="small">— Team ${esc(coach.team)}</span>
      ${coach.active ? '' : '<span class="pill p-over">inactive</span>'}</span>
    </h2>
    <p class="small" style="margin-top:6px">${coach.phone?`Phone: ${esc(coach.phone)} · `:''}${coach.start_date?`Start date: ${fmt(coach.start_date)}`:''}${(!coach.phone&&!coach.start_date)?'No phone or start date on file yet.':''}</p>
    <div class="cards" style="margin-top:12px">
      <div class="card"><div class="k">${stats.assignedStores}</div><div class="l">Assigned stores</div></div>
      <div class="card"><div class="k">${stats.completedThisYear}</div><div class="l">Visits completed this year</div></div>
      <div class="card"><div class="k">${stats.allTimeCompleted}</div><div class="l">Visits completed, all-time</div></div>
      <div class="card"><div class="k">${stats.upcomingCount}</div><div class="l">On the calendar now</div></div>
    </div>
  </div>`;

  const todoTotal = (todo.overdue.length + todo.dueSoon.length + todo.missingNotes.length);
  html += `<div class="panel"><h2>To-do${todoTotal?` (${todoTotal})`:''}</h2>`;
  if(!todoTotal){
    html += `<p class="small">Nothing outstanding — no overdue stores, nothing due in the next 2 weeks, and every completed visit has a note.</p>`;
  } else {
    if(todo.overdue.length) html += `<h3 style="color:var(--bad)">Overdue (${todo.overdue.length})</h3><table><tr><th>Client</th><th>Program</th><th>Was due</th></tr>` +
      todo.overdue.map(v=>`<tr><td>${v.client_id?`<a onclick="openClientProfile(${v.client_id})" style="cursor:pointer;color:var(--primary);text-decoration:underline">${esc(v.client)}</a>`:esc(v.client)}</td><td>${esc(v.program||'—')}</td><td class="mono">${fmt(v.due)}</td></tr>`).join('') + `</table>`;
    if(todo.dueSoon.length) html += `<h3>Due within 2 weeks (${todo.dueSoon.length})</h3><table><tr><th>Client</th><th>Program</th><th>Due</th></tr>` +
      todo.dueSoon.map(v=>`<tr><td>${v.client_id?`<a onclick="openClientProfile(${v.client_id})" style="cursor:pointer;color:var(--primary);text-decoration:underline">${esc(v.client)}</a>`:esc(v.client)}</td><td>${esc(v.program||'—')}</td><td class="mono">${fmt(v.due)}</td></tr>`).join('') + `</table>`;
    if(todo.missingNotes.length) html += `<h3>Completed visits missing a note (${todo.missingNotes.length})</h3><table><tr><th>Client</th><th>Completed</th></tr>` +
      todo.missingNotes.map(v=>`<tr><td>${v.client_id?`<a onclick="openClientProfile(${v.client_id})" style="cursor:pointer;color:var(--primary);text-decoration:underline">${esc(v.client)}</a>`:esc(v.client)}</td><td class="mono">${fmt(v.completed_on)}</td></tr>`).join('') + `</table>`;
  }
  html += `</div>`;

  html += `<div class="panel"><h2>Assigned stores</h2>` +
    (assignedClients.length ? `<table><tr><th>Client</th><th>Status</th></tr>` +
      assignedClients.map(c=>`<tr><td><a onclick="openClientProfile(${c.id})" style="cursor:pointer;color:var(--primary);text-decoration:underline">${esc(c.name)}</a></td>
        <td>${c.status==='active'?'<span class="pill p-done">active</span>':c.status==='cancelled'?'<span class="pill p-over">cancelled</span>':'<span class="pill">inactive</span>'}</td></tr>`).join('') + `</table>`
      : `<p class="small">No stores currently assigned.</p>`) + `</div>`;

  if(upcoming.length){
    html += `<div class="panel"><h2>On the calendar</h2><table><tr><th>Client</th><th>Program</th><th>Due</th><th>Scheduled week</th></tr>` +
      upcoming.map(v=>`<tr><td>${v.client_id?`<a onclick="openClientProfile(${v.client_id})" style="cursor:pointer;color:var(--primary);text-decoration:underline">${esc(v.client)}</a>`:esc(v.client)}</td>
        <td>${esc(v.program||'—')}</td><td class="mono">${fmt(v.due)}</td><td class="mono">${fmtW(v.cal_week)}</td></tr>`).join('') + `</table></div>`;
  }

  html += `<div class="panel"><h2>Visit history</h2>
    <p class="small" style="margin-bottom:8px">Every visit ${esc(coach.name)} has completed, credited to them permanently regardless of any later reassignment.</p>` +
    (visitHistory.length ? `<table><tr><th>Client</th><th>Program</th><th>Completed</th></tr>` +
      visitHistory.map(v=>`<tr><td>${v.client_id?`<a onclick="openClientProfile(${v.client_id})" style="cursor:pointer;color:var(--primary);text-decoration:underline">${esc(v.client)}</a>`:esc(v.client)}</td>
        <td>${esc(v.program||'—')}</td><td class="mono">${fmt(v.completed_on)}</td></tr>`).join('') + `</table>`
      : `<p class="small">No completed visits on record yet.</p>`) + `</div>`;

  html += `<div class="panel"><h2>Notes</h2>
    <p class="small" style="margin-bottom:8px">Notes ${esc(coach.name)} has logged, across all their stores.</p>` +
    (notes.length ? notes.map(n=>`<div class="duecard">
      <div class="meta"><b>${fmt(n.note_date)} — ${esc(n.note_type)}</b> · <a onclick="openClientProfile(${n.client_id})" style="cursor:pointer;color:var(--primary);text-decoration:underline">${esc(n.client_name)}</a>${n.source==='keap'?' <span class="pill" style="background:#e2f0f0;color:#2a6a6a">via Keap</span>':''}</div>
      <div style="margin-top:4px;white-space:pre-wrap">${esc(n.body)}</div>
    </div>`).join('') : `<p class="small">No notes logged yet.</p>`) + `</div>`;
  return html;
}
function coachDeactivateDlg(id, name){
  const leaving = D.coaches.find(c=>c.id===id);
  const teammates = D.coaches.filter(c=>c.id!==id && (!leaving || c.team===leaving.team))
    .sort((a,b)=>(a.assigned_stores||0)-(b.assigned_stores||0)); // lightest-loaded first
  openDlg(`<h3>Deactivate ${esc(name)}?</h3>
    <p class="small">Their completed visit history stays intact and stays credited to them — nothing there changes.
    Choose what happens to their ${leaving?.assigned_stores||0} current store(s) and ${leaving?.upcoming_count||0} upcoming visit(s):</p>
    <h3>Current workload — Team ${esc(leaving?.team||'')}</h3>
    <table style="margin-bottom:10px"><tr><th>Coach</th><th class="num">Stores</th><th class="num">Upcoming</th></tr>
      ${teammates.map(c=>`<tr><td>${esc(c.name)}</td><td class="num">${c.assigned_stores||0}</td><td class="num">${c.upcoming_count||0}</td></tr>`).join('') || '<tr><td colspan="3" class="small">No other coaches on this team.</td></tr>'}
    </table>
    <label>Reassign stores &amp; upcoming visits to</label>
    <select id="reassignTo"><option value="">— leave unassigned instead —</option>
      ${teammates.map(c=>`<option value="${c.id}">${esc(c.name)} (${c.assigned_stores||0} stores, ${c.upcoming_count||0} upcoming)</option>`).join('')}</select>
    <p class="small" style="margin-top:4px">Lightest-loaded teammates are listed first. All of this coach's stores go to a single pick — split manually afterward from each client's profile if you'd rather divide the book across two or three people.</p>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary danger" onclick="doDeactivateCoach('${id}','${esc(name).replace(/'/g,"\\'")}')">Deactivate</button></div>`);
}
function editCoachDlg(id){
  const c = D.coaches.find(x=>x.id===id) || st.coachProfileCoach;
  openDlg(`<h3>Edit profile</h3>
    <label>Name</label><input id="ecName" value="${esc(c.name)}">
    <label>Team</label><select id="ecTeam">${teamOpts(c.team)}</select>
    <label>Phone</label><input id="ecPhone" value="${esc(c.phone||'')}" placeholder="(555) 555-5555">
    <label>Start date</label><input type="date" id="ecStart" value="${c.start_date||''}">
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveCoachEdit('${id}')">Save</button></div>`);
}
async function saveCoachEdit(id){
  const name = $('#ecName').value.trim(); if(!name){ uiAlert('Name required'); return; }
  await api('PATCH','/api/coaches/'+id, { name, team: $('#ecTeam').value, phone: $('#ecPhone').value.trim(), start_date: $('#ecStart').value || null });
  closeDlg(); await refresh(); toast('Profile updated');
  if(st.view==='coachprofile') await loadCoachProfile(st.coachId);
}
function editUserDlg(id){
  const u = (D.users||[]).find(x=>x.id===id); if(!u) return;
  openDlg(`<h3>Edit user</h3>
    <label>Name</label><input id="euName" value="${esc(u.name)}">
    <label>Email</label><input id="euEmail" value="${esc(u.email)}" autocomplete="off">
    <label>Role</label><select id="euRole"><option ${u.role==='admin'?'selected':''}>admin</option><option ${u.role==='lead'?'selected':''}>lead</option><option ${u.role==='sales'?'selected':''}>sales</option><option ${u.role==='coach'?'selected':''}>coach</option></select>
    <label>Team</label><select id="euTeam">${teamOpts(u.team)}</select>
    <label>Coach link (for coach role)</label><select id="euCoach"><option value="">—</option>${D.coaches.map(c=>`<option value="${c.id}" ${u.coach_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveUserEdit(${u.id})">Save</button></div>`);
}
async function saveUserEdit(id){
  const name = $('#euName').value.trim(); const email = $('#euEmail').value.trim();
  if(!name || !email){ uiAlert('Name and email required'); return; }
  await api('PATCH','/api/users/'+id, { name, email, role: $('#euRole').value, team: $('#euTeam').value, coach_id: $('#euCoach').value || null });
  closeDlg(); await refresh(); toast('User updated');
}
async function doDeactivateCoach(id, name){
  const reassignToCoachId = $('#reassignTo').value || undefined;
  const r = await api('DELETE','/api/coaches/'+id, reassignToCoachId ? { reassignToCoachId } : undefined);
  closeDlg(); await refresh();
  const parts = [];
  if(r.storesMoved) parts.push(`${r.storesMoved} store(s) ${reassignToCoachId?'reassigned':'unassigned'}`);
  const c = r.cascade;
  if(c){
    if(c.keptWeek) parts.push(`${c.keptWeek} scheduled visit(s) moved with their week intact`);
    if(c.needsReplacing) parts.push(`${c.needsReplacing} visit(s) need re-placing (the new coach's week was already taken) — check that team's to-schedule list`);
    if(c.unscheduled) parts.push(`${c.unscheduled} visit(s) taken off the calendar`);
  }
  toast(`${name} deactivated${parts.length ? ' — ' + parts.join('; ') : ''}`);
  if(st.view==='coachprofile') go('admin');
}
async function saveAssignedCoach(clientId, coachId){
  const r = await api('PATCH','/api/clients/'+clientId, { assigned_coach_id: coachId || null });
  if(r.cascade){
    const c = r.cascade;
    const parts = [];
    if(c.keptWeek) parts.push(`${c.keptWeek} scheduled visit(s) moved with their week intact`);
    if(c.teamMoved) parts.push(`${c.teamMoved} unscheduled visit(s) moved to Team ${r.newTeam}'s list`);
    if(c.needsReplacing) parts.push(`${c.needsReplacing} visit(s) need re-placing (the new coach's week was taken) — they're in Team ${r.newTeam}'s to-schedule list`);
    toast(parts.length ? 'Coach reassigned — ' + parts.join('; ') : 'Coach assignment saved');
  } else {
    toast('Coach assignment saved');
  }
  await refresh();
  await loadClientProfile(clientId);
}
function deleteClientDlg(clientId, clientName){
  openDlg(`<h3>Delete ${esc(clientName)}?</h3>
    <p class="small">This removes the client from every list immediately. It's recoverable for 30 days from Admin → Recently deleted — after that it's purged for good, along with its contracts, visits, and notes.</p>
    <label>Type the client name to confirm</label><input id="delConfirm" placeholder="${esc(clientName)}">
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary danger" onclick="doDeleteClient(${clientId},'${esc(clientName).replace(/'/g,"\\'")}')">Delete</button></div>`);
}
async function doDeleteClient(clientId, clientName){
  if($('#delConfirm').value.trim() !== clientName){ uiAlert('Name does not match — nothing was deleted.'); return; }
  await api('DELETE','/api/clients/'+clientId);
  closeDlg(); toast(clientName+' deleted');
  go('clients');
}
function clientNoteCard(clientId, n){
  const title = `${fmt(n.note_date)} — ${esc(n.note_type)}`;
  const isAdmin = D.user.role === 'admin';
  const editedTag = n.edited ? ` <span class="small">(edited ${n.edited.slice(0,16).replace('T',' ')})</span>` : '';
  const keapTag = n.source === 'keap' ? ` <span class="pill" style="background:#e2f0f0;color:#2a6a6a">via Keap</span>` : '';
  return `<div class="duecard" id="note-${n.id}">
    <div class="meta"><b>${title}</b>${keapTag} · ${esc(n.author_name||n.author_email)} · logged ${n.created.slice(0,16).replace('T',' ')}${editedTag}</div>
    <div style="margin-top:4px;white-space:pre-wrap" id="note-body-${n.id}">${esc(n.body)}</div>
    ${isAdmin ? `<div class="dlgrow" style="margin-top:6px">
      <button class="btn tiny" onclick="editNoteDlg(${clientId},${n.id})">Edit</button>
      <button class="btn tiny danger" onclick="deleteClientNote(${clientId},${n.id})">Delete</button>
    </div>` : ''}
  </div>`;
}
async function keapNotesPreviewDlg(clientId){
  openDlg(`<h3>Import notes from Keap</h3><p class="small">Fetching candidate notes from Keap…</p>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Close</button></div>`);
  let r;
  try{ r = await api('GET', '/api/clients/'+clientId+'/keap-notes-preview'); }
  catch(e){ openDlg(`<h3>Import notes from Keap</h3><p class="small" style="color:var(--bad)">${esc(e.message||String(e))}</p><div class="dlgrow"><button class="btn" onclick="closeDlg()">Close</button></div>`); return; }
  st.keapPreview = r.candidates;
  if(!r.candidates.length){
    openDlg(`<h3>Import notes from Keap</h3>
      <p class="small">No new candidate notes found (checked ${r.totalFetched} Keap note(s); ${r.excludedCount} were system-generated or already imported).</p>
      <div class="dlgrow"><button class="btn" onclick="closeDlg()">Close</button></div>`);
    return;
  }
  const rows = r.candidates.map((c,i)=>`
    <div class="duecard">
      <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer">
        <input type="checkbox" class="knImport" value="${esc(c.keap_note_id)}" checked style="margin-top:3px">
        <span>
          <b>${esc(c.title||'(untitled)')}</b> <span class="small">— ${fmt(c.note_date)} · ${esc(c.author_name||'unknown')}</span>
          <div class="small" style="white-space:pre-wrap;margin-top:3px;max-height:80px;overflow:auto">${esc((c.body||'').slice(0,400))}${(c.body||'').length>400?'…':''}</div>
        </span>
      </label>
    </div>`).join('');
  openDlg(`<h3>Import notes from Keap</h3>
    <p class="small" style="margin-bottom:8px">${r.candidates.length} candidate note(s) found (checked ${r.totalFetched} total Keap note(s); ${r.excludedCount} filtered out as system-generated or already imported). Review and uncheck any you don't want, then import.</p>
    <div style="max-height:50vh;overflow-y:auto">${rows}</div>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="doImportKeapNotes(${clientId})">Import selected</button></div>`);
}
async function doImportKeapNotes(clientId){
  const noteIds = Array.from(document.querySelectorAll('.knImport:checked')).map(x=>x.value);
  if(!noteIds.length){ uiAlert('Select at least one note to import.'); return; }
  const r = await api('POST', '/api/clients/'+clientId+'/keap-notes-import', { noteIds });
  closeDlg(); toast(`Imported ${r.imported} note(s) from Keap`);
  await loadClientProfile(clientId);
}
async function saveClientNote(clientId){
  const body = $('#cliNoteBody').value.trim();
  if(!body){ uiAlert('Note cannot be empty'); return; }
  const note_date = $('#cliNoteDate').value || TODAY;
  const note_type = $('#cliNoteType').value;
  await api('POST','/api/clients/'+clientId+'/notes', { body, note_date, note_type });
  toast('Note added');
  await loadClientProfile(clientId);
}
function editNoteDlg(clientId, noteId){
  const n = (st.clientNotes||[]).find(x=>x.id===noteId); if(!n) return;
  openDlg(`<h3>Edit note</h3>
    <label>Date</label><input type="date" id="enDate" value="${n.note_date}">
    <label>Type</label><select id="enType"><option ${n.note_type==='Coaching Call'?'selected':''}>Coaching Call</option><option ${n.note_type==='LID'?'selected':''}>LID</option></select>
    <label>Note</label><textarea id="enBody" rows="4" style="width:100%;box-sizing:border-box">${esc(n.body)}</textarea>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveEditedNote(${clientId},${noteId})">Save</button></div>`);
}
async function saveEditedNote(clientId, noteId){
  const body = $('#enBody').value.trim();
  if(!body){ uiAlert('Note cannot be empty'); return; }
  await api('PATCH',`/api/clients/${clientId}/notes/${noteId}`, { body, note_date: $('#enDate').value, note_type: $('#enType').value });
  closeDlg(); toast('Note updated');
  await loadClientProfile(clientId);
}
async function deleteClientNote(clientId, noteId){
  if(!(await uiConfirm('Delete this note? This cannot be undone.','Delete'))) return;
  await api('DELETE',`/api/clients/${clientId}/notes/${noteId}`);
  toast('Note deleted');
  await loadClientProfile(clientId);
}

/* ---------- my schedule (coach) ---------- */
function mySchedule(){
  const cid=D.user.coach_id;
  const c=coach(cid);
  if(!c) return `<div class="panel"><h2>My schedule</h2><p class="small">Your account isn't linked to a coach yet — ask an admin to set it in Admin → Users.</p></div>`;
  const weeks=mondaysRange(TODAY,addDays(TODAY,7*16));
  let html=`<div class="panel"><h2>${esc(c.name)} — next 16 weeks</h2><table><tr><th>Week of</th><th>Assignment</th><th>Details</th></tr>`;
  for(const w of weeks){
    const o=occ[cid+'|'+w];
    let what='<span class="pill p-done">Open</span>', det='';
    if(o&&o.type==='visit'){ what=`<b>${esc(o.v.client)}</b>`; det=`${esc(o.v.cycle)} ${esc(o.v.program)} · due ${fmt(o.v.due)}`; }
    else if(o){ what=esc(o.label||BLOCKKINDS[o.kind]||o.kind); det=esc(BLOCKKINDS[o.kind]||''); }
    html+=`<tr><td class="mono">${fmtW(w)}</td><td>${what}</td><td class="small">${det}</td></tr>`;
  }
  return html+`</table></div>`;
}

/* ---------- FAQ / SOPs ---------- */
const FAQ = [
  { cat: 'Visits & completion', roles: ['admin','lead','sales','coach'], items: [
    { q: 'Who can mark a visit complete?', a: `Only the coach who scheduled it (they're listed as the calendar coach for that slot) or the coach permanently assigned to that client. An admin or lead can complete any visit on their team. This is checked on the server every time — a coach can't complete a visit for a store that isn't theirs, even by editing the request.` },
    { q: 'What happens to the note I add when completing a visit?', a: `It's saved to that client's Notes tab and tagged to the specific visit it documents — you'll see the visit's due date and program show up next to it automatically. That link is set only by the complete step itself, so it can't be edited onto a different visit later.` },
    { q: 'I completed a visit by mistake — can I undo it?', a: `Admins and leads can reopen a completed visit from the Inventory page, which clears its completed status. The note you logged (if any) stays on the client's record either way.` },
  ]},
  { cat: 'Availability & soft pencil holds', roles: ['admin','lead','sales'], items: [
    { q: 'What is a soft pencil hold?', a: `A tentative reservation of specific weeks on a coach's schedule for a prospect who hasn't signed yet, placed from the Availability page's "Preview calendar." It records the prospect's name, program, who placed it and when — and it blocks those weeks from being double-booked. It never creates a client, contract, or anything Keap sees. Every hold has an expiry date (30 days after its last held week by default): if the deal goes quiet, the nightly job warns admins a week ahead, then auto-releases the weeks so they don't rot on the calendar.` },
    { q: 'The prospect signed in Keap — do I have to reconnect it to the hold by hand?', a: `No. When the new subscription lands in Unassigned Clients, the app automatically checks it against your active holds by name and shows a banner on that row: "Looks like your soft-pencil hold with [coach]." Click "Use this hold" and the assign form opens pre-filled with the hold's program, team, and first reserved week — creating the contract then automatically frees the reserved weeks so you can place the real visits right where they were penciled in.` },
    { q: 'Does a soft pencil hold show up in LID Inventory or get billed?', a: `No. It's calendar-only. Nothing appears in LID Inventory, no revenue is counted, and Keap never hears about it. That only happens once the deal actually signs and becomes a real contract.` },
    { q: 'The deal signed — how do I turn a soft pencil into the real thing?', a: `Two ways. Preferred: wait for the Keap subscription to land in Unassigned Clients and click "Use this hold" on the automatic match banner (see above). Manual: from Availability → Active soft-pencil holds, click "Convert to client" — it frees the held weeks and opens the New Contract form pre-filled with the prospect's name, program, team, and first reserved week. Either way, from that point on it's a completely normal contract — reconciled against Keap exactly like any other client, with no special soft-pencil residue anywhere.` },
    { q: 'What if the deal falls through?', a: `Click "Release" instead of "Convert to client" on Active soft-pencil holds — the weeks go back to fully open, nothing else to clean up.` },
  ]},
  { cat: 'Client notes & Keap', roles: ['admin','lead'], items: [
    { q: 'Can I pull a client\'s historical notes out of Keap?', a: `Yes — open a client's profile and click "Import from Keap…" (only shows up if the client has a linked Keap company ID). It fetches that client's Keap notes, filters out system/sales noise automatically, and shows you the real candidates to review before anything is saved. You pick which ones actually come in; nothing imports without that review step.` },
    { q: 'Will re-running the Keap import create duplicates?', a: `No. Every imported note carries its original Keap note ID, and the app won't insert the same one twice — re-previewing after an import shows those notes as already-imported and excludes them automatically.` },
    { q: 'What does "Sync with Keap" do on the Clients page?', a: `Re-checks every contract that already has a Keap subscription ID against Keap's live record and updates price/status if they've drifted. It never touches a contract that isn't already Keap-linked, and if Keap can't be reached it reports an error for that item and changes nothing — a failed check never gets misread as "cancelled" or "$0."` },
  ]},
  { cat: 'Clients', roles: ['admin','lead','sales'], items: [
    { q: 'I deleted a client by mistake — is it gone for good?', a: `No — deleting a client is a soft delete. It disappears from every normal list immediately, but it's fully recoverable for 30 days from Admin → Recently deleted. After 30 days a nightly job purges it permanently, along with its contracts, visits, and notes.` },
    { q: 'What happens if a new contract or subscription comes in for a client I soft-deleted?', a: `The app auto-restores the client the moment a new contract or Keap subscription matches their name — it never silently attaches new work to a hidden record. You'll see an audit log entry ("client.auto_restore") when this happens.` },
    { q: 'One Keap invoice covers multiple stores I visit separately — how should revenue be tracked?', a: `Pick one client as the "revenue owner" — it carries the real Keap subscription ID and full price. Every other client covered by that same invoice keeps its own visits and coach assignment, but its contract price is set to $0 with a pointer back to the revenue owner, so the $0 reads as "billed elsewhere" rather than "worth nothing." Revenue totals stay accurate with no manual splitting. See the SOP doc for the full Castle example.` },
  ]},
  { cat: 'Coaches & profiles', roles: ['admin','lead','coach'], items: [
    { q: 'What happens to a coach\'s history when they leave?', a: `Nothing about it changes. Every visit a coach completed is permanently credited to them (separately from who's currently scheduled), so their profile keeps showing accurate history and notes forever — deactivating them only affects future scheduling, not the record of past work. Their profile stays fully browsable from Admin → Former coaches.` },
    { q: 'What happens to a departing coach\'s stores?', a: `When you deactivate a coach, you choose: hand all their current stores and upcoming scheduled visits to one teammate in a single step, or leave them unassigned so they surface as open work. The dialog shows every teammate's current workload (stores + upcoming visits) so you can pick who has room — lightest-loaded teammates are listed first.` },
    { q: 'Can I split a departing coach\'s stores across more than one person?', a: `Not in one step yet — the deactivation flow reassigns everything to a single coach. To split the book, deactivate with one recipient, then move individual stores to someone else afterward from each client's profile (Assignment & Keap details → Assigned coach).` },
    { q: 'What\'s on a coach\'s "To-do" list?', a: `Anything currently in their court: overdue stores, anything due in the next two weeks, and any completed visit that's still missing a note. It's computed fresh every time the profile loads, not stored, so it's always current.` },
  ]},
  { cat: 'Accounts & security', roles: ['admin'], items: [
    { q: 'How do coaches log in?', a: `Either with an email/password you set up for them (Admin → Users → Add user, role "coach", linked to their coach profile), or with Google Sign-In if SSO is configured for your Workspace domain — both work side by side. SSO never auto-creates an account; the email has to already exist as a user first.` },
    { q: 'What happens after repeated failed logins?', a: `5 failed attempts on the same email within 15 minutes triggers a 15-minute lockout, even with the correct password — this resets on redeploy and isn't a persistent ban list.` },
    { q: 'Can I change someone\'s login email later?', a: `Yes — Admin → Users → Edit lets you change name, email, role, team, and coach link after the account exists. Changing the email only changes how they log in; it doesn't rewrite anything already recorded under their old address in notes, audit logs, or Keap sync history.` },
  ]},
  { cat: 'Backups & data', roles: ['admin'], items: [
    { q: 'Is the database backed up automatically, and where is it saved?', a: `Yes — every night (~3-4am Eastern) the app emails every admin a gzipped copy of the actual database file, alongside a Keap sync pass and the day's revenue snapshot. There's no separate storage location on the server itself (the hosting disk isn't persistent across deploys), so that emailed file — or the "Download backup now" button on Admin → Backups & nightly maintenance — is the real backup. Save a copy somewhere you control (a shared drive, etc.) if you want a copy that doesn't depend on email. To restore: gunzip it and replace the running server's database file, then restart the app. Admin → Backups shows the timestamp of the last successful backup so you can confirm at a glance it's actually running.` },
    { q: 'Where can I see revenue trending over time, not just today\'s snapshot?', a: `Admin → Revenue history — one row per day captured automatically, so drift toward or away from Keap shows up as a trend rather than a single point-in-time number.` },
    { q: 'Can I export the client/inventory list?', a: `Yes — the LID Inventory page has a CSV export that respects whatever filters you currently have applied.` },
  ]},
];
function faqView(){
  const role = D.user.role;
  const sections = FAQ.filter(s=>s.roles.includes(role));
  let html = `<div class="panel"><h2>FAQ &amp; SOPs</h2>
    <p class="small">How this app's less-obvious features work — click a question to expand it. Sections only show if they're relevant to your role.</p></div>`;
  for(const s of sections){
    html += `<div class="panel"><h2>${esc(s.cat)}</h2>` +
      s.items.map(i=>`<details style="margin-bottom:8px">
        <summary style="cursor:pointer;font-weight:600;padding:6px 0">${esc(i.q)}</summary>
        <div class="small" style="padding:4px 0 8px 4px;white-space:pre-wrap">${esc(i.a)}</div>
      </details>`).join('') + `</div>`;
  }
  return html;
}

/* ---------- admin ---------- */
/* Split into three sub-tabs — the old single page had backups buried under a
   full scroll of roster history, which non-technical admins simply never found. */
const ADMIN_TABS = [['people','Team & Users'],['data','Data & Backups'],['history','History & Audit']];
function setAdminTab(t){ st.adminTab=t; render(); }
function adminView(){
  const tab = st.adminTab || 'people';
  let html = `<div class="controls" style="margin-bottom:14px">` +
    ADMIN_TABS.map(([k,l])=>`<button class="btn ${tab===k?'primary':''}" onclick="setAdminTab('${k}')">${l}</button>`).join('') + `</div>`;
  if(tab==='people') return html + adminPeopleView();
  if(tab==='data') return html + adminDataView();
  return html + adminHistoryView();
}
function adminPeopleView(){
  let html=`<div class="panel"><h2>Teams &amp; coaches</h2>
    <div class="controls"><button class="btn primary" onclick="coachDlg()">＋ Add coach</button>
    <button class="btn" onclick="teamDlg()">＋ Add team</button></div>`;
  for(const t of D.teams){
    const members=D.coaches.filter(c=>c.team===t);
    html+=`<h3 style="display:flex;align-items:center;gap:8px">Team ${esc(t)} (${members.length})
      <button class="btn tiny" onclick="renameTeamDlg('${esc(t).replace(/'/g,"\\'")}')">Rename</button>
      ${members.length?'':`<button class="btn tiny danger" onclick="deleteTeam('${esc(t).replace(/'/g,"\\'")}')">Delete</button>`}
    </h3><table><tr><th>Coach</th><th class="num">Future visits</th><th>Move to</th><th></th></tr>`;
    members.forEach(c=>{
      const fv=D.visits.filter(v=>!v.completed&&v.cal_coach===c.id&&v.cal_week>=TODAY).length;
      html+=`<tr><td><a onclick="openCoachProfile('${c.id}')" style="cursor:pointer;color:var(--ink);text-decoration:none;display:flex;align-items:center;gap:8px">${avatarHtml(c.name,c.team,26)}<b style="text-decoration:underline;color:var(--primary)">${esc(c.name)}</b></a></td><td class="num">${fv}</td>
        <td><select onchange="moveCoach('${c.id}',this.value)"><option></option>${D.teams.filter(x=>x!==t).map(x=>`<option>${x}</option>`).join('')}</select></td>
        <td><button class="btn tiny danger" onclick="removeCoach('${c.id}','${esc(c.name)}')">Deactivate</button></td></tr>`;
    });
    html+=`</table>`;
  }
  // Onboarding: which coaches can actually sign in? One row per active coach, with
  // a one-click SSO account creator for the ones who can't yet.
  html+=`</div><div class="panel"><h2>Coach sign-in accounts</h2>
  <p class="small" style="margin-bottom:8px">Every coach needs a user account with their real work email before Google sign-in works for them.
  Type the email and click Create — no password needed, they'll use the Google button. Their view of the app is automatically scoped to their own visits and stores.</p>
  <table><tr><th>Coach</th><th>Team</th><th>Sign-in account</th><th></th></tr>`;
  for(const c of D.coaches){
    const u = (D.users||[]).find(u=>u.coach_id===c.id && u.active);
    html += `<tr><td style="display:flex;align-items:center;gap:8px">${avatarHtml(c.name,c.team,24)}<b>${esc(c.name)}</b></td><td>${esc(c.team)}</td>` +
      (u ? `<td><span class="pill p-done">✓</span> <span class="mono small">${esc(u.email)}</span></td><td></td>`
         : `<td><input id="obEmail-${esc(c.id)}" placeholder="their @chriscollinsinc.com email" style="width:250px" onkeydown="if(event.key==='Enter')createCoachAccount('${esc(c.id)}')"></td>
            <td><button class="btn tiny primary" onclick="createCoachAccount('${esc(c.id)}')">Create SSO account</button></td>`) + `</tr>`;
  }
  html+=`</table></div>`;
  html+=`<div class="panel"><h2>Former coaches</h2>
  <p class="small" style="margin-bottom:8px">Deactivated coaches — their profile, visit history, and notes stay fully browsable, they're just no longer scheduled for new work.</p>
  <div id="formerCoachesOut" class="small">Loading…</div></div>`;
  html+=`<div class="panel"><h2>Users</h2>
    <div class="controls"><button class="btn primary" onclick="userDlg()">＋ Add user</button></div>
    <table><tr><th>Name</th><th>Email</th><th>Role</th><th>Team</th><th>Coach link</th><th>Status</th><th></th></tr>`;
  (D.users||[]).forEach(u=>{
    html+=`<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.role}</td><td>${esc(u.team||'—')}</td>
      <td class="small">${esc(coach(u.coach_id)?.name||'—')}</td>
      <td>${u.active?'<span class="pill p-done">active</span>':'<span class="pill p-over">disabled</span>'}</td>
      <td><button class="btn tiny" onclick="editUserDlg(${u.id})">Edit</button>
      <button class="btn tiny" onclick="resetPwDlg(${u.id},'${esc(u.name)}')">Reset pw</button>
      ${u.id!==D.user.id?`<button class="btn tiny danger" onclick="toggleUser(${u.id},${u.active?0:1})">${u.active?'Disable':'Enable'}</button>`:''}</td></tr>`;
  });
  html+=`</table></div>`;
  return html;
}
function adminDataView(){
  let html=`<div class="panel"><h2>Recently cancelled via Keap</h2>
  <p class="small" style="margin-bottom:12px">Auto-flagged when Keap reports a subscription cancelled. Future visits are left on the
  board on purpose — clear or reassign them from the Inventory screen once you've confirmed.</p>
  <div id="cancelledOut" class="small">Loading…</div></div>
  <div class="panel"><h2>Backups &amp; nightly maintenance</h2>
  <p class="small" style="margin-bottom:12px">Every night (around 3-4am Eastern) the app checks Keap-linked contracts for drift, snapshots the revenue total, purges any client past its 30-day
  delete window, and emails every admin a full database backup (a gzipped copy of the actual database file) plus a summary — overdue visits, stale Pending Clients items, and whether the backup went out.
  There's no separate storage location — the emailed attachment (or a direct download below) <b>is</b> the backup; save a copy of it somewhere you control if you want a copy outside of email.
  To restore: gunzip the file and replace the running server's database file, then restart the app.</p>
  <p class="small" id="lastBackupOut">Checking last backup time…</p>
  <div class="controls"><button class="btn" id="backupNowBtn" onclick="backupNow()">Email backup now</button>
  <button class="btn" onclick="window.location='/api/admin/backup-download'">Download backup now</button>
  <button class="btn" id="nightlyNowBtn" onclick="runNightlyNow()">Run full nightly check now</button></div>
  <div id="maintenanceOut" class="small"></div></div>
  <div class="panel"><h2>Revenue history</h2>
  <p class="small" style="margin-bottom:12px">One row per day, captured by the nightly job — total active revenue and client count, so drift (toward or away from Keap) shows as a trend.</p>
  <div id="revenueHistoryOut" class="small">Loading…</div></div>
  <div class="panel"><h2>Recently deleted</h2>
  <p class="small" style="margin-bottom:12px">Clients deleted in the last 30 days — restorable here. After 30 days they're purged for good by the nightly job.</p>
  <div id="deletedOut" class="small">Loading…</div></div>
  <div class="panel"><h2>Keap webhook activity</h2>
  <p class="small" style="margin-bottom:12px">Diagnostic tool for "I added something in Keap and it never showed up." <b>Recent events</b> is every raw hit Keap has sent this app, whether it was acted on or not — if a store you added isn't in here at all, Keap never reached this app for it (check the subscription actually exists in Keap, not just a contact). <b>Hook status</b> checks live with Keap whether the <code>subscription.add/edit/delete</code> hooks are registered and Verified against this app's URL right now. <b>Backfill</b> below is the fix for missed webhooks — it checks every subscription in Keap (not just recent ones — Keap's own date filters aren't reliable enough to trust) against what this app already knows, and queues anything untracked, including ones that start in the future.</p>
  <div class="controls"><button class="btn" onclick="loadKeapEvents()">Refresh events</button>
  <button class="btn" onclick="checkKeapHooks()">Check hook status</button>
  <button class="btn primary" id="keapBackfillBtn" onclick="backfillKeapSubscriptions()">Backfill missed subscriptions</button></div>
  <div id="keapHooksOut" class="small"></div>
  <div id="keapBackfillOut" class="small"></div>
  <div id="keapEventsOut" class="small">Loading…</div></div>`;
  return html;
}
function adminHistoryView(){
  let html=`<div class="panel"><h2>Client roster history</h2>
  <p class="small" style="margin-bottom:12px">A frozen snapshot of every client's status is captured automatically at the start of each month,
  so you can look back at who was active in any given month, not just today.</p>
  <div class="controls"><select id="chPeriod" onchange="loadClientHistory(this.value)"></select></div>
  <div id="clientHistoryOut" class="small">Loading…</div></div>
  <div class="panel"><h2>Audit log</h2><div id="auditOut" class="small">Loading…</div></div>`;
  return html;
}
async function loadFormerCoaches(){
  try{
    const rows = await api('GET','/api/coaches/inactive');
    $('#formerCoachesOut').innerHTML = rows.length ?
      `<table><tr><th>Coach</th><th>Team</th></tr>` +
      rows.map(c=>`<tr><td><a onclick="openCoachProfile('${c.id}')" style="cursor:pointer;color:var(--primary);text-decoration:underline">${esc(c.name)}</a></td><td>${esc(c.team)}</td></tr>`).join('') +
      `</table>` : `<p>None.</p>`;
  }catch(e){ $('#formerCoachesOut').innerHTML = '<p>Could not load.</p>'; }
}
async function loadCancelledContracts(){
  try{
    const rows = await api('GET','/api/keap/cancelled-contracts');
    $('#cancelledOut').innerHTML = rows.length ? `<table><tr><th>Client</th><th>Team</th><th>Program</th></tr>` +
      rows.map(r=>`<tr><td>${esc(r.client_name)}</td><td>${esc(r.team||'—')}</td><td>${esc(r.program||'—')}</td></tr>`).join('') + `</table>`
      : `<p>None yet.</p>`;
  }catch(e){ $('#cancelledOut').innerHTML = '<p>Could not load.</p>'; }
}
async function loadClientHistoryPeriods(){
  try{
    const periods = await api('GET','/api/client-history/periods');
    const sel = $('#chPeriod');
    if(!periods.length){ sel.innerHTML = '<option>No history yet</option>'; $('#clientHistoryOut').innerHTML = '<p>The first monthly snapshot hasn\'t run yet — check back after the app has been up for a few minutes.</p>'; return; }
    sel.innerHTML = periods.map(p=>`<option value="${p}">${p}</option>`).join('');
    await loadClientHistory(periods[0]);
  }catch(e){ $('#clientHistoryOut').innerHTML = '<p>Could not load.</p>'; }
}
async function loadClientHistory(period){
  if(!period) return;
  try{
    const rows = await api('GET','/api/client-history/'+period);
    const active = rows.filter(r=>r.status==='active').length;
    const inactive = rows.filter(r=>r.status==='inactive').length;
    const cancelled = rows.filter(r=>r.status==='cancelled').length;
    $('#clientHistoryOut').innerHTML = `<p><b>${active} active</b> · ${inactive} inactive · ${cancelled} cancelled — ${rows.length} total clients on record for ${period}</p>
      <table><tr><th>Client</th><th>Status</th><th class="num">Active contracts</th></tr>` +
      rows.map(r=>`<tr><td>${esc(r.name)}</td><td>${r.status==='active'?'<span class="pill p-done">active</span>':r.status==='cancelled'?'<span class="pill p-over">cancelled</span>':'<span class="pill">inactive</span>'}</td><td class="num">${r.active_contracts}</td></tr>`).join('') +
      `</table>`;
  }catch(e){ $('#clientHistoryOut').innerHTML = '<p>Could not load.</p>'; }
}
function coachDlg(){
  openDlg(`<h3>Add coach</h3><label>Name</label><input id="kName">
    <label>Team</label><select id="kTeam">${teamOpts()}</select>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveCoach()">Add</button></div>`);
}
async function saveCoach(){ const n=$('#kName').value.trim(); if(!n){uiAlert('Name required');return;}
  await api('POST','/api/coaches',{name:n,team:$('#kTeam').value}); closeDlg(); await refresh(); toast(n+' added — their weeks are open capacity'); }
async function moveCoach(id,team){ if(!team) return; await api('PATCH','/api/coaches/'+id,{team}); await refresh(); toast('Moved'); }
function removeCoach(id,name){ coachDeactivateDlg(id,name); }
function renameTeamDlg(from){
  openDlg(`<h3>Rename Team ${esc(from)}</h3>
    <p class="small">The new name replaces "${esc(from)}" everywhere at once — every coach, user, visit, and board reference moves with it. Nothing else changes.</p>
    <label>New team name</label><input id="rtName" value="${esc(from)}">
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="doRenameTeam('${esc(from).replace(/'/g,"\\'")}')">Rename</button></div>`);
}
async function doRenameTeam(from){
  const to = $('#rtName').value.trim();
  if(!to){ uiAlert('Enter the new team name.'); return; }
  if(to === from){ closeDlg(); return; }
  const r = await api('PATCH','/api/teams/rename',{ from, to });
  closeDlg();
  if(st.boardTeam === from) st.boardTeam = to;
  await refresh();
  toast(`Team renamed — ${r.nCoaches} coach(es), ${r.nUsers} user(s), and ${r.nVisits} visit(s) moved to "${to}"`);
}
async function deleteTeam(t){
  if(!(await uiConfirm(`Delete Team ${t}? Only allowed while it's completely empty — the app will refuse if any coaches, users, or open visits still reference it.`,'Delete'))) return;
  await api('DELETE','/api/teams/'+encodeURIComponent(t));
  if(st.boardTeam === t) st.boardTeam = null;
  await refresh();
  toast(`Team ${t} deleted`);
}
function teamDlg(){
  openDlg(`<h3>Add team</h3><label>Team name</label><input id="tName">
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveTeam()">Add</button></div>`);
}
async function saveTeam(){ await api('POST','/api/teams',{name:$('#tName').value}); closeDlg(); await refresh(); }
function userDlg(){
  openDlg(`<h3>Add user</h3>
    <label>Name</label><input id="uName">
    <label>Email</label><input id="uEmail">
    <label>Role</label><select id="uRole"><option>lead</option><option>sales</option><option>coach</option><option>admin</option></select>
    <label>Team (for leads)</label><select id="uTeam"><option value=""></option>${D.teams.map(t=>`<option>${t}</option>`).join('')}</select>
    <label>Coach link (for coach role)</label><select id="uCoach"><option value=""></option>${D.coaches.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
    <label>Temporary password — leave blank for Google sign-in only</label><input id="uPw" placeholder="blank = they sign in with the Google button">
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveUser()">Create</button></div>`);
}
async function saveUser(){
  const pw = $('#uPw').value;
  const r = await api('POST','/api/users',{name:$('#uName').value,email:$('#uEmail').value,role:$('#uRole').value,
    team:$('#uTeam').value||null,coach_id:$('#uCoach').value||null,password:pw||undefined});
  closeDlg(); await refresh();
  toast(r.ssoOnly ? 'Account created — they sign in with the Google button using that email' : 'User created — send them their temporary password');
}
async function createCoachAccount(coachId){
  const c = D.coaches.find(x=>x.id===coachId); if(!c) return;
  const email = ($('#obEmail-'+CSS.escape(coachId))||{value:''}).value.trim();
  if(!email || !/^\S+@\S+\.\S+$/.test(email)){ uiAlert('Enter a valid email address first.'); return; }
  await api('POST','/api/users',{ name: c.name, email, role: 'coach', team: c.team, coach_id: c.id });
  await refresh();
  toast(`${c.name} can now sign in with Google using ${email}`);
}
function resetPwDlg(id,name){
  openDlg(`<h3>Reset password — ${name}</h3><label>New password</label><input id="rPw" value="Welcome!${Math.floor(1000+Math.random()*9000)}">
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="doResetPw(${id})">Reset</button></div>`);
}
async function doResetPw(id){ await api('PATCH','/api/users/'+id,{password:$('#rPw').value}); closeDlg(); toast('Password reset'); }
async function toggleUser(id,active){ await api('PATCH','/api/users/'+id,{active:!!active}); await refresh(); }
async function loadAudit(){
  try{ const rows=await api('GET','/api/audit');
    $('#auditOut').innerHTML=`<table><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr>`+
      rows.map(r=>`<tr><td class="mono small">${r.ts.slice(0,16).replace('T',' ')}</td><td>${esc(r.user)}</td><td>${esc(r.action)}</td><td class="small">${esc(r.detail).slice(0,120)}</td></tr>`).join('')+`</table>`;
  }catch(e){}
}
async function loadKeapEvents(){
  const out = $('#keapEventsOut'); if(!out) return;
  out.innerHTML = 'Loading…';
  try{
    const rows = await api('GET','/api/admin/keap-events');
    out.innerHTML = `<h4 style="margin:12px 0 6px">Recent events (last 100)</h4>` + (rows.length ?
      `<table><tr><th>When</th><th>Event</th><th>Company</th><th>Object ID</th><th>Handled</th><th></th></tr>` +
      rows.map((r,i)=>{
        const reprocessable = ['subscription.add','subscription.edit','subscription.delete'].includes(r.event_key);
        return `<tr><td class="mono small">${esc(r.ts).slice(0,19).replace('T',' ')}</td><td>${esc(r.event_key)}</td>
        <td><b>${esc(r.company_name||'—')}</b></td>
        <td class="mono small">${esc(r.object_id||'—')}</td>
        <td class="small">${esc(r.handled||'—')}</td>
        <td><button class="btn tiny" onclick="toggleKeapRaw(${i})">Raw</button>
        ${reprocessable ? `<button class="btn tiny" onclick="reprocessKeapEvent(${r.id},${i})">Reprocess</button>` : ''}</td></tr>
        <tr id="keapRaw-${i}" style="display:none"><td colspan="6"><pre class="small mono" style="white-space:pre-wrap;background:var(--bg2,#f6f6f6);padding:8px;border-radius:6px">${esc(r.raw)}</pre></td></tr>`;
      }).join('') +
      `</table>` : `<p>Nothing has ever come in from Keap — if you just added a subscription and expect to see it here within a minute or two, click Refresh. If it stays empty, the webhook itself likely isn't registered or verified with Keap right now (use "Check hook status" above).</p>`);
  }catch(e){ out.innerHTML = '<p>Could not load.</p>'; }
}
function toggleKeapRaw(i){ const el=$('#keapRaw-'+i); if(el) el.style.display = el.style.display==='none' ? '' : 'none'; }
async function reprocessKeapEvent(id){
  try{
    await api('POST', `/api/admin/keap-events/${id}/reprocess`, {});
    toast('Reprocessed — check Unassigned Clients or the client record');
    await loadKeapEvents();
  }catch(e){}
}
async function checkKeapHooks(){
  const out = $('#keapHooksOut'); if(!out) return;
  out.innerHTML = 'Checking with Keap…';
  try{
    const r = await api('GET','/api/admin/keap-hooks-status');
    const relevant = ['subscription.add','subscription.edit','subscription.delete'];
    out.innerHTML = `<h4 style="margin:0 0 6px">Hook status (live from Keap)</h4>` + (r.hooks.length ?
      `<table><tr><th>Event</th><th>Hook URL</th><th>Status</th></tr>` +
      r.hooks.filter(h=>relevant.includes(h.eventKey||h.event_key)).map(h=>{
        const status = h.status || h.hookStatus || '—';
        const ok = /verified/i.test(status);
        return `<tr><td>${esc(h.eventKey||h.event_key)}</td><td class="mono small">${esc(h.hookUrl||h.hook_url||'—')}</td>
          <td><span class="pill ${ok?'p-done':'p-over'}">${esc(status)}</span></td></tr>`;
      }).join('') + `</table>` +
      (relevant.every(k=>r.hooks.some(h=>(h.eventKey||h.event_key)===k)) ? '' :
        `<p class="small">Missing one or more of subscription.add/edit/delete entirely — they need to be (re)registered with Keap pointing at this app's URL.</p>`)
      : `<p>Keap reports no hooks registered at all for this account/app. New subscriptions can never reach this app until the hook registration is (re)run.</p>`);
  }catch(e){ out.innerHTML = `<p style="color:var(--danger,#c0392b)">${esc(e.message||String(e))}</p>`; }
}
async function backfillKeapSubscriptions(){
  const out = $('#keapBackfillOut'), btn = $('#keapBackfillBtn'); if(!out) return;
  if(btn){ btn.disabled = true; btn.textContent = 'Checking every subscription in Keap…'; }
  out.innerHTML = '';
  try{
    const r = await api('POST','/api/admin/keap-backfill-subscriptions',{});
    const rows = r.queued || [];
    out.innerHTML = `<p class="small">Checked ${r.checked} subscription(s) in Keap — ${rows.length} newly queued, ${r.alreadyTracked} already tracked, ${r.notCoachingProduct} not a Signature Coaching subscription, ${r.cancelled} cancelled/inactive${r.errors.length?`, ${r.errors.length} error(s)`:''}.${r.hitPageCap?' (hit the page cap — there may be more; run it again to keep going.)':''}</p>` +
      (rows.length ? `<table><tr><th>Company</th><th>Contact</th><th>Starts</th><th>Active</th></tr>` +
        rows.map(q=>{
          const future = q.startDate && q.startDate > TODAY;
          return `<tr><td><b>${esc(q.companyName||'(unknown — check Unassigned Clients)')}</b></td><td class="small">${esc(q.contactName||'—')}</td>
          <td class="small">${esc(q.startDate||'—')}${future?' <span class="pill p-fut">upcoming</span>':''}</td>
          <td>${q.active?'active':'not yet active'}</td></tr>`;
        }).join('') + `</table><p class="small">These are now sitting in Unassigned Clients, ready to Assign or Ignore.</p>` : '') +
      (r.errors.length ? `<p class="small" style="color:var(--danger,#c0392b)">${r.errors.map(esc).join('<br>')}</p>` : '');
    if(rows.length) toast(`${rows.length} subscription(s) queued to Unassigned Clients`);
  }catch(e){ out.innerHTML = `<p style="color:var(--danger,#c0392b)">${esc(e.message||String(e))}</p>`; }
  finally{ if(btn){ btn.disabled = false; btn.textContent = 'Backfill missed subscriptions'; } }
}
async function loadBackupStatus(){
  try{
    const r = await api('GET','/api/admin/backup-status');
    $('#lastBackupOut').innerHTML = r.lastBackupAt
      ? `Last successful backup: <b>${r.lastBackupAt.slice(0,16).replace('T',' ')} UTC</b>`
      : `<span style="color:var(--bad)">No successful backup on record yet.</span>`;
  }catch(e){ $('#lastBackupOut').textContent = 'Could not check last backup time.'; }
}
async function backupNow(){
  const btn=$('#backupNowBtn'); if(btn){btn.disabled=true;btn.textContent='Sending…';}
  try{
    const r = await api('POST','/api/admin/backup-now',{});
    $('#maintenanceOut').innerHTML = r.ok
      ? `<p>Backup sent (${Math.round((r.sizeBytes||0)/1024)} KB) to: ${esc((r.results||[]).filter(x=>x.ok).map(x=>x.to).join(', ')||'—')}</p>`
      : `<p>Backup failed: ${esc(r.error||(r.results||[]).map(x=>x.error).filter(Boolean).join('; ')||'unknown error')}</p>`;
    await loadBackupStatus();
  }catch(e){ $('#maintenanceOut').innerHTML = `<p>Backup failed: ${esc(e.message||e)}</p>`; }
  finally{ if(btn){btn.disabled=false;btn.textContent='Email backup now';} }
}
async function runNightlyNow(){
  const btn=$('#nightlyNowBtn'); if(btn){btn.disabled=true;btn.textContent='Running…';}
  try{
    const r = await api('POST','/api/admin/run-nightly-now',{});
    const lines=[
      r.sync.error?`Keap sync: FAILED — ${esc(r.sync.error)}`:`Keap sync: checked ${r.sync.checked}, priced ${r.sync.priceChanged}, status changed ${r.sync.statusChanged}, errors ${(r.sync.errors||[]).length}`,
      r.revenue.error?`Revenue snapshot: FAILED — ${esc(r.revenue.error)}`:`Revenue snapshot: ${fmtMoney(r.revenue.totalRevenue)} across ${r.revenue.activeClients} active client(s)`,
      r.purge.error?`Purge: FAILED — ${esc(r.purge.error)}`:`Purge: ${r.purge.purged} client(s) purged`,
      r.backup.ok?`Backup: sent (${Math.round((r.backup.sizeBytes||0)/1024)} KB)`:`Backup: FAILED`,
      `Digest emailed to ${r.digestSentTo||0} of ${r.digestAttempted||0} admin(s).`,
    ];
    $('#maintenanceOut').innerHTML = `<ul style="margin:0;padding-left:18px">${lines.map(l=>`<li>${l}</li>`).join('')}</ul>`;
    await loadRevenueHistory(); await loadDeletedClients(); await loadBackupStatus();
  }catch(e){ $('#maintenanceOut').innerHTML = `<p>Run failed: ${esc(e.message||e)}</p>`; }
  finally{ if(btn){btn.disabled=false;btn.textContent='Run full nightly check now';} }
}
async function loadRevenueHistory(){
  try{
    const rows = await api('GET','/api/revenue-history');
    if(!rows.length){ $('#revenueHistoryOut').innerHTML = '<p>No snapshots yet — the first one is captured by tonight\'s run, or click "Run full nightly check now" above.</p>'; return; }
    $('#revenueHistoryOut').innerHTML = `<table><tr><th>Date</th><th class="num">Revenue</th><th class="num">Active clients</th><th class="num">Keap-linked contracts</th></tr>` +
      rows.slice(0,30).map(r=>`<tr><td class="mono">${esc(r.date)}</td><td class="num">${fmtMoney(r.total_revenue)}</td><td class="num">${r.active_clients}</td><td class="num">${r.keap_linked_contracts}</td></tr>`).join('') +
      `</table>`;
  }catch(e){ $('#revenueHistoryOut').innerHTML = '<p>Could not load.</p>'; }
}
async function loadDeletedClients(){
  try{
    const rows = await api('GET','/api/clients/deleted');
    $('#deletedOut').innerHTML = rows.length ? `<table><tr><th>Client</th><th>Deleted</th><th></th></tr>` +
      rows.map(r=>`<tr><td>${esc(r.name)}</td><td class="mono small">${r.deleted_at.slice(0,16).replace('T',' ')}</td>
        <td><button class="btn tiny" onclick="restoreClient(${r.id},'${esc(r.name).replace(/'/g,"\\'")}')">Restore</button></td></tr>`).join('') + `</table>`
      : `<p>Nothing in the recovery window right now.</p>`;
  }catch(e){ $('#deletedOut').innerHTML = '<p>Could not load.</p>'; }
}
async function restoreClient(id, name){
  await api('POST','/api/clients/'+id+'/restore',{});
  toast(name+' restored'); await loadDeletedClients();
}

/* ---------- boot ---------- */
refresh().catch(()=>{ D=null; render(); });
