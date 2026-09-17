/* Coach Fulfillment System — frontend */
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MO = MONTHS.map(m=>m.slice(0,3));
const TODAY = new Date().toISOString().slice(0,10);
const fmt = iso => { if(!iso) return '—'; const [y,m,d]=iso.split('-'); return `${MO[+m-1]} ${+d}, ${y}`; };
const fmtW = iso => { if(!iso) return '—'; const [y,m,d]=iso.split('-'); return `${MO[+m-1]} ${+d}`; };
const fmtFull = iso => { if(!iso) return '—'; const [y,m,d]=iso.split('-'); return `${MONTHS[+m-1]} ${+d}, ${y}`; };
const dayDiff = (a,b)=>(new Date(a)-new Date(b))/864e5;
const CYCLE_LEN = {'Monthly':12,'Semi-Monthly':6,'Quarterly':4,'Bi-Annual':2,'LID (Purchase)':1,'Coaching Only':0};
const INTERVAL  = {'Monthly':1,'Semi-Monthly':2,'Quarterly':3,'Bi-Annual':6,'LID (Purchase)':0,'Coaching Only':0};
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

/* ========== CONTRACT/LID DETAIL MODAL ========== */

/* Opens the full-screen modal with visits + notes */
/* ---------- Visit modal (complete a visit / edit its notes) ----------
 * One screen, one action: everything typed here is saved by "Complete visit" (or by
 * "Save draft" if the visit isn't happening yet). Left: what this visit is, where it sits
 * in the cycle, what the client promised last time (check off what got done), and last
 * visit's notes for reference. Right: the four note fields, each dictatable. */
async function openVisitModal(id) {
  const v = D.visits.find(x => x.id === id);
  if (!v) return;
  const modal = document.createElement('div');
  modal.id = 'visitModal';
  modal.className = 'vm-backdrop';
  modal.innerHTML = `<div class="vm">
    <div class="vm-head">
      <div style="flex:1;min-width:0">
        <div class="vm-title">${esc(v.client)}</div>
        <div class="vm-chips" id="vmChips"></div>
      </div>
      <button class="vm-x" onclick="closeVisitModal()" title="Close">×</button>
    </div>
    <div class="vm-body">
      <aside class="vm-side" id="vmSide"><p class="small">Loading…</p></aside>
      <section class="vm-main" id="vmNotesPanel"></section>
    </div>
    <div class="vm-foot">
      <div class="small" id="vmFootNote" style="flex:1"></div>
      <button class="btn" onclick="closeVisitModal()">Cancel</button>
      ${v.completed
        ? `<button class="btn primary" onclick="saveVisitNotes(${v.id})">Save notes</button>`
        : `<button class="btn" onclick="saveVisitNotes(${v.id}, true)" title="Keep what you've typed without marking the visit done">Save draft</button>
           <button class="btn primary" onclick="completeVisitFromModal(${v.id})">✓ Complete visit</button>`}
    </div>
  </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeVisitModal(); });
  document.addEventListener('keydown', vmEsc);
  await loadVisitModalData(id);
}
function vmEsc(e){ if(e.key === 'Escape') closeVisitModal(); }
function closeVisitModal() {
  if(window._rec){ try{ window._rec.stop(); }catch(e){} window._rec = null; }
  document.removeEventListener('keydown', vmEsc);
  const modal = document.getElementById('visitModal');
  if (modal) modal.remove();
}
function vmPayload(){
  const val = id => (($('#'+id)||{}).value || '').trim();
  const commitments = val('visit_commitments').split('\n').map(s=>s.replace(/^[-•*]\s*/,'').trim()).filter(Boolean);
  const resolved = [...document.querySelectorAll('.vm-commit:checked')].map(el => +el.value);
  return { wins: val('visit_wins'), issues: val('visit_issues'), focus: val('visit_focus'), commitments, resolvedCommitmentIds: resolved,
    completed_date: val('visit_date') || undefined, store: ($('#visit_store') ? $('#visit_store').value : undefined) };
}
async function saveVisitNotes(id, draft) {
  const p = vmPayload();
  try{
    await api('PATCH', `/api/visits/${id}`, { notes_wins: p.wins, notes_issues: p.issues, notes_focus: p.focus, notes_commitments: p.commitments.join('\n') });
    toast(draft ? 'Draft saved — visit still open' : 'Notes saved');
    closeVisitModal(); await refresh();
  }catch(e){ uiAlert(e.message || 'Could not save'); }
}
async function completeVisitFromModal(id) {
  const p = vmPayload();
  if(!p.wins && !p.issues && !p.focus){
    if(!(await uiConfirm('No notes yet — complete the visit anyway? It will show up under "You owe a note" until you add them.', 'Complete without notes'))) return;
  }
  try{
    const r = await api('POST', `/api/visits/${id}/complete`, p);
    if(r && r.ok){ toast('Visit completed'); closeVisitModal(); await refresh(); }
  }catch(e){ uiAlert(e.message || 'Could not complete'); }
}
async function loadVisitModalData(visitId) {
  try {
    const [visit, cycleData, prep] = await Promise.all([
      api('GET', `/api/visits/${visitId}`), api('GET', `/api/visits/${visitId}/cycle`), api('GET', `/api/visits/${visitId}/prep`),
    ]);
    renderVisitChips(visit);
    renderVisitSide(visit, cycleData.visits || [], prep || {});
    renderNotesPanel(visit, prep || {});
  } catch (e) {
    uiAlert('Could not load visit details: ' + (e.message || 'unknown error'));
    closeVisitModal();
  }
}
function renderVisitChips(v){
  const el = $('#vmChips'); if(!el) return;
  const chip = (t, cls='') => `<span class="vm-chip ${cls}">${t}</span>`;
  const status = v.completed ? chip('✓ Completed','ok') : v.cal_week ? (weekEndOf(v.cal_week) < TODAY ? chip('Notes missing','bad') : chip('On calendar','cal')) : (v.due && v.due < TODAY ? chip('Overdue — not scheduled','bad') : chip('Needs scheduling','warn'));
  el.innerHTML = [chip(`${esc(v.cycle||'')} ${esc(v.program||'')}`), v.team ? chip(`Team ${esc(v.team)}`) : '', status, v.cal_week ? chip(`Week of ${fmtW(v.cal_week)}`) : '', v.due ? chip(`Due ${fmt(v.due)}`) : ''].filter(Boolean).join('');
}
function renderVisitSide(v, cycleVisits, prep){
  const el = $('#vmSide'); if(!el) return;
  const coachName = v.cal_coach ? (coach(v.cal_coach)?.name || '') : (D.user.coach_id && D.user.role==='coach' ? (coach(D.user.coach_id)?.name || '') : '');
  const stores = storeList(v);
  const defaultDate = v.completed_date || v.cal_week || TODAY;
  // Cycle strip: one dot per visit in this lap, oldest → newest; click opens that visit read-only.
  const lap = cycleVisits.filter(x => x.program === v.program).sort((a,b)=>(a.due||'').localeCompare(b.due||''));
  const idx = lap.findIndex(x => x.id === v.id);
  const cm = /(\d+)\s+of\s+(\d+)/.exec(v.cycle||'');
  const k = cm ? +cm[1] : 1, n = cm ? +cm[2] : lap.length;
  const start = Math.max(0, idx - (k - 1));
  const lapVisits = cm ? lap.slice(start, start + n) : lap;
  const dots = lapVisits.map(x => {
    const cls = x.id === v.id ? 'cur' : x.completed ? 'done' : x.cal_week ? 'cal' : 'todo';
    const title = `${x.cycle} · due ${fmt(x.due)}${x.completed ? ' · completed' : x.cal_week ? ' · wk of '+fmtW(x.cal_week) : ' · not scheduled'}${(x.notes_wins||x.notes_issues||x.notes_focus) ? ' · has notes' : ''}`;
    return `<button class="vm-dot ${cls}" title="${esc(title)}" ${x.id===v.id?'':`onclick="closeVisitModal();openVisitModal(${x.id})"`}>${(x.cycle||'').split(' ')[0]}</button>`;
  }).join('');
  const commits = prep.openCommitments || [];
  const last = (prep.lastNotes || [])[0];
  el.innerHTML = `
    <div class="vm-block">
      <div class="vm-label">This visit</div>
      <div class="vm-kv"><span>Coach</span><b>${esc(coachName || '—')}</b></div>
      ${v.completed ? `<div class="vm-kv"><span>Visited</span><b>${fmt(v.completed_date || v.scheduled_week || v.cal_week)}</b></div>`
        : `<div class="vm-kv"><span>Visit date</span><input type="date" id="visit_date" value="${defaultDate}" style="width:140px"></div>`}
      ${stores.length ? `<div class="vm-kv"><span>Store</span><select id="visit_store"><option value="">— pick —</option>${stores.map(s=>`<option ${v.store===s?'selected':''}>${esc(s)}</option>`).join('')}</select></div>`
        : (v.store ? `<div class="vm-kv"><span>Store</span><b>${esc(v.store)}</b></div>` : '')}
    </div>
    <div class="vm-block">
      <div class="vm-label">This cycle</div>
      <div class="vm-dots">${dots || '<span class="small">—</span>'}</div>
      <div class="small" style="margin-top:6px">Click a visit to read its notes.</div>
    </div>
    <div class="vm-block">
      <div class="vm-label">Promised last time ${commits.length ? `<span class="pill p-due" style="margin-left:6px">${commits.length} open</span>` : ''}</div>
      ${commits.length ? `<div class="small" style="margin-bottom:6px">Tick what the dealer actually did — the rest carries forward.</div>` +
        commits.map(c => `<label class="vm-commit-row"><input type="checkbox" class="vm-commit" value="${c.id}" ${v.completed?'disabled':''}><span>${esc(c.text)}<br><span class="small">from visit ${c.from_due ? 'due '+fmt(c.from_due) : ''}</span></span></label>`).join('')
        : `<div class="small">No open commitments from previous visits.</div>`}
    </div>
    ${last ? `<details class="vm-block"><summary class="vm-label" style="cursor:pointer">Last visit's notes · ${fmt(last.note_date)}</summary>
      ${last.wins ? `<div class="vm-ref"><b>Wins</b>${esc(last.wins)}</div>` : ''}
      ${last.issues ? `<div class="vm-ref"><b>Issues</b>${esc(last.issues)}</div>` : ''}
      ${last.focus ? `<div class="vm-ref"><b>Focus was</b>${esc(last.focus)}</div>` : ''}
    </details>` : ''}`;
  const foot = $('#vmFootNote');
  if(foot) foot.textContent = v.completed ? 'Editing notes on a completed visit.' : 'Complete visit saves your notes, logs new commitments and checks off the ones you ticked.';
}
function renderNotesPanel(visit, prep) {
  const panel = $('#vmNotesPanel'); if (!panel) return;
  const last = (prep.lastNotes || [])[0];
  const card = (id, title, icon, tone, ph, val, hint) => `<div class="vm-card" style="--tone:${tone.fg};--tint:${tone.bg}">
      <div class="vm-card-h"><span class="vm-ico">${icon}</span><span>${title}</span><span style="flex:1"></span>${micBtn(id)}</div>
      <textarea id="${id}" placeholder="${esc(ph)}">${esc(val || '')}</textarea>
      ${hint ? `<div class="vm-hint">${hint}</div>` : ''}
    </div>`;
  const T = { win:{fg:'#1e8e5a',bg:'#eef8f2'}, issue:{fg:'#c23b3b',bg:'#fbeeee'}, focus:{fg:'#1d4f91',bg:'#e9f0fb'}, commit:{fg:'#c77d0a',bg:'#fdf4e3'} };
  panel.innerHTML = `
    <div class="vm-main-h"><div>
      <div style="font-family:var(--head);font-size:18px;letter-spacing:.5px;text-transform:uppercase;font-weight:600">Visit notes</div>
      <div class="small">What happened, what's stuck, where you'll pick up — tap 🎤 on any box to dictate.</div></div></div>
    <div class="vm-grid">
      ${card('visit_wins', 'What went well', '✓', T.win, 'Momentum, breakthroughs, quick wins…', visit.notes_wins)}
      ${card('visit_issues', 'Issues & blockers', '!', T.issue, "What's stuck or needs attention…", visit.notes_issues)}
      ${card('visit_focus', 'Focus for next visit', '→', T.focus, "Where you'll pick up next time…", visit.notes_focus, last && last.focus ? `Last time you said: <i>${esc(last.focus)}</i>` : '')}
      ${card('visit_commitments', 'New commitments', '☐', T.commit, 'One per line — e.g. Post walkaround videos daily', visit.notes_commitments, 'Each line becomes a commitment the dealer owns; it shows up here next visit to be checked off.')}
    </div>`;
}
function getStatusLabel(v) {
  return v.completed ? 'Completed' : v.cal_week ? 'On calendar' : (v.due && v.due < TODAY) ? 'Overdue' : 'Needs scheduling';
}

/* ---------- app state ---------- */
let D = null;   // server state {user, teams, coaches, blocks, visits, users?}
let ssoEnabled;  // undefined = not checked yet, else true/false — set once from /api/sso-config on the login screen
let st = {
  view:'dashboard', boardTeam:null,
  boardY:+TODAY.slice(0,4), boardM:+TODAY.slice(5,7)-1,
  placing:null, detail:null,
  invFilter:'attention', invSearch:'',
  calSearch:'',
  due2027:false,
  handoffMode:0,
  notesCarousel: {
    cycles: [],
    currentCycleIdx: 0,
    currentNoteIdx: 0,
    filterMode: 'all'
  }
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
    const err = new Error(msg); err.body = j; err.status = r.status;
    if(!(r.status===409 && j.code==='out_of_order')) toast(msg); // out-of-order is handled by the caller
    throw err;
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
const isAvailable = (cid,w) => { const o = occ[cid+'|'+w]; return !o; };
/* Jumps straight to the Schedule Board cell a visit is sitting on — the calendar
 * link behind every "on calendar" / "Late — on calendar" badge. Switches to the
 * visit's own team and the month its cal_week falls in (which may not be the
 * viewer's current team/month), and opens its detail box the same way clicking
 * the card on the board itself does. Read-only navigation — available to anyone
 * who can see the board (canEditWeeks()), same as clicking a card there. */
function jumpToCalendar(id){
  const v = D.visits.find(x=>x.id===id);
  if(!v || !v.cal_week){ uiAlert("This visit isn't on the calendar yet."); return; }
  st.view='board'; st.boardTeam=v.team||myTeams()[0];
  st.boardY=+v.cal_week.slice(0,4); st.boardM=+v.cal_week.slice(5,7)-1;
  st.detail=v.id; st.placing=null; render();
}
/* Shared "on calendar" / "Late — on calendar" badge — used anywhere a visit is
 * referenced (Inventory list, a client's Visit history). Hovering shows the due
 * date and the scheduled week; clicking jumps straight to that cell on the
 * Schedule Board (stopPropagation so it doesn't also trigger a row's own onclick,
 * e.g. Inventory rows opening the visit drawer underneath it). */
// Week-of date (Monday) → the Sunday that closes that week, ISO string.
const weekEndOf = mon => { const d = new Date(mon + 'T00:00:00'); d.setDate(d.getDate() + 6); return d.toISOString().slice(0,10); };
function calendarPill(v){
  const who = v.cal_coach ? ' — ' + (coach(v.cal_coach)?.name || '') : '';
  // Scheduled week is over and nobody marked it complete: the visit presumably happened
  // but the coach never filed notes. Surface that instead of a reassuring "On calendar".
  if(v.cal_week && weekEndOf(v.cal_week) < TODAY){
    const tip = `Scheduled for week of ${fmtW(v.cal_week)}${who}. That week has passed and the visit hasn't been marked complete — notes are missing. Click to view it on the calendar.`;
    return `<span class="pill p-over" style="cursor:pointer" title="${esc(tip)}" onclick="event.stopPropagation();jumpToCalendar(${v.id})">Notes missing</span>`;
  }
  const late = v.due && v.due < TODAY;
  const tip = `Due ${fmt(v.due)} — scheduled for week of ${fmtW(v.cal_week)}${who}`;
  return `<span class="pill ${late?'p-due':'p-cal'}" style="cursor:pointer" title="${esc(tip)}" onclick="event.stopPropagation();jumpToCalendar(${v.id})">${late?'Late — on calendar':'On calendar'}</span>`;
}
/* Completed-visit badge. When the visit was placed on the calendar (cal_week set), it
 * behaves like calendarPill — hover shows when it was done + which week/coach it sat on,
 * and clicking jumps to that cell on the Schedule Board. Historical imports with no
 * calendar placement fall back to a plain, non-clickable badge that still shows the date. */
function completedPill(v){
  if(v.cal_week){
    const tip = `Completed for scheduled week: ${fmtW(v.scheduled_week)}${v.cal_coach?' with '+(coach(v.cal_coach)?.name||''):''}. Click to view it on the calendar.`;
    return `<span class="pill p-done" style="cursor:pointer" title="${esc(tip)}" onclick="event.stopPropagation();jumpToCalendar(${v.id})">completed ↗</span>`;
  }
  const tip = v.scheduled_week ? `Scheduled for: ${fmt(v.scheduled_week)}` : (v.sched_hist ? `Scheduled ${v.sched_hist}` : 'Completed');
  return `<span class="pill p-done" title="${esc(tip)}">completed</span>`;
}
const canEdit = () => ['admin','lead'].includes(D.user.role);
const isAdmin = () => D.user.role === 'admin';
// Broader than canEdit(): sales/coach can see the Schedule Board and set/clear a
// coach's open-week label (Home/Off/Training/etc.), but never place, move, or
// unschedule an actual visit card — that stays canEdit()-only (admin/lead), and is
// enforced server-side regardless of what the UI shows.
const canEditWeeks = () => ['admin','lead','sales','coach'].includes(D.user.role);
// A coach can complete a visit only if they're the one who scheduled it (cal_coach)
// or the one permanently assigned to the client (client_assigned_coach_id) — this is
// a UI convenience mirror of the server-side check in server.js's canCompleteVisit;
// the server re-derives and enforces this independently, so this never has to be
// trusted as the real security boundary.
const ownsVisit = v => D.user.role==='coach' && ((v.cal_coach && v.cal_coach===D.user.coach_id) || (v.client_assigned_coach_id && v.client_assigned_coach_id===D.user.coach_id));
// Unschedule / Move: server allows admin/lead on their team, and a coach ONLY for a
// client assigned to them (being the calendar coach isn't enough) — mirror that here.
/* Cycle-order helpers — mirror of the server's placementProblem, used to grey out Place
 * buttons and explain why. The server is the authority; this just saves a failed click. */
const parseCycle = c => { const m=/^(\d+)\s+of\s+(\d+)$/.exec(c||''); return m?{k:+m[1],n:+m[2]}:null; };
function cycleLapOf(v){
  if(!v || !v.contract_id || !parseCycle(v.cycle)) return null;
  const rows = D.visits.filter(x=>x.contract_id===v.contract_id && x.program===v.program && parseCycle(x.cycle)).sort((a,b)=>(a.due||'').localeCompare(b.due||'')||a.id-b.id);
  const laps=[]; let lap=[], prevK=Infinity;
  for(const r of rows){ const k=parseCycle(r.cycle).k; if(k<=prevK && lap.length){ laps.push(lap); lap=[]; } lap.push({...r,k}); prevK=k; }
  if(lap.length) laps.push(lap);
  return laps.find(L=>L.some(x=>x.id===v.id))||null;
}
function placeBlockReason(v){
  const lap = cycleLapOf(v); if(!lap) return null;
  const me = lap.find(x=>x.id===v.id); if(!me) return null;
  const earlier = lap.filter(x=>x.k<me.k && !x.completed && !x.cal_week);
  return earlier.length ? `Place ${earlier.map(x=>x.cycle).join(' and ')} first — visits go on the calendar in order` : null;
}
function orderProblem(v){ // for a PLACED, not-completed visit: is it out of order right now?
  if(!v || v.completed || !v.cal_week) return null;
  const lap = cycleLapOf(v); if(!lap) return null;
  const me = lap.find(x=>x.id===v.id); if(!me) return null;
  const wk = x => x.completed ? (x.scheduled_week||x.cal_week) : x.cal_week;
  const a = lap.find(x=>x.k<me.k && !x.completed && !x.cal_week); if(a) return `${a.cycle} is still unscheduled`;
  const b = lap.find(x=>x.k<me.k && wk(x) && wk(x) > v.cal_week); if(b) return `placed before ${b.cycle} (wk of ${fmtW(wk(b))})`;
  const c = lap.find(x=>x.k>me.k && wk(x) && wk(x) < v.cal_week); if(c) return `placed after ${c.cycle} (wk of ${fmtW(wk(c))})`;
  return null;
}
/* "Needs scheduling" / "Overdue — no plan" as a link into the calendar: placement mode for
 * anyone allowed to place this visit (unless a lower-numbered visit must go first), else
 * just the calendar at the due month. */
function unscheduledPill(v, extra=''){
  const over = v.due && v.due < TODAY;
  const text = over ? `Overdue — no plan${extra}` : `Needs scheduling${extra}`;
  const cls = over ? 'p-over' : 'p-due';
  const can = canEdit() || ownsVisit(v);
  const blocked = can ? placeBlockReason(v) : null;
  const dateCmd = v.due ? `st.boardY=${+v.due.slice(0,4)};st.boardM=${+v.due.slice(5,7)-1};` : '';
  const onclick = can && !blocked ? placeJump(v) : `st.view='board';${v.team?`st.boardTeam='${esc(v.team)}';`:''}${dateCmd}st.placing=null;render()`;
  const title = blocked ? blocked : can ? 'Open the calendar and pick a week for this visit' : 'Open the calendar at this visit\'s due month';
  return `<span class="pill ${cls}" style="cursor:pointer" title="${esc(title)}" onclick="event.stopPropagation();${onclick}">${text} ↗</span>`;
}
const canReschedule = v => canEdit() || (D.user.role==='coach' && !!v.client_assigned_coach_id && v.client_assigned_coach_id===D.user.coach_id);
const myTeams = () => D.user.role==='admin' ? D.teams : [D.user.team];

/* Helper to render a client name as a clickable link to their profile,
   or as plain text if no clientId is provided. Used throughout the app
   to make all client names consistently navigable. */
const clientLink = (name, clientId) => {
  if(!clientId) return `<span>${esc(name)}</span>`;
  return `<span style="cursor:pointer;color:var(--primary)" onmouseover="this.style.opacity='0.7'" onmouseout="this.style.opacity='1'" title="Click to view profile" onclick="openClientProfile(${clientId})">${esc(name)}</span>`;
};

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
/* Coach offboarding workflow — handles the modal for future visit disposition */
async function showCoachOffboardingModal(coach, futureVisits){
  const visitList = futureVisits.map(v=>`<tr><td>${esc(v.client)}</td><td>${esc(v.cycle)} ${esc(v.program)}</td><td class="mono">${fmt(v.due)}</td></tr>`).join('');
  openDlg(`<h3>Offboard ${esc(coach.name)}?</h3>
    <p class="small" style="margin-bottom:10px">This coach has ${futureVisits.length} future unscheduled visit(s). Choose what to do with them:</p>
    <table style="margin-bottom:12px"><tr><th>Client</th><th>Visit</th><th>Due</th></tr>${visitList}</table>
    <div style="margin-bottom:12px">
      <label><input type="radio" name="offboardDisposition" value="delete" checked> Delete these visits — they won't be scheduled.</label>
      <label style="margin-top:8px"><input type="radio" name="offboardDisposition" value="transfer"> Leave them unscheduled — mark as orphaned so someone else can pick them up later.</label>
      <label style="margin-top:8px"><input type="radio" name="offboardDisposition" value="orphan"> Leave them exactly as-is — just remove the coach assignment.</label>
    </div>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary danger" onclick="confirmCoachOffboard('${coach.id}')">Confirm offboarding</button></div>`);
}
async function confirmCoachOffboard(coachId){
  const disposition = document.querySelector('input[name="offboardDisposition"]:checked')?.value || 'transfer';
  try{
    await api('POST',`/api/coaches/${coachId}/offboard`, { disposition });
    closeDlg();
    await refresh();
    const c = D.coaches.find(x=>x.id===coachId);
    toast(`${c?.name||'Coach'} offboarded`);
  }catch(e){
    uiAlert(e.message || 'Could not offboard coach');
  }
}
async function coachDeleteWithModal(coachId){
  try{
    const r = await api('DELETE',`/api/coaches/${coachId}`);
    if(r.hasFutureVisits && r.futureVisits && r.futureVisits.length > 0){
      await showCoachOffboardingModal(r.coach, r.futureVisits);
    } else {
      const c = r.coach || D.coaches.find(x=>x.id===coachId);
      toast(`${c?.name||'Coach'} deactivated`);
      await refresh();
    }
  }catch(e){
    uiAlert(e.message || 'Could not process coach deletion');
  }
}
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

/* ---------- notes carousel (cycle-based display) ---------- */
const CYCLE_COLORS = ['#4A90E2', '#1ABC9C', '#F39C12', '#E74C3C', '#9B59B6', '#27AE60'];
function getCycleColor(cycleNum) {
  return CYCLE_COLORS[(cycleNum - 1) % CYCLE_COLORS.length];
}

async function loadNotesCarousel(clientId) {
  try {
    const data = await api('GET', '/api/clients/' + clientId + '/notes-by-cycle');
    st.notesCarousel.cycles = data.cycles || [];
    st.notesCarousel.currentCycleIdx = 0;
    st.notesCarousel.currentNoteIdx = 0;
  } catch (e) {
    console.error('Failed to load notes carousel:', e);
    st.notesCarousel.cycles = [];
  }
}

function nextNoteCarousel() {
  if (!st.notesCarousel.cycles.length) return;
  const cycle = st.notesCarousel.cycles[st.notesCarousel.currentCycleIdx];
  if (!cycle || !cycle.notes.length) return;

  if (st.notesCarousel.currentNoteIdx < cycle.notes.length - 1) {
    st.notesCarousel.currentNoteIdx++;
  } else if (st.notesCarousel.currentCycleIdx < st.notesCarousel.cycles.length - 1) {
    st.notesCarousel.currentCycleIdx++;
    st.notesCarousel.currentNoteIdx = 0;
  }
}

function prevNoteCarousel() {
  if (!st.notesCarousel.cycles.length) return;

  if (st.notesCarousel.currentNoteIdx > 0) {
    st.notesCarousel.currentNoteIdx--;
  } else if (st.notesCarousel.currentCycleIdx > 0) {
    st.notesCarousel.currentCycleIdx--;
    const cycle = st.notesCarousel.cycles[st.notesCarousel.currentCycleIdx];
    st.notesCarousel.currentNoteIdx = (cycle.notes.length || 1) - 1;
  }
}

function jumpToCycleCarousel(cycleIdx) {
  if (cycleIdx >= 0 && cycleIdx < st.notesCarousel.cycles.length) {
    st.notesCarousel.currentCycleIdx = cycleIdx;
    st.notesCarousel.currentNoteIdx = 0;
  }
}

function renderNoteSection(title, content, color) {
  if (!content) return '';
  return `<div style="margin-bottom:16px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:${color};letter-spacing:0.5px;margin-bottom:8px">${title}</div>
    <div style="font-size:13px;line-height:1.6;color:#333">${esc(content)}</div>
  </div>`;
}
function renderCarouselOnly() {
  const carouselDiv = document.getElementById("notesCarouselContainer");
  if (carouselDiv && st.clientProfile?.client?.id) {
    carouselDiv.innerHTML = renderNotesCarousel(st.clientProfile.client.id);
  }
  setupCarouselListeners();
}
// 
function setupCarouselListeners() {
  const container = document.getElementById("notesCarouselContainer");
  if (!container) return;
  
  // Tab click handlers
  container.querySelectorAll(".carousel-cycle-tab").forEach(tab => {
    tab.addEventListener("click", (e) => {
      const idx = parseInt(e.currentTarget.getAttribute("data-cycle-idx"));
      jumpToCycleCarousel(idx);
      renderCarouselOnly();
    });
  });
  
  // Previous note button
  const prevBtn = container.querySelector("[data-action='prev-note']");
  if (prevBtn) prevBtn.addEventListener("click", () => { prevNoteCarousel(); renderCarouselOnly(); });
  
  // Next note button
  const nextBtn = container.querySelector("[data-action='next-note']");
  if (nextBtn) nextBtn.addEventListener("click", () => { nextNoteCarousel(); renderCarouselOnly(); });
  
  // Pagination dots
  container.querySelectorAll(".carousel-dot").forEach(dot => {
    dot.addEventListener("click", (e) => {
      const noteIdx = parseInt(e.currentTarget.getAttribute("data-note-idx"));
      st.notesCarousel.currentNoteIdx = noteIdx;
      renderCarouselOnly();
    });
  });
}

