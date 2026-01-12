// FB Mass Logbook (phone-first) - IndexedDB + offline + suggestions + PR + backups
const PROGRAM = {
  "FB-A": [
    ["Back Squat / Hack Squat", ["Top Set","Back-off"]],
    ["Romanian Deadlift", ["Top Set","Back-off"]],
    ["Bench Press", ["Top Set","Back-off"]],
    ["Chest-Supported Row", ["Set 1","Set 2"]],
    ["Pull-Ups (Failure)", ["Set 1 (Fail)","Set 2 (Fail)"]],
    ["Lateral Raises (Myo-reps)", ["Activation","Mini-set 1","Mini-set 2","Mini-set 3"]],
    ["Triceps Pushdown", ["Set 1","Set 2"]],
    ["Calf Raise", ["Set 1","Set 2"]]
  ],
  "FB-B": [
    ["Bulgarian Split Squat", ["Top Set","Back-off"]],
    ["Leg Curl", ["Set 1","Set 2"]],
    ["DB Overhead Press", ["Top Set","Back-off"]],
    ["1-Arm DB Row", ["Set 1","Set 2"]],
    ["Pull-Ups (Failure)", ["Set 1 (Fail)","Set 2 (Fail)"]],
    ["Incline DB Curl", ["Set 1","Set 2"]],
    ["Overhead Triceps Extension", ["Set 1","Set 2"]],
    ["Rear Delt Fly / Face Pull", ["Set 1","Set 2"]],
    ["Abs", ["Set 1","Set 2"]]
  ],
  "FB-C": [
    ["Leg Press", ["Top Set","Back-off"]],
    ["Hip Thrust", ["Set 1","Set 2"]],
    ["Incline Bench / Dips", ["Top Set","Back-off"]],
    ["Row Variation", ["Set 1","Set 2"]],
    ["Pull-Ups (Failure)", ["Set 1 (Fail)","Set 2 (Fail)"]],
    ["Pec Deck / Push-Ups (Drop)", ["Set 1","Set 2"]],
    ["Hammer Curl", ["Set 1","Set 2"]],
    ["Lateral Raise (Light)", ["Set 1","Set 2"]]
  ]
};

