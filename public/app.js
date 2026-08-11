// Grand Villaggio Hotel — Reception Handover System
// Vanilla JS front end. No build step required.

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

// If the Worker API is deployed on the same Pages project (via Pages
// Functions or a _routes.json proxy), "/api" is correct as-is. If the
// Worker is deployed separately, replace this with its full URL, e.g.
// "https://villaggio-handover-api.yourname.workers.dev/api".
const API_BASE = "/api";

const AUTOSAVE_DELAY_MS = 700;

// ---------------------------------------------------------------------
// Tiny IndexedDB offline cache + pending-save queue
// ---------------------------------------------------------------------

const OfflineStore = (() => {
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("villaggio-handover", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("cache")) {
          db.createObjectStore("cache", { keyPath: "date" });
        }
        if (!db.objectStoreNames.contains("queue")) {
          db.createObjectStore("queue", { keyPath: "queueId", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function cacheHandover(date, data) {
    try {
      const db = await open();
      const tx = db.transaction("cache", "readwrite");
      tx.objectStore("cache").put({ date, data, cachedAt: Date.now() });
    } catch (e) { /* offline cache is best-effort */ }
  }

  async function getCached(date) {
    try {
      const db = await open();
      return await new Promise((resolve) => {
        const tx = db.transaction("cache", "readonly");
        const req = tx.objectStore("cache").get(date);
        req.onsuccess = () => resolve(req.result ? req.result.data : null);
        req.onerror = () => resolve(null);
      });
    } catch (e) { return null; }
  }

  async function queueSave(id, payload, date) {
    try {
      const db = await open();
      const tx = db.transaction("queue", "readwrite");
      tx.objectStore("queue").add({ id, payload, date, ts: Date.now() });
    } catch (e) { /* ignore */ }
  }

  async function getQueue() {
    try {
      const db = await open();
      return await new Promise((resolve) => {
        const tx = db.transaction("queue", "readonly");
        const req = tx.objectStore("queue").getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } catch (e) { return []; }
  }

  async function clearQueueItem(queueId) {
    try {
      const db = await open();
      const tx = db.transaction("queue", "readwrite");
      tx.objectStore("queue").delete(queueId);
    } catch (e) { /* ignore */ }
  }

  return { cacheHandover, getCached, queueSave, getQueue, clearQueueItem };
})();

// ---------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------

async function api(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) throw new Error("API error " + res.status);
  return res.json();
}

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

const state = {
  settings: { staff_names: [], expected_petty_cash: 2500, denominations: [] },
  handover: null,   // full handover object from API
  saveTimer: null,
  loading: false,
};

function todayISO() {
  const d = new Date();
  const tz = d.getTimezoneOffset();
  return new Date(d.getTime() - tz * 60000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// Save status indicator
// ---------------------------------------------------------------------

const saveStatusEl = document.getElementById("saveStatus");
const saveTextEl = document.getElementById("saveText");

function setSaveStatus(mode, text) {
  saveStatusEl.className = "save-status " + mode;
  saveTextEl.textContent = text;
}

// ---------------------------------------------------------------------
// Loading / creating a handover for a given date
// ---------------------------------------------------------------------

async function loadDate(dateStr) {
  state.loading = true;
  setSaveStatus("", "Loading…");
  document.getElementById("refDate").value = dateStr;

  let handover = null;
  let networkOk = true;
  try {
    handover = await api("/handover?date=" + dateStr);
    if (handover) await OfflineStore.cacheHandover(dateStr, handover);
  } catch (e) {
    networkOk = false;
    handover = await OfflineStore.getCached(dateStr);
    if (handover) setSaveStatus("offline", "Offline — showing cached copy");
  }

  if (handover) {
    // An existing saved record for this exact date — open it exactly as
    // saved. Never copy another date into it, never reset it.
    state.handover = handover;
    state.loading = false;
    renderAll();
    if (saveStatusEl.className.indexOf("offline") === -1) setSaveStatus("saved", "AutoAutoSaved ✓");
    return;
  }

  if (!networkOk) {
    // Offline with nothing cached for this date: default to a local
    // blank draft rather than guessing — it will sync as a genuinely
    // new, independent record once the connection returns.
    state.handover = blankLocalDraft(dateStr);
    state.loading = false;
    renderAll();
    setSaveStatus("offline", "Offline — new draft will sync later");
    return;
  }

  // Nothing saved yet for this date — ask how the new record should start.
  await promptNewDate(dateStr);
}

function blankLocalDraft(dateStr) {
  return {
    id: "local-" + dateStr,
    reference_date: dateStr,
    from_staff: "",
    to_staff: "",
    general_notes: "",
    credits: 0,
    give_backs: 0,
    cash_posting: 0,
    status: "draft",
    items: [],
    denominations: (state.settings.denominations || []).map((d) => ({ denomination: d, qty: 0 })),
    foreign_currency: [],
    activity: [],
  };
}

async function promptNewDate(dateStr) {
  const newDateModal = document.getElementById("newDateModal");
  const copyEl = document.getElementById("newDateCopy");
  const prevBtn = document.getElementById("createFromPrevBtn");
  const blankBtn = document.getElementById("createBlankBtn");

  let previous = null;
  try {
    previous = await api("/handover/previous?before=" + dateStr);
  } catch (e) { /* offline or lookup failed — treat as no previous available */ }

  if (previous) {
    copyEl.textContent =
      `No saved handover exists yet for ${dateStr}. You can start from the previous saved handover ` +
      `(${previous.reference_date}) — its cash count and any unresolved room items will be copied in; ` +
      `that earlier record itself will not be changed. Or start completely blank.`;
    prevBtn.style.display = "";
  } else {
    copyEl.textContent = `No saved handover exists yet for ${dateStr}, and there's no earlier handover to copy from.`;
    prevBtn.style.display = "none";
  }

  newDateModal.classList.add("open");

  const choice = await new Promise((resolve) => {
    const onPrev = () => { cleanup(); resolve("previous"); };
    const onBlank = () => { cleanup(); resolve("blank"); };
    function cleanup() {
      prevBtn.removeEventListener("click", onPrev);
      blankBtn.removeEventListener("click", onBlank);
      newDateModal.classList.remove("open");
    }
    prevBtn.addEventListener("click", onPrev);
    blankBtn.addEventListener("click", onBlank);
  });

  let handover;
  try {
    handover = await api("/handover", {
      method: "POST",
      body: JSON.stringify({ reference_date: dateStr, source: choice, from_staff: "", to_staff: "" }),
    });
    await OfflineStore.cacheHandover(dateStr, handover);
  } catch (e) {
    handover = blankLocalDraft(dateStr);
    setSaveStatus("offline", "Offline — new draft will sync later");
  }

  state.handover = handover;
  state.loading = false;
  renderAll();
  if (saveStatusEl.className.indexOf("offline") === -1) setSaveStatus("saved", "AutoSaved ✓");
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

function renderAll() {
  renderMeta();
  renderItems();
  renderDenominations();
  renderForeignCurrency();
  renderCalculations();
  renderActivity();
}

function renderMeta() {
  const h = state.handover;
  const fromSel = document.getElementById("fromStaff");
  const toSel = document.getElementById("toStaff");
  const names = state.settings.staff_names || [];

  const buildOptions = (sel, current) => {
    sel.innerHTML = '<option value="">— Select —</option>' +
      names.map((n) => `<option value="${n}"${n === current ? " selected" : ""}>${n}</option>`).join("");
  };
  buildOptions(fromSel, h.from_staff);
  buildOptions(toSel, h.to_staff);

  document.getElementById("generalNotes").value = h.general_notes || "";

  // These three are the only editable numbers in the Cash Calculation
  // panel. They MUST be populated from the saved record every time a
  // date is opened — leaving them at their default "0" would cause the
  // next autosave to silently overwrite real saved figures.
  document.getElementById("inputCredits").value = h.credits || 0;
  document.getElementById("inputGiveBacks").value = h.give_backs || 0;
  document.getElementById("inputCashPosting").value = h.cash_posting || 0;

  const isCompleted = h.status === "completed";
  document.getElementById("completeToggle").checked = isCompleted;
  const pill = document.getElementById("statusPill");
  pill.textContent = isCompleted ? "Completed" : "Draft";
  pill.className = "status-pill" + (isCompleted ? " completed" : "");
}

function renderItems() {
  const tbody = document.getElementById("itemsBody");
  const items = state.handover.items && state.handover.items.length
    ? state.handover.items
    : [];
  tbody.innerHTML = "";

  items.forEach((item, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="row-no">${idx + 1}</td>
      <td><input type="text" class="item-room" value="${escapeAttr(item.room || "")}" placeholder="Room" /></td>
      <td><input type="text" class="item-note" value="${escapeAttr(item.note || "")}" placeholder="Handover note" /></td>
      <td>
        <select class="item-status">
          <option value="Pending"${item.status === "Pending" ? " selected" : ""}>Pending</option>
          <option value="Done"${item.status === "Done" ? " selected" : ""}>Done</option>
          <option value="Follow-up"${item.status === "Follow-up" ? " selected" : ""}>Follow-up</option>
        </select>
      </td>
      <td class="no-print"><button class="delete-row-btn" title="Remove row" type="button">✕</button></td>
    `;
    tr.querySelector(".item-room").addEventListener("input", (e) => { item.room = e.target.value; scheduleSave(); });
    tr.querySelector(".item-note").addEventListener("input", (e) => { item.note = e.target.value; scheduleSave(); });
    tr.querySelector(".item-status").addEventListener("change", (e) => { item.status = e.target.value; scheduleSave(); });
    tr.querySelector(".delete-row-btn").addEventListener("click", () => {
      state.handover.items = state.handover.items.filter((it) => it !== item);
      renderItems();
      scheduleSave();
    });
    tbody.appendChild(tr);
  });

  state.handover.items = items;
}

function addItemRow() {
  if (!state.handover.items) state.handover.items = [];
  state.handover.items.push({ room: "", note: "", status: "Pending" });
  renderItems();
  scheduleSave();
  const rows = document.querySelectorAll("#itemsBody .item-room");
  if (rows.length) rows[rows.length - 1].focus();
}

function renderDenominations() {
  const tbody = document.getElementById("denomBody");
  let denoms = state.handover.denominations;
  if (!denoms || !denoms.length) {
    denoms = (state.settings.denominations || []).map((d) => ({ denomination: d, qty: 0 }));
  }
  // Sort descending by value for a spreadsheet-like reading order.
  denoms.sort((a, b) => b.denomination - a.denomination);

  tbody.innerHTML = "";
  denoms.forEach((d) => {
    const tr = document.createElement("tr");
    const label = formatDenomLabel(d.denomination);
    tr.innerHTML = `
      <td class="col-denom">${label}</td>
      <td class="col-qty"><input type="number" min="0" step="1" class="denom-qty" value="${d.qty || 0}" /></td>
      <td class="col-total"><span class="locked-cell denom-total">AED 0.00</span></td>
    `;
    tr.querySelector(".denom-qty").addEventListener("input", (e) => {
      let v = Math.max(0, Math.round(Number(e.target.value) || 0));
      d.qty = v;
      updateDenomRowTotal(tr, d);
      renderCalculations();
      scheduleSave();
    });
    updateDenomRowTotal(tr, d);
    tbody.appendChild(tr);
  });

  state.handover.denominations = denoms;
}

function updateDenomRowTotal(tr, d) {
  const total = d.denomination * (d.qty || 0);
  tr.querySelector(".denom-total").textContent = formatMoney(total);
}

function formatDenomLabel(value) {
  const n = Number(value);
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toFixed(2);
}

function renderForeignCurrency() {
  const tbody = document.getElementById("fxBody");
  const rows = state.handover.foreign_currency || [];
  tbody.innerHTML = "";

  rows.forEach((f) => {
    const tr = document.createElement("tr");
    tr.className = "fx-row";
    tr.innerHTML = `
      <td class="col-denom fx-label">
        <input type="text" class="fx-currency" value="${escapeAttr(f.label || "")}" placeholder="USD" />
        <input type="number" min="0" step="0.0001" class="fx-rate" value="${f.rate || 0}" placeholder="Rate" />
      </td>
      <td class="col-qty"><input type="number" min="0" step="1" class="fx-qty" value="${f.qty || 0}" /></td>
      <td class="col-total">
        <span class="locked-cell fx-total">AED 0.00</span>
        <button class="delete-row-btn no-print" title="Remove currency" type="button">✕</button>
      </td>
    `;
    tr.querySelector(".fx-currency").addEventListener("input", (e) => { f.label = e.target.value; scheduleSave(); });
    tr.querySelector(".fx-rate").addEventListener("input", (e) => {
      f.rate = Math.max(0, Number(e.target.value) || 0);
      updateFxRowTotal(tr, f);
      renderCalculations();
      scheduleSave();
    });
    tr.querySelector(".fx-qty").addEventListener("input", (e) => {
      f.qty = Math.max(0, Number(e.target.value) || 0);
      updateFxRowTotal(tr, f);
      renderCalculations();
      scheduleSave();
    });
    tr.querySelector(".delete-row-btn").addEventListener("click", () => {
      state.handover.foreign_currency = state.handover.foreign_currency.filter((x) => x !== f);
      renderForeignCurrency();
      renderCalculations();
      scheduleSave();
    });
    updateFxRowTotal(tr, f);
    tbody.appendChild(tr);
  });
}

function updateFxRowTotal(tr, f) {
  const total = (f.rate || 0) * (f.qty || 0);
  tr.querySelector(".fx-total").textContent = formatMoney(total);
}

function addFxRow() {
  if (!state.handover.foreign_currency) state.handover.foreign_currency = [];
  state.handover.foreign_currency.push({ label: "", rate: 0, qty: 0 });
  renderForeignCurrency();
  scheduleSave();
  const inputs = document.querySelectorAll("#fxBody .fx-currency");
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function renderActivity() {
  const list = document.getElementById("activityList");
  const entries = state.handover.activity || [];
  list.innerHTML = entries.length
    ? entries.map((a) => `
        <li>
          <span class="activity-action">${a.action}${a.staff_name ? " — " + a.staff_name : ""}</span>
          <span>${formatDateTime(a.created_at)}</span>
        </li>
      `).join("")
    : `<li><span>No activity recorded yet.</span></li>`;
}

// ---------------------------------------------------------------------
// Calculations
// ---------------------------------------------------------------------

function renderCalculations() {
  const h = state.handover;

  const denomTotal = (h.denominations || []).reduce((sum, d) => sum + d.denomination * (d.qty || 0), 0);
  const fxTotal = (h.foreign_currency || []).reduce((sum, f) => sum + (f.rate || 0) * (f.qty || 0), 0);
  const cashInHand = denomTotal + fxTotal;

  const credits = Number(document.getElementById("inputCredits").value) || 0;
  const giveBacks = Number(document.getElementById("inputGiveBacks").value) || 0;
  const cashPosting = Number(document.getElementById("inputCashPosting").value) || 0;

  const total = cashInHand + credits;
  const pettyCash = total - (giveBacks + cashPosting);
  const expectedPetty = Number(state.settings.expected_petty_cash) || 0;
  const difference = pettyCash - expectedPetty;

  document.getElementById("calcCashInHand").textContent = formatMoney(cashInHand);
  document.getElementById("calcTotal").textContent = formatMoney(total);
  document.getElementById("calcPettyCash").textContent = formatMoney(pettyCash);
  document.getElementById("calcExpectedPetty").textContent = formatMoney(expectedPetty);
  document.getElementById("calcDifference").textContent = formatMoney(Math.abs(difference));

  const banner = document.getElementById("resultBanner");
  let resultLabel;
  if (Math.abs(difference) < 0.005) {
    resultLabel = "BALANCED";
    banner.className = "result-banner balanced";
  } else if (difference > 0) {
    resultLabel = "EXCESS";
    banner.className = "result-banner excess";
  } else {
    resultLabel = "SHORT";
    banner.className = "result-banner short";
  }
  banner.textContent = `${formatMoney(Math.abs(difference))} ${resultLabel}`;

  h.credits = credits;
  h.give_backs = giveBacks;
  h.cash_posting = cashPosting;
}

// ---------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------

function scheduleSave() {
  if (state.loading) return;
  setSaveStatus("saving", "Saving…");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(doSave, AUTOSAVE_DELAY_MS);
}

async function doSave() {
  const h = state.handover;
  const payload = {
    from_staff: h.from_staff,
    to_staff: h.to_staff,
    general_notes: h.general_notes,
    credits: h.credits,
    give_backs: h.give_backs,
    cash_posting: h.cash_posting,
    status: h.status,
    items: h.items,
    denominations: h.denominations,
    foreign_currency: h.foreign_currency,
    staff_name: h.to_staff || h.from_staff || "",
  };

  await OfflineStore.cacheHandover(h.reference_date, { ...h, ...payload });

  if (h.id && h.id.startsWith("local-")) {
    setSaveStatus("offline", "Saved offline — will sync");
    await OfflineStore.queueSave(h.id, payload, h.reference_date);
    return;
  }

  try {
    const saved = await api("/handover/" + h.id, { method: "PUT", body: JSON.stringify(payload) });
    state.handover.activity = saved.activity;
    renderActivity();
    setSaveStatus("saved", "AutoSaved ✓");
  } catch (e) {
    setSaveStatus("offline", "Offline — saved locally, will sync");
    await OfflineStore.queueSave(h.id, payload, h.reference_date);
  }
}

async function processQueue() {
  const queue = await OfflineStore.getQueue();
  for (const entry of queue) {
    try {
      if (String(entry.id).startsWith("local-")) {
        // Create it for real, then drop the local placeholder.
        const created = await api("/handover", {
          method: "POST",
          body: JSON.stringify({ reference_date: entry.date, from_staff: entry.payload.from_staff, to_staff: entry.payload.to_staff }),
        });
        await api("/handover/" + created.id, { method: "PUT", body: JSON.stringify(entry.payload) });
        if (state.handover && state.handover.reference_date === entry.date) {
          state.handover.id = created.id;
        }
      } else {
        await api("/handover/" + entry.id, { method: "PUT", body: JSON.stringify(entry.payload) });
      }
      await OfflineStore.clearQueueItem(entry.queueId);
    } catch (e) {
      break; // still offline, try again next time
    }
  }
  if (state.handover) {
    try {
      const fresh = await api("/handover/" + state.handover.id);
      state.handover = fresh;
      renderAll();
      setSaveStatus("saved", "AutoSaved ✓");
    } catch (e) { /* ignore */ }
  }
}

window.addEventListener("online", processQueue);

// ---------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------

function formatMoney(n) {
  const v = Number(n) || 0;
  return "AED " + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDateTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch (e) { return iso; }
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// ---------------------------------------------------------------------
// Event wiring — meta fields
// ---------------------------------------------------------------------

document.getElementById("refDate").addEventListener("change", (e) => loadDate(e.target.value));
document.getElementById("fromStaff").addEventListener("change", (e) => { state.handover.from_staff = e.target.value; scheduleSave(); });
document.getElementById("toStaff").addEventListener("change", (e) => { state.handover.to_staff = e.target.value; scheduleSave(); });
document.getElementById("generalNotes").addEventListener("input", (e) => { state.handover.general_notes = e.target.value; scheduleSave(); });

document.getElementById("completeToggle").addEventListener("change", (e) => {
  state.handover.status = e.target.checked ? "completed" : "draft";
  renderMeta();
  scheduleSave();
});

document.getElementById("addItemBtn").addEventListener("click", addItemRow);
document.getElementById("addFxBtn").addEventListener("click", addFxRow);

["inputCredits", "inputGiveBacks", "inputCashPosting"].forEach((id) => {
  document.getElementById(id).addEventListener("input", () => { renderCalculations(); scheduleSave(); });
});

// Activity log collapse
const activityList = document.getElementById("activityList");
const activityChevron = document.getElementById("activityChevron");
document.getElementById("activityToggle").addEventListener("click", () => {
  const collapsed = activityList.style.display === "none";
  activityList.style.display = collapsed ? "" : "none";
  activityChevron.classList.toggle("open", collapsed);
});

// ---------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------

document.getElementById("printBtn").addEventListener("click", () => window.print());
// Ctrl+P is native browser behavior; the print stylesheet handles layout.

// ---------------------------------------------------------------------
// History modal + calendar
// ---------------------------------------------------------------------

const historyModal = document.getElementById("historyModal");
let calendarCursor = new Date();
let handoverDates = []; // [{reference_date, status}]

document.getElementById("historyBtn").addEventListener("click", async () => {
  try {
    handoverDates = await api("/handover-dates");
  } catch (e) {
    handoverDates = [];
  }
  calendarCursor = state.handover ? new Date(state.handover.reference_date + "T00:00:00") : new Date();
  renderCalendar();
  historyModal.classList.add("open");
});
document.getElementById("closeHistory").addEventListener("click", () => historyModal.classList.remove("open"));
historyModal.addEventListener("click", (e) => { if (e.target === historyModal) historyModal.classList.remove("open"); });

document.getElementById("calPrev").addEventListener("click", () => {
  calendarCursor.setMonth(calendarCursor.getMonth() - 1);
  renderCalendar();
});
document.getElementById("calNext").addEventListener("click", () => {
  calendarCursor.setMonth(calendarCursor.getMonth() + 1);
  renderCalendar();
});

function renderCalendar() {
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  document.getElementById("calMonthLabel").textContent =
    calendarCursor.toLocaleString("en-US", { month: "long", year: "numeric" });

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const grid = document.getElementById("calendarGrid");
  grid.innerHTML = "";

  const byDate = {};
  handoverDates.forEach((h) => { byDate[h.reference_date] = h.status; });
  const todayStr = todayISO();

  for (let i = 0; i < firstDay; i++) {
    const empty = document.createElement("div");
    empty.className = "cal-day empty";
    grid.appendChild(empty);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const cell = document.createElement("div");
    cell.className = "cal-day" + (dateStr === todayStr ? " today" : "");
    cell.innerHTML = `${day}`;
    const status = byDate[dateStr];
    if (status) {
      const dot = document.createElement("span");
      dot.className = "dot " + (status === "completed" ? "dot-completed" : "dot-draft");
      cell.appendChild(dot);
    }
    cell.addEventListener("click", () => {
      historyModal.classList.remove("open");
      loadDate(dateStr);
    });
    grid.appendChild(cell);
  }
}

// ---------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------

const settingsModal = document.getElementById("settingsModal");

document.getElementById("settingsBtn").addEventListener("click", () => {
  renderSettingsModal();
  settingsModal.classList.add("open");
});
document.getElementById("closeSettings").addEventListener("click", () => settingsModal.classList.remove("open"));
settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) settingsModal.classList.remove("open"); });

let draftSettings = null;

function renderSettingsModal() {
  draftSettings = JSON.parse(JSON.stringify(state.settings));
  document.getElementById("settingsExpectedPetty").value = draftSettings.expected_petty_cash;
  renderStaffList();
  renderDenomListSettings();
}

function renderStaffList() {
  const ul = document.getElementById("staffList");
  ul.innerHTML = draftSettings.staff_names.map((name, idx) => `
    <li>
      <span>${escapeAttr(name)}</span>
      <button type="button" data-idx="${idx}" title="Remove">✕</button>
    </li>
  `).join("");
  ul.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      draftSettings.staff_names.splice(Number(btn.dataset.idx), 1);
      renderStaffList();
    });
  });
}

document.getElementById("addStaffBtn").addEventListener("click", () => {
  const input = document.getElementById("newStaffName");
  const name = input.value.trim().toUpperCase();
  if (name && !draftSettings.staff_names.includes(name)) {
    draftSettings.staff_names.push(name);
    input.value = "";
    renderStaffList();
  }
});

function renderDenomListSettings() {
  const ul = document.getElementById("denomList");
  const sorted = [...draftSettings.denominations].sort((a, b) => b - a);
  ul.innerHTML = sorted.map((val) => `
    <li>
      <span>${formatDenomLabel(val)}</span>
      <button type="button" data-val="${val}" title="Remove">✕</button>
    </li>
  `).join("");
  ul.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      draftSettings.denominations = draftSettings.denominations.filter((v) => v !== Number(btn.dataset.val));
      renderDenomListSettings();
    });
  });
}

document.getElementById("addDenomBtn").addEventListener("click", () => {
  const input = document.getElementById("newDenomValue");
  const val = Number(input.value);
  if (val > 0 && !draftSettings.denominations.includes(val)) {
    draftSettings.denominations.push(val);
    input.value = "";
    renderDenomListSettings();
  }
});

document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
  draftSettings.expected_petty_cash = Number(document.getElementById("settingsExpectedPetty").value) || 0;
  try {
    state.settings = await api("/settings", { method: "PUT", body: JSON.stringify(draftSettings) });
  } catch (e) {
    state.settings = draftSettings; // apply locally even if offline
  }
  settingsModal.classList.remove("open");
  renderAll();
});

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

async function boot() {
  try {
    state.settings = await api("/settings");
  } catch (e) {
    state.settings = {
      staff_names: ["KAMRAN", "KISHAN", "CARYL", "KATHY", "MAGDY", "AUBREY"],
      expected_petty_cash: 2500,
      denominations: [1000, 500, 200, 100, 50, 20, 10, 5, 1, 0.5, 0.25],
    };
  }
  await loadDate(todayISO());
  processQueue();
}

boot();