function renderNotesCarousel(clientId) {
  const { cycles, currentCycleIdx, currentNoteIdx } = st.notesCarousel;

  if (!cycles.length) {
    return '<p class="small" style="color:var(--muted)">No notes recorded yet.</p>';
  }

  const cycle = cycles[currentCycleIdx];
  if (!cycle || !cycle.notes.length) {
    return '<p class="small" style="color:var(--muted)">No notes in this cycle.</p>';
  }

  const note = cycle.notes[currentNoteIdx];
  const color = getCycleColor(cycle.cycle_num || (currentCycleIdx + 1));
  const isLast = currentNoteIdx === cycle.notes.length - 1;
  const isFirst = currentNoteIdx === 0;

  let html = `<div style="margin-bottom:20px">`;

  // Apple-style cycle tabs - clean, minimal, text-based
  html += `<div style="display:flex;gap:0;margin-bottom:24px;border-bottom:1px solid #e5e5e5;position:relative;overflow-x:auto;-webkit-overflow-scrolling:touch">`;
  cycles.forEach((c, idx) => {
    const isActive = idx === currentCycleIdx;
    const tabColor = getCycleColor(c.cycle_num || (idx + 1));
    html += `<button  style="padding:14px 16px;border:none;background:transparent;color:${isActive?'#000':'#999'};font-size:13px;font-weight:${isActive?'600':'500'};cursor:pointer;transition:all 0.3s ease;position:relative;white-space:nowrap;${isActive?`border-bottom:3px solid ${tabColor};color:#000;`:''}" data-cycle-idx="${idx}" class="carousel-cycle-tab">${esc(c.cycle_label)}</button>`;
  });
  html += `</div>`;

  // Note card — colour band header + three tinted columns (Wins / Issues / Focus)
  const coachName = (coach(note.author)?.name) || (note.author ? note.author.split('_').slice(-2).map(s=>s.charAt(0).toUpperCase()+s.slice(1)).join(' ') : 'Unknown');
  const chip = (label, val) => `<span style="display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:5px 11px;font-size:12px;color:#fff;white-space:nowrap"><span style="font-family:var(--head);font-size:9.5px;letter-spacing:.8px;text-transform:uppercase;opacity:.85">${label}</span><b style="font-weight:600">${val}</b></span>`;
  const section = (title, icon, tone, body) => `<div style="padding:18px 20px;background:${tone.bg};border-top:3px solid ${tone.fg};min-height:120px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="width:24px;height:24px;border-radius:50%;background:${tone.fg};color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700">${icon}</span>
        <span style="font-family:var(--head);font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${tone.fg};font-weight:600">${title}</span>
      </div>
      ${body ? `<div style="font-size:14px;line-height:1.6;color:#222;white-space:pre-wrap">${esc(body)}</div>`
             : `<div style="font-size:13px;color:#9a9a9f;font-style:italic">Nothing noted</div>`}
    </div>`;
  const TONES = { win:{fg:'#1e8e5a',bg:'#eef8f2'}, issue:{fg:'#c77d0a',bg:'#fdf4e3'}, focus:{fg:'#1d4f91',bg:'#e9f0fb'} };

  html += `<div style="animation:fadeInNote 0.35s ease-out;margin-bottom:20px">
    <div style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);border:1px solid var(--line)">
      <div style="background:linear-gradient(135deg,${color} 0%,${color}d9 100%);padding:18px 22px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-family:var(--head);font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:rgba(255,255,255,.85)">Visit completed</div>
          <div style="font-family:var(--head);font-size:28px;font-weight:600;line-height:1.1;color:#fff">${fmt(note.scheduled_on || note.date)}</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          ${chip('Due', fmt(note.date))}
          ${note.cycle ? chip('Cycle', esc(note.cycle)) : ''}
          ${chip('Coach', esc(coachName))}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1px;background:var(--line)">
        ${section('Wins','✓',TONES.win,note.wins)}
        ${section('Issues','!',TONES.issue,note.issues)}
        ${section('Focus','→',TONES.focus,note.focus)}
      </div>
    </div>
  </div>`;

  // Apple-style pagination and navigation - clean dots + swipe-like navigation
  html += `<div style="display:flex;flex-direction:column;gap:16px">
    <!-- Pagination dots -->
    <div style="display:flex;justify-content:center;gap:8px;padding:8px 0">
      ${cycle.notes.map((_, idx) => {
        const isActive = idx === currentNoteIdx;
        return `<button data-note-idx="${idx}" class="carousel-dot" style="width:${isActive?'28':'8'}px;height:8px;border-radius:4px;background:${isActive?'#000':'#ddd'};border:none;cursor:pointer;transition:all 0.3s ease;padding:0" title="Note ${idx+1}"></button>`;
      }).join('')}
    </div>
    
    <!-- Navigation buttons -->
    <div style="display:flex;gap:12px;justify-content:center">
      <button data-action="prev-note" style="padding:10px 14px;border:1px solid #e5e5e5;background:#fff;color:#333;border-radius:8px;font-size:14px;cursor:${isFirst?'not-allowed':'pointer'};opacity:${isFirst?'0.4':'1'};pointer-events:${isFirst?'none':'auto'};transition:all 0.2s;font-weight:500" ${isFirst?'disabled':''}>← Prev</button>
      
      <div style="font-size:13px;color:#999;display:flex;align-items:center;gap:4px">
        <span style="color:#000;font-weight:600">${currentNoteIdx + 1}</span>
        <span>/</span>
        <span>${cycle.notes.length}</span>
      </div>
      
      <button data-action="next-note" style="padding:10px 14px;border:1px solid #e5e5e5;background:#fff;color:#333;border-radius:8px;font-size:14px;cursor:${isLast?'not-allowed':'pointer'};opacity:${isLast?'0.4':'1'};pointer-events:${isLast?'none':'auto'};transition:all 0.2s;font-weight:500" ${isLast?'disabled':''}>Next →</button>
    </div>
  </div>`;

  html += `</div>`;
  return html;
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
  // One Calendar tab (2026-09-15 nav cleanup): the board's own controls switch between
  // my row / team / all teams / list view, so Schedule Board, Global Calendar and My
  // Schedule no longer need separate tabs. My Profile moved to the avatar (top right).
  if(canEditWeeks()) views.board='Calendar'; // admin/lead/sales/coach — see canEditWeeks()
  views.inventory = r==='coach' ? 'Visit List' : 'LID Inventory';
  views.clients='Clients'; // dropdown for admin/lead (Active Clients + Unassigned Clients); plain link otherwise
  if(r!=='coach') views.availability='Availability'; // sales-capacity tool — not a coach's concern
  if(r==='admin') views.admin='Admin';
  views.faq='FAQ';
  const CAL_VIEWS = ['board','global','formercoaches','mysched'];
  if(!views[st.view] && !CAL_VIEWS.includes(st.view) && st.view!=='clientprofile' && st.view!=='coachprofile' && !(st.view==='pending'&&hasPending)){
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
    const active = st.view===k||(k==='clients'&&st.view==='clientprofile')||(k==='board'&&CAL_VIEWS.includes(st.view));
    return `<button class="${active?'active':''}" onclick="go('${k}')">${v}</button>`;
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
      ${D.user.coach_id ? `<a onclick="openCoachProfile('${D.user.coach_id}')" title="My profile" style="cursor:pointer;display:flex">${avatarHtml(D.user.name, D.user.team, 30)}</a>` : avatarHtml(D.user.name, D.user.team, 30)}
      <span>${D.user.coach_id ? `<a onclick="openCoachProfile('${D.user.coach_id}')" title="My profile" style="color:inherit;cursor:pointer">${esc(D.user.name)}</a>` : esc(D.user.name)} · ${D.user.role}${D.user.team?' · '+D.user.team:''}<br>
      <a onclick="pwDlg()">password</a> · <a onclick="logout()">sign out</a></span></div>
  </header>
  <main id="main"></main>`;
  const m=$('#main');
  if(st.view==='dashboard'){ m.innerHTML=dashboard(); loadToday(); }
  if(st.view==='board') m.innerHTML=board();
  if(st.view==='global') m.innerHTML=board();
  if(st.view==='formercoaches') m.innerHTML=board();
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
    if(tab==='data'){ loadCancelledContracts(); loadDeletedClients(); loadArchivedClients(); loadOutOfOrder(); loadRevenueHistory(); loadBackupStatus(); loadKeapEvents(); loadTeamMismatchAudit(); loadDuplicateVisitsAudit(); loadPhantomContractsAudit(); loadContractSplitsAudit(); loadOrphanedVisitsAudit(); loadSheetRecon2026(); loadResyncPreview(); }
    if(tab==='history'){ loadAudit(); loadClientHistoryPeriods(); }
    if(tab==='monthend'){ loadMonthEnd(); }
  }
  if(st.view==='faq') m.innerHTML=faqView();
  syncHistory();
  restoreFocus();
}
function go(v){ st.view=v; st.placing=null; st.detail=null; render(); }

/* ---------- browser history / Back button ----------
 * The app is a single page that swaps views by mutating `st` and re-rendering. Without
 * this, the browser Back button leaves the site entirely instead of returning to the
 * previous in-app view. syncHistory() runs at the end of every render() (the single
 * choke point all navigation flows through) and pushes a history entry whenever the
 * nav-relevant state changes — so Back/Forward walk the views the user actually clicked
 * through. Only view/ids/team/adminTab count as "navigation" (not dialog open/close,
 * data refreshes, month paging, or placing state), so we don't spam the history stack. */
let _lastNavKey = null;
function _navKey(){ return JSON.stringify([st.view, st.clientId, st.coachId, st.boardTeam, st.adminTab]); }
function syncHistory(){
  const key = _navKey();
  if(key === _lastNavKey) return;
  const first = _lastNavKey === null;
  _lastNavKey = key;
  const s = { nav:true, view:st.view, clientId:st.clientId, coachId:st.coachId, boardTeam:st.boardTeam, boardY:st.boardY, boardM:st.boardM, adminTab:st.adminTab };
  try{ first ? history.replaceState(s, '') : history.pushState(s, ''); }catch(_){}
}
window.addEventListener('popstate', e => {
  const s = e.state;
  if(!s || !s.nav) return; // not one of ours (e.g. pre-app entry) — let the browser do its thing
  st.view = s.view; st.clientId = s.clientId; st.coachId = s.coachId;
  st.boardTeam = s.boardTeam; if(s.boardY!=null) st.boardY = s.boardY; if(s.boardM!=null) st.boardM = s.boardM;
  st.adminTab = s.adminTab; st.placing = null; st.detail = null;
  _lastNavKey = _navKey(); // prevent syncHistory() from re-pushing this restored state
  render();
});
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
    clientHits.map(c=>`<a onclick="gsGo('client',${c.id})"><b>${esc(c.name)}</b><span class="small"> · client${c.archived_at?' · archived':c.status==='active'?'':' · '+esc(c.status)}</span></a>`).join('') +
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
    <label>New password</label><input type="password" id="pw1" autocomplete="new-password">
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
    ${ssoEnabled ? `<a href="https://coach-fulfillment-system.onrender.com/auth/google" class="gbtn">
      <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
      <span>Sign in with Google</span></a>
    <div class="small" style="text-align:center;margin-bottom:10px;color:var(--muted)">— or —</div>` : ''}
    <form id="loginForm" onsubmit="event.preventDefault();doLogin()">
    <label>Email</label><input type="text" name="username" id="lEmail" autocomplete="username">
    <label>Password</label><input type="password" name="password" id="lPw" autocomplete="current-password">
    <div class="err" id="lErr"></div>
    <button class="btn primary" type="submit">Sign in</button>
    </form>
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
  // Fetch orphaned visits for dashboard display
  let orphanedData = null;
  if(D.user.role !== 'coach'){
    try{ orphanedData = await api('GET','/api/orphaned-visits'); }
    catch(e){}
  }
  $('#todayOut').innerHTML = D.user.role==='coach' ? todayCoachView(t) : todayTeamView(t, orphanedData);
}
function syncConfCount(){
  const n=document.querySelectorAll('.confChk:checked').length;
  const el=$('#confCount'); if(el) el.textContent = n?`${n} selected`:'';
  const all=$('#confAll'); const total=document.querySelectorAll('.confChk').length;
  if(all) all.checked = n>0 && n===total;
}
async function bulkConfirmCompleted(){
  const ids=[...document.querySelectorAll('.confChk:checked')].map(c=>+c.value);
  if(!ids.length){ toast('Tick at least one visit first'); return; }
  if(!(await uiConfirm(`Mark ${ids.length} visit(s) complete, each dated to the week it was scheduled? Use this to confirm they actually happened.`,'Mark complete'))) return;
  try{
    const r=await api('POST','/api/admin/confirm-completed',{ids});
    toast(`Confirmed ${r.completed} complete${r.skipped?` · ${r.skipped} skipped`:''}`);
    await refresh(); await loadToday();
  }catch(e){ uiAlert(e.message||'Bulk confirm failed'); }
}
const invJump = f => `st.invFilter='${f}';st.invSel=new Set();go('inventory')`;
const placeJump = v => {
  const targetView = st.view === 'formercoaches' ? 'formercoaches' : 'board';
  const teamCmd = st.view === 'formercoaches' ? '' : `st.boardTeam='${esc(v.team)}';`;
  const dateCmd = v.due?`st.boardY=${+v.due.slice(0,4)};st.boardM=${+v.due.slice(5,7)-1};`:'';
  return `st.view='${targetView}';${teamCmd}${dateCmd}st.placing=${v.id};render()`;
};
function todayRows(list, maxN, rowFn){
  return list.slice(0,maxN).map(rowFn).join('') +
    (list.length>maxN?`<tr><td colspan="9" class="small">…and ${list.length-maxN} more</td></tr>`:'');
}
function todayTeamView(t, orphanedData){
  const odDays = d => Math.floor(dayDiff(TODAY,d));
  let html=`<div class="cards">
    <div class="card ${t.overdueNoPlan.length?'bad':'ok'}" style="cursor:pointer" onclick="${invJump('overdue')};st.invFilter='attention'"><div class="k">${t.overdueNoPlan.length}</div><div class="l">Overdue — no plan</div></div>
    <div class="card" style="cursor:pointer" onclick="${invJump('oncal')}"><div class="k">${t.lateOnCalendar}</div><div class="l">Late but on calendar</div></div>
    <div class="card ${t.dueSoonUnscheduled.length?'warn':'ok'}" style="cursor:pointer" onclick="${invJump('needs')}"><div class="k">${t.dueSoonUnscheduled.length}</div><div class="l">Due in 30 days, unscheduled</div></div>
    ${(t.toConfirm&&t.toConfirm.length)?`<div class="card warn" style="cursor:pointer" onclick="document.getElementById('confirmDonePanel')?.scrollIntoView({behavior:'smooth'})"><div class="k">${t.toConfirm.length}</div><div class="l">To confirm completed</div></div>`:''}
    <div class="card ok"><div class="k">${t.completedThisMonth}</div><div class="l">Completed this month${t.team?' — Team '+esc(t.team):''}</div></div>
    ${(t.callsOwed&&t.callsOwed.length)?`<div class="card ${t.callsOwed.some(r=>r.missed)?'bad':'warn'}" style="cursor:pointer" onclick="document.getElementById('tdCalls')?.scrollIntoView({behavior:'smooth'})"><div class="k">${t.callsOwed.length}</div><div class="l">Coaching calls owed</div></div>`:''}
    ${orphanedData ? (() => {
      const sum = orphanedData.summary || {total: 0, overdue: 0, thisMonth: 0, nextMonth: 0};
      const cardClass = sum.overdue > 0 ? 'bad' : (sum.thisMonth > 0 ? 'warn' : 'ok');
      return `<div class="card ${cardClass}" style="cursor:pointer" onclick="st.invFilter='orphaned';go('inventory')"><div class="k">${sum.total}</div><div class="l">Orphaned visits${sum.overdue?' · '+sum.overdue+' overdue':''}</div></div>`;
    })() : ''}
  </div>`;
  if(t.pendingCount) html+=`<div class="panel" style="border-left:4px solid var(--primary);padding:10px 14px">
    <b>${t.pendingCount} new Keap subscription${t.pendingCount>1?'s':''}</b> waiting for assignment.
    <button class="btn tiny primary" style="margin-left:8px" onclick="go('pending')">Review →</button></div>`;

  html+=callsOwedPanel(t);

  html+=`<div class="panel"><h2>Fix first — overdue with no plan (${t.overdueNoPlan.length})</h2>`;
  html+= t.overdueNoPlan.length ? `<table><tr><th>Client</th><th>Visit</th><th>Was due</th><th>How late</th><th></th></tr>`+
    todayRows(t.overdueNoPlan, 10, v=>`<tr>
      <td><b>${clientLink(v.client, v.client_id)}</b></td>
      <td>${esc(v.cycle)} ${esc(v.program)} · ${esc(v.team||'?')}</td><td class="mono">${fmt(v.due)}</td>
      <td><span class="pill p-over">${odDays(v.due)} days</span></td>
      <td>${v.team?`<button class="btn tiny primary" onclick="${placeJump(v)}">Place on calendar</button>`:''}
      <button class="btn tiny" onclick="openVisitModal(${v.id})">Details</button></td></tr>`)+`</table>`
    : `<p class="small">Nothing — every overdue visit has a calendar slot. ✔</p>`;
  html+=`</div>`;

  if(t.toConfirm && t.toConfirm.length){
    html+=`<div class="panel" id="confirmDonePanel"><h2>Confirm completed — scheduled, week passed, not marked done (${t.toConfirm.length})</h2>
    <p class="small" style="margin-bottom:8px">These visits were placed on a week that's already over but aren't marked complete yet — including everything brought over from the 2026 sheet. Tick the ones that happened and confirm in a batch; each is marked complete <b>as of the week it was scheduled</b>, not today. If a visit didn't happen, leave it unticked and open it to reschedule.</p>
    <div class="controls" style="margin-bottom:8px;align-items:center">
      <label class="small"><input type="checkbox" id="confAll" onclick="document.querySelectorAll('.confChk').forEach(c=>c.checked=this.checked);syncConfCount()"> Select all ${t.toConfirm.length}</label>
      <button class="btn primary tiny" onclick="bulkConfirmCompleted()">Mark selected complete</button>
      <span class="small" id="confCount" style="color:var(--muted)"></span>
    </div>
    <table><tr><th style="width:26px"></th><th>Client</th><th>Visit</th><th>Was scheduled</th><th>Coach</th><th></th></tr>`+
    t.toConfirm.map(v=>`<tr>
      <td><input type="checkbox" class="confChk" value="${v.id}" onclick="syncConfCount()"></td>
      <td><b>${clientLink(v.client, v.client_id)}</b></td>
      <td>${esc(v.cycle)} ${esc(v.program)} · ${esc(v.team||'?')}</td>
      <td class="mono">wk of ${fmtW(v.cal_week)}</td>
      <td>${esc(coach(v.cal_coach)?.name||'—')}</td>
      <td><button class="btn tiny" onclick="openVisitModal(${v.id})">Details</button></td></tr>`).join('')+`</table></div>`;
  }

  html+=`<div class="panel"><h2>Schedule next — due within 30 days (${t.dueSoonUnscheduled.length})</h2>`;
  html+= t.dueSoonUnscheduled.length ? `<table><tr><th>Client</th><th>Visit</th><th>Due</th><th></th></tr>`+
    todayRows(t.dueSoonUnscheduled, 10, v=>`<tr>
      <td><b>${clientLink(v.client, v.client_id)}</b></td>
      <td>${esc(v.cycle)} ${esc(v.program)} · ${esc(v.team||'?')}</td><td class="mono">${fmt(v.due)}</td>
      <td>${v.team?`<button class="btn tiny primary" onclick="${placeJump(v)}">Place on calendar</button>`:''}</td></tr>`)+`</table>`
    : `<p class="small">Nothing coming due unscheduled in the next 30 days. ✔</p>`;
  html+=`</div>`;

  if(t.atRisk.length){
    html+=`<div class="panel"><h2>At-risk clients (${t.atRisk.length})</h2>
    <p class="small" style="margin-bottom:8px">Active, paying visit-clients with no completed visit in 60+ days and nothing on the calendar — the ones most likely to churn quietly.</p>
    <table><tr><th>Client</th><th>Assigned coach</th><th></th></tr>`+
    todayRows(t.atRisk, 8, c=>`<tr><td><b>${clientLink(c.name, c.id)}</b></td>
      <td>${esc(coach(c.assigned_coach_id)?.name||'— unassigned —')}</td>
      <td><button class="btn tiny" onclick="openClientProfile(${c.id})">Open profile</button></td></tr>`)+`</table></div>`;
  }

  if(t.weekPassed && t.weekPassed.length){
    html+=`<div class="panel"><h2>Scheduled week passed, not marked done (${t.weekPassed.length})</h2>
    <p class="small" style="margin-bottom:8px">On a coach's calendar for a week that's now over, still open. Either it happened and wasn't logged, or it needs re-placing — the coach sees these on their own Today.</p>
    <table><tr><th>Client</th><th>Visit</th><th>Was scheduled</th><th>Coach</th><th></th></tr>`+
    todayRows(t.weekPassed, 10, v=>`<tr><td><b>${clientLink(v.client, v.client_id)}</b></td><td class="small">${esc(v.cycle||'')} ${esc(v.program||'')}</td>
      <td class="mono">wk of ${fmtW(v.cal_week)}</td><td>${esc(coach(v.cal_coach)?.name||'—')}</td>
      <td><button class="btn tiny" onclick="openVisitModal(${v.id})">Open</button></td></tr>`)+`</table></div>`;
  }
  if(t.missingNotes.length){
    html+=`<div class="panel"><h2>Completed without a note (${t.missingNotes.length})</h2>
    <p class="small" style="margin-bottom:8px">Visits marked done in the last 30 days with no write-up — undocumented work is invisible work.</p>
    <table><tr><th>Client</th><th>Scheduled On</th><th>Coach</th><th></th></tr>`+
    todayRows(t.missingNotes, 8, v=>`<tr><td><b>${clientLink(v.client, v.client_id)}</b></td><td class="mono">${fmt(v.scheduled_week)}</td>
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
/* ---------- Coaching calls owed (Today) ----------
 * Deliberately its own panel rather than folded into "You owe a note": that list is a
 * write-up missing for work already done, this one is work that hasn't happened yet.
 * The server decides what's owed (see callsOwed) — current month only from the 10th,
 * last month once it has closed — so this just renders it. */
function monthLabel(key){
  const [y,m] = String(key||'').split('-').map(Number);
  return (MONTHS_SHORT[(m||1)-1] || '?') + ' ' + (y || '');
}
// Last day of a YYYY-MM, so a call logged for a closed month lands inside it and counts.
function monthEndDate(key){
  const [y,m] = String(key||'').split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0,10);
}
function callRow(r){
  const forKey = r.missed || r.due;
  const late = !!r.missed;
  const when = late ? `<span class="pill p-over">${monthLabel(r.missed)} missed</span>` : `<span class="pill p-due">${monthLabel(r.due)} due</span>`;
  const both = r.missed && r.due ? ` <span class="small" style="color:var(--muted)">+ ${monthLabel(r.due)}</span>` : '';
  return `<tr>
    <td><b>${healthDot(r.client_id)}${clientLink(r.client, r.client_id)}</b></td>
    ${r.coach !== undefined && D.user.role !== 'coach' ? `<td class="small" style="white-space:nowrap">${esc(r.coach||'—')}</td>` : ''}
    <td style="white-space:nowrap">${when}${both}</td>
    <td class="mono small" style="white-space:nowrap">${r.last_call ? fmt(r.last_call) : '<span style="color:var(--muted)">never</span>'}</td>
    <td><div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:nowrap">
      <button class="btn tiny" onclick="openClientProfile(${r.client_id})">Open</button>
      <button class="btn tiny primary" onclick="logCallDlg(${r.client_id},'${esc(r.client).replace(/'/g,"\\'")}','${forKey}')">Log call</button>
    </div></td></tr>`;
}
function callsOwedPanel(t){
  const rows = t.callsOwed || [];
  const showCoach = D.user.role !== 'coach';
  if(!rows.length) return '';
  const missedN = rows.filter(r=>r.missed).length;
  return `<div class="panel" id="tdCalls"><h2>Coaching calls owed <span class="small" style="font-family:inherit;font-weight:400;letter-spacing:0;text-transform:none">(${rows.length})</span></h2>
    <p class="small" style="margin-bottom:8px">One call per client per month, visit or no visit. ${missedN ? `<b style="color:var(--bad)">${missedN}</b> month${missedN>1?'s':''} already closed without one.` : 'Nothing missed yet — these are this month\'s.'} Logging here counts toward that month's coverage strip on the client's page.</p>
    <div style="overflow-x:auto"><table style="width:100%"><tr><th>Client</th>${showCoach?'<th>Coach</th>':''}<th>For</th><th>Last call</th><th style="text-align:right"></th></tr>
    ${todayRows(rows, 12, callRow)}</table></div>
    ${(t.callsUnowned && t.callsUnowned.length) ? `<p class="small" style="margin-top:8px;color:var(--warn)">⚠ ${t.callsUnowned.length} active client${t.callsUnowned.length>1?'s':''} owe a call but have no assigned coach — nobody is being prompted for them. ${t.callsUnowned.slice(0,6).map(r=>clientLink(r.client, r.client_id)).join(', ')}${t.callsUnowned.length>6?' …':''}</p>` : ''}
  </div>`;
}
/* Quick-log straight from Today, so a coach clearing the panel never has to leave it.
 * The date defaults to the end of the month being logged — a call logged for a closed
 * month has to sit inside that month to count toward it. */
function logCallDlg(clientId, clientName, forKey){
  const dflt = forKey === TODAY.slice(0,7) ? TODAY : monthEndDate(forKey);
  openDlg(`<h3>Log coaching call</h3>
    <p class="small" style="color:var(--muted)">${esc(clientName)} · counts toward <b>${monthLabel(forKey)}</b></p>
    <label>Call date</label><input type="date" id="lcDate" value="${dflt}" style="width:160px">
    <label>What was covered ${micBtn('lcBody')}</label>
    <textarea id="lcBody" rows="3" style="width:100%;box-sizing:border-box" placeholder="Who you spoke with, what you covered, anything to follow up…"></textarea>
    <p class="small" style="color:var(--muted)">Open the client's page if you need to tag a specific store.</p>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveQuickCall(${clientId})">Log call</button></div>`);
}
async function saveQuickCall(clientId){
  const note_date = ($('#lcDate')||{}).value || TODAY;
  const body = (($('#lcBody')||{}).value || '').trim();
  if(!body){ uiAlert('Add a line about the call first'); return; }
  if(window._rec){ try{window._rec.stop()}catch(e){} window._rec=null; }
  try{
    await api('POST','/api/clients/'+clientId+'/notes', { note_date, note_type: 'Coaching Call', body });
    closeDlg(); toast('Call logged');
    if($('#todayOut')) await loadToday();
    if($('#monthEndOut')) await loadMonthEnd();
  }catch(e){ uiAlert(e.message || 'Could not log the call'); }
}
function todayCoachView(t){
  const me = D.user.coach_id;
  const full = v => D.visits.find(x=>x.id===v.id) || v;
  const daysLate = d => Math.max(0, Math.floor(dayDiff(TODAY, d)));
  const onCal = D.visits.filter(v=>v.cal_coach===me && !v.completed && v.cal_week && v.cal_week>=TODAY).length;
  let html='';

  // ---- At-a-glance strip
  const stat = (n, label, tone, onclick) => `<div class="card" style="border-top-color:${tone};${onclick?'cursor:pointer':''}" ${onclick?`onclick="${onclick}"`:''}>
    <div class="k" style="color:${n?tone:'var(--muted)'}">${n}</div><div class="l">${label}</div></div>`;
  html+=`<div class="cards" style="margin-bottom:14px">
    ${stat(t.overdueMine.length, 'Overdue', 'var(--bad)', "document.getElementById('tdOverdue')?.scrollIntoView({behavior:'smooth'})")}
    ${stat(t.dueSoonMine.length, 'Due in the next 30 days', 'var(--warn)', "document.getElementById('tdDueSoon')?.scrollIntoView({behavior:'smooth'})")}
    ${stat(t.missingNotes.length + (t.weekPassed||[]).length, 'Notes owed', '#1d4f91', "document.getElementById('tdNotes')?.scrollIntoView({behavior:'smooth'})")}
    ${stat((t.callsOwed||[]).length, 'Calls owed', (t.callsOwed||[]).some(r=>r.missed) ? 'var(--bad)' : 'var(--warn)', "document.getElementById('tdCalls')?.scrollIntoView({behavior:'smooth'})")}
    ${stat(onCal, 'On your calendar', 'var(--ok)', "go('board')")}
  </div>`;

  // ---- Next visit hero
  html+=`<div class="panel" style="border-left:5px solid var(--primary);display:flex;align-items:center;gap:20px;flex-wrap:wrap">`;
  if(t.nextVisit){
    const nv = t.nextVisit;
    html+=`<div style="min-width:120px"><div style="font-family:var(--head);font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:var(--muted)">Your next visit</div>
        <div style="font-family:var(--head);font-size:30px;font-weight:600;line-height:1.05;margin-top:2px">wk of ${fmtW(nv.cal_week)}</div></div>
      <div style="flex:1;min-width:220px"><div style="font-size:17px;font-weight:600">${clientLink(nv.client, nv.client_id)}</div>
        <div class="small" style="margin-top:2px">${esc(nv.cycle)} ${esc(nv.program)} · due ${fmt(nv.due)}</div></div>
      <div class="btnrow" style="margin:0">
        ${nv.client_id?`<button class="btn tiny" onclick="openClientProfile(${nv.client_id})">Profile &amp; notes</button>`:''}
        <button class="btn tiny primary" onclick="openVisitModal(${nv.id})">Complete it</button></div>`;
  } else {
    html+=`<div><div style="font-family:var(--head);font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:var(--muted)">Your next visit</div>
      <p class="small" style="margin-top:4px">Nothing on your calendar yet — <a onclick="go('board')" style="cursor:pointer"><b>open the Calendar</b></a> to place your upcoming visits.</p></div>`;
  }
  html+=`</div>`;

  // ---- Work lists: Client · Visit · Due · Status · actions (right-aligned, never wrap)
  const statusOf = v => {
    const f = full(v);
    if(f.completed) return completedPill(f);
    if(f.cal_week) return calendarPill(f);
    return unscheduledPill(f);
  };
  const actions = v => {
    const f = full(v);
    const can = canReschedule(f);
    return `<div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:nowrap">
      ${v.client_id?`<button class="btn tiny" onclick="openClientProfile(${v.client_id})">Open</button>`:''}
      ${!f.cal_week && can ? (placeBlockReason(f) ? `<button class="btn tiny" disabled title="${esc(placeBlockReason(f))}" style="opacity:.55;cursor:not-allowed">Place</button>` : `<button class="btn tiny" title="Pick a week on your calendar" onclick="${placeJump(f)}">Place</button>`) : ''}
      ${f.cal_week && !f.completed && can ? `<button class="btn tiny" style="color:var(--muted)" title="Take it off the calendar" onclick="unscheduleV(${v.id})">Unschedule</button>` : ''}
      ${!f.completed ? `<button class="btn tiny primary" onclick="openVisitModal(${v.id})">Complete</button>` : ''}
    </div>`;
  };
  const sec=(id,title,list,empty,late)=>{
    let h=`<div class="panel" id="${id}"><h2>${title}${list.length?` <span class="small" style="font-family:inherit;font-weight:400;letter-spacing:0;text-transform:none">(${list.length})</span>`:''}</h2>`;
    h+= list.length ? `<div style="overflow-x:auto"><table style="width:100%"><tr><th>Client</th><th>Visit</th><th>Due</th><th>Status</th><th style="text-align:right"></th></tr>`+
      todayRows(list, 10, v=>`<tr>
        <td><b>${healthDot(v.client_id)}${clientLink(v.client, v.client_id)}</b></td>
        <td class="small" style="white-space:nowrap">${esc(v.cycle||'')} ${esc(v.program||'')}</td>
        <td class="mono" style="white-space:nowrap">${fmt(v.due)}${late && v.due && v.due<TODAY ? ` <span class="small" style="color:var(--bad)">${daysLate(v.due)}d late</span>` : ''}</td>
        <td style="white-space:nowrap">${statusOf(v)}</td>
        <td style="white-space:nowrap">${actions(v)}</td></tr>`)+`</table></div>`
      : `<p class="small" style="color:var(--ok)">${empty}</p>`;
    return h+`</div>`;
  };
  html+=sec('tdOverdue', 'Overdue from you', t.overdueMine, 'Nothing overdue. ✔', true);
  html+=sec('tdDueSoon', 'Due from you in the next 30 days', t.dueSoonMine, 'Nothing due soon. ✔', false);
  // One list. To the coach these are the same chore — a visit that needs writing up — so
  // they sit together, newest first; the pill says which kind each row is. Both buttons
  // open the same visit modal, which already shows Complete for an open visit and
  // Save notes for a completed one.
  const owed = [
    ...(t.weekPassed||[]).map(v => ({ ...v, kind:'open', when: v.cal_week })),
    ...t.missingNotes.map(v => ({ ...v, kind:'done', when: v.scheduled_week||v.cal_week||v.due })),
  ].sort((a,b) => (b.when||'').localeCompare(a.when||''));
  if(owed.length){
    html+=`<div class="panel" id="tdNotes"><h2>You owe a note <span class="small" style="font-family:inherit;font-weight:400;letter-spacing:0;text-transform:none">(${owed.length})</span></h2>
    <p class="small" style="margin-bottom:8px">Visits with no write-up yet — either the scheduled week has passed and it isn't marked done, or it's marked done with no notes. The client's page can't show wins, issues or focus until you add them.</p>
    <div style="overflow-x:auto"><table style="width:100%"><tr><th>Client</th><th>Visit</th><th>When</th><th>Status</th><th style="text-align:right"></th></tr>`+
    owed.map(v=>`<tr><td><b>${healthDot(v.client_id)}${clientLink(v.client, v.client_id)}</b></td>
      <td class="small" style="white-space:nowrap">${esc(v.cycle||'')} ${esc(v.program||'')}</td>
      <td class="mono" style="white-space:nowrap">${v.kind==='open' ? `wk of ${fmtW(v.when)} <span class="small" style="color:var(--bad)">${daysLate(v.when)}d ago</span>` : fmt(v.when)}</td>
      <td style="white-space:nowrap">${v.kind==='open' ? `<span class="pill p-over" title="On your calendar for a week that has passed, not marked complete">Not marked done</span>` : `<span class="pill p-due" title="Marked complete, no notes">Completed, no notes</span>`}</td>
      <td><div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:nowrap">
        ${v.kind==='open' && canReschedule(full(v)) ? `<button class="btn tiny" title="Didn't happen — pick another week" onclick="${placeJump(full(v))}">Move</button>` : ''}
        <button class="btn tiny primary" onclick="openVisitModal(${v.id})">${v.kind==='open' ? 'Complete &amp; write up' : 'Add note'}</button></div></td></tr>`).join('')+`</table></div></div>`;
  }
  html += callsOwedPanel(t);
  return html;
}

const healthDot = cid => {
  const h = cid && D.clientHealth ? D.clientHealth[cid] : null;
  return h==='at_risk' ? '<span title="Client at risk — see their profile" style="color:var(--bad);font-size:11px">● </span>'
    : h==='behind' ? '<span title="Client behind — see their profile" style="color:var(--warn);font-size:11px">● </span>' : '';
};
/* ---------- schedule board ---------- */
function board(){
  const global = st.view==='global';
  const t=st.boardTeam, y=st.boardY, m=st.boardM;
  const weeks=mondaysInMonth(y,m);
  const formerCoachesView = st.view === 'formercoaches';
  
  // For coaches, only show their own row in board view, but show all team coaches in global view
  let members;
  if(D.user.role === 'coach'){
    if(global){
      // Global view: show all coaches on this coach's team
      members = D.coaches.filter(c=>c.active && c.team === D.user.team).sort((a,b)=>a.name.localeCompare(b.name));
    } else {
      // Board view: show only their own row
      members = D.coaches.filter(c=>c.id === D.user.coach_id);
    }
  } else {
    // Admin/lead/sales: existing logic
    members = formerCoachesView
      ? D.coaches.filter(c=>!c.active && myTeams().includes(c.team)).slice().sort((a,b)=>(a.team+'|'+a.name).localeCompare(b.team+'|'+b.name))
      : global
      ? D.coaches.filter(c=>c.active && myTeams().includes(c.team)).slice().sort((a,b)=>(a.team+'|'+a.name).localeCompare(b.team+'|'+b.name))
      : D.coaches.filter(c=>c.active && c.team===t);
  }
  
  const placing = st.placing ? D.visits.find(v=>v.id===st.placing) : null;
  // Calendar client search: matches a visit's client name (case-insensitive substring).
  // Drives both the cell glow on the grid below and the results rail on the right.
  const calQ = norm(st.calSearch||'');
  const calHit = v => calQ && norm(v.client).includes(calQ);

  /* to-schedule list: for coaches, show their team's unscheduled LIDs; for others, show team/global */
  const nextM = m===11?[y+1,0]:[y,m+1];
  const inMonth=(v,yy,mm)=>v.due&&+v.due.slice(0,4)===yy&&+v.due.slice(5,7)===mm+1;
  
  // For coaches, show their team's unscheduled visits
  // For admin/lead, show team or global unscheduled visits
  const cand = D.user.role === 'coach'
    ? D.visits.filter(v => !v.completed && !v.cal_week && v.team === D.user.team)
    : D.visits.filter(v=>!v.completed&&!v.cal_week&&(global?myTeams().includes(v.team):v.team===t));
  
  const overdue=cand.filter(v=>v.due&&v.due<TODAY&&!inMonth(v,y,m)).sort((a,b)=>a.due.localeCompare(b.due));
  const thisMo=cand.filter(v=>inMonth(v,y,m));
  const nextMo=cand.filter(v=>inMonth(v,nextM[0],nextM[1]));

  let html='';
  if(placing){
    html+=`<div class="placebanner">Placing <b>${clientLink(placing.client, placing.client_id)}</b> — ${esc(placing.cycle)} ${esc(placing.program)}, due ${fmt(placing.due)}.
      Click any open week — <b>including past weeks</b>, to backfill a visit that already happened. <button class="btn tiny" onclick="st.placing=null;paintBoard()">Cancel</button></div>`;
  }
  html+=`<div class="controls">
    ${calendarSwitcher()}
    <span style="flex:1"></span>
    <div class="calsearch">
      <input id="calSearchBox" placeholder="🔍 Search a client's visits…" autocomplete="off" value="${esc(st.calSearch||'')}"
        oninput="st.calSearch=this.value;paintBoard()"
        onkeydown="if(event.key==='Escape'){st.calSearch='';paintBoard()}">
      ${st.calSearch?`<button class="btn tiny" onclick="st.calSearch='';paintBoard()">clear ✕</button>`:''}
    </div>
    <div class="monthnav">
      <button class="btn" onclick="bMonth(-1)">‹</button>
      <span class="mlabel">${MONTHS[m]} ${y}</span>
      <button class="btn" onclick="bMonth(1)">›</button>
      <button class="btn tiny" onclick="st.boardY=${+TODAY.slice(0,4)};st.boardM=${+TODAY.slice(5,7)-1};paintBoard()">Today</button>
    </div></div>
  <div class="boardlayout"><div class="panel" style="margin:0">
  <table class="bgrid"><tr><th style="text-align:left">Coach</th>`;
  weeks.forEach(w=>{ const now=TODAY>=w&&dayDiff(TODAY,w)<7;
    html+=`<th class="${now?'wk-now':''}">wk of ${fmtW(w)}${now?' ●':''}</th>`; });
  html+=`</tr>`;
  for(const c of members){
    html+=`<tr><td class="cname">${esc(c.name)}${global?`<br><span class="small" style="color:var(--muted)">${esc(c.team)}</span>`:''}</td>`;
    for(const w of weeks){
      const o=occ[c.id+'|'+w]; const past=w<mondayOf(new Date());
      let cls='slot', inner='', click='';
      if(!o){
        cls+=' s-open'+(past?' s-past':'');
        // Placing: admin/lead can drop onto any open week on the board; a coach can drop a
        // visit they own onto their OWN row only (the server enforces the same rule).
        // Past weeks ARE editable: a visit that happened last week and never got its
        // card added gets backfilled here (then shows on the "confirm completed" to-do),
        // and a past open week can be set to a custom card — Home/Truck/Training/Off/etc.
        // — to fill in what a coach was actually doing that week.
        // Coaches can only manage their own weeks
        const coachCanManage = D.user.role === 'coach' ? c.id === D.user.coach_id : true;
        const canPlaceHere = placing && (canEdit() || (ownsVisit(placing) && c.id === D.user.coach_id));
        if(canPlaceHere){ cls+=' target'+(past?' target-past':''); inner=''; click=` onclick="placeHere('${c.id}','${w}')"`; }
        else if(canEditWeeks() && coachCanManage && !past) click=` onclick="cellDlg('${c.id}','${w}')"`;
      } else if(o.type==='visit'){
        const v=o.v; cls+= (v.completed?' s-done':' s-visit') + (calHit(v)?' cal-hl':'');
        inner=`<b>${v.completed?'':healthDot(v.client_id)}${clientLink(v.client, v.client_id)}</b><small>${esc(v.cycle)} ${esc(v.program)}${v.completed?' · done':''}</small>${v.store?`<small class="storetag">🏬 ${esc(v.store)}</small>`:''}`;
        // Viewing a visit's detail box is read-only by itself — Complete/Move/Unschedule
        // inside it are individually gated (see the detail box below), so anyone who can
        // see the board can click through to look, but only canEdit() (or the owning
        // coach, for Complete) sees anything actionable there.
        click=` onclick="st.detail=${v.id};st.placing=null;paintBoard()"`;
      } else {
        const kindCls = o.kind==='mag'?'s-mag' : (o.kind==='visit'||o.kind==='visit_legacy')?'s-legacy' : o.kind==='launch_open'?'s-launch_open' : o.kind==='soft_pencil'?'s-soft':'s-block';
        cls+=' '+kindCls+(past?' s-past':'');
        inner=`<b>${esc(o.label||BLOCKKINDS[o.kind]||o.kind)}</b><small>${o.kind==='visit'||o.kind==='visit_legacy'?'from sheet':esc(BLOCKKINDS[o.kind]||'')}</small>`;
        // Coaches can only manage their own weeks
        const coachCanManage = D.user.role === 'coach' ? c.id === D.user.coach_id : true;
        if(canEditWeeks() && coachCanManage) click=` onclick="cellDlg('${c.id}','${w}')"`;
      }
      html+=`<td><div class="${cls}"${click}>${inner}</div></td>`;
    }
    html+=`</tr>`;
  }
  html+=`</table>
  <div class="legend"><span><i style="background:var(--visit)"></i>Visit</span><span><i style="background:var(--done)"></i>Completed</span>
    <span><i style="background:var(--open);border:1px dashed var(--openb)"></i>Open</span><span><i style="background:var(--launch)"></i>Launch slot</span>
    <span><i style="background:#e2f0f0"></i>Mills</span><span><i style="background:var(--offc)"></i>Blocked (home/off/etc.)</span></div>
  <p class="small">${canEdit() ? 'Click a visit to manage it · ' : 'Click a visit to view it · '}click an open or blocked week to set Home/Off/Training/etc. ·
  <span style="color:var(--bad)">●</span> client at risk · <span style="color:var(--warn)">●</span> client behind — hover a dot for details, open the client's profile for the full story.</p>
  </div>`;

  /* side rail */
  html+=`<div class="sidebox">`;
  if(calQ) html += calSearchRail(calQ, global);
  if(st.detail){
    const v=D.visits.find(x=>x.id===st.detail);
    const dStores = v ? storeList(v) : [];
    if(v) html+=`<div class="detailbox"><b>${clientLink(v.client, v.client_id)}</b>
      ${esc(v.cycle)} ${esc(v.program)} · due ${fmt(v.due)}<br>
      <span class="small">wk of ${fmtW(v.cal_week)} — ${esc(coach(v.cal_coach)?.name||'')}</span>
      ${dStores.length ? `<div class="small" style="margin-top:6px">Store: ${canEdit()
        ? `<select onchange="setVisitStore(${v.id}, this.value)"><option value="">— none —</option>${dStores.map(s=>`<option value="${esc(s)}" ${v.store===s?'selected':''}>${esc(s)}</option>`).join('')}</select>`
        : `<b>${v.store?esc(v.store):'—'}</b>`}</div>` : (v.store?`<div class="small" style="margin-top:6px">Store: <b>${esc(v.store)}</b></div>`:'')}
      <div class="btnrow">
        ${(canEdit()||ownsVisit(v)) ? `<button class="btn tiny primary" onclick="openVisitModal(${v.id})">${v.completed?'Edit notes':'Complete'}</button>` : ''}
        ${canReschedule(v) ? `<button class="btn tiny" onclick="st.placing=${v.id};st.detail=null;paintBoard()">Move</button>` : ''}
        ${canReschedule(v) ? `<button class="btn tiny" onclick="unscheduleV(${v.id})">Unschedule</button>` : ''}
        <button class="btn tiny" onclick="st.detail=null;paintBoard()">Close</button>
      </div></div>`;
  }
  const section=(title,list)=>{
    if(!list.length) return '';
    let h=`<h2>${title} (${list.length})</h2>`;
    list.slice(0,40).forEach(v=>{
      h+=`<div class="duecard ${v.due&&v.due<TODAY?'over':''}"><b>${healthDot(v.client_id)}${clientLink(v.client, v.client_id)}</b>
        <div class="meta">${esc(v.cycle)} ${esc(v.program)} · due ${fmt(v.due)}</div>
        ${(canEdit()||ownsVisit(v)) ? (placeBlockReason(v) ? `<button class="btn tiny" disabled title="${esc(placeBlockReason(v))}" style="opacity:.55;cursor:not-allowed">Place on calendar</button><div class="small" style="color:var(--warn);margin-top:4px">⚠ ${esc(placeBlockReason(v))}</div>` : `<button class="btn tiny primary" onclick="st.placing=${v.id};st.detail=null;render()">Place on calendar</button>`) : ''}</div>`;
    });
    return h;
  };
  if(!calQ){
    html+=section('Overdue / carryover',overdue);
    html+=section(`Due ${MO[m]}`,thisMo);
    html+=section(`Coming up · ${MO[nextM[1]]}`,nextMo);
    if(!overdue.length&&!thisMo.length&&!nextMo.length) html+=`<h2>To schedule</h2><p class="small">Nothing waiting for ${global?'these teams':'Team '+t} in this window. 🎉</p>`;
  }
  html+=`</div></div>`;
  return html;
}
/* Results rail for the calendar client search. Lists every matching visit across the
 * last ~2 years + all future, chronological, color-coded by status; clicking one jumps
 * the board to that visit's month and (if it's placed on a coach's week) glows its cell. */
function calSearchRail(q, global){
  const cutoff = (()=>{ const d=new Date(TODAY+'T12:00:00'); d.setFullYear(d.getFullYear()-2); return d.toISOString().slice(0,10); })();
  const key = v => v.cal_week || v.due || '';
  const matches = D.visits.filter(v=>norm(v.client).includes(q) && key(v) && key(v) >= cutoff)
    .sort((a,b)=> key(a).localeCompare(key(b)) || (a.id-b.id));
  if(!matches.length) return `<h2>Visit search</h2><p class="small">No visits found for “${esc(st.calSearch)}” in the last 2 years.<br><a onclick="st.calSearch='';paintBoard()" style="cursor:pointer;color:var(--primary)">clear search</a></p>`;
  const names = [...new Set(matches.map(v=>v.client))];
  const placedOnGrid = matches.filter(v=>v.cal_week && v.cal_coach).length;
  let h=`<h2>Visit search (${matches.length})</h2>
    <p class="small" style="margin:-4px 0 8px">${names.length===1?esc(names[0]):names.length+' clients'} · ${placedOnGrid} on the calendar · click one to jump to its month.</p>`;
  for(const v of matches){
    const s=status(v);
    const label = s==='completed'?'Completed' : s==='on_calendar'?'On calendar' : s==='overdue'?'Overdue — no plan' : s==='needs_scheduling'?'To schedule':'—';
    const dk=key(v);
    const mo = dk?`${MO[+dk.slice(5,7)-1]} ${dk.slice(0,4)}`:'—';
    const co = v.cal_coach?(coach(v.cal_coach)?.name||''):'';
    const wk = v.cal_week?`wk of ${fmtW(v.cal_week)}` : v.due?`due ${fmt(v.due)}`:'';
    h+=`<div class="rescard rs-${s}" onclick="calSearchJump(${v.id})" title="Jump to ${esc(mo)}">
      <div class="resmo">${mo}<span class="reslabel">${label}</span></div>
      ${names.length>1?`<b>${clientLink(v.client, v.client_id)}</b>`:''}
      <div class="meta">${esc(v.cycle)} ${esc(v.program)}${v.store?` · 🏬 ${esc(v.store)}`:''}</div>
      <div class="meta">${wk}${co?' · '+esc(co):''}${global&&v.team?' · '+esc(v.team):''}</div>
    </div>`;
  }
  return h;
}
/* Jump the board to a searched visit's month. Keeps the current view mode (stays on
 * the Global Calendar if that's where you searched, otherwise switches to the visit's
 * team board), and leaves st.calSearch set so the cell keeps glowing after the jump. */
function calSearchJump(id){
  const v=D.visits.find(x=>x.id===id); if(!v) return;
  const anchor = v.cal_week || v.due;
  if(anchor){ st.boardY=+anchor.slice(0,4); st.boardM=+anchor.slice(5,7)-1; }
  if(st.view!=='global'){ st.view='board'; if(v.team) st.boardTeam=v.team; }
  st.detail = (v.cal_week && v.cal_coach) ? v.id : null;
  st.placing=null; render();
}
/* One switcher for every calendar-shaped view, so the current view is always visible
 * and the options read as choices, not as commands. Coaches (one team): My calendar ·
 * Team <name> · List. Admin/lead/sales: one segment per team · All teams · Former
 * coaches, plus List when the user is linked to a coach. */
function calendarSwitcher(){
  const v = st.view, teams = myTeams(), single = D.user.role === 'coach' && teams.length === 1;
  const go = (view, extra='') => `st.view='${view}';st.placing=null;${extra}render()`;
  const b = (label, on, onclick, title='') => `<button class="${on?'on':''}" ${on?'':`onclick="${onclick}"`} ${title?`title="${esc(title)}"`:''}>${label}</button>`;
  let h = `<div class="seg">`;
  if(single){
    h += b('My calendar', v==='board', go('board'), 'Just your row, week by week');
    h += b(`Team ${esc(teams[0])}`, v==='global', go('global'), `Everyone on team ${teams[0]}`);
  } else {
    if(teams.length > 1) h += `<span class="segl">Team</span>`;
    for(const t of teams) h += b(esc(t), v==='board' && st.boardTeam===t, go('board', `st.boardTeam='${t}';`), `Team ${t}'s calendar`);
    if(teams.length > 1) h += b('All teams', v==='global', go('global'), 'Every team on one board');
    if(canEditWeeks() && D.user.role !== 'coach') h += b('Former coaches', v==='formercoaches', go('formercoaches'));
  }
  if(D.user.coach_id) h += b('☰ List', v==='mysched', go('mysched'), 'Your next 16 weeks as a list');
  return h + `</div>`;
}
/* Repaint only #main for calendar interactions (month paging, Today, the visit-search
 * box, opening/closing a visit bubble). A full render() replaces app.innerHTML, which
 * tears down and rebuilds the header — nav, global search box, user chip — on every
 * click. Password managers (1Password especially) read a wholesale rebuild of the page
 * chrome as a page transition and re-surface their "Save login?" prompt; paging months
 * a few times is enough to get it popping up over and over. Nothing outside #main
 * depends on which month is showing, so nothing outside #main gets rebuilt. */
const CAL_MAIN_VIEWS = ['board','global','formercoaches','mysched'];
function paintBoard(){
  const m = $('#main');
  if(!m || !CAL_MAIN_VIEWS.includes(st.view)){ render(); return; }
  const el = document.getElementById('calSearchBox');
  const selStart = el && typeof el.selectionStart === 'number' ? el.selectionStart : null;
  const selEnd = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : null;
  m.innerHTML = st.view==='mysched' ? mySchedule() : board();
  const el2 = document.getElementById('calSearchBox');
  if(el2 && el){
    el2.focus();
    if(selStart != null && typeof el2.setSelectionRange === 'function'){
      try{ el2.setSelectionRange(selStart, selEnd); }catch(e){}
    }
  }
}
function bMonth(d){ st.boardM+=d; if(st.boardM>11){st.boardM=0;st.boardY++;} if(st.boardM<0){st.boardM=11;st.boardY--;} st.detail=null; paintBoard(); }
async function placeHere(cid,w,force){
  const id=st.placing; if(!id) return;
  try{
    await api('POST',`/api/visits/${id}/place`,{coach:cid,week:w,force:!!force,reason:force?'admin override from calendar':undefined});
  }catch(e){
    const b = e.body || {};
    if(b.code==='out_of_order'){
      if(b.canOverride){
        if(await uiConfirm(`Out of order — ${b.problem.message}\n\nPlace it here anyway? This is logged as an admin override.`,'Place anyway')) return placeHere(cid,w,true);
      } else {
        uiAlert(`Out of order — ${b.problem.message}`);
      }
      return;
    }
    return;
  }
  st.placing=null;
  await refresh();
  toast(`Scheduled → ${coach(cid).name}, wk of ${fmtW(w)}`, async()=>api('POST',`/api/visits/${id}/unschedule`));
}
async function unscheduleV(id){
  const v=D.visits.find(x=>x.id===id); if(!v) return; const old={coach:v.cal_coach,week:v.cal_week};
  if(!(await uiConfirm(`Take ${v.client} — ${v.cycle} ${v.program} off the calendar (week of ${fmtW(v.cal_week)})? It goes back to "needs scheduling" and can be placed again.`,'Unschedule'))) return;
  await api('POST',`/api/visits/${id}/unschedule`); st.detail=null; await refresh();
  toast('Unscheduled — back in the to-schedule list', async()=>api('POST',`/api/visits/${id}/place`,old));
}
async function setVisitStore(id, store){
  try{ await api('PATCH',`/api/visits/${id}`,{ store }); }
  catch(e){ uiAlert(e.message||'Could not set store'); return; }
  await refresh();
  toast(store ? `Store set → ${store}` : 'Store cleared');
}
function storeList(v){ try{ const a=JSON.parse((v&&v.contract_stores)||'[]'); return Array.isArray(a)?a:[]; }catch(_){ return []; } }
const SPEECH_OK = ('webkitSpeechRecognition' in window) || ('SpeechRecognition' in window);
function micBtn(targetId){
  return SPEECH_OK ? `<button type="button" class="micbtn" id="mic_${targetId}" title="Dictate" onclick="dictate('${targetId}')">🎤</button>` : '';
}
function dictate(targetId){
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition; if(!Ctor) return;
  const btn=$('#mic_'+targetId), field=$('#'+targetId);
  if(window._rec){ try{ window._rec.stop(); }catch(e){} window._rec=null; if(btn) btn.classList.remove('rec'); return; }
  const rec=new Ctor(); rec.continuous=true; rec.interimResults=false; rec.lang='en-US';
  window._rec=rec; if(btn) btn.classList.add('rec');
  rec.onresult=e=>{ let t=''; for(let i=e.resultIndex;i<e.results.length;i++) t+=e.results[i][0].transcript; if(field){ field.value=(field.value?field.value.trim()+' ':'')+t.trim(); } };
  rec.onerror=()=>{ if(btn) btn.classList.remove('rec'); window._rec=null; };
  rec.onend=()=>{ if(btn) btn.classList.remove('rec'); window._rec=null; };
  try{ rec.start(); }catch(e){}
}
function cellDlg(cid,w){
  if(st.view === 'formercoaches'){
    const o=occ[cid+'|'+w];
    if(o){
      const label = o.type==='visit' ? `${o.v.client} - ${o.v.cycle} ${o.v.program}` : (o.label||BLOCKKINDS[o.kind]||o.kind);
      openDlg(`<h3>Remove from ${esc(coach(cid).name)} — week of ${fmt(w)}</h3>
        <p>Delete <b>${esc(label)}</b>?</p>
        <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
        <button class="btn danger" onclick="deleteBlock('${cid}','${w}')">Delete</button></div>`);
      return;
    }
    const completedVisits = D.visits.filter(v => v.completed && v.cal_coach === cid).sort((a,b) => (b.completed || '').localeCompare(a.completed || ''));
    if(!completedVisits.length){
      openDlg(`<h3>${esc(coach(cid).name)} — week of ${fmt(w)}</h3>
        <p>No completed visits to place.</p>
        <div class="dlgrow"><button class="btn" onclick="closeDlg()">Close</button></div>`);
      return;
    }
    const opts = completedVisits.map(v => `<option value="${v.id}">${esc(v.client)} (${esc(v.program)}) - ${esc(v.cycle)}</option>`).join('');
    openDlg(`<h3>Place past visit for ${esc(coach(cid).name)} — week of ${fmt(w)}</h3>
      <label>Select completed visit</label><select id="pastVisitId">${opts}</select>
      <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
      <button class="btn primary" onclick="savePastVisitPlacement('${cid}','${w}')">Place visit</button></div>`);
    return;
  }
  const o=occ[cid+'|'+w]; const cur=o&&o.type==='block'?o.kind:'open';
  const opts=[['open','Open (available)'],...Object.entries(BLOCKKINDS).filter(([k])=>!['visit','visit_legacy'].includes(k))]
    .map(([k,l])=>`<option value="${k}" ${cur===k?'selected':''}>${l}</option>`).join('');
  openDlg(`<h3>${esc(coach(cid).name)} — week of ${fmt(w)}</h3>
    <label>Week type</label><select id="ctKind">${opts}</select>
    <label>Label (optional)</label><input id="ctLabel" value="${esc(o&&o.type==='block'?o.label:'')}">
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveCell('${cid}','${w}')">Save</button></div>`);
}
async function savePastVisitPlacement(cid,w){
  const visitId = $('#pastVisitId').value;
  if(!visitId) return;
  await api('POST','/api/place-past-visit',{visit_id:parseInt(visitId),coach_id:cid,week:w});
  closeDlg(); await refresh();
}
async function saveCell(cid,w){
  await api('PUT','/api/blocks',{coach:cid,week:w,kind:$('#ctKind').value,label:$('#ctLabel').value.trim()});
  closeDlg(); await refresh();
}
async function deleteBlock(cid,w){
  await api('PUT','/api/blocks',{coach:cid,week:w,kind:'open',label:''});
  closeDlg(); await refresh();
}
/* Inventory column definitions */
const hint = t => `<span title="${esc(t)}" style="cursor:help;color:var(--muted);border-bottom:1px dotted var(--muted)">?</span>`;
const INV_COLS = [
  { key:'client', label:'Client', get:v=>v.client||'' },
  { key:'team', label:'Team', get:v=>v.team||'' },
  { key:'coach', label:'Assigned Coach', get:v=>v.cal_coach ? (coach(v.cal_coach)?.name || '') : '' },
  { key:'program', label:'Program '+hint('How often this client gets visited — Quarterly means 4 visits per year, Semi-Monthly means 6, etc.'), get:v=>v.program||'' },
  { key:'cycle', label:'Cycle '+hint('Which visit this is within the contract — "3 of 4" means the 3rd of 4 contracted visits.'), get:v=>v.cycle||'' },
  { key:'store', label:'Store '+hint('For a shared / multi-store contract, which store this visit covered. Blank for ordinary single-store visits.'), get:v=>v.store||'' },
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
  const MONTH_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0,10);
  const isOrphaned = v => !v.completed && v.cal_coach === null && v.due >= MONTH_AGO;
  const isCompletedOrphaned = v => v.completed && v.cal_coach === null;
  const stf={
    attention:v=>!v.completed&&!isStale(v),
    active:v=>!v.completed,
    overdue:v=>status(v)==='overdue'&&!isStale(v),
    stale:v=>isStale(v),
    needs:v=>status(v)==='needs_scheduling',
    oncal:v=>status(v)==='on_calendar',
    completed:v=>!!v.completed,
    orphaned:v=>isOrphaned(v),
    completed_orphaned:v=>isCompletedOrphaned(v),
    all:()=>true};
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
      <option value="orphaned" ${f==='orphaned'?'selected':''}>Orphaned (incomplete, no coach) — ${count(stf.orphaned)}</option>
      <option value="completed_orphaned" ${f==='completed_orphaned'?'selected':''}>Data quality (completed, no coach) — ${count(stf.completed_orphaned)}</option>
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
      <button class="btn tiny" onclick="bulkAssignCoachDlg()">Assign to coach</button>
      <button class="btn tiny" onclick="bulkAssignLeadDlg()">Assign to lead</button>
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
      :s==='overdue'?unscheduledPill(v, od>=30?` · ${od}d`:'')
      :s==='on_calendar'?calendarPill(v)
      :s==='needs_scheduling'?unscheduledPill(v):'<span class="pill p-fut">—</span>';
    // Row styling for orphaned visits
    let rowBg = '';
    if(isOrphaned(v)){
      if(v.due < TODAY) rowBg = 'background:#ffebee'; // red for overdue orphaned
      else if(v.due < new Date(new Date().setMonth(new Date().getMonth()+1)).toISOString().slice(0,7)+'-01') rowBg = 'background:#fff3e0'; // amber for this month
    } else if(isCompletedOrphaned(v)){
      rowBg = 'background:#f0f4f8;opacity:0.85'; // muted blue-gray for data quality issue
    }
    html+=`<tr style="cursor:pointer${rowBg?';'+rowBg:''}" onclick="openVisitModal(${v.id})">
      ${showChecks?`<td onclick="event.stopPropagation()"><input type="checkbox" ${sel.has(v.id)?'checked':''} onclick="toggleInvSel(${v.id},this.checked)"></td>`:''}
      ${INV_COLS.map(c=>{
        let cellData = '';
        if(c.key === 'client') cellData = '<b>'+clientLink(v.client, v.client_id)+'</b>';
        else if(c.key === 'scheduled') cellData = `<small>${sched}</small>`;
        else if(c.key === 'status') cellData = pill;
        else cellData = esc(c.get(v)||'');
        const cellClass = (c.key==='due'||c.key==='cycle')?'mono':'';
        return `<td class="${cellClass}">${cellData}</td>`;
      }).join('')}
      <td class="small" style="color:var(--muted)">Open ›</td></tr>`;
  });
  if(rows.length>400) html+=`<tr><td colspan="${INV_COLS.length + 1 + (showChecks?1:0)}" class="small">…first 400 of ${rows.length}</td></tr>`;
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
async function reopenVisit(id){
  const v = D.visits.find(x=>x.id===id);
  const who = v ? `${v.client} — ${v.cycle} ${v.program}` : 'this visit';
  if(!(await uiConfirm(`Mark ${who} as INCOMPLETE? It goes back to active status and can be completed again. Any notes logged on it are kept.`,'Mark incomplete'))) return;
  await api('POST',`/api/visits/${id}/reopen`); await refresh(); toast('Marked incomplete — the visit is active again');
}
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
function bulkAssignCoachDlg(){
  const ids=[...st.invSel];
  const assignable = D.coaches.filter(c => c.active).sort((a,b) => (a.team+'|'+a.name).localeCompare(b.team+'|'+b.name));
  const opts = assignable.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  openDlg(`<h3>Assign ${ids.length} visit(s) to team lead</h3>
    <label>Select coach or team lead</label>
    <select id="bulkCoachId">${opts}</select>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="bulkAssignCoach()">Assign</button></div>`);
}
async function bulkAssignCoach(){
  const coachId = $('#bulkCoachId').value;
  const ids = [...st.invSel];
  if(!coachId || !ids.length) return;
  let ok = 0;
  for(const id of ids){
    try{ const c = coach(coachId); await api('PATCH', `/api/visits/${id}`, {team: c.team}); ok++; }catch(e){ console.error(e); }
  }
  closeDlg(); st.invSel = new Set(); await refresh(); toast(`${ok} of ${ids.length} assigned`);
}
function bulkAssignLeadDlg(){
  const ids=[...st.invSel];
  const assignable = D.coaches.filter(c => c.active && c.is_lead).sort((a,b) => (a.team+"|"+a.name).localeCompare(b.team+"|"+b.name));
  const opts = assignable.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  openDlg(`<h3>Assign ${ids.length} visit(s) to lead</h3>
    <label>Select lead</label><select id="bulkLeadId">${opts}</select>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="bulkAssignLead()">Assign</button></div>`);
}
async function bulkAssignLead(){
  const leadId = $("#bulkLeadId").value;
  const ids = [...st.invSel];
  if(!leadId || !ids.length) return;
  let ok = 0;
  for(const id of ids){
    try{ const c = coach(leadId); await api("PATCH", `/api/visits/${id}`, {team: c.team}); ok++; }catch(e){ console.error(e); }
  }
  closeDlg(); st.invSel = new Set(); await refresh(); toast(`${ok} of ${ids.length} assigned to lead`);
}
/* First pay date, not first visit due date — new clients' first visit isn't due
 * until 90 days after they were actually first charged, so this collects the real
 * charge date and shows the computed due date as a preview; the server (not this
 * client-side math) is the one that actually applies the +90 days when saving. */
