const API = location.origin;   // same-origin: works in local dev and in production
let ACTIVITIES = [];

// ── token store (localStorage with in-memory fallback) ──
const mem = {};
const store = {
  get:k=>{try{return sessionStorage.getItem(k)}catch{return mem[k]??null}},
  set:(k,v)=>{try{sessionStorage.setItem(k,v)}catch{mem[k]=v}},
  del:k=>{try{sessionStorage.removeItem(k)}catch{delete mem[k]}}
};
let user=null, sock=null, state=null, mfaToken=null, lastActivityEventType=null, userRoles=[];

// ── API helper with one auto-refresh on 401 ──
async function api(path,{method="GET",body,auth=true,retry=true}={}){
  const h={"content-type":"application/json"};
  if(auth){const t=store.get("tt_access"); if(t) h.Authorization="Bearer "+t;}
  const res=await fetch(API+path,{method,headers:h,body:body?JSON.stringify(body):undefined});
  if(res.status===401 && auth && retry && store.get("tt_refresh")){
    const ok=await tryRefresh();
    if(ok) return api(path,{method,body,auth,retry:false});
  }
  const text=await res.text();
  const data=text?JSON.parse(text):{};
  if(!res.ok) throw Object.assign(new Error(data.message||res.statusText),{status:res.status,data});
  return data;
}
async function tryRefresh(){
  try{
    const r=await fetch(API+"/auth/refresh",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({refreshToken:store.get("tt_refresh")})});
    if(!r.ok) return false;
    const d=await r.json(); store.set("tt_access",d.accessToken); store.set("tt_refresh",d.refreshToken); return true;
  }catch{return false}
}

// ── toasts ──
function toast(msg,kind="ok"){
  const el=document.createElement("div"); el.className="toast "+kind; el.textContent=msg;
  document.getElementById("toasts").appendChild(el);
  setTimeout(()=>el.remove(),4200);
}

// ── promise-based confirm modal (replaces window.confirm) ──
const ICONS={danger:"⚠",warn:"⚠",primary:"?"};
function confirmDialog({title="Are you sure?",message="",confirmText="Confirm",cancelText="Cancel",kind="primary"}={}){
  return new Promise(resolve=>{
    const overlay=document.getElementById("modalOverlay");
    const ok=document.getElementById("modalConfirm");
    const cancel=document.getElementById("modalCancel");
    const icon=document.getElementById("modalIcon");
    document.getElementById("modalTitle").textContent=title;
    document.getElementById("modalMsg").textContent=message;
    ok.textContent=confirmText; cancel.textContent=cancelText;
    ok.className="btn "+(kind==="danger"?"danger":kind==="warn"?"warn":"primary");
    icon.className="ic "+kind; icon.textContent=ICONS[kind]||"?";
    overlay.classList.add("show");
    setTimeout(()=>ok.focus(),0);
    let done=false;
    const finish=(result)=>{
      if(done) return; done=true;
      overlay.classList.remove("show");
      ok.onclick=null; cancel.onclick=null; overlay.onclick=null;
      document.removeEventListener("keydown",onKey);
      resolve(result);
    };
    const onKey=e=>{ if(e.key==="Escape") finish(false); else if(e.key==="Enter") finish(true); };
    ok.onclick=()=>finish(true);
    cancel.onclick=()=>finish(false);
    overlay.onclick=e=>{ if(e.target===overlay) finish(false); };
    document.addEventListener("keydown",onKey);
  });
}

// ── escape user-supplied text before putting it in innerHTML (XSS guard) ──
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

// ── view switching ──
function show(id){for(const v of ["login","mfa","app"]) document.getElementById("view-"+v).classList.toggle("hide",v!==id);}

// ── LOGIN ──
document.getElementById("li-go").onclick=async()=>{
  const id=document.getElementById("li-id").value.trim();
  const pw=document.getElementById("li-pw").value;
  const err=document.getElementById("li-err"); err.textContent="";
  if(!id||!pw){err.textContent="Enter your login and password.";return;}
  try{
    const r=await api("/auth/login",{method:"POST",auth:false,body:{identifier:id,password:pw}});
    // Experimental MFA-exempt account: server returns tokens immediately (no second factor).
    if(r.status==="OK" && r.accessToken){ store.set("tt_access",r.accessToken); store.set("tt_refresh",r.refreshToken); await boot(); return; }
    mfaToken=r.mfaToken;
    const sub=document.getElementById("mfa-sub");
    const enroll=document.getElementById("mfa-enroll");
    enroll.classList.add("hide");
    if(r.status==="MFA_EMAIL_OTP_SENT"){ sub.textContent="We emailed you a 6-digit code."; }
    else if(r.status==="MFA_TOTP_REQUIRED"){ sub.textContent="Enter the code from your authenticator app."; }
    else if(r.status==="MFA_TOTP_ENROLL"){
      sub.textContent="Set up your authenticator app to finish signing in.";
      enroll.classList.remove("hide");
      const secret=new URL(r.otpauthUrl).searchParams.get("secret");
      document.getElementById("mfa-secret").textContent=secret;
      const box=document.getElementById("mfa-qr"); box.innerHTML="";
      if(window.QRCode){ try{ new QRCode(box,{text:r.otpauthUrl,width:170,height:170}); }
        catch(e){ box.innerHTML='<div class="muted" style="font-size:13px">QR couldn\u2019t render — use the manual key.</div>'; } }
      else { box.innerHTML='<div class="muted" style="font-size:13px">QR unavailable — enter the manual key into your authenticator app.</div>'; }
      const cb=document.getElementById("copyKey");
      cb.onclick=()=>{ navigator.clipboard?.writeText(secret).then(()=>toast("Key copied")).catch(()=>{}); };
    }
    document.getElementById("mfa-code").value="";
    show("mfa"); document.getElementById("mfa-code").focus();
  }catch(e){ err.textContent=e.message||"Sign-in failed."; }
};

// ── MFA verify ──
document.getElementById("mfa-go").onclick=async()=>{
  const code=document.getElementById("mfa-code").value.trim();
  const err=document.getElementById("mfa-err"); err.textContent="";
  try{
    const d=await api("/auth/mfa/verify",{method:"POST",auth:false,body:{mfaToken,code}});
    store.set("tt_access",d.accessToken); store.set("tt_refresh",d.refreshToken);
    await boot();
  }catch(e){ err.textContent=e.message||"Verification failed."; }
};

// ── profile photo + identity in the top bar ──
function initials(name){ return (name||"?").trim().split(/\s+/).map(s=>s[0]).slice(0,2).join("").toUpperCase(); }
function renderWho(){
  const name=user.employee?.fullName||user.email;
  const team=user.employee?.team;
  const photo=user.employee?.photoUrl;
  const av=photo
    ? `<img src="${photo}" alt="" style="width:34px;height:34px;border-radius:50%;object-fit:cover;display:block">`
    : `<span style="width:34px;height:34px;border-radius:50%;background:var(--panel);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--muted)">${initials(name)}</span>`;
  const who=document.getElementById("who");
  who.style.cssText="display:flex;align-items:center;gap:10px";
  who.innerHTML=`<button id="avatarBtn" title="Change your photo" style="background:none;border:none;padding:0;cursor:pointer">${av}</button>`+
    `<div style="line-height:1.3"><div><b>${name}</b> · ${userRoles.join(", ")}</div>`+
    `<div class="muted" style="font-size:12px">${team?team.name:"No team"}</div></div>`;
  document.getElementById("avatarBtn").onclick=()=>pickPhoto("/me/photo",async()=>{ user=await api("/auth/me"); renderWho(); });
}
function pickPhoto(url, onDone){
  const inp=document.createElement("input"); inp.type="file"; inp.accept="image/*";
  inp.onchange=()=>{
    const f=inp.files[0]; if(!f) return;
    if(f.size>1500000){ toast("Image too large (max 1.5 MB).","err"); return; }
    const rd=new FileReader();
    rd.onload=async()=>{ try{ await api(url,{method:"POST",body:{photo:rd.result}}); toast("Photo updated","ok"); onDone&&onDone(); }catch(e){toast(e.message,"err");} };
    rd.readAsDataURL(f);
  };
  inp.click();
}

// ── boot after auth: load identity, route by role, connect socket ──
async function boot(){
  user=await api("/auth/me");
  store.set("tt_user",JSON.stringify(user));
  userRoles=user.roles||[];
  renderWho();
  buildTabs(userRoles);
  await buildClockStatics();
  show("app");
  connectSocket();
  await refreshClock();
  loadOvertime();
  if(isLead(userRoles)){ loadConsole(); }
  if(isScheduler(userRoles)){ loadSchedulePanel(); }
  startTicker();
}
function isLead(roles){return roles.includes("TEAM_LEAD")||roles.includes("WFM")||roles.includes("ADMIN");}
function isScheduler(roles){return roles.includes("WFM")||roles.includes("ADMIN");}
function isManager(roles){return roles.includes("MANAGER")||roles.includes("HR")||roles.includes("ADMIN");}
function isProvisioner(roles){return roles.includes("WFM")||roles.includes("ADMIN");}
function isPayroll(roles){return roles.includes("PAYROLL")||roles.includes("ADMIN");}
function canLiveActivity(roles){return roles.includes("WFM")||roles.includes("ADMIN");}      // live feed, grant, activities, assign
function canLeaveReview(roles){return roles.includes("TEAM_LEAD")||roles.includes("HR")||roles.includes("ADMIN");}

function buildTabs(roles){
  const tabs=document.getElementById("tabs"); tabs.innerHTML="";
  const lead=isLead(roles);
  const allTabs=["clock","myschedule","leave","schedule","console","oversight","people","teams","payroll","payslips"];
  const defs=[];
  if(user.employeeId) defs.push(["clock","My clock"]);
  if(user.employeeId) defs.push(["myschedule","My schedule"]);
  if(user.employeeId && !lead && !isScheduler(roles) && !isManager(roles) && !isPayroll(roles)) defs.push(["leave","My leave"]);
  if(user.employeeId) defs.push(["payslips","My payslips"]);
  if(isScheduler(roles)) defs.push(["schedule","Scheduling"]);
  if(lead) defs.push(["console","Team console"]);
  if(isManager(roles)) defs.push(["oversight","Oversight"]);
  if(isProvisioner(roles)) defs.push(["people","People"]);
  if(isProvisioner(roles)) defs.push(["teams","Teams"]);
  if(isPayroll(roles)) defs.push(["payroll","Payroll"]);
  defs.push(["__logout","Sign out"]);
  defs.forEach(([k,label],i)=>{
    const b=document.createElement("div"); b.className="tab"+(i===0?" on":""); b.textContent=label;
    b.onclick=()=>{
      if(k==="__logout") return signOut();
      stopOversightPoll();
      document.querySelectorAll(".tab").forEach(t=>t.classList.remove("on")); b.classList.add("on");
      allTabs.forEach(id=>document.getElementById("tab-"+id).classList.toggle("hide",k!==id));
      if(k==="myschedule") loadMySchedule();
      if(k==="leave") loadMyLeave();
      if(k==="schedule") loadSchedulePanel();
      if(k==="oversight") startOversightPoll();
      if(k==="people") loadUsers();
      if(k==="teams") loadTeams();
      if(k==="payroll") loadPayroll();
      if(k==="payslips") loadMyPayslips();
      if(k==="console") loadConsole();
    };
    tabs.appendChild(b);
  });
  allTabs.forEach(id=>document.getElementById("tab-"+id).classList.add("hide"));
  if(defs[0][0]!=="__logout") document.getElementById("tab-"+defs[0][0]).classList.remove("hide");
}
async function signOut(){ try{await api("/auth/logout",{method:"POST",auth:false,body:{refreshToken:store.get("tt_refresh")}});}catch{}
  store.del("tt_access");store.del("tt_refresh");store.del("tt_user"); if(sock)sock.disconnect(); location.reload(); }

// ── CLOCK ──
async function buildClockStatics(){
  const list=await api("/activity-types/mine").catch(()=>[]);
  ACTIVITIES=list.map(a=>a.name);
  const off=document.getElementById("activityPickOff"); off.innerHTML="";
  const clockInBtn=document.getElementById("clockInBtn");
  if(!ACTIVITIES.length){
    off.innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">No activities assigned to you yet. Contact your team lead.</div>';
    clockInBtn.disabled=true;
    return;
  }
  clockInBtn.disabled=false;
  ACTIVITIES.forEach((a,i)=>{const c=document.createElement("button");c.className="chip"+(i===0?" on":"");
    c.textContent=a; c.dataset.a=a; c.onclick=()=>{off.querySelectorAll(".chip").forEach(x=>x.classList.remove("on"));c.classList.add("on")};
    off.appendChild(c);});
}
function selectedOffActivity(){const c=document.querySelector("#activityPickOff .chip.on");return c?c.dataset.a:ACTIVITIES[0];}

document.getElementById("clockInBtn").onclick=async()=>{
  try{ state=await api("/time/clock-in",{method:"POST",body:{activityType:selectedOffActivity()}}); renderClock(); toast("Clocked in"); }
  catch(e){ toast(e.message,"err"); }
};
document.getElementById("resumeBtn").onclick=async()=>{
  try{ state=await api("/time/break/end",{method:"POST"}); renderClock(); toast("Back to work"); }catch(e){toast(e.message,"err");}
};
document.getElementById("clockOutBtn").onclick=async()=>{
  const ok=await confirmDialog({title:"Clock out?",message:"This will end your shift. You can clock back in within the 8-hour window.",confirmText:"Clock out",kind:"danger"});
  if(!ok) return;
  try{ state=await api("/time/clock-out",{method:"POST"}); renderClock(); toast("Clocked out"); }catch(e){toast(e.message,"err");}
};