// -----------------------------
// IndexedDB
// -----------------------------
const DB_NAME = "fb_mass_logbook";
const DB_VERSION = 2; // bump for new indices if needed
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      // Create or re-create stores safely
      if(!d.objectStoreNames.contains("sessions")){
        const sessions = d.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
        sessions.createIndex("by_date", "date", { unique: false });
        sessions.createIndex("by_type", "type", { unique: false });
      }
      if(!d.objectStoreNames.contains("sets")){
        const sets = d.createObjectStore("sets", { keyPath: "id", autoIncrement: true });
        sets.createIndex("by_session", "sessionId", { unique: false });
        sets.createIndex("by_exercise", "exercise", { unique: false });
        sets.createIndex("by_exercise_settype", ["exercise","setType"], { unique: false });
        sets.createIndex("by_date", "date", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(storeNames, mode="readonly"){
  return db.transaction(storeNames, mode);
}

async function addSession(session, setRows){
  return new Promise((resolve, reject) => {
    const t = tx(["sessions","sets"], "readwrite");
    const sStore = t.objectStore("sessions");
    const setStore = t.objectStore("sets");

    const sReq = sStore.add(session);
    sReq.onsuccess = () => {
      const sessionId = sReq.result;
      for(const row of setRows){
        setStore.add({ ...row, sessionId, date: session.date, type: session.type, bodyweight: session.bodyweight ?? null });
      }
    };
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

async function getAllRecords(storeName){
  return new Promise((resolve) => {
    const t = tx([storeName], "readonly");
    const store = t.objectStore(storeName);
    const req = store.openCursor();
    const rows = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if(cursor){
        rows.push(cursor.value);
        cursor.continue();
      } else resolve(rows);
    };
    req.onerror = () => resolve([]);
  });
}

async function getLastFor(exercise, setType){
  // Scan by index and choose most recent by date then id
  return new Promise((resolve) => {
    const t = tx(["sets"], "readonly");
    const store = t.objectStore("sets");
    const idx = store.index("by_exercise_settype");
    const req = idx.openCursor(IDBKeyRange.only([exercise, setType]));
    let best = null;
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if(cursor){
        const v = cursor.value;
        if(!best || v.date > best.date || (v.date === best.date && v.id > best.id)){
          best = v;
        }
        cursor.continue();
      } else resolve(best);
    };
    req.onerror = () => resolve(null);
  });
}

async function getBestPR(exercise, setType){
  // PR = best e1RM for weighted lifts, or max reps for pull-ups failure
  const rows = await getHistory(exercise, 2000);
  let best = null;
  for(const r of rows){
    if(r.setType !== setType) continue;
    const score = prScore(r, setType);
    if(score === null) continue;
    if(!best || score > best.score){
      best = { score, row: r };
    }
  }
  return best;
}

function prScore(r, setType){
  // Pull-ups: score = reps (prefer Set 1/2 fail)
  if((r.exercise || "").includes("Pull-Ups")){
    return (typeof r.reps === "number") ? r.reps : null;
  }
  // For top sets/back-offs: compute e1RM where load is numeric-ish
  const load = parseLoadToNumber(r.load, r);
  if(load === null || typeof r.reps !== "number" || r.reps <= 0) return null;
  // Epley e1RM
  return load * (1 + (r.reps / 30));
}

function parseLoadToNumber(loadStr, row){
  if(!loadStr) return null;
  const s = String(loadStr).trim().toUpperCase();
  // BW+X for pull-ups or similar; use session BW if present
  if(s.startsWith("BW")){
    const m = s.match(/BW\s*\+\s*([0-9.]+)/);
    const add = m ? parseFloat(m[1]) : 0;
    const bw = (row && typeof row.bodyweight === "number") ? row.bodyweight : null;
    if(bw === null) return null;
    return bw + add;
  }
  // "70S" dumbbells -> numeric 70 (approx)
  const m2 = s.match(/^([0-9.]+)\s*S$/);
  if(m2) return parseFloat(m2[1]);
  // plain number
  const m3 = s.match(/^([0-9.]+)/);
  if(m3) return parseFloat(m3[1]);
  return null;
}

async function getAllExercises(){
  const ex = new Set();
  for(const k of Object.keys(PROGRAM)){
    for(const [name] of PROGRAM[k]) ex.add(name);
  }
  return Array.from(ex).sort();
}

async function getHistory(exercise, limit=200){
  return new Promise((resolve) => {
    const t = tx(["sets"], "readonly");
    const store = t.objectStore("sets");
    const idx = store.index("by_exercise");
    const req = idx.openCursor(IDBKeyRange.only(exercise));
    const rows = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if(cursor){
        rows.push(cursor.value);
        cursor.continue();
      } else {
        rows.sort((a,b) => (b.date.localeCompare(a.date)) || (b.id - a.id));
        resolve(rows.slice(0, limit));
      }
    };
    req.onerror = () => resolve([]);
  });
}

async function getRecentSessions(limit=50){
  const rows = await getAllRecords("sessions");
  rows.sort((a,b) => (b.date.localeCompare(a.date)) || (b.id - a.id));
  return rows.slice(0, limit);
}

async function wipeAll(){
  return new Promise((resolve, reject) => {
    const t = tx(["sessions","sets"], "readwrite");
    t.objectStore("sessions").clear();
    t.objectStore("sets").clear();
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

// -----------------------------
// UI helpers
// -----------------------------
function $(id){ return document.getElementById(id); }

function setTodayDefault(){
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  $("sessionDate").value = `${yyyy}-${mm}-${dd}`;
}

function escapeHtml(str){
  return String(str ?? "").replace(/[&<>"']/g, s => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[s]));
}

function setView(view){
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === `view-${view}`));
  if(view === "history"){
    renderHistory($("historyExercise").value);
  }
  if(view === "stats"){
    renderSessions();
    renderSnapshot();
    renderBWChart(currentBWWindowDays);
  }
}

function toggleAll(expand=true){
  document.querySelectorAll("details.exercise").forEach(d => d.open = expand);
}

function buildSetCard(exercise, stype, last, prBest){
  const card = document.createElement("div");
  card.className = "setcard";

  const head = document.createElement("div");
  head.className = "sethead";

  const left = document.createElement("div");
  left.className = "settype";
  left.textContent = stype;

  const actions = document.createElement("div");
  actions.className = "actions";

  const useLast = document.createElement("button");
  useLast.className = "btn ghost mini";
  useLast.textContent = "Use last";
  useLast.type = "button";

  const suggest = document.createElement("button");
  suggest.className = "btn ghost mini";
  suggest.textContent = "Suggest";
  suggest.type = "button";

  const rest = document.createElement("button");
  rest.className = "btn ghost mini";
  rest.textContent = "Rest 90s";
  rest.type = "button";

  actions.appendChild(useLast);
  actions.appendChild(suggest);
  actions.appendChild(rest);

  head.appendChild(left);
  head.appendChild(actions);
  card.appendChild(head);

  const inputs = document.createElement("div");
  inputs.className = "inputs";

  const load = document.createElement("input");
  load.placeholder = "Load (225 / 70s / BW+25)";
  load.inputMode = "text";
  load.autocomplete = "off";
  load.dataset.exercise = exercise;
  load.dataset.setType = stype;
  load.dataset.field = "load";

  const reps = document.createElement("input");
  reps.type = "number";
  reps.inputMode = "numeric";
  reps.placeholder = "Reps";
  reps.min = "0";
  reps.dataset.exercise = exercise;
  reps.dataset.setType = stype;
  reps.dataset.field = "reps";

  const rir = document.createElement("input");
  rir.type = "number";
  rir.inputMode = "decimal";
  rir.step = "0.5";
  rir.placeholder = "RIR";
  rir.dataset.exercise = exercise;
  rir.dataset.setType = stype;
  rir.dataset.field = "rir";

  const notes = document.createElement("input");
  notes.placeholder = "Notes";
  notes.className = "note";
  notes.dataset.exercise = exercise;
  notes.dataset.setType = stype;
  notes.dataset.field = "notes";

  if(last){
    load.placeholder = `Load (last: ${last.load ?? ""})`;
    reps.placeholder = `Reps (last: ${last.reps ?? ""})`;
    rir.placeholder  = `RIR (last: ${last.rir ?? ""})`;
  }

  inputs.appendChild(load);
  inputs.appendChild(reps);
  inputs.appendChild(rir);
  inputs.appendChild(notes);
  card.appendChild(inputs);

  // Use last
  useLast.addEventListener("click", () => {
    if(!last) return;
    load.value = last.load ?? "";
    reps.value = (last.reps ?? "") === null ? "" : last.reps ?? "";
    rir.value  = (last.rir  ?? "") === null ? "" : last.rir  ?? "";
  });

  // Suggestion
  suggest.addEventListener("click", () => {
    const suggestion = computeSuggestion(exercise, stype, last);
    if(!suggestion) return;
    if(suggestion.load !== null && load.value.trim() === "") load.value = suggestion.load;
    if(suggestion.reps !== null && reps.value.trim() === "") reps.value = suggestion.reps;
    if(suggestion.rir !== null  && rir.value.trim()  === "") rir.value  = suggestion.rir;
  });

  // Rest timer quick start
  rest.addEventListener("click", () => startRest(90));

  return card;
}

function computeSuggestion(exercise, stype, last){
  if(!last) return null;

  // Pull-ups: if reps >= 10, suggest BW+5
  if(exercise.includes("Pull-Ups")){
    const r = (typeof last.reps === "number") ? last.reps : null;
    if(r === null) return { load: last.load ?? "", reps: null, rir: 0 };
    if(r >= 10){
      // convert BW+X
      const s = String(last.load ?? "BW").toUpperCase();
      let add = 0;
      const m = s.match(/BW\s*\+\s*([0-9.]+)/);
      if(m) add = parseFloat(m[1]);
      const next = add + 5;
      return { load: `BW+${next}`, reps: null, rir: 0 };
    }
    return { load: last.load ?? "", reps: null, rir: 0 };
  }

  // For general lifts: if last RIR <= 1 and reps at/above 8, suggest +5 (or +2.5 if small)
  const lastRir = (typeof last.rir === "number") ? last.rir : null;
  const lastReps = (typeof last.reps === "number") ? last.reps : null;
  const s = String(last.load ?? "").trim();
  const parsed = parseLoadString(s);
  if(!parsed) return { load: last.load ?? "", reps: null, rir: null };

  let bump = 5;
  // Smaller/isolation: bump 2.5
  const small = /RAISE|CURL|PUSHDOWN|EXTENSION|REAR|FACE|ABS|PEC DECK/i.test(exercise);
  if(small) bump = 2.5;

  let shouldBump = false;
  if(lastRir !== null && lastRir <= 1){
    if(lastReps !== null && lastReps >= 8) shouldBump = true;
  }

  const nextNum = (parsed.num + (shouldBump ? bump : 0));
  const nextLoad = formatLoad(nextNum, parsed.suffix);

  return { load: nextLoad, reps: null, rir: null };
}

function parseLoadString(load){
  if(!load) return null;
  const u = load.trim();
  // dumbbells "70s" suffix
  const mS = u.match(/^([0-9.]+)\s*s$/i);
  if(mS) return { num: parseFloat(mS[1]), suffix: "s" };
  const m = u.match(/^([0-9.]+)(.*)$/);
  if(!m) return null;
  const num = parseFloat(m[1]);
  if(Number.isNaN(num)) return null;
  const suffix = (m[2] ?? "").trim();
  return { num, suffix };
}

function formatLoad(num, suffix){
  const n = (Math.round(num*2)/2).toString(); // nearest 0.5
  if(suffix === "s") return `${n}s`;
  return suffix ? `${n} ${suffix}` : `${n}`;
}

async function renderWorkout(sessionType){
  const container = $("workoutContainer");
  container.innerHTML = "";

  const template = PROGRAM[sessionType];

  for(const [exercise, setTypes] of template){
    const det = document.createElement("details");
    det.className = "exercise";
    det.open = false;

    const sum = document.createElement("summary");
    const titleRow = document.createElement("div");
    titleRow.className = "ex-title";

    const name = document.createElement("div");
    name.className = "ex-name";
    name.textContent = exercise;

    const badges = document.createElement("div");
    badges.className = "badges";

    const summaryLast = document.createElement("div");
    summaryLast.className = "lastline";
    summaryLast.textContent = "Last: —";

    titleRow.appendChild(name);
    titleRow.appendChild(badges);

    sum.appendChild(titleRow);
    sum.appendChild(summaryLast);
    det.appendChild(sum);

    const body = document.createElement("div");
    body.className = "ex-body";

    // last lines & PR badge (based on first set type)
    const lastParts = [];
    for(const st of setTypes){
      const last = await getLastFor(exercise, st);
      if(last && (last.load || last.reps !== null || last.rir !== null)){
        lastParts.push(`${st}: ${last.load ?? ""} x ${last.reps ?? ""} @RIR ${last.rir ?? ""} (${last.date})`);
      }
    }
    summaryLast.textContent = lastParts.length ? `Last: ${lastParts[0]}` : "Last: —";

    // PR badge baseline (best score for primary set type)
    const primarySetType = setTypes[0];
    const best = await getBestPR(exercise, primarySetType);
    if(best){
      const b = document.createElement("span");
      b.className = "badge";
      if(exercise.includes("Pull-Ups")){
        b.textContent = `Best: ${best.row.reps ?? ""} reps`;
      } else {
        b.textContent = `Best e1RM`;
      }
      badges.appendChild(b);
    }

    // Build set cards
    for(const st of setTypes){
      const last = await getLastFor(exercise, st);
      const prBest = null; // reserved if we want per setType label
      body.appendChild(buildSetCard(exercise, st, last, prBest));
    }

    det.appendChild(body);
    container.appendChild(det);
  }
}

function collectSetRows(){
  const inputs = document.querySelectorAll("#workoutContainer input");
  const map = new Map();
  for(const el of inputs){
    const ex = el.dataset.exercise;
    const st = el.dataset.setType;
    const key = `${ex}||${st}`;
    if(!map.has(key)){
      map.set(key, { exercise: ex, setType: st, load: "", reps: null, rir: null, notes: "" });
    }
    const row = map.get(key);
    if(el.dataset.field === "load") row.load = el.value.trim();
    if(el.dataset.field === "reps") row.reps = el.value ? parseInt(el.value,10) : null;
    if(el.dataset.field === "rir") row.rir = el.value ? parseFloat(el.value) : null;
    if(el.dataset.field === "notes") row.notes = el.value.trim();
  }
  return Array.from(map.values()).filter(r => (r.load || r.reps !== null || r.rir !== null || r.notes));
}

function clearInputs(){
  document.querySelectorAll("#workoutContainer input").forEach(i => i.value = "");
}

// -----------------------------
// History + CSV
// -----------------------------
async function renderHistory(exercise){
  const rows = await getHistory(exercise, 300);
  const wrap = $("historyTable");
  if(!rows.length){
    wrap.innerHTML = `<p class="muted">No entries yet for ${escapeHtml(exercise)}.</p>`;
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr>
        <th>Date</th><th>Session</th><th>Set</th><th>Load</th><th>Reps</th><th>RIR</th><th>Notes</th>
      </tr>
    </thead>
  `;
  const tb = document.createElement("tbody");
  for(const r of rows){
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.date ?? ""}</td>
      <td>${r.type ?? ""}</td>
      <td>${escapeHtml(r.setType ?? "")}</td>
      <td>${escapeHtml(r.load ?? "")}</td>
      <td>${r.reps ?? ""}</td>
      <td>${r.rir ?? ""}</td>
      <td>${escapeHtml(r.notes ?? "")}</td>
    `;
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  wrap.innerHTML = "";
  wrap.appendChild(table);
}

function exportHistoryCSV(exercise){
  getHistory(exercise, 2000).then(rows => {
    const header = ["date","type","exercise","setType","load","reps","rir","notes"];
    const lines = [header.join(",")];
    for(const r of rows){
      const line = [
        r.date, r.type, r.exercise, r.setType,
        (r.load ?? "").replaceAll('"','""'),
        r.reps ?? "",
        r.rir ?? "",
        (r.notes ?? "").replaceAll('"','""')
      ].map(v => `"${v ?? ""}"`).join(",");
      lines.push(line);
    }
    const blob = new Blob([lines.join("\n")], {type:"text/csv"});
    downloadBlob(blob, `history_${exercise.replaceAll(" ","_")}.csv`);
  });
}

function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// -----------------------------
// Stats: sessions + snapshot + BW chart
// -----------------------------
async function renderSessions(){
  const rows = await getRecentSessions(60);
  const wrap = $("sessionsTable");
  if(!rows.length){
    wrap.innerHTML = `<p class="muted">No sessions yet.</p>`;
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>Date</th><th>Type</th><th>BW</th><th>Cals</th><th>Sleep</th></tr></thead>`;
  const tb = document.createElement("tbody");
  for(const r of rows){
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.date ?? ""}</td><td>${r.type ?? ""}</td><td>${r.bodyweight ?? ""}</td><td>${r.calories ?? ""}</td><td>${r.sleep ?? ""}</td>`;
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  wrap.innerHTML = "";
  wrap.appendChild(table);
}

async function renderSnapshot(){
  const key = [
    ["Back Squat / Hack Squat","Top Set"],
    ["Leg Press","Top Set"],
    ["Bench Press","Top Set"],
    ["Incline Bench / Dips","Top Set"],
    ["DB Overhead Press","Top Set"],
    ["Pull-Ups (Failure)","Set 1 (Fail)"]
  ];
  const wrap = $("snapshot");
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>Exercise</th><th>Set</th><th>Last</th><th>PR</th></tr></thead>`;
  const tb = document.createElement("tbody");

  for(const [ex, st] of key){
    const last = await getLastFor(ex, st);
    const best = await getBestPR(ex, st);
    const lastTxt = last ? `${last.load ?? ""} x ${last.reps ?? ""} @RIR ${last.rir ?? ""} (${last.date})` : "—";
    let prTxt = "—";
    if(best){
      if(ex.includes("Pull-Ups")) prTxt = `${best.row.reps ?? ""} reps`;
      else prTxt = `e1RM ≈ ${Math.round(best.score)}`;
    }
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(ex)}</td><td>${escapeHtml(st)}</td><td>${escapeHtml(lastTxt)}</td><td>${escapeHtml(prTxt)}</td>`;
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  wrap.innerHTML = "";
  wrap.appendChild(table);
}

function isoToDate(d){ return new Date(d + "T00:00:00"); }

async function renderBWChart(days){
  const sessions = await getRecentSessions(500);
  const withBW = sessions.filter(s => typeof s.bodyweight === "number");
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const pts = withBW
    .map(s => ({ d: isoToDate(s.date), bw: s.bodyweight }))
    .filter(p => p.d >= cutoff)
    .sort((a,b) => a.d - b.d);

  const canvas = $("bwChart");
  const ctx = canvas.getContext("2d");
  const w = canvas.width = canvas.clientWidth * devicePixelRatio;
  const h = canvas.height = 120 * devicePixelRatio;

  ctx.clearRect(0,0,w,h);

  if(pts.length < 2){
    ctx.fillStyle = "#b0b0b0";
    ctx.font = `${12*devicePixelRatio}px system-ui`;
    ctx.fillText("Log at least two bodyweight entries to see a trend.", 12*devicePixelRatio, 22*devicePixelRatio);
    $("bwSummary").textContent = "";
    return;
  }

  const minBW = Math.min(...pts.map(p => p.bw));
  const maxBW = Math.max(...pts.map(p => p.bw));
  const pad = 14 * devicePixelRatio;
  const x0 = pad, y0 = pad, x1 = w - pad, y1 = h - pad;

  const scaleX = (i) => x0 + (i/(pts.length-1))*(x1-x0);
  const scaleY = (bw) => {
    const t = (bw - minBW) / (maxBW - minBW || 1);
    return y1 - t*(y1-y0);
  };

  // axis line
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1*devicePixelRatio;
  ctx.beginPath();
  ctx.moveTo(x0,y1);
  ctx.lineTo(x1,y1);
  ctx.stroke();

  // line
  ctx.strokeStyle = "rgba(230,230,230,0.9)";
  ctx.lineWidth = 2*devicePixelRatio;
  ctx.beginPath();
  pts.forEach((p,i)=>{
    const x = scaleX(i);
    const y = scaleY(p.bw);
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();

  // points
  ctx.fillStyle = "rgba(230,230,230,0.95)";
  pts.forEach((p,i)=>{
    const x = scaleX(i);
    const y = scaleY(p.bw);
    ctx.beginPath();
    ctx.arc(x,y, 2.5*devicePixelRatio, 0, Math.PI*2);
    ctx.fill();
  });

  const first = pts[0].bw;
  const last = pts[pts.length-1].bw;
  const diff = Math.round((last-first)*10)/10;
  const perWeek = Math.round((diff / (days/7))*10)/10;
  $("bwSummary").textContent = `Change: ${diff >= 0 ? "+" : ""}${diff} lb over ${days} days (≈ ${perWeek >= 0 ? "+" : ""}${perWeek} lb/week).`;
}

let currentBWWindowDays = 7;

// -----------------------------
// Backup / Import
// -----------------------------
async function exportBackup(){
  const sessions = await getAllRecords("sessions");
  const sets = await getAllRecords("sets");
  const payload = {
    version: 2,
    exportedAt: new Date().toISOString(),
    sessions,
    sets
  };
  const blob = new Blob([JSON.stringify(payload)], {type:"application/json"});
  downloadBlob(blob, `fb_mass_backup_${new Date().toISOString().slice(0,10)}.json`);
}

async function importBackupFile(file){
  const text = await file.text();
  const payload = JSON.parse(text);

  if(!payload || !Array.isArray(payload.sessions) || !Array.isArray(payload.sets)){
    throw new Error("Invalid backup file.");
  }

  // Strategy: merge by inserting as new records (new IDs)
  // Wipe first? We'll ask user via confirm.
  const replace = confirm("Replace existing data with this backup? OK = replace, Cancel = merge.");
  if(replace){
    await wipeAll();
  }

  // Re-insert sessions and map old->new ids
  const t = tx(["sessions","sets"], "readwrite");
  const sStore = t.objectStore("sessions");
  const setStore = t.objectStore("sets");

  const idMap = new Map();

  await new Promise((resolve, reject) => {
    let pending = payload.sessions.length;
    if(pending === 0) resolve();
    payload.sessions.forEach(s => {
      const clean = { ...s };
      delete clean.id;
      const req = sStore.add(clean);
      req.onsuccess = () => {
        idMap.set(s.id, req.result);
        pending--;
        if(pending === 0) resolve();
      };
      req.onerror = () => reject(req.error);
    });
  });

  await new Promise((resolve, reject) => {
    let pending = payload.sets.length;
    if(pending === 0) resolve();
    payload.sets.forEach(st => {
      const clean = { ...st };
      delete clean.id;
      clean.sessionId = idMap.get(st.sessionId) ?? clean.sessionId;
      const req = setStore.add(clean);
      req.onsuccess = () => {
        pending--;
        if(pending === 0) resolve();
      };
      req.onerror = () => reject(req.error);
    });
  });

  await new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// -----------------------------
// Plate calculator
// -----------------------------
function plateCalc(target, bar){
  const plates = [45,35,25,10,5,2.5];
  const total = target - bar;
  if(total < 0) return { ok:false, msg:"Target is below bar weight." };
  const perSide = total/2;
  let rem = Math.round(perSide*2)/2; // nearest 0.5
  const out = [];
  for(const p of plates){
    while(rem >= p - 1e-9){
      out.push(p);
      rem = Math.round((rem - p)*2)/2;
    }
  }
  if(rem > 0.01) return { ok:false, msg:"Cannot match exactly with standard plates." };
  return { ok:true, perSide, out };
}

// -----------------------------
// Rest timer
// -----------------------------
let rtInterval = null;
let rtEnd = null;

function startRest(seconds){
  rtEnd = Date.now() + seconds*1000;
  tickRest();
  if(rtInterval) clearInterval(rtInterval);
  rtInterval = setInterval(tickRest, 250);
}

function stopRest(){
  rtEnd = null;
  if(rtInterval) clearInterval(rtInterval);
  rtInterval = null;
  $("rtTime").textContent = "00:00";
}

function tickRest(){
  if(!rtEnd) return;
  const ms = rtEnd - Date.now();
  const sec = Math.max(0, Math.ceil(ms/1000));
  const m = String(Math.floor(sec/60)).padStart(2,"0");
  const s = String(sec%60).padStart(2,"0");
  $("rtTime").textContent = `${m}:${s}`;
  if(sec === 0){
    stopRest();
    try{ navigator.vibrate?.(200); } catch(e){}
  }
}

// -----------------------------
// Init
// -----------------------------
async function init(){
  db = await openDB();

  // Tabs
  document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => setView(btn.dataset.view)));

  // Defaults
  setTodayDefault();

  // History dropdown
  const exercises = await getAllExercises();
  const sel = $("historyExercise");
  exercises.forEach(ex => {
    const opt = document.createElement("option");
    opt.value = ex;
    opt.textContent = ex;
    sel.appendChild(opt);
  });
  sel.addEventListener("change", () => renderHistory(sel.value));

  // Workout template load on change
  $("sessionType").addEventListener("change", () => renderWorkout($("sessionType").value));

  // Save session
  $("saveSession").addEventListener("click", async () => {
    const type = $("sessionType").value;
    const date = $("sessionDate").value;
    if(!date){ $("saveStatus").textContent = "Select a date."; return; }

    const bodyweight = $("bodyweight").value ? parseFloat($("bodyweight").value) : null;
    const calories = $("calories").value ? parseInt($("calories").value,10) : null;
    const sleep = $("sleep").value ? parseFloat($("sleep").value) : null;

    const setRows = collectSetRows();
    if(setRows.length === 0){ $("saveStatus").textContent = "Enter at least one set."; return; }

    const session = { date, type, bodyweight, calories, sleep, createdAt: new Date().toISOString() };
    try{
      await addSession(session, setRows);
      $("saveStatus").textContent = "Saved.";
      // Refresh views
      await renderWorkout(type);
      await renderSessions();
      await renderSnapshot();
      await renderBWChart(currentBWWindowDays);
      await renderHistory($("historyExercise").value);
    } catch(e){
      console.error(e);
      $("saveStatus").textContent = "Save failed.";
    }
  });

  $("clearInputs").addEventListener("click", clearInputs);

  $("expandAll").addEventListener("click", () => toggleAll(true));
  $("collapseAll").addEventListener("click", () => toggleAll(false));

  // BW window buttons
  $("bw7").addEventListener("click", async () => {
    currentBWWindowDays = 7;
    $("bw7").classList.add("active-mini");
    $("bw30").classList.remove("active-mini");
    await renderBWChart(7);
  });
  $("bw30").addEventListener("click", async () => {
    currentBWWindowDays = 30;
    $("bw30").classList.add("active-mini");
    $("bw7").classList.remove("active-mini");
    await renderBWChart(30);
  });

  // Export CSV
  $("exportCsv").addEventListener("click", () => exportHistoryCSV($("historyExercise").value));

  // Backup
  $("backupJson").addEventListener("click", exportBackup);
  $("importJson").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if(!file) return;
    try{
      await importBackupFile(file);
      $("backupStatus").textContent = "Import complete.";
      await renderWorkout($("sessionType").value);
      await renderSessions();
      await renderSnapshot();
      await renderBWChart(currentBWWindowDays);
      await renderHistory($("historyExercise").value);
    } catch(err){
      console.error(err);
      $("backupStatus").textContent = "Import failed.";
    } finally {
      e.target.value = "";
    }
  });

  // Wipe
  $("wipeData").addEventListener("click", async () => {
    if(!confirm("Wipe ALL data on this device?")) return;
    try{
      await wipeAll();
      $("wipeStatus").textContent = "All data wiped.";
      await renderWorkout($("sessionType").value);
      await renderSessions();
      await renderSnapshot();
      await renderBWChart(currentBWWindowDays);
      await renderHistory($("historyExercise").value);
    } catch(e){
      $("wipeStatus").textContent = "Wipe failed.";
    }
  });

  // Plate calc
  $("pcCalc").addEventListener("click", () => {
    const target = parseFloat($("pcTarget").value);
    const bar = parseFloat($("pcBar").value);
    if(Number.isNaN(target) || Number.isNaN(bar)){
      $("pcOut").innerHTML = `<p class="muted">Enter numbers.</p>`;
      return;
    }
    const res = plateCalc(target, bar);
    if(!res.ok){
      $("pcOut").innerHTML = `<p class="muted">${escapeHtml(res.msg)}</p>`;
      return;
    }
    $("pcOut").innerHTML = `<p><strong>Per side:</strong> ${res.out.join(" + ")} (total per side ${Math.round(res.perSide*10)/10})</p>`;
  });

  // Rest timer buttons
  document.querySelectorAll(".rt-btn[data-sec]").forEach(b => {
    b.addEventListener("click", () => startRest(parseInt(b.dataset.sec,10)));
  });
  $("rtStop").addEventListener("click", stopRest);

  // First render
  await renderWorkout($("sessionType").value);
  await renderSessions();
  await renderSnapshot();
  await renderBWChart(currentBWWindowDays);
  await renderHistory($("historyExercise").value);

  // Service worker
  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("./sw.js").catch(console.error);
  }
}

init();