function addDaysClient(iso, days){
  const d = new Date(iso+'T12:00:00'); d.setDate(d.getDate()+days);
  return d.toISOString().slice(0,10);
}
function contractDlg(){
  openDlg(`<h3>New contract</h3>
    <label>Client / dealership</label><input id="cName" list="cl"><datalist id="cl">${clientNames().map(n=>`<option value="${esc(n)}">`).join('')}</datalist>
    <label>Program</label><select id="cProg" onchange="onContractProgramChange()">${progOpts('Quarterly')}</select>
    <div id="cVisitFields">
      <label>Number of visits</label><input type="number" id="cN" value="4" min="1" max="24">
      <label>First pay date</label><input type="date" id="cFirstPay" value="${TODAY}" onchange="onFirstPayDateChange()" oninput="onFirstPayDateChange()">
      <p class="small" id="cFirstPayPreview" style="color:var(--muted)"></p>
      <label>Team</label><select id="cTeam">${teamOpts(D.user.team)}</select>
      <label>Stores covered <span style="color:var(--muted);font-weight:400">(optional — one per line)</span></label>
      <textarea id="cStores" rows="3" placeholder="Only for a shared / à-la-carte contract that covers multiple stores — e.g.&#10;Steven Honda&#10;Steven Hyundai&#10;Steven Ford&#10;&#10;Leave blank for a normal single-store contract."></textarea>
      <p class="small" style="color:var(--muted)">If set, each visit can be tagged with which of these stores it covered. This stays in the app only — it never changes Keap.</p>
    </div>
    <div id="cCoachFields" style="display:none">
      <label>Assigned coach</label><select id="cCoach">${coachOptsFor()}</select>
      <p class="small">Coaching Only — remote coaching, no LID visits will be scheduled.</p>
    </div>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveContract()">Create</button></div>`);
  onContractProgramChange();
  onFirstPayDateChange();
}
function onContractProgramChange(){
  const prog = $('#cProg').value;
  const isCoachingOnly = prog === 'Coaching Only';
  $('#cN').value = CYCLE_LEN[prog] || 4;
  $('#cVisitFields').style.display = isCoachingOnly ? 'none' : '';
  $('#cCoachFields').style.display = isCoachingOnly ? '' : 'none';
}
function onFirstPayDateChange(){
  const v = $('#cFirstPay').value;
  const el = $('#cFirstPayPreview');
  if(!el) return;
  el.textContent = v ? `First visit due: ${fmt(addDaysClient(v,90))} (90 days later)` : '';
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
  const firstPayDate = $('#cFirstPay').value;
  if(!firstPayDate){ uiAlert('First pay date required'); return; }
  const stores = (($('#cStores')||{}).value || '').split('\n').map(s=>s.trim()).filter(Boolean);
  const b={client,program,n:+$('#cN').value,firstPayDate,team:$('#cTeam').value};
  if(stores.length) b.stores = stores;
  const r = await api('POST','/api/contracts',b); closeDlg(); await refresh();
  toast(`${b.client}: ${b.n} ${b.program} visits added — first due ${fmt(r.firstVisitDue)}`);
}
function visitDlg(id){
  const v=D.visits.find(x=>x.id===id)||{client:'',program:'Quarterly',cycle:'1 of 1',due:TODAY,team:D.user.team||D.teams[0]};
  const actions = id ? (v.completed && isAdmin() ? `<button class="btn tiny" onclick="closeDlg();reopenVisit(${id})">Mark incomplete</button>` : '') + `<button class="btn tiny danger" onclick="closeDlg();delVisit(${id})">Delete visit</button>` : '';
  openDlg(`<h3>${id?'Edit visit':'Add single visit'}</h3>
    <label>Client</label><input id="vName" value="${esc(v.client)}" list="cl"><datalist id="cl">${clientNames().map(n=>`<option value="${esc(n)}">`).join('')}</datalist>
    <label>Program</label><select id="vProg">${progOpts(v.program)}</select>
    <label>Cycle label</label><input id="vCycle" value="${esc(v.cycle)}">
    <label>Due date</label><input type="date" id="vDue" value="${v.due||TODAY}">
    <label>Team</label><select id="vTeam">${teamOpts(v.team)}</select>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveVisit(${id||0})">Save</button>${actions}</div>`);
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
  const msg = v.completed ? `This visit is marked COMPLETED — deleting erases it from the client's history and completed count. To keep it but undo the completion, use 'Mark incomplete' instead.\n\nDelete ${v.client} — ${v.cycle} ${v.program}?` : `Delete ${v.client} — ${v.cycle} ${v.program}?`;
  if(!(await uiConfirm(msg,'Delete'))) return;
  await api('DELETE','/api/visits/'+id); await refresh(); toast('Deleted');
}