async function refreshClock(){ try{ state=await api("/time/me"); renderClock(); }catch(e){ if(e.status===401) signOut(); } }

function fmt(ms){ if(ms<0)ms=0; const s=Math.floor(ms/1000); const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;
  return (h>0?h+":":"")+String(m).padStart(h>0?2:1,"0")+":"+String(x).padStart(2,"0"); }

function renderClock(){
  const onShift = state && state.onShift;
  document.getElementById("offShift").classList.toggle("hide",!!onShift);
  document.getElementById("onShift").classList.toggle("hide",!onShift);
  const pill=document.getElementById("statusPill");
  if(!onShift){ pill.className="status-pill off"; pill.textContent="Clocked out"; document.getElementById("liveDot").classList.remove("live"); return; }
  document.getElementById("liveDot").classList.add("live");

  const onBreak = !!state.currentBreak;
  pill.className="status-pill "+(onBreak?"brk":"shift");
  pill.textContent = onBreak ? "On "+state.currentBreak.type.toLowerCase()+" break" : "On shift · "+(state.currentActivity||"—");

  document.getElementById("breakBox").classList.toggle("hide",!onBreak);
  document.getElementById("workBox").classList.toggle("hide",onBreak);
  if(onBreak) document.getElementById("breakLabel").textContent="On "+state.currentBreak.type.toLowerCase()+" break";

  // activity chips
  const on=document.getElementById("activityPickOn"); on.innerHTML="";
  ACTIVITIES.forEach(a=>{const c=document.createElement("button");c.className="chip"+(a===state.currentActivity?" on":"");
    c.textContent=a; c.onclick=async()=>{
      if(a===state.currentActivity) return; // already on it
      try{state=await api("/time/activity",{method:"POST",body:{activityType:a}});renderClock();toast("Switched to "+a);}catch(e){toast(e.message,"err");}
    };
    on.appendChild(c);});

  // break buttons, gated by server-provided state + policy
  // Team Leads (TEAM_LEAD, MANAGER, HR, ADMIN) are exempt from bio/additional break limits
  const p=state.policy||{};
  const bb=document.getElementById("breakBtns"); bb.innerHTML="";
  const isExempt=userRoles.some(r=>['TEAM_LEAD','MANAGER','HR','ADMIN'].includes(r));
  const dur=s=>{ s=Number(s)||0; return (s>=60 && s%60===0)?(s/60)+"m":s+"s"; };
  const bioDur=dur(p.bioMaxSeconds||300);
  // Compute the regular-break unlock live from clock-in so it flips on time
  // without waiting for a server round-trip.
  const regUnlocked = !!state.regUnlocked || (state.clockInAt && (Date.now()-new Date(state.clockInAt).getTime()) >= (p.regUnlockHours||4)*3600000);

  const defs=[
    {type:"REGULAR", label:`Regular (${dur(p.regMaxSeconds||1800)})`,
      disabled: state.regBreakUsed || !regUnlocked,
      hint: state.regBreakUsed?"used":(!regUnlocked?`unlocks after ${p.regUnlockHours||4}h`:"")},
    // Managers/TLs: unlimited bio breaks, but still auto-clocked-out at the limit.
    isExempt
      ? {type:"BIO", label:`Bio (${bioDur})`, disabled:false,
         hint:`unlimited · auto clock-out at ${bioDur}`}
      : {type:"BIO", label:`Bio (${bioDur}) ${state.bioUsed}/${state.bioMax}`,
         disabled: state.bioUsed>=state.bioMax,
         hint: state.bioUsed>=state.bioMax?"limit reached":""},
    ...(!isExempt?[{type:"ADDITIONAL", label:`Additional bio (${dur(p.addlMaxSeconds||600)})`,
      disabled: !state.additionalApproved,
      hint: !state.additionalApproved?"needs TL approval":""}]:[]),
  ];
  defs.forEach(d=>{
    const c=document.createElement("button"); c.className="chip"; c.disabled=d.disabled;
    c.innerHTML=d.label+(d.hint?` <span class="muted">· ${d.hint}</span>`:"");
    c.onclick=async()=>{try{state=await api("/time/break/start",{method:"POST",body:{breakType:d.type}});renderClock();toast(d.type.toLowerCase()+" break started","warn");}catch(e){toast(e.message,"err");}};
    bb.appendChild(c);
  });
}

// ── live ticker for countdowns (display only; server is authority) ──
let ticker=null, tickN=0;
function startTicker(){ if(ticker) clearInterval(ticker); ticker=setInterval(()=>{
  document.getElementById("now").textContent=new Date().toLocaleTimeString();
  if(!state||!state.onShift) return;
  // Quietly re-pull authoritative state every ~30s so time-based changes
  // (regular-break unlock, bio counts, shift expiry) appear without an action.
  if((++tickN % 120)===0) refreshClock();
  const now=Date.now();
  if(state.shiftEndsAt){ const end=new Date(state.shiftEndsAt).getTime(); const start=new Date(state.clockInAt).getTime();
    document.getElementById("shiftTimer").textContent=fmt(end-now);
    const pct=Math.max(0,Math.min(100,(now-start)/(end-start)*100));
    document.getElementById("shiftBar").style.width=pct+"%"; }
  if(state.currentBreak){ const d=new Date(state.currentBreak.deadlineAt).getTime();
    document.getElementById("breakTimer").textContent=fmt(d-now); }
},250); }

// ── SOCKET ──
function connectSocket(){
  sock=io(API,{auth:{token:store.get("tt_access")},transports:["websocket","polling"]});
  sock.on("connect",()=>document.getElementById("liveDot").classList.add("live"));
  sock.on("time:event",ev=>{
    if(ev.type==="ACTIVITIES_UPDATED"){ buildClockStatics().then(refreshClock); toast("Your available activities were updated","ok"); return; }
    if(ev.type==="OVERTIME_GRANTED"){ toast("WFM gave you overtime — check the banner on your clock","ok"); loadOvertime(); return; }
    const m={SHIFT_STARTED:"Shift started",BREAK_STARTED:"Break started",BREAK_ENDED:"Back to work",
      AUTO_LOGOUT:"Auto-logged out — break overran",SHIFT_EXPIRED:"Shift window ended",
      BREAK_OVERRUN:"Break time exceeded — returned to work",
      AUTO_CLOCKED_OUT:"Auto-clocked out — break time exceeded",
      CLOCKED_OUT:"Clocked out",LOGGED_OUT_BACKGROUND:"Logged out — shift still running",
      ADDL_GRANTED:"A team lead granted you an additional bio break",ADDL_REVOKED:"Additional bio break revoked"}[ev.type]||ev.type;
    // The same AUTO_CLOCKED_OUT event now arrives from two enforcers; say which one.
    const m2=(ev.type==="AUTO_CLOCKED_OUT"&&ev.reason==="IDLE_TIMEOUT")?"Auto-clocked out — no activity detected at your station":m;
    const kind=(ev.type==="AUTO_LOGOUT"||ev.type==="SHIFT_EXPIRED"||ev.type==="AUTO_CLOCKED_OUT")?"err":(ev.type==="ADDL_GRANTED"?"ok":"warn");

    // Prevent duplicate activity toasts: only show if event type differs from the last one, or after a short delay
    if(ev.type!=="SHIFT_STARTED"||ev.type!==lastActivityEventType){ toast(m2,kind); lastActivityEventType=ev.type; }
    refreshClock();
  });
  sock.on("time:approver",ev=>{ if(canLiveActivity(userRoles)) loadActive(); });
  sock.on("time:activity",()=>{ if(canLiveActivity(userRoles)){ loadAudit(); loadConsoleViolations(); } });

  // ── screen-share signaling ──
  sock.on("screen:request", async ev=>{
    const ok=await confirmDialog({title:"Screen view request",
      message:`${ev.fromName} (manager) is asking to view your screen. If you agree, your browser will ask which screen or window to share — and you can stop anytime.`,
      confirmText:"Share my screen",cancelText:"Decline",kind:"warn"});
    if(!ok){ sock.emit("screen:decline",{toSocketId:ev.fromSocketId}); return; }
    let stream;
    try{ stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false}); }
    catch(e){ sock.emit("screen:decline",{toSocketId:ev.fromSocketId}); toast("Screen share canceled","warn"); return; }
    shareStream=stream; sharePeerSocket=ev.fromSocketId;
    sharePc=new RTCPeerConnection(RTC_CONFIG);
    stream.getTracks().forEach(t=>sharePc.addTrack(t,stream));
    sharePc.onicecandidate=e=>{ if(e.candidate&&sharePeerSocket) sock.emit("screen:ice",{toSocketId:sharePeerSocket,candidate:e.candidate}); };
    const vt=stream.getVideoTracks()[0]; if(vt) vt.onended=()=>stopSharing();
    const offer=await sharePc.createOffer();
    await sharePc.setLocalDescription(offer);
    sock.emit("screen:offer",{toSocketId:ev.fromSocketId,sdp:offer,employeeId:user.employeeId});
    document.getElementById("shareWith").textContent=ev.fromName;
    document.getElementById("shareBanner").classList.remove("hide");
  });
  sock.on("screen:offer", async ev=>{
    viewPeerSocket=ev.fromSocketId;
    viewPc=new RTCPeerConnection(RTC_CONFIG);
    viewPc.ontrack=e=>{ document.getElementById("ov-video").srcObject=e.streams[0]; document.getElementById("ov-viewer-status").textContent="Live"; };
    viewPc.onicecandidate=e=>{ if(e.candidate&&viewPeerSocket) sock.emit("screen:ice",{toSocketId:viewPeerSocket,candidate:e.candidate}); };
    try{
      await viewPc.setRemoteDescription(ev.sdp);
      const answer=await viewPc.createAnswer();
      await viewPc.setLocalDescription(answer);
      sock.emit("screen:answer",{toSocketId:ev.fromSocketId,sdp:answer});
    }catch(e){ document.getElementById("ov-viewer-status").textContent="Connection error."; }
  });
  sock.on("screen:answer", async ev=>{ if(sharePc){ try{await sharePc.setRemoteDescription(ev.sdp);}catch(e){} } });
  sock.on("screen:ice", async ev=>{
    if(viewPc && ev.fromSocketId===viewPeerSocket){ try{await viewPc.addIceCandidate(ev.candidate);}catch(e){} }
    else if(sharePc && ev.fromSocketId===sharePeerSocket){ try{await sharePc.addIceCandidate(ev.candidate);}catch(e){} }
  });
  sock.on("screen:decline", ev=>{ document.getElementById("ov-viewer-status").textContent="The employee declined the request."; toast("Employee declined the screen view","warn"); });
  sock.on("screen:stop", ev=>{
    if(viewPeerSocket && ev.fromSocketId===viewPeerSocket){ stopViewing(); document.getElementById("ov-viewer-status").textContent="Sharing ended by the employee."; }
    if(sharePeerSocket && ev.fromSocketId===sharePeerSocket){ stopSharing(); }
  });
}

