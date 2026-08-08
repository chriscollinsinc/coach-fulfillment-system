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
const BLOCKKINDS = {home:'Home',off:'Off / Vacation',training:'Training',bootcamp:'Bootcamp',event:'Event (Top Dog / Virtual)',truck:'TRUCK',travel:'Travel',mag:'Mills (M.A.G.)',launch_open:'Launch slot held',not_hired:'Not hired yet',shadow:'Shadow',meeting:'Meeting',blocked:'Blocked',visit:'Legacy visit (from sheet)',visit_legacy:'Legacy visit (from sheet)'};

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
  invFilter:'active', invSearch:'',
  due2027:false,
};
let occ = null; // occupancy map coach|week -> {type:'visit'|'block', ...}

async function api(method, url, body){
  const r = await fetch(url,{method, headers:{'Content-Type':'application/json'}, body:body?JSON.stringify(body):undefined});
  const j = await r.json().catch(()=>({}));
  if(r.status===401){ D=null; render(); throw new Error('signed out'); }
  if(!r.ok){ toast(j.error||'Error'); throw new Error(j.error||'error'); }
  return j;
}
async function refresh(){
  D = await api('GET','/api/state');
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

/* ---------- shell ---------- */
function render(){
  const app=$('#app');
  if(!D){
    const resetToken = new URLSearchParams(location.search).get('reset');
    app.innerHTML = resetToken ? resetView(resetToken) : loginView();
    return;
  }
  const views = {};
  const r = D.user.role;
  if(r!=='coach'){ views.dashboard='Dashboard'; }
  if(r==='admin'||r==='lead'){
    views.board='Schedule Board'; views.inventory='LID Inventory';
    const n=D.pendingClientCount||0;
    views.pending = 'Unassigned Clients' + (n?` (${n})`:'');
  }
  views.clients='Clients';
  views.availability='Availability';
  if(r==='coach'||D.user.coach_id) views.mysched='My Schedule';
  if(r==='admin') views.admin='Admin';
  if(!views[st.view] && st.view!=='clientprofile') st.view = Object.keys(views)[0];
  app.innerHTML = `
  <header>
    <img class="logo" src="https://chriscollinsinc.com/wp-content/uploads/2020/03/logo-1.png" onerror="this.style.display='none'" alt="">
    <h1>Coach Fulfillment</h1>
    <nav>${Object.entries(views).map(([k,v])=>`<button class="${(st.view===k||(k==='clients'&&st.view==='clientprofile'))?'active':''}" onclick="go('${k}')">${v}</button>`).join('')}</nav>
    <div class="userchip">${esc(D.user.name)} · ${D.user.role}${D.user.team?' · '+D.user.team:''}<br>
      <a onclick="pwDlg()">password</a> · <a onclick="logout()">sign out</a></div>
  </header>
  <main id="main"></main>`;
  const m=$('#main');
  if(st.view==='dashboard') m.innerHTML=dashboard();
  if(st.view==='board') m.innerHTML=board();
  if(st.view==='inventory') m.innerHTML=inventory();
  if(st.view==='pending'){ m.innerHTML=pendingView(); loadPending(); }
  if(st.view==='clients'){ m.innerHTML=clientsView(); loadClients(); }
  if(st.view==='clientprofile'){ m.innerHTML='<div class="panel">Loading…</div>'; loadClientProfile(st.clientId); }
  if(st.view==='availability'){ m.innerHTML=availabilityView(); runAvail(); }
  if(st.view==='mysched') m.innerHTML=mySchedule();
  if(st.view==='admin'){ m.innerHTML=adminView(); loadAudit(); loadCancelledContracts(); loadClientHistoryPeriods(); }
}
function go(v){ st.view=v; st.placing=null; st.detail=null; render(); }
async function logout(){ await api('POST','/api/logout'); D=null; render(); }
function pwDlg(){
  openDlg(`<h3>Change password</h3>
    <label>New password</label><input type="password" id="pw1">
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="savePw()">Save</button></div>`);
}
async function savePw(){ const p=$('#pw1').value; if(p.length<8){alert('Use at least 8 characters');return;}
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
    ${ssoEnabled ? `<a class="btn" style="display:block;text-align:center;margin-bottom:14px" href="/auth/google">Sign in with Google</a>
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
function dashboard(){
  const act=D.visits.filter(v=>!v.completed);
  const n=k=>act.filter(v=>status(v)===k).length;
  const done=D.visits.filter(v=>v.completed).length;
  let html=`<div class="cards">
    <div class="card"><div class="k">${done}</div><div class="l">Visits completed</div></div>
    <div class="card ${n('overdue')?'bad':'ok'}"><div class="k">${n('overdue')}</div><div class="l">Overdue</div></div>
    <div class="card ${n('needs_scheduling')?'warn':'ok'}"><div class="k">${n('needs_scheduling')}</div><div class="l">Needs scheduling</div></div>
    <div class="card"><div class="k">${n('on_calendar')}</div><div class="l">On calendar</div></div>
  </div>`;
  if((D.pendingClientCount||0) > 0 && ['admin','lead'].includes(D.user.role)){
    html += `<div class="panel" style="border-left:4px solid var(--primary)">
      <b>${D.pendingClientCount} new Keap subscription${D.pendingClientCount>1?'s':''}</b> waiting for a team assignment.
      <button class="btn tiny primary" onclick="go('pending')">Review →</button></div>`;
  }
  html+=`<div class="panel"><h2>Capacity vs. LIDs due — next 12 months</h2>`;
  for(const t of myTeams()){
    html+=`<h3>Team ${t}</h3><table><tr><th>Month</th><th class="num">Booked</th><th class="num">Open</th><th class="num">LIDs due</th><th>Load</th><th></th></tr>`;
    for(const [y,m] of rolling12()){
      const c=capacity(t,y,m);
      const due=D.visits.filter(v=>!v.completed&&v.team===t&&v.due&&+v.due.slice(0,4)===y&&+v.due.slice(5,7)===m+1).length;
      const cap=c.booked+c.open, pct=cap?Math.round(c.booked/cap*100):0;
      const verdict=due>cap?`<span class="pill p-over">${due-cap} over</span>`
        : c.open>0?`<span class="pill p-done">${c.open} open</span>`:`<span class="pill p-due">full</span>`;
      html+=`<tr><td>${MO[m]} ${String(y).slice(2)}</td><td class="num">${c.booked}</td><td class="num">${c.open}</td><td class="num">${due}</td>
        <td><div class="bar"><div style="width:${pct}%;background:var(--primary)"></div><div style="width:${100-pct}%;background:var(--open)"></div></div></td>
        <td>${verdict} <button class="btn tiny" onclick="st.view='board';st.boardTeam='${t}';st.boardY=${y};st.boardM=${m};render()">Open →</button></td></tr>`;
    }
    html+=`</table>`;
  }
  html+=`<p class="small" style="margin-top:8px">Weeks with nothing scheduled or blocked count as open. Months beyond the imported 2026 plan will read fully open until leads fill them in.</p></div>`;
  return html;
}

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
        inner=`<b>${esc(v.client)}</b><small>${esc(v.cycle)} ${esc(v.program)}${v.completed?' · done':''}</small>`;
        if(canEdit()) click=` onclick="st.detail=${v.id};st.placing=null;render()"`;
      } else {
        const kindCls = o.kind==='mag'?'s-mag' : (o.kind==='visit'||o.kind==='visit_legacy')?'s-legacy' : o.kind==='launch_open'?'s-launch_open':'s-block';
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
  <p class="small">Click a visit to manage it · click an open or blocked week to set Home/Off/Training/etc.</p>
  </div>`;

  /* side rail */
  html+=`<div class="sidebox">`;
  if(st.detail){
    const v=D.visits.find(x=>x.id===st.detail);
    if(v) html+=`<div class="detailbox"><b>${esc(v.client)}</b>
      ${esc(v.cycle)} ${esc(v.program)} · due ${fmt(v.due)}<br>
      <span class="small">wk of ${fmtW(v.cal_week)} — ${esc(coach(v.cal_coach)?.name||'')}</span>
      <div class="btnrow">
        <button class="btn tiny primary" onclick="completeV(${v.id})">Complete</button>
        <button class="btn tiny" onclick="st.placing=${v.id};st.detail=null;render()">Move</button>
        <button class="btn tiny" onclick="unscheduleV(${v.id})">Unschedule</button>
        <button class="btn tiny" onclick="st.detail=null;render()">Close</button>
      </div></div>`;
  }
  const section=(title,list)=>{
    if(!list.length) return '';
    let h=`<h2>${title} (${list.length})</h2>`;
    list.slice(0,40).forEach(v=>{
      h+=`<div class="duecard ${v.due&&v.due<TODAY?'over':''}"><b>${esc(v.client)}</b>
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
async function completeV(id){
  await api('POST',`/api/visits/${id}/complete`); st.detail=null; await refresh();
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
const INV_COLS = [
  { key:'client', label:'Client', get:v=>v.client||'' },
  { key:'team', label:'Team', get:v=>v.team||'' },
  { key:'program', label:'Program', get:v=>v.program||'' },
  { key:'cycle', label:'Cycle', get:v=>v.cycle||'' },
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
function inventory(){
  if(!st.invSort) st.invSort = { key:'due', dir:'asc' };
  const f=st.invFilter,q=norm(st.invSearch);
  let rows=D.visits.slice();
  const stf={active:v=>!v.completed,overdue:v=>status(v)==='overdue',needs:v=>status(v)==='needs_scheduling',
    oncal:v=>status(v)==='on_calendar',completed:v=>!!v.completed,all:()=>true};
  rows=rows.filter(stf[f]||stf.all);
  if(D.user.role==='lead') rows=rows.filter(v=>!v.team||v.team===D.user.team);
  if(q) rows=rows.filter(v=>norm(v.client).includes(q)||norm(v.coach_hist).includes(q));
  const { key, dir } = st.invSort;
  const col = INV_COLS.find(c=>c.key===key) || INV_COLS[4];
  rows.sort((a,b)=>{
    const av=(col.get(a)||'').toString().toLowerCase(), bv=(col.get(b)||'').toString().toLowerCase();
    if(av===bv) return (a.due||'9').localeCompare(b.due||'9');
    return dir==='asc'?av.localeCompare(bv):bv.localeCompare(av);
  });
  const count=fn=>D.visits.filter(fn).length;
  const arrow = k => st.invSort.key===k ? (st.invSort.dir==='asc'?' ▲':' ▼') : '';
  const th = c => `<th style="cursor:pointer;user-select:none" onclick="sortInventory('${c.key}')">${c.label}<span class="small">${arrow(c.key)}</span></th>`;
  let html=`<div class="controls">
    <button class="btn primary" onclick="contractDlg()">＋ New contract</button>
    <button class="btn" onclick="visitDlg(0)">＋ Single visit</button>
    <select onchange="st.invFilter=this.value;render()">
      <option value="active" ${f==='active'?'selected':''}>Active — ${count(v=>!v.completed)}</option>
      <option value="overdue" ${f==='overdue'?'selected':''}>Overdue — ${count(v=>status(v)==='overdue')}</option>
      <option value="needs" ${f==='needs'?'selected':''}>Needs scheduling — ${count(v=>status(v)==='needs_scheduling')}</option>
      <option value="oncal" ${f==='oncal'?'selected':''}>On calendar — ${count(v=>status(v)==='on_calendar')}</option>
      <option value="completed" ${f==='completed'?'selected':''}>Completed — ${count(v=>!!v.completed)}</option>
      <option value="all" ${f==='all'?'selected':''}>Everything — ${D.visits.length}</option></select>
    <input placeholder="Search client or coach…" value="${esc(st.invSearch)}" oninput="st.invSearch=this.value;render()" style="width:230px">
    <span class="small">${rows.length} rows</span></div>
  <div class="panel" style="overflow-x:auto"><table><tr>${INV_COLS.map(th).join('')}<th style="width:245px"></th></tr>`;
  rows.slice(0,400).forEach(v=>{
    const s=status(v);
    const sched=v.completed?(v.sched_hist||(v.cal_week?'wk of '+fmtW(v.cal_week):'—'))
      : v.cal_week?`wk of ${fmtW(v.cal_week)} — ${esc(coach(v.cal_coach)?.name||'')}`:'—';
    const pill=v.completed?'<span class="pill p-done">Completed</span>'
      :s==='overdue'?'<span class="pill p-over">Overdue</span>'
      :s==='on_calendar'?'<span class="pill p-cal">On calendar</span>'
      :s==='needs_scheduling'?'<span class="pill p-due">Needs scheduling</span>':'<span class="pill p-fut">—</span>';
    let act='';
    if(canEdit()){
      act=`<button class="btn tiny" onclick="visitDlg(${v.id})">Edit</button>`;
      if(!v.completed&&!v.cal_week&&v.team) act+=`<button class="btn tiny" onclick="st.view='board';st.boardTeam='${esc(v.team)}';${v.due?`st.boardY=${+v.due.slice(0,4)};st.boardM=${+v.due.slice(5,7)-1};`:''}st.placing=${v.id};render()">Place</button>`;
      if(!v.completed) act+=`<button class="btn tiny" onclick="completeV(${v.id})">Complete</button>`;
      act+=`<button class="btn tiny danger" onclick="delVisit(${v.id})">✕</button>`;
    }
    html+=`<tr><td>${esc(v.client)}</td><td>${esc(v.team||'?')}</td><td>${esc(v.program)}</td><td class="mono">${esc(v.cycle)}</td>
      <td class="mono">${fmt(v.due)}</td><td class="small">${sched}</td><td>${pill}</td><td class="actions-nowrap">${act}</td></tr>`;
  });
  if(rows.length>400) html+=`<tr><td colspan="8" class="small">…first 400 of ${rows.length}</td></tr>`;
  html+=`</table></div>`;
  return html;
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
  if(!client){alert('Client name required');return;}
  const program = $('#cProg').value;
  if(program==='Coaching Only'){
    const coachId = $('#cCoach').value;
    if(!coachId){ alert('Pick a coach'); return; }
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
  if(!b.client){alert('Client name required');return;}
  if(id) await api('PATCH','/api/visits/'+id,b); else await api('POST','/api/visits',b);
  closeDlg(); await refresh(); toast('Saved');
}
async function delVisit(id){
  const v=D.visits.find(x=>x.id===id);
  if(!confirm(`Delete ${v.client} — ${v.cycle} ${v.program}?`)) return;
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
  <div class="panel"><h2>Open capacity by month</h2><div id="capOut"></div></div>`;
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
  let html='';
  if(!results.length){
    html=`<p style="color:var(--bad);font-weight:600">No coach can absorb a full ${prog} cadence before ${fmt(horizon)}${team!=='Any'?` on Team ${team}`:''}.</p>`;
  }else{
    html=`<p style="margin:8px 0"><b style="color:var(--ok)">Yes — ${results.length} coach${results.length>1?'es':''} can take a new ${prog} client.</b>
    Earliest start: <b>week of ${fmt(results[0].plan.start)}</b> with ${esc(results[0].coach.name)} (Team ${results[0].coach.team}).</p>
    <table><tr><th>Coach</th><th>Team</th><th>Earliest start</th><th>Projected visit weeks</th><th class="num">Spare open weeks</th></tr>`;
    results.slice(0,12).forEach(r=>{
      html+=`<tr><td><b>${esc(r.coach.name)}</b></td><td>${r.coach.team}</td><td class="mono">${fmt(r.plan.start)}</td>
      <td>${r.plan.seq.map(w=>`<span class="result-week">${fmtW(w)}</span>`).join('')}</td><td class="num">${r.spare}</td></tr>`;
    });
    html+=`</table>`;
  }
  html+=`<p class="small" style="margin-top:8px">Planning horizon: through ${fmt(horizon)}. ${st.due2027?'Months past the current plan read as fully open — treat those as estimates.':'Check the box above to look into 2027 (not yet planned).'}</p>`;
  $('#aOut').innerHTML=html;
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
  return `<div class="panel"><h2>Unassigned clients</h2>
  <p class="small" style="margin-bottom:12px">New subscriptions from Keap land here first. Confirm the client name, program cadence,
  and team, then create the contract — same as adding a contract today, just pre-filled from Keap.</p>
  <div id="pendingOut">Loading…</div></div>`;
}
async function loadPending(){
  try{
    const rows = await api('GET','/api/pending-clients');
    st.pendingList = rows;
    $('#pendingOut').innerHTML = rows.length ? `<table><tr><th>Company</th><th>Contact</th><th class="num">Amount</th><th>Billing</th><th>Started</th><th></th></tr>` +
      rows.map(r=>`<tr><td><b>${esc(r.company_name||'(unknown)')}</b></td><td class="small">${esc(r.contact_name||'—')}</td>
        <td class="num">${r.billing_amount?'$'+r.billing_amount:'—'}</td><td class="small">${esc(r.billing_cycle||'—')} ×${r.billing_frequency||1}</td>
        <td class="small">${esc(r.start_date||'—')}</td>
        <td><button class="btn tiny primary" onclick="assignPendingDlg(${r.id})">Assign</button>
        <button class="btn tiny" onclick="ignorePending(${r.id})">Ignore</button></td></tr>`).join('') + `</table>`
      : `<p class="small">Nothing waiting — you're all caught up.</p>`;
  }catch(e){ $('#pendingOut').innerHTML = `<p class="small">Could not load.</p>`; }
}
function coachOptsFor(team){
  const list = D.coaches.filter(c=>!team||c.team===team);
  return `<option value="">— select —</option>` + list.map(c=>`<option value="${c.id}" data-team="${c.team}">${esc(c.name)} (${c.team})</option>`).join('');
}
function assignPendingDlg(id){
  const r = (st.pendingList||[]).find(x=>x.id===id); if(!r) return;
  const guessed = guessProgram(r.billing_cycle, r.billing_frequency);
  openDlg(`<h3>Assign — ${esc(r.company_name||'(unknown)')}</h3>
    <label>Client name</label><input id="pClient" value="${esc(r.company_name||r.contact_name||'')}">
    <label>Program</label><select id="pProg" onchange="onPendingProgramChange()">${PROGRAMS.map(p=>`<option ${p===guessed?'selected':''}>${p}</option>`).join('')}</select>
    <div id="pVisitFields">
      <label>Number of visits</label><input id="pN" type="number" value="${CYCLE_LEN[guessed]||4}">
      <label>First visit due</label><input id="pFirst" type="date" value="${r.start_date||TODAY}">
      <label>Team</label><select id="pTeam">${teamOpts()}</select>
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
async function saveAssignPending(id){
  const client=$('#pClient').value.trim(); if(!client){alert('Client name required');return;}
  const program=$('#pProg').value;
  if(program==='Coaching Only'){
    const coachId = $('#pCoach').value;
    if(!coachId){ alert('Pick a coach'); return; }
    const coach = D.coaches.find(c=>c.id===coachId);
    await api('POST',`/api/pending-clients/${id}/assign`,{client, program, n:0, first:null, team:coach.team, coachId});
    closeDlg(); await refresh(); toast(client+' added — Coaching Only, assigned to '+coach.name);
    return;
  }
  const n=+$('#pN').value, first=$('#pFirst').value, team=$('#pTeam').value;
  if(!first||!(n>0)||!team){alert('Program visit count, first due date and team are required');return;}
  await api('POST',`/api/pending-clients/${id}/assign`,{client,program,n,first,team});
  closeDlg(); await refresh(); toast(client+' added — contract created');
}
async function ignorePending(id){
  if(!confirm("Ignore this subscription? It won't be added to the LID Inventory.")) return;
  await api('POST',`/api/pending-clients/${id}/ignore`,{}); await refresh(); toast('Ignored');
}

/* ---------- clients (profiles) ---------- */
const CLIENT_COLS = [
  { key:'name', label:'Client', type:'string' },
  { key:'status', label:'Status', type:'string' },
  { key:'programs', label:'Product type', type:'string' },
  { key:'revenue', label:'Revenue', type:'num' },
  { key:'active_contracts', label:'Active contracts', type:'num' },
  { key:'assigned_coach_name', label:'Assigned coach', type:'string' },
];
function clientsView(){
  if(!st.cliSort) st.cliSort = { key:'name', dir:'asc' };
  return `<div class="panel"><h2>Clients</h2>
  <p class="small" style="margin-bottom:12px">Every dealership we've coached — with who's assigned, Keap-imported details, and a running notes history. Click a column header to sort.</p>
  <div class="controls"><input placeholder="Search client…" id="cliSearch" value="${esc(st.cliSearch||'')}" oninput="st.cliSearch=this.value;renderClientTable()" style="width:260px">
    ${D.user.role==='admin' ? `<button class="btn tiny" id="keapSyncBtn" onclick="syncWithKeap()">Sync with Keap</button>` : ''}
  </div>
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
    alert(lines);
    await loadClients();
  }catch(e){
    alert('Sync failed: ' + (e.message||e));
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
function renderClientTable(){
  const box = $('#clientsOut'); if(!box) return;
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
  box.innerHTML = `<table><tr>${CLIENT_COLS.map(th).join('')}<th></th></tr>` +
    rows.map(c=>`<tr><td><b>${esc(c.name)}</b></td>
      <td>${c.status==='active'?'<span class="pill p-done">active</span>':c.status==='cancelled'?'<span class="pill p-over">cancelled</span>':'<span class="pill">inactive</span>'}</td>
      <td>${esc(c.programs||'—')}</td>
      <td class="num">${fmtMoney(c.revenue)}</td>
      <td class="num">${c.active_contracts}</td><td>${esc(c.assigned_coach_name||'—')}</td>
      <td><button class="btn tiny" onclick="openClientProfile(${c.id})">View profile →</button></td></tr>`).join('') +
    `<tr style="font-weight:600;border-top:2px solid var(--border,#ccc)">
      <td colspan="3">Total — ${rows.length} client${rows.length===1?'':'s'}</td>
      <td class="num">${fmtMoney(totalRevenue)}</td><td></td><td></td><td></td></tr>` +
    `</table>` + (rows.length ? '' : `<p class="small">No clients match.</p>`);
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
function clientProfileView(data, notes){
  const { client, assignedCoach, contracts, visits, visitProgress } = data;
  const pct = visitProgress.total ? Math.round(visitProgress.completed/visitProgress.total*100) : 0;
  const activeContract = contracts.find(c=>c.status==='active');
  let html = `<div class="panel">
    <div class="controls">
      <button class="btn tiny" onclick="go('clients')">← All clients</button>
      <span style="flex:1"></span>
      ${D.user.role==='admin' ? `<button class="btn tiny danger" onclick="deleteClientDlg(${client.id},'${esc(client.name).replace(/'/g,"\\'")}')">Delete client</button>` : ''}
    </div>
    <h2 style="margin-top:8px">${esc(client.name)}
      ${client.status==='active'?'<span class="pill p-done">active</span>':client.status==='cancelled'?'<span class="pill p-over">cancelled</span>':'<span class="pill">inactive</span>'}
    </h2>
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
    visits.slice().reverse().map(v=>`<tr><td class="mono">${fmt(v.due)}</td><td>${esc(v.program)}</td><td class="mono">${esc(v.cycle)}</td>
      <td>${v.completed?'<span class="pill p-done">completed</span>':v.cal_week?'<span class="pill p-cal">on calendar</span>':'<span class="pill p-due">needs scheduling</span>'}</td></tr>`).join('') +
    `</table>${visits.length?'':'<p class="small">No visits recorded yet.</p>'}</div>`;

  html += `<div class="panel"><h2>Notes</h2>
    <p class="small" style="margin-bottom:10px">Any coach, lead, or admin can add a note here — this is meant to replace jotting notes in Keap going forward. Only admins can edit or delete a note.</p>
    <div class="controls" style="margin-bottom:6px">
      <label style="margin:0">Date</label><input type="date" id="cliNoteDate" value="${TODAY}" style="width:150px">
      <label style="margin:0">Type</label><select id="cliNoteType"><option>Coaching Call</option><option>LID</option></select>
    </div>
    <textarea id="cliNoteBody" rows="3" style="width:100%;box-sizing:border-box" placeholder="Add a note about this client…"></textarea>
    <div class="dlgrow" style="margin-top:6px"><button class="btn primary" onclick="saveClientNote(${client.id})">Add note</button></div>
    <div style="margin-top:14px">${notes.length ? notes.map(n=>clientNoteCard(client.id, n)).join('') : '<p class="small">No notes yet.</p>'}</div>
  </div>`;

  html += `<div class="panel"><h2>Coming soon</h2>
    <p class="small">Zoom coaching call recordings/transcripts — coming soon once Zoom API access is set up.</p>
    <p class="small">Top Dog Underground daily tracking data — coming soon once that integration is available.</p>
  </div>`;
  return html;
}
async function saveAssignedCoach(clientId, coachId){
  await api('PATCH','/api/clients/'+clientId, { assigned_coach_id: coachId || null });
  toast('Coach assignment saved');
  await loadClientProfile(clientId);
}
function deleteClientDlg(clientId, clientName){
  openDlg(`<h3>Delete ${esc(clientName)}?</h3>
    <p class="small">This permanently deletes the client, its contracts, visits, and notes. This cannot be undone.</p>
    <label>Type the client name to confirm</label><input id="delConfirm" placeholder="${esc(clientName)}">
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary danger" onclick="doDeleteClient(${clientId},'${esc(clientName).replace(/'/g,"\\'")}')">Delete permanently</button></div>`);
}
async function doDeleteClient(clientId, clientName){
  if($('#delConfirm').value.trim() !== clientName){ alert('Name does not match — nothing was deleted.'); return; }
  await api('DELETE','/api/clients/'+clientId);
  closeDlg(); toast(clientName+' deleted');
  go('clients');
}
function clientNoteCard(clientId, n){
  const title = `${fmt(n.note_date)} — ${esc(n.note_type)}`;
  const isAdmin = D.user.role === 'admin';
  const editedTag = n.edited ? ` <span class="small">(edited ${n.edited.slice(0,16).replace('T',' ')})</span>` : '';
  return `<div class="duecard" id="note-${n.id}">
    <div class="meta"><b>${title}</b> · ${esc(n.author_name||n.author_email)} · logged ${n.created.slice(0,16).replace('T',' ')}${editedTag}</div>
    <div style="margin-top:4px;white-space:pre-wrap" id="note-body-${n.id}">${esc(n.body)}</div>
    ${isAdmin ? `<div class="dlgrow" style="margin-top:6px">
      <button class="btn tiny" onclick="editNoteDlg(${clientId},${n.id})">Edit</button>
      <button class="btn tiny danger" onclick="deleteClientNote(${clientId},${n.id})">Delete</button>
    </div>` : ''}
  </div>`;
}
async function saveClientNote(clientId){
  const body = $('#cliNoteBody').value.trim();
  if(!body){ alert('Note cannot be empty'); return; }
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
  if(!body){ alert('Note cannot be empty'); return; }
  await api('PATCH',`/api/clients/${clientId}/notes/${noteId}`, { body, note_date: $('#enDate').value, note_type: $('#enType').value });
  closeDlg(); toast('Note updated');
  await loadClientProfile(clientId);
}
async function deleteClientNote(clientId, noteId){
  if(!confirm('Delete this note? This cannot be undone.')) return;
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

/* ---------- admin ---------- */
function adminView(){
  let html=`<div class="panel"><h2>Teams &amp; coaches</h2>
    <div class="controls"><button class="btn primary" onclick="coachDlg()">＋ Add coach</button>
    <button class="btn" onclick="teamDlg()">＋ Add team</button></div>`;
  for(const t of D.teams){
    const members=D.coaches.filter(c=>c.team===t);
    html+=`<h3>Team ${t} (${members.length})</h3><table><tr><th>Coach</th><th class="num">Future visits</th><th>Move to</th><th></th></tr>`;
    members.forEach(c=>{
      const fv=D.visits.filter(v=>!v.completed&&v.cal_coach===c.id&&v.cal_week>=TODAY).length;
      html+=`<tr><td><b>${esc(c.name)}</b></td><td class="num">${fv}</td>
        <td><select onchange="moveCoach('${c.id}',this.value)"><option></option>${D.teams.filter(x=>x!==t).map(x=>`<option>${x}</option>`).join('')}</select></td>
        <td><button class="btn tiny danger" onclick="removeCoach('${c.id}','${esc(c.name)}')">Remove</button></td></tr>`;
    });
    html+=`</table>`;
  }
  html+=`</div><div class="panel"><h2>Users</h2>
    <div class="controls"><button class="btn primary" onclick="userDlg()">＋ Add user</button></div>
    <table><tr><th>Name</th><th>Email</th><th>Role</th><th>Team</th><th>Coach link</th><th>Status</th><th></th></tr>`;
  (D.users||[]).forEach(u=>{
    html+=`<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.role}</td><td>${esc(u.team||'—')}</td>
      <td class="small">${esc(coach(u.coach_id)?.name||'—')}</td>
      <td>${u.active?'<span class="pill p-done">active</span>':'<span class="pill p-over">disabled</span>'}</td>
      <td><button class="btn tiny" onclick="resetPwDlg(${u.id},'${esc(u.name)}')">Reset pw</button>
      ${u.id!==D.user.id?`<button class="btn tiny danger" onclick="toggleUser(${u.id},${u.active?0:1})">${u.active?'Disable':'Enable'}</button>`:''}</td></tr>`;
  });
  html+=`</table></div>
  <div class="panel"><h2>Recently cancelled via Keap</h2>
  <p class="small" style="margin-bottom:12px">Auto-flagged when Keap reports a subscription cancelled. Future visits are left on the
  board on purpose — clear or reassign them from the Inventory screen once you've confirmed.</p>
  <div id="cancelledOut" class="small">Loading…</div></div>
  <div class="panel"><h2>Client roster history</h2>
  <p class="small" style="margin-bottom:12px">A frozen snapshot of every client's status is captured automatically at the start of each month,
  so you can look back at who was active in any given month, not just today.</p>
  <div class="controls"><select id="chPeriod" onchange="loadClientHistory(this.value)"></select></div>
  <div id="clientHistoryOut" class="small">Loading…</div></div>
  <div class="panel"><h2>Audit log</h2><div id="auditOut" class="small">Loading…</div></div>`;
  return html;
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
async function saveCoach(){ const n=$('#kName').value.trim(); if(!n){alert('Name required');return;}
  await api('POST','/api/coaches',{name:n,team:$('#kTeam').value}); closeDlg(); await refresh(); toast(n+' added — their weeks are open capacity'); }
async function moveCoach(id,team){ if(!team) return; await api('PATCH','/api/coaches/'+id,{team}); await refresh(); toast('Moved'); }
async function removeCoach(id,name){
  if(!confirm(`Remove ${name}? Their scheduled visits return to the to-schedule list.`)) return;
  await api('DELETE','/api/coaches/'+id); await refresh(); toast(name+' removed');
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
    <label>Temporary password</label><input id="uPw" value="Welcome!${Math.floor(1000+Math.random()*9000)}">
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveUser()">Create</button></div>`);
}
async function saveUser(){
  await api('POST','/api/users',{name:$('#uName').value,email:$('#uEmail').value,role:$('#uRole').value,
    team:$('#uTeam').value||null,coach_id:$('#uCoach').value||null,password:$('#uPw').value});
  closeDlg(); await refresh(); toast('User created — send them their temporary password');
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

/* ---------- boot ---------- */
refresh().catch(()=>{ D=null; render(); });