/* ---------- availability ---------- */
function availabilityView(){
  return `<div class="panel"><h2>Sales availability</h2>
  <p class="small" style="margin-bottom:12px">Can we take a new client, and when could they start? Finds coaches with enough open weeks to absorb the full visit cadence, after all existing commitments.</p>
  <div class="controls">
    <label>Program</label><select id="aProg">${PROGRAMS.map(p=>`<option ${p==='Quarterly'?'selected':''}>${p}</option>`).join('')}</select>
    <label>Preferred Coach</label><select id="aCoach"><option value="">Any coach</option>${D.coaches.filter(c=>c.active && c.is_launch_certified).map(c=>`<option value="${c.id}">${esc(c.name)} (${c.team})</option>`).join('')}</select>
    <label>Preferred Handoff Coach</label><select id="aHandoffCoach"><option value="">Any coach</option>${D.coaches.filter(c=>c.active && (c.is_launch_certified || c.is_handoff_capable)).map(c=>`<option value="${c.id}">${esc(c.name)} (${c.team})</option>`).join('')}</select>
    <label>Team</label><select id="aTeam"><option>Any</option>${D.teams.map(t=>`<option>${t}</option>`).join('')}</select>
    <label>Start no earlier than</label><input type="date" id="aFrom" value="${TODAY}">
    <label class="small" style="display:flex;align-items:center;gap:5px;text-transform:none;letter-spacing:0">
      <input type="checkbox" id="aFar" style="width:auto" ${st.due2027?'checked':''}> include unplanned months (2027+)</label>
    <label>Handoff strategy</label><select id="aHandoffMode">
      <option value="0" ${st.handoffMode===0?'selected':''}>No handoff — preferred coach for all months</option>
      <option value="1" ${st.handoffMode===1?'selected':''}>Handoff after month 1 — let other coaches take over</option>
      <option value="2" ${st.handoffMode===2?'selected':''}>Handoff after month 2 — preferred coach launches, then hands off</option>
      <option value="3" ${st.handoffMode===3?'selected':''}>Handoff after month 3 — preferred coach does full cadence</option>
    </select>
    <button class="btn primary" onclick="runAvail()">Check availability</button>
  </div><div id="aOut"></div></div>
  <div class="panel"><h2>Open capacity by month</h2><div id="capOut"></div></div>
  <div class="panel"><h2>Active soft-pencil holds</h2>
  <p class="small" style="margin-bottom:8px">Tentative launch-date placeholders — reserve a coach's calendar for a prospect before the contract's signed, so nobody double-books that window. Release a hold to free those weeks back up.</p>
  <div id="softHoldsOut"></div></div>`;
}
function runAvail(){
  $('#aOut').innerHTML=''; // Clear stale results before computing
  const prog=$('#aProg').value,team=$('#aTeam').value,from=$('#aFrom').value||TODAY;
  const preferredCoachId = $('#aCoach').value;
  const preferredHandoffCoachId = $('#aHandoffCoach').value;
  st.due2027=$('#aFar').checked;
  st.handoffMode=parseInt($('#aHandoffMode').value);
  const lastPlanned = D.blocks.reduce((a,b)=>b.week>a?b.week:a,'2026-12-28');
  const horizon = st.due2027 ? addDays(TODAY,420) : lastPlanned;
  const interval=INTERVAL[prog],nVisits=CYCLE_LEN[prog];
  const results=[];
  // In handoff mode, allow Handoff-Capable coaches for follow-up visits
  const launchCoachFilter = c => {
    if(!c.active) return false;
    if(c.is_advisor_only) return false;
    if(!c.is_launch_certified) return false;
    if(team !== 'Any' && c.team !== team) return false;
    return true;
  };
  const followupCoachFilter = c => {
    if(!c.active) return false;
    if(c.is_advisor_only) return false;
    if(st.handoffMode > 0) {
      // In handoff mode, allow Launch Certified OR Handoff-Capable
      return c.is_launch_certified || c.is_handoff_capable;
    } else {
      // Normal mode: only Launch Certified
      return c.is_launch_certified;
    }
  };
  // If preferred coach is specified with handoff mode, find partial cadence matches
  if(preferredCoachId && st.handoffMode > 0){
    const prefCoach = coach(preferredCoachId);
    if(prefCoach && launchCoachFilter(prefCoach)){
      const prefOpen = mondaysRange(from<TODAY?TODAY:from,horizon).filter(w=>isAvailable(prefCoach.id,w));
      for(const start of prefOpen){
        const coachAssignments = {[0]: prefCoach.id}; // Visit 1 = preferred coach
        const used = new Set([start]);
        const seq = [start];
        let partialOk = true;
        for(let k=1;k<nVisits;k++){
          const target=new Date(start+'T12:00:00');target.setMonth(target.getMonth()+k*interval);
          if(target>new Date(horizon+'T12:00:00')) break;
          const tIso=target.toISOString().slice(0,10);
          let cand = null;
          let candCoach = null;
          
          // If k < st.handoffMode, preferred coach MUST handle this visit
          if(k < st.handoffMode) {
            const prefCandidates = prefOpen.filter(w=>!used.has(w)&&Math.abs(dayDiff(w,tIso))<=14);
            if(prefCandidates.length) {
              cand = prefCandidates.sort((a,b)=>Math.abs(dayDiff(a,tIso))-Math.abs(dayDiff(b,tIso)))[0];
              candCoach = prefCoach.id;
            }
          } else {
            // Visit k >= st.handoffMode: allow any available coach (respecting team filter)
            let allFollowupCoaches = D.coaches.filter(c => followupCoachFilter(c) && (team === 'Any' || c.team === team));
            // If a specific handoff coach is preferred, only use that one
            if(preferredHandoffCoachId){
              allFollowupCoaches = allFollowupCoaches.filter(c => c.id === preferredHandoffCoachId);
            }
            for(const coach of allFollowupCoaches){
              const coachOpen=mondaysRange(from<TODAY?TODAY:from,horizon).filter(w=>isAvailable(coach.id,w));
              const candidate=coachOpen.filter(w=>!used.has(w)&&Math.abs(dayDiff(w,tIso))<=14)
                .sort((a,b)=>Math.abs(dayDiff(a,tIso))-Math.abs(dayDiff(b,tIso)))[0];
              if(candidate){cand=candidate;candCoach=coach.id;break;}
            }
          }
          if(!cand){partialOk=false;break;}
          coachAssignments[k] = candCoach;
          used.add(cand);seq.push(cand);
        }
        if(partialOk && seq.length === nVisits) {
          // Validate we got ALL visits, not a partial cadence cut off by horizon
          // Count spare weeks only in the 12-month window around the plan, not entire horizon
          // In handoff mode, only count spare weeks for the primary coach's visits
          const prefCoachVisitCount = Object.values(coachAssignments)
            .filter(cid => cid === prefCoach.id).length;
          const windowEnd = addDays(start, 365);
          const spareInWindow = prefOpen.filter(w => w >= start && w <= windowEnd).length - prefCoachVisitCount;
          results.push({coach:prefCoach,plan:{start,seq},spare:spareInWindow,coachAssignments});
        }
      }
    }
  } else {
    // Standard logic: no preferred coach or handoff mode off
    for(const c of D.coaches.filter(launchCoachFilter)){
      const open=mondaysRange(from<TODAY?TODAY:from,horizon).filter(w=>isAvailable(c.id,w));
      if(!open.length) continue;
      let plan=null;
      let coachAssignments={};  // Declare outside loop so it persists
      for(const start of open){
        const used=new Set([start]);const seq=[start];let ok=true;
        coachAssignments={};  // Reset for each candidate start date
        coachAssignments[0]=c.id;   // Visit 0 is primary coach
        for(let k=1;k<nVisits;k++){
          const target=new Date(start+'T12:00:00');target.setMonth(target.getMonth()+k*interval);
          if(target>new Date(horizon+'T12:00:00')) break;
          const tIso=target.toISOString().slice(0,10);
          let cand=null;
          let coachId=c.id;  // Default to primary coach
          // If handoffMode > 0 and k >= handoffMode, allow any available coach to take over
          if(st.handoffMode > 0 && k >= st.handoffMode){
            let allFollowupCoaches = D.coaches.filter(c => followupCoachFilter(c) && (team === 'Any' || c.team === team));
            // If a specific handoff coach is preferred, only use that one
            if(preferredHandoffCoachId){
              allFollowupCoaches = allFollowupCoaches.filter(c => c.id === preferredHandoffCoachId);
            }
            for(const coach of allFollowupCoaches){
              const coachOpen=mondaysRange(from<TODAY?TODAY:from,horizon).filter(w=>isAvailable(coach.id,w));
              const candidate=coachOpen.filter(w=>!used.has(w)&&Math.abs(dayDiff(w,tIso))<=14)
                .sort((a,b)=>Math.abs(dayDiff(a,tIso))-Math.abs(dayDiff(b,tIso)))[0];
              if(candidate){cand=candidate;coachId=coach.id;break;}
            }
          } else {
            // Primary coach must handle all visits (or until handoff threshold)
            cand=open.filter(w=>!used.has(w)&&Math.abs(dayDiff(w,tIso))<=14)
              .sort((a,b)=>Math.abs(dayDiff(a,tIso))-Math.abs(dayDiff(b,tIso)))[0];
          }
          if(!cand){ok=false;break;}
          coachAssignments[k]=coachId;  // Record which coach handles this visit
          used.add(cand);seq.push(cand);
        }
        if(ok){plan={start,seq};break;}
      }
      if(plan && plan.seq.length === nVisits) {
        // Validate we got ALL visits, not a partial cadence cut off by horizon
        // Count spare weeks only in the 12-month window around the plan, not entire horizon
        const windowEnd = addDays(plan.start, 365);
        const spareInWindow = open.filter(w => w >= plan.start && w <= windowEnd).length - plan.seq.length;
        // In standard mode, check if there are multiple coaches (handoff occurred)
        const uniqueCoaches = new Set(Object.values(coachAssignments));
        results.push({coach:c,plan,spare:spareInWindow,coachAssignments:uniqueCoaches.size > 1 ? coachAssignments : undefined});
      }
    }
  }
  results.sort((a,b)=>{
    const aIsLaunch = a.coach.is_launch_certified ? 0 : 1;
    const bIsLaunch = b.coach.is_launch_certified ? 0 : 1;
    if(aIsLaunch !== bIsLaunch) return aIsLaunch - bIsLaunch;
    return a.plan.start.localeCompare(b.plan.start);
  });
  st.availResults = results; st.availProg = prog;
  let html='';
  if(!results.length){
    html=`<p style="color:var(--bad);font-weight:600">No coach can absorb a full ${prog} cadence before ${fmt(horizon)}${team!=='Any'?` on Team ${team}`:''}.</p>`;
  }else{
    html=`<p style="margin:8px 0"><b style="color:var(--ok)">Yes — ${results.length} coach${results.length>1?'es':''} can take a new ${prog} client.</b>
    Earliest start: <b>week of ${fmt(results[0].plan.start)}</b> with ${esc(results[0].coach.name)} (Team ${results[0].coach.team}).</p>
    <table><tr><th>Primary Coach</th><th>Team</th><th>Earliest start</th><th>Projected visits</th><th class="num">Spare weeks</th><th></th></tr>`;
    results.slice(0,12).forEach((r,i)=>{
      let coachInfo = `<b>${esc(r.coach.name)}</b>`;
      if(r.coachAssignments){
        const uniqueCoaches = new Set(Object.values(r.coachAssignments));
        if(uniqueCoaches.size > 1){
          // Find the handoff coach (not the primary)
          const handoffCoachId = Array.from(uniqueCoaches).find(cid => cid !== r.coach.id);
          const handoffCoachName = handoffCoachId ? coach(handoffCoachId)?.name : 'unknown';
          coachInfo += `<div class="small" style="margin-top:4px;color:#666">→ hands off to ${esc(handoffCoachName)}</div>`;
        }
      }
      html+=`<tr><td>${coachInfo}</td><td>${r.coach.team}</td><td class="mono">${fmt(r.plan.start)}</td>
      <td>${r.plan.seq.map((w,vidx)=>{
        const assignedCoach = r.coachAssignments ? coach(r.coachAssignments[vidx]) : r.coach;
        const isHandoff = assignedCoach && assignedCoach.id !== r.coach.id;
        const label = isHandoff ? `${fmtW(w)}<br/><small>${assignedCoach?.name || 'unknown'}</small>` : fmtW(w);
        return `<span class="result-week" style="display:inline-block;text-align:center">${label}</span>`;
      }).join(' ')}</td><td class="num">${r.spare}</td>
      <td><button class="btn tiny" onclick="previewAvailCoach(${i})">Preview calendar</button></td></tr>`;
    });
    html+=`</table>`;
  }
  let note = `Planning horizon: through ${fmt(horizon)}. ${st.due2027?'Months past the current plan read as fully open — treat those as estimates.':'Check the box above to look into 2027 (not yet planned).'}`;
  note += ` Visits are spaced within ±14 days of their target dates to keep cadences tight.`;
  if(team !== 'Any') note += ` All coaches shown are on Team ${team}.`;
  if(st.handoffMode > 0){
    note += ` Use "Preferred Handoff Coach" to filter to a specific follow-up coach, or leave blank to see all options.`;
    if(results.some(r=>r.coachAssignments)) note += ` Visits marked with coach names are assigned to different coaches.`;
  }
  note += ` "Spare weeks" counts open weeks within 12 months of the plan start.`;
  html+=`<p class="small" style="margin-top:8px">${note}</p>`;
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
    else if(o.type==='visit'){ cls+= o.v.completed?' s-done':' s-visit'; label=`<b>${clientLink(o.v.client, o.v.client_id)}</b>`; detail=`${esc(o.v.cycle)} ${esc(o.v.program)}`; }
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
  <div class="controls" style="margin-bottom:10px">
    ${n>0 ? `<button class="btn danger" onclick="ignoreAllPending()">Clear all${n?` (${n})`:''}</button>` : ''}
    <label class="small" style="display:flex;align-items:center;gap:6px;margin:0"><input type="checkbox" ${st.pendShowIgnored?'checked':''} onchange="st.pendShowIgnored=this.checked;loadPending()"> Show ignored</label>
  </div>
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
    const rows = await api('GET','/api/pending-clients' + (st.pendShowIgnored ? '?includeIgnored=1' : ''));
    st.pendingList = rows;
    $('#pendingOut').innerHTML = rows.length ? `<div style="overflow-x:auto"><table><tr><th>Company</th><th>Contact</th><th class="num">Amount</th><th>Billing</th><th>Started</th><th style="white-space:nowrap">Actions</th></tr>` +
      rows.map(r=>{
        const pcm = r.program_change_match;
        const pcmRow = (pcm && r.status !== 'ignored') ? `<tr><td colspan="6" style="background:#e9f0fb;border-left:4px solid #1d4f91;padding:8px 12px">
          <b>Looks like a program change for ${esc(pcm.clientName)}</b> — their ${esc(pcm.program)} contract${pcm.keapSubscriptionId?` (Keap ${esc(pcm.keapSubscriptionId)})`:''} is cancelled,
          with ${pcm.completedVisits} completed visit(s)${pcm.placed.length?`, ${pcm.placed.length} still on a calendar`:''}${pcm.unplaced?` and ${pcm.unplaced} unscheduled`:''}.
          Assigning it as the replacement keeps that history, carries the booked week(s) into the new cycle${pcm.archived?', and brings the client back out of the archive':''}.
          <button class="btn tiny primary" style="margin-left:8px" onclick="assignPendingDlg(${r.id}, null, ${pcm.contractId})">Program change</button>
        </td></tr>` : '';
        const hm = r.hold_match;
        const matchRow = hm ? `<tr><td colspan="6" style="background:#fdf6e3;border-left:4px solid var(--gold);padding:8px 12px">
          <b>Looks like your soft-pencil hold:</b> "${esc(hm.name)}" with ${esc(hm.coachName)}${hm.team?` (Team ${esc(hm.team)})`:''} —
          ${hm.weeks.length} week(s) reserved starting ${fmtW(hm.weeks[0])}, ${esc(hm.program)}.
          <button class="btn tiny primary" style="margin-left:8px" onclick="assignPendingDlg(${r.id}, ${hm.id})">Use this hold</button>
        </td></tr>` : '';
        const future = r.start_date && r.start_date > TODAY;
        const ig = r.status === 'ignored';
        return `<tr${ig?' style="opacity:.6;background:#faf9f8"':''}><td><b>${esc(r.company_name||'(unknown)')}</b>${ig?' <span class="pill" style="background:#f0efee;color:var(--muted)">ignored</span>':''}</td><td class="small">${esc(r.contact_name||'—')}</td>
        <td class="num">${r.billing_amount?'$'+r.billing_amount:'—'}</td><td class="small">${esc(r.billing_cycle||'—')} ×${r.billing_frequency||1}</td>
        <td class="small">${esc(r.start_date||'—')}${future?' <span class="pill p-fut">upcoming</span>':''}</td>
        <td style="white-space:nowrap">${ig
          ? `<button class="btn tiny primary" title="Put it back in the queue" onclick="unignorePending(${r.id})">Un-ignore</button>`
          : `<button class="btn tiny primary" onclick="assignPendingDlg(${r.id})">Assign</button>
        <button class="btn tiny" onclick="ignorePending(${r.id})">Ignore</button>`}
        ${D.user.role==='admin'?`<button class="btn tiny" onclick="debugPendingClient(${r.id})">Debug</button>`:''}</td></tr>` + pcmRow + matchRow;
      }).join('') + `</table></div>`
      : `<p class="small">Nothing waiting — you're all caught up.</p>`;
  }catch(e){ $('#pendingOut').innerHTML = `<p class="small">Could not load.</p>`; }
}
function coachOptsFor(team, placeholder, selectedId){
  const list = D.coaches.filter(c=>c.active && (!team||c.team===team));
  return `<option value="">${esc(placeholder || '— select —')}</option>` +
    list.map(c=>`<option value="${c.id}" data-team="${c.team}" ${selectedId===c.id?'selected':''}>${esc(c.name)} (${c.team})</option>`).join('');
}
/* The team select drives which coaches are offered — keep them in step, and hold the
 * current pick if that coach is on the newly chosen team. */