// ── CONSOLE ──
// RBAC: WFM/Admin get live activity + grant + activity types + assign;
// Team Leads get leave review only; everything else is hidden.
function applyConsoleRBAC(){
  const live=canLiveActivity(userRoles), leave=canLeaveReview(userRoles);
  document.getElementById("cn-grant").classList.toggle("hide",!live);
  document.getElementById("cn-live").classList.toggle("hide",!live);
  document.getElementById("cn-violations").classList.toggle("hide",!live);
  document.getElementById("cn-activitytypes").classList.toggle("hide",!live);
  document.getElementById("cn-assign").classList.toggle("hide",!live);
  document.getElementById("cn-leave").classList.toggle("hide",!leave);
}
function loadConsole(){
  applyConsoleRBAC();
  if(canLiveActivity(userRoles)){ loadRoster(); loadActive(); loadAudit(); loadConsoleViolations(); renderActivityMgmt(); loadAssignPanel(); }
  if(canLeaveReview(userRoles)){ loadLeaveRequests(); }
}
async function loadConsoleViolations(){
  const box=document.getElementById("cv-list");
  try{
    const list=await api("/approvals/violations");
    box.innerHTML="";
    if(!list.length){ box.innerHTML='<div class="muted" style="padding:10px 2px;font-size:13px">No violations recorded.</div>'; return; }
    list.forEach(v=>box.appendChild(violationRow(v.type, v.detail, v.fullName||v.employeeCode||"agent", v.occurredAt)));
  }catch(e){ /* non-fatal */ }
}
async function loadRoster(){
  const list=await api("/approvals/roster"); const sel=document.getElementById("rosterSel"); sel.innerHTML="";
  list.forEach(e=>{const o=document.createElement("option");o.value=e.id;o.textContent=`${e.employeeCode} — ${e.fullName}`;sel.appendChild(o);});
}
document.getElementById("grantBtn").onclick=async()=>{
  const employeeId=document.getElementById("rosterSel").value; if(!employeeId)return;
  try{ const r=await api("/approvals",{method:"POST",body:{employeeId}});
    if(r.ok){toast("Granted");} else toast(r.reason||"Not granted","warn"); loadActive(); }
  catch(e){toast(e.message,"err");}
};
async function loadActive(){
  try{ const list=await api("/approvals/active"); const box=document.getElementById("activeList"); box.innerHTML="";
    if(!list.length){box.innerHTML='<div class="muted" style="padding:10px 2px;font-size:13px">No active grants.</div>';return;}
    list.forEach(a=>{const row=document.createElement("div");row.className="ev";
      row.innerHTML=`<span class="tag ok">GRANTED</span><div style="flex:1">${esc(a.employee.employeeCode)} — ${esc(a.employee.fullName)}</div>`;
      const b=document.createElement("button");b.className="btn ghost";b.style.padding="4px 10px";b.style.fontSize="12px";b.textContent="Revoke";
      b.onclick=async()=>{try{await api(`/approvals/${a.id}/revoke`,{method:"POST"});toast("Revoked","warn");loadActive();}catch(e){toast(e.message,"err");}};
      row.appendChild(b); box.appendChild(row);});
  }catch(e){/* non-fatal */}
}
const ACTIVITY_VERBS={
  APPROVAL_GRANTED:["ok","granted an additional bio break to"],
  APPROVAL_REVOKED:["info","revoked the additional bio break of"],
  LEAVE_APPROVED:["ok","approved the leave of"],
  LEAVE_REJECTED:["viol","rejected the leave of"],
};
function activityRow(r){
  const [cls,verb]=ACTIVITY_VERBS[r.action]||["info",r.action.replace(/_/g," ").toLowerCase()];
  const actor=(r.actorRole?(ROLE_TAG[r.actorRole]||r.actorRole)+" ":"")+(r.actorName||"Someone");
  const lt=r.leaveType?` (${r.leaveType.toLowerCase()})`:"";
  const row=document.createElement("div"); row.className="ev";
  row.innerHTML=`<time>${new Date(r.at||Date.now()).toLocaleTimeString()}</time>`+
    `<div style="flex:1" class="muted"><b style="color:var(--ink)">${actor}</b> ${verb} <b style="color:var(--ink)">${r.subjectName||"—"}</b>${lt}</div>`;
  return row;
}
async function loadAudit(){
  const box=document.getElementById("feed");
  try{
    const rows=await api("/approvals/audit");
    box.innerHTML="";
    if(!rows.length){ box.innerHTML='<div class="muted" style="padding:10px 2px;font-size:13px">No recent activity.</div>'; return; }
    rows.forEach(r=>box.appendChild(activityRow(r)));
  }catch(e){ /* non-fatal */ }
}
function addFeed(ev){
  const box=document.getElementById("feed");
  const labels={VIOLATION:["viol","Compliance violation"],ADDL_CONSUMED:["info","Additional bio break used"],
    EMPLOYEE_AUTO_LOGOUT:["viol","Agent auto-logged out"],APPROVAL_GRANTED:["ok","Approval granted"],
    APPROVAL_REVOKED:["info","Approval revoked"]};
  const [cls,text]=labels[ev.type]||["info",ev.type];
  const row=document.createElement("div"); row.className="ev";
  const detail=ev.detail||ev.violation||(ev.employeeId?("agent "+ev.employeeId.slice(-6)):"");
  row.innerHTML=`<time>${new Date(ev._t||Date.now()).toLocaleTimeString()}</time><span class="tag ${cls}">${text}</span><div style="flex:1" class="muted">${detail}</div>`;
  box.prepend(row);
}

// ── ACTIVITY TYPE MANAGEMENT (Team Lead) ──
async function renderActivityMgmt(){
  const list=await api("/activity-types").catch(()=>[]);
  const box=document.getElementById("activityTypeList"); if(!box) return;
  box.innerHTML="";
  if(!list.length){
    box.innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">No activity types yet. Add one above.</div>';
    return;
  }
  list.forEach(a=>{
    const chip=document.createElement("div");
    chip.className="chip"; chip.style.display="inline-flex"; chip.style.alignItems="center"; chip.style.gap="8px";
    chip.innerHTML=`<span>${esc(a.name)}</span>`;
    const del=document.createElement("button");
    del.textContent="×"; del.title="Remove"; del.style.cssText="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;padding:0;line-height:1";
    del.onmouseenter=()=>del.style.color="var(--red)"; del.onmouseleave=()=>del.style.color="var(--muted)";
    del.onclick=async()=>{
      const ok=await confirmDialog({title:`Remove "${a.name}"?`,message:"Agents currently on this activity won't be affected mid-shift.",confirmText:"Remove",kind:"danger"});
      if(!ok) return;
      try{
        await api(`/activity-types/${a.id}`,{method:"DELETE"});
        toast(`"${a.name}" removed`,"warn");
        renderActivityMgmt();
        buildClockStatics();
        renderAsgState();
      }catch(e){toast(e.message,"err");}
    };
    chip.appendChild(del);
    box.appendChild(chip);
  });
}

document.getElementById("addActivityBtn").onclick=async()=>{
  const input=document.getElementById("newActivityName");
  const name=input.value.trim(); if(!name) return;
  const btn=document.getElementById("addActivityBtn"); btn.disabled=true; btn.textContent="Adding…";
  try{
    await api("/activity-types",{method:"POST",body:{name}});
    toast(`"${name}" added`,"ok");
    input.value="";
    renderActivityMgmt();
    buildClockStatics();
    renderAsgState();
  }catch(e){toast(e.message,"err");}
  finally{btn.disabled=false; btn.textContent="Add";}
};
document.getElementById("newActivityName").onkeydown=e=>{if(e.key==="Enter") document.getElementById("addActivityBtn").click();};

// ── ACTIVITY ASSIGNMENT (Team Lead) ──
let asgTargets={employees:[],teams:[]};