function onPendingTeamChange(){
  const sel = $('#pVisitCoach'); if(!sel) return;
  const keep = sel.value;
  sel.innerHTML = coachOptsFor($('#pTeam').value, '— decide later —', keep);
}
function assignPendingDlg(id, holdId, succeedsContractId){
  const r = (st.pendingList||[]).find(x=>x.id===id); if(!r) return;
  const hm = holdId && r.hold_match && r.hold_match.id===holdId ? r.hold_match : null;
  const pcm = succeedsContractId && r.program_change_match && r.program_change_match.contractId===succeedsContractId ? r.program_change_match : null;
  st._pendingHoldId = hm ? hm.id : null;
  st._pendingSucceeds = pcm ? pcm.contractId : null;
  const guessed = hm && PROGRAMS.includes(hm.program) ? hm.program : guessProgram(r.billing_cycle, r.billing_frequency);
  openDlg(`<h3>${pcm ? 'Program change' : 'Assign'} — ${esc(r.company_name||'(unknown)')}</h3>
    ${pcm ? `<div class="small" style="background:#e9f0fb;padding:8px 10px;border-left:4px solid #1d4f91;margin-bottom:8px">
      Replaces <b>${esc(pcm.program)}</b> for <b>${esc(pcm.clientName)}</b>. Their ${pcm.completedVisits} completed visit(s) and notes stay on the old contract.
      ${pcm.placed.length ? `The ${pcm.placed.length} week(s) already booked (${pcm.placed.map(v=>fmtW(v.cal_week)).join(', ')}) carry into the new cycle in order.` : ''}
      ${pcm.unplaced ? `${pcm.unplaced} unscheduled visit(s) on the old contract are removed.` : ''}
      ${pcm.archived ? 'The client comes back out of the archive.' : ''}
    </div>` : ''}
    ${hm ? `<p class="small" style="background:#fdf6e3;padding:6px 10px;border-left:4px solid var(--gold)">Pre-filled from your hold "${esc(hm.name)}" — creating this contract will release the ${hm.weeks.length} reserved week(s) on ${esc(hm.coachName)}'s calendar so you can place the real visits there.</p>` : ''}
    <label>Client name</label><input id="pClient" value="${esc(r.company_name||r.contact_name||'')}">
    <label>Program</label><select id="pProg" onchange="onPendingProgramChange()">${PROGRAMS.map(p=>`<option ${p===guessed?'selected':''}>${p}</option>`).join('')}</select>
    <div id="pVisitFields">
      <label>Number of visits</label><input id="pN" type="number" value="${CYCLE_LEN[guessed]||4}">
      <label>First visit due</label><input id="pFirst" type="date" value="${(hm&&hm.weeks[0])||r.start_date||TODAY}">
      <label>Team</label><select id="pTeam" onchange="onPendingTeamChange()">${teamOpts(pcm&&pcm.team?pcm.team:(hm?hm.team:undefined))}</select>
      <label>Assigned coach <span class="small" style="font-weight:400;text-transform:none;letter-spacing:0">— optional, but they'll own these visits</span></label>
      <select id="pVisitCoach">${coachOptsFor(pcm&&pcm.team?pcm.team:(hm?hm.team:undefined), '— decide later —', pcm?pcm.assignedCoachId:null)}</select>
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
    await api('POST',`/api/pending-clients/${id}/assign`,{client, program, n:0, first:null, team:coach.team, coachId, succeedsContractId: st._pendingSucceeds || undefined});
    const extra = await finishPendingHold();
    closeDlg(); await refresh(); toast(client+' added — Coaching Only, assigned to '+coach.name+extra);
    return;
  }
  const n=+$('#pN').value, first=$('#pFirst').value, team=$('#pTeam').value;
  if(!first||!(n>0)||!team){uiAlert('Program visit count, first due date and team are required');return;}
  const coachId = (($('#pVisitCoach')||{}).value) || undefined;
  const res = await api('POST',`/api/pending-clients/${id}/assign`,{client,program,n,first,team, coachId, succeedsContractId: st._pendingSucceeds || undefined});
  const extra = await finishPendingHold();
  const coachTxt = coachId ? ` · assigned to ${esc((D.coaches.find(c=>c.id===coachId)||{}).name||'coach')}` : '';
  const sx = res && res.succession
    ? ` — replaced the previous contract${res.succession.carried.length?`, ${res.succession.carried.length} booked week(s) carried over`:''}${res.succession.droppedPlaced?`, ${res.succession.droppedPlaced} booked week(s) had no slot in the shorter cycle and were cleared`:''}`
    : ' — contract created';
  st._pendingSucceeds = null;
  closeDlg(); await refresh(); toast(client+' added'+sx+coachTxt+extra);
}
async function ignorePending(id){
  const r = (st.pendingList||[]).find(x=>x.id===id);
  const pcm = r && r.program_change_match;
  const msg = pcm
    ? `This looks like a program change for ${pcm.clientName} — their ${pcm.program} contract is cancelled and this would be the replacement.\n\nIgnore it anyway? You can bring it back later with "Show ignored".`
    : "Ignore this subscription? It won't be added to the LID Inventory. You can bring it back later with \"Show ignored\".";
  if(!(await uiConfirm(msg, 'Ignore'))) return;
  await api('POST',`/api/pending-clients/${id}/ignore`,{}); await refresh(); await loadPending(); toast('Ignored');
}
async function unignorePending(id){
  await api('POST',`/api/pending-clients/${id}/unignore`,{});
  await refresh(); await loadPending(); toast('Back in the queue');
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
      ${(r.subscription && !r.subscription.ok) || (r.contact && !r.contact.ok) ? `<p class="small" style="color:var(--bad,#c23b3b)">Keap says these IDs don't exist. This row's link is stale or corrupt — deleting it lets a fresh Backfill re-create it correctly under Keap's current IDs (Admin → Backfill missed subscriptions).</p>` : ''}
      <div class="dlgrow"><button class="btn danger" onclick="deleteStalePendingClient(${id})">Delete this row</button><button class="btn" onclick="closeDlg()">Close</button></div>`);
  }catch(e){ openDlg(`<h3>Keap raw lookup</h3><p class="small" style="color:var(--bad,#c23b3b)">${esc(e.message||String(e))}</p><div class="dlgrow"><button class="btn" onclick="closeDlg()">Close</button></div>`); }
}
async function deleteStalePendingClient(id){
  if(!(await uiConfirm('Delete this pending row outright? Unlike Ignore, this is a hard delete — use it when the stored Keap subscription/contact IDs are stale or corrupt (404 on lookup) so a corrected Backfill can re-create it fresh.','Delete'))) return;
  await api('POST', `/api/admin/pending-clients/${id}/delete`, {});
  closeDlg();
  await refresh();
  toast('Deleted');
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
    <label class="small" style="display:flex;align-items:center;gap:6px;margin:0"><input type="checkbox" ${st.cliShowArchived?'checked':''} onchange="st.cliShowArchived=this.checked;renderClientTable()"> Show archived <span id="cliArchivedN"></span></label>
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
  const archivedN = rows.filter(c=>c.archived_at).length;
  const nEl = $('#cliArchivedN'); if(nEl) nEl.textContent = archivedN ? `(${archivedN})` : '';
  if(!st.cliShowArchived) rows = rows.filter(c=>!c.archived_at);
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
    rows.map(c=>`<tr>${canBulk?`<td onclick="event.stopPropagation()"><input type="checkbox" ${sel.has(c.id)?'checked':''} onclick="toggleClientSel(${c.id},this.checked)"></td>`:''}<td><b>${clientLink(c.name, c.id)}</b>${noticePill(c)}</td>
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
/* Per-contract Keap resync/relink — see the "Keap link" column in the Assignment
 * &amp; Keap details table. Resync re-checks the currently-linked subscription;
 * Relink re-points the contract at a different subscription ID entirely (for when
 * the link itself is wrong, not just stale) and resyncs from the corrected one. */
async function contractKeapResync(contractId){
  try{
    const r = await api('POST', `/api/contracts/${contractId}/keap-resync`, {});
    const parts = [];
    if(r.statusChanged) parts.push('status updated');
    if(r.priceChanged) parts.push('price updated');
    if(r.found===false) parts.push('no matching contract found on Keap\'s side');
    await refresh();
    toast(parts.length ? `Resynced — ${parts.join(', ')}` : 'Resynced — no changes needed');
    // Program/cadence is a suggestion only, never applied automatically — if Keap's
    // billing shape implies something different, offer the fix as a one-click dialog
    // instead of silently rewriting it.
    if(r.programSuggestion) offerProgramFix(contractId, r.programSuggestion);
  }catch(e){ uiAlert(e.message||'Resync failed'); }
}
async function unarchiveContract(contractId){
  if(!(await uiConfirm('Unarchive this contract? It goes back into the main contract list exactly as it was, with nothing else recalculated.','Unarchive'))) return;
  try{
    await api('POST', `/api/contracts/${contractId}/unarchive`, {});
    await refresh();
    toast('Contract unarchived');
  }catch(e){ uiAlert(e.message||'Unarchive failed'); }
}
function contractKeapRelinkDlg(contractId, currentSubId){
  openDlg(`<h3>Link to Keap subscription</h3>
    <p class="small">${currentSubId?`Currently linked to subscription <span class="mono">${esc(currentSubId)}</span>. `:''}Enter the correct Keap subscription ID for this contract. It's validated against Keap before anything changes, and price/status is resynced from it immediately after linking.</p>
    <label>Keap subscription ID</label><input id="krSubId" placeholder="e.g. 7304">
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="doContractKeapRelink(${contractId})">Link &amp; resync</button></div>`);
}
async function doContractKeapRelink(contractId){
  const subscriptionId = $('#krSubId').value.trim();
  if(!subscriptionId){ uiAlert('Subscription ID required'); return; }
  try{
    const r = await api('POST', `/api/contracts/${contractId}/keap-relink`, { subscriptionId });
    closeDlg();
    const parts = [];
    if(r.statusChanged) parts.push('status updated');
    if(r.priceChanged) parts.push('price updated');
    if(r.resyncError) parts.push(`resync afterward failed: ${r.resyncError}`);
    await refresh();
    toast(`Linked to subscription ${subscriptionId}${parts.length?' — '+parts.join(', '):''}`);
    if(r.programSuggestion) offerProgramFix(contractId, r.programSuggestion);
  }catch(e){ uiAlert(e.message||'Link failed'); }
}
function offerProgramFix(contractId, suggestion){
  openDlg(`<h3>Program cadence looks off</h3>
    <p class="small">Based on ${esc(suggestion.basis||'the billing cycle')}, this subscription looks like <b>${esc(suggestion.guessed)}</b>, but this contract is currently set to <b>${esc(suggestion.current||'—')}</b>. This is only a suggestion — it's never applied automatically. Fix it now?</p>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Leave as-is</button>
    <button class="btn primary" onclick="closeDlg();programChangeDlg(${contractId},'${esc(suggestion.current||'').replace(/'/g,"\\'")}',null,'${esc(suggestion.guessed).replace(/'/g,"\\'")}',null,'keap')">Review &amp; fix</button></div>`);
}
/* Manual override of a contract's program/cadence label — the fix for exactly the
 * kind of mismatch offerProgramFix() surfaces, or just a direct correction any time.
 * Only ever edits the contract row itself; never touches already-generated visits
 * (those are fixed individually via the Edit button on Visit history below). */
/* Multi-store ("stores covered") display + editor on a contract row. */
function parseContractStores(c){ try{ const a=JSON.parse((c&&c.stores)||'[]'); return Array.isArray(a)?a:[]; }catch(_){ return []; } }
/* Every store this client is known to operate, de-duped and sorted. Two sources: the
 * contract's own store list (contracts.stores, set by an admin) and, as a fallback, the
 * stores already recorded on this client's visits - plenty of multi-rooftop clients came
 * in from the sheet import with visits.store filled in but contracts.stores never set,
 * and without this the picker would silently never appear for them. Empty for ordinary
 * single-store clients, in which case no picker is shown at all. */
function clientStoreOptions(){
  const out = [];
  const add = raw => { const t = String(raw || '').trim(); if(t && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t); };
  for(const c of ((st.clientProfile && st.clientProfile.contracts) || [])) parseContractStores(c).forEach(add);
  for(const v of ((st.clientProfile && st.clientProfile.visits) || [])) add(v.store);
  return out.sort((a,b) => a.localeCompare(b));
}
function contractStoresHtml(c){
  const list = parseContractStores(c);
  const admin = D.user.role==='admin';
  if(!list.length){
    return admin ? ` <button class="btn tiny" title="Set the stores this contract covers (for a shared / à-la-carte contract)" onclick="editStoresDlg(${c.id})">+ stores</button>` : '';
  }
  const chips = `<div class="small" style="margin-top:4px">🏬 ${list.map(esc).join(' · ')}${admin?` <button class="btn tiny" onclick="editStoresDlg(${c.id})">Edit</button>`:''}</div>`;
  return chips;
}
function editStoresDlg(contractId){
  const c = ((st.clientProfile&&st.clientProfile.contracts)||[]).find(x=>x.id===contractId) || {};
  const cur = parseContractStores(c).join('\n');
  openDlg(`<h3>Stores covered</h3>
    <p class="small">One store per line. These are the dealerships this single contract covers — each visit can then be tagged with which store it was. App-only; never changes Keap. Leave blank to make this an ordinary single-store contract.</p>
    <textarea id="stStores" rows="6" placeholder="Steven Honda&#10;Steven Hyundai&#10;Steven Ford">${esc(cur)}</textarea>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveStores(${contractId})">Save</button></div>`);
}
async function saveStores(contractId){
  const stores = (($('#stStores')||{}).value||'').split('\n').map(s=>s.trim()).filter(Boolean);
  try{ await api('PATCH',`/api/contracts/${contractId}`,{ stores }); }
  catch(e){ uiAlert(e.message||'Could not save stores'); return; }
  closeDlg(); await refresh();
  toast(stores.length?`Saved ${stores.length} store(s)`:'Stores cleared');
}
/* ---------- Change program (cadence change with schedule follow-through) ----------
 * Keap is changed first; this makes the app follow. Preview shows exactly what will
 * happen to every open visit before anything is written. See server planProgramChange. */
function nextOpenDueFor(contractId){
  const open = D.visits.filter(v => v.contract_id === contractId && !v.completed && v.due >= TODAY).sort((a,b)=>a.due.localeCompare(b.due));
  return open.length ? open[0].due : TODAY;
}
function programChangeDlg(contractId, currentProgram, currentVisits, suggestedProgram, effectiveDate, source){
  const startProgram = suggestedProgram || currentProgram;
  const eff = effectiveDate || nextOpenDueFor(contractId);
  openDlg(`<h3>Change program</h3>
    <p class="small" style="color:var(--muted)">Currently <b>${esc(currentProgram||'—')}</b> · ${currentVisits ?? '—'} visits per cycle.${suggestedProgram ? ` Keap now bills <b>${esc(suggestedProgram)}</b>.` : ''}</p>
    <div class="controls" style="align-items:flex-end;margin-top:8px">
      <div><label style="display:block;margin:0 0 3px">New program</label><select id="pcProg" onchange="$('#pcN').value=CYCLE_LEN[this.value]||0;$('#pcPlan').innerHTML=''">${progOpts(startProgram)}</select></div>
      <div><label style="display:block;margin:0 0 3px">Visits / cycle</label><input type="number" id="pcN" min="0" max="24" style="width:80px" value="${CYCLE_LEN[startProgram] ?? 0}" oninput="$('#pcPlan').innerHTML=''"></div>
      <div><label style="display:block;margin:0 0 3px">Effective from</label><input type="date" id="pcEff" value="${eff}" style="width:150px" onchange="$('#pcPlan').innerHTML=''"></div>
      <button class="btn primary" onclick="programChangePreview(${contractId})">Preview</button>
    </div>
    <p class="small" style="margin-top:8px">Completed visits are never touched. Open visits due before the effective date stay as they are. From the effective date, unscheduled visits are replaced by a fresh cycle starting at 1; visits already on a coach's calendar keep their week and are relabelled into the new cycle.</p>
    <div id="pcPlan" style="margin-top:10px"></div>
    <div class="dlgrow" style="margin-top:12px">
      <button class="btn" onclick="closeDlg()">Cancel</button>
      <span style="flex:1"></span>
      <a class="small" style="cursor:pointer;color:var(--muted)" onclick="closeDlg();editContractProgramDlg(${contractId},'${esc(currentProgram||'').replace(/'/g,"\\'")}',${currentVisits ?? 'null'})" title="Correct the label only — no visits added, removed or moved">just relabel the contract</a>
    </div>`, {wide:true});
  st._pcSource = source || 'manual';
}
async function programChangePreview(contractId){
  const body = { program: $('#pcProg').value, visits: +$('#pcN').value, effective_date: $('#pcEff').value };
  const out = $('#pcPlan'); out.innerHTML = '<p class="small">Working out the plan…</p>';
  try{
    const p = await api('POST', `/api/contracts/${contractId}/program-change/preview`, body);
    const row = (a,b,c) => `<tr><td class="mono">${a}</td><td>${b}</td><td class="small">${c}</td></tr>`;
    let h = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-bottom:10px">
      <div class="card"><div class="k">${p.keep}</div><div class="l">left alone (due before ${fmt(p.effective_date)})</div></div>
      <div class="card"><div class="k" style="color:var(--bad)">${p.remove.length}</div><div class="l">unscheduled, removed</div></div>
      <div class="card"><div class="k" style="color:#1d4f91">${p.relabel.filter(r=>!r.untouched).length}</div><div class="l">on calendar, relabelled</div></div>
      <div class="card"><div class="k" style="color:var(--ok)">${p.create.length}</div><div class="l">new ${esc(p.to.program)} visits created</div></div>
    </div>`;
    if(p.relabel.length) h += `<h3 style="margin:10px 0 4px">Kept on the calendar</h3><table><tr><th>Week of</th><th>Becomes</th><th></th></tr>${p.relabel.map(r=>row(fmtW(r.cal_week), r.untouched ? `${esc(r.from)} (unchanged — ${esc(p.to.program)} has no cycle)` : `<b>${esc(r.to)} ${esc(p.to.program)}</b> · due ${fmt(r.due)}`, `was ${esc(r.from)}${r.cal_coach?' · '+esc(coach(r.cal_coach)?.name||''):''}`)).join('')}</table>`;
    if(p.remove.length) h += `<h3 style="margin:10px 0 4px">Removed (never scheduled)</h3><table><tr><th>Due</th><th>Cycle</th><th></th></tr>${p.remove.map(r=>row(fmt(r.due), esc(r.cycle), '')).join('')}</table>`;
    if(p.create.length) h += `<h3 style="margin:10px 0 4px">New cycle</h3><table><tr><th>Due</th><th>Cycle</th><th></th></tr>${p.create.map(r=>row(fmt(r.due), `${esc(r.cycle)} ${esc(p.to.program)}`, '')).join('')}</table>`;
    const same = p.from.program === p.to.program && +p.from.visits === +p.to.visits;
    h += `<div class="dlgrow" style="margin-top:12px">${same ? '<span class="small">That is already the contract\'s program — pick a different one.</span>' : `<button class="btn primary" onclick="programChangeApply(${contractId})">Apply change</button>`}</div>`;
    out.innerHTML = h;
  }catch(e){ out.innerHTML = `<p class="small" style="color:var(--bad)">${esc(e.message||'Preview failed')}</p>`; }
}
async function programChangeApply(contractId){
  const body = { program: $('#pcProg').value, visits: +$('#pcN').value, effective_date: $('#pcEff').value, source: st._pcSource || 'manual' };
  try{
    const r = await api('POST', `/api/contracts/${contractId}/program-change`, body);
    closeDlg();
    toast(`Program changed — ${r.relabelled} kept on calendar, ${r.removed} removed, ${r.created} created`);
    await refresh();
  }catch(e){ uiAlert(e.message||'Change failed'); }
}
/* A program change is a new contract that took over from a cancelled one, so show the
 * link both ways — otherwise a client's contracts read as unrelated rows. */
function contractLineage(c, all){
  const prev = c.succeeds_contract_id ? (all||[]).find(x=>x.id===c.succeeds_contract_id) : null;
  const next = (all||[]).find(x=>x.succeeds_contract_id===c.id);
  const bits = [];
  if(prev) bits.push(`replaced ${esc(prev.program||'a previous contract')}${prev.start_date?` from ${fmt(prev.start_date)}`:''}`);
  if(next) bits.push(`replaced by ${esc(next.program||'a later contract')}${next.start_date?` from ${fmt(next.start_date)}`:''}`);
  return bits.length ? `<div class="small" style="color:var(--muted);margin-top:2px">↳ ${bits.join(' · ')}</div>` : '';
}
function cadenceBanner(contracts){
  const flagged = (contracts||[]).filter(c => c.cadence_flag && c.status === 'active');
  if(!flagged.length || D.user.role !== 'admin') return '';
  return flagged.map(c => `<div style="background:#fdeecd;border-left:5px solid #c77d0a;padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
    <div style="flex:1;min-width:240px"><div style="font-family:var(--head);font-size:14px;letter-spacing:1px;text-transform:uppercase;color:#8a5b06;font-weight:600">Keap billing changed</div>
      <div style="font-size:13px;margin-top:3px">This contract is stored as <b>${esc(c.program)}</b>, but Keap now bills <b>${esc(c.cadence_flag.suggested_program)}</b> (per ${esc(c.cadence_flag.basis||'the subscription')}, checked ${fmt(c.cadence_flag.detected_at.slice(0,10))}). Review how the visit schedule should follow.</div></div>
    <button class="btn primary" onclick="programChangeDlg(${c.id},'${esc(c.program||'').replace(/'/g,"\\'")}',${c.visits},'${esc(c.cadence_flag.suggested_program).replace(/'/g,"\\'")}',null,'keap')">Review schedule change</button>
  </div>`).join('');
}

function editContractProgramDlg(contractId, currentProgram, currentVisits, suggestedProgram){
  const startProgram = suggestedProgram || currentProgram;
  openDlg(`<h3>Edit program &amp; cadence</h3>
    <label>Program</label><select id="ecpProg" onchange="$('#ecpN').value=CYCLE_LEN[this.value]||0">${progOpts(startProgram)}</select>
    <label>Cadence (visits per cycle)</label><input type="number" id="ecpN" min="0" max="24" value="${currentVisits!=null?currentVisits:(CYCLE_LEN[startProgram]||0)}">
    <p class="small">This only relabels the contract itself — it does not add, remove, or reschedule any already-generated visits.</p>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveContractProgram(${contractId})">Save</button></div>`);
}
async function saveContractProgram(contractId){
  const program = $('#ecpProg').value;
  const visits = +$('#ecpN').value;
  try{
    await api('PATCH', `/api/contracts/${contractId}`, { program, visits });
    closeDlg(); await refresh();
    toast('Contract updated');
  }catch(e){ uiAlert(e.message||'Update failed'); }
}
/* Regenerate a contract's remaining schedule on its CURRENT program/cadence — the
 * fix for exactly the gap editContractProgramDlg leaves: correcting the program
 * label doesn't touch already-generated visits, so this is the button that actually
 * deletes the not-yet-completed ones and recreates them spaced correctly. The anchor
 * date defaults to the contract's existing start date but is editable here — changing
 * it re-spaces the ENTIRE remaining schedule from the new date forward (the
 * "butterfly effect" for correcting an existing client's first-pay date). Completed
 * visits are never touched. Counts are previewed from the already-loaded client
 * profile, same pattern as deleteContractDlg below. */
function regenerateContractDlg(contractId, program, visitsN, startDate, firstPayDate){
  const visits = ((st.clientProfile && st.clientProfile.visits) || []).filter(v => v.contract_id === contractId);
  const notCompleted = visits.filter(v => !v.completed).length;
  const completed = visits.length - notCompleted;
  openDlg(`<h3>Regenerate schedule</h3>
    <p class="small">This will remove ${notCompleted} not-yet-completed visit${notCompleted===1?'':'s'} under this ${esc(program||'')} contract and create ${visitsN} new one${visitsN===1?'':'s'}, spaced on the ${esc(program||'')} cadence starting from the date below.${completed?` ${completed} completed visit${completed===1?'':'s'} will be left exactly as-is.`:''}</p>
    <label>First pay date (leave blank if unknown/not applicable)</label>
    <input type="date" id="rgFirstPay" value="${esc(firstPayDate||'')}" onchange="onRgFirstPayChange()" oninput="onRgFirstPayChange()">
    <label>Anchor date (first visit due)</label><input type="date" id="rgAnchor" value="${esc(startDate||'')}">
    <p class="small" style="color:var(--muted)">Entering a first pay date fills the anchor date 90 days later automatically. You can also edit the anchor date directly instead (e.g. for Keap-linked contracts with no clean pay date on record). Either way, changing it re-spaces the whole remaining schedule from that new date forward — this is how you correct an existing client's first-pay date one-off.</p>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="doRegenerateContract(${contractId})">Regenerate</button></div>`);
}
async function generateNextCycleDlg(clientId, contracts){
  if(!contracts || contracts.length === 0) { uiAlert('No active contracts'); return; }
  // One contract: straight to the preview. Several: pick which one first.
  if(contracts.length === 1) return extendVisitsDlg(contracts[0].id);
  openDlg(`<h3>Extend visits</h3>
    <p class="small" style="color:var(--muted)">This client has more than one active contract. Which one?</p>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
      ${contracts.map(c=>`<button class="btn" onclick="closeDlg();extendVisitsDlg(${c.id})">${esc(c.program)} · ${c.visits} per cycle${c.start_date?` · since ${fmt(c.start_date)}`:''}</button>`).join('')}
    </div>
    <div class="dlgrow" style="margin-top:14px"><button class="btn" onclick="closeDlg()">Cancel</button></div>`);
}
async function extendVisitsDlg(contractId){
  let p;
  try{ p = await api('GET', `/api/contracts/${contractId}/extend/preview`); }
  catch(e){ uiAlert(e.message || 'Could not preview'); return; }
  const yr = (p.horizon||'').slice(0,4);
  const rows = (p.visits||[]).map(v=>`<tr><td class="mono">${esc(v.cycle)}</td><td class="mono">${fmt(v.due)}</td></tr>`).join('');
  openDlg(`<h3>Extend visits through ${yr}</h3>
    <p class="small" style="color:var(--muted)"><b>${esc(p.program)}</b> · ${p.visitsPerCycle} visits per cycle. Continues from the latest visit on this contract through Dec ${yr}, then finishes the cycle so it always ends on "${p.visitsPerCycle} of ${p.visitsPerCycle}". Nothing existing is changed.</p>
    ${p.created ? `<table style="margin-top:10px"><tr><th>Cycle</th><th>Due</th></tr>${rows}</table>`
                : `<p style="margin-top:12px">Already covered — this contract has visits through Dec ${yr}. Nothing to add.</p>`}
    <div class="dlgrow" style="margin-top:14px">
      <button class="btn" onclick="closeDlg()">Cancel</button>
      ${p.created ? `<button class="btn primary" onclick="closeDlg();extendVisitsApply(${contractId})">Add ${p.created} visit${p.created!==1?'s':''}</button>` : ''}
    </div>`, {wide:true});
}
async function extendVisitsApply(contractId){
  try{
    const r = await api('POST', `/api/contracts/${contractId}/extend`, {});
    await refresh();
    toast(`Added ${r.created} visit${r.created !== 1 ? 's' : ''} through ${(r.horizon||'').slice(0,4)}`);
  }catch(e){ uiAlert(e.message || 'Could not extend visits'); }
}
function onRgFirstPayChange(){
  const v = $('#rgFirstPay').value;
  if(v) $('#rgAnchor').value = addDaysClient(v, 90);
}
async function doRegenerateContract(contractId){
  const anchorDate = $('#rgAnchor').value;
  const firstPayDate = $('#rgFirstPay').value || '';
  if(!anchorDate) return uiAlert('Pick an anchor date');
  try{
    const r = await api('POST', `/api/contracts/${contractId}/regenerate`, { anchorDate, firstPayDate });
    closeDlg(); await refresh();
    toast(`Schedule regenerated — ${r.deletedVisits} removed, ${r.createdVisits} created`);
  }catch(e){ uiAlert(e.message||'Regenerate failed'); }
}
/* Delete a contract outright — for duplicates (e.g. a leftover sheet-import row
 * sitting alongside the correctly Keap-linked one) or ones created by mistake.
 * The server never destroys completed visit history: a completed visit under this
 * contract is only detached, not deleted — only not-yet-completed visits (which
 * would otherwise be dangling duplicates) are removed. This preview counts both
 * from the already-loaded client profile so the confirm dialog is accurate before
 * anything happens server-side. */
function deleteContractDlg(contractId, program){
  const visits = ((st.clientProfile && st.clientProfile.visits) || []).filter(v => v.contract_id === contractId);
  const notCompleted = visits.filter(v => !v.completed).length;
  const completed = visits.length - notCompleted;
  const parts = [];
  if(notCompleted) parts.push(`${notCompleted} not-yet-completed visit${notCompleted>1?'s':''} generated under it will be removed (freeing any calendar slot they're on)`);
  if(completed) parts.push(`${completed} completed visit${completed>1?'s':''} will stay on record, just detached from this contract`);
  openDlg(`<h3>Delete contract</h3>
    <p class="small">Delete this ${esc(program||'')} contract? ${parts.length?parts.join('. ')+'. ':'No visits are tied to this contract. '}This can't be undone.</p>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary danger" onclick="doDeleteContract(${contractId})">Delete contract</button></div>`);
}
async function doDeleteContract(contractId){
  try{
    const r = await api('DELETE', `/api/contracts/${contractId}`, {});
    closeDlg(); await refresh();
    const parts = [];
    if(r.deletedVisits) parts.push(`${r.deletedVisits} visit(s) removed`);
    if(r.detachedCompletedVisits) parts.push(`${r.detachedCompletedVisits} completed visit(s) detached`);
    toast(`Contract deleted${parts.length?' — '+parts.join(', '):''}`);
  }catch(e){ uiAlert(e.message||'Delete failed'); }
}
function openClientProfile(id){ st.view='clientprofile'; st.clientId=id; render(); }
async function attachCompanyId(clientId){
  const companyId = $('#cliCompanyId').value.trim();
  if(!companyId){ uiAlert('Enter a company ID'); return; }
  try{
    const res = await api('PATCH','/api/clients/'+clientId,{company_id:companyId});
    await refresh();
    if(res.syncedName){
      toast(`Company ID attached — name synced to "${res.syncedName}"`);
    } else {
      toast('Company ID attached');
    }
  }catch(e){ uiAlert(e.message||'Could not attach company ID'); }
}
async function detachCompanyId(clientId){
  if(!confirm('Remove this company ID?')) return;
  try{
    await api('PATCH','/api/clients/'+clientId,{company_id:''});
    await refresh();
    toast('Company ID removed');
  }catch(e){ uiAlert(e.message||'Could not remove company ID'); }
}
// Re-render the profile from cached data (no refetch) — for fold/unfold and similar UI-only toggles.
function rerenderClientProfile(){ if(st.clientProfile && st.view==='clientprofile'){ $('#main').innerHTML = clientProfileView(st.clientProfile, st.clientNotes || []); setupCarouselListeners(); } }
async function loadClientProfile(id){
  try{
    const data = await api('GET','/api/clients/'+id);
    st.clientProfile = data;
    const notes = await api('GET','/api/clients/'+id+'/notes');
    st.clientNotes = notes;
    await loadNotesCarousel(id);
    $('#main').innerHTML = clientProfileView(data, notes);
    setupCarouselListeners();
  }catch(e){
    console.error('Failed to load client:', id, e);
    $('#main').innerHTML = '<div class="panel"><p class="small">Could not load this client: ' + esc(e.message || e) + '</p></div>';
  }
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
/* Builds a unified timeline of visit notes + coaching notes */
function buildUnifiedNotesHistory(visits, coachingNotes){
  // Collect all note-worthy items
  const items = [];
  
  // Add visit notes (wins/issues/focus from completed visits)
  visits.forEach(v => {
    if(v.completed && (v.notes_wins || v.notes_issues || v.notes_focus)){
      items.push({
        date: v.completed_date || v.cal_week || v.due,
        type: 'Visit Note',
        visitId: v.id,
        program: v.program,
        cycle: v.cycle,
        coach: v.cal_coach,
        wins: v.notes_wins,
        issues: v.notes_issues,
        focus: v.notes_focus,
        sortKey: new Date(v.completed_date || v.cal_week || v.due).getTime()
      });
    }
  });
  
  // Add coaching notes
  coachingNotes.forEach(n => {
    if(n.note_type === 'Coaching Call'){
      items.push({
        date: n.note_date,
        type: 'Coaching Call',
        author: n.author_name || n.author_email,
        body: n.body,
        wins: n.wins,
        issues: n.issues,
        focus: n.focus,
        sortKey: new Date(n.note_date).getTime()
      });
    }
  });
  
  // Sort by date descending (newest first)
  items.sort((a, b) => b.sortKey - a.sortKey);
  
  if(items.length === 0) return '<p class="small">No visit notes or coaching calls recorded yet.</p>';
  
  let html = '<div style="margin-top:12px">';
  items.forEach((item, i) => {
    const isVisitNote = item.type === 'Visit Note';
    const bgColor = isVisitNote ? '#f0f8ff' : '#fff8e1';
    const borderColor = isVisitNote ? '#4a90e2' : '#ffb800';
    
    html += `<div style="background:${bgColor};border-left:4px solid ${borderColor};padding:10px 12px;margin-bottom:8px;border-radius:2px">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span style="font-weight:600;font-size:13px">${isVisitNote ? '📋 Visit Note' : '🎧 Coaching Call'}</span>
        <span style="font-size:12px;color:var(--muted)">${fmt(item.date)}</span>
      </div>`;
    
    if(isVisitNote){
      html += `<p style="font-size:12px;color:var(--muted);margin:4px 0">${esc(item.program)} — Cycle ${esc(item.cycle)}</p>`;
      if(item.wins) html += `<p style="font-size:12px;margin:4px 0"><b>✓ Wins:</b> ${esc(item.wins)}</p>`;
      if(item.issues) html += `<p style="font-size:12px;margin:4px 0"><b>⚠ Issues:</b> ${esc(item.issues)}</p>`;
      if(item.focus) html += `<p style="font-size:12px;margin:4px 0"><b>→ Focus:</b> ${esc(item.focus)}</p>`;
    } else {
      html += `<p style="font-size:12px;color:var(--muted);margin:4px 0">by ${esc(item.author)}</p>`;
      if(item.wins) html += `<p style="font-size:12px;margin:4px 0"><b>✓ Wins:</b> ${esc(item.wins)}</p>`;
      if(item.issues) html += `<p style="font-size:12px;margin:4px 0"><b>⚠ Issues:</b> ${esc(item.issues)}</p>`;
      if(item.focus) html += `<p style="font-size:12px;margin:4px 0"><b>→ Focus:</b> ${esc(item.focus)}</p>`;
      if(item.body) html += `<p style="font-size:12px;margin:4px 0;font-style:italic">${esc(item.body)}</p>`;
    }
    
    html += `</div>`;
  });
  html += '</div>';
  
  return html;
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
      ${canEdit() && !client.archived_at ? `<button class="btn tiny" title="Move to the archive: history kept, open visits removed, hidden from working lists" onclick="archiveClientDlg(${client.id},'${esc(client.name).replace(/'/g,"\\'")}')">Archive client</button>` : ''}
      ${canEdit() && client.archived_at ? `<button class="btn tiny primary" onclick="reactivateClient(${client.id},'${esc(client.name).replace(/'/g,"\\'")}')">Reactivate</button>` : ''}
      ${D.user.role==='admin' ? `<button class="btn tiny danger" onclick="deleteClientDlg(${client.id},'${esc(client.name).replace(/'/g,"\\'")}')">Delete client</button>` : ''}
    </div>
    ${client.archived_at ? `<div style="background:#f0f0f1;border-left:5px solid #9a9aa2;padding:12px 16px;margin:10px 0 4px">
      <div style="font-family:var(--head);font-size:14px;letter-spacing:1px;text-transform:uppercase;color:#55555c;font-weight:600">Archived</div>
      <div style="font-size:13px;margin-top:3px">Since ${fmt(client.archived_at.slice(0,10))}${client.archive_reason ? ` — ${esc(client.archive_reason)}` : ''}. History below is intact; this client no longer appears in working lists, calendars or capacity. Reactivate to bring them back, then use Extend visits to rebuild the schedule.</div>
    </div>` : ''}
    <h2 style="margin-top:8px">${esc(client.name)}
      ${client.archived_at?'<span class="pill" style="background:#e8e8ea;color:#55555c">archived</span>':client.status==='active'?'<span class="pill p-done">active</span>':client.status==='cancelled'?'<span class="pill p-over">cancelled</span>':'<span class="pill">inactive</span>'}${noticePill(client)}
    </h2>
    ${client.notice_given_date ? `<p class="small" style="color:var(--muted)">30-day notice given ${fmt(client.notice_given_date)}${client.status!=='cancelled'?' — no open visits are scheduled for them':''}</p>` : ''}
    <div class="cards" style="margin-top:12px">
      <div class="card"><div class="k">${visitProgress.completed}/${visitProgress.total}</div><div class="l">Visits completed — ${visitProgress.year}</div></div>
      <div class="card"><div class="k">${contracts.filter(c=>c.status==='active'&&!c.archived_at).length}</div><div class="l">Active contracts</div></div>
      <div class="card"><div class="k">${fmt(client.billing_start)}</div><div class="l">First paid</div></div>
    </div>
    <div class="bar" style="margin-top:10px;max-width:400px"><div style="width:${pct}%;background:var(--primary)"></div><div style="width:${100-pct}%;background:var(--open)"></div></div>
  </div>`;

  const oc = data.openCommitments || [], dc = data.doneCommitments || [];
  if(oc.length || dc.length){
    html += `<div class="panel"><h2>Commitments</h2>
      <p class="small" style="margin-bottom:10px">What this client agreed to, captured on their visits — the open ones carry into the next visit for follow-up.</p>
      ${oc.length ? `<ul class="commitlist">${oc.map(c=>`<li><span class="cdot open"></span><span>${esc(c.text)}${c.from_due?` <span class="cfrom">since ${fmt(c.from_due)}</span>`:''}</span></li>`).join('')}</ul>`
        : `<p class="small" style="color:var(--muted)">No open commitments.</p>`}
      ${dc.length ? `<details style="margin-top:10px"><summary class="small" style="cursor:pointer">${dc.length} completed commitment${dc.length>1?'s':''}</summary>
        <ul class="commitlist done" style="margin-top:8px">${dc.map(c=>`<li><span class="cdot done">✓</span><span>${esc(c.text)}${c.done_on?` <span class="cfrom">${fmt(c.done_on)}</span>`:''}</span></li>`).join('')}</ul></details>` : ''}
    </div>`;
  }

  const archivedContracts = contracts.filter(c=>c.archived_at);
  const liveContracts = contracts.filter(c=>!c.archived_at);
  html += cadenceBanner(contracts);
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

  html += `<table style="margin-top:10px"><tr><th>Program</th><th>Cadence (visits)</th><th>Started</th><th class="num">Price</th><th>Status</th><th>Source</th><th>Keap link</th>${D.user.role==='admin'?'<th></th>':''}</tr>` +
    liveContracts.map(c=>`<tr><td>${esc(c.program||'—')}${contractLineage(c, contracts)}${D.user.role==='admin'?` <button class="btn tiny" title="Change program / cadence (with schedule follow-through)" onclick="programChangeDlg(${c.id},'${esc(c.program||'').replace(/'/g,"\\'")}',${c.visits})">✎</button>`:''}${contractStoresHtml(c)}</td><td class="num">${c.visits}</td><td class="mono">${fmt(c.start_date)}</td>
      <td class="num">${c.price?'$'+c.price:'—'}</td>
      <td>${c.status==='active'?'<span class="pill p-done">active</span>':c.status==='cancelled'?'<span class="pill p-over">cancelled</span>':'<span class="pill">completed</span>'}</td>
      <td class="small">${esc(c.source||'—')}</td>
      <td class="small">${c.keap_subscription_id?`<span class="mono">${esc(c.keap_subscription_id)}</span>`:'<span style="color:var(--muted)">not linked</span>'}
        ${D.user.role==='admin' ? `<div style="margin-top:4px;white-space:nowrap">${c.keap_subscription_id?`<button class="btn tiny" onclick="contractKeapResync(${c.id})">Resync</button> `:''}<button class="btn tiny" onclick="contractKeapRelinkDlg(${c.id},'${esc(c.keap_subscription_id||'').replace(/'/g,"\\'")}')">${c.keap_subscription_id?'Change link':'Link to Keap'}</button></div>` : ''}
      </td>
      ${D.user.role==='admin' ? `<td style="white-space:nowrap"><button class="btn tiny danger" onclick="deleteContractDlg(${c.id},'${esc(c.program||'').replace(/'/g,"\\'")}')">Delete</button></td>` : ''}
      </tr>`).join('') +
    `</table>
    <p class="small" style="margin-top:8px">
      <span>Keap company ID: <span class="mono">${esc(client.keap_id||'—')}</span></span>
      ${client.company_id ? `<span style="margin-left:16px">Company ID: <span class="mono">${esc(client.company_id)}</span>${canEdit() ? ` <button class="btn tiny" onclick="detachCompanyId(${client.id})">Clear</button>` : ''}</span>` : ''}
      ${!client.company_id && canEdit() ? `<div style="margin-top:6px"><input id="cliCompanyId" value="" placeholder="Enter company ID to auto-sync name" style="font-size:12px; padding:4px">
        <button class="btn tiny" style="margin-top:4px" onclick="attachCompanyId(${client.id})">Attach ID</button></div>` : ''}
    </p>
    ${archivedContracts.length ? `<details style="margin-top:10px"><summary class="small" style="cursor:pointer">${archivedContracts.length} archived contract${archivedContracts.length>1?'s':''}</summary>
      <table style="margin-top:8px"><tr><th>Program</th><th>Started</th><th class="num">Price</th><th>Source</th><th>Keap link</th><th>Archived reason</th>${D.user.role==='admin'?'<th></th>':''}</tr>` +
      archivedContracts.map(c=>`<tr style="opacity:.7"><td>${esc(c.program||'—')}</td><td class="mono">${fmt(c.start_date)}</td>
        <td class="num">${c.price?'$'+c.price:'—'}</td><td class="small">${esc(c.source||'—')}</td>
        <td class="small">${c.keap_subscription_id?`<span class="mono">${esc(c.keap_subscription_id)}</span>`:'<span style="color:var(--muted)">not linked</span>'}</td>
        <td class="small">${esc(c.archived_reason||'—')}</td>
        ${D.user.role==='admin' ? `<td><button class="btn tiny" onclick="unarchiveContract(${c.id})">Unarchive</button></td>` : ''}
        </tr>`).join('') +
      `</table></details>` : ''}
  </div>`;

  // ---- Visit History, grouped by cycle lap ("1 of n" … "n of n") ----
  // A forever contract accumulates dozens of rows; one collapsible block per lap keeps
  // it readable. The lap containing today's work is open; past and future laps fold to
  // a one-line summary. st.vhOpen remembers what the user toggled on this profile.
  const visitRow = v => {
    const pill = v.completed?completedPill(v)
      : v.cal_week?calendarPill(v)
      : unscheduledPill(v);
    const placedCoach = v.cal_coach ? coach(v.cal_coach) : null;
    const assignedCoach = !placedCoach && client.assigned_coach_id ? coach(client.assigned_coach_id) : null;
    const coachCell = placedCoach ? esc(placedCoach.name)
      : assignedCoach ? `<span style="color:var(--muted)" title="Client's assigned coach — visit not placed on the calendar yet">${esc(assignedCoach.name)} <span class="small">(assigned)</span></span>`
      : '—';
    const oo = orderProblem(v);
    return `<tr><td class="mono">${fmt(v.due)}</td><td>${esc(v.program)}</td><td class="mono">${esc(v.cycle)}</td><td class="mono">${v.cal_week ? fmt(v.cal_week) : '—'}</td><td>${coachCell}</td><td>${pill}${oo ? ` <span class="pill p-due" title="${esc(oo)}">⚠ out of order</span>` : ''}</td>
      <td style="white-space:nowrap">${canEdit() ? `<button class="btn tiny" onclick="visitDlg(${v.id})">Edit</button>` : ''}${v.cal_week && !v.completed && (canEdit() || (D.user.role==='coach' && client.assigned_coach_id===D.user.coach_id)) ? ` <button class="btn tiny" title="Take this visit off the calendar" onclick="unscheduleV(${v.id})">Unschedule</button>` : ''}${v.completed && isAdmin() ? ` <button class="btn tiny danger" title="Admin: undo this completion" onclick="reopenVisit(${v.id})">Mark incomplete</button>` : ''}</td></tr>`;
  };
  // Walk visits oldest → newest; a new lap starts whenever the cycle number resets
  // (k <= previous k) or the program changes. Unparseable labels ride along in the current lap.
  const laps = [];
  let cur = null, prevK = Infinity, prevProg = null;
  for(const v of visits.slice().sort((a,b)=>(a.due||'').localeCompare(b.due||'') || a.id-b.id)){
    const m = /^(\d+)\s+of\s+(\d+)$/.exec(v.cycle||''); const k = m ? +m[1] : null;
    if(!cur || (k !== null && k <= prevK) || v.program !== prevProg){ cur = { program: v.program, n: m ? +m[2] : null, visits: [] }; laps.push(cur); }
    cur.visits.push(v); if(k !== null) prevK = k; prevProg = v.program;
  }
  st.vhOpen = st.vhOpen || {};
  const currentLapIdx = (() => { const i = laps.findIndex(l => l.visits.some(v => !v.completed)); return i < 0 ? laps.length - 1 : i; })();
  const lapKey = (l, i) => `${client.id}:${i}`;
  const lapHtml = laps.map((l, i) => {
    const done = l.visits.filter(v=>v.completed).length, onCal = l.visits.filter(v=>!v.completed && v.cal_week).length, todo = l.visits.length - done - onCal;
    const first = l.visits[0].due, last = l.visits[l.visits.length-1].due;
    const isOpen = st.vhOpen[lapKey(l,i)] != null ? st.vhOpen[lapKey(l,i)] : i === currentLapIdx;
    const tag = i === currentLapIdx ? '<span class="pill p-cal" style="margin-left:8px">current</span>' : (i > currentLapIdx ? '<span class="pill" style="margin-left:8px;background:#f0efee;color:var(--muted)">upcoming</span>' : (done === l.visits.length ? '<span class="pill p-done" style="margin-left:8px">complete</span>' : ''));
    const summary = [done ? `${done} completed` : '', onCal ? `${onCal} on calendar` : '', todo ? `${todo} to schedule` : ''].filter(Boolean).join(' · ');
    return `<div style="border:1px solid var(--line);border-radius:8px;margin-bottom:8px;overflow:hidden">
      <div onclick="st.vhOpen['${lapKey(l,i)}']=${!isOpen};rerenderClientProfile()" style="display:flex;align-items:center;gap:12px;padding:10px 14px;cursor:pointer;background:${isOpen?'#fff':'#faf9f8'}">
        <span style="width:14px;color:var(--muted)">${isOpen?'▾':'▸'}</span>
        <span style="font-family:var(--head);font-size:13px;letter-spacing:.8px;text-transform:uppercase;font-weight:600">Cycle ${i + 1} · ${esc(l.program)}${l.n ? ` · ${l.visits.length} of ${l.n} visits` : ''}</span>
        <span class="small">${fmtW(first)} ${first.slice(0,4)} – ${fmtW(last)} ${last.slice(0,4)}</span>${tag}
        <span style="flex:1"></span><span class="small">${summary}</span>
      </div>
      ${isOpen ? `<table style="margin:0"><tr><th>Due</th><th>Program</th><th>Cycle</th><th>Scheduled On</th><th>Coach</th><th>Status</th><th></th></tr>${l.visits.slice().reverse().map(visitRow).join('')}</table>` : ''}
    </div>`;
  }).reverse().join('');
  html += `<div class="panel"><h2>Visit history${canEdit()?` <button class="btn tiny" style="float:right" onclick="generateNextCycleDlg(${client.id},${JSON.stringify(liveContracts).replace(/"/g, '&quot;')})">Extend visits</button>`:''}</h2>
    <p class="small" style="margin-bottom:10px">${visits.length} visit${visits.length===1?'':'s'} across ${laps.length} cycle${laps.length===1?'':'s'} — click a cycle to expand or fold it.</p>
    ${laps.length ? lapHtml : '<p class="small">No visits recorded yet.</p>'}</div>`;

  html += `<div class="panel"><h2>📋 Visit Notes</h2>
    <p class="small" style="margin-bottom:10px">Wins, issues and focus recorded when a visit is completed — one card per visit, grouped by contract. Use the arrows or dots to move between visits.</p>
    <div id="notesCarouselContainer">${renderNotesCarousel(st.clientProfile.client.id)}</div>
  </div>`;

  // Monthly coaching calls — separate from visits, 12 a year.
  html += coachingCallsPanel(client, notes);

  const generalNotes = notes.filter(n => n.note_type !== 'Coaching Call');
  html += `<div class="panel"><h2>General Notes</h2>
    <p class="small" style="margin-bottom:10px">Anything that isn't a visit or a monthly call — an email, a heads-up, a billing question, a change of contact. Any coach, lead, or admin can add one; only admins can edit or delete.</p>
    <div class="controls" style="margin-bottom:6px;align-items:flex-start">
      <div><label style="margin:0 0 3px;display:block">Date</label><input type="date" id="cliNoteDate" value="${TODAY}" style="width:150px"></div>
      <div style="flex:1;min-width:240px"><label style="margin:0 0 3px;display:block">Note ${micBtn('cliNoteBody')}</label><textarea id="cliNoteBody" rows="2" style="width:100%;box-sizing:border-box" placeholder="Quick note about this client…"></textarea></div>
    </div>
    <div class="dlgrow" style="margin-top:6px">
      <button class="btn primary" onclick="saveClientNote(${client.id})">Add note</button>
      ${canEdit() && client.keap_id ? `<button class="btn" onclick="keapNotesPreviewDlg(${client.id})">Import from Keap…</button>` : ''}
    </div>
    <div style="margin-top:14px">${generalNotes.length ? generalNotes.map(n=>clientNoteCard(client.id, n)).join('') : '<p class="small">No general notes yet.</p>'}</div>
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
  if(isSelf){
    // A coach's own to-do lives on Today (overdue, due soon, notes owed) — don't repeat it here.
    html += `<div class="panel"><h2>To-do${todoTotal?` (${todoTotal})`:''}</h2>
      <p class="small">${todoTotal ? `You have ${todoTotal} item${todoTotal===1?'':'s'} outstanding — ` : 'Nothing outstanding — '}your working list is on <a onclick="go('dashboard')" style="cursor:pointer"><b>Today</b></a>.</p></div>`;
  } else {
  html += `<div class="panel"><h2>To-do${todoTotal?` (${todoTotal})`:''}</h2>`;
  if(!todoTotal){
    html += `<p class="small">Nothing outstanding — no overdue stores, nothing due in the next 2 weeks, and every completed visit has a note.</p>`;
  } else {
    if(todo.overdue.length) html += `<h3 style="color:var(--bad)">Overdue (${todo.overdue.length})</h3><table><tr><th>Client</th><th>Program</th><th>Was due</th></tr>` +
      todo.overdue.map(v=>`<tr><td>${clientLink(v.client, v.client_id)}</td><td>${esc(v.program||'—')}</td><td class="mono">${fmt(v.due)}</td></tr>`).join('') + `</table>`;
    if(todo.dueSoon.length) html += `<h3>Due within 2 weeks (${todo.dueSoon.length})</h3><table><tr><th>Client</th><th>Program</th><th>Due</th></tr>` +
      todo.dueSoon.map(v=>`<tr><td>${clientLink(v.client, v.client_id)}</td><td>${esc(v.program||'—')}</td><td class="mono">${fmt(v.due)}</td></tr>`).join('') + `</table>`;
    if(todo.missingNotes.length) html += `<h3>Completed visits missing a note (${todo.missingNotes.length})</h3><table><tr><th>Client</th><th>Scheduled On</th></tr>` +
      todo.missingNotes.map(v=>`<tr><td>${clientLink(v.client, v.client_id)}</td><td class="mono">${fmt(v.scheduled_week)}</td></tr>`).join('') + `</table>`;
  }
  html += `</div>`;
  }

  html += `<div class="panel"><h2>Assigned stores</h2>` +
    (assignedClients.length ? `<table><tr><th>Client</th><th>Status</th></tr>` +
      assignedClients.map(c=>`<tr><td>${clientLink(c.name, c.id)}</td>
        <td>${c.status==='active'?'<span class="pill p-done">active</span>':c.status==='cancelled'?'<span class="pill p-over">cancelled</span>':'<span class="pill">inactive</span>'}</td></tr>`).join('') + `</table>`
      : `<p class="small">No stores currently assigned.</p>`) + `</div>`;

  if(upcoming.length){
    html += `<div class="panel"><h2>On the calendar</h2><table><tr><th>Client</th><th>Program</th><th>Due</th><th>Scheduled week</th></tr>` +
      upcoming.map(v=>`<tr><td>${clientLink(v.client, v.client_id)}</td>
        <td>${esc(v.program||'—')}</td><td class="mono">${fmt(v.due)}</td><td class="mono">${fmtW(v.cal_week)}</td></tr>`).join('') + `</table></div>`;
  }

  html += `<div class="panel"><h2>Visit history</h2>
    <p class="small" style="margin-bottom:8px">Every visit ${esc(coach.name)} has completed, credited to them permanently regardless of any later reassignment.</p>` +
    (visitHistory.length ? `<table><tr><th>Client</th><th>Program</th><th>Scheduled On</th></tr>` +
      visitHistory.map(v=>`<tr><td>${clientLink(v.client, v.client_id)}</td>
        <td>${esc(v.program||'—')}</td><td class="mono">${fmt(v.scheduled_week)}</td></tr>`).join('') + `</table>`
      : `<p class="small">No completed visits on record yet.</p>`) + `</div>`;

  html += `<div class="panel"><h2>Notes</h2>
    <p class="small" style="margin-bottom:8px">Notes ${esc(coach.name)} has logged, across all their stores.</p>` +
    (notes.length ? notes.map(n=>`<div class="duecard">
      <div class="meta"><b>${fmt(n.note_date)} — ${esc(n.note_type)}</b> · ${clientLink(n.client_name, n.client_id)}${n.source==='keap'?' <span class="pill" style="background:#e2f0f0;color:#2a6a6a">via Keap</span>':''}</div>
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

async function assignClientCoachDlg(clientName){
  console.log('assignClientCoachDlg called with clientName:', clientName);
  if(!clientName) { console.error('No clientName provided'); return; }
  
  // Try to find client from D.clients if available
  let client = D.clients ? D.clients.find(c => c.name === clientName) : null;
  
  if(!client) {
    console.log('D.clients not available or client not found, fetching all clients...');
    try {
      const allClients = await api('GET', '/api/clients?limit=999');
      console.log('Fetched clients:', allClients);
      if(allClients && allClients.length) {
        client = allClients.find(c => c.name === clientName);
      }
    } catch(e) {
      console.error('Failed to fetch clients:', e);
      uiAlert('Could not load client data. Please try again.');
      return;
    }
  }
  
  console.log('Found client:', client);
  if(!client) { console.error('Client not found by name:', clientName); uiAlert('Could not find client: ' + clientName); return; }
  
  const clientId = client.id;
  console.log('Using clientId:', clientId);
  
  const coaches = D.coaches.filter(c => c.active).sort((a,b) => (a.team+'|'+a.name).localeCompare(b.team+'|'+b.name));
  const opts = coaches.map(c => `<option value="${c.id}">${esc(c.name)} (${esc(c.team)})</option>`).join('');
  
  const dialogHtml = `<h3>Assign coach to ${esc(client.name)}</h3>
    <p class="small">This assigns the client to a coach, making them responsible for scheduling and completing visits.</p>
    <label>Coach</label>
    <select id="assignCoach" onchange="saveAssignedCoach(${clientId},this.value)">
      <option value="">— unassigned —</option>
      ${opts}
    </select>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button></div>`;
  
  console.log('Opening dialog');
  openDlg(dialogHtml);
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
/* ---------- Coaching Calls (monthly) ----------
 * Every client gets a coaching call each month — 12 a year — whether or not a visit
 * happens that month. Visit notes live on the visit row; coaching calls are
 * client_notes rows of type 'Coaching Call'. This panel shows a 12-month coverage
 * strip for one year, a quick-log form, and the calls for that year. */
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function callsYear(){ return st.callsYear || +TODAY.slice(0,4); }
function setCallsYear(y){ st.callsYear = y; st.callsMonth = null; rerenderCalls(); }
function setCallsMonth(m){ st.callsMonth = (st.callsMonth === m) ? null : m; rerenderCalls(); }
function setCallsStoreFilter(name){ st.callsStoreFilter = name; rerenderCalls(); }
function rerenderCalls(){
  const el = $('#coachingCallsPanel'); if(!el) return;
  el.outerHTML = coachingCallsPanel(st.clientProfile.client, st.clientNotes || []);
}
function coachingCallsPanel(client, notes){
  const year = callsYear();
  const calls = notes.filter(n => n.note_type === 'Coaching Call');
  const inYear = calls.filter(n => (n.note_date||'').slice(0,4) === String(year));
  const byMonth = Array.from({length:12}, () => []);
  inYear.forEach(n => { const m = +(n.note_date||'').slice(5,7) - 1; if(m >= 0 && m < 12) byMonth[m].push(n); });
  const curY = +TODAY.slice(0,4), curM = +TODAY.slice(5,7) - 1;
  const years = [...new Set(calls.map(n => +(n.note_date||'').slice(0,4)).filter(Boolean).concat([curY]))].sort((a,b)=>b-a);

  // Coverage: months up to and including the current one that have at least one call.
  const monthsElapsed = year < curY ? 12 : year > curY ? 0 : curM + 1;
  const covered = byMonth.slice(0, monthsElapsed).filter(m => m.length).length;
  const missed = byMonth.slice(0, Math.max(0, year < curY ? 12 : curM)).filter(m => !m.length).length;

  const cell = (m) => {
    const has = byMonth[m].length;
    const isCur = year === curY && m === curM;
    const isPast = year < curY || (year === curY && m < curM);
    const sel = st.callsMonth === m;
    let bg, fg, border, label;
    if(has){ bg = '#e2f4ea'; fg = '#186b45'; border = '#1e8e5a'; label = has > 1 ? `${has} calls` : 'called'; }
    else if(isCur){ bg = '#fdeecd'; fg = '#8a5b06'; border = '#c77d0a'; label = 'due'; }
    else if(isPast){ bg = '#fbe3e3'; fg = '#a12626'; border = '#c23b3b'; label = 'missed'; }
    else { bg = '#f3f2f1'; fg = '#9a9aa2'; border = 'transparent'; label = ''; }
    return `<button onclick="setCallsMonth(${m})" title="${MONTHS_SHORT[m]} ${year}${has ? ` — ${has} call${has>1?'s':''}` : ''}" style="flex:1;min-width:52px;padding:8px 4px;border-radius:8px;border:2px solid ${sel ? 'var(--ink)' : border};background:${bg};color:${fg};cursor:pointer;text-align:center;line-height:1.2">
      <div style="font-family:var(--head);font-size:11px;letter-spacing:.8px;text-transform:uppercase;font-weight:600">${MONTHS_SHORT[m]}</div>
      <div style="font-size:10.5px;margin-top:2px;min-height:12px">${label}</div>
    </button>`;
  };

  const stores = clientStoreOptions();
  const listed = (st.callsMonth != null ? byMonth[st.callsMonth] : inYear).slice()
    .filter(n => !st.callsStoreFilter || n.store === st.callsStoreFilter)
    .sort((a,b) => (b.note_date||'').localeCompare(a.note_date||'') || b.id - a.id);
  const filterNote = st.callsMonth != null ? ` · showing ${MONTHS_SHORT[st.callsMonth]} <button class="btn tiny" onclick="setCallsMonth(${st.callsMonth})">show all ${year}</button>` : '';
  // Coverage counts the group as a whole: one call in any month covers that month, whichever
  // store it was about. The store chips below filter the list, not the strip.
  const storeChip = (name, on) => `<button class="btn tiny${on?' primary':''}" onclick="setCallsStoreFilter(${name===null?'null':`'${esc(String(name)).replace(/'/g,"\\'")}'`})">${name===null?'All stores':esc(name)}</button>`;
  const storeChips = stores.length > 1 ? `<div class="dlgrow" style="margin-bottom:10px;flex-wrap:wrap">${storeChip(null, !st.callsStoreFilter)}${stores.map(nm=>storeChip(nm, st.callsStoreFilter===nm)).join('')}</div>` : '';

  return `<div class="panel" id="coachingCallsPanel"><h2>🎧 Coaching Calls</h2>
    <p class="small" style="margin-bottom:10px">One call per month, every month — including months with a visit. Log the call here; the strip shows which months of ${year} are covered.</p>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap">
      <button class="btn tiny" onclick="setCallsYear(${year-1})">‹ ${year-1}</button>
      <span style="font-family:var(--head);font-size:16px;letter-spacing:1px">${year}</span>
      <button class="btn tiny" onclick="setCallsYear(${year+1})" ${year >= curY + 1 ? 'disabled' : ''}>${year+1} ›</button>
      <span class="small" style="margin-left:6px">${year > curY ? 'Nothing due yet' : `<b style="color:${missed ? 'var(--bad)' : 'var(--ok)'}">${covered} of ${monthsElapsed}</b> month${monthsElapsed===1?'':'s'} covered${missed ? ` · <b style="color:var(--bad)">${missed} missed</b>` : ''}`}${filterNote}</span>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">${MONTHS_SHORT.map((_,m)=>cell(m)).join('')}</div>
    ${storeChips}
    <div class="controls" style="margin-bottom:6px;align-items:flex-start">
      <div><label style="margin:0 0 3px;display:block">Call date</label><input type="date" id="callDate" value="${TODAY}" style="width:150px"></div>
      ${stores.length ? `<div><label style="margin:0 0 3px;display:block">Store</label><select id="callStore" style="min-width:170px"><option value="">— whole group —</option>${stores.map(s=>`<option ${st.callsStore===s?'selected':''}>${esc(s)}</option>`).join('')}</select></div>` : ''}
      <div style="flex:1;min-width:240px"><label style="margin:0 0 3px;display:block">What was covered ${micBtn('callBody')}</label><textarea id="callBody" rows="2" style="width:100%;box-sizing:border-box" placeholder="Who you spoke with, what you covered, anything to follow up…"></textarea></div>
    </div>
    <div class="dlgrow" style="margin-bottom:12px"><button class="btn primary" onclick="saveCoachingCall(${client.id})">Log call</button></div>
    <div>${listed.length ? listed.map(n => clientNoteCard(client.id, n)).join('') : `<p class="small">No coaching calls logged for ${st.callsMonth != null ? MONTHS_SHORT[st.callsMonth] + ' ' : ''}${year}${st.callsStoreFilter ? ' at ' + esc(st.callsStoreFilter) : ''}.</p>`}</div>
  </div>`;
}
async function saveCoachingCall(clientId){
  const note_date = ($('#callDate')||{}).value || TODAY;
  const body = (($('#callBody')||{}).value || '').trim();
  const store = (($('#callStore')||{}).value || '').trim();
  if(!body){ uiAlert('Add a line about the call first'); return; }
  if(window._rec){ try{window._rec.stop()}catch(e){} window._rec=null; }
  await api('POST','/api/clients/'+clientId+'/notes', { note_date, note_type: 'Coaching Call', body, store });
  toast(store ? `Call logged — ${store}` : 'Call logged');
  // Keep the store selected: a coach logging several calls in a row is usually working
  // through one rooftop at a time.
  st.callsStore = store || null;
  st.callsYear = +note_date.slice(0,4); st.callsMonth = null;
  await loadClientProfile(clientId);
}

function clientNoteCard(clientId, n){
  const typeLabel = n.note_type === 'LID' ? 'LID note <span class="small">(legacy)</span>' : n.note_type === 'Coaching Call' ? '🎧 Coaching call' : 'Note';
  const title = `${fmt(n.note_date)} — ${typeLabel}`;
  const isAdmin = D.user.role === 'admin';
  const editedTag = n.edited ? ` <span class="small">(edited ${n.edited.slice(0,16).replace('T',' ')})</span>` : '';
  const keapTag = n.source === 'keap' ? ` <span class="pill" style="background:#e2f0f0;color:#2a6a6a">via Keap</span>` : '';
  const structured = (n.wins||n.issues||n.focus)
    ? `<div class="notestruct">
        ${n.wins?`<div class="ns ns-win"><span>Wins</span>${esc(n.wins)}</div>`:''}
        ${n.issues?`<div class="ns ns-iss"><span>Issues</span>${esc(n.issues)}</div>`:''}
        ${n.focus?`<div class="ns ns-foc"><span>Focus next</span>${esc(n.focus)}</div>`:''}
      </div>`
    : `<div style="margin-top:4px;white-space:pre-wrap" id="note-body-${n.id}">${esc(n.body)}</div>`;
  const visitTag = n.visit_id ? ` <span class="pill" style="background:var(--visit,#fde5de);color:#b93c22">visit</span>` : '';
  const storeTag = n.store ? ` <span class="pill" style="background:#e9f0fb;color:#1d4f91">🏬 ${esc(n.store)}</span>` : '';
  return `<div class="duecard" id="note-${n.id}">
    <div class="meta"><b>${title}</b>${storeTag}${visitTag}${keapTag} · ${esc(n.author_name||n.author_email)} · logged ${n.created.slice(0,16).replace('T',' ')}${editedTag}</div>
    ${structured}
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
  const note_date = ($('#cliNoteDate')||{}).value || TODAY;
  const body = (($('#cliNoteBody')||{}).value || '').trim();
  if(!body){ uiAlert('Note cannot be empty'); return; }
  if(window._rec){ try{window._rec.stop()}catch(e){} window._rec=null; }
  await api('POST','/api/clients/'+clientId+'/notes', { note_date, note_type: 'General', body });
  toast('Note added');
  await loadClientProfile(clientId);
}
function editNoteDlg(clientId, noteId){
  const n = (st.clientNotes||[]).find(x=>x.id===noteId); if(!n) return;
  openDlg(`<h3>Edit note</h3>
    <label>Date</label><input type="date" id="enDate" value="${n.note_date}">
    <label>Type</label><select id="enType"><option ${n.note_type==='Coaching Call'?'selected':''}>Coaching Call</option><option ${n.note_type==='General'?'selected':''}>General</option>${n.note_type==='LID'?'<option selected>LID</option>':''}</select>
    <p class="small" style="color:var(--muted);margin-top:2px">Moving a note to "Coaching Call" counts it toward that month's call coverage.</p>
    ${clientStoreOptions().length ? `<label>Store</label><select id="enStore"><option value="">— whole group —</option>${clientStoreOptions().map(s=>`<option ${n.store===s?'selected':''}>${esc(s)}</option>`).join('')}</select>` : ''}
    <label>Note</label><textarea id="enBody" rows="4" style="width:100%;box-sizing:border-box">${esc(n.body)}</textarea>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveEditedNote(${clientId},${noteId})">Save</button></div>`);
}
async function saveEditedNote(clientId, noteId){
  const body = $('#enBody').value.trim();
  if(!body){ uiAlert('Note cannot be empty'); return; }
  const patch = { body, note_date: $('#enDate').value, note_type: $('#enType').value };
  if($('#enStore')) patch.store = $('#enStore').value;
  await api('PATCH',`/api/clients/${clientId}/notes/${noteId}`, patch);
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
  let html=`<div class="panel"><div class="controls" style="margin-bottom:8px">${calendarSwitcher()}</div>
    <h2>${esc(c.name)} — next 16 weeks</h2><table><tr><th>Week of</th><th>Assignment</th><th>Details</th></tr>`;
  for(const w of weeks){
    const o=occ[cid+'|'+w];
    let what='<span class="pill p-done">Open</span>', det='';
    if(o&&o.type==='visit'){ what=`<b>${clientLink(o.v.client, o.v.client_id)}</b>`; det=`${esc(o.v.cycle)} ${esc(o.v.program)} · due ${fmt(o.v.due)}`; }
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
    { q: 'I completed a visit by mistake — can I undo it?', a: `Admins can undo a completion from the client's Visit History (the red 'Mark incomplete' button on the row) or from the visit's Edit dialog. Leads and coaches can't — ask an admin. The note you logged (if any) stays on the client's record either way.` },
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
    { q: 'A client cancelled — do I delete them?', a: `No — archive them (or let the app do it). When Keap reports their last contract cancelled, the client is archived that night: they drop out of the Clients list, Visit List, Today, calendars and capacity, and their open visits are removed. Everything they've done — completed visits, visit notes, coaching calls, general notes, contracts — stays on their profile, which you can still open from search or Admin → Data → Archived clients. Admins and leads can also archive by hand from the profile, and Reactivate if Keap was wrong or they come back. Delete is only for records that should never have existed.` },
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
/* ---------- Video guides (Scribe) ----------
 * Accordion of walkthroughs. The iframe src is only set when a row is opened, so a page with
 * a dozen guides doesn't load a dozen videos up front. Admins add/reorder/remove in place. */
function guidesPanel(){
  const guides = D.guides || [];
  const admin = D.user.role === 'admin';
  if(!guides.length && !admin) return '';
  const ROLE_LABEL = { admin:'Admins', lead:'Leads', sales:'Sales', coach:'Coaches' };
  const rows = guides.map((g, i) => `<details class="guide" id="guide-${g.id}" ontoggle="guideToggled(this,'${esc(g.url).replace(/'/g,'%27')}')" style="margin-bottom:8px;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff">
      <summary style="cursor:pointer;font-weight:600;padding:12px 14px;display:flex;align-items:center;gap:10px;list-style:none">
        <span style="display:inline-flex;width:26px;height:26px;border-radius:50%;background:var(--primary);color:#fff;align-items:center;justify-content:center;font-size:12px;flex:none">▶</span>
        <span style="flex:1">${esc(g.title)}</span>
        ${g.roles && g.roles.length ? `<span class="small" style="color:var(--muted);font-weight:400">${g.roles.map(r=>ROLE_LABEL[r]||r).join(' · ')}</span>` : ''}
        ${admin ? `<span style="display:inline-flex;gap:4px" onclick="event.preventDefault();event.stopPropagation()">
          <button class="btn tiny" title="Move up" onclick="guideMove('${g.id}',-1)" ${i===0?'disabled':''}>↑</button>
          <button class="btn tiny" title="Move down" onclick="guideMove('${g.id}',1)" ${i===guides.length-1?'disabled':''}>↓</button>
          <button class="btn tiny" onclick="guideDlg('${g.id}')">Edit</button>
          <button class="btn tiny danger" onclick="guideDelete('${g.id}','${esc(g.title).replace(/'/g,"\\'")}')">Remove</button></span>` : ''}
      </summary>
      <div class="guide-body" style="padding:0 14px 14px"><div class="small" style="color:var(--muted);padding:8px 0">Loading video…</div></div>
    </details>`).join('');
  return `<div class="panel"><h2>🎬 Video guides</h2>
    <p class="small" style="margin-bottom:10px">Short click-through walkthroughs of the system. Open one to play it${admin ? ' — admins can add more with the Scribe embed code' : ''}.</p>
    ${rows || '<p class="small">No guides yet.</p>'}
    ${admin ? `<div class="controls" style="margin-top:10px"><button class="btn primary" onclick="guideDlg()">＋ Add guide</button></div>` : ''}
  </div>`;
}
function guideToggled(el, url){
  const body = el.querySelector('.guide-body'); if(!body) return;
  if(el.open && !body.dataset.loaded){
    body.dataset.loaded = '1';
    body.innerHTML = `<iframe src="${url}" width="100%" height="800" allow="fullscreen" loading="lazy" style="aspect-ratio:16/12;border:0;min-height:480px;border-radius:8px;background:#f4f4f5"></iframe>`;
  }
}
function guideDlg(id){
  const g = id ? (D.guides||[]).find(x=>x.id===id) : null;
  const roles = (g && g.roles) || [];
  const chk = (r,l) => `<label class="small" style="margin-right:12px"><input type="checkbox" class="gRole" value="${r}" ${roles.includes(r)?'checked':''}> ${l}</label>`;
  openDlg(`<h3>${g ? 'Edit guide' : 'Add video guide'}</h3>
    <label>Title</label><input id="gTitle" value="${g ? esc(g.title) : ''}" placeholder="How to …">
    <label>Scribe embed</label><textarea id="gEmbed" rows="3" style="width:100%;box-sizing:border-box" placeholder="Paste the whole <iframe …> embed code from Scribe, or just the scribehow.com/embed/… link">${g ? esc(g.url) : ''}</textarea>
    <p class="small" style="color:var(--muted);margin-top:2px">In Scribe: Share → Embed → copy. The <code>?as=video</code> version plays as a movie; without it, it shows as steps.</p>
    <label>Show to</label><div style="margin:2px 0 6px">${chk('coach','Coaches')}${chk('lead','Leads')}${chk('sales','Sales')}${chk('admin','Admins')}</div>
    <p class="small" style="color:var(--muted)">Leave all unticked to show it to everyone.</p>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="guideSave(${g ? `'${g.id}'` : 'null'})">${g ? 'Save' : 'Add'}</button></div>`, {wide:true});
}
async function guideSave(id){
  const title = ($('#gTitle')||{}).value || '', embed = ($('#gEmbed')||{}).value || '';
  const roles = [...document.querySelectorAll('.gRole:checked')].map(x=>x.value);
  try{
    if(id) await api('PATCH','/api/guides/'+id,{ title, embed, roles });
    else await api('POST','/api/guides',{ title, embed, roles });
    closeDlg(); toast(id ? 'Guide updated' : 'Guide added'); await refresh();
  }catch(e){ uiAlert(e.message || 'Could not save guide'); }
}
async function guideMove(id, dir){ try{ await api('PATCH','/api/guides/'+id,{ order: dir }); await refresh(); }catch(e){ uiAlert(e.message||'Could not move'); } }
async function guideDelete(id, title){
  if(!(await uiConfirm(`Remove "${title}" from the FAQ? The Scribe itself is untouched — this only removes the link here.`,'Remove'))) return;
  try{ await api('DELETE','/api/guides/'+id); toast('Guide removed'); await refresh(); }catch(e){ uiAlert(e.message||'Could not remove'); }
}
function faqView(){
  const role = D.user.role;
  const sections = FAQ.filter(s=>s.roles.includes(role));
  let html = `<div class="panel"><h2>FAQ &amp; SOPs</h2>
    <p class="small">How this app's less-obvious features work — click a question to expand it. Sections only show if they're relevant to your role.</p></div>`;
  html += guidesPanel();
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
const ADMIN_TABS = [['people','Team & Users'],['monthend','Month-end'],['data','Data & Backups'],['history','History & Audit']];
function setAdminTab(t){ st.adminTab=t; render(); }
function adminView(){
  const tab = st.adminTab || 'people';
  let html = `<div class="controls" style="margin-bottom:14px">` +
    ADMIN_TABS.map(([k,l])=>`<button class="btn ${tab===k?'primary':''}" onclick="setAdminTab('${k}')">${l}</button>`).join('') + `</div>`;
  if(tab==='people') return html + adminPeopleView();
  if(tab==='monthend') return html + monthEndView();
  if(tab==='data') return html + adminDataView();
  return html + adminHistoryView();
}
/* ---------- Month-end reconciliation ----------
 * Sub-tab per month (current + 11 back). Three read-only sections from one API call:
 * revenue by team, coaching-call checklist, visit-note checklist. Checkmarks are derived
 * from the data, not ticked by hand. */
function monthEndPeriod(){ return st.mePeriod || TODAY.slice(0,7); }
function setMonthEnd(p){ st.mePeriod = p; st.meFilter = null; render(); }
function setMonthEndFilter(v){ st.meFilter = v || null; loadMonthEnd(); }
function monthEndView(){
  const cur = TODAY.slice(0,7);
  const months = []; { let [y,m] = cur.split('-').map(Number); for(let i=0;i<12;i++){ months.push(`${y}-${String(m).padStart(2,'0')}`); m--; if(m<1){ m=12; y--; } } }
  const sel = monthEndPeriod();
  return `<div class="panel"><h2>Month-end reconciliation</h2>
    <p class="small" style="margin-bottom:10px">Revenue by team and the two note checklists for one month. Team is whoever had the client at the start of that month. A ✓ means the note exists; it can't be ticked by hand.</p>
    <div class="controls" style="flex-wrap:wrap;gap:6px">${months.map(p=>`<button class="btn tiny ${p===sel?'primary':''}" onclick="setMonthEnd('${p}')">${monthLabel(p)}${p===cur?' <span class="small" style="opacity:.7">(in progress)</span>':''}</button>`).join('')}</div>
  </div>
  <div id="monthEndOut"><div class="panel small">Loading ${monthLabel(sel)}…</div></div>`;
}
function toggleMeTeam(team){ const el = document.getElementById('me-team-'+team.replace(/\W/g,'_')); if(el) el.style.display = el.style.display==='none' ? '' : 'none'; }
async function loadMonthEnd(){
  const out = $('#monthEndOut'); if(!out) return;
  const p = monthEndPeriod();
  try{
    const r = await api('GET','/api/admin/month-end/'+p);
    // One filter for the whole page: "team:X" or "coach:ID". Applies to all three sections.
    const f = st.meFilter || '';
    const [fk, fv] = f ? f.split(':') : [null, null];
    const teamOf = x => x.team || '(no team)';
    const pass = x => !f || (fk==='team' ? teamOf(x)===fv : String(x.coach_id||'')===fv);
    const teams = [...new Set([...r.revenue.map(t=>t.team), ...r.calls.map(teamOf), ...r.visitNotes.map(teamOf)])].sort();
    const coachMap = {}; [...r.revenue.flatMap(t=>t.rows), ...r.calls, ...r.visitNotes].forEach(x => { if(x.coach_id) coachMap[x.coach_id] = { name: x.coach || x.coach_id, team: teamOf(x) }; });
    const coachOpts = Object.entries(coachMap).sort((a,b)=>a[1].team.localeCompare(b[1].team)||a[1].name.localeCompare(b[1].name));
    const filterPick = `<select onchange="setMonthEndFilter(this.value)" style="margin-left:auto;max-width:260px">
      <option value="">All teams &amp; coaches</option>
      <optgroup label="Teams">${teams.map(t=>`<option value="team:${esc(t)}" ${f==='team:'+t?'selected':''}>Team ${esc(t)}</option>`).join('')}</optgroup>
      <optgroup label="Coaches">${coachOpts.map(([id,c])=>`<option value="coach:${esc(id)}" ${f==='coach:'+id?'selected':''}>${esc(c.name)} · ${esc(c.team)}</option>`).join('')}</optgroup></select>`;

    const rev = r.revenue.map(t => ({ ...t, rows: t.rows.filter(pass) })).filter(t => t.rows.length);
    const revTotal = rev.reduce((s,t)=>s+t.rows.reduce((a,x)=>a+(x.price||0),0),0);
    const calls = r.calls.filter(pass), vn = r.visitNotes.filter(pass);
    const pct = (a,b) => b ? Math.round(100*a/b) : 0;
    const tick = d => d ? '<span style="display:inline-flex;width:20px;height:20px;border-radius:50%;background:#1e8e5a;color:#fff;align-items:center;justify-content:center;font-size:12px;font-weight:700">✓</span>' : '<span style="display:inline-flex;width:20px;height:20px;border-radius:50%;border:2px solid #c23b3b;background:#fbe3e3;align-items:center;justify-content:center"></span>';
    const cd = calls.filter(c=>c.done).length, vd = vn.filter(v=>v.done).length, sheetN = vn.filter(v=>v.kind==='sheet').length;

    let h = `<div class="panel" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 16px"><b>Showing:</b> <span>${f ? (fk==='team' ? 'Team '+esc(fv) : esc((coachMap[fv]||{}).name||fv)) : 'everyone'}</span>${filterPick}</div>
    <div class="cards" style="margin-bottom:14px">
      <div class="card"><div class="k">${fmtMoney(revTotal)}</div><div class="l">Monthly revenue · ${monthLabel(p)}</div></div>
      <div class="card ${cd===calls.length?'ok':'warn'}"><div class="k">${cd}<span class="small" style="font-size:16px;color:var(--muted)"> / ${calls.length}</span></div><div class="l">Coaching calls logged · ${pct(cd,calls.length)}%</div></div>
      <div class="card ${vd===vn.length?'ok':'warn'}"><div class="k">${vd}<span class="small" style="font-size:16px;color:var(--muted)"> / ${vn.length}</span></div><div class="l">Visits written up · ${pct(vd,vn.length)}%</div></div>
    </div>`;

    // Revenue: one accordion row per team → clients with coach, program, price
    h += `<div class="panel"><h2>Revenue by team</h2>
      <p class="small" style="margin-bottom:8px">Sum of each active contract's monthly-equivalent price (from Keap), attributed to the team that held the client at the start of ${monthLabel(p)}. Click a team to see every client behind the number.</p>
      <table><tr><th style="width:22px"></th><th>Team</th><th class="num">Clients</th><th class="num">Contracts</th><th class="num">Monthly revenue</th><th class="num">Share</th><th></th></tr>` +
      rev.map(t => {
        const sub = t.rows.reduce((a,x)=>a+(x.price||0),0), unpriced = t.rows.filter(x=>x.price==null).length, key = t.team.replace(/\W/g,'_');
        return `<tr style="cursor:pointer" onclick="toggleMeTeam('${esc(t.team).replace(/'/g,"\\'")}')"><td style="color:var(--muted)">▸</td><td><b>Team ${esc(t.team)}</b></td><td class="num">${new Set(t.rows.map(x=>x.client_id)).size}</td><td class="num">${t.rows.length}</td><td class="num"><b>${fmtMoney(sub)}</b></td><td class="num">${pct(sub, revTotal)}%</td>
          <td class="small" style="color:var(--warn)">${unpriced?`${unpriced} with no price yet`:''}</td></tr>
        <tr id="me-team-${key}" style="display:none"><td></td><td colspan="6" style="padding:0 0 10px">
          <table style="width:100%;margin:0"><tr><th>Client</th><th>Coach</th><th>Program</th><th class="num">Monthly</th></tr>` +
          t.rows.map(x=>`<tr><td>${clientLink(x.client, x.client_id)}</td><td class="small">${esc(x.coach||'—')}</td><td class="small">${esc(x.program||'—')}${x.status==='cancelled'?' <span class="pill" style="background:#f0f0f1;color:#55555c">cancelled in month</span>':''}</td><td class="num">${x.price==null?'<span class="small" style="color:var(--warn)">no price</span>':fmtMoney(x.price)}</td></tr>`).join('') +
          `</table></td></tr>`; }).join('') +
      `<tr style="border-top:2px solid var(--ink)"><td></td><td><b>Total</b></td><td class="num">${new Set(rev.flatMap(t=>t.rows.map(x=>x.client_id))).size}</td><td class="num">${rev.reduce((s,t)=>s+t.rows.length,0)}</td><td class="num"><b>${fmtMoney(revTotal)}</b></td><td class="num">100%</td><td></td></tr></table></div>`;

    h += `<div class="panel"><h2>Coaching calls · ${monthLabel(p)} <span class="small" style="font-family:inherit;font-weight:400;letter-spacing:0;text-transform:none">${cd} of ${calls.length} logged</span></h2>
      <p class="small" style="margin-bottom:8px">One call per active client per month. ✓ = a Coaching Call note dated in ${monthLabel(p)} exists on the client. Unlogged first.</p>
      <div style="max-height:420px;overflow:auto"><table style="width:100%"><tr><th style="width:32px"></th><th>Client</th><th>Team</th><th>Coach</th><th>Logged</th><th></th></tr>` +
      calls.map(c=>`<tr><td>${tick(c.done)}</td><td>${clientLink(c.client, c.client_id)}</td><td class="small">${esc(c.team||'—')}</td><td class="small">${esc(c.coach||'—')}</td>
        <td class="small">${c.done ? `${c.calls>1?c.calls+' calls · ':''}last ${fmt(c.last)}` : '<span style="color:var(--bad)">none</span>'}</td>
        <td>${c.done?'':`<button class="btn tiny" onclick="logCallDlg(${c.client_id},'${esc(c.client).replace(/'/g,"\\'")}','${p}')">Log call</button>`}</td></tr>`).join('') + `</table></div></div>`;

    const stateLabel = { done:'', no_notes:'<span class="pill p-due">Completed, no notes</span>', not_marked_done:'<span class="pill p-over">Not marked done</span>',
      upcoming:'<span class="pill p-cal">Upcoming</span>', not_tracked:'<span class="pill" style="background:#f0f0f1;color:#55555c" title="Imported from the 2026 sheet as a calendar block. Not a visit record, so notes can\'t be written on it until Sheet Recon converts it.">Sheet visit · not tracked</span>' };
    h += `<div class="panel"><h2>Visit notes · ${monthLabel(p)} <span class="small" style="font-family:inherit;font-weight:400;letter-spacing:0;text-transform:none">${vd} of ${vn.length} written up</span></h2>
      <p class="small" style="margin-bottom:8px">Every visit completed in ${monthLabel(p)} or on a calendar week that touches it — the same LIDs the global calendar shows. ✓ = wins, issues, focus or commitments were written. Missing first.</p>
      ${sheetN ? `<div style="background:#f0f0f1;border-left:5px solid #9a9aa2;padding:8px 12px;margin-bottom:10px" class="small"><b>${sheetN}</b> of these are 2026-sheet calendar blocks, not visit records — they can never be ticked here. Admin → Data → <b>Sheet Recon 2026</b> maps them onto real visits.</div>` : ''}
      <div style="max-height:480px;overflow:auto"><table style="width:100%"><tr><th style="width:32px"></th><th>Client</th><th>Visit</th><th>When</th><th>Team</th><th>Coach</th><th>Status</th><th></th></tr>` +
      vn.map(v=>`<tr${v.kind==='sheet'?' style="color:var(--muted)"':''}><td>${tick(v.done)}</td><td>${v.client_id ? clientLink(v.client, v.client_id) : `<span title="No client matched this sheet label">${esc(v.client)}</span> <span class="small">(unmatched)</span>`}</td>
        <td class="small">${v.kind==='sheet' ? '<i>from sheet</i>' : `${esc(v.cycle||'')} ${esc(v.program||'')}`}</td><td class="mono small">${v.kind==='sheet' || !v.completed ? 'wk of '+fmtW(v.when) : fmt(v.when)}</td>
        <td class="small">${esc(v.team||'—')}</td><td class="small">${esc(v.coach||'—')}</td><td>${stateLabel[v.state]||''}</td>
        <td>${v.done || !v.id ? '' : `<button class="btn tiny" onclick="openVisitModal(${v.id})">Open</button>`}</td></tr>`).join('') + `</table></div></div>`;
    out.innerHTML = h;
  }catch(e){ out.innerHTML = `<div class="panel small" style="color:var(--bad)">Could not load: ${esc(e.message||e)}</div>`; }
}
function teamInfoFor(name){ return (D.teamInfo||[]).find(x=>x.name===name) || { name, lead_coach_id:null, lead_name:null }; }
function adminPeopleView(){
  const issues = D.leadIssues || { noLead:[], strayLeads:[] };
  let html=`<div class="panel"><h2>Teams &amp; coaches</h2>
    <p class="small" style="margin-bottom:8px">Every team has exactly one lead. The lead's login is a <b>lead</b> role and their coach record sits on the team they lead — both follow from the pick below, so there is nothing to keep in sync by hand.</p>
    ${issues.strayLeads.length ? `<div style="background:#fdeecd;border-left:5px solid #c77d0a;padding:10px 14px;margin-bottom:10px" class="small">⚠ <b>Lead login, no team:</b> ${issues.strayLeads.map(u=>esc(u.name||u.email)).join(', ')} — role says lead but they don't lead a team. Set their team's lead below, or change the role in Users.</div>` : ''}
    <div class="controls"><button class="btn primary" onclick="coachDlg()">＋ Add coach</button>
    <button class="btn" onclick="teamDlg()">＋ Add team</button></div>`;
  for(const t of D.teams){
    const members=D.coaches.filter(c=>c.team===t);
    const info = teamInfoFor(t);
    const leadPick = `<select onchange="setTeamLead('${esc(t).replace(/'/g,"\\'")}',this.value)" title="Who leads this team">
        <option value="">${info.lead_coach_id ? '— remove lead —' : '— pick a lead —'}</option>
        ${members.filter(c=>c.active).map(c=>`<option value="${c.id}" ${c.id===info.lead_coach_id?'selected':''}>${esc(c.name)}</option>`).join('')}</select>`;
    html+=`<h3 style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">Team ${esc(t)} <span class="small" style="font-weight:400">(${members.length})</span>
      <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;background:${info.lead_coach_id?'#e2f4ea':'#fbe3e3'};color:${info.lead_coach_id?'#186b45':'#a12626'};font-size:12px">${info.lead_coach_id ? `★ Lead: <b>${esc(info.lead_name||'')}</b>` : '⚠ No lead'}</span>
      ${leadPick}
      <span style="flex:1"></span>
      <button class="btn tiny" onclick="renameTeamDlg('${esc(t).replace(/'/g,"\\'")}')">Rename</button>
      ${members.length?'':`<button class="btn tiny danger" onclick="deleteTeam('${esc(t).replace(/'/g,"\\'")}')">Delete</button>`}
    </h3><table><tr><th>Coach</th><th class="num">Future visits</th><th>Move to</th><th></th></tr>`;
    members.forEach(c=>{
      const fv=D.visits.filter(v=>!v.completed&&v.cal_coach===c.id&&v.cal_week>=TODAY).length;
      const isLead = c.id===info.lead_coach_id;
      html+=`<tr><td><a onclick="openCoachProfile('${c.id}')" style="cursor:pointer;color:var(--ink);text-decoration:none;display:flex;align-items:center;gap:8px">${avatarHtml(c.name,c.team,26)}<b style="text-decoration:underline;color:var(--primary)">${esc(c.name)}</b>${isLead?' <span title="Team lead" style="color:#c77d0a">★</span>':''}</a></td><td class="num">${fv}</td>
        <td>${isLead ? `<span class="small" style="color:var(--muted)" title="Pick a new lead for Team ${esc(t)} first">leads this team</span>` : `<select onchange="moveCoach('${c.id}',this.value)"><option></option>${D.teams.filter(x=>x!==t).map(x=>`<option>${x}</option>`).join('')}</select>`}</td>
        <td><button class="btn tiny danger" onclick="removeCoach('${c.id}','${esc(c.name)}')" >Deactivate</button></td></tr>`;
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
  <p class="small" style="margin-bottom:12px">Every night (around 3-4am Eastern) the app checks Keap-linked contracts for drift, keeps every active contract's repeating cycle populated 12 months out (never touching completed visits or deleting anything — purely adds what's missing), snapshots the revenue total, purges any client past its 30-day
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
  <div class="panel"><h2>Cycle order</h2>
  <p class="small" style="margin-bottom:12px">One hard rule: "3 of 12" can't be placed while "2 of 12" is still unscheduled (admins can override with a logged reason). A visit is never tied to its due month — any week is allowed. Weeks that leapfrog a neighbour (a later visit placed in an earlier week) are allowed but listed here as advisory, alongside anything that slipped past the hard rule, so you can review and re-place if you want to.</p>
  <div class="controls"><button class="btn" onclick="loadOutOfOrder()">Refresh</button></div>
  <div id="outOfOrderOut" class="small">Loading…</div></div>
  <div class="panel"><h2>Archived clients</h2>
  <p class="small" style="margin-bottom:12px">Clients who've left. Archiving happens automatically when Keap reports their last contract cancelled, and nightly for any client with <b>no active contract</b> who is marked cancelled or inactive or whose 30-day notice has lapsed — a client with a live contract is never archived automatically, whatever their status says. Or by hand from a profile. History is kept; open visits were removed. Reactivate if Keap was wrong or they come back.</p>
  <div id="archivedOut" class="small">Loading…</div></div>
  <div class="panel"><h2>Recently deleted</h2>
  <p class="small" style="margin-bottom:12px">Clients deleted in the last 30 days — restorable here. After 30 days they're purged for good by the nightly job.</p>
  <div id="deletedOut" class="small">Loading…</div></div>
  <div class="panel"><h2>Rolling schedule</h2>
  <p class="small" style="margin-bottom:12px">Keeps every active contract's repeating cycle populated through <b>Dec 31 of next calendar year</b> — never touches completed history or deletes anything, only adds visits past whatever's already there, wrapping the cycle counter back to 1 after the last visit. <b>Runs live every night</b> (since Sep 14, 2026); the nightly summary email lists what was added. Preview shows anything it would add right now; Apply runs it immediately instead of waiting for tonight. Per-client, the "Extend visits" button on a client's Visit History does the same thing for one contract.</p>
  <div class="controls"><button class="btn primary" onclick="loadRollingSchedulePreview()">Preview</button>
  <button class="btn danger" id="rollingApplyBtn" onclick="applyRollingSchedule()" disabled>Apply (run a Preview first)</button></div>
  <div id="rollingScheduleOut" class="small">Click Preview to see what this would add.</div></div>
  <div class="panel"><h2>Visits on the wrong team</h2>
  <p class="small" style="margin-bottom:12px">Open visits whose team label doesn't match the coach responsible for them — the coach on the calendar if it's placed, otherwise the client's assigned coach. These show up in the wrong lead's to-schedule list, and the right lead can get "Not your team" trying to place them. Usual cause: a coach moved teams and their unplaced visits kept the old label, then the rolling generator copied it forward. Read-only until you click Fix; the fix only relabels open visits to their coach's current team — completed history is never touched.</p>
  <div class="controls"><button class="btn" onclick="loadTeamMismatchAudit()">Refresh</button></div>
  <div id="teamMismatchOut" class="small">Loading…</div></div>
  <div class="panel"><h2>Duplicate visits</h2>
  <p class="small" style="margin-bottom:12px">Finds not-yet-scheduled visits sitting on the same contract as an already-completed visit with the exact same cycle number (e.g. two "2 of 4"s) — that combination is always a stray leftover, most likely from the original spreadsheet import, never a legitimate visit. This is read-only until you click Clean up below, and only ever deletes visits matching this exact pattern — nothing else.</p>
  <div class="controls"><button class="btn" onclick="loadDuplicateVisitsAudit()">Refresh</button></div>
  <div id="dupVisitsOut" class="small">Loading…</div></div>
  <div class="panel"><h2>Phantom contracts</h2>
  <p class="small" style="margin-bottom:12px">Finds contracts sitting in pairs — same client, same program, same start date — where one is the real, priced, Keap-linked contract and the other is an unpriced, unlinked shell created by a past sheet import that never checked for the existing contract before inserting a new one (the Suski Chevrolet Buick pattern, found 2026-08-25). Clean up first moves any visits sitting on the shell onto the real contract, then archives the shell — it is never deleted, and can be restored from a client's profile at any time. Pairs where BOTH contracts are unpriced/unlinked (no single "real" one to prefer) are listed separately below and are never touched automatically.</p>
  <div class="controls"><button class="btn" onclick="loadPhantomContractsAudit()">Refresh</button></div>
  <div id="phantomContractsOut" class="small">Loading…</div></div>
  <div class="panel"><h2>Contract splits</h2>
  <p class="small" style="margin-bottom:12px">Finds clients with 2+ active contracts at once — a broader, more careful check than Phantom contracts above: it doesn't require the same program/start-date, and rather than just archiving one side, it actually folds a secondary contract into the primary — moving its visits (renumbering any not-yet-completed cycle so the merged history reads as one coherent sequence, and dropping any that would collide within 45 days of another), and carrying over its Keap link/price/first-pay-date wherever the primary is missing one. Not every split found here should be merged — a client can legitimately have two separate, active subscriptions. Review each one before merging; nothing merges automatically.</p>
  <div class="controls"><button class="btn" onclick="loadContractSplitsAudit()">Refresh</button></div>
  <div id="contractSplitsOut" class="small">Loading…</div></div>
  <div class="panel"><h2>Orphaned visits</h2>
  <p class="small" style="margin-bottom:12px">Visits with no contract_id at all — usually old sheet-import rows that were never linked to a contract. "High confidence" means the client has exactly one contract with a matching program, so linking it is unambiguous; those are the only ones Link auto-links. "Ambiguous" (2+ matching contracts) and "None" (no matching program) are listed for you to look at directly and are never touched automatically.</p>
  <div class="controls"><button class="btn" onclick="loadOrphanedVisitsAudit()">Refresh</button></div>
  <div id="orphanedVisitsOut" class="small">Loading…</div></div>
  <div class="panel"><h2>Cadence changes (vs. Keap)</h2>
  <p class="small" style="margin-bottom:12px">For every active Keap-linked contract, checks whether Keap's subscription now implies a different visit cadence than what's stored (e.g. a client that moved from Monthly to Quarterly billing). Detection only — nothing here ever rewrites a schedule automatically, since a wrong auto-apply would silently reshuffle a client's whole calendar. Fix a flagged one from that client's profile using the existing "Regenerate schedule" button, which re-spaces the remaining visits from today.</p>
  <div class="controls"><button class="btn" onclick="loadCadenceChangeAudit()">Check against Keap</button></div>
  <div id="cadenceChangeOut" class="small">Click Check to run (calls Keap for every linked contract — takes a few seconds).</div></div>
  <div class="panel"><h2>2026 Schedule reconciliation</h2>
  <p class="small" style="margin-bottom:12px">The 2026 Schedule sheet is the source of truth for this year's visits. This maps every "from sheet" 2026 calendar visit onto the matching contract's cadence cycle — <b>place</b> where a real visit lines up with a cycle, <b>extra</b> where the sheet has more than the cadence, <b>carryover</b> for 2025 make-ups, and it flags cadence cycles with no sheet visit. <b>Read-only</b> — nothing is written here. Review it before we turn on the apply.</p>
  <div class="controls"><button class="btn" onclick="loadSheetRecon2026()">Refresh</button></div>
  <div id="sheetReconOut" class="small">Loading…</div></div>
  <div class="panel"><h2>Re-sync 2026 schedule from CSV</h2>
  <p class="small" style="margin-bottom:12px">Upload the current <b>2026 Schedule</b> CSV to bring the app in line with the master sheet. It applies the rule that <b>two coaches on the same client the same week count as one visit</b> (the lead holds the real card), so double-booked weeks stop consuming two cadence cycles. <b>Read-only preview</b> — nothing is written yet.</p>
  <div class="controls"><input type="file" id="sheetCsvFile" accept=".csv,text/csv">
    <button class="btn primary" onclick="importSheet2026()">Import &amp; preview</button>
    <button class="btn" onclick="loadResyncPreview()">Refresh</button></div>
  <div id="resyncOut" class="small" style="margin-top:8px">No CSV imported yet.</div></div>
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
      `<table><tr><th>Coach</th><th>Team</th><th></th></tr>` +
      rows.map(c=>`<tr><td><a onclick="openCoachProfile('${c.id}')" style="cursor:pointer;color:var(--primary);text-decoration:underline">${esc(c.name)}</a></td><td>${esc(c.team)}</td><td><button class="btn tiny primary" onclick="reactivateCoach('${c.id}','${esc(c.name).replace(/'/g,"\\'")}')">Reactivate</button></td></tr>`).join('') +
      `</table>` : `<p>None.</p>`;
  }catch(e){ $('#formerCoachesOut').innerHTML = '<p>Could not load.</p>'; }
}
async function reactivateCoach(coachId, coachName){
  if(!confirm(`Reactivate ${coachName}? They'll be eligible for new assignments.`)) return;
  try{
    const res = await api('POST',`/api/coaches/${coachId}/reactivate`);
    if(res && res.ok){
      toast('Coach reactivated');
      D.coaches = await api('GET','/api/coaches');
      loadFormerCoaches();
      refresh();
    } else {
      toast('Reactivation failed: ' + (res?.message || 'Unknown error'), 'error');
    }
  }catch(e){ toast('Reactivation failed: ' + e.message, 'error'); }
}
async function loadCancelledContracts(){
  try{
    const rows = await api('GET','/api/keap/cancelled-contracts');
    $('#cancelledOut').innerHTML = rows.length ? `<table><tr><th>Client</th><th>Team</th><th>Program</th></tr>` +
      rows.map(r=>`<tr><td>${esc(r.client_name)}</td><td>${esc(r.team||'—')}</td><td>${esc(r.program||'—')}</td></tr>`).join('') + `</table>`
      : `<p>None yet.</p>`;
  }catch(e){ $('#cancelledOut').innerHTML = '<p>Could not load.</p>'; }
}
let _rollingPreviewCount = 0;
async function loadRollingSchedulePreview(){
  $('#rollingScheduleOut').innerHTML = 'Loading…';
  $('#rollingApplyBtn').disabled = true;
  try{
    const r = await api('GET','/api/admin/rolling-schedule/preview');
    _rollingPreviewCount = r.totalCreated;
    if(!r.totalCreated){
      $('#rollingScheduleOut').innerHTML = '<p>Nothing to add — every active contract already has the next 12 months populated. ✔</p>';
      return;
    }
    $('#rollingScheduleOut').innerHTML = `<p><b>${r.totalCreated} visit(s)</b> would be added across ${r.perClient.length} contract(s) (${r.contractsChecked} active contract(s) checked):</p>
      <table><tr><th>Client</th><th>Program</th><th>Would add</th></tr>` +
      r.perClient.map(c=>`<tr><td>${clientLink(c.client, c.clientId)}</td>
        <td>${esc(c.program||'—')}</td>
        <td class="small">${c.visits.map(v=>`${esc(v.cycle)} (due ${fmt(v.due)})`).join(', ')}</td></tr>`).join('') +
      `</table>
      ${r.capped.length?`<p class="small" style="color:var(--bad)">⚠ Hit the safety cap (over a decade stale — needs a manual look, list above may be incomplete for): ${esc(r.capped.join(', '))}</p>`:''}`;
    const btn = $('#rollingApplyBtn'); btn.disabled = false; btn.textContent = `Apply — create ${r.totalCreated} visit(s)`;
  }catch(e){ $('#rollingScheduleOut').innerHTML = '<p>Could not load.</p>'; }
}
async function applyRollingSchedule(){
  if(!(await uiConfirm(`Create ${_rollingPreviewCount} visit(s) across every active contract that needs them, exactly as shown in the preview? This can be cleaned up afterward with Delete/Regenerate if anything looks wrong, but it's a real write to every active contract at once.`,'Apply'))) return;
  try{
    const r = await api('POST','/api/admin/rolling-schedule/run-now',{});
    toast(`Created ${r.totalCreated} visit(s) across ${r.perClient.length} contract(s)`);
    await refresh(); await loadRollingSchedulePreview();
  }catch(e){ uiAlert(e.message||'Apply failed'); }
}
async function loadTeamMismatchAudit(){
  try{
    const r = await api('GET','/api/admin/team-mismatch-audit');
    if(!r.count){ $('#teamMismatchOut').innerHTML = '<p>None found. ✔ Every open visit is labelled with its coach\'s team.</p>'; return; }
    const pairs = Object.entries(r.byTeamPair).sort((a,b)=>b[1]-a[1]).map(([k,n])=>`<span class="pill" style="margin-right:6px">${esc(k)} · ${n}</span>`).join('');
    $('#teamMismatchOut').innerHTML = `<p><b>${r.count} open visit(s)</b> carry the wrong team label.</p><p style="margin:6px 0 10px">${pairs}</p>
      <div style="max-height:360px;overflow:auto"><table><tr><th>Client</th><th>Visit</th><th>Due</th><th>Coach</th><th>Says</th><th>Should be</th></tr>` +
      r.rows.slice(0,200).map(v=>`<tr><td>${clientLink(v.client, v.client_id)}</td>
        <td class="small">${esc(v.cycle||'')} ${esc(v.program||'')}</td><td class="mono">${fmt(v.due)}</td>
        <td>${esc(v.coach)} <span class="small" style="color:var(--muted)">(${v.via})</span></td>
        <td><span class="pill p-over">${esc(v.visit_team||'—')}</span></td><td><span class="pill p-ok">${esc(v.coach_team)}</span></td></tr>`).join('') +
      `</table></div>${r.count>200?`<p class="small">Showing first 200 of ${r.count}.</p>`:''}
      <div class="controls" style="margin-top:10px"><button class="btn primary" onclick="repairTeamMismatches(${r.count})">Fix all ${r.count} — relabel to coach's team</button></div>`;
  }catch(e){ $('#teamMismatchOut').innerHTML = '<p>Could not load.</p>'; }
}
async function repairTeamMismatches(n){
  if(!(await uiConfirm(`Relabel ${n} open visit(s) to their coach's current team? Completed visits are not touched. Each one will move to the correct lead's lists.`,'Fix teams'))) return;
  try{ const r = await api('POST','/api/admin/team-mismatch-repair',{}); toast(`Relabelled ${r.fixed} visit(s)`); await refresh(); await loadTeamMismatchAudit(); }
  catch(e){ uiAlert(e.message||'Repair failed'); }
}
async function loadDuplicateVisitsAudit(){
  try{
    const r = await api('GET','/api/admin/duplicate-visits-audit');
    if(!r.count){ $('#dupVisitsOut').innerHTML = '<p>None found. ✔</p>'; return; }
    $('#dupVisitsOut').innerHTML = `<p><b>${r.count} stray visit(s)</b> across ${r.contracts.length} contract(s):</p>
      <table><tr><th>Client</th><th>Program</th><th>Duplicate cycles</th></tr>` +
      r.contracts.map(c=>`<tr><td>${clientLink(c.client, c.clientId)}</td>
        <td>${esc(c.program||'—')}</td>
        <td class="small">${c.duplicates.map(d=>`${esc(d.cycle)} (due ${fmt(d.due)})`).join(', ')}</td></tr>`).join('') +
      `</table>
      <div class="controls" style="margin-top:10px"><button class="btn danger" onclick="cleanupDuplicateVisits(${r.count})">Clean up all ${r.count} stray visit(s)</button></div>`;
  }catch(e){ $('#dupVisitsOut').innerHTML = '<p>Could not load.</p>'; }
}
async function cleanupDuplicateVisits(expectedCount){
  if(!(await uiConfirm(`Delete ${expectedCount} stray duplicate visit(s) across every client? Each one is a not-yet-scheduled visit whose cycle number is already completed under the same contract — this can't be undone.`,'Clean up'))) return;
  try{
    const r = await api('POST','/api/admin/duplicate-visits-cleanup',{});
    toast(`Deleted ${r.deleted} stray visit(s) across ${r.affectedContracts.length} contract(s)`);
    await refresh(); await loadDuplicateVisitsAudit();
  }catch(e){ uiAlert(e.message||'Cleanup failed'); }
}
async function loadPhantomContractsAudit(){
  try{
    const r = await api('GET','/api/admin/phantom-contracts-audit');
    let h = '';
    if(!r.count) h += '<p>None found. ✔</p>';
    else h += `<p><b>${r.count} phantom contract(s)</b> ready to merge:</p>
      <table><tr><th>Client</th><th>Program</th><th>Started</th><th>Real contract</th><th>Shell</th></tr>` +
      r.pairs.map(p=>`<tr><td>${clientLink(p.client, p.clientId)}</td>
        <td>${esc(p.program||'—')}</td><td class="mono">${fmt(p.startDate)}</td>
        <td class="small">#${p.realContractId} — $${p.realPrice} <span class="mono">${esc(p.realKeap)}</span></td>
        <td class="small">#${p.shellContractId}</td></tr>`).join('') +
      `</table>
      <div class="controls" style="margin-top:10px"><button class="btn danger" onclick="cleanupPhantomContracts(${r.count})">Merge &amp; archive all ${r.count} phantom(s)</button></div>`;
    if(r.manualReviewCount){
      h += `<p style="margin-top:14px"><b>${r.manualReviewCount} pair(s) need manual review</b> — both contracts are unpriced/unlinked, so there's no clear "real" one to keep:</p>
        <table><tr><th>Client</th><th>Program</th><th>Started</th><th>Contract IDs</th></tr>` +
        r.manualReview.map(g=>`<tr><td>${clientLink(g.client, g.clientId)}</td>
          <td>${esc(g.program||'—')}</td><td class="mono">${fmt(g.startDate)}</td>
          <td class="small">${g.contractIds.map(id=>'#'+id).join(', ')}</td></tr>`).join('') +
        `</table>`;
    }
    $('#phantomContractsOut').innerHTML = h;
  }catch(e){ $('#phantomContractsOut').innerHTML = '<p>Could not load.</p>'; }
}
async function cleanupPhantomContracts(expectedCount){
  if(!(await uiConfirm(`Merge & archive ${expectedCount} phantom contract(s)? Any visits sitting on a shell move onto its matching real contract first, then the shell is archived — not deleted, and restorable from that client's profile at any time.`,'Merge & archive'))) return;
  try{
    const r = await api('POST','/api/admin/phantom-contracts-cleanup',{});
    toast(`Archived ${r.archived} phantom contract(s), moved ${r.visitsMoved} visit(s)`);
    await refresh(); await loadPhantomContractsAudit();
  }catch(e){ uiAlert(e.message||'Cleanup failed'); }
}
async function loadContractSplitsAudit(){
  try{
    const r = await api('GET','/api/admin/contract-splits-audit');
    if(!r.count){ $('#contractSplitsOut').innerHTML = '<p>None found. ✔</p>'; return; }
    $('#contractSplitsOut').innerHTML = `<p><b>${r.count} client(s)</b> with 2+ active contracts:</p>
      <table><tr><th>Client</th><th>Primary (kept)</th><th>Secondary (would fold in)</th><th></th></tr>` +
      r.rows.map(g=>`<tr><td>${clientLink(g.client, g.clientId)}</td>
        <td class="small">#${g.primary.contractId} ${esc(g.primary.program||'—')} ${g.primary.price?'$'+g.primary.price:''} ${g.primary.keapSubscriptionId?`<span class="mono">${esc(g.primary.keapSubscriptionId)}</span>`:''} (${g.primary.visits} visits)</td>
        <td class="small">${g.moveFrom.map(o=>`#${o.contractId} ${esc(o.program||'—')}${o.wouldMove.length?' — would move: '+o.wouldMove.join(', '):' — nothing to move'}`).join('<br>')}</td>
        <td><button class="btn tiny" onclick='contractSplitPreviewDlg(${g.clientId},${g.primary.contractId},${JSON.stringify(g.moveFrom.map(o=>o.contractId))},"${esc(g.client).replace(/"/g,'&quot;')}")'>Review merge</button></td>
        </tr>`).join('') +
      `</table>`;
  }catch(e){ $('#contractSplitsOut').innerHTML = '<p>Could not load.</p>'; }
}
async function contractSplitPreviewDlg(clientId, primaryId, secondaryIds, clientName){
  let plan;
  try{ plan = await api('POST','/api/admin/contract-splits/preview',{clientId,primaryId,secondaryIds}); }
  catch(e){ uiAlert(e.message||'Preview failed'); return; }
  const moves = [
    plan.keapMove ? `Keap subscription <span class="mono">${esc(plan.keapMove.keapSubscriptionId)}</span> moves onto the primary` : null,
    plan.priceMove ? `Price $${plan.priceMove.price} moves onto the primary` : null,
    plan.firstPayMove ? `First-pay date ${fmt(plan.firstPayMove.firstPayDate)} moves onto the primary` : null,
  ].filter(Boolean);
  openDlg(`<h3>Merge contracts — ${esc(clientName)}</h3>
    <p class="small">Primary: contract #${plan.primaryId}. Folding in: ${plan.secondaryIds.map(id=>'#'+id).join(', ')}.</p>
    ${moves.length?`<ul class="small">${moves.map(m=>`<li>${m}</li>`).join('')}</ul>`:'<p class="small">Nothing to carry over onto the primary — it already has price/Keap link/first-pay date.</p>'}
    <p class="small">${plan.completed.length} completed visit(s) move over unchanged. ${plan.relabeled.length} not-yet-completed visit(s) get renumbered to read as one continuous cycle.${plan.dropped.length?` ${plan.dropped.length} visit(s) that would collide within 45 days of another are dropped (the calendar-placed one wins).`:''}</p>
    <p class="small" style="color:var(--muted)">The secondary contract(s) are marked completed with a permanent link to the primary — never deleted.</p>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
      <button class="btn danger" onclick='applyContractSplitMerge(${clientId},${primaryId},${JSON.stringify(secondaryIds)})'>Merge</button></div>`);
}
async function applyContractSplitMerge(clientId, primaryId, secondaryIds){
  try{
    const r = await api('POST','/api/admin/contract-splits/apply',{clientId,primaryId,secondaryIds});
    closeDlg();
    toast(`Merged ${r.plan.secondaryIds.length} contract(s) into #${r.plan.primaryId}`);
    await refresh(); await loadContractSplitsAudit();
  }catch(e){ uiAlert(e.message||'Merge failed'); }
}
async function loadOrphanedVisitsAudit(){
  try{
    const r = await api('GET','/api/admin/orphaned-visits-audit');
    if(!r.count){ $('#orphanedVisitsOut').innerHTML = '<p>None found. ✔</p>'; return; }
    $('#orphanedVisitsOut').innerHTML = `<p><b>${r.count} orphaned visit(s)</b> — ${r.byConfidence.high} high confidence, ${r.byConfidence.ambiguous} ambiguous, ${r.byConfidence.none} no match:</p>
      <table><tr><th>Client</th><th>Program</th><th>Due</th><th>Confidence</th><th>Reason</th></tr>` +
      r.rows.map(v=>`<tr><td>${clientLink(v.client, v.clientId)}</td>
        <td>${esc(v.program||'—')}</td><td class="mono">${fmt(v.due)}</td>
        <td>${v.confidence==='high'?'<span class="pill p-done">high</span>':v.confidence==='ambiguous'?'<span class="pill p-due">ambiguous</span>':'<span class="pill p-over">none</span>'}</td>
        <td class="small">${esc(v.reason)}</td></tr>`).join('') +
      `</table>
      ${r.byConfidence.high?`<div class="controls" style="margin-top:10px"><button class="btn" onclick="applyOrphanedVisitsLink(${r.byConfidence.high})">Link all ${r.byConfidence.high} high-confidence visit(s)</button></div>`:''}`;
  }catch(e){ $('#orphanedVisitsOut').innerHTML = '<p>Could not load.</p>'; }
}
async function applyOrphanedVisitsLink(expectedCount){
  if(!(await uiConfirm(`Link ${expectedCount} high-confidence orphaned visit(s) to their one matching contract? Ambiguous and no-match visits are never touched.`,'Link'))) return;
  try{
    const r = await api('POST','/api/admin/orphaned-visits/apply',{});
    toast(`Linked ${r.linkedCount} visit(s)`);
    await refresh(); await loadOrphanedVisitsAudit();
  }catch(e){ uiAlert(e.message||'Link failed'); }
}
async function loadCadenceChangeAudit(){
  $('#cadenceChangeOut').innerHTML = 'Checking against Keap…';
  try{
    const r = await api('GET','/api/admin/cadence-change-audit');
    let h = '';
    if(r.errors && r.errors.length) h += `<p class="small" style="color:var(--bad,#c23b3b)">${r.errors.length} error(s): ${r.errors.slice(0,5).map(esc).join('; ')}${r.errors.length>5?'…':''}</p>`;
    if(!r.changes.length) h += `<p>Checked ${r.checked} contract(s) — no cadence mismatches. ✔</p>`;
    else h += `<p>Checked ${r.checked} contract(s) — <b>${r.changes.length} mismatch(es):</b></p>
      <table><tr><th>Client</th><th>Current</th><th>Keap implies</th><th>Basis</th><th></th></tr>` +
      r.changes.map(c=>`<tr><td>${clientLink(c.client, c.clientId)}</td>
        <td>${esc(c.currentProgram||'—')}</td><td><b>${esc(c.suggestedProgram)}</b></td><td class="small">${esc(c.basis)}</td>
        <td><button class="btn tiny primary" onclick="programChangeDlg(${c.contractId},'${esc(c.currentProgram||'').replace(/'/g,"\\'")}',null,'${esc(c.suggestedProgram).replace(/'/g,"\\'")}',null,'keap')">Review schedule change</button></td></tr>`).join('') +
      `</table><p class="small" style="color:var(--muted)">Each flagged client's profile also shows this as a banner. "Review schedule change" previews exactly which visits are kept, relabelled, removed and created before anything is applied.</p>`;
    $('#cadenceChangeOut').innerHTML = h;
  }catch(e){ $('#cadenceChangeOut').innerHTML = '<p>Could not load.</p>'; }
}
async function loadSheetRecon2026(){
  const el=$('#sheetReconOut'); if(!el) return;
  try{
    const r=await api('GET','/api/admin/sheet-recon-2026'); const t=r.totals;
    window._recon=r;
    let h=`<div class="recon-kpis">
      <span><b>${t.sheetVisits}</b> sheet visits</span>
      <span><b>${t.matchedClients}</b> clients</span>
      <span class="rk-good"><b>${t.place}</b> place</span>
      <span class="rk-warn"><b>${t.extra}</b> extra</span>
      <span class="rk-info"><b>${t.carryover}</b> carryover</span>
      <span class="rk-mut"><b>${t.unscheduled}</b> unscheduled cycles</span>
      <span class="rk-bad"><b>${t.unmatched}</b> unmatched</span></div>
      <div class="controls" style="margin:12px 0 2px">
        <button class="btn danger" onclick="applySheetRecon2026()">Apply to calendar</button>
        <span class="small" style="color:var(--muted)">Places ${t.place}, creates ${t.extra+t.carryover} extra/carryover, deletes ${t.place+t.extra+t.carryover} superseded blocks. Placed only — past visits become “confirm completed” to-dos.</span>
      </div>
      <div class="controls" style="margin:6px 0"><label class="small">Show
        <select id="reconFilter" onchange="renderReconTable()">
          <option value="all">everything</option>
          <option value="place">place onto a cycle</option>
          <option value="extra">extra (over cadence)</option>
          <option value="carryover">carryover</option>
          <option value="unscheduled">unscheduled cycles</option>
        </select></label></div>
      <div id="reconTableOut"></div>`;
    if(r.unmatched.length){
      h+=`<h3 style="margin:18px 0 6px;font-size:14px">Unmatched sheet labels (${r.unmatched.length}) — name variants to map or non-LID</h3>
        <div class="recon-scroll"><table class="recon-tbl"><tr><th>Week</th><th>Coach</th><th>Sheet label</th></tr>`+
        r.unmatched.map(u=>`<tr><td>${fmtW(u.week)}</td><td>${esc(u.coach)}</td><td>${esc(u.label)}</td></tr>`).join('')+`</table></div>`;
    }
    el.innerHTML=h; renderReconTable();
  }catch(e){ el.innerHTML='<p>Could not load.</p>'; }
}
async function applySheetRecon2026(){
  const r=window._recon; if(!r){ await loadSheetRecon2026(); return; }
  const t=r.totals;
  const msg=`Apply the 2026 schedule to the calendar?\n\n`+
    `• Place ${t.place} visits onto their cadence cycle (coach + week from the sheet)\n`+
    `• Create ${t.extra} extra + ${t.carryover} carryover visit(s) on the client's existing contract\n`+
    `• Delete ${t.place+t.extra+t.carryover} superseded "from sheet" blocks\n\n`+
    `Visits are PLACED, not marked complete — past ones appear on your "Confirm completed" to-do on Today. Unscheduled cycles (${t.unscheduled}) and unmatched labels (${t.unmatched}) are left alone.`;
  if(!(await uiConfirm(msg,'Apply to calendar'))) return;
  try{
    const res=await api('POST','/api/admin/sheet-recon-2026/apply',{});
    toast(`Applied — ${res.placed} placed, ${res.created} created, ${res.blocksDeleted} blocks removed`);
    await refresh(); await loadSheetRecon2026();
  }catch(e){ uiAlert(e.message||'Apply failed'); }
}
function reconNote(x){
  if(x.type==='place') return (x.alreadyPlaced?'already on calendar · ':'')+(x.completed?'cycle already completed · ':'')+(x.past?'past week (likely already done)':'would place on this week');
  if(x.type==='extra') return 'over cadence — sheet plans more than the contract';
  if(x.type==='carryover') return '2025 make-up — becomes an extra tracked visit';
  if(x.type==='unscheduled') return 'cadence cycle with no sheet visit — stays to-schedule';
  return '';
}
function renderReconTable(){
  const r=window._recon; if(!r) return;
  const out=$('#reconTableOut'); if(!out) return;
  const f=($('#reconFilter')||{}).value||'all';
  const rows=[];
  for(const p of r.plan) for(const it of p.items) if(f==='all'||it.type===f) rows.push(Object.assign({client:p.client},it));
  const chip=t=>`<span class="rchip r-${t}">${t}</span>`;
  let h=`<div class="recon-scroll"><table class="recon-tbl">
    <tr><th>Client</th><th>Type</th><th>Week</th><th>Coach</th><th>Sheet label</th><th>Cadence cycle</th><th>Note</th></tr>`;
  h+=rows.map(x=>`<tr>
    <td>${esc(x.client)}</td><td>${chip(x.type)}</td>
    <td>${x.week?fmtW(x.week):'—'}</td><td>${x.coach?esc(x.coach):'—'}</td>
    <td>${x.label?esc(x.label):'—'}</td>
    <td>${x.cycle?esc(x.cycle)+(x.due?` <span class="small" style="color:var(--muted)">(due ${fmt(x.due)})</span>`:''):'—'}</td>
    <td class="small">${reconNote(x)}</td></tr>`).join('');
  h+=`</table></div><p class="small" style="margin-top:6px">${rows.length} row(s)${f!=='all'?` · filtered to “${f}”`:''}</p>`;
  out.innerHTML=h;
}
async function importSheet2026(){
  const inp=$('#sheetCsvFile'); const f=inp&&inp.files&&inp.files[0];
  if(!f){ toast('Choose a CSV file first'); return; }
  $('#resyncOut').innerHTML='Importing…';
  try{
    const csv=await f.text();
    const r=await api('POST','/api/admin/sheet-2026/import',{csv, filename:f.name});
    toast(`Imported ${r.visitCells} visit cell(s) from ${f.name}`);
    await loadResyncPreview();
  }catch(e){ $('#resyncOut').innerHTML='<p style="color:var(--bad)">'+esc(e.message||'Import failed')+'</p>'; }
}
async function loadResyncPreview(){
  const el=$('#resyncOut'); if(!el) return;
  try{
    const r=await api('GET','/api/admin/sheet-2026/resync-preview');
    if(!r||!r.imported){ el.innerHTML='<p class="small" style="color:var(--muted)">No CSV imported yet — upload one above to preview the re-sync.</p>'; return; }
    if(r.error){ el.innerHTML='<p style="color:var(--bad)">'+esc(r.error)+'</p>'; return; }
    window._resync=r; const s=r.summary;
    let h=`<p class="small" style="color:var(--muted)">Imported ${esc(r.filename||'')} · ${r.uploadedAt?esc(r.uploadedAt.slice(0,16).replace('T',' ')):''}</p>
      <div class="recon-kpis">
        <span><b>${s.visitsAfterDedupe}</b> visits (deduped)</span>
        <span><b>${s.matchedClients}</b> clients</span>
        <span class="rk-good"><b>${s.place}</b> place</span>
        <span class="rk-warn"><b>${s.extra}</b> extra</span>
        <span class="rk-info"><b>${s.carryover}</b> carryover</span>
        <span class="rk-mut"><b>${s.unscheduled}</b> unscheduled</span>
        <span class="rk-bad"><b>${s.unmatchedLabelCount}</b> unmatched</span>
      </div>
      <p class="small" style="margin:8px 0"><b>${s.sameWeekDoubles}</b> same-week two-coach visit(s) collapsed to one — ${s.coVisitsCollapsed} rider visit(s) no longer counted.${(s.unmatchedCoaches&&s.unmatchedCoaches.length)?` <span style="color:var(--muted)">Unmatched coaches: ${s.unmatchedCoaches.map(esc).join(', ')}.</span>`:''}</p>`;
    if(r.doubles&&r.doubles.length){
      h+=`<details style="margin:6px 0"><summary class="small" style="cursor:pointer">Same-week doubles (${r.doubles.length})</summary>
        <div class="recon-scroll" style="margin-top:6px"><table class="recon-tbl"><tr><th>Client</th><th>Week</th><th>Both coaches — one counts</th></tr>`+
        r.doubles.map(d=>`<tr><td>${esc(d.client)}</td><td>${fmtW(d.week)}</td><td>${d.coaches.map(esc).join('  +  ')}</td></tr>`).join('')+`</table></div></details>`;
    }
    h+=`<div class="controls" style="margin:12px 0 2px">
        <button class="btn danger" onclick="applyResync2026()">Apply</button>
        <span class="small" style="color:var(--muted)">Corrects ${s.place} existing visit(s), creates ${s.extra+s.carryover} new linked visit(s)${s.skippedInactiveNew?`, skips ${s.skippedInactiveNew} for departed/notice-given clients`:''}. Nothing completed is ever touched.</span>
      </div>
      <div class="controls" style="margin:10px 0 4px"><label class="small">Show
      <select id="resyncFilter" onchange="renderResyncTable()">
        <option value="all">everything</option><option value="place">place onto a cycle</option>
        <option value="extra">extra (over cadence)</option><option value="carryover">carryover</option>
        <option value="unscheduled">unscheduled cycles</option></select></label></div>
      <div id="resyncTableOut"></div>`;
    if(r.unmatchedLabels&&r.unmatchedLabels.length){
      h+=`<details style="margin-top:10px"><summary class="small" style="cursor:pointer">Unmatched labels (${r.unmatchedLabels.length}) — name variants or non-LID</summary>
        <div class="small" style="margin-top:6px;color:var(--muted)">${r.unmatchedLabels.map(esc).join('  ·  ')}</div></details>`;
    }
    el.innerHTML=h; renderResyncTable();
  }catch(e){ el.innerHTML='<p>Could not load preview.</p>'; }
}
async function applyResync2026(){
  const r=window._resync; if(!r){ await loadResyncPreview(); return; }
  const s=r.summary;
  const msg=`Apply the 2026 schedule re-sync?\n\n`+
    `• Correct the scheduled week/coach on ${s.place} existing visit(s) — no new rows\n`+
    `• Create ${s.extra} extra + ${s.carryover} carryover visit(s), each linked to the client's existing contract\n`+
    (s.skippedInactiveNew?`• Skip ${s.skippedInactiveNew} of those for clients who've cancelled or given notice — nothing new gets created for them\n`:'')+
    `\nUnscheduled cycles (${s.unscheduled}) and unmatched labels (${s.unmatchedLabelCount}) are left alone. Nothing completed is ever touched. Safe to re-apply any time you re-upload an updated sheet.`;
  if(!(await uiConfirm(msg,'Apply'))) return;
  try{
    const res=await api('POST','/api/admin/sheet-2026/apply',{});
    toast(`Applied — ${res.placed} placed, ${res.created} created, ${res.cleared} re-placed, ${res.skipped} skipped`);
    await refresh(); await loadResyncPreview();
  }catch(e){ uiAlert(e.message||'Apply failed'); }
}
function renderResyncTable(){
  const r=window._resync; if(!r) return; const out=$('#resyncTableOut'); if(!out) return;
  const f=(($('#resyncFilter')||{}).value)||'all';
  const rows=[]; for(const p of r.plan) for(const it of p.items) if(f==='all'||it.type===f) rows.push(Object.assign({client:p.client},it));
  const chip=t=>`<span class="rchip r-${t}">${t}</span>`;
  let h=`<div class="recon-scroll"><table class="recon-tbl"><tr><th>Client</th><th>Type</th><th>Week</th><th>Coach</th><th>Cadence cycle</th></tr>`;
  h+=rows.map(x=>`<tr><td>${esc(x.client)}</td><td>${chip(x.type)}</td>
    <td>${x.week?fmtW(x.week):'—'}</td>
    <td>${x.coach?esc(x.coach)+(x.coCount?` <span class="small" style="color:var(--muted)" title="riding along, not counted">+${x.coCount}</span>`:''):'—'}</td>
    <td>${x.cycle?esc(x.cycle)+(x.due?` <span class="small" style="color:var(--muted)">(due ${fmt(x.due)})</span>`:''):'—'}</td></tr>`).join('');
  h+=`</table></div><p class="small" style="margin-top:6px">${rows.length} row(s)</p>`;
  out.innerHTML=h;
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
async function setTeamLead(team, coachId){
  try{
    await api('PUT','/api/teams/'+encodeURIComponent(team)+'/lead',{ coach_id: coachId || null });
    await refresh(); toast(coachId ? 'Team lead set — their login is now a lead' : 'Lead removed');
  }catch(e){ uiAlert(e.message || 'Could not set lead'); await refresh(); }
}
function removeCoach(id,name){ coachDeleteWithModal(id); }
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
  const free = D.coaches.filter(c=>c.active && !(D.teamInfo||[]).some(t=>t.lead_coach_id===c.id));
  openDlg(`<h3>Add team</h3>
    <label>Team name</label><input id="tName" placeholder="e.g. Big Dogs">
    <label>Team lead</label><select id="tLead"><option value="">— pick later —</option>${free.map(c=>`<option value="${c.id}">${esc(c.name)} (${esc(c.team||'no team')})</option>`).join('')}</select>
    <p class="small" style="color:var(--muted)">Picking a lead moves that coach onto the new team and makes their login a lead. Promoting a coach to run a new team is exactly this.</p>
    <div class="dlgrow"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="saveTeam()">Add</button></div>`);
}
async function saveTeam(){
  const name = ($('#tName')||{}).value || '', lead_coach_id = ($('#tLead')||{}).value || null;
  try{ const r = await api('POST','/api/teams',{ name, lead_coach_id }); closeDlg(); if(r && r.warning) uiAlert(r.warning); await refresh(); }
  catch(e){ uiAlert(e.message || 'Could not add team'); }
}
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
    out.innerHTML = `<p class="small">Checked ${r.checked} subscription(s) in Keap — ${rows.length} newly queued, ${r.alreadyTracked} already tracked, ${r.previouslyIgnored?`<b>${r.previouslyIgnored} previously ignored</b> (tick "Show ignored" in Unassigned Clients to bring one back), `:''}${r.notCoachingProduct} not a Signature Coaching subscription, ${r.cancelled} cancelled/inactive${r.errors.length?`, ${r.errors.length} error(s)`:''}.${r.hitPageCap?' (hit the page cap — there may be more; run it again to keep going.)':''}</p>` +
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
      r.rollingSchedule.error?`Rolling schedule: FAILED — ${esc(r.rollingSchedule.error)}`:`Rolling schedule: ${r.rollingSchedule.totalCreated} visit(s) added across ${r.rollingSchedule.perClient.length} contract(s)${r.rollingSchedule.capped&&r.rollingSchedule.capped.length?` — ⚠ ${r.rollingSchedule.capped.length} contract(s) hit the safety cap, needs a look`:''}`,
      r.revenue.error?`Revenue snapshot: FAILED — ${esc(r.revenue.error)}`:`Revenue snapshot: ${fmtMoney(r.revenue.totalRevenue)} across ${r.revenue.activeClients} active client(s)`,
      r.purge.error?`Purge: FAILED — ${esc(r.purge.error)}`:`Purge: ${r.purge.purged} client(s) purged`,
      r.backup.ok?`Backup: sent (${Math.round((r.backup.sizeBytes||0)/1024)} KB)`:`Backup: FAILED`,
      `Digest emailed to ${r.digestSentTo||0} of ${r.digestAttempted||0} admin(s).`,
    ];
    $('#maintenanceOut').innerHTML = `<ul style="margin:0;padding-left:18px">${lines.map(l=>`<li>${l}</li>`).join('')}</ul>`;
    await loadRevenueHistory(); await loadDeletedClients(); await loadBackupStatus(); await loadDuplicateVisitsAudit(); await loadPhantomContractsAudit(); await loadContractSplitsAudit(); await loadOrphanedVisitsAudit();
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
async function loadOutOfOrder(){
  const el = $('#outOfOrderOut'); if(!el) return;
  try{
    const rows = await api('GET','/api/admin/out-of-order');
    el.innerHTML = rows.length ? `<table><tr><th>Client</th><th>Visit</th><th>On calendar</th><th>Coach</th><th>Problem</th><th></th></tr>` +
      rows.map(r=>`<tr><td>${clientLink(r.client, r.client_id)}</td><td class="mono">${esc(r.cycle)} ${esc(r.program)}</td><td class="mono">wk of ${fmtW(r.cal_week)}</td><td>${esc(coach(r.cal_coach)?.name||'—')}</td><td class="small">${esc(r.message)}</td>
        <td style="white-space:nowrap"><button class="btn tiny" onclick="jumpToCalendar(${r.id})">Calendar</button> <button class="btn tiny danger" onclick="unscheduleV(${r.id}).then(loadOutOfOrder)">Unschedule</button></td></tr>`).join('') + `</table>`
      : `<p style="color:var(--ok)">Every placed visit is in cycle order. ✔</p>`;
  }catch(e){ el.innerHTML = '<p>Could not load.</p>'; }
}
async function loadArchivedClients(){
  const el = $('#archivedOut'); if(!el) return;
  try{
    const rows = await api('GET','/api/clients/archived');
    el.innerHTML = rows.length ? `<table><tr><th>Client</th><th>Archived</th><th>Why</th><th>Coach was</th><th>Completed visits</th><th>Last visit</th><th></th></tr>` +
      rows.map(r=>`<tr><td>${clientLink(r.name, r.id)}</td><td class="mono">${fmt(r.archived_at.slice(0,10))}</td><td class="small">${esc(r.archive_reason||'')}</td><td>${esc(r.assigned_coach_name||'—')}</td><td class="num">${r.completed_visits}</td><td class="mono">${r.last_visit?fmt(r.last_visit):'—'}</td>
        <td><button class="btn tiny" onclick="reactivateClient(${r.id},'${esc(r.name).replace(/'/g,"\\'")}')">Reactivate</button></td></tr>`).join('') + `</table>`
      : `<p>No archived clients.</p>`;
  }catch(e){ el.innerHTML = '<p>Could not load.</p>'; }
}
function archiveClientDlg(id, name){
  openDlg(`<h3>Archive ${esc(name)}?</h3>
    <p class="small">They leave the Clients list, Visit List, Today, calendars and capacity. Completed visits, notes and contracts are kept. <b>Open (not completed) visits are removed</b>, including any already on a coach's calendar.</p>
    <label>Reason</label><input id="arcReason" placeholder="e.g. Cancelled — moved to in-house training" style="width:100%;box-sizing:border-box">
    <div class="dlgrow" style="margin-top:12px"><button class="btn" onclick="closeDlg()">Cancel</button>
    <button class="btn primary" onclick="archiveClientGo(${id})">Archive</button></div>`);
}
async function archiveClientGo(id){
  const reason = (($('#arcReason')||{}).value||'').trim() || 'Archived by hand';
  try{ const r = await api('POST',`/api/clients/${id}/archive`,{ reason }); closeDlg(); toast(`Archived — ${r.visitsDeleted} open visit${r.visitsDeleted===1?'':'s'} removed`); await refresh(); }
  catch(e){ uiAlert(e.message||'Archive failed'); }
}
async function reactivateClient(id, name){
  if(!(await uiConfirm(`Reactivate ${name}? They return to the working lists as active. Use Extend visits on their contract afterwards to rebuild the schedule.`,'Reactivate'))) return;
  try{ await api('POST',`/api/clients/${id}/reactivate`,{}); toast('Reactivated'); await refresh(); if($('#archivedOut')) loadArchivedClients(); }
  catch(e){ uiAlert(e.message||'Reactivate failed'); }
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