async function loadAssignPanel(){
  try{ asgTargets=await api("/activity-assignments/targets"); }catch{ asgTargets={employees:[],teams:[]}; }
  populateAsgTargets();
  await renderAsgState();
}
function populateAsgTargets(){
  const kind=document.getElementById("asgKind").value;
  const sel=document.getElementById("asgTarget");
  if(kind==="all"){ sel.disabled=true; sel.innerHTML='<option value="">All members (current &amp; future)</option>'; return; }
  sel.disabled=false; sel.innerHTML="";
  const items=kind==="team"?asgTargets.teams:asgTargets.employees;
  if(!items.length){const o=document.createElement("option");o.value="";o.textContent="(none available)";sel.appendChild(o);return;}
  items.forEach(it=>{const o=document.createElement("option");o.value=it.id;
    o.textContent=kind==="team"?it.name:`${it.employeeCode} — ${it.fullName}`; sel.appendChild(o);});
}
function currentAsgQuery(){
  const kind=document.getElementById("asgKind").value;
  if(kind==="all") return {all:true};
  const id=document.getElementById("asgTarget").value;
  if(!id) return null;
  return kind==="team"?{teamId:id}:{employeeId:id};
}
async function renderAsgState(){
  const q=currentAsgQuery();
  const catBox=document.getElementById("asgCatalog"); const asgBox=document.getElementById("asgAssigned");
  catBox.innerHTML=""; asgBox.innerHTML="";
  if(!q){ asgBox.innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">Pick a target above.</div>'; return; }
  const qs=q.all?"all=1":(q.teamId?`teamId=${q.teamId}`:`employeeId=${q.employeeId}`);
  const assignBody=q.all?{}:q;
  const [catalog,assigned]=await Promise.all([
    api("/activity-types").catch(()=>[]),
    api(`/activity-assignments?${qs}`).catch(()=>[]),
  ]);
  const assignedIds=new Set(assigned.map(a=>a.activityType.id));
  const unassigned=catalog.filter(c=>!assignedIds.has(c.id));
  if(!unassigned.length){catBox.innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">All catalog activities are assigned.</div>';}
  unassigned.forEach(c=>{
    const chip=document.createElement("button"); chip.className="chip"; chip.innerHTML="+ "+c.name;
    chip.onclick=async()=>{
      try{ await api("/activity-assignments",{method:"POST",body:{activityTypeId:c.id,...assignBody}}); toast(`"${c.name}" assigned`,"ok"); renderAsgState(); buildClockStatics(); }
      catch(e){ toast(e.message,"err"); }
    };
    catBox.appendChild(chip);
  });
  if(!assigned.length){asgBox.innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">Nothing assigned yet.</div>';}
  assigned.forEach(a=>{
    const chip=document.createElement("div"); chip.className="chip on";
    chip.style.display="inline-flex"; chip.style.alignItems="center"; chip.style.gap="8px";
    chip.innerHTML=`<span>${esc(a.activityType.name)}</span>`;
    const del=document.createElement("button"); del.textContent="×"; del.title="Unassign";
    del.style.cssText="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;padding:0;line-height:1";
    del.onmouseenter=()=>del.style.color="var(--red)"; del.onmouseleave=()=>del.style.color="var(--muted)";
    del.onclick=async()=>{
      try{ await api(`/activity-assignments/${a.id}`,{method:"DELETE"}); toast("Unassigned","warn"); renderAsgState(); buildClockStatics(); }
      catch(e){ toast(e.message,"err"); }
    };
    chip.appendChild(del); asgBox.appendChild(chip);
  });
}
document.getElementById("asgKind").onchange=()=>{ populateAsgTargets(); renderAsgState(); };
document.getElementById("asgTarget").onchange=()=>renderAsgState();

// ── SCHEDULING (WFM) ──
let scTargets={employees:[],teams:[]};
let restSet=new Set();
let restWeekdays=new Set();
const SC_WEEKDAYS=[{n:1,l:"Mon"},{n:2,l:"Tue"},{n:3,l:"Wed"},{n:4,l:"Thu"},{n:5,l:"Fri"},{n:6,l:"Sat"},{n:0,l:"Sun"}];

async function loadSchedulePanel(){
  scTargets=await api("/schedules/targets").catch(()=>({employees:[],teams:[]}));
  populateScTargets();
  populateCopyTargets();
  populateOtEmp();
  const fd=document.getElementById("sc-filter-date");
  if(!fd.value) fd.value=dateStr(new Date());
  const od=document.getElementById("ot-date");
  if(!od.value) od.value=dateStr(new Date());
  renderWeekdayPattern();
  renderRestDays();
  loadScheduleList();
}

// ── Overtime management (WFM): grant per date + hours, separate from shifts ──
function populateOtEmp(){
  const sel=document.getElementById("ot-emp"); sel.innerHTML="";
  const items=scTargets.employees||[];
  if(!items.length){ const o=document.createElement("option"); o.value=""; o.textContent="(none available)"; sel.appendChild(o); document.getElementById("ot-list").innerHTML=""; return; }
  items.forEach(e=>{ const o=document.createElement("option"); o.value=e.id; o.textContent=`${e.employeeCode} — ${e.fullName}`; sel.appendChild(o); });
  loadOtGrants();
}
async function loadOtGrants(){
  const box=document.getElementById("ot-list");
  const eid=document.getElementById("ot-emp").value;
  if(!eid){ box.innerHTML=""; return; }
  box.innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">Loading…</div>';
  let rows;
  try{ rows=await api("/schedules/overtime?employeeId="+encodeURIComponent(eid)); }
  catch(e){ box.innerHTML='<div class="muted" style="font-size:13px">Could not load overtime.</div>'; return; }
  if(!rows.length){ box.innerHTML='<div class="muted" style="font-size:13px">No upcoming overtime.</div>'; return; }
  box.innerHTML="";
  rows.forEach(r=>{
    const row=document.createElement("div");
    row.style.cssText="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)";
    row.innerHTML=`<div><div style="font-weight:600;font-size:13px">${fmtDay(r.workDate)} · ${r.hours}h${r.classification?` <span style="color:var(--amber)">· ${r.classification}</span>`:''}</div>`+
      `<div class="muted" style="font-size:12px">${fmtTime(r.otStart)} – ${fmtTime(r.otEnd)}${r.acknowledged?' · acknowledged':''}</div></div>`;
    const del=document.createElement("button"); del.className="btn"; del.textContent="Remove";
    del.style.cssText="padding:5px 12px;font-size:12px;white-space:nowrap";
    del.onclick=async()=>{ del.disabled=true; try{ await api("/schedules/overtime/"+r.id,{method:"DELETE"}); toast("Overtime removed","ok"); loadOtGrants(); }catch(e){ toast(e.message,"err"); del.disabled=false; } };
    row.appendChild(del); box.appendChild(row);
  });
}
document.getElementById("ot-emp").onchange=loadOtGrants;
document.getElementById("ot-grant").onclick=async()=>{
  const btn=document.getElementById("ot-grant");
  const employeeId=document.getElementById("ot-emp").value;
  const date=document.getElementById("ot-date").value;
  const startTime=document.getElementById("ot-start").value;
  const hours=parseFloat(document.getElementById("ot-hours").value);
  if(!employeeId){ toast("Pick an employee.","err"); return; }
  if(!date){ toast("Pick a date.","err"); return; }
  if(!startTime){ toast("Set a start time.","err"); return; }
  if(!(hours>0)){ toast("Enter the number of hours.","err"); return; }
  btn.disabled=true; btn.textContent="Granting…";
  try{
    const r=await api("/schedules/overtime",{method:"POST",body:{employeeId,date,startTime,hours}});
    toast(`Overtime granted · ${hours}h${r.classification?` · ${r.classification}`:""}`,"ok");
    loadOtGrants();
  }catch(e){ toast(e.message,"err"); }
  finally{ btn.disabled=false; btn.textContent="Grant overtime"; }
};
let scScope="employee", scMultiSel=new Set();
function setScScope(s){
  scScope=s;
  document.getElementById("sc-scope-emp").classList.toggle("on",s==="employee");
  document.getElementById("sc-scope-multi").classList.toggle("on",s==="multi");
  document.getElementById("sc-scope-team").classList.toggle("on",s==="team");
  document.getElementById("sc-target").classList.toggle("hide",s==="multi");
  document.getElementById("sc-multi-wrap").classList.toggle("hide",s!=="multi");
  if(s==="multi") populateScMulti(); else populateScTargets();
}
function populateScTargets(){
  const sel=document.getElementById("sc-target"); sel.innerHTML="";
  const items=scScope==="team"?scTargets.teams:scTargets.employees;
  if(!items.length){const o=document.createElement("option");o.value="";o.textContent="(none available)";sel.appendChild(o);return;}
  items.forEach(it=>{const o=document.createElement("option");o.value=it.id;
    o.textContent=scScope==="team"?it.name:`${it.employeeCode} — ${it.fullName}`+((it.roles||[]).length?` · ${it.roles.join("/")}`:"");
    sel.appendChild(o);});
}
function populateScMulti(){
  const box=document.getElementById("sc-multi"); box.innerHTML="";
  const items=scTargets.employees||[];
  if(!items.length){ box.innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">No employees available.</div>'; return; }
  items.forEach(e=>{
    const chip=document.createElement("button"); chip.type="button";
    chip.className="chip"+(scMultiSel.has(e.id)?" on":"");
    chip.textContent=`${e.employeeCode} — ${e.fullName}`;
    chip.onclick=()=>{ if(scMultiSel.has(e.id))scMultiSel.delete(e.id); else scMultiSel.add(e.id); chip.classList.toggle("on"); };
    box.appendChild(chip);
  });
}
document.getElementById("sc-scope-emp").onclick=()=>setScScope("employee");
document.getElementById("sc-scope-multi").onclick=()=>setScScope("multi");
document.getElementById("sc-scope-team").onclick=()=>setScScope("team");

function rangeDates(){
  const s=document.getElementById("sc-start-date").value, e=document.getElementById("sc-end-date").value;
  if(!s||!e) return [];
  let t=new Date(s+"T00:00:00Z"); const last=new Date(e+"T00:00:00Z");
  if(isNaN(t)||isNaN(last)||last<t) return [];
  const out=[]; let guard=0;
  while(t<=last && guard++<400){ out.push(t.toISOString().slice(0,10)); t=new Date(t.getTime()+86400000); }
  return out;
}
function renderRestDays(){
  const wrap=document.getElementById("sc-restwrap"), box=document.getElementById("sc-restdays");
  const days=rangeDates();
  restSet=new Set([...restSet].filter(d=>days.includes(d))); // prune out-of-range
  if(!days.length){ wrap.classList.add("hide"); box.innerHTML=""; return; }
  wrap.classList.remove("hide"); box.innerHTML="";
  days.forEach(ds=>{
    const d=new Date(ds+"T00:00:00Z");
    const chip=document.createElement("button"); chip.type="button";
    chip.className="chip"+(restSet.has(ds)?" on":"");
    chip.textContent=d.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric",timeZone:"UTC"});
    chip.onclick=()=>{ if(restSet.has(ds))restSet.delete(ds); else restSet.add(ds); chip.classList.toggle("on"); };
    box.appendChild(chip);
  });
}
function renderWeekdayPattern(){
  const box=document.getElementById("sc-weekdays"); box.innerHTML="";
  SC_WEEKDAYS.forEach(d=>{
    const chip=document.createElement("button"); chip.type="button";
    chip.className="chip"+(restWeekdays.has(d.n)?" on":"");
    chip.textContent=d.l;
    chip.onclick=()=>{ if(restWeekdays.has(d.n))restWeekdays.delete(d.n); else restWeekdays.add(d.n); chip.classList.toggle("on"); applyWeekdayPattern(); };
    box.appendChild(chip);
  });
}
function applyWeekdayPattern(){
  const days=rangeDates();
  restSet=new Set(days.filter(ds=>restWeekdays.has(new Date(ds+"T00:00:00Z").getUTCDay())));
  renderRestDays();
}
function onScRangeChange(){ if(restWeekdays.size) applyWeekdayPattern(); else renderRestDays(); }
document.getElementById("sc-start-date").onchange=onScRangeChange;
document.getElementById("sc-end-date").onchange=onScRangeChange;

function shiftLengthHours(startTime,endTime){
  const [sh,sm]=startTime.split(":").map(Number);
  const [eh,em]=endTime.split(":").map(Number);
  let mins=(eh*60+em)-(sh*60+sm);
  if(mins<=0) mins+=1440; // crosses midnight
  return mins/60;
}
// POST a schedule action; if the server returns compliance warnings, confirm then retry with force.
async function postWithCompliance(url,body){
  let r=await api(url,{method:"POST",body});
  if(r&&r.needsConfirmation){
    // Leave conflicts (scheduling someone on approved/pending leave) are more
    // serious than shift-length nits — list them first so they always show
    // above the cap, and flag them in a header.
    const all=r.warnings||[];
    const leave=all.filter(w=>/\bleave\b/i.test(w));
    const ordered=[...leave,...all.filter(w=>!/\bleave\b/i.test(w))];
    const cap=8;
    const more=ordered.length>cap?`\n…and ${ordered.length-cap} more`:"";
    const header=leave.length
      ? `⚠ ${leave.length} leave conflict${leave.length>1?"s":""} — the person may be on approved/pending leave.\n\n`
      : "";
    const msg=header+"Compliance issues with this schedule:\n\n"+ordered.slice(0,cap).map(w=>"• "+w).join("\n")+more;
    const ok=await confirmDialog({title:"Compliance warnings",message:msg,confirmText:"Apply anyway",cancelText:"Go back",kind:"warn"});
    if(!ok) return null;
    r=await api(url,{method:"POST",body:{...body,force:true}});
  }
  return r;
}
document.getElementById("sc-apply").onclick=async()=>{
  const btn=document.getElementById("sc-apply");
  const targetId=document.getElementById("sc-target").value;
  const startDate=document.getElementById("sc-start-date").value;
  const endDate=document.getElementById("sc-end-date").value;
  const startTime=document.getElementById("sc-start-time").value;
  const endTime=document.getElementById("sc-end-time").value;
  const isNightShift=document.getElementById("sc-night").checked;
  if(scScope==="multi"){ if(!scMultiSel.size){toast("Pick at least one person.","err");return;} }
  else if(!targetId){toast("Pick a target.","err");return;}
  if(!startDate||!endDate){toast("Pick a start and end date.","err");return;}
  const working=rangeDates().filter(d=>!restSet.has(d));
  if(working.length && (!startTime||!endTime)){toast("Set start and end times for working days.","err");return;}
  // Shift-length warnings (under/over 8h) are enforced server-side and surface
  // through postWithCompliance() along with the other compliance checks.
  const body={startDate,endDate,startTime,endTime,isNightShift,restDays:[...restSet]};
  if(scScope==="team") body.teamId=targetId;
  else if(scScope==="multi") body.employeeIds=[...scMultiSel];
  else body.employeeId=targetId;
  btn.disabled=true; btn.textContent="Applying…";
  try{
    const r=await postWithCompliance("/schedules/apply",body);
    if(r){
      toast(`Applied to ${r.employees} ${r.employees===1?"person":"people"} · ${r.days} day(s), ${r.restDays} rest`,"ok");
      document.getElementById("sc-filter-date").value=startDate;
      loadScheduleList();
    }
  }catch(e){toast(e.message,"err");}
  finally{btn.disabled=false;btn.textContent="Apply schedule";}
};

document.getElementById("sc-filter-date").onchange=()=>loadScheduleList();
async function loadScheduleList(){
  const date=document.getElementById("sc-filter-date").value;
  const box=document.getElementById("sc-list"); box.innerHTML="";
  const list=await api("/schedules"+(date?`?date=${date}`:"")).catch(()=>[]);
  if(!list.length){box.innerHTML='<div class="muted" style="padding:10px 2px;font-size:13px">No schedules for this date.</div>';return;}
  const t=d=>new Date(d).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
  list.forEach(s=>{
    const row=document.createElement("div"); row.className="ev";
    const info=document.createElement("div"); info.style.flex="1";
    const ot=(s.otStart&&s.otEnd)?` <span class="tag info">OT ${t(s.otStart)}–${t(s.otEnd)}</span>`:"";
    const detail=s.isRestDay
      ? '<span class="tag warn">REST DAY</span>'
      : `${t(s.scheduledStart)}–${t(s.scheduledEnd)}${s.isNightShift?' <span class="tag info">night</span>':""}${ot}`;
    info.innerHTML=`<b>${esc(s.employee.employeeCode)} — ${esc(s.employee.fullName)}</b> · ${detail}`;
    const del=document.createElement("button"); del.className="btn ghost"; del.style.cssText="padding:4px 10px;font-size:12px"; del.textContent="Delete";
    del.onclick=async()=>{
      const ok=await confirmDialog({title:"Delete schedule?",message:`Remove ${s.employee.fullName}'s entry on this date?`,confirmText:"Delete",kind:"danger"});
      if(!ok) return;
      try{await api(`/schedules/${s.id}`,{method:"DELETE"});toast("Schedule deleted","warn");loadScheduleList();}catch(e){toast(e.message,"err");}
    };
    row.appendChild(info); row.appendChild(del); box.appendChild(row);
  });
}

// ── COPY A WEEK (WFM) ──
function populateCopyTargets(){
  const sel=document.getElementById("cw-target"); sel.innerHTML="";
  const all=document.createElement("option"); all.value=""; all.textContent="Everyone scheduled that week"; sel.appendChild(all);
  (scTargets.employees||[]).forEach(e=>{const o=document.createElement("option");o.value=e.id;o.textContent=`${e.employeeCode} — ${e.fullName}`;sel.appendChild(o);});
}
function addDaysStr(ds,n){ const d=new Date(ds+"T00:00:00Z"); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
document.getElementById("cw-from").onchange=()=>{ const f=document.getElementById("cw-from").value; if(f) document.getElementById("cw-to").value=addDaysStr(f,7); };
document.getElementById("cw-copy").onclick=async()=>{
  const btn=document.getElementById("cw-copy");
  const sourceStart=document.getElementById("cw-from").value;
  const destStart=document.getElementById("cw-to").value;
  const who=document.getElementById("cw-target").value;
  if(!sourceStart||!destStart){toast("Pick both the source and destination week.","err");return;}
  const body={sourceStart,destStart}; if(who) body.employeeId=who;
  btn.disabled=true; btn.textContent="Copying…";
  try{
    const r=await postWithCompliance("/schedules/copy-week",body);
    if(r){
      toast(`Copied ${r.copied} schedule ${r.copied===1?"entry":"entries"} to the week of ${destStart}`,"ok");
      document.getElementById("sc-filter-date").value=destStart;
      loadScheduleList();
    }
  }catch(e){toast(e.message,"err");}
  finally{btn.disabled=false;btn.textContent="Copy week →";}
};

// ── MANAGER OVERSIGHT ──
let ovTimer=null, ovNames=new Map();
function startOversightPoll(){ stopOversightPoll(); loadOversight(); ovTimer=setInterval(loadOversight,8000); }
function stopOversightPoll(){ if(ovTimer){ clearInterval(ovTimer); ovTimer=null; } }
function sinceStr(iso){ if(!iso) return ""; const m=Math.floor((Date.now()-new Date(iso).getTime())/60000); if(m<1)return "just now"; if(m<60)return "for "+m+"m"; return "for "+Math.floor(m/60)+"h "+(m%60)+"m"; }

async function loadOversight(){
  const box=document.getElementById("ov-board");
  try{
    const list=await api("/oversight");
    ovNames=new Map(list.map(p=>[p.id,p.fullName]));
    document.getElementById("ov-updated").textContent="· updated "+new Date().toLocaleTimeString();
    box.innerHTML="";
    if(!list.length){ box.innerHTML='<div class="muted" style="padding:10px 2px;font-size:13px">No floor agents or team leads in your scope.</div>'; return; }
    list.forEach(p=>{
      const row=document.createElement("div"); row.className="ev"; row.style.alignItems="center";
      const cls=p.status==="WORKING"?"ok":(p.status==="BREAK"?"warn":"info");
      const pill=p.status==="WORKING"?"On shift":(p.status==="BREAK"?"On break":"Clocked out");
      let detail="—";
      if(p.status==="WORKING") detail=(p.activity||"—")+(p.activitySince?` · ${sinceStr(p.activitySince)}`:"");
      else if(p.status==="BREAK") detail=((p.breakType||"").toLowerCase()+" break")+(p.breakSince?` · ${sinceStr(p.breakSince)}`:"");
      const roleTag=p.role==="TEAM_LEAD"?'<span class="tag info">Team Lead</span>':'<span class="tag">Agent</span>';
      const info=document.createElement("div"); info.style.flex="1";
      info.innerHTML=`<b>${esc(p.employeeCode)} — ${esc(p.fullName)}</b> ${roleTag}<div class="muted" style="font-size:12px">${detail}</div>`;
      const st=document.createElement("span"); st.className="tag "+cls; st.textContent=pill; st.style.marginRight="8px";
      const viewBtn=document.createElement("button"); viewBtn.className="btn ghost"; viewBtn.style.cssText="padding:4px 10px;font-size:12px"; viewBtn.textContent="View screen";
      viewBtn.onclick=()=>requestScreen(p.id, p.fullName);
      row.appendChild(info); row.appendChild(st); row.appendChild(viewBtn); box.appendChild(row);
    });
  }catch(e){ /* non-fatal — keep the last board on a transient error */ }
}

const VIOL_LABELS={EARLY_REGULAR_BREAK:"Early regular break",SECOND_REGULAR_BREAK:"2nd regular break",BIO_LIMIT_EXCEEDED:"Bio limit exceeded",ADDL_UNAPPROVED:"Unapproved additional break",BREAK_OVERRUN:"Break overrun",SHIFT_EXPIRED:"Shift expired",OUT_OF_SCHEDULE_LOGIN:"Out-of-schedule login"};
function violationRow(type, detail, who, when){
  const row=document.createElement("div"); row.className="ev";
  row.innerHTML=`<time>${new Date(when||Date.now()).toLocaleTimeString()}</time><span class="tag viol">${VIOL_LABELS[type]||type}</span>`+
    `<div style="flex:1" class="muted"><b style="color:var(--ink)">${who}</b>${detail?(" · "+detail):""}</div>`;
  return row;
}
async function loadOversightViolations(){
  const box=document.getElementById("ov-violations");
  try{
    const list=await api("/oversight/violations");
    box.innerHTML="";
    if(!list.length){ box.innerHTML='<div class="muted" style="padding:10px 2px;font-size:13px">No violations recorded.</div>'; return; }
    list.forEach(v=>box.appendChild(violationRow(v.type, v.detail, v.fullName||v.employeeCode||"agent", v.occurredAt)));
  }catch(e){ /* non-fatal */ }
}
function addLiveViolation(ev){
  const box=document.getElementById("ov-violations"); if(!box) return;
  const who=ovNames.get(ev.employeeId)||("agent "+(ev.employeeId?ev.employeeId.slice(-6):""));
  const empty=box.querySelector(".muted"); if(empty&&box.children.length===1) box.innerHTML="";
  box.prepend(violationRow(ev.violation, ev.detail, who, Date.now()));
}

// ── consent-based screen sharing (WebRTC) ──
const RTC_CONFIG={iceServers:[{urls:"stun:stun.l.google.com:19302"}]};
let viewPc=null, viewPeerSocket=null;          // manager viewing an employee
let sharePc=null, shareStream=null, sharePeerSocket=null; // employee sharing to a manager

function requestScreen(targetEmployeeId, name){
  if(!sock){ toast("Not connected.","err"); return; }
  stopViewing();
  document.getElementById("ov-viewer-panel").style.display="";
  document.getElementById("ov-viewer-name").textContent=name;
  document.getElementById("ov-viewer-status").textContent="Requesting… waiting for the employee to approve.";
  sock.emit("screen:request",{targetEmployeeId});
}
function stopViewing(){
  if(viewPc){ try{viewPc.close();}catch(e){} viewPc=null; }
  if(viewPeerSocket){ try{sock.emit("screen:stop",{toSocketId:viewPeerSocket});}catch(e){} viewPeerSocket=null; }
  const v=document.getElementById("ov-video"); if(v) v.srcObject=null;
}
function stopSharing(){
  if(shareStream){ shareStream.getTracks().forEach(t=>t.stop()); shareStream=null; }
  if(sharePc){ try{sharePc.close();}catch(e){} sharePc=null; }
  if(sharePeerSocket){ try{sock.emit("screen:stop",{toSocketId:sharePeerSocket});}catch(e){} sharePeerSocket=null; }
  document.getElementById("shareBanner").classList.add("hide");
}
document.getElementById("ov-viewer-stop").onclick=()=>{ stopViewing(); document.getElementById("ov-viewer-panel").style.display="none"; };
document.getElementById("shareStopBtn").onclick=stopSharing;

// ── PEOPLE / PROVISIONING (WFM, Admin) ──
const ROLE_TAG={EMPLOYEE:"EMP",TEAM_LEAD:"TL",MANAGER:"MGR",WFM:"WFM",HR:"HR",PAYROLL:"PAYROLL",ADMIN:"ADMIN"};
async function loadUsers(){
  const box=document.getElementById("pp-list");
  try{
    const list=await api("/admin/users");
    box.innerHTML="";
    if(!list.length){ box.innerHTML='<div class="muted" style="padding:10px 2px;font-size:13px">No users yet.</div>'; return; }
    list.forEach(u=>{
      const row=document.createElement("div"); row.className="ev";
      const tags=(u.roles||[]).map(r=>`<span class="tag">${ROLE_TAG[r]||r}</span>`).join(" ");
      row.innerHTML=`<div style="flex:1"><b>${esc(u.employeeCode)} — ${esc(u.fullName)}</b> ${tags}<div class="muted" style="font-size:12px">${esc(u.email||"no login")}</div></div>`;
      box.appendChild(row);
    });
  }catch(e){ /* non-fatal */ }
}
document.getElementById("pp-add").onclick=async()=>{
  const btn=document.getElementById("pp-add");
  const role=document.getElementById("pp-role").value;
  const fullName=document.getElementById("pp-name").value.trim();
  const email=document.getElementById("pp-email").value.trim();
  const password=document.getElementById("pp-pass").value;
  if(!fullName||!email||!password){ toast("Fill in name, email, and password.","err"); return; }
  if(password.length<8){ toast("Password must be at least 8 characters.","err"); return; }
  btn.disabled=true; btn.textContent="Creating…";
  try{
    const r=await api("/admin/users",{method:"POST",body:{role,fullName,email,password}});
    toast(`Created ${r.employeeCode} — ${r.fullName}`,"ok");
    document.getElementById("pp-name").value="";
    document.getElementById("pp-email").value="";
    document.getElementById("pp-pass").value="";
    loadUsers();
  }catch(e){ toast(e.message,"err"); }
  finally{ btn.disabled=false; btn.textContent="Create user"; }
};

// ── TEAMS (WFM, Admin) ──
let tmPeople={managers:[],leads:[],employees:[]};
function tmSelect(list, selectedId, placeholder){
  const sel=document.createElement("select");
  const none=document.createElement("option"); none.value=""; none.textContent=placeholder; sel.appendChild(none);
  list.forEach(u=>{ const o=document.createElement("option"); o.value=u.id; o.textContent=`${u.employeeCode} — ${u.fullName}`; if(u.id===selectedId)o.selected=true; sel.appendChild(o); });
  return sel;
}
async function loadTeams(){
  const box=document.getElementById("tm-list");
  const [teams, users]=await Promise.all([api("/admin/teams").catch(()=>[]), api("/admin/users").catch(()=>[])]);
  tmPeople={
    managers: users.filter(u=>(u.roles||[]).includes("MANAGER")),
    leads: users.filter(u=>(u.roles||[]).includes("TEAM_LEAD")),
    employees: users,
  };
  box.innerHTML="";
  if(!teams.length){ box.innerHTML='<div class="panel"><div class="muted" style="font-size:13px">No teams yet — create one above.</div></div>'; return; }
  teams.forEach(t=>box.appendChild(teamPanel(t)));
}
function teamPanel(t){
  const panel=document.createElement("div"); panel.className="panel";
  const header=document.createElement("div"); header.className="row"; header.style.cssText="gap:8px;align-items:center;margin-bottom:14px";
  const nameInput=document.createElement("input"); nameInput.value=t.name; nameInput.style.cssText="flex:1;max-width:300px;font-size:15px;font-weight:600";
  const renameBtn=document.createElement("button"); renameBtn.className="btn"; renameBtn.textContent="Rename"; renameBtn.style.cssText="padding:8px 16px;white-space:nowrap";
  renameBtn.onclick=async()=>{ const nn=nameInput.value.trim(); if(!nn){toast("Name can't be empty.","err");return;} try{await api(`/admin/teams/${t.id}`,{method:"PATCH",body:{name:nn}});toast("Team renamed","ok");loadTeams();}catch(e){toast(e.message,"err");} };
  const av=document.createElement(t.photoUrl?"img":"span");
  if(t.photoUrl){ av.src=t.photoUrl; av.style.cssText="width:40px;height:40px;border-radius:10px;object-fit:cover;flex-shrink:0"; }
  else { av.textContent="team"; av.style.cssText="width:40px;height:40px;border-radius:10px;background:var(--panel-2);border:1px solid var(--line);display:inline-flex;align-items:center;justify-content:center;color:var(--muted);font-size:11px;flex-shrink:0"; }
  const photoBtn=document.createElement("button"); photoBtn.className="btn"; photoBtn.textContent="Photo"; photoBtn.style.cssText="padding:8px 14px;white-space:nowrap";
  photoBtn.onclick=()=>pickPhoto(`/admin/teams/${t.id}/photo`, loadTeams);
  header.appendChild(av); header.appendChild(nameInput); header.appendChild(renameBtn); header.appendChild(photoBtn);
  panel.appendChild(header);

  const grid=document.createElement("div"); grid.className="row"; grid.style.cssText="gap:10px;margin-bottom:14px";
  const mgrWrap=document.createElement("label"); mgrWrap.className="fld"; mgrWrap.style.cssText="margin:0;flex:1;min-width:180px"; mgrWrap.innerHTML="<span>Manager</span>";
  const mgrSel=tmSelect(tmPeople.managers, t.manager?.id, "(none)");
  mgrSel.onchange=()=>updateTeam(t.id,{managerId:mgrSel.value||null});
  mgrWrap.appendChild(mgrSel);
  const leadWrap=document.createElement("label"); leadWrap.className="fld"; leadWrap.style.cssText="margin:0;flex:1;min-width:180px"; leadWrap.innerHTML="<span>Team lead</span>";
  const leadSel=tmSelect(tmPeople.leads, t.lead?.id, "(none)");
  leadSel.onchange=()=>updateTeam(t.id,{leadId:leadSel.value||null});
  leadWrap.appendChild(leadSel);
  grid.appendChild(mgrWrap); grid.appendChild(leadWrap);
  panel.appendChild(grid);

  const memLabel=document.createElement("div"); memLabel.className="muted"; memLabel.style.cssText="font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px"; memLabel.textContent="Members";
  panel.appendChild(memLabel);
  const memBox=document.createElement("div"); memBox.className="chips"; memBox.style.marginBottom="10px";
  if(!t.members.length) memBox.innerHTML='<div class="muted" style="font-size:13px">No members yet.</div>';
  t.members.forEach(m=>{
    const r=(m.roles||[]).includes("TEAM_LEAD")?"TL":((m.roles||[]).includes("MANAGER")?"MGR":"EMP");
    const chip=document.createElement("span"); chip.className="chip"; chip.style.cssText="display:inline-flex;align-items:center;gap:8px";
    chip.innerHTML=`<span>${esc(m.employeeCode)} — ${esc(m.fullName)} · ${r}</span>`;
    const x=document.createElement("button"); x.textContent="×"; x.title="Remove from team";
    x.style.cssText="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;padding:0;line-height:1";
    x.onmouseenter=()=>x.style.color="var(--red)"; x.onmouseleave=()=>x.style.color="var(--muted)";
    x.onclick=async()=>{ const ok=await confirmDialog({title:"Remove member?",message:`Remove ${m.fullName} from ${t.name}?`,confirmText:"Remove",kind:"danger"}); if(!ok) return;
      try{ await api(`/admin/teams/${t.id}/remove-member`,{method:"POST",body:{employeeId:m.id}}); toast("Member removed","warn"); loadTeams(); }catch(e){toast(e.message,"err");} };
    chip.appendChild(x); memBox.appendChild(chip);
  });
  panel.appendChild(memBox);

  const addRow=document.createElement("div"); addRow.className="row"; addRow.style.gap="8px";
  const addSel=tmSelect(tmPeople.employees, "", "Add a member…");
  const addBtn=document.createElement("button"); addBtn.className="btn"; addBtn.textContent="Add"; addBtn.style.cssText="padding:8px 16px;white-space:nowrap";
  addBtn.onclick=async()=>{ if(!addSel.value){toast("Pick someone to add.","err");return;}
    try{ await api(`/admin/teams/${t.id}/members`,{method:"POST",body:{employeeId:addSel.value}}); toast("Member added","ok"); loadTeams(); }catch(e){toast(e.message,"err");} };
  addRow.appendChild(addSel); addRow.appendChild(addBtn);
  panel.appendChild(addRow);
  return panel;
}
async function updateTeam(id, data){
  try{ await api(`/admin/teams/${id}`,{method:"PATCH",body:data}); toast("Team updated","ok"); loadTeams(); }
  catch(e){ toast(e.message,"err"); loadTeams(); }
}
document.getElementById("tm-create").onclick=async()=>{
  const name=document.getElementById("tm-name").value.trim();
  if(!name){toast("Enter a team name.","err");return;}
  try{ await api("/admin/teams",{method:"POST",body:{name}}); toast(`Team "${name}" created`,"ok"); document.getElementById("tm-name").value=""; loadTeams(); }
  catch(e){toast(e.message,"err");}
};

// ── LEAVE ──
const LEAVE_LABELS={VACATION:"Vacation",SICK:"Sick",EMERGENCY:"Emergency",BIRTHDAY:"Birthday"};
// Pay policy: Vacation is paid; Sick, Emergency and Birthday are unpaid.
const LEAVE_PAID={VACATION:true,SICK:false,EMERGENCY:false,BIRTHDAY:false};
const LEAVE_STATUS_CLS={PENDING:"info",APPROVED:"ok",REJECTED:"viol"};
// "Paid"/"Unpaid" chip. Prefers the server-provided flag, falls back to policy map.
function payTag(r){ const paid=(r&&r.paid!==undefined)?r.paid:LEAVE_PAID[r.leaveType]; return `<span class="tag ${paid?"ok":""}" style="margin-left:6px">${paid?"Paid":"Unpaid"}</span>`; }
// Thumbnails for Sick/Emergency supporting images (base64 data URLs). Server
// only ever stores `data:image/…` URLs, so they're safe to render as <img>.
function attachmentsHtml(r){
  const a=(r&&Array.isArray(r.attachments))?r.attachments:[];
  if(!a.length) return "";
  return `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">`+
    a.map(src=>`<a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="attachment" style="width:46px;height:46px;object-fit:cover;border-radius:6px;border:1px solid var(--line)"></a>`).join("")+
    `</div>`;
}

document.getElementById("lv-submit").onclick=async()=>{
  const btn=document.getElementById("lv-submit");
  const type=document.getElementById("lv-type").value;
  const start=document.getElementById("lv-start").value;
  const end=document.getElementById("lv-end").value;
  const reason=document.getElementById("lv-reason").value.trim();
  if(!start||!end){toast("Pick a start and end date.","err");return;}
  btn.disabled=true; btn.textContent="Submitting…";
  try{
    const body={leaveType:type,startDate:start,endDate:end,reason:reason||undefined};
    if((type==="SICK"||type==="EMERGENCY")&&leaveAttachments.length) body.attachments=leaveAttachments.slice();
    const r=await api("/leave",{method:"POST",body});
    toast(r.overrode>0?"Request submitted — replaced your previous request for these dates":"Leave request submitted","ok");
    document.getElementById("lv-start").value="";
    document.getElementById("lv-end").value="";
    document.getElementById("lv-reason").value="";
    leaveAttachments=[]; renderDocsPreview();
    loadMyLeave();
  }catch(e){toast(e.message,"err");}
  finally{btn.disabled=false;btn.textContent="Submit request";}
};

function dateStr(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
const lvType=document.getElementById("lv-type");
// Only Vacation needs advance notice (3 days); Sick, Emergency and Birthday may start same-day.
function leaveNoticeDays(type){ return type==="VACATION"?3:0; }
function minLeaveStr(type){ const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+leaveNoticeDays(type||(lvType&&lvType.value))); return dateStr(d); }
const lvStart=document.getElementById("lv-start"), lvEnd=document.getElementById("lv-end");
function applyLeaveMin(){ const m=minLeaveStr(); lvStart.min=m; if(lvStart.value&&lvStart.value<m) lvStart.value=""; lvEnd.min=lvStart.value||m; if(lvEnd.value&&lvStart.value&&lvEnd.value<lvStart.value) lvEnd.value=lvStart.value; }
lvStart.onchange=()=>{ lvEnd.min=lvStart.value||minLeaveStr(); if(lvEnd.value&&lvEnd.value<lvStart.value) lvEnd.value=lvStart.value; };

// ── Supporting documents (Sick/Emergency only) ──
const lvDocsFld=document.getElementById("lv-docs-fld");
const lvDocs=document.getElementById("lv-docs");
const lvDocsPreview=document.getElementById("lv-docs-preview");
let leaveAttachments=[];
function docsAllowed(){ const t=lvType&&lvType.value; return t==="SICK"||t==="EMERGENCY"; }
function renderDocsPreview(){
  if(!lvDocsPreview) return;
  lvDocsPreview.innerHTML="";
  leaveAttachments.forEach((src,i)=>{
    const w=document.createElement("span"); w.style.cssText="position:relative;display:inline-block";
    const img=document.createElement("img"); img.src=src; img.style.cssText="width:54px;height:54px;object-fit:cover;border-radius:8px;border:1px solid var(--line)";
    const x=document.createElement("button"); x.type="button"; x.textContent="×"; x.title="Remove";
    x.style.cssText="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;border:none;background:var(--red,#c0392b);color:#fff;cursor:pointer;font-size:12px;line-height:1;padding:0";
    x.onclick=()=>{ leaveAttachments.splice(i,1); renderDocsPreview(); };
    w.appendChild(img); w.appendChild(x); lvDocsPreview.appendChild(w);
  });
}
function syncDocsVisibility(){
  const show=docsAllowed();
  if(lvDocsFld) lvDocsFld.classList.toggle("hide",!show);
  if(!show){ leaveAttachments=[]; if(lvDocs) lvDocs.value=""; renderDocsPreview(); }
}
if(lvDocs) lvDocs.onchange=()=>{
  const files=Array.from(lvDocs.files||[]); lvDocs.value="";
  for(const f of files){
    if(leaveAttachments.length>=5){ toast("You can attach at most 5 images.","err"); break; }
    if(!f.type.startsWith("image/")){ toast(`"${f.name}" is not an image.`,"err"); continue; }
    if(f.size>1500000){ toast(`"${f.name}" is too large (max 1.5 MB).`,"err"); continue; }
    const rd=new FileReader();
    rd.onload=()=>{ if(leaveAttachments.length<5){ leaveAttachments.push(rd.result); renderDocsPreview(); } };
    rd.readAsDataURL(f);
  }
};

applyLeaveMin();
syncDocsVisibility();
if(lvType) lvType.onchange=()=>{ applyLeaveMin(); syncDocsVisibility(); };

async function loadMyLeave(){
  applyLeaveMin();
  try{
    const list=await api("/leave/my");
    const box=document.getElementById("lv-list"); box.innerHTML="";
    if(!list.length){box.innerHTML='<div class="muted" style="padding:10px 2px;font-size:13px">No leave requests yet.</div>';return;}
    list.forEach(r=>{
      const row=document.createElement("div"); row.className="ev";
      const cls=LEAVE_STATUS_CLS[r.status]||"info";
      const dates=fmtDate(r.startDate)+(r.startDate!==r.endDate?" → "+fmtDate(r.endDate):"");
      row.innerHTML=`<time>${fmtDate(r.submittedAt)}</time><span class="tag ${cls}">${r.status}</span>`+
        `<div style="flex:1"><b>${LEAVE_LABELS[r.leaveType]}</b>${payTag(r)} · ${dates}`+
        (r.reason?`<div class="muted" style="font-size:12px">${esc(r.reason)}</div>`:"")+
        (r.reviewNote?`<div class="muted" style="font-size:12px">Note: ${esc(r.reviewNote)}</div>`:"")+
        attachmentsHtml(r)+
        `</div>`;
      box.appendChild(row);
    });
  }catch(e){/* non-fatal */}
}

async function loadLeaveRequests(){
  try{
    const list=await api("/leave/team");
    const box=document.getElementById("leaveList"); box.innerHTML="";
    if(!list.length){box.innerHTML='<div class="muted" style="padding:10px 2px;font-size:13px">No pending requests.</div>';return;}
    list.forEach(r=>{
      const row=document.createElement("div"); row.className="ev"; row.style.flexWrap="wrap"; row.style.gap="8px";
      const dates=fmtDate(r.startDate)+(r.startDate!==r.endDate?" → "+fmtDate(r.endDate):"");
      const info=document.createElement("div"); info.style.flex="1";
      const notice=r.onTime
        ?`<span class="tag ok" title="Submitted ${r.noticeDays} days before the leave date">2+ weeks notice</span>`
        :`<span class="tag viol" title="Submitted only ${r.noticeDays} day${r.noticeDays===1?"":"s"} before the leave date">Late · short notice</span>`;
      info.innerHTML=`<b>${esc(r.employee.employeeCode)} — ${esc(r.employee.fullName)}</b> · <span class="tag info">${LEAVE_LABELS[r.leaveType]}</span>${payTag(r)} ${dates} ${notice}`+
        (r.reason?`<div class="muted" style="font-size:12px">${esc(r.reason)}</div>`:"")+
        attachmentsHtml(r);
      const noteInput=document.createElement("input");
      noteInput.placeholder="Optional note…"; noteInput.style.cssText="width:160px;padding:6px 10px;font-size:12px";
      const approve=document.createElement("button"); approve.className="btn primary"; approve.style.cssText="padding:6px 12px;font-size:12px"; approve.textContent="Approve";
      const reject=document.createElement("button");  reject.className="btn danger";  reject.style.cssText="padding:6px 12px;font-size:12px";  reject.textContent="Reject";
      approve.onclick=async()=>{
        try{await api(`/leave/${r.id}/approve`,{method:"POST",body:{note:noteInput.value.trim()||undefined}});toast("Approved","ok");loadLeaveRequests();}
        catch(e){toast(e.message,"err");}
      };
      reject.onclick=async()=>{
        try{await api(`/leave/${r.id}/reject`,{method:"POST",body:{note:noteInput.value.trim()||undefined}});toast("Rejected","warn");loadLeaveRequests();}
        catch(e){toast(e.message,"err");}
      };
      row.appendChild(info); row.appendChild(noteInput); row.appendChild(approve); row.appendChild(reject);
      box.appendChild(row);
    });
  }catch(e){/* non-fatal */}
}

function fmtDate(iso){
  if(!iso) return "";
  return new Date(iso).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"});
}

// ── PAYROLL (Payroll specialist, Admin) ──
function loadPayroll(){
  const s=document.getElementById("pr-start"), e=document.getElementById("pr-end");
  if(!s.value||!e.value){ const t=new Date(); const first=new Date(t.getFullYear(),t.getMonth(),1);
    s.value=dateStr(first); e.value=dateStr(t); }
  loadPayRates();
  loadComponents();
  loadComponentTargets();
  document.getElementById("pr-results").innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">Pick a period and run payroll.</div>';
  document.getElementById("pr-payslips").innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">Generate payslips for the period to edit and release them.</div>';
  document.getElementById("pr-editor").innerHTML="";
}
async function loadPayRates(){
  const box=document.getElementById("pr-rates");
  try{
    const list=await api("/payroll/rates");
    box.innerHTML="";
    if(!list.length){ box.innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">No employees.</div>'; return; }
    list.forEach(p=>{
      const row=document.createElement("div"); row.className="ev"; row.style.alignItems="center";
      const info=document.createElement("div"); info.style.flex="1";
      info.innerHTML=`<b>${esc(p.employeeCode)} — ${esc(p.fullName)}</b>`;
      const inp=document.createElement("input"); inp.type="number"; inp.min="0"; inp.step="0.01";
      inp.value=(p.hourlyRate??"")===""?"":p.hourlyRate; inp.placeholder="₱/hr";
      inp.style.cssText="width:90px;padding:6px 10px;font-size:13px";
      const save=document.createElement("button"); save.className="btn"; save.textContent="Save"; save.style.cssText="padding:6px 12px;font-size:12px";
      save.onclick=async()=>{ const r=Number(inp.value); if(!(r>=0)){toast("Enter a valid rate.","err");return;}
        try{ await api("/payroll/rates",{method:"POST",body:{employeeId:p.id,hourlyRate:r}}); toast("Rate saved","ok"); }catch(err){toast(err.message,"err");} };
      row.appendChild(info); row.appendChild(inp); row.appendChild(save); box.appendChild(row);
    });
  }catch(e){ /* non-fatal */ }
}
document.getElementById("pr-run").onclick=async()=>{
  const btn=document.getElementById("pr-run");
  const start=document.getElementById("pr-start").value, end=document.getElementById("pr-end").value;
  if(!start||!end){ toast("Pick a start and end date.","err"); return; }
  btn.disabled=true; btn.textContent="Running…";
  const box=document.getElementById("pr-results");
  try{
    const rows=await api(`/payroll/run?start=${start}&end=${end}`);
    box.innerHTML="";
    let total=0;
    rows.forEach(r=>{
      total+=r.gross;
      const row=document.createElement("div"); row.className="ev"; row.style.alignItems="center";
      const info=document.createElement("div"); info.style.flex="1";
      info.innerHTML=`<b>${esc(r.employeeCode)} — ${esc(r.fullName)}</b><div class="muted" style="font-size:12px">`+
        `${r.regularHours}h reg · ${r.overtimeHours}h OT · ${r.nightHours}h night · ₱${r.rate}/hr</div>`;
      const amt=document.createElement("span"); amt.className="tag ok"; amt.textContent=fmtPeso(r.gross);
      row.appendChild(info); row.appendChild(amt); box.appendChild(row);
    });
    if(!rows.length) box.innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">No employees.</div>';
    else { const t=document.createElement("div"); t.className="ev"; t.style.marginTop="4px";
      t.innerHTML=`<div style="flex:1"><b>Total gross</b></div><b>${fmtPeso(total)}</b>`; box.appendChild(t); }
  }catch(e){ toast(e.message,"err"); }
  finally{ btn.disabled=false; btn.textContent="Run payroll"; }
};

// ════════════════════ PAYROLL · PAYSLIPS · OVERTIME ════════════════════
function fmtPeso(n){ return "₱"+Number(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtDay(d){ if(!d) return ""; const x=new Date(d); return isNaN(x)?String(d):x.toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"}); }
function fmtTime(d){ if(!d) return ""; const x=new Date(d); return isNaN(x)?"":x.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}); }

// ── Overtime banner on the employee clock ──
let OT_GRANTS=[];
async function loadOvertime(){
  const box=document.getElementById("otBanner");
  if(!box) return;
  if(!user||!user.employeeId){ box.classList.add("hide"); return; }
  try{ OT_GRANTS=await api("/me/overtime"); }catch{ OT_GRANTS=[]; }
  if(!OT_GRANTS.length){ box.classList.add("hide"); box.innerHTML=""; return; }
  box.classList.remove("hide"); box.innerHTML="";
  OT_GRANTS.forEach(g=>{
    const card=document.createElement("div");
    card.style.cssText="border:1px solid var(--amber);background:#16130a;border-radius:12px;padding:14px 16px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap";
    card.innerHTML=`<div><b style="color:var(--amber)">⏱ WFM has provided you with overtime</b>`+
      `<div class="muted" style="font-size:13px;margin-top:2px">${fmtDay(g.workDate)} · ${fmtTime(g.otStart)}–${fmtTime(g.otEnd)}${g.classification?` · ${g.classification}`:''}</div></div>`;
    const btn=document.createElement("button"); btn.className="btn warn"; btn.textContent="Got it";
    btn.style.cssText="padding:6px 14px;font-size:13px;white-space:nowrap";
    btn.onclick=()=>ackOvertime(g.id);
    card.appendChild(btn); box.appendChild(card);
  });
}
async function ackOvertime(id){
  // Guard against an accidental tap: dismissing only hides the reminder, but
  // make the user confirm and tell them where to find the OT afterwards.
  const ok=await confirmDialog({title:"Dismiss overtime reminder?",
    message:"This only hides the reminder. Your overtime is still scheduled and you'll still be paid for it — you can always see it under “My schedule”.",
    confirmText:"Dismiss",cancelText:"Keep it",kind:"warn"});
  if(!ok) return;
  try{ await api(`/me/overtime/${id}/ack`,{method:"POST"}); }catch(e){ toast(e.message,"err"); return; }
  loadOvertime();
}

// ── My schedule (read-only): upcoming shifts + granted overtime ──
async function loadMySchedule(){
  const box=document.getElementById("mysched-list");
  if(!box) return;
  box.innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">Loading…</div>';
  let rows;
  try{ rows=await api("/me/schedule"); }
  catch(e){ box.innerHTML='<div class="muted" style="font-size:13px">Could not load your schedule.</div>'; return; }
  if(!rows.length){ box.innerHTML='<div class="muted" style="font-size:13px">No upcoming shifts scheduled.</div>'; return; }
  box.innerHTML="";
  rows.forEach(r=>{
    const card=document.createElement("div");
    card.style.cssText="border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:10px;background:var(--panel)";
    const shift=r.isRestDay
      ? '<span class="muted">Rest day — no shift</span>'
      : r.scheduledStart
        ? `<b>${fmtTime(r.scheduledStart)} – ${fmtTime(r.scheduledEnd)}</b>`+(r.isNightShift?' <span class="muted" style="font-size:12px">· night shift</span>':'')
        : '<span class="muted">Overtime only — no regular shift</span>';
    let html=`<div class="row" style="justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">`+
      `<div><div style="font-size:13px;color:var(--muted)">${fmtDay(r.workDate)}</div>`+
      `<div style="margin-top:2px">${shift}</div></div>`;
    if(r.hasOvertime){
      html+=`<div style="border:1px solid var(--amber);border-radius:10px;padding:8px 12px;background:#16130a">`+
        `<div style="color:var(--amber);font-weight:600;font-size:13px">⏱ ${r.otClass||'Overtime'}</div>`+
        `<div style="font-size:13px;margin-top:2px">${fmtTime(r.otStart)} – ${fmtTime(r.otEnd)}</div>`+
        `<div class="muted" style="font-size:11px;margin-top:2px">${r.otAcknowledged?"Acknowledged":"New — not yet acknowledged"}</div>`+
      `</div>`;
    }
    html+=`</div>`;
    card.innerHTML=html;
    box.appendChild(card);
  });
}

// ── My payslips (every member) ──
async function loadMyPayslips(){
  const box=document.getElementById("my-payslip-list");
  box.innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">Loading…</div>';
  document.getElementById("my-payslip-body").innerHTML="";
  document.getElementById("my-payslip-hint").textContent="Select a payslip to view its earnings, allowances, and deductions.";
  try{
    const list=await api("/me/payslips");
    box.innerHTML="";
    if(!list.length){ box.innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">No payslips have been released to you yet.</div>'; return; }
    list.forEach(p=>{
      const row=document.createElement("div"); row.className="ev"; row.style.cssText="align-items:center;cursor:pointer";
      const info=document.createElement("div"); info.style.flex="1";
      info.innerHTML=`<b>${fmtDay(p.periodStart)} – ${fmtDay(p.periodEnd)}</b>`+
        `<div class="muted" style="font-size:12px">Released ${fmtDay(p.releasedAt)}</div>`;
      const amt=document.createElement("span"); amt.className="tag ok"; amt.textContent=fmtPeso(p.netPay);
      row.appendChild(info); row.appendChild(amt);
      row.onclick=()=>openMyPayslip(p.id);
      box.appendChild(row);
    });
  }catch(e){ box.innerHTML=`<div class="muted" style="font-size:13px;padding:4px 0">${e.message}</div>`; }
}
async function openMyPayslip(id){
  const body=document.getElementById("my-payslip-body");
  body.innerHTML='<div class="muted" style="font-size:13px">Loading…</div>';
  try{
    const p=await api(`/me/payslips/${id}`);
    document.getElementById("my-payslip-hint").textContent=`${fmtDay(p.periodStart)} – ${fmtDay(p.periodEnd)}`;
    const sec=(title,cat)=>{ const ls=p.lines.filter(l=>l.category===cat); if(!ls.length) return "";
      return `<div class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin:12px 0 4px">${title}</div>`+
        ls.map(l=>`<div class="ev" style="align-items:center"><div style="flex:1">${esc(l.label)}</div><span>${fmtPeso(l.amount)}</span></div>`).join(""); };
    body.innerHTML=sec("Earnings","EARNING")+sec("Allowances","ALLOWANCE")+sec("Deductions","DEDUCTION")+
      `<div class="ev" style="margin-top:10px;align-items:center"><div style="flex:1"><b>Net pay</b></div><b>${fmtPeso(p.netPay)}</b></div>`+
      `<div class="muted" style="font-size:12px;margin-top:8px">${p.regularHours}h regular · ${p.overtimeHours}h OT · ${p.nightHours}h night · gross ${fmtPeso(p.grossPay)}</div>`+
      `<button class="btn" id="my-dl-btn" style="width:100%;margin-top:16px">⬇ Download payslip (PDF)</button>`;
    document.getElementById("my-dl-btn").onclick=()=>downloadPayslip(p);
  }catch(e){ body.innerHTML=`<div class="muted" style="font-size:13px">${e.message}</div>`; }
}
// Build a real PDF with jsPDF and save it straight to Downloads — a true file
// download, not a print dialog. jsPDF's default font is WinAnsi-encoded, so the
// text stays ASCII (no peso sign / en-dash, which would render as blanks).
function downloadPayslip(p){
  const JS = window.jspdf && window.jspdf.jsPDF;
  if(!JS){ toast("PDF engine didn't load — refresh and try again.","err"); return; }
  const emp=(user&&user.employee)||{};
  const money=n=>"PHP "+Number(n||0).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2});
  const day=d=>{ const x=new Date(d); return isNaN(x)?String(d||"").slice(0,10):x.toLocaleDateString("en-PH",{year:"numeric",month:"short",day:"numeric"}); };
  const doc=new JS({unit:"pt",format:"a4"});
  const L=56, R=539; let y=72;
  doc.setTextColor(24);
  doc.setFont("helvetica","bold").setFontSize(22).text("Payslip", L, y);
  doc.setFont("helvetica","normal").setFontSize(10).setTextColor(120).text("Shift Console", L, y+15);
  doc.setFontSize(11).setTextColor(24).text(`${day(p.periodStart)} - ${day(p.periodEnd)}`, R, y, {align:"right"});
  y+=30; doc.setDrawColor(24).setLineWidth(1.2).line(L,y,R,y); y+=24;
  doc.setFont("helvetica","bold").setFontSize(13).text(emp.fullName||(user&&user.email)||"Employee", L, y);
  const meta=[emp.employeeCode, emp.team&&emp.team.name].filter(Boolean).join("   -   ");
  if(meta){ y+=15; doc.setFont("helvetica","normal").setFontSize(10).setTextColor(120).text(meta, L, y); doc.setTextColor(24); }
  const row=(label,amount,o={})=>{
    y+=o.gap||18;
    doc.setFont("helvetica",o.bold?"bold":"normal").setFontSize(o.size||11).setTextColor(24);
    doc.text(String(label), L, y);
    doc.text(money(amount), R, y, {align:"right"});
  };
  const heading=t=>{ y+=20; doc.setFont("helvetica","bold").setFontSize(9).setTextColor(120).text(t.toUpperCase(), L, y); doc.setTextColor(24); };
  const section=(title,cat)=>{ const ls=p.lines.filter(l=>l.category===cat); if(!ls.length) return; heading(title); ls.forEach(l=>row(l.label,l.amount)); };
  section("Earnings","EARNING");
  section("Allowances","ALLOWANCE");
  section("Deductions","DEDUCTION");
  y+=14; doc.setDrawColor(24).setLineWidth(1).line(L,y,R,y);
  row("Gross pay", p.grossPay);
  row("Add: allowances", p.totalAllowances);
  row("Less: deductions", p.totalDeductions);
  y+=8; doc.setLineWidth(1.5).line(L,y,R,y);
  row("Net pay", p.netPay, {bold:true,size:15,gap:24});
  y+=22; doc.setFont("helvetica","normal").setFontSize(9).setTextColor(120);
  doc.text(`${p.regularHours}h regular  -  ${p.overtimeHours}h OT  -  ${p.nightHours}h night${p.releasedAt?"  -  Released "+day(p.releasedAt):""}`, L, y);
  doc.save(`Payslip-${String(p.periodStart||"").slice(0,10)}.pdf`);
}

// ── Payroll: pay components ──
let PC_TARGETS={employees:[],teams:[]};
async function loadComponentTargets(){
  try{ PC_TARGETS=await api("/payroll/targets"); }catch{ PC_TARGETS={employees:[],teams:[]}; }
  syncComponentTargetOptions();
}
function syncComponentTargetOptions(){
  const scope=document.getElementById("pc-scope").value;
  const wrap=document.getElementById("pc-target-wrap"), sel=document.getElementById("pc-target");
  if(scope==="ORG"){ wrap.classList.add("hide"); sel.innerHTML=""; return; }
  wrap.classList.remove("hide");
  sel.innerHTML=(scope==="TEAM"
    ? PC_TARGETS.teams.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`)
    : PC_TARGETS.employees.map(e=>`<option value="${e.id}">${esc(e.employeeCode)} — ${esc(e.fullName)}</option>`)
  ).join("")||'<option value="">(none available)</option>';
}
function syncComponentMethodFields(){
  const m=document.getElementById("pc-method").value;
  document.getElementById("pc-amount-wrap").classList.toggle("hide",m!=="FIXED");
  document.getElementById("pc-percent-wrap").classList.toggle("hide",m!=="PERCENT_OF_GROSS");
  document.getElementById("pc-brackets-wrap").classList.toggle("hide",m!=="BRACKET");
  if(m==="BRACKET" && !document.querySelector("#pc-brackets-rows .bracket-row")) addBracketRow();
}
document.getElementById("pc-method").onchange=syncComponentMethodFields;
document.getElementById("pc-scope").onchange=syncComponentTargetOptions;
document.getElementById("pc-bracket-add").onclick=()=>addBracketRow();

// ── Bracket-table builder: rows of "Up to ₱___ → ₱amount / %value" ──
function bracketRowEl(band){
  band=band||{};
  const row=document.createElement("div"); row.className="row bracket-row";
  row.style.cssText="gap:8px;margin-bottom:8px;align-items:center;flex-wrap:wrap";
  const upLbl=document.createElement("span"); upLbl.className="muted";
  upLbl.style.cssText="font-size:12px;white-space:nowrap"; upLbl.textContent="Up to ₱";
  const up=document.createElement("input"); up.type="number"; up.min="0"; up.step="0.01";
  up.placeholder="no limit"; up.className="bk-up"; up.style.cssText="flex:1;min-width:70px;padding:6px 8px;font-size:13px";
  if(band.upTo!=null) up.value=band.upTo;
  const arrow=document.createElement("span"); arrow.className="muted"; arrow.style.cssText="font-size:13px"; arrow.textContent="→";
  const type=document.createElement("select"); type.className="bk-type"; type.style.cssText="padding:6px 8px;font-size:13px";
  type.innerHTML='<option value="amount">₱ amount</option><option value="percent">% of gross</option>';
  if(band.percent!=null) type.value="percent";
  const val=document.createElement("input"); val.type="number"; val.min="0"; val.step="0.01";
  val.placeholder="value"; val.className="bk-val"; val.style.cssText="width:90px;padding:6px 8px;font-size:13px";
  if(band.amount!=null) val.value=band.amount; else if(band.percent!=null) val.value=band.percent;
  const del=document.createElement("button"); del.type="button"; del.className="btn ghost"; del.textContent="×";
  del.style.cssText="padding:5px 10px;font-size:14px"; del.onclick=()=>row.remove();
  row.append(upLbl,up,arrow,type,val,del);
  return row;
}
function addBracketRow(band){ document.getElementById("pc-brackets-rows").appendChild(bracketRowEl(band)); }
function resetBracketRows(){ document.getElementById("pc-brackets-rows").innerHTML=""; addBracketRow(); }
function readBrackets(){
  const out=[];
  document.querySelectorAll("#pc-brackets-rows .bracket-row").forEach(r=>{
    const upRaw=r.querySelector(".bk-up").value.trim();
    const valRaw=r.querySelector(".bk-val").value.trim();
    if(valRaw==="") return;                       // skip incomplete bands
    const band={ upTo: upRaw===""?null:Number(upRaw) };
    if(r.querySelector(".bk-type").value==="percent") band.percent=Number(valRaw);
    else band.amount=Number(valRaw);
    out.push(band);
  });
  return out;
}
document.getElementById("pc-add").onclick=async()=>{
  const kind=document.getElementById("pc-kind").value, name=document.getElementById("pc-name").value.trim();
  const method=document.getElementById("pc-method").value, scope=document.getElementById("pc-scope").value;
  if(!name){ toast("Enter a name.","err"); return; }
  const body={kind,name,method,scope};
  if(method==="FIXED"){ const a=Number(document.getElementById("pc-amount").value); if(!(a>=0)){toast("Enter a valid amount.","err");return;} body.amount=a; }
  else if(method==="PERCENT_OF_GROSS"){ const p=Number(document.getElementById("pc-percent").value); if(!(p>=0)){toast("Enter a valid percent.","err");return;} body.percent=p; }
  else { body.brackets=readBrackets();
    if(!body.brackets.length){ toast("Add at least one band with a value.","err"); return; }
    if(body.brackets.some(b=>(b.upTo!=null && !(b.upTo>=0)) || (b.amount!=null && !(b.amount>=0)) || (b.percent!=null && !(b.percent>=0)))){
      toast("Band ceilings and values must be non-negative numbers.","err"); return; } }
  if(scope!=="ORG"){ const t=document.getElementById("pc-target").value; if(!t){ toast("Pick a target.","err"); return; }
    if(scope==="TEAM") body.teamId=t; else body.employeeId=t; }
  try{
    await api("/payroll/components",{method:"POST",body});
    toast("Component added","ok");
    ["pc-name","pc-amount","pc-percent"].forEach(id=>document.getElementById(id).value="");
    resetBracketRows();
    loadComponents();
  }catch(e){ toast(e.message,"err"); }
};
async function loadComponents(){
  const box=document.getElementById("pc-list");
  box.innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">Loading…</div>';
  try{
    const list=await api("/payroll/components");
    box.innerHTML="";
    if(!list.length){ box.innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">No components yet.</div>'; return; }
    list.forEach(c=>{
      const row=document.createElement("div"); row.className="ev"; row.style.alignItems="center";
      const how=c.method==="FIXED"?fmtPeso(c.amount):c.method==="PERCENT_OF_GROSS"?`${c.percent}% of gross`:"bracket table";
      const info=document.createElement("div"); info.style.flex="1";
      info.innerHTML=`<b>${esc(c.name)}</b> <span class="tag ${c.kind==="ALLOWANCE"?"ok":""}">${c.kind==="ALLOWANCE"?"Allowance":"Deduction"}</span>`+
        `<div class="muted" style="font-size:12px">${how} · ${c.targetLabel}${c.active?"":" · inactive"}</div>`;
      const del=document.createElement("button"); del.className="btn ghost"; del.textContent="Remove"; del.style.cssText="padding:6px 12px;font-size:12px";
      del.onclick=async()=>{
        const ok=await confirmDialog({title:"Remove component?",message:`Remove "${c.name}"? If it's already used on a payslip it's deactivated instead of deleted.`,confirmText:"Remove",kind:"danger"});
        if(!ok) return;
        try{ await api(`/payroll/components/${c.id}`,{method:"DELETE"}); toast("Removed","ok"); loadComponents(); }catch(e){ toast(e.message,"err"); }
      };
      row.appendChild(info); row.appendChild(del); box.appendChild(row);
    });
  }catch(e){ box.innerHTML=`<div class="muted" style="font-size:13px;padding:4px 0">${e.message}</div>`; }
}

// ── Payroll: payslip generation, editing, release ──
document.getElementById("pr-generate").onclick=async()=>{
  const start=document.getElementById("pr-start").value, end=document.getElementById("pr-end").value;
  if(!start||!end){ toast("Pick a start and end date above.","err"); return; }
  const btn=document.getElementById("pr-generate"); btn.disabled=true; btn.textContent="Generating…";
  try{
    const r=await api("/payroll/payslips/generate",{method:"POST",body:{start,end}});
    const made=r.generated.filter(g=>!g.skipped).length, skipped=r.generated.filter(g=>g.skipped).length;
    toast(`Generated ${made} payslip${made!==1?"s":""}${skipped?` · ${skipped} already released`:""}`,"ok");
    loadPayslips();
  }catch(e){ toast(e.message,"err"); }
  finally{ btn.disabled=false; btn.textContent="Generate payslips for the selected period"; }
};
async function loadPayslips(){
  const start=document.getElementById("pr-start").value, end=document.getElementById("pr-end").value;
  const box=document.getElementById("pr-payslips");
  document.getElementById("pr-editor").innerHTML="";
  if(!start||!end) return;
  box.innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">Loading…</div>';
  try{
    const list=await api(`/payroll/payslips?start=${start}&end=${end}`);
    box.innerHTML="";
    if(!list.length){ box.innerHTML='<div class="muted" style="font-size:13px;padding:4px 0">No payslips for this period yet — generate them.</div>'; return; }
    list.forEach(p=>{
      const row=document.createElement("div"); row.className="ev"; row.style.alignItems="center";
      const info=document.createElement("div"); info.style.flex="1";
      info.innerHTML=`<b>${esc(p.employeeCode)} — ${esc(p.fullName)}</b>`+
        `<div class="muted" style="font-size:12px">gross ${fmtPeso(p.grossPay)} · +${fmtPeso(p.totalAllowances)} · −${fmtPeso(p.totalDeductions)} · net ${fmtPeso(p.netPay)}</div>`;
      const tag=document.createElement("span"); tag.className="tag "+(p.status==="RELEASED"?"ok":""); tag.textContent=p.status==="RELEASED"?"Released":"Draft";
      const edit=document.createElement("button"); edit.className="btn"; edit.textContent=p.status==="RELEASED"?"View":"Edit"; edit.style.cssText="padding:6px 12px;font-size:12px";
      edit.onclick=()=>openPayslipEditor(p.id);
      row.appendChild(info); row.appendChild(tag); row.appendChild(edit); box.appendChild(row);
    });
  }catch(e){ box.innerHTML=`<div class="muted" style="font-size:13px;padding:4px 0">${e.message}</div>`; }
}
async function openPayslipEditor(id){
  const ed=document.getElementById("pr-editor");
  ed.innerHTML='<div class="muted" style="font-size:13px;padding:8px 0">Loading…</div>';
  let p;
  try{ p=await api(`/payroll/payslips/${id}`); }catch(e){ ed.innerHTML=`<div class="muted" style="font-size:13px">${e.message}</div>`; return; }
  const draft=p.status!=="RELEASED";
  ed.innerHTML="";
  const head=document.createElement("div"); head.className="panel"; head.style.cssText="border:1px solid var(--amber);margin-top:6px";
  head.innerHTML=`<div class="row" style="justify-content:space-between;align-items:center"><div><b>${esc(p.employeeCode)} — ${esc(p.fullName)}</b>`+
    `<div class="muted" style="font-size:12px">${fmtDay(p.periodStart)} – ${fmtDay(p.periodEnd)} · ${draft?"Draft":"Released"}</div></div>`+
    `<button class="btn ghost" id="pe-close" style="padding:6px 12px;font-size:12px">Close</button></div>`;
  const linesBox=document.createElement("div"); linesBox.style.marginTop="10px";
  const totals=document.createElement("div"); totals.style.marginTop="12px";
  const refreshTotals=()=>{ totals.innerHTML=`<div class="ev" style="align-items:center"><div style="flex:1"><b>Net pay</b></div><b>${fmtPeso(p.netPay)}</b></div>`+
    `<div class="muted" style="font-size:12px;margin-top:4px">gross ${fmtPeso(p.grossPay)} · allowances ${fmtPeso(p.totalAllowances)} · deductions ${fmtPeso(p.totalDeductions)}</div>`; };
  const reload=async()=>{ p=await api(`/payroll/payslips/${id}`); renderLines(); refreshTotals(); };
  const renderLines=()=>{
    linesBox.innerHTML="";
    ["EARNING","ALLOWANCE","DEDUCTION"].forEach(cat=>{
      const ls=p.lines.filter(l=>l.category===cat); if(!ls.length) return;
      const title=document.createElement("div"); title.className="muted"; title.style.cssText="font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin:10px 0 4px";
      title.textContent={EARNING:"Earnings",ALLOWANCE:"Allowances",DEDUCTION:"Deductions"}[cat];
      linesBox.appendChild(title);
      ls.forEach(l=>{
        const row=document.createElement("div"); row.className="ev"; row.style.alignItems="center";
        if(draft){
          const lbl=document.createElement("input"); lbl.value=l.label; lbl.style.cssText="flex:1;padding:6px 10px;font-size:13px;min-width:110px";
          const amt=document.createElement("input"); amt.type="number"; amt.min="0"; amt.step="0.01"; amt.value=l.amount; amt.style.cssText="width:100px;padding:6px 10px;font-size:13px";
          const save=document.createElement("button"); save.className="btn"; save.textContent="Save"; save.style.cssText="padding:6px 10px;font-size:12px";
          save.onclick=async()=>{ try{ await api(`/payroll/payslips/${id}/lines/${l.id}`,{method:"PATCH",body:{label:lbl.value,amount:Number(amt.value)}}); await reload(); toast("Saved","ok"); }catch(e){ toast(e.message,"err"); } };
          const del=document.createElement("button"); del.className="btn ghost"; del.textContent="×"; del.style.cssText="padding:6px 11px;font-size:14px";
          del.onclick=async()=>{ try{ await api(`/payroll/payslips/${id}/lines/${l.id}`,{method:"DELETE"}); await reload(); }catch(e){ toast(e.message,"err"); } };
          row.appendChild(lbl); row.appendChild(amt); row.appendChild(save); row.appendChild(del);
        } else { row.innerHTML=`<div style="flex:1">${esc(l.label)}</div><span>${fmtPeso(l.amount)}</span>`; }
        linesBox.appendChild(row);
      });
    });
  };
  head.appendChild(linesBox);
  if(draft){
    const add=document.createElement("div"); add.className="row"; add.style.cssText="gap:8px;margin-top:12px;flex-wrap:wrap";
    add.innerHTML=`<select id="pe-cat" style="flex:1;min-width:110px;padding:7px 10px;font-size:13px"><option value="ALLOWANCE">Allowance</option><option value="DEDUCTION">Deduction</option><option value="EARNING">Earning</option></select>`+
      `<input id="pe-label" placeholder="Label" style="flex:2;min-width:130px;padding:7px 10px;font-size:13px"/>`+
      `<input id="pe-amount" type="number" min="0" step="0.01" placeholder="₱" style="width:100px;padding:7px 10px;font-size:13px"/>`+
      `<button class="btn" id="pe-add" style="padding:7px 14px;font-size:13px">Add line</button>`;
    head.appendChild(add);
  }
  head.appendChild(totals);
  if(draft){
    const rel=document.createElement("button"); rel.className="btn primary"; rel.textContent="Release to employee"; rel.style.cssText="width:100%;margin-top:14px";
    rel.onclick=async()=>{
      const ok=await confirmDialog({title:"Release payslip?",message:`Release ${p.employeeCode}'s payslip? They'll be able to view it, and it can no longer be edited.`,confirmText:"Release",kind:"primary"});
      if(!ok) return;
      try{ await api(`/payroll/payslips/${id}/release`,{method:"POST"}); toast("Released","ok"); ed.innerHTML=""; loadPayslips(); }catch(e){ toast(e.message,"err"); }
    };
    head.appendChild(rel);
  }
  ed.appendChild(head);
  renderLines(); refreshTotals();
  document.getElementById("pe-close").onclick=()=>{ ed.innerHTML=""; };
  if(draft){
    document.getElementById("pe-add").onclick=async()=>{
      const category=document.getElementById("pe-cat").value, label=document.getElementById("pe-label").value.trim(), amount=Number(document.getElementById("pe-amount").value);
      if(!label){ toast("Enter a label.","err"); return; }
      if(!(amount>=0)){ toast("Enter a valid amount.","err"); return; }
      try{ await api(`/payroll/payslips/${id}/lines`,{method:"POST",body:{category,label,amount}}); await reload();
        document.getElementById("pe-label").value=""; document.getElementById("pe-amount").value=""; toast("Line added","ok"); }catch(e){ toast(e.message,"err"); }
    };
  }
}

// ── auto-resume session on reload ──
(async()=>{ if(store.get("tt_access")){ try{ await boot(); }catch{ show("login"); } } else show("login"); })();
