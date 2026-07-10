const { useState, useEffect, useCallback } = React;

// Inject global mobile styles
if (typeof document !== "undefined") {
  const style = document.createElement("style");
  style.textContent = `
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    body { margin: 0; overscroll-behavior: none; }
    input, button { font-family: inherit; }
    button { touch-action: manipulation; }
    ::-webkit-scrollbar { width: 4px; height: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 99px; }
  `;
  document.head.appendChild(style);
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return isMobile;
}

// ── SUPABASE CONFIG ───────────────────────────────────────────
const SUPABASE_URL = "https://gqdywhlhpqogtlzhcqih.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdxZHl3aGxocHFvZ3RsemhjcWloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MjY5NjksImV4cCI6MjA5ODUwMjk2OX0.HHFWg9errPSVdVru1sLZ-Z-xUsyr9q_5YUjPKsGOu9g";
const HEADERS = {
  "Content-Type": "application/json",
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
};

// ── AUTH HELPERS ─────────────────────────────────────────────
const supabaseAuth = {
  signInWithGoogle() {
    const redirectTo = window.location.origin + window.location.pathname;
    window.location.href = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;
  },
  async getSession() {
    // Check URL for access_token (after OAuth redirect)
    const hash = window.location.hash;
    if (hash && hash.includes("access_token")) {
      const params = new URLSearchParams(hash.substring(1));
      const token = params.get("access_token");
      const refresh = params.get("refresh_token");
      if (token) {
        localStorage.setItem("sb_access_token", token);
        if (refresh) localStorage.setItem("sb_refresh_token", refresh);
        window.history.replaceState({}, "", window.location.pathname);
        return token;
      }
    }
    return localStorage.getItem("sb_access_token");
  },
  async getUser(token) {
    if (!token) return null;
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token}` },
      });
      if (!res.ok) return null;
      return res.json();
    } catch(e) { return null; }
  },
  // Access tokens expire after ~1hr. Use the long-lived refresh token to get a new one silently.
  async refreshSession() {
    const refresh = localStorage.getItem("sb_refresh_token");
    if (!refresh) return null;
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY },
        body: JSON.stringify({ refresh_token: refresh }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.access_token) return null;
      localStorage.setItem("sb_access_token", data.access_token);
      if (data.refresh_token) localStorage.setItem("sb_refresh_token", data.refresh_token);
      return data.access_token;
    } catch (e) { return null; }
  },
  // Tries the saved token; if it's expired, silently refreshes and retries once.
  async getValidUser() {
    const token = await supabaseAuth.getSession();
    if (!token) return null;
    let u = await supabaseAuth.getUser(token);
    if (u) return u;
    const newToken = await supabaseAuth.refreshSession();
    if (!newToken) return null;
    u = await supabaseAuth.getUser(newToken);
    return u;
  },
  signOut() {
    localStorage.removeItem("sb_access_token");
    localStorage.removeItem("sb_refresh_token");
    window.location.reload();
  },
};

async function getUserRole(email) {
  const rows = await sbFetch(`/user_roles?email=eq.${encodeURIComponent(email)}&select=*`);
  return rows && rows.length > 0 ? rows[0] : null;
}

async function upsertUserRole(email, name, role = "pending") {
  // Try insert first, if exists just ignore
  try {
    await sbFetch("/user_roles", "POST", { email, name, role }, { "Prefer": "return=minimal" });
  } catch(e) {
    // Already exists, that's fine
  }
}

async function getAllUsers() {
  return await sbFetch("/user_roles?select=*&order=created_at.desc") || [];
}

async function updateUserRole(email, role) {
  await sbFetch(`/user_roles?email=eq.${encodeURIComponent(email)}`, "PATCH", { role, approved_at: new Date().toISOString() }, { "Prefer": "return=minimal" });
}

async function deleteUser(email) {
  await sbFetch(`/user_roles?email=eq.${encodeURIComponent(email)}`, "DELETE", null, { "Prefer": "return=minimal" });
}

async function sbFetch(path, method = "GET", body = null, extraHeaders = {}, _isRetry = false) {
  // Use the logged-in user's own token when available, so Supabase RLS can
  // tell a real authenticated user apart from an anonymous request. Falls
  // back to the anon key only for the brief pre-login moment.
  const userToken = (typeof localStorage !== "undefined") ? localStorage.getItem("sb_access_token") : null;
  const authHeaders = userToken
    ? { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${userToken}` }
    : HEADERS;
  const options = {
    method,
    headers: { ...authHeaders, "Content-Type": "application/json", ...extraHeaders },
  };
  if (body) options.body = JSON.stringify(body);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, options);
    if (res.status === 401 && userToken && !_isRetry) {
      // Token likely expired between refresh cycles — refresh once and retry
      const newToken = await supabaseAuth.refreshSession();
      if (newToken) return sbFetch(path, method, body, extraHeaders, true);
    }
    if (!res.ok) {
      const e = await res.text();
      console.error("Supabase error:", res.status, e);
      throw new Error(`HTTP ${res.status}: ${e}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    console.error("Fetch failed:", err);
    throw err;
  }
}

async function loadAllRooms() {
  const [roomRows, tenantRows] = await Promise.all([
    sbFetch("/rooms?select=*"),
    sbFetch("/tenants?select=*"),
  ]);
  const rooms = {};
  roomRows.forEach(r => {
    const id = r.id;
    rooms[id] = { floor: r.floor, number: r.number, beds: r.beds, label: r.label || "", tenants: makeBeds(r.beds) };
  });
  tenantRows.forEach(t => {
    if (!rooms[t.room_id]) return;
    const bi = t.bed_index;
    if (bi >= 0 && bi < rooms[t.room_id].tenants.length) {
      rooms[t.room_id].tenants[bi] = {
        name: t.name || "", phone: t.phone || "",
        admissionDate: t.admission_date || "",
        checkoutDate: t.checkout_date || "",
        billingType: t.billing_type || "monthly",
        aadharId: t.aadhar_id || "",
        fatherName: t.father_name || "",
        fatherPhone: t.father_phone || "",
        guardianName: t.guardian_name || "",
        guardianPhone: t.guardian_phone || "",
        address: t.address || "",
        city: t.city || "",
        occupation: t.occupation || "",
        occupationPlace: t.occupation_place || "",
        occupationId: t.occupation_id || "",
        reasonToStay: t.reason_to_stay || "",
        rentAmount: t.rent_amount || "",
        rentPaidOn: t.rent_paid_on || "",
        rentPaymentMode: t.rent_payment_mode || "",
        rentReceiptNo: t.rent_receipt_no || "",
        rentSnoozedAt: t.rent_snoozed_at || "",
        rentSnoozedUntil: t.rent_snoozed_until || "",
        rentSnoozedCycleStart: t.rent_snoozed_cycle_start || "",
        rentNote: t.rent_note || "",
        depositAmount: t.deposit_amount || "",
        depositPaidOn: t.deposit_paid_on || "",
        depositPaymentMode: t.deposit_payment_mode || "",
        depositReceiptNo: t.deposit_receipt_no || "",
        depositReturnedOn: t.deposit_returned_on || "",
        depositReturnAmount: t.deposit_return_amount || "",
        depositNote: t.deposit_note || "",
        dbId: t.id,
      };
    }
  });
  return rooms;
}

async function createRoom(floor, number, beds, label = "") {
  const id = `${floor}-${number}`;
  await sbFetch(
    `/rooms`,
    "POST",
    { id, floor, number, beds, label },
    { "Prefer": "return=minimal" }
  );
  return id;
}

async function logPayment(entry) {
  await sbFetch("/payments", "POST", entry, { "Prefer": "return=minimal" });
}

async function loadPayments() {
  const rows = await sbFetch("/payments?select=*&order=paid_at.desc&limit=20000");
  return rows || [];
}

// ── SECURITY DEPOSITS — completely separate permanent table from `payments`,
// so it never touches rent data/reports and survives a tenant being cleared
// out of their room (archived) later.
async function createDepositRecord(entry) {
  const rows = await sbFetch("/security_deposits", "POST", entry, { "Prefer": "return=representation" });
  return rows && rows[0];
}

async function updateDepositRecord(id, fields) {
  await sbFetch(`/security_deposits?id=eq.${id}`, "PATCH", fields, { "Prefer": "return=minimal" });
}

async function loadDeposits() {
  const rows = await sbFetch("/security_deposits?select=*&order=collected_at.desc&limit=20000");
  return rows || [];
}

async function saveRoom(room, tenants) {
  const id = `${room.floor}-${room.number}`;
  // Update room beds and label
  await sbFetch(
    `/rooms?id=eq.${id}`,
    "PATCH",
    { beds: room.beds, label: room.label },
    { "Prefer": "return=minimal" }
  );
  // Archive existing tenants before deleting
  try {
    const existing = await sbFetch(`/tenants?room_id=eq.${id}&select=*`);
    if (existing && existing.length > 0) {
      const changed = existing.filter(ex => {
        const newT = tenants.find((t, bi) => bi === ex.bed_index);
        return !newT || !newT.name || newT.name.trim() === "" || newT.name !== ex.name;
      });
      if (changed.length > 0) {
        await archiveTenants(changed.map(t => ({
          ...t, aadharId: t.aadhar_id, admissionDate: t.admission_date,
          checkoutDate: t.checkout_date, billingType: t.billing_type,
          // NOTE: these aliases are required — `t` here is a raw Supabase row
          // (snake_case), and archiveTenants reads camelCase. Without an
          // alias for a field, it silently archives as blank.
          fatherName: t.father_name, fatherPhone: t.father_phone,
          guardianName: t.guardian_name, guardianPhone: t.guardian_phone,
          occupationPlace: t.occupation_place, occupationId: t.occupation_id,
          reasonToStay: t.reason_to_stay, rentAmount: t.rent_amount,
          depositAmount: t.deposit_amount, depositPaidOn: t.deposit_paid_on,
          depositPaymentMode: t.deposit_payment_mode, depositReceiptNo: t.deposit_receipt_no,
          depositReturnedOn: t.deposit_returned_on, depositReturnAmount: t.deposit_return_amount,
        })), id, room.floor, room.number);
      }
    }
  } catch(e) { console.warn("Archive failed (table may not exist yet):", e); }
  // Delete all existing tenants for this room first
  await sbFetch(
    `/tenants?room_id=eq.${id}`,
    "DELETE",
    null,
    { "Prefer": "return=minimal" }
  );
  // Insert updated tenants (only beds with a name filled)
  const toInsert = tenants
    .map((t, bi) => ({
      room_id: id,
      bed_index: bi,
      name: t.name || "",
      phone: t.phone || "",
      aadhar_id: t.aadharId || "",
      father_name: t.fatherName || "",
      father_phone: t.fatherPhone || "",
      guardian_name: t.guardianName || "",
      guardian_phone: t.guardianPhone || "",
      address: t.address || "",
      city: t.city || "",
      occupation: t.occupation || "",
      occupation_place: t.occupationPlace || "",
      occupation_id: t.occupationId || "",
      reason_to_stay: t.reasonToStay || "",
      rent_amount: t.rentAmount || "",
      admission_date: t.admissionDate || "",
      checkout_date: t.checkoutDate || "",
      billing_type: t.billingType || "monthly",
      rent_paid_on: t.rentPaidOn || null,
      rent_payment_mode: t.rentPaymentMode || null,
      rent_receipt_no: t.rentReceiptNo || null,
      rent_snoozed_at: t.rentSnoozedAt || null,
      rent_snoozed_until: t.rentSnoozedUntil || null,
      rent_snoozed_cycle_start: t.rentSnoozedCycleStart || null,
      rent_note: t.rentNote || null,
      deposit_amount: t.depositAmount || null,
      deposit_paid_on: t.depositPaidOn || null,
      deposit_payment_mode: t.depositPaymentMode || null,
      deposit_receipt_no: t.depositReceiptNo || null,
      deposit_returned_on: t.depositReturnedOn || null,
      deposit_return_amount: t.depositReturnAmount || null,
      deposit_note: t.depositNote || null,
    }))
    .filter(t => t.name.trim() !== "");
  if (toInsert.length > 0) {
    await sbFetch(
      "/tenants",
      "POST",
      toInsert,
      { "Prefer": "return=minimal" }
    );
  }
}

async function archiveTenants(oldTenants, roomId, floor, roomNumber) {
  const toArchive = oldTenants
    .filter(t => t.name && t.name.trim() !== "")
    .map(t => ({
      room_id: roomId,
      floor,
      room_number: roomNumber,
      bed_index: t.bed_index || 0,
      name: t.name || "",
      phone: t.phone || "",
      aadhar_id: t.aadharId || "",
      father_name: t.fatherName || "",
      father_phone: t.fatherPhone || "",
      guardian_name: t.guardianName || "",
      guardian_phone: t.guardianPhone || "",
      address: t.address || "",
      city: t.city || "",
      occupation: t.occupation || "",
      occupation_place: t.occupationPlace || "",
      occupation_id: t.occupationId || "",
      reason_to_stay: t.reasonToStay || "",
      rent_amount: t.rentAmount || "",
      admission_date: t.admissionDate || "",
      checkout_date: t.checkoutDate || istDateStr(),
      billing_type: t.billingType || "monthly",
      deposit_amount: t.depositAmount || null,
      deposit_paid_on: t.depositPaidOn || null,
      deposit_payment_mode: t.depositPaymentMode || null,
      deposit_receipt_no: t.depositReceiptNo || null,
      deposit_returned_on: t.depositReturnedOn || null,
      deposit_return_amount: t.depositReturnAmount || null,
      deposit_note: t.depositNote || null,
      archived_at: new Date().toISOString(),
    }));
  if (toArchive.length === 0) return;
  await sbFetch("/tenant_history", "POST", toArchive, { "Prefer": "return=minimal" });
}

async function loadHistory() {
  const rows = await sbFetch("/tenant_history?select=*&order=archived_at.desc&limit=10000");
  return rows || [];
}

const FLOORS = [0, 1, 2, 3, 4];
const ROOM_COUNTS = { 0: 3, 1: 40, 2: 40, 3: 40, 4: 4 };
const FLOOR_LABELS = { 0: "Ground", 1: "Floor 1", 2: "Floor 2", 3: "Floor 3", 4: "Floor 4" };

function makeBeds(count, existing = []) {
  return Array.from({ length: count }, (_, i) => existing[i] || { name: "", admissionDate: "", phone: "", billingType: "monthly", checkoutDate: "", aadharId: "", fatherName: "", fatherPhone: "", guardianName: "", guardianPhone: "", address: "", city: "", occupation: "", occupationPlace: "", occupationId: "", reasonToStay: "", rentAmount: "", rentPaidOn: "", rentSnoozedAt: "", rentSnoozedUntil: "", rentSnoozedCycleStart: "", rentPaymentMode: "", rentReceiptNo: "", rentNote: "", depositAmount: "", depositPaidOn: "", depositPaymentMode: "", depositReceiptNo: "", depositReturnedOn: "", depositReturnAmount: "", depositNote: "" });
}

function initRooms() {
  const rooms = {};
  FLOORS.forEach(floor => {
    const count = ROOM_COUNTS[floor] || 0;
    for (let r = 1; r <= count; r++) {
      const id = `${floor}-${r}`;
      rooms[id] = { floor, number: r, beds: 2, label: "", tenants: makeBeds(2) };
    }
  });
  return rooms;
}

const STATUS_COLORS = {
  empty:   { bg: "#e8f5e9", border: "#81c784", text: "#2e7d32", label: "Empty" },
  partial: { bg: "#fff8e1", border: "#ffd54f", text: "#f57f17", label: "Partial" },
  full:    { bg: "#ffebee", border: "#e57373", text: "#c62828", label: "Full" },
};

function getRoomStatus(room) {
  const occ = room.tenants.filter(t => t.name.trim()).length;
  if (occ === 0) return "empty";
  if (occ >= room.beds) return "full";
  return "partial";
}

function getOccupied(room) {
  return room.tenants.filter(t => t.name.trim()).length;
}

// Guaranteed-unique receipt number — built from the exact payment instant,
// so no database round-trip or counter is needed to avoid collisions.
// ── INDIA STANDARD TIME HELPERS ──────────────────────────────────
// Everything in the app — "today", due dates, receipt numbers, displayed
// dates — should follow India time (UTC+5:30, no DST), regardless of what
// timezone the device or server happens to be set to. These use the Intl
// API against the real 'Asia/Kolkata' zone, so they're accurate even if a
// staff member's phone is misconfigured.
function istParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p = {};
  fmt.formatToParts(d).forEach(part => { if (part.type !== "literal") p[part.type] = part.value; });
  return p;
}
function istDateStr(d = new Date()) {
  const p = istParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}
// A Date object whose getFullYear/getMonth/getDate/getHours etc. all read
// back as India-time wall-clock values — safe to use anywhere the app reads
// "today" for calendar/day-of-month logic.
function istNow() {
  const p = istParts(new Date());
  return new Date(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}
// Wrapper around toLocaleDateString that always renders in India time.
function fmtDateIST(d, opts = {}) {
  return d.toLocaleDateString("en-IN", { ...opts, timeZone: "Asia/Kolkata" });
}

function generateReceiptNo(isoString, prefix = "RC") {
  const p = istParts(new Date(isoString));
  return `${prefix}-${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}-${String(new Date(isoString).getMilliseconds()).padStart(3,"0")}`;
}

function fmt(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00+05:30");
  return fmtDateIST(d, { day: "2-digit", month: "short", year: "numeric" });
}

// ── PHONE VALIDATION ──────────────────────────────────────────
// Normalizes an Indian mobile number to its bare 10 digits, stripping
// spaces/dashes/parens and a leading "+91"/"91"/"0" country/trunk prefix.
// Returns null if what's left isn't a plausible 10-digit mobile number
// (this also catches typo'd 9-digit / 11-digit entries).
function normalizePhone10(raw) {
  let d = (raw || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length !== 10) return null;
  if (!/^[6-9]/.test(d)) return null; // Indian mobiles start 6-9
  return d;
}
function isValidPhone10(raw) {
  return normalizePhone10(raw) !== null;
}

function ordinal(n) {
  const s = ["th","st","nd","rd"], v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}

// Get all tenants as flat list
function getAllTenants(rooms) {
  const list = [];
  Object.values(rooms).forEach(room => {
    room.tenants.forEach((t, bi) => {
      if (t.name.trim()) list.push({ ...t, floor: room.floor, roomNumber: room.number, bed: bi + 1, roomLabel: room.label, fatherName: t.fatherName||'', fatherPhone: t.fatherPhone||'', guardianName: t.guardianName||'', guardianPhone: t.guardianPhone||'', address: t.address||'', city: t.city||'', occupation: t.occupation||'', occupationPlace: t.occupationPlace||'', occupationId: t.occupationId||'', reasonToStay: t.reasonToStay||'', rentAmount: t.rentAmount||'', depositAmount: t.depositAmount||'' });
    });
  });
  return list;
}

// Rent due logic
function getRentStatus(admissionDate, today, rentPaidOn = null) {
  if (!admissionDate) return null;
  const ad = new Date(admissionDate + "T00:00:00");
  const dueDay = ad.getDate(); // the tenant's actual billing anchor day, e.g. 31

  // Single source of truth for classification: "firstMissedBoundary" is the
  // due date they actually owe against right now — either their next
  // upcoming due date (if paid up), or the exact date they stopped being
  // paid up (if not). Everything (due_today/due_soon/ok/overdue) is derived
  // from comparing today to this ONE date, using proper cycle-boundary math
  // (getCycleStart) instead of raw day-of-month subtraction.
  //
  // The old day-of-month approach broke badly for day-29/30/31 anchors: e.g.
  // a day-31 tenant could NEVER show overdue, even after years of not
  // paying, because every month transition happened to land on a day where
  // the subtraction came out positive again. Verified against a 5-year,
  // all-anchor-days simulation before landing this fix.
  let firstMissedBoundary;
  if (rentPaidOn) {
    const coveredCycleStart = getCycleStart(dueDay, new Date(rentPaidOn));
    let y = coveredCycleStart.getFullYear(), m = coveredCycleStart.getMonth() + 1;
    if (m > 11) { m = 0; y++; }
    const daysInM = new Date(y, m + 1, 0).getDate();
    firstMissedBoundary = new Date(y, m, Math.min(dueDay, daysInM));
  } else {
    firstMissedBoundary = getCycleStart(dueDay, ad); // = admission date itself
  }

  const daysDiff = Math.round((today - firstMissedBoundary) / (24*60*60*1000));
  if (daysDiff < 0) {
    const daysUntil = -daysDiff;
    if (daysUntil <= 3) return { type: "due_soon", label: `Due in ${daysUntil} day${daysUntil>1?"s":""}`, color: "#f59e0b", bg: "#fffbeb", icon: "🟡", daysUntil, dueDay };
    return { type: "ok", label: `Due on ${ordinal(dueDay)}`, color: "#22c55e", bg: "#f0fdf4", icon: "🟢", daysUntil, dueDay };
  }
  if (daysDiff === 0) return { type: "due_today", label: "Due Today", color: "#ef4444", bg: "#fef2f2", icon: "🔴", daysUntil: 0, dueDay };
  const daysOverdue = daysDiff;
  return { type: "overdue", label: `${daysOverdue} day${daysOverdue !== 1 ? "s" : ""} overdue`, color: "#b91c1c", bg: "#fef2f2", icon: "🔴", daysOverdue, dueDay };
}

// Start of the current billing cycle (the most recent occurrence of dueDay on/before today)
function getCycleStart(dueDay, today) {
  const todayDay = today.getDate();
  let year = today.getFullYear();
  let month = today.getMonth();
  // Compare against THIS month's clamped due day (e.g. 28 in Feb for a day-29
  // anchor), not the raw anchor day. Comparing against the raw day caused a
  // real bug: paying on Feb 28 (the correct, clamped due date for a day-29
  // tenant) was misread as "before this month's due day," incorrectly
  // rolling the cycle back to January and breaking payment validity, snooze
  // scoping, and overdue calculations for any day-29/30/31 anchor.
  const daysInThisMonth = new Date(year, month + 1, 0).getDate();
  const dueDayThisMonth = Math.min(dueDay, daysInThisMonth);
  if (todayDay < dueDayThisMonth) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return new Date(year, month, Math.min(dueDay, daysInMonth));
  }
  return new Date(year, month, dueDayThisMonth);
}

// Is a stored timestamp (paid-on / snoozed-at) still valid for the current billing cycle?
// Custom-duration snooze check — simple date comparison, independent of
// cycle boundaries, since a snooze can now last any chosen number of days
// (1 to 90) rather than always exactly "until next cycle."
// Custom-duration snooze check — but scoped to the SPECIFIC cycle it was
// applied to. If a brand new cycle has started since snoozing (e.g. you
// snooze for 90 days but next month's due date arrives in 30), the snooze
// no longer applies — that's a new, separate obligation, not the one you
// snoozed. The outer "until" date is just a safety cap so a snooze can never
// silently last forever even within the same cycle.
function isSnoozedNow(rentSnoozedUntil, rentSnoozedCycleStart, currentCycleStart, today) {
  if (!rentSnoozedUntil) return false;
  const until = new Date(rentSnoozedUntil);
  if (isNaN(until.getTime()) || until < today) return false;
  if (!rentSnoozedCycleStart || !currentCycleStart) return true;
  return new Date(rentSnoozedCycleStart).toDateString() === currentCycleStart.toDateString();
}

function isActiveForCycle(isoDateStr, dueDay, today) {
  if (!isoDateStr) return false;
  const cycleStart = getCycleStart(dueDay, today);
  const d = new Date(isoDateStr);
  if (isNaN(d.getTime())) return false;
  return d >= cycleStart;
}

// ── 15-DAY CYCLE — repeats every 15 days from the tenant's admission date,
// not tied to calendar months at all (unlike Monthly, which recurs on the
// same day-of-month). ──
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function getCycleStart15(admissionDate, today) {
  const ad = new Date(admissionDate + "T00:00:00");
  const diffDays = Math.floor((today - ad) / MS_PER_DAY);
  const cyclesPassed = Math.max(0, Math.floor(diffDays / 15));
  return new Date(ad.getTime() + cyclesPassed * 15 * MS_PER_DAY);
}

function getRentStatus15(admissionDate, today, rentPaidOn = null) {
  if (!admissionDate) return null;
  // cycleStart/nextDue = the current calendar-elapsed 15-day window, used
  // separately by isActiveForCycle15 to check payment validity. Kept as-is.
  const cycleStart = getCycleStart15(admissionDate, today);
  const nextDue = new Date(cycleStart.getTime() + 15 * MS_PER_DAY);
  const dueLabel = fmtDateIST(nextDue, { day: "numeric", month: "short" });

  // firstMissedBoundary = the due date actually owed against right now,
  // based on the last REAL payment (or admission if never paid). This is
  // what decides due_today/due_soon/ok/overdue.
  //
  // The previous version computed daysUntil from cycleStart/nextDue, which
  // are pure calendar-elapsed values independent of payment — nextDue is
  // ALWAYS in the future by construction, so daysUntil was NEVER negative.
  // Verified by simulation: this made the "overdue" branch permanently
  // unreachable — a 15-day tenant could never show overdue no matter how
  // long they went unpaid, even over a 5-year test.
  let firstMissedBoundary;
  if (rentPaidOn) {
    const coveredCycleStart = getCycleStart15(admissionDate, new Date(rentPaidOn));
    firstMissedBoundary = new Date(coveredCycleStart.getTime() + 15 * MS_PER_DAY);
  } else {
    firstMissedBoundary = new Date(admissionDate + "T00:00:00");
  }
  const daysDiff = Math.round((today - firstMissedBoundary) / MS_PER_DAY);
  if (daysDiff < 0) {
    const daysUntil = -daysDiff;
    if (daysUntil <= 3) return { type: "due_soon", label: `Due in ${daysUntil} day${daysUntil>1?"s":""}`, color: "#f59e0b", bg: "#fffbeb", icon: "🟡", daysUntil, cycleStart, nextDue };
    return { type: "ok", label: `Due on ${dueLabel}`, color: "#22c55e", bg: "#f0fdf4", icon: "🟢", daysUntil, cycleStart, nextDue };
  }
  if (daysDiff === 0) return { type: "due_today", label: "Due Today", color: "#ef4444", bg: "#fef2f2", icon: "🔴", daysUntil: 0, cycleStart, nextDue };
  const daysOverdue = daysDiff;
  return { type: "overdue", label: `${daysOverdue} day${daysOverdue !== 1 ? "s" : ""} overdue`, color: "#b91c1c", bg: "#fef2f2", icon: "🔴", daysOverdue, cycleStart, nextDue };
}

function isActiveForCycle15(isoDateStr, cycleStart) {
  if (!isoDateStr) return false;
  const d = new Date(isoDateStr);
  if (isNaN(d.getTime())) return false;
  return d >= cycleStart;
}

const inputStyle = {
  width: "100%", padding: "9px 11px", borderRadius: 8,
  border: "1.5px solid #e2e8f0", fontSize: 14, outline: "none",
  boxSizing: "border-box", background: "#f8fafc",
};

// ── CONTACT BUTTONS ───────────────────────────────────────────
function ContactButtons({ phone, size = "normal" }) {
  if (!phone) return null;
  const clean = phone.replace(/\D/g, "");
  const isSmall = size === "small";
  return (
    <div style={{ display: "flex", gap: 6 }} onClick={e => e.stopPropagation()}>
      <a
        href={`tel:${clean}`}
        style={{
          display: "flex", alignItems: "center", gap: isSmall ? 3 : 5,
          padding: isSmall ? "4px 8px" : "6px 12px",
          background: "#1a2332", color: "#fff", borderRadius: 8,
          fontSize: isSmall ? 11 : 12, fontWeight: 700,
          textDecoration: "none", whiteSpace: "nowrap",
          transition: "opacity 0.15s",
        }}
        onMouseEnter={e => e.currentTarget.style.opacity = "0.85"}
        onMouseLeave={e => e.currentTarget.style.opacity = "1"}
      >
        📞 {isSmall ? "" : "Call"}
      </a>
      <a
        href={`https://wa.me/${clean}`}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "flex", alignItems: "center", gap: isSmall ? 3 : 5,
          padding: isSmall ? "4px 8px" : "6px 12px",
          background: "#25d366", color: "#fff", borderRadius: 8,
          fontSize: isSmall ? 11 : 12, fontWeight: 700,
          textDecoration: "none", whiteSpace: "nowrap",
          transition: "opacity 0.15s",
        }}
        onMouseEnter={e => e.currentTarget.style.opacity = "0.85"}
        onMouseLeave={e => e.currentTarget.style.opacity = "1"}
      >
        💬 {isSmall ? "" : "WhatsApp"}
      </a>
    </div>
  );
}

// ── NAV ───────────────────────────────────────────────────────
function Nav({ page, setPage, allStats, rentAlerts, user, userRole, isAdmin, isManager }) {
  const isMobile = useIsMobile();
  const role = userRole?.role;

  const NAV_ITEMS = [
    { id: "home", icon: "🏠", label: "Dashboard", show: true },
    { id: "rooms", icon: "🛏", label: "Rooms", show: true },
    { id: "search", icon: "🔍", label: "Tenants", show: true },
    { id: "rent", icon: "💰", label: "Rent Due", show: isManager },
    { id: "deposits", icon: "🔒", label: "Deposits", show: isManager },
    { id: "history", icon: "🗂️", label: "History", show: isAdmin },
    { id: "users", icon: "👥", label: "Users", show: isAdmin },
  ].filter(n => n.show);

  if (isMobile) {
    // Mobile: top mini header + bottom tab bar
    return (
      <>
        {/* Top mini header */}
        <div style={{ background: "#1a2332", color: "#fff", position: "sticky", top: 0, zIndex: 50, boxShadow: "0 2px 8px #0005", padding: "0 16px", height: 50, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 20 }}>🏨</span>
            <span style={{ fontWeight: 800, fontSize: 16 }}>Turiya Hostel</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", gap: 10, fontSize: 12, color: "#94a3b8" }}>
              <span>🛏 <b style={{ color: "#e2e8f0" }}>{allStats.totalBeds}</b></span>
              <span>👤 <b style={{ color: "#60a5fa" }}>{allStats.totalOcc}</b></span>
            </div>
            <button onClick={supabaseAuth.signOut} style={{ background: "#ffffff18", border: "none", borderRadius: 8, padding: "4px 10px", color: "#94a3b8", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>Sign out</button>
          </div>
        </div>
        {/* Bottom tab bar */}
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#1a2332", zIndex: 50, display: "flex", borderTop: "1px solid #ffffff15", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {NAV_ITEMS.map(n => (
            <button key={n.id} onClick={() => setPage(n.id)} style={{
              flex: 1, padding: "8px 4px 10px", border: "none", background: "none",
              color: page === n.id ? "#60a5fa" : "#64748b",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
              cursor: "pointer", position: "relative",
              borderTop: page === n.id ? "2px solid #60a5fa" : "2px solid transparent",
            }}>
              <span style={{ fontSize: 18 }}>{n.icon}</span>
              <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.2px" }}>{n.label}</span>
              {n.id === "rent" && rentAlerts > 0 && (
                <span style={{ position: "absolute", top: 4, right: "50%", transform: "translateX(8px)", background: "#ef4444", color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 99, minWidth: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 3px" }}>{rentAlerts}</span>
              )}
            </button>
          ))}
        </div>
      </>
    );
  }

  // Desktop nav
  return (
    <div style={{ background: "#1a2332", color: "#fff", position: "sticky", top: 0, zIndex: 50, boxShadow: "0 2px 12px #0005" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", alignItems: "center", height: 60, padding: "0 20px", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: 28 }}>
          <span style={{ fontSize: 22 }}>🏨</span>
          <span style={{ fontWeight: 800, fontSize: 17, letterSpacing: "-0.5px" }}>HostelDesk</span>
        </div>
        <div style={{ display: "flex", gap: 2, flex: 1 }}>
          {NAV_ITEMS.map(n => (
            <button key={n.id} onClick={() => setPage(n.id)} style={{
              padding: "6px 14px", borderRadius: 8, border: "none",
              background: page === n.id ? "#ffffff18" : "transparent",
              color: page === n.id ? "#fff" : "#94a3b8",
              fontWeight: 600, fontSize: 13, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 5,
              borderBottom: page === n.id ? "2px solid #60a5fa" : "2px solid transparent",
              position: "relative",
            }}>
              <span>{n.icon}</span>
              <span>{n.label}</span>
              {n.id === "rent" && rentAlerts > 0 && (
                <span style={{ background: "#ef4444", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 99, minWidth: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px", marginLeft: 2 }}>{rentAlerts}</span>
              )}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 14, fontSize: 12, color: "#94a3b8", flexShrink: 0, alignItems: "center" }}>
          <span>🛏 <b style={{ color: "#e2e8f0" }}>{allStats.totalBeds}</b></span>
          <span>👤 <b style={{ color: "#60a5fa" }}>{allStats.totalOcc}</b></span>
          <span>✅ <b style={{ color: "#4ade80" }}>{allStats.totalBeds - allStats.totalOcc}</b></span>
          {user && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 8, paddingLeft: 12, borderLeft: "1px solid #ffffff22" }}>
              <span style={{ fontSize: 11, background: role === "admin" ? "#3b82f6" : role === "manager" ? "#22c55e" : "#f59e0b", color: "#fff", padding: "2px 8px", borderRadius: 99, fontWeight: 700, textTransform: "capitalize" }}>{role}</span>
              <button onClick={supabaseAuth.signOut} style={{ background: "#ffffff18", border: "none", borderRadius: 8, padding: "5px 12px", color: "#94a3b8", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>Sign out</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── DONUT ─────────────────────────────────────────────────────
function DonutChart({ pct, color, size = 90 }) {
  const r = 30, cx = 40, cy = 40, circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  return (
    <svg width={size} height={size} viewBox="0 0 80 80">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e2e8f0" strokeWidth="10" />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="10"
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" transform="rotate(-90 40 40)" />
      <text x="40" y="45" textAnchor="middle" fontSize="13" fontWeight="700" fill={color}>{pct}%</text>
    </svg>
  );
}

// ── HOME PAGE ─────────────────────────────────────────────────
// Tiny, minimal last-month-vs-this-month bar pair — no chart library needed
function MiniCompareBars({ a, b, color }) {
  const max = Math.max(1, a, b);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 28, marginTop: 8 }}>
      <div style={{ width: 10, height: `${Math.max(4, (a / max) * 28)}px`, background: "#e2e8f0", borderRadius: 2 }} title="Last month" />
      <div style={{ width: 10, height: `${Math.max(4, (b / max) * 28)}px`, background: color, borderRadius: 2 }} title="This month" />
    </div>
  );
}

function HomePage({ rooms, setPage, setActiveFloor, today, isManager = true, setRoomsInitialStatusFilter }) {
  const [trendPayments, setTrendPayments] = useState(null);
  const [trendDeposits, setTrendDeposits] = useState(null);
  useEffect(() => {
    if (!isManager) return;
    loadPayments().then(setTrendPayments).catch(() => setTrendPayments([]));
    loadDeposits().then(setTrendDeposits).catch(() => setTrendDeposits([]));
  }, [isManager]);

  const all = Object.values(rooms);
  const totalBeds = all.reduce((s, r) => s + r.beds, 0);
  const totalOcc = all.reduce((s, r) => s + getOccupied(r), 0);
  const totalFree = totalBeds - totalOcc;
  const occPct = totalBeds > 0 ? Math.round((totalOcc / totalBeds) * 100) : 0;
  const fullRooms = all.filter(r => getRoomStatus(r) === "full").length;
  const partialRooms = all.filter(r => getRoomStatus(r) === "partial").length;
  const emptyRooms = all.filter(r => getRoomStatus(r) === "empty").length;

  const floorStats = FLOORS.map(f => {
    const fr = all.filter(r => r.floor === f);
    return {
      f,
      beds: fr.reduce((s, r) => s + r.beds, 0),
      occ: fr.reduce((s, r) => s + getOccupied(r), 0),
      full: fr.filter(r => getRoomStatus(r) === "full").length,
      empty: fr.filter(r => getRoomStatus(r) === "empty").length,
    };
  });

  const barColors = ["#3b82f6", "#8b5cf6", "#f59e0b", "#10b981", "#ec4899"];

  // Rent alerts for home — only UNPAID tenants should ever trigger an alert,
  // and both Monthly and 15-Day billing types need checking (Daily has no cycle).
  const tenants = getAllTenants(rooms);
  const cyclicHome = tenants.filter(t => (t.billingType || "monthly") !== "daily" && t.admissionDate);
  const homeCategorized = cyclicHome.map(t => {
    const is15 = t.billingType === "15day";
    const rentStatus = is15 ? getRentStatus15(t.admissionDate, today, t.rentPaidOn) : getRentStatus(t.admissionDate, today, t.rentPaidOn);
    if (!rentStatus) return null;
    const isPaid = is15
      ? isActiveForCycle15(t.rentPaidOn, rentStatus.cycleStart)
      : isActiveForCycle(t.rentPaidOn, rentStatus.dueDay, today);
    const isSnoozed = !isPaid && isSnoozedNow(t.rentSnoozedUntil, t.rentSnoozedCycleStart, is15 ? rentStatus.cycleStart : getCycleStart(rentStatus.dueDay, today), today);
    return { ...t, rentStatus, isPaid, isSnoozed };
  }).filter(Boolean).filter(t => !t.isPaid && !t.isSnoozed);
  const overdue = homeCategorized.filter(t => t.rentStatus.type === "overdue").sort((a,b) => (b.rentStatus.daysOverdue||0) - (a.rentStatus.daysOverdue||0));
  const dueToday = homeCategorized.filter(t => t.rentStatus.type === "due_today");
  const dueSoon = homeCategorized.filter(t => t.rentStatus.type === "due_soon");

  // Recent tenants
  const recentTenants = [...tenants].sort((a,b) => (b.admissionDate||"").localeCompare(a.admissionDate||"")).slice(0, 6);

  // This month vs last month — real trend data, backed by actual timestamped
  // records (payments/deposits ledgers). Occupancy has no historical snapshot
  // stored anywhere, so it's intentionally not included here as a "trend" —
  // only things we actually have dated history for.
  const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const inRange = (dateStr, start, end) => { const d = new Date(dateStr); return d >= start && d < end; };

  const rentThisMonth = (trendPayments || []).filter(p => inRange(p.paid_at, thisMonthStart, new Date(today.getFullYear(), today.getMonth()+1, 1)));
  const rentLastMonth = (trendPayments || []).filter(p => inRange(p.paid_at, lastMonthStart, thisMonthStart));
  const rentThisTotal = rentThisMonth.reduce((s,p) => s + Number(p.amount||0), 0);
  const rentLastTotal = rentLastMonth.reduce((s,p) => s + Number(p.amount||0), 0);
  const rentChangePct = rentLastTotal > 0 ? Math.round(((rentThisTotal - rentLastTotal) / rentLastTotal) * 100) : (rentThisTotal > 0 ? 100 : 0);

  const depositsThisMonth = (trendDeposits || []).filter(d => inRange(d.collected_at, thisMonthStart, new Date(today.getFullYear(), today.getMonth()+1, 1)));
  const depositsLastMonth = (trendDeposits || []).filter(d => inRange(d.collected_at, lastMonthStart, thisMonthStart));
  const depositsThisTotal = depositsThisMonth.reduce((s,d) => s + Number(d.amount||0), 0);
  const depositsLastTotal = depositsLastMonth.reduce((s,d) => s + Number(d.amount||0), 0);
  const depositsHeldNow = (trendDeposits || []).filter(d => !d.returned_at).reduce((s,d) => s + Number(d.amount||0), 0);

  const newTenantsThisMonth = [...tenants].filter(t => t.admissionDate && inRange(t.admissionDate + "T00:00:00", thisMonthStart, new Date(today.getFullYear(), today.getMonth()+1, 1))).length;
  const newTenantsLastMonth = [...tenants].filter(t => t.admissionDate && inRange(t.admissionDate + "T00:00:00", lastMonthStart, thisMonthStart)).length;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "16px 12px 90px" }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 3px", letterSpacing: "-0.5px" }}>Dashboard</h1>
        <p style={{ margin: 0, color: "#64748b", fontSize: 14 }}>3 floors · {all.length} rooms · {totalBeds} beds total</p>
      </div>

      {/* Rent alerts banner (managers/admins only) */}
      {isManager && (overdue.length > 0 || dueToday.length > 0 || dueSoon.length > 0) && (
        <div style={{ marginBottom: 20, display: "flex", flexDirection: "column", gap: 8 }}>
          {overdue.length > 0 && (
            <div onClick={() => setPage("rent")} style={{ background: "#fef2f2", border: "1.5px solid #b91c1c", borderRadius: 12, padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 20 }}>🔴</span>
              <div style={{ flex: 1 }}>
                <b style={{ color: "#b91c1c" }}>Rent OVERDUE</b> — {overdue.length} tenant{overdue.length > 1 ? "s" : ""}: {overdue.slice(0,3).map(t => `${t.name} (${t.rentStatus.daysOverdue}d)`).join(", ")}{overdue.length > 3 ? ` +${overdue.length-3} more` : ""}
              </div>
              <span style={{ fontSize: 12, color: "#b91c1c", fontWeight: 600 }}>View →</span>
            </div>
          )}
          {dueToday.length > 0 && (
            <div onClick={() => setPage("rent")} style={{ background: "#fef2f2", border: "1.5px solid #fca5a5", borderRadius: 12, padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 20 }}>🔴</span>
              <div style={{ flex: 1 }}>
                <b style={{ color: "#ef4444" }}>Rent due TODAY</b> — {dueToday.length} tenant{dueToday.length > 1 ? "s" : ""}: {dueToday.slice(0,3).map(t => t.name).join(", ")}{dueToday.length > 3 ? ` +${dueToday.length-3} more` : ""}
              </div>
              <span style={{ fontSize: 12, color: "#ef4444", fontWeight: 600 }}>View →</span>
            </div>
          )}
          {dueSoon.length > 0 && (
            <div onClick={() => setPage("rent")} style={{ background: "#fffbeb", border: "1.5px solid #fcd34d", borderRadius: 12, padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 20 }}>🟡</span>
              <div style={{ flex: 1 }}>
                <b style={{ color: "#d97706" }}>Rent due soon</b> — {dueSoon.length} tenant{dueSoon.length > 1 ? "s" : ""} in the next 3 days
              </div>
              <span style={{ fontSize: 12, color: "#d97706", fontWeight: 600 }}>View →</span>
            </div>
          )}
        </div>
      )}

      {/* This Month vs Last Month trend */}
      {isManager && (
        <div style={{ background: "#fff", borderRadius: 14, padding: 16, marginBottom: 18, boxShadow: "0 1px 4px #0001" }}>
          <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 2 }}>📈 This Month vs Last Month</div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 14 }}>{today.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}</div>
          {trendPayments === null || trendDeposits === null ? (
            <div style={{ textAlign: "center", color: "#94a3b8", padding: 10, fontSize: 13 }}>Loading trend data…</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
              <div>
                <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>RENT COLLECTED</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#1a2332" }}>₹{rentThisTotal.toLocaleString("en-IN")}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: rentChangePct >= 0 ? "#15803d" : "#dc2626" }}>
                  {rentChangePct >= 0 ? "▲" : "▼"} {Math.abs(rentChangePct)}% <span style={{ color: "#94a3b8", fontWeight: 500 }}>vs ₹{rentLastTotal.toLocaleString("en-IN")} last month</span>
                </div>
                <MiniCompareBars a={rentLastTotal} b={rentThisTotal} color="#3b82f6" />
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>DEPOSITS COLLECTED</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#1a2332" }}>₹{depositsThisTotal.toLocaleString("en-IN")}</div>
                <div style={{ fontSize: 12, color: "#94a3b8" }}>vs ₹{depositsLastTotal.toLocaleString("en-IN")} last month</div>
                <MiniCompareBars a={depositsLastTotal} b={depositsThisTotal} color="#8b5cf6" />
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>DEPOSITS CURRENTLY HELD</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#1a2332" }}>₹{depositsHeldNow.toLocaleString("en-IN")}</div>
                <div style={{ fontSize: 12, color: "#94a3b8" }}>live snapshot, not a monthly trend</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>NEW TENANTS</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#1a2332" }}>{newTenantsThisMonth}</div>
                <div style={{ fontSize: 12, color: "#94a3b8" }}>vs {newTenantsLastMonth} last month</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* KPI Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10, marginBottom: 18 }}>
        {[
          { icon: "🛏", label: "Total Beds", value: totalBeds, color: "#3b82f6", bg: "#eff6ff" },
          { icon: "👤", label: "Occupied", value: totalOcc, color: "#ef4444", bg: "#fef2f2", goTo: "search" },
          { icon: "✅", label: "Available", value: totalFree, color: "#22c55e", bg: "#f0fdf4", statusFilter: "partial" },
          { icon: "🏠", label: "Total Rooms", value: all.length, color: "#8b5cf6", bg: "#f5f3ff", statusFilter: "all" },
          { icon: "🔴", label: "Full Rooms", value: fullRooms, color: "#f97316", bg: "#fff7ed", statusFilter: "full" },
          { icon: "🟡", label: "Partial", value: partialRooms, color: "#eab308", bg: "#fefce8", statusFilter: "partial" },
          { icon: "🟢", label: "Empty", value: emptyRooms, color: "#10b981", bg: "#ecfdf5", statusFilter: "empty" },
          { icon: "📊", label: "Occupancy", value: `${occPct}%`, color: "#6366f1", bg: "#eef2ff" },
        ].map(c => (
          <div key={c.label}
            onClick={c.statusFilter ? () => { setRoomsInitialStatusFilter(c.statusFilter); setPage("rooms"); } : c.goTo ? () => setPage(c.goTo) : undefined}
            style={{ background: c.bg, borderRadius: 12, padding: "16px 18px", border: `1.5px solid ${c.color}22`, cursor: (c.statusFilter || c.goTo) ? "pointer" : "default" }}>
            <div style={{ fontSize: 20, marginBottom: 6 }}>{c.icon}</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: c.color, lineHeight: 1 }}>{c.value}</div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 3, fontWeight: 500 }}>{c.label}{(c.statusFilter || c.goTo) && " →"}</div>
          </div>
        ))}
      </div>

      {/* Minimal room-composition bar — visual complement to the numbers above */}
      {all.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", borderRadius: 10, overflow: "hidden", height: 14, boxShadow: "0 1px 3px #0001" }}>
            {fullRooms > 0 && <div style={{ width: `${(fullRooms/all.length)*100}%`, background: "#f97316" }} title={`${fullRooms} full`} />}
            {partialRooms > 0 && <div style={{ width: `${(partialRooms/all.length)*100}%`, background: "#eab308" }} title={`${partialRooms} partial`} />}
            {emptyRooms > 0 && <div style={{ width: `${(emptyRooms/all.length)*100}%`, background: "#10b981" }} title={`${emptyRooms} empty`} />}
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 6, fontSize: 11, color: "#64748b" }}>
            <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "#f97316", marginRight: 4 }} />Full {fullRooms}</span>
            <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "#eab308", marginRight: 4 }} />Partial {partialRooms}</span>
            <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "#10b981", marginRight: 4 }} />Empty {emptyRooms}</span>
          </div>
        </div>
      )}

      {/* Two col */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 18, marginBottom: 18 }}>
        {/* Occupancy card */}
        <div style={{ background: "#fff", borderRadius: 14, padding: "20px", boxShadow: "0 1px 4px #0001" }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16 }}>Overall Occupancy</div>
          <div style={{ display: "flex", alignItems: "center", gap: 24, marginBottom: 16 }}>
            <DonutChart pct={occPct} color="#3b82f6" size={90} />
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[{ label: "Occupied", value: totalOcc, color: "#ef4444" }, { label: "Free", value: totalFree, color: "#22c55e" }].map(item => (
                <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 9, height: 9, borderRadius: "50%", background: item.color }} />
                  <span style={{ fontSize: 13, color: "#374151" }}>{item.label}</span>
                  <span style={{ fontWeight: 700, marginLeft: "auto", paddingLeft: 12, fontSize: 15 }}>{item.value}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: 14 }}>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, marginBottom: 8 }}>ROOM STATUS</div>
            <div style={{ display: "flex", gap: 8 }}>
              {[{ label: "Full", value: fullRooms, color: "#ef4444", bg: "#fef2f2", statusFilter: "full" }, { label: "Partial", value: partialRooms, color: "#f59e0b", bg: "#fffbeb", statusFilter: "partial" }, { label: "Empty", value: emptyRooms, color: "#22c55e", bg: "#f0fdf4", statusFilter: "empty" }].map(s => (
                <div key={s.label} onClick={() => { setRoomsInitialStatusFilter(s.statusFilter); setPage("rooms"); }} style={{ flex: 1, textAlign: "center", background: s.bg, borderRadius: 8, padding: "8px 4px", cursor: "pointer" }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: 10, color: "#64748b" }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Floor breakdown */}
        <div style={{ background: "#fff", borderRadius: 14, padding: "20px", boxShadow: "0 1px 4px #0001" }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14 }}>Floor Breakdown</div>
          {floorStats.map((fs, idx) => {
            const pct = fs.beds > 0 ? Math.round((fs.occ / fs.beds) * 100) : 0;
            return (
              <div key={fs.f} onClick={() => { setActiveFloor(fs.f); setPage("rooms"); }}
                style={{ marginBottom: 14, cursor: "pointer", padding: "10px 12px", borderRadius: 10, border: "1px solid #f1f5f9", transition: "border-color 0.15s" }}
                onMouseEnter={e => e.currentTarget.style.borderColor = barColors[idx]}
                onMouseLeave={e => e.currentTarget.style.borderColor = "#f1f5f9"}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{FLOOR_LABELS[fs.f]}</span>
                  <span style={{ fontSize: 12, color: "#64748b" }}>{fs.occ}/{fs.beds} beds ({pct}%)</span>
                </div>
                <div style={{ height: 7, background: "#f1f5f9", borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, background: barColors[idx], borderRadius: 99 }} />
                </div>
                <div style={{ marginTop: 5, fontSize: 11, color: "#94a3b8" }}>{fs.full} full · {fs.empty} empty · Click to manage →</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Floor detail + recent tenants */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 18 }}>
        {floorStats.map((fs, idx) => (
          <div key={fs.f} onClick={() => { setActiveFloor(fs.f); setPage("rooms"); }}
            style={{ background: "#fff", borderRadius: 12, padding: "16px", boxShadow: "0 1px 4px #0001", cursor: "pointer", border: "1.5px solid #f1f5f9", transition: "border-color 0.15s, box-shadow 0.15s" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = barColors[idx]; e.currentTarget.style.boxShadow = "0 4px 16px #0002"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#f1f5f9"; e.currentTarget.style.boxShadow = "0 1px 4px #0001"; }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{FLOOR_LABELS[fs.f]}</span>
              <span style={{ fontSize: 10, background: barColors[idx] + "22", color: barColors[idx], fontWeight: 600, padding: "2px 8px", borderRadius: 99 }}>{fs.beds > 0 ? Math.round((fs.occ/fs.beds)*100) : 0}%</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
              {[{ label: "Beds", value: fs.beds }, { label: "Occupied", value: fs.occ }, { label: "Full rooms", value: fs.full }, { label: "Empty", value: fs.empty }].map(item => (
                <div key={item.label} style={{ background: "#f8fafc", borderRadius: 8, padding: "8px 10px" }}>
                  <div style={{ fontSize: 17, fontWeight: 700 }}>{item.value}</div>
                  <div style={{ fontSize: 10, color: "#94a3b8" }}>{item.label}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Recent tenants */}
      <div style={{ background: "#fff", borderRadius: 14, padding: "20px", boxShadow: "0 1px 4px #0001" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Recent Admissions</div>
          <button onClick={() => setPage("search")} style={{ fontSize: 13, color: "#3b82f6", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>Search all →</button>
        </div>
        {recentTenants.length === 0
          ? <div style={{ textAlign: "center", padding: "24px 0", color: "#94a3b8", fontSize: 14 }}>No tenants yet. Add from the Rooms page.</div>
          : <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {recentTenants.map((t, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", background: "#f8fafc", borderRadius: 10, border: "1px solid #e2e8f0" }}>
                  <div style={{ width: 34, height: 34, borderRadius: "50%", background: "#1a2332", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14, flexShrink: 0 }}>
                    {t.name.charAt(0).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</div>
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>Floor {t.floor} · Room {t.roomNumber} · Bed {t.bed}</div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    {t.phone && <div style={{ fontSize: 12, color: "#374151" }}>📞 {t.phone}</div>}
                    {t.admissionDate && <div style={{ fontSize: 11, color: "#94a3b8" }}>{fmt(t.admissionDate)}</div>}
                  </div>
                </div>
              ))}
            </div>
        }
      </div>
    </div>
  );
}

// ── TENANT SEARCH PAGE ────────────────────────────────────────
function TenantSearchPage({ rooms, setPage, setActiveFloor, isManager = true, isAdmin = false }) {
  const [query, setQuery] = useState("");
  const [companyFilter, setCompanyFilter] = useState("all");
  const allTenants = getAllTenants(rooms);

  const companies = Array.from(new Set(allTenants.map(t => (t.occupationPlace || "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));

  const results = allTenants.filter(t => {
    const matchesQuery = query.trim().length === 0 || (
      t.name.toLowerCase().includes(query.toLowerCase()) ||
      (t.phone || "").includes(query) ||
      String(t.roomNumber).includes(query) ||
      String(t.floor).includes(query) ||
      (t.roomLabel || "").toLowerCase().includes(query.toLowerCase()) ||
      (t.occupationPlace || "").toLowerCase().includes(query.toLowerCase())
    );
    const matchesCompany = companyFilter === "all" || t.occupationPlace === companyFilter;
    return matchesQuery && matchesCompany;
  });

  function exportCurrentTenantsCSV() {
    if (results.length === 0) { alert("No tenants to export."); return; }
    const headers = ["Name", "Phone", "Floor", "Room", "Bed", "Rent Amount", "Billing Type", "Admission Date", "Father Name", "Father Phone", "Guardian Name", "Guardian Phone"];
    const data = results
      .slice()
      .sort((a, b) => (a.floor - b.floor) || (a.roomNumber - b.roomNumber) || (a.bed - b.bed))
      .map(t => [
        t.name, t.phone || "", FLOOR_LABELS[t.floor] || `Floor ${t.floor}`, t.roomNumber, t.bed,
        t.rentAmount || "", t.billingType || "monthly", t.admissionDate || "",
        t.fatherName || "", t.fatherPhone || "", t.guardianName || "", t.guardianPhone || "",
      ]);
    const csv = [headers, ...data].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hosteldesk-current-tenants-${istDateStr()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "16px 12px 90px" }}>
      <div style={{ marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 3px" }}>Tenant Search</h1>
          <p style={{ margin: 0, color: "#64748b", fontSize: 14 }}>{allTenants.length} tenants across all floors</p>
        </div>
        {isAdmin && (
          <button onClick={exportCurrentTenantsCSV} style={{ padding: "9px 14px", borderRadius: 10, border: "1.5px solid #86efac", background: "#f0fdf4", color: "#15803d", fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}>
            ⬇️ Export CSV
          </button>
        )}
      </div>

      <div style={{ position: "relative", marginBottom: 20 }}>
        <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontSize: 16 }}>🔍</span>
        <input
          autoFocus
          placeholder="Search by name, phone, room number, floor, company…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          style={{ ...inputStyle, paddingLeft: 40, fontSize: 15, padding: "12px 14px 12px 40px", borderRadius: 12, border: "2px solid #e2e8f0" }}
        />
        {query && (
          <button onClick={() => setQuery("")} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "#e2e8f0", border: "none", borderRadius: "50%", width: 22, height: 22, cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        )}
      </div>

      {isManager && companies.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: "#64748b", display: "block", marginBottom: 6 }}>FILTER BY COMPANY / PLACE</label>
          <select value={companyFilter} onChange={e => setCompanyFilter(e.target.value)} style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1.5px solid #e2e8f0", fontSize: 14, background: "#fff" }}>
            <option value="all">All companies/places</option>
            {companies.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      )}

      <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 12 }}>
        {(query || companyFilter !== "all") ? `${results.length} result${results.length !== 1 ? "s" : ""}${query ? ` for "${query}"` : ""}${companyFilter !== "all" ? ` at ${companyFilter}` : ""}` : `Showing all ${results.length} tenants`}
      </div>

      {results.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 0", color: "#94a3b8" }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🔍</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>No tenants found</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>Try a different name or phone number</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {results.map((t, i) => (
            <div key={i} onClick={() => { setActiveFloor(t.floor); setPage("rooms"); }}
              style={{ background: "#fff", borderRadius: 12, padding: "14px 16px", border: "1.5px solid #e2e8f0", cursor: "pointer", display: "flex", alignItems: "center", gap: 14, transition: "border-color 0.15s, box-shadow 0.15s" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "#3b82f6"; e.currentTarget.style.boxShadow = "0 2px 12px #0002"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "#e2e8f0"; e.currentTarget.style.boxShadow = "none"; }}>
              <div style={{ width: 42, height: 42, borderRadius: "50%", background: "#1a2332", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 17, flexShrink: 0 }}>
                {t.name.charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{t.name}</div>
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                  Floor {t.floor} · Room {t.roomNumber}{t.roomLabel ? ` (${t.roomLabel})` : ""} · Bed {t.bed}
                </div>
                {isManager && t.admissionDate && (
                  <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>Admitted: {fmt(t.admissionDate)}</div>
                )}
                {isManager && t.fatherName && <div style={{ fontSize: 11, color: "#64748b", marginTop: 1 }}>👨 Father: {t.fatherName}{t.fatherPhone ? ` · ${t.fatherPhone}` : ""}</div>}
                {isManager && t.guardianName && <div style={{ fontSize: 11, color: "#64748b", marginTop: 1 }}>🛡️ Guardian: {t.guardianName}{t.guardianPhone ? ` · ${t.guardianPhone}` : ""}</div>}
                {isManager && (t.city || t.address) && <div style={{ fontSize: 11, color: "#64748b", marginTop: 1 }}>📍 {[t.city, t.address].filter(Boolean).join(", ")}</div>}
                {isManager && t.occupationPlace && <div style={{ fontSize: 11, color: "#64748b", marginTop: 1 }}>💼 {t.occupation === "job" ? "Works at" : t.occupation === "college" ? "Studies at" : "At"}: {t.occupationPlace}{t.occupationId ? ` (ID: ${t.occupationId})` : ""}</div>}
                {isManager && t.reasonToStay && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1, fontStyle: "italic" }}>"{t.reasonToStay}"</div>}
                {isManager && t.rentAmount && <div style={{ fontSize: 12, fontWeight: 700, color: "#15803d", marginTop: 2 }}>💰 ₹{Number(t.rentAmount).toLocaleString("en-IN")}/month</div>}
                {isManager && t.depositAmount && (
                  <div style={{ fontSize: 11, fontWeight: 700, marginTop: 2, color: t.depositReturnedOn ? "#64748b" : t.depositPaidOn ? "#1d4ed8" : "#b45309" }}>
                    🔒 ₹{Number(t.depositAmount).toLocaleString("en-IN")} deposit — {t.depositReturnedOn ? "Returned" : t.depositPaidOn ? "Held" : "Pending"}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                {t.phone && <div style={{ fontSize: 12, color: "#64748b" }}>{t.phone}</div>}
                <ContactButtons phone={t.phone} />
                <div style={{ fontSize: 11, color: "#3b82f6", fontWeight: 500 }}>View room →</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Reusable Cash / UPI / Bank Transfer / Other(+ free text) selector
function PaymentModeSelector({ mode, setMode, otherText, setOtherText }) {
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
        {["Cash", "UPI", "Bank Transfer", "Other"].map(m => (
          <button key={m} onClick={() => setMode(m)} style={{
            padding: "9px 4px", borderRadius: 9, fontSize: 11.5, fontWeight: 700, cursor: "pointer",
            border: mode === m ? "2px solid #22c55e" : "1.5px solid #e2e8f0",
            background: mode === m ? "#f0fdf4" : "#fff",
            color: mode === m ? "#15803d" : "#64748b",
          }}>{m}</button>
        ))}
      </div>
      {mode === "Other" && (
        <input value={otherText} onChange={e => setOtherText(e.target.value)} placeholder="Optional — describe payment mode"
          style={{ width: "100%", marginTop: 8, padding: "9px 12px", borderRadius: 9, border: "1.5px solid #e2e8f0", fontSize: 13, boxSizing: "border-box" }} />
      )}
    </div>
  );
}

// ── TENANT RENT HISTORY SEARCH (search any tenant, see every payment ever
// made by them from the permanent ledger — independent of their current
// cycle status, and still works after they've checked out) ──
function TenantHistoryPanel({ paymentsLog, loading, search, setSearch }) {
  function reprint(p) {
    generateReceiptPDF({
      name: p.tenant_name,
      phone: p.phone,
      floorLabel: FLOOR_LABELS[p.floor] || "Floor " + p.floor,
      roomNumber: p.room_number,
      paidDate: new Date(p.paid_at),
      amount: p.amount,
      mode: p.payment_mode,
      receiptNo: p.receipt_no || generateReceiptNo(p.paid_at),
      cycleNote: "Monthly",
      note: p.note || "",
    });
  }

  const term = search.trim().toLowerCase();
  const matches = term.length === 0 ? [] : (paymentsLog || []).filter(p => (p.tenant_name || "").toLowerCase().includes(term));
  const sorted = [...matches].sort((a, b) => new Date(b.paid_at) - new Date(a.paid_at));
  const total = sorted.reduce((s, p) => s + Number(p.amount || 0), 0);

  return (
    <div style={{ background: "#fff", borderRadius: 14, padding: 16, marginBottom: 14, boxShadow: "0 1px 4px #0001" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", marginBottom: 8 }}>SEARCH A TENANT'S PAYMENT HISTORY</div>
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Type tenant name…"
        style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: "1.5px solid #e2e8f0", fontSize: 14, boxSizing: "border-box", marginBottom: 14 }}
      />
      {loading && <div style={{ textAlign: "center", color: "#94a3b8", padding: 20 }}>Loading payment history…</div>}
      {!loading && term.length === 0 && (
        <div style={{ textAlign: "center", color: "#94a3b8", padding: 10, fontSize: 13 }}>Start typing a name to see every rent payment they've ever made.</div>
      )}
      {!loading && term.length > 0 && sorted.length === 0 && (
        <div style={{ textAlign: "center", color: "#94a3b8", padding: 10, fontSize: 13 }}>No payments found matching "{search}".</div>
      )}
      {!loading && sorted.length > 0 && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, padding: "8px 10px", background: "#f8fafc", borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: "#64748b", fontWeight: 700 }}>{sorted.length} payment{sorted.length !== 1 ? "s" : ""} found</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#15803d" }}>₹{total.toLocaleString("en-IN")} total</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {sorted.map(p => (
              <div key={p.id || p.receipt_no} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#f8fafc", borderRadius: 8, padding: "8px 10px" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1a2332" }}>{p.tenant_name}</div>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>
                    {FLOOR_LABELS[p.floor] || "Floor " + p.floor} · Room {p.room_number} · {fmtDateIST(new Date(p.paid_at), { day: "numeric", month: "short", year: "numeric" })} · {p.payment_mode || "mode not set"}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: "#15803d" }}>₹{Number(p.amount || 0).toLocaleString("en-IN")}</div>
                  <button onClick={() => reprint(p)} style={{ padding: "5px 10px", borderRadius: 7, border: "1.5px solid #93c5fd", background: "#eff6ff", color: "#1d4ed8", fontWeight: 700, fontSize: 11, cursor: "pointer" }}>🧾 Reprint</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── RENT REPORTS PANEL (monthly/yearly revenue, from the permanent payments log) ──
function RentReportsPanel({ paymentsLog, loading, reportYear, setReportYear }) {
  const [expandedMonth, setExpandedMonth] = useState(null);

  if (loading) {
    return <div style={{ background: "#fff", borderRadius: 12, padding: 30, textAlign: "center", color: "#94a3b8", marginBottom: 14 }}>Loading payment history…</div>;
  }
  if (!paymentsLog || paymentsLog.length === 0) {
    return <div style={{ background: "#fff", borderRadius: 12, padding: 30, textAlign: "center", color: "#94a3b8", marginBottom: 14 }}>No payments recorded yet. Once you start marking rent as paid, monthly and yearly totals will show up here — including for tenants who later check out.</div>;
  }

  const years = Array.from(new Set(paymentsLog.map(p => new Date(p.paid_at).getFullYear()))).sort((a, b) => b - a);
  if (!years.includes(reportYear)) reportYear = years[0];

  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthly = monthNames.map((name, i) => {
    const rows = paymentsLog
      .filter(p => { const d = new Date(p.paid_at); return d.getFullYear() === reportYear && d.getMonth() === i; })
      .sort((a, b) => new Date(b.paid_at) - new Date(a.paid_at));
    return { name, monthIndex: i, rows, total: rows.reduce((s, p) => s + Number(p.amount || 0), 0), count: rows.length };
  });
  const yearTotal = monthly.reduce((s, m) => s + m.total, 0);
  const maxMonth = Math.max(1, ...monthly.map(m => m.total));

  function reprint(p) {
    generateReceiptPDF({
      name: p.tenant_name,
      phone: p.phone,
      floorLabel: FLOOR_LABELS[p.floor] || "Floor " + p.floor,
      roomNumber: p.room_number,
      paidDate: new Date(p.paid_at),
      amount: p.amount,
      mode: p.payment_mode,
      receiptNo: p.receipt_no || generateReceiptNo(p.paid_at),
      cycleNote: "Monthly",
      note: p.note || "",
    });
  }

  function exportYearCSV() {
    const rows = monthly.flatMap(m => m.rows);
    if (rows.length === 0) { alert(`No payments recorded in ${reportYear} to export.`); return; }
    const headers = ["Date", "Tenant", "Floor", "Room", "Amount", "Payment Mode", "Receipt No", "Note"];
    const data = rows
      .slice().sort((a, b) => new Date(a.paid_at) - new Date(b.paid_at))
      .map(p => [
        fmtDateIST(new Date(p.paid_at)),
        p.tenant_name || "",
        FLOOR_LABELS[p.floor] || `Floor ${p.floor}`,
        p.room_number,
        p.amount || 0,
        p.payment_mode || "",
        p.receipt_no || "",
        p.note || "",
      ]);
    const csv = [headers, ...data].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hosteldesk-payments-${reportYear}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ background: "#fff", borderRadius: 14, padding: 16, marginBottom: 14, boxShadow: "0 1px 4px #0001" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>TOTAL COLLECTED IN {reportYear}</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: "#1a2332" }}>₹{yearTotal.toLocaleString("en-IN")}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={exportYearCSV} style={{ padding: "8px 14px", borderRadius: 8, border: "1.5px solid #86efac", background: "#f0fdf4", color: "#15803d", fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}>⬇️ Export CSV</button>
          <select value={reportYear} onChange={e => { setReportYear(Number(e.target.value)); setExpandedMonth(null); }} style={{ padding: "8px 12px", borderRadius: 8, border: "1.5px solid #e2e8f0", fontWeight: 700, fontSize: 14 }}>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {monthly.map(m => (
          <div key={m.name}>
            <div onClick={() => m.count > 0 && setExpandedMonth(x => x === m.monthIndex ? null : m.monthIndex)}
              style={{ display: "flex", alignItems: "center", gap: 10, cursor: m.count > 0 ? "pointer" : "default", padding: "4px 6px", borderRadius: 8, background: expandedMonth === m.monthIndex ? "#f8fafc" : "transparent" }}>
              <div style={{ width: 32, fontSize: 12, fontWeight: 700, color: "#64748b" }}>{m.name}</div>
              <div style={{ flex: 1, background: "#f1f5f9", borderRadius: 6, height: 20, position: "relative", overflow: "hidden" }}>
                <div style={{ width: `${(m.total / maxMonth) * 100}%`, background: m.total > 0 ? "#3b82f6" : "transparent", height: "100%", borderRadius: 6, transition: "width 0.3s" }} />
              </div>
              <div style={{ width: 90, textAlign: "right", fontSize: 12.5, fontWeight: 700, color: "#1a2332" }}>₹{m.total.toLocaleString("en-IN")}</div>
              <div style={{ width: 22, textAlign: "right", fontSize: 10.5, color: "#94a3b8" }}>{m.count}</div>
              <div style={{ width: 14, textAlign: "center", fontSize: 10, color: "#94a3b8" }}>{m.count > 0 ? (expandedMonth === m.monthIndex ? "▲" : "▼") : ""}</div>
            </div>
            {expandedMonth === m.monthIndex && (
              <div style={{ margin: "6px 4px 10px", background: "#f8fafc", borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                {m.rows.map(p => (
                  <div key={p.id || p.receipt_no} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#fff", borderRadius: 8, padding: "8px 10px", boxShadow: "0 1px 2px #0001" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#1a2332" }}>{p.tenant_name}</div>
                      <div style={{ fontSize: 11, color: "#94a3b8" }}>
                        {FLOOR_LABELS[p.floor] || "Floor " + p.floor} · Room {p.room_number} · {fmtDateIST(new Date(p.paid_at), { day: "numeric", month: "short" })} · {p.payment_mode || "mode not set"}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: "#15803d" }}>₹{Number(p.amount || 0).toLocaleString("en-IN")}</div>
                      <button onClick={() => reprint(p)} style={{ padding: "5px 10px", borderRadius: 7, border: "1.5px solid #93c5fd", background: "#eff6ff", color: "#1d4ed8", fontWeight: 700, fontSize: 11, cursor: "pointer" }}>🧾 Reprint</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── RENT DUE PAGE ─────────────────────────────────────────────
// Shared receipt PDF generator — used both for a freshly-marked-paid tenant
// and for reprinting any past payment from the permanent ledger in Reports.
function generateReceiptPDF({ name, phone, floorLabel, roomNumber, paidDate, amount, mode, receiptNo, cycleNote, note = "", docTitle = "Rent Receipt", amountLabel = "AMOUNT PAID", fileTag = "" }) {
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) { alert("PDF library still loading — try again in a moment."); return; }

  const doc = new jsPDF({ unit: "pt", format: [320, 480] });
  doc.setFont("helvetica", "bold"); doc.setFontSize(16);
  doc.text("Turiya Hostel", 24, 40);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(120);
  doc.text(`${docTitle} · No. ${receiptNo}`, 24, 56);

  const rows = [
    ["Tenant", name],
    ["Room", `${floorLabel} - Room ${roomNumber}`],
    ["Phone", phone || "-"],
    ["Date", fmtDateIST(paidDate, { day: "numeric", month: "long", year: "numeric" })],
    ["Time", fmtDateIST(paidDate, { hour: "numeric", minute: "2-digit", hour12: true }) + " IST"],
    ["Mode", mode || "-"],
    ["Cycle", cycleNote || "-"],
  ];
  // Free-text notes are a separate row from cycle info, and only shown when
  // actually provided — this used to be conflated into one confusing "Note"
  // field that mixed billing-cycle text with anything the staff typed in.
  if (note && note.trim()) rows.push(["Notes", note.trim()]);
  let y = 84;
  doc.setFontSize(11);
  rows.forEach(([label, value]) => {
    doc.setTextColor(100); doc.text(label, 24, y);
    doc.setTextColor(20);
    const valueLines = doc.splitTextToSize(String(value), 170);
    doc.text(valueLines, 296, y, { align: "right" });
    doc.setDrawColor(230); doc.line(24, y + 8 + (valueLines.length - 1) * 12, 296, y + 8 + (valueLines.length - 1) * 12);
    y += 26 + (valueLines.length - 1) * 12;
  });

  doc.setFontSize(9); doc.setTextColor(150); doc.text(amountLabel, 160, y + 24, { align: "center" });
  doc.setFont("helvetica", "bold"); doc.setFontSize(26); doc.setTextColor(21, 128, 61);
  doc.text(`Rs ${Number(amount || 0).toLocaleString("en-IN")}`, 160, y + 52, { align: "center" });

  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(160);
  doc.text("This is a system-generated receipt. Keep it for your records.", 160, y + 90, { align: "center" });

  const fileDate = istDateStr(paidDate);
  const safeName = (name || "tenant").trim().replace(/[^a-zA-Z0-9]+/g, "_");
  doc.save(`${safeName}_${fileTag ? fileTag + "_" : ""}${fileDate}.pdf`);
}

function RentPage({ rooms, setRooms, today }) {
  const [filter, setFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [paidModal, setPaidModal] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [paymentMode, setPaymentMode] = useState("Cash");
  const [paymentModeOther, setPaymentModeOther] = useState("");
  const [showReports, setShowReports] = useState(false);
  const [receiptModal, setReceiptModal] = useState(null);
  const [receiptMode, setReceiptMode] = useState("Cash");
  const [receiptModeOther, setReceiptModeOther] = useState("");
  const [paymentsLog, setPaymentsLog] = useState(null);
  const [loadingReports, setLoadingReports] = useState(false);
  const [reportYear, setReportYear] = useState(today.getFullYear());
  const [showHistorySearch, setShowHistorySearch] = useState(false);
  const [snoozeModal, setSnoozeModal] = useState(null);
  const [snoozeDays, setSnoozeDays] = useState(7);
  const [unsnoozeConfirm, setUnsnoozeConfirm] = useState(null);
  const [undoPaidConfirm, setUndoPaidConfirm] = useState(null);
  const [paymentNote, setPaymentNote] = useState("");
  const [receiptNoteEdit, setReceiptNoteEdit] = useState("");
  const [historySearch, setHistorySearch] = useState("");

  useEffect(() => {
    if ((showReports || showHistorySearch) && paymentsLog === null) {
      setLoadingReports(true);
      loadPayments().then(rows => { setPaymentsLog(rows); setLoadingReports(false); });
    }
  }, [showReports, showHistorySearch]);

  const tenants = getAllTenants(rooms);
  const monthlyTenants = tenants.filter(t => (t.billingType || "monthly") === "monthly");
  const fifteenDayTenants = tenants.filter(t => (t.billingType || "monthly") === "15day");
  const dailyTenants = tenants.filter(t => (t.billingType || "monthly") === "daily");
  const cyclicTenants = [...monthlyTenants, ...fifteenDayTenants];
  const withDates = cyclicTenants.filter(t => t.admissionDate);
  const withoutDates = cyclicTenants.filter(t => !t.admissionDate);

  function tKey(t) { return `${t.floor}-${t.roomNumber}-${t.bed}`; }

  // Persist a payment-status change to Supabase, then reflect it in local state
  async function patchTenant(t, dbFields, localFields) {
    const key = tKey(t);
    setBusyKey(key);
    try {
      await sbFetch(`/tenants?id=eq.${t.dbId}`, "PATCH", dbFields, { "Prefer": "return=minimal" });
      setRooms(prev => {
        const roomId = `${t.floor}-${t.roomNumber}`;
        const room = prev[roomId];
        if (!room) return prev;
        const bedIndex = t.bed - 1;
        const newTenants = room.tenants.map((tn, bi) => bi === bedIndex ? { ...tn, ...localFields } : tn);
        return { ...prev, [roomId]: { ...room, tenants: newTenants } };
      });
    } catch (e) {
      console.error(e);
      alert("Failed to update payment status. Please check your internet connection.");
    }
    setBusyKey(null);
  }

  async function markPaid(t, paymentMode, note = "") {
    const nowIso = new Date().toISOString();
    const receiptNo = generateReceiptNo(nowIso);
    const finalMode = paymentMode;
    await patchTenant(
      t,
      { rent_paid_on: nowIso, rent_snoozed_at: null, rent_snoozed_until: null, rent_snoozed_cycle_start: null, rent_payment_mode: finalMode, rent_receipt_no: receiptNo, rent_note: note || null },
      { rentPaidOn: nowIso, rentSnoozedAt: "", rentSnoozedUntil: "", rentSnoozedCycleStart: "", rentPaymentMode: finalMode, rentReceiptNo: receiptNo, rentNote: note }
    );
    // Permanent ledger entry — survives even after this tenant checks out/is archived,
    // so month/year revenue reports always stay accurate.
    try {
      await logPayment({
        receipt_no: receiptNo,
        tenant_name: t.name,
        phone: t.phone || "",
        floor: t.floor,
        room_number: t.roomNumber,
        amount: Number(t.rentAmount) || 0,
        payment_mode: finalMode,
        paid_at: nowIso,
        note: note || null,
      });
    } catch (e) { console.warn("Payment log failed (table may not exist yet):", e); }
    return { nowIso, receiptNo, finalMode };
  }
  async function undoPaid(t) {
    const receiptNo = t.rentReceiptNo;
    await patchTenant(
      t,
      { rent_paid_on: null, rent_payment_mode: null, rent_receipt_no: null },
      { rentPaidOn: "", rentPaymentMode: "", rentReceiptNo: "" }
    );
    // Also remove the permanent ledger entry, otherwise the report keeps
    // counting a payment that was just undone.
    if (receiptNo) {
      try {
        await sbFetch(`/payments?receipt_no=eq.${receiptNo}`, "DELETE", null, { "Prefer": "return=minimal" });
        setPaymentsLog(prev => prev ? prev.filter(p => p.receipt_no !== receiptNo) : prev);
      } catch (e) { console.warn("Could not remove payment ledger entry:", e); }
    }
  }
  async function snoozeTenant(t, days) {
    const nowIso = new Date().toISOString();
    const untilIso = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    const is15 = (t.billingType || "monthly") === "15day";
    const cycleStart = is15
      ? getCycleStart15(t.admissionDate, today)
      : getCycleStart(new Date(t.admissionDate + "T00:00:00").getDate(), today);
    const cycleStartIso = cycleStart.toISOString();
    await patchTenant(
      t,
      { rent_snoozed_at: nowIso, rent_snoozed_until: untilIso, rent_snoozed_cycle_start: cycleStartIso },
      { rentSnoozedAt: nowIso, rentSnoozedUntil: untilIso, rentSnoozedCycleStart: cycleStartIso }
    );
  }
  async function unsnoozeTenant(t) {
    await patchTenant(t, { rent_snoozed_at: null, rent_snoozed_until: null, rent_snoozed_cycle_start: null }, { rentSnoozedAt: "", rentSnoozedUntil: "", rentSnoozedCycleStart: "" });
  }

  function printReceipt(t) {
    const paidDate = t.rentPaidOn ? new Date(t.rentPaidOn) : new Date();
    const receiptNo = t.rentReceiptNo || generateReceiptNo(paidDate.toISOString());
    const is15 = (t.billingType || "monthly") === "15day";
    generateReceiptPDF({
      name: t.name,
      phone: t.phone,
      floorLabel: FLOOR_LABELS[t.floor] || "Floor " + t.floor,
      roomNumber: t.roomNumber,
      paidDate,
      amount: t.rentAmount,
      mode: t.rentPaymentMode,
      receiptNo,
      cycleNote: is15
        ? (t.rentStatus ? `15-Day Cycle · next due ${fmtDateIST(t.rentStatus.nextDue, { day: "numeric", month: "short" })}` : "15-Day Cycle")
        : (t.rentStatus ? `Due on ${t.rentStatus.dueDay} · Monthly` : "Monthly"),
      note: t.rentNote || "",
    });
  }

  async function confirmReceiptAndPrint(t, mode, note = "") {
    const finalMode = mode === "Other" ? receiptModeOther.trim() : mode;
    setReceiptModal(null);
    const fieldsChanged = finalMode !== t.rentPaymentMode || note !== (t.rentNote || "");
    if (fieldsChanged) {
      // Keep the tenant row and the permanent ledger entry in sync
      try {
        await sbFetch(`/tenants?id=eq.${t.dbId}`, "PATCH", { rent_payment_mode: finalMode, rent_note: note || null }, { "Prefer": "return=minimal" });
        if (t.rentReceiptNo) {
          await sbFetch(`/payments?receipt_no=eq.${t.rentReceiptNo}`, "PATCH", { payment_mode: finalMode, note: note || null }, { "Prefer": "return=minimal" });
        }
        setRooms(prev => {
          const roomId = `${t.floor}-${t.roomNumber}`;
          const room = prev[roomId];
          if (!room) return prev;
          const bedIndex = t.bed - 1;
          const newTenants = room.tenants.map((tn, bi) => bi === bedIndex ? { ...tn, rentPaymentMode: finalMode, rentNote: note } : tn);
          return { ...prev, [roomId]: { ...room, tenants: newTenants } };
        });
      } catch (e) { console.warn("Could not update payment mode/note:", e); }
    }
    printReceipt({ ...t, rentPaymentMode: finalMode, rentNote: note });
  }

  const categorized = withDates.map(t => {
    const is15 = (t.billingType || "monthly") === "15day";
    const rentStatus = is15 ? getRentStatus15(t.admissionDate, today, t.rentPaidOn) : getRentStatus(t.admissionDate, today, t.rentPaidOn);
    const isPaid = !!rentStatus && (is15
      ? isActiveForCycle15(t.rentPaidOn, rentStatus.cycleStart)
      : isActiveForCycle(t.rentPaidOn, rentStatus.dueDay, today));
    const isSnoozed = !isPaid && !!rentStatus && isSnoozedNow(t.rentSnoozedUntil, t.rentSnoozedCycleStart, is15 ? rentStatus.cycleStart : getCycleStart(rentStatus.dueDay, today), today);
    return { ...t, rentStatus, isPaid, isSnoozed, is15 };
  });
  const allDue = categorized.filter(t => !t.isPaid && !t.isSnoozed);
  const overdue = allDue.filter(t => t.rentStatus.type === "overdue").sort((a, b) => (b.rentStatus.daysOverdue||0) - (a.rentStatus.daysOverdue||0));
  const dueToday = allDue.filter(t => t.rentStatus.type === "due_today");
  const dueSoon = allDue.filter(t => t.rentStatus.type === "due_soon");
  const ok = allDue.filter(t => t.rentStatus.type === "ok");
  const paidList = categorized.filter(t => t.isPaid);
  const snoozedList = categorized.filter(t => t.isSnoozed);

  let shown = [];
  if (filter === "all") shown = [...overdue, ...dueToday, ...dueSoon, ...ok];
  else if (filter === "overdue") shown = overdue;
  else if (filter === "due_today") shown = dueToday;
  else if (filter === "due_soon") shown = dueSoon;
  else if (filter === "ok") shown = ok;
  else if (filter === "paid") shown = paidList;
  else if (filter === "snoozed") shown = snoozedList;

  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    shown = shown.filter(t =>
      t.name.toLowerCase().includes(q) ||
      (t.phone || "").includes(searchQuery) ||
      String(t.roomNumber).includes(searchQuery) ||
      String(t.floor).includes(searchQuery)
    );
  }

  // Group by a stable key — monthly tenants group by day-of-month (they
  // recur on the same date every month), 15-day tenants group by their
  // actual next-due date (their cycle isn't tied to calendar months).
  const grouped = {};
  shown.forEach(t => {
    const key = t.is15 ? `f-${t.rentStatus.nextDue.toDateString()}` : `m-${t.rentStatus?.dueDay || 0}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(t);
  });
  const sortedKeys = Object.keys(grouped).sort((ka, kb) => grouped[ka][0].rentStatus.daysUntil - grouped[kb][0].rentStatus.daysUntil);

  const totalToCollect = [...dueToday, ...dueSoon].filter(t => t.rentAmount).reduce((s, t) => s + Number(t.rentAmount), 0);
  const totalCollected = paidList.filter(t => t.rentAmount).reduce((s, t) => s + Number(t.rentAmount), 0);

  // Calendar-month total: sums every payment actually made since the 1st of
  // this month, regardless of individual cycle status. No reset job needed —
  // it's just filtered live from the stored payment dates, so a new month
  // naturally starts at ₹0.
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const paidThisCalendarMonth = withDates.filter(t => {
    if (!t.rentPaidOn) return false;
    const d = new Date(t.rentPaidOn);
    return !isNaN(d.getTime()) && d >= monthStart;
  });
  const collectedThisMonth = paidThisCalendarMonth.filter(t => t.rentAmount).reduce((s, t) => s + Number(t.rentAmount), 0);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "16px 12px 90px" }}>
      <div style={{ marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 3px" }}>💰 Rent Due</h1>
          <p style={{ margin: 0, color: "#64748b", fontSize: 13 }}>
            {fmtDateIST(today, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setShowHistorySearch(s => !s)} style={{ padding: "9px 14px", borderRadius: 10, border: "1.5px solid " + (showHistorySearch ? "#1a2332" : "#e2e8f0"), background: showHistorySearch ? "#1a2332" : "#fff", color: showHistorySearch ? "#fff" : "#475569", fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}>
            🔍 History
          </button>
          <button onClick={() => setShowReports(s => !s)} style={{ padding: "9px 14px", borderRadius: 10, border: "1.5px solid " + (showReports ? "#1a2332" : "#e2e8f0"), background: showReports ? "#1a2332" : "#fff", color: showReports ? "#fff" : "#475569", fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}>
            📊 Reports
          </button>
        </div>
      </div>

      {showHistorySearch && (
        <TenantHistoryPanel paymentsLog={paymentsLog} loading={loadingReports} search={historySearch} setSearch={setHistorySearch} />
      )}

      {showReports && (
        <RentReportsPanel paymentsLog={paymentsLog} loading={loadingReports} reportYear={reportYear} setReportYear={setReportYear} />
      )}

      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 8, marginBottom: 14 }}>
        {[
          { label: "Overdue", value: overdue.length, color: "#b91c1c", bg: "#fef2f2", icon: "🔴", id: "overdue" },
          { label: "Due Today", value: dueToday.length, color: "#ef4444", bg: "#fef2f2", icon: "🔴", id: "due_today" },
          { label: "Due Soon", value: dueSoon.length, color: "#f59e0b", bg: "#fffbeb", icon: "🟡", id: "due_soon" },
          { label: "Upcoming", value: ok.length, color: "#22c55e", bg: "#f0fdf4", icon: "🟢", id: "ok" },
          { label: "Paid ✅", value: paidList.length, color: "#3b82f6", bg: "#eff6ff", icon: "✅", id: "paid" },
          { label: "Snoozed", value: snoozedList.length, color: "#8b5cf6", bg: "#f5f3ff", icon: "⏭️", id: "snoozed" },
        ].map(c => (
          <div key={c.id} onClick={() => setFilter(filter === c.id ? "all" : c.id)}
            style={{ background: filter === c.id ? c.color : c.bg, borderRadius: 12, padding: "12px 10px", cursor: "pointer", border: `2px solid ${filter === c.id ? c.color : c.color + "44"}`, transition: "all 0.15s", textAlign: "center" }}>
            <div style={{ fontSize: 18, marginBottom: 2 }}>{c.icon}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: filter === c.id ? "#fff" : c.color }}>{c.value}</div>
            <div style={{ fontSize: 10, color: filter === c.id ? "#ffffff99" : "#64748b", fontWeight: 600 }}>{c.label}</div>
          </div>
        ))}
      </div>

      {/* Money bar */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
        <div style={{ background: "#fef2f2", borderRadius: 12, padding: "12px 16px", border: "1.5px solid #fca5a5" }}>
          <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>TO COLLECT</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#ef4444" }}>₹{totalToCollect.toLocaleString("en-IN")}</div>
          <div style={{ fontSize: 11, color: "#94a3b8" }}>{[...dueToday,...dueSoon].filter(t=>t.rentAmount).length} tenants</div>
        </div>
        <div style={{ background: "#f0fdf4", borderRadius: 12, padding: "12px 16px", border: "1.5px solid #86efac" }}>
          <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>COLLECTED (this cycle)</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#15803d" }}>₹{totalCollected.toLocaleString("en-IN")}</div>
          <div style={{ fontSize: 11, color: "#94a3b8" }}>{paidList.filter(t=>t.rentAmount).length} tenants</div>
        </div>
      </div>

      {/* This calendar month's collections — resets automatically on the 1st, no manual reset needed */}
      <div style={{ background: "#eff6ff", borderRadius: 12, padding: "12px 16px", border: "1.5px solid #93c5fd", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>COLLECTED IN {fmtDateIST(today, { month: "long" }).toUpperCase()}</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#1d4ed8" }}>₹{collectedThisMonth.toLocaleString("en-IN")}</div>
        </div>
        <div style={{ fontSize: 11, color: "#94a3b8", textAlign: "right" }}>{paidThisCalendarMonth.length} payment{paidThisCalendarMonth.length !== 1 ? "s" : ""} since 1st<br/>auto-resets next month</div>
      </div>

      {/* No date warning */}
      {withoutDates.length > 0 && (
        <div style={{ background: "#fffbeb", border: "1.5px solid #fcd34d", borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#92400e" }}>
          ⚠️ <b>{withoutDates.length} tenant{withoutDates.length > 1 ? "s" : ""}</b> have no admission date — add from Rooms page.
        </div>
      )}

      {/* Daily tenants */}
      {dailyTenants.length > 0 && filter === "all" && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
            ☀️ Per Day Tenants
            <span style={{ fontSize: 11, background: "#fef3c7", color: "#d97706", fontWeight: 600, padding: "1px 8px", borderRadius: 99 }}>{dailyTenants.length}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {dailyTenants.map((t, i) => {
              const inn = t.admissionDate ? new Date(t.admissionDate + "T00:00:00") : null;
              const out = t.checkoutDate ? new Date(t.checkoutDate + "T00:00:00") : null;
              const days = inn && out ? Math.max(0, Math.round((out - inn) / 86400000)) : null;
              const isCheckedOut = out && out < today;
              return (
                <div key={i} style={{ background: "#fff", border: `1.5px solid ${isCheckedOut ? "#e2e8f0" : "#fcd34d"}`, borderLeft: `4px solid ${isCheckedOut ? "#94a3b8" : "#f59e0b"}`, borderRadius: 12, padding: "12px 14px", display: "flex", alignItems: "center", gap: 12, opacity: isCheckedOut ? 0.6 : 1 }}>
                  <div style={{ width: 38, height: 38, borderRadius: "50%", background: "#fffbeb", border: "2px solid #fcd34d", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14, color: "#d97706", flexShrink: 0 }}>
                    {t.name.charAt(0).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{t.name}</div>
                    <div style={{ fontSize: 11, color: "#64748b" }}>Floor {t.floor} · Room {t.roomNumber} · Bed {t.bed}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>{inn ? fmt(t.admissionDate) : "No check-in"}{out ? ` → ${fmt(t.checkoutDate)}` : ""}{days !== null ? ` · ${days} days` : ""}</div>
                    {t.rentAmount && <div style={{ fontSize: 12, fontWeight: 700, color: "#15803d", marginTop: 2 }}>₹{Number(t.rentAmount).toLocaleString("en-IN")} total</div>}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
                    <span style={{ background: isCheckedOut ? "#f1f5f9" : "#fffbeb", color: isCheckedOut ? "#94a3b8" : "#d97706", fontWeight: 700, fontSize: 10, padding: "2px 8px", borderRadius: 99 }}>{isCheckedOut ? "✅ Out" : out ? "⏳ Staying" : "☀️"}</span>
                    <ContactButtons phone={t.phone} size="small" />
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ height: 1, background: "#e2e8f0", margin: "14px 0" }} />
        </div>
      )}

      {/* Search */}
      <div style={{ position: "relative", marginBottom: 12 }}>
        <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14 }}>🔍</span>
        <input
          placeholder="Search by name, phone, room, floor…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{ width: "100%", padding: "10px 12px 10px 36px", borderRadius: 10, border: "1.5px solid #e2e8f0", fontSize: 14, boxSizing: "border-box" }}
        />
        {searchQuery && (
          <button onClick={() => setSearchQuery("")} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "#e2e8f0", border: "none", borderRadius: "50%", width: 20, height: 20, cursor: "pointer", fontSize: 11 }}>✕</button>
        )}
      </div>

      {/* Filter pills */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        {[
          { id: "all", label: "All" },
          { id: "due_today", label: "🔴 Today" },
          { id: "due_soon", label: "🟡 Soon" },
          { id: "ok", label: "🟢 Upcoming" },
          { id: "paid", label: "✅ Paid" },
          { id: "snoozed", label: "⏭️ Snoozed" },
        ].map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            padding: "6px 12px", borderRadius: 8,
            border: "1.5px solid " + (filter === f.id ? "#1a2332" : "#e2e8f0"),
            background: filter === f.id ? "#1a2332" : "#fff",
            color: filter === f.id ? "#fff" : "#64748b",
            fontWeight: 600, fontSize: 12, cursor: "pointer",
          }}>{f.label}</button>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#94a3b8" }}>{shown.length} tenants</span>
      </div>

      {/* Tenant list */}
      {shown.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 0", color: "#94a3b8" }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>{filter === "paid" ? "✅" : filter === "snoozed" ? "⏭️" : "🎉"}</div>
          <div style={{ fontWeight: 600 }}>{filter === "paid" ? "No payments marked yet" : filter === "snoozed" ? "Nothing snoozed" : "No tenants here"}</div>
        </div>
      ) : (
        sortedKeys.map(key => {
          const group = grouped[key];
          const first = group[0];
          const headerLabel = filter === "paid" ? "✅ Paid this cycle"
            : filter === "snoozed" ? "⏭️ Snoozed"
            : first.rentStatus.type === "due_today" ? "🔴 Due Today"
            : first.is15 ? `🔁 ${fmtDateIST(first.rentStatus.nextDue, { day: "numeric", month: "short" })} · 15-Day Cycle`
            : `📅 ${ordinal(first.rentStatus.dueDay)} of every month`;
          return (
          <div key={key} style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: "#1a2332" }}>
                {headerLabel}
              </div>
              <div style={{ height: 1, flex: 1, background: "#e2e8f0" }} />
              <span style={{ fontSize: 12, color: "#94a3b8" }}>{group.length}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {group.map((t, idx) => {
                const rs = t.rentStatus;
                const key = tKey(t);
                const isPaid = t.isPaid;
                const isSnoozed = t.isSnoozed;
                const isBusy = busyKey === key;
                const borderColor = isPaid ? "#22c55e" : isSnoozed ? "#8b5cf6" : rs.color;
                const bgColor = isPaid ? "#f0fdf4" : isSnoozed ? "#f5f3ff" : "#fff";
                return (
                  <div key={idx} style={{ background: bgColor, border: `1.5px solid ${borderColor}44`, borderLeft: `4px solid ${borderColor}`, borderRadius: 14, padding: "14px 16px" }}>
                    {/* Name row with rent amount badge */}
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 10 }}>
                      <div style={{ width: 44, height: 44, borderRadius: "50%", background: isPaid ? "#dcfce7" : isSnoozed ? "#ede9fe" : rs.bg, border: `2px solid ${borderColor}66`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 17, color: borderColor, flexShrink: 0 }}>
                        {isPaid ? "✅" : isSnoozed ? "⏭️" : t.name.charAt(0).toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 2 }}>
                          <span style={{ fontWeight: 800, fontSize: 16 }}>{t.name}</span>
                          {/* RENT AMOUNT BADGE - big and visible */}
                          {t.rentAmount && (
                            <span style={{ background: "#f0fdf4", color: "#15803d", fontWeight: 800, fontSize: 15, padding: "3px 12px", borderRadius: 10, border: "2px solid #86efac" }}>
                              ₹{Number(t.rentAmount).toLocaleString("en-IN")}{t.is15 ? "/15 days" : "/mo"}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: "#64748b" }}>
                          Floor {t.floor} · Room {t.roomNumber}{t.roomLabel ? ` (${t.roomLabel})` : ""} · Bed {t.bed}
                        </div>
                        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                          Joined: {fmt(t.admissionDate)}
                          {isPaid && t.rentPaidOn && ` · Paid: ${fmtDateIST(new Date(t.rentPaidOn))}`}
                          {isSnoozed && t.rentSnoozedUntil && ` · Snoozed until ${fmtDateIST(new Date(t.rentSnoozedUntil), { day: "numeric", month: "short" })} (or sooner if next cycle starts)`}
                        </div>
                      </div>
                      <span style={{ flexShrink: 0, background: isPaid ? "#dcfce7" : isSnoozed ? "#ede9fe" : rs.bg, color: isPaid ? "#15803d" : isSnoozed ? "#7c3aed" : rs.color, fontWeight: 700, fontSize: 11, padding: "3px 10px", borderRadius: 99, border: `1px solid ${borderColor}44`, whiteSpace: "nowrap" }}>
                        {isPaid ? "✅ Paid" : isSnoozed ? `⏰ Snoozed to ${fmtDateIST(new Date(t.rentSnoozedUntil), { day: "numeric", month: "short" })}` : `${rs.icon} ${rs.label}`}
                      </span>
                    </div>
                    {/* Action buttons row */}
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <ContactButtons phone={t.phone} size="small" />
                      <div style={{ flex: 1 }} />
                      {!isPaid && !isSnoozed && (
                        <>
                          <button disabled={isBusy} onClick={() => { setPaymentMode("Cash"); setPaymentModeOther(""); setPaymentNote(""); setPaidModal(t); }} style={{ padding: "8px 16px", borderRadius: 10, border: "none", background: "#22c55e", color: "#fff", fontWeight: 800, fontSize: 13, cursor: isBusy ? "default" : "pointer", opacity: isBusy ? 0.6 : 1, display: "flex", alignItems: "center", gap: 5 }}>
                            ✅ Mark Paid
                          </button>
                          <button disabled={isBusy} onClick={() => { setSnoozeDays(7); setSnoozeModal(t); }} style={{ padding: "8px 14px", borderRadius: 10, border: "1.5px solid #c4b5fd", background: "#f5f3ff", color: "#7c3aed", fontWeight: 700, fontSize: 13, cursor: isBusy ? "default" : "pointer", opacity: isBusy ? 0.6 : 1 }}>
                            ⏰ Snooze
                          </button>
                        </>
                      )}
                      {isPaid && (
                        <>
                          <button onClick={() => { setReceiptMode(t.rentPaymentMode || "Cash"); setReceiptModeOther(""); setReceiptNoteEdit(t.rentNote || ""); setReceiptModal(t); }} style={{ padding: "7px 14px", borderRadius: 10, border: "1.5px solid #93c5fd", background: "#eff6ff", color: "#1d4ed8", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                            🧾 Receipt
                          </button>
                          <button disabled={isBusy} onClick={() => setUndoPaidConfirm(t)} style={{ padding: "7px 14px", borderRadius: 10, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 600, fontSize: 12, cursor: isBusy ? "default" : "pointer", opacity: isBusy ? 0.6 : 1 }}>
                            Undo Paid
                          </button>
                        </>
                      )}
                      {isSnoozed && (
                        <>
                          <button disabled={isBusy} onClick={() => { setPaymentMode("Cash"); setPaymentModeOther(""); setPaymentNote(""); setPaidModal(t); }} style={{ padding: "8px 16px", borderRadius: 10, border: "none", background: "#22c55e", color: "#fff", fontWeight: 800, fontSize: 13, cursor: isBusy ? "default" : "pointer", opacity: isBusy ? 0.6 : 1 }}>
                            ✅ Mark Paid
                          </button>
                          <button disabled={isBusy} onClick={() => setUnsnoozeConfirm(t)} style={{ padding: "7px 14px", borderRadius: 10, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 600, fontSize: 12, cursor: isBusy ? "default" : "pointer", opacity: isBusy ? 0.6 : 1 }}>
                            Unsnooze
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          );
        })
      )}

      {/* Paid confirmation modal */}
      {paidModal && (
        <div onClick={() => setPaidModal(null)} style={{ position: "fixed", inset: 0, background: "#0009", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 200 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: "22px 22px 0 0", padding: "20px 24px 36px", width: "100%", maxWidth: 440, boxShadow: "0 -8px 40px #0004" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
              <div style={{ width: 40, height: 4, borderRadius: 99, background: "#e2e8f0" }} />
            </div>
            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <div style={{ fontSize: 52, marginBottom: 10 }}>💰</div>
              <div style={{ fontWeight: 800, fontSize: 20, color: "#1a2332" }}>Confirm Payment Received</div>
              <div style={{ fontSize: 14, color: "#64748b", marginTop: 8 }}>Did you receive rent from</div>
              <div style={{ fontWeight: 800, fontSize: 20, color: "#1a2332", marginTop: 4 }}>{paidModal.name}?</div>
              <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>Floor {paidModal.floor} · Room {paidModal.roomNumber} · Bed {paidModal.bed}</div>
              {paidModal.rentAmount && (
                <div style={{ marginTop: 14, display: "inline-block", background: "#f0fdf4", color: "#15803d", fontWeight: 800, fontSize: 28, padding: "10px 28px", borderRadius: 14, border: "2.5px solid #86efac" }}>
                  ₹{Number(paidModal.rentAmount).toLocaleString("en-IN")}
                </div>
              )}
            </div>
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 8, textAlign: "center" }}>Mode of Payment</div>
              <PaymentModeSelector mode={paymentMode} setMode={setPaymentMode} otherText={paymentModeOther} setOtherText={setPaymentModeOther} />
            </div>
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 6 }}>Notes (optional — will print on the receipt)</div>
              <input
                value={paymentNote}
                onChange={e => setPaymentNote(e.target.value)}
                placeholder="e.g. partial adjustment, late fee waived…"
                style={{ width: "100%", padding: "9px 12px", borderRadius: 9, border: "1.5px solid #e2e8f0", fontSize: 13, boxSizing: "border-box" }}
              />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setPaidModal(null)} style={{ flex: 1, padding: "14px 0", borderRadius: 12, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>
                Cancel
              </button>
              <button onClick={async () => {
                const t = paidModal;
                const mode = paymentMode === "Other" ? paymentModeOther.trim() : paymentMode;
                const note = paymentNote.trim();
                setPaidModal(null);
                const result = await markPaid(t, mode, note);
                if (result) {
                  printReceipt({
                    ...t,
                    rentPaidOn: result.nowIso,
                    rentPaymentMode: result.finalMode,
                    rentReceiptNo: result.receiptNo,
                    rentNote: note,
                  });
                }
              }} style={{ flex: 2, padding: "14px 0", borderRadius: 12, border: "none", background: "#22c55e", color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer" }}>
                ✅ Yes, Received!
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Receipt confirmation modal — same style as the paid confirmation,
          lets you review/adjust payment mode right before generating the PDF */}
      {receiptModal && (
        <div onClick={() => setReceiptModal(null)} style={{ position: "fixed", inset: 0, background: "#0009", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 200 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: "22px 22px 0 0", padding: "20px 24px 36px", width: "100%", maxWidth: 440, boxShadow: "0 -8px 40px #0004" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
              <div style={{ width: 40, height: 4, borderRadius: 99, background: "#e2e8f0" }} />
            </div>
            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <div style={{ fontSize: 52, marginBottom: 10 }}>🧾</div>
              <div style={{ fontWeight: 800, fontSize: 20, color: "#1a2332" }}>Generate Receipt</div>
              <div style={{ fontSize: 14, color: "#64748b", marginTop: 8 }}>For</div>
              <div style={{ fontWeight: 800, fontSize: 20, color: "#1a2332", marginTop: 4 }}>{receiptModal.name}</div>
              <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>Floor {receiptModal.floor} · Room {receiptModal.roomNumber} · Bed {receiptModal.bed}</div>
              {receiptModal.rentAmount && (
                <div style={{ marginTop: 14, display: "inline-block", background: "#eff6ff", color: "#1d4ed8", fontWeight: 800, fontSize: 28, padding: "10px 28px", borderRadius: 14, border: "2.5px solid #93c5fd" }}>
                  ₹{Number(receiptModal.rentAmount).toLocaleString("en-IN")}
                </div>
              )}
            </div>
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 8, textAlign: "center" }}>Mode of Payment</div>
              <PaymentModeSelector mode={receiptMode} setMode={setReceiptMode} otherText={receiptModeOther} setOtherText={setReceiptModeOther} />
            </div>
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 6 }}>Notes (optional — printed on the receipt)</div>
              <input
                value={receiptNoteEdit}
                onChange={e => setReceiptNoteEdit(e.target.value)}
                placeholder="e.g. partial adjustment, late fee waived…"
                style={{ width: "100%", padding: "9px 12px", borderRadius: 9, border: "1.5px solid #e2e8f0", fontSize: 13, boxSizing: "border-box" }}
              />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setReceiptModal(null)} style={{ flex: 1, padding: "14px 0", borderRadius: 12, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>
                Cancel
              </button>
              <button onClick={() => confirmReceiptAndPrint(receiptModal, receiptMode, receiptNoteEdit.trim())} style={{ flex: 2, padding: "14px 0", borderRadius: 12, border: "none", background: "#1d4ed8", color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer" }}>
                🧾 Print / Save PDF
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Snooze confirmation — custom duration, 1 day to 3 months (90 days) */}
      {snoozeModal && (
        <div onClick={() => setSnoozeModal(null)} style={{ position: "fixed", inset: 0, background: "#0009", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 200 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: "22px 22px 0 0", padding: "20px 24px 36px", width: "100%", maxWidth: 440, boxShadow: "0 -8px 40px #0004" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}><div style={{ width: 40, height: 4, borderRadius: 99, background: "#e2e8f0" }} /></div>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 52, marginBottom: 10 }}>⏰</div>
              <div style={{ fontWeight: 800, fontSize: 20, color: "#1a2332" }}>Snooze Rent Reminder</div>
              <div style={{ fontSize: 14, color: "#64748b", marginTop: 8 }}>For</div>
              <div style={{ fontWeight: 800, fontSize: 20, color: "#1a2332", marginTop: 4 }}>{snoozeModal.name}</div>
              <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>Floor {snoozeModal.floor} · Room {snoozeModal.roomNumber} · Bed {snoozeModal.bed}</div>
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 8, textAlign: "center" }}>Hide from Rent Due for how many days?</div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                <input type="range" min={1} max={90} value={snoozeDays} onChange={e => setSnoozeDays(Number(e.target.value))} style={{ flex: 1 }} />
                <input type="number" min={1} max={90} value={snoozeDays} onChange={e => setSnoozeDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
                  style={{ width: 60, padding: "8px 6px", borderRadius: 8, border: "1.5px solid #e2e8f0", fontSize: 14, textAlign: "center" }} />
              </div>
              <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 8 }}>
                {[1, 3, 7, 14, 30, 90].map(d => (
                  <button key={d} onClick={() => setSnoozeDays(d)} style={{
                    padding: "5px 10px", borderRadius: 7, fontSize: 11.5, fontWeight: 700, cursor: "pointer",
                    border: snoozeDays === d ? "2px solid #7c3aed" : "1.5px solid #e2e8f0",
                    background: snoozeDays === d ? "#f5f3ff" : "#fff",
                    color: snoozeDays === d ? "#7c3aed" : "#64748b",
                  }}>{d === 90 ? "3mo" : d + "d"}</button>
                ))}
              </div>
              <div style={{ textAlign: "center", fontSize: 12.5, color: "#7c3aed", fontWeight: 700, background: "#f5f3ff", borderRadius: 8, padding: "6px 10px" }}>
                Hidden until {fmtDateIST(new Date(Date.now() + snoozeDays * 24*60*60*1000), { day: "numeric", month: "short", year: "numeric" })} — but reappears sooner automatically if their next rent cycle begins first
              </div>
            </div>
            <div style={{ fontSize: 11.5, color: "#94a3b8", textAlign: "center", marginBottom: 4 }}>
              This only snoozes the payment currently due — a new cycle starting during this period will show up as a fresh reminder.
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button onClick={() => setSnoozeModal(null)} style={{ flex: 1, padding: "14px 0", borderRadius: 12, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>Cancel</button>
              <button onClick={async () => {
                const t = snoozeModal;
                const days = snoozeDays;
                setSnoozeModal(null);
                await snoozeTenant(t, days);
              }} style={{ flex: 2, padding: "14px 0", borderRadius: 12, border: "none", background: "#7c3aed", color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer" }}>
                ⏰ Snooze {snoozeDays} day{snoozeDays !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unsnooze confirmation */}
      {unsnoozeConfirm && (
        <div onClick={() => setUnsnoozeConfirm(null)} style={{ position: "fixed", inset: 0, background: "#00000066", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 210, padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, padding: 22, width: "100%", maxWidth: 340 }}>
            <div style={{ fontSize: 40, textAlign: "center", marginBottom: 8 }}>⏰</div>
            <div style={{ fontWeight: 800, fontSize: 18, textAlign: "center", marginBottom: 8 }}>Remove snooze?</div>
            <div style={{ fontSize: 13, color: "#64748b", textAlign: "center", marginBottom: 18 }}>
              <b>{unsnoozeConfirm.name}</b> will immediately show up as due again in the Rent Due list, instead of staying hidden until {fmtDateIST(new Date(unsnoozeConfirm.rentSnoozedUntil), { day: "numeric", month: "short" })}.
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setUnsnoozeConfirm(null)} style={{ flex: 1, padding: "12px 0", borderRadius: 10, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 600, fontSize: 14, cursor: "pointer" }}>Cancel</button>
              <button onClick={async () => { const t = unsnoozeConfirm; setUnsnoozeConfirm(null); await unsnoozeTenant(t); }} style={{ flex: 2, padding: "12px 0", borderRadius: 10, border: "none", background: "#7c3aed", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
                Yes, Unsnooze
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Undo Paid confirmation */}
      {undoPaidConfirm && (
        <div onClick={() => setUndoPaidConfirm(null)} style={{ position: "fixed", inset: 0, background: "#00000066", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 210, padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, padding: 22, width: "100%", maxWidth: 340 }}>
            <div style={{ fontSize: 40, textAlign: "center", marginBottom: 8 }}>⚠️</div>
            <div style={{ fontWeight: 800, fontSize: 18, textAlign: "center", marginBottom: 8 }}>Undo this payment?</div>
            <div style={{ fontSize: 13, color: "#64748b", textAlign: "center", marginBottom: 18 }}>
              <b>{undoPaidConfirm.name}</b> will show up as due again, and their "Paid" status for this cycle will be removed. This does not delete their permanent payment record in Reports.
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setUndoPaidConfirm(null)} style={{ flex: 1, padding: "12px 0", borderRadius: 10, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 600, fontSize: 14, cursor: "pointer" }}>Cancel</button>
              <button onClick={async () => { const t = undoPaidConfirm; setUndoPaidConfirm(null); await undoPaid(t); }} style={{ flex: 2, padding: "12px 0", borderRadius: 10, border: "none", background: "#dc2626", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
                Yes, Undo
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── SECURITY DEPOSITS PAGE ──────────────────────────────────────
// Completely independent of rent: sourced from its own `security_deposits`
// table, so nothing here ever touches rent data or the Rent report.
// ── SECURITY DEPOSIT REPORTS PANEL ───────────────────────────
function DepositReportsPanel({ depositsLog, loading }) {
  const [reportYear, setReportYear] = useState(new Date().getFullYear());
  const [expandedMonth, setExpandedMonth] = useState(null);

  if (loading) {
    return <div style={{ background: "#fff", borderRadius: 12, padding: 30, textAlign: "center", color: "#94a3b8", marginBottom: 14 }}>Loading deposit history…</div>;
  }
  if (!depositsLog || depositsLog.length === 0) {
    return <div style={{ background: "#fff", borderRadius: 12, padding: 30, textAlign: "center", color: "#94a3b8", marginBottom: 14 }}>No deposits recorded yet.</div>;
  }

  const years = Array.from(new Set(depositsLog.map(d => new Date(d.collected_at).getFullYear()))).sort((a, b) => b - a);
  if (!years.includes(reportYear)) reportYear = years[0];

  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthly = monthNames.map((name, i) => {
    const collected = depositsLog.filter(d => { const dt = new Date(d.collected_at); return dt.getFullYear() === reportYear && dt.getMonth() === i; });
    const returned = depositsLog.filter(d => d.returned_at && (() => { const dt = new Date(d.returned_at); return dt.getFullYear() === reportYear && dt.getMonth() === i; })());
    // Build a combined, chronological transaction list for this month (each
    // collect and each return is its own line, even if same deposit record)
    const transactions = [
      ...collected.map(d => ({ ...d, txType: "collected", txDate: d.collected_at, txAmount: d.amount })),
      ...returned.map(d => ({ ...d, txType: "returned", txDate: d.returned_at, txAmount: d.return_amount })),
    ].sort((a, b) => new Date(b.txDate) - new Date(a.txDate));
    return {
      name, monthIndex: i, transactions,
      collectedTotal: collected.reduce((s, d) => s + Number(d.amount || 0), 0),
      returnedTotal: returned.reduce((s, d) => s + Number(d.return_amount || 0), 0),
      collectedCount: collected.length,
      returnedCount: returned.length,
    };
  });
  const yearCollected = monthly.reduce((s, m) => s + m.collectedTotal, 0);
  const yearReturned = monthly.reduce((s, m) => s + m.returnedTotal, 0);
  const maxVal = Math.max(1, ...monthly.map(m => Math.max(m.collectedTotal, m.returnedTotal)));

  function reprintTx(tx) {
    if (tx.txType === "collected") {
      generateReceiptPDF({
        name: tx.tenant_name, phone: tx.phone, floorLabel: FLOOR_LABELS[tx.floor] || "Floor " + tx.floor,
        roomNumber: tx.room_number, paidDate: new Date(tx.collected_at), amount: tx.amount, mode: tx.payment_mode,
        receiptNo: tx.receipt_no, cycleNote: "Security Deposit", note: tx.collect_note || "", docTitle: "Security Deposit Receipt", amountLabel: "DEPOSIT COLLECTED", fileTag: "deposit",
      });
    } else {
      generateReceiptPDF({
        name: tx.tenant_name, phone: tx.phone, floorLabel: FLOOR_LABELS[tx.floor] || "Floor " + tx.floor,
        roomNumber: tx.room_number, paidDate: new Date(tx.returned_at), amount: tx.return_amount, mode: tx.return_mode,
        receiptNo: tx.return_receipt_no, cycleNote: "Security Deposit Return", note: tx.return_note || "", docTitle: "Deposit Return Receipt", amountLabel: "AMOUNT RETURNED", fileTag: "deposit_return",
      });
    }
  }

  function exportCSV() {
    const rows = depositsLog.filter(d => new Date(d.collected_at).getFullYear() === reportYear);
    if (rows.length === 0) { alert(`No deposits in ${reportYear} to export.`); return; }
    const headers = ["Tenant", "Floor", "Room", "Collected Date", "Amount Collected", "Collect Mode", "Returned Date", "Amount Returned", "Return Mode", "Receipt No"];
    const data = rows.map(d => [
      d.tenant_name, FLOOR_LABELS[d.floor] || `Floor ${d.floor}`, d.room_number,
      fmtDateIST(new Date(d.collected_at)), d.amount || 0, d.payment_mode || "",
      d.returned_at ? fmtDateIST(new Date(d.returned_at)) : "", d.return_amount || "", d.return_mode || "",
      d.receipt_no || "",
    ]);
    const csv = [headers, ...data].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hosteldesk-deposits-${reportYear}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ background: "#fff", borderRadius: 14, padding: 16, marginBottom: 14, boxShadow: "0 1px 4px #0001" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", gap: 20 }}>
          <div>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>COLLECTED IN {reportYear}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#1d4ed8" }}>₹{yearCollected.toLocaleString("en-IN")}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>RETURNED IN {reportYear}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#475569" }}>₹{yearReturned.toLocaleString("en-IN")}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={exportCSV} style={{ padding: "8px 14px", borderRadius: 8, border: "1.5px solid #86efac", background: "#f0fdf4", color: "#15803d", fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}>⬇️ Export CSV</button>
          <select value={reportYear} onChange={e => setReportYear(Number(e.target.value))} style={{ padding: "8px 12px", borderRadius: 8, border: "1.5px solid #e2e8f0", fontWeight: 700, fontSize: 14 }}>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>
      <div style={{ display: "flex", gap: 14, fontSize: 11, color: "#94a3b8", marginBottom: 8 }}>
        <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "#1d4ed8", marginRight: 4 }} />Collected</span>
        <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "#94a3b8", marginRight: 4 }} />Returned</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {monthly.map(m => (
          <div key={m.name}>
            <div onClick={() => m.transactions.length > 0 && setExpandedMonth(x => x === m.monthIndex ? null : m.monthIndex)}
              style={{ display: "flex", alignItems: "center", gap: 10, cursor: m.transactions.length > 0 ? "pointer" : "default", padding: "4px 6px", borderRadius: 8, background: expandedMonth === m.monthIndex ? "#f8fafc" : "transparent" }}>
              <div style={{ width: 32, fontSize: 12, fontWeight: 700, color: "#64748b" }}>{m.name}</div>
              <div style={{ flex: 1 }}>
                <div style={{ background: "#eff6ff", borderRadius: 4, height: 9, marginBottom: 2, overflow: "hidden" }}>
                  <div style={{ width: `${(m.collectedTotal / maxVal) * 100}%`, background: "#1d4ed8", height: "100%" }} />
                </div>
                <div style={{ background: "#f1f5f9", borderRadius: 4, height: 9, overflow: "hidden" }}>
                  <div style={{ width: `${(m.returnedTotal / maxVal) * 100}%`, background: "#94a3b8", height: "100%" }} />
                </div>
              </div>
              <div style={{ width: 85, textAlign: "right", fontSize: 11.5, fontWeight: 700, color: "#1a2332" }}>₹{m.collectedTotal.toLocaleString("en-IN")}</div>
              <div style={{ width: 14, textAlign: "center", fontSize: 10, color: "#94a3b8" }}>{m.transactions.length > 0 ? (expandedMonth === m.monthIndex ? "▲" : "▼") : ""}</div>
            </div>
            {expandedMonth === m.monthIndex && (
              <div style={{ margin: "6px 4px 10px", background: "#f8fafc", borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                {m.transactions.map((tx, idx) => (
                  <div key={tx.id + "-" + tx.txType + "-" + idx} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#fff", borderRadius: 8, padding: "8px 10px", boxShadow: "0 1px 2px #0001" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#1a2332" }}>
                        {tx.tenant_name} <span style={{ fontSize: 10, fontWeight: 700, color: tx.txType === "collected" ? "#1d4ed8" : "#64748b", background: tx.txType === "collected" ? "#eff6ff" : "#f1f5f9", padding: "1px 6px", borderRadius: 99, marginLeft: 4 }}>{tx.txType === "collected" ? "Collected" : "Returned"}</span>
                      </div>
                      <div style={{ fontSize: 11, color: "#94a3b8" }}>
                        {FLOOR_LABELS[tx.floor] || "Floor " + tx.floor} · Room {tx.room_number} · {fmtDateIST(new Date(tx.txDate), { day: "numeric", month: "short" })} · {tx.txType === "collected" ? tx.payment_mode : tx.return_mode}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: tx.txType === "collected" ? "#1d4ed8" : "#475569" }}>₹{Number(tx.txAmount || 0).toLocaleString("en-IN")}</div>
                      <button onClick={() => reprintTx(tx)} style={{ padding: "5px 10px", borderRadius: 7, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 700, fontSize: 11, cursor: "pointer" }}>🧾</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function DepositsPage({ rooms, setRooms, today }) {
  const [depositsLog, setDepositsLog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("pending");
  const [depositSearch, setDepositSearch] = useState("");
  const [busyKey, setBusyKey] = useState(null);

  const [collectModal, setCollectModal] = useState(null); // tenant
  const [collectNote, setCollectNote] = useState("");
  const [collectMode, setCollectMode] = useState("Cash");
  const [collectModeOther, setCollectModeOther] = useState("");

  const [returnModal, setReturnModal] = useState(null); // ledger row
  const [undoConfirm, setUndoConfirm] = useState(null); // { type: 'collect'|'return', row }
  const [returnAmount, setReturnAmount] = useState("");
  const [returnMode, setReturnMode] = useState("Cash");
  const [returnModeOther, setReturnModeOther] = useState("");
  const [returnNote, setReturnNote] = useState("");
  const [showDepositReports, setShowDepositReports] = useState(false);
  const [showReturnHistory, setShowReturnHistory] = useState(false);
  const [historySearch, setHistorySearch] = useState("");

  useEffect(() => {
    setLoading(true);
    loadDeposits().then(rows => { setDepositsLog(rows); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  function refreshLog() {
    loadDeposits().then(rows => setDepositsLog(rows));
  }

  function tKey(t) { return `${t.floor}-${t.roomNumber}-${t.bed}`; }

  async function collectDeposit(t, mode, note = "") {
    const key = tKey(t);
    setBusyKey(key);
    try {
      const nowIso = new Date().toISOString();
      const receiptNo = generateReceiptNo(nowIso, "SD");
      const amount = Number(t.depositAmount) || 0;
      await createDepositRecord({
        receipt_no: receiptNo,
        tenant_name: t.name,
        phone: t.phone || "",
        floor: t.floor,
        room_number: t.roomNumber,
        amount,
        payment_mode: mode,
        collected_at: nowIso,
        collect_note: note || null,
      });
      if (t.dbId) {
        try {
          await sbFetch(`/tenants?id=eq.${t.dbId}`, "PATCH", { deposit_paid_on: nowIso, deposit_payment_mode: mode, deposit_receipt_no: receiptNo, deposit_note: note || null }, { "Prefer": "return=minimal" });
        } catch (e) { console.warn("Could not sync tenant record:", e); }
      }
      setRooms(prev => {
        const roomId = `${t.floor}-${t.roomNumber}`;
        const room = prev[roomId];
        if (!room) return prev;
        const bedIndex = t.bed - 1;
        const newTenants = room.tenants.map((tn, bi) => bi === bedIndex ? { ...tn, depositPaidOn: nowIso, depositPaymentMode: mode, depositReceiptNo: receiptNo, depositNote: note } : tn);
        return { ...prev, [roomId]: { ...room, tenants: newTenants } };
      });
      refreshLog();
      generateReceiptPDF({
        name: t.name, phone: t.phone, floorLabel: FLOOR_LABELS[t.floor] || "Floor " + t.floor,
        roomNumber: t.roomNumber, paidDate: new Date(nowIso), amount, mode, receiptNo,
        cycleNote: "Security Deposit", note, docTitle: "Security Deposit Receipt", amountLabel: "DEPOSIT COLLECTED", fileTag: "deposit",
      });
    } catch (e) {
      console.error(e);
      alert("Failed to record the deposit. Please check your internet connection.");
    }
    setBusyKey(null);
  }

  async function confirmReturn(row, amount, mode, note) {
    setBusyKey(row.id);
    try {
      const nowIso = new Date().toISOString();
      const receiptNo = generateReceiptNo(nowIso, "SDR");
      await updateDepositRecord(row.id, {
        returned_at: nowIso, return_amount: amount, return_mode: mode,
        return_receipt_no: receiptNo, return_note: note || null,
      });
      // Sync the tenant's own record if they're still active in a room
      setRooms(prev => {
        let changed = false;
        const next = { ...prev };
        Object.keys(next).forEach(roomId => {
          const room = next[roomId];
          const idx = room.tenants.findIndex(tn => tn.depositReceiptNo === row.receipt_no);
          if (idx !== -1) {
            const matchedTenant = room.tenants[idx];
            const newTenants = room.tenants.map((tn, i) => i === idx ? { ...tn, depositReturnedOn: nowIso, depositReturnAmount: amount } : tn);
            next[roomId] = { ...room, tenants: newTenants };
            changed = true;
            if (matchedTenant.dbId) {
              sbFetch(`/tenants?id=eq.${matchedTenant.dbId}`, "PATCH", { deposit_returned_on: nowIso, deposit_return_amount: amount }, { "Prefer": "return=minimal" }).catch(() => {});
            }
          }
        });
        return changed ? next : prev;
      });
      refreshLog();
      generateReceiptPDF({
        name: row.tenant_name, phone: row.phone, floorLabel: FLOOR_LABELS[row.floor] || "Floor " + row.floor,
        roomNumber: row.room_number, paidDate: new Date(nowIso), amount, mode, receiptNo,
        cycleNote: "Security Deposit Return", note, docTitle: "Deposit Return Receipt", amountLabel: "AMOUNT RETURNED", fileTag: "deposit_return",
      });
    } catch (e) {
      console.error(e);
      alert("Failed to record the return. Please check your internet connection.");
    }
    setBusyKey(null);
  }

  function reprintCollected(row) {
    generateReceiptPDF({
      name: row.tenant_name, phone: row.phone, floorLabel: FLOOR_LABELS[row.floor] || "Floor " + row.floor,
      roomNumber: row.room_number, paidDate: new Date(row.collected_at), amount: row.amount, mode: row.payment_mode,
      receiptNo: row.receipt_no, cycleNote: "Security Deposit", note: row.collect_note || "", docTitle: "Security Deposit Receipt", amountLabel: "DEPOSIT COLLECTED", fileTag: "deposit",
    });
  }

  function reprintReturned(row) {
    generateReceiptPDF({
      name: row.tenant_name, phone: row.phone, floorLabel: FLOOR_LABELS[row.floor] || "Floor " + row.floor,
      roomNumber: row.room_number, paidDate: new Date(row.returned_at), amount: row.return_amount, mode: row.return_mode,
      receiptNo: row.return_receipt_no, cycleNote: "Security Deposit Return", note: row.return_note || "", docTitle: "Deposit Return Receipt", amountLabel: "AMOUNT RETURNED", fileTag: "deposit_return",
    });
  }

  // Clears the given deposit fields on whichever active tenant matches this
  // receipt number (best-effort — no-op if the tenant has since been
  // cleared/archived, since the ledger row is the real source of truth).
  function clearTenantDepositFields(receiptNo, dbFields, localFields) {
    setRooms(prev => {
      let changed = false;
      const next = { ...prev };
      Object.keys(next).forEach(roomId => {
        const room = next[roomId];
        const idx = room.tenants.findIndex(tn => tn.depositReceiptNo === receiptNo);
        if (idx !== -1) {
          const matchedTenant = room.tenants[idx];
          const newTenants = room.tenants.map((tn, i) => i === idx ? { ...tn, ...localFields } : tn);
          next[roomId] = { ...room, tenants: newTenants };
          changed = true;
          if (matchedTenant.dbId) {
            sbFetch(`/tenants?id=eq.${matchedTenant.dbId}`, "PATCH", dbFields, { "Prefer": "return=minimal" }).catch(() => {});
          }
        }
      });
      return changed ? next : prev;
    });
  }

  // Undo a mistaken "Mark Collected" — removes the ledger row entirely and
  // resets the tenant back to "Pending Collection".
  async function undoCollect(row) {
    setBusyKey(row.id);
    try {
      await sbFetch(`/security_deposits?id=eq.${row.id}`, "DELETE", null, { "Prefer": "return=minimal" });
      clearTenantDepositFields(
        row.receipt_no,
        { deposit_paid_on: null, deposit_payment_mode: null, deposit_receipt_no: null },
        { depositPaidOn: "", depositPaymentMode: "", depositReceiptNo: "" }
      );
      setDepositsLog(prev => prev ? prev.filter(d => d.id !== row.id) : prev);
    } catch (e) {
      console.error(e);
      alert("Failed to undo. Please check your internet connection.");
    }
    setBusyKey(null);
  }

  // Undo a mistaken "Mark Returned" — reverts the ledger row back to Held,
  // keeping the original collection intact.
  async function undoReturn(row) {
    setBusyKey(row.id);
    try {
      await updateDepositRecord(row.id, { returned_at: null, return_amount: null, return_mode: null, return_receipt_no: null, return_note: null });
      clearTenantDepositFields(
        row.receipt_no,
        { deposit_returned_on: null, deposit_return_amount: null },
        { depositReturnedOn: "", depositReturnAmount: "" }
      );
      refreshLog();
    } catch (e) {
      console.error(e);
      alert("Failed to undo. Please check your internet connection.");
    }
    setBusyKey(null);
  }

  const tenants = getAllTenants(rooms);
  const term = depositSearch.trim().toLowerCase();
  const matchesTerm = (name, phone) => term.length === 0 || (name || "").toLowerCase().includes(term) || (phone || "").includes(depositSearch.trim());
  const activeReceiptNos = new Set(tenants.map(t => t.depositReceiptNo).filter(Boolean));

  const pending = tenants.filter(t => Number(t.depositAmount) > 0 && !t.depositPaidOn && matchesTerm(t.name, t.phone));
  const held = (depositsLog || []).filter(d => !d.returned_at && matchesTerm(d.tenant_name, d.phone))
    .map(d => ({ ...d, tenantHasLeft: !activeReceiptNos.has(d.receipt_no) }))
    .sort((a, b) => (b.tenantHasLeft - a.tenantHasLeft) || (new Date(b.collected_at) - new Date(a.collected_at)));
  const allReturned = (depositsLog || []).filter(d => d.returned_at);
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  // If actively searching, show every match regardless of age — the 30-day
  // window is just a default declutter, not a real limit on what's findable.
  const returned = term.length > 0
    ? allReturned.filter(d => matchesTerm(d.tenant_name, d.phone)).sort((a, b) => new Date(b.returned_at) - new Date(a.returned_at))
    : allReturned.filter(d => new Date(d.returned_at) >= thirtyDaysAgo);

  const totalHeld = held.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const totalReturned = allReturned.reduce((s, d) => s + (Number(d.return_amount) || 0), 0);
  const totalEverCollected = (depositsLog || []).reduce((s, d) => s + (Number(d.amount) || 0), 0);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "16px 12px 90px" }}>
      <div style={{ marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 3px" }}>🔒 Security Deposits</h1>
          <p style={{ margin: 0, color: "#64748b", fontSize: 13 }}>Separate from rent — tracked and reported independently</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setShowReturnHistory(true)} style={{ padding: "9px 14px", borderRadius: 10, border: "1.5px solid #e2e8f0", background: "#fff", color: "#475569", fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}>
            📜 Full History
          </button>
          <button onClick={() => setShowDepositReports(s => !s)} style={{ padding: "9px 14px", borderRadius: 10, border: "1.5px solid " + (showDepositReports ? "#1a2332" : "#e2e8f0"), background: showDepositReports ? "#1a2332" : "#fff", color: showDepositReports ? "#fff" : "#475569", fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}>
            📊 Reports
          </button>
        </div>
      </div>

      {showDepositReports && (
        <DepositReportsPanel depositsLog={depositsLog} loading={loading} />
      )}

      {/* Money bar */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <div style={{ background: "#eff6ff", borderRadius: 12, padding: "12px 16px", border: "1.5px solid #93c5fd" }}>
          <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>HELD NOW</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#1d4ed8" }}>₹{totalHeld.toLocaleString("en-IN")}</div>
          <div style={{ fontSize: 11, color: "#94a3b8" }}>{held.length} deposit{held.length !== 1 ? "s" : ""}</div>
        </div>
        <div style={{ background: "#f8fafc", borderRadius: 12, padding: "12px 16px", border: "1.5px solid #e2e8f0" }}>
          <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>RETURNED (all time)</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#475569" }}>₹{totalReturned.toLocaleString("en-IN")}</div>
          <div style={{ fontSize: 11, color: "#94a3b8" }}>{returned.length} tenant{returned.length !== 1 ? "s" : ""}</div>
        </div>
      </div>
      <div style={{ background: "#f0fdf4", borderRadius: 12, padding: "10px 16px", border: "1.5px solid #86efac", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>EVER COLLECTED (all time)</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: "#15803d" }}>₹{totalEverCollected.toLocaleString("en-IN")}</div>
      </div>

      {/* Search */}
      <div style={{ position: "relative", marginBottom: 12 }}>
        <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontSize: 16 }}>🔍</span>
        <input
          value={depositSearch}
          onChange={e => setDepositSearch(e.target.value)}
          placeholder="Search by name or phone…"
          style={{ ...inputStyle, paddingLeft: 40, fontSize: 14, padding: "10px 14px 10px 40px", borderRadius: 10, border: "1.5px solid #e2e8f0", boxSizing: "border-box" }}
        />
        {depositSearch && (
          <button onClick={() => setDepositSearch("")} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "#e2e8f0", border: "none", borderRadius: "50%", width: 22, height: 22, cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        )}
      </div>

      {/* Filter chips */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[
          { id: "pending", label: "Pending Collection", count: pending.length, color: "#b45309" },
          { id: "held", label: "Held", count: held.length, color: "#1d4ed8" },
          { id: "returned", label: "Returned", count: returned.length, color: "#64748b" },
        ].map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            flex: 1, padding: "10px 4px", borderRadius: 10, cursor: "pointer", fontSize: 12, fontWeight: 700,
            border: `1.5px solid ${filter === f.id ? f.color : "#e2e8f0"}`,
            background: filter === f.id ? f.color : "#fff",
            color: filter === f.id ? "#fff" : "#64748b",
          }}>{f.label} ({f.count})</button>
        ))}
      </div>

      {loading && <div style={{ textAlign: "center", color: "#94a3b8", padding: 30 }}>Loading…</div>}

      {!loading && filter === "pending" && (
        pending.length === 0 ? (
          <div style={{ background: "#fff", borderRadius: 12, padding: 30, textAlign: "center", color: "#94a3b8" }}>{term ? `No pending deposits match "${depositSearch}".` : "No deposits pending collection. Set a deposit amount on a tenant's card in Rooms to see them here."}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pending.map((t, i) => {
              const key = tKey(t);
              const isBusy = busyKey === key;
              return (
                <div key={i} style={{ background: "#fff", border: "1.5px solid #fcd34d", borderLeft: "4px solid #f59e0b", borderRadius: 12, padding: "12px 14px", display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{t.name}</div>
                    <div style={{ fontSize: 12, color: "#64748b" }}>Floor {t.floor} · Room {t.roomNumber} · Bed {t.bed}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#b45309", marginTop: 2 }}>₹{Number(t.depositAmount).toLocaleString("en-IN")}</div>
                  </div>
                  <button disabled={isBusy} onClick={() => { setCollectMode("Cash"); setCollectModeOther(""); setCollectNote(""); setCollectModal(t); }} style={{ padding: "8px 14px", borderRadius: 10, border: "none", background: "#22c55e", color: "#fff", fontWeight: 700, fontSize: 13, cursor: isBusy ? "default" : "pointer", opacity: isBusy ? 0.6 : 1, whiteSpace: "nowrap" }}>
                    ✅ Mark Collected
                  </button>
                </div>
              );
            })}
          </div>
        )
      )}

      {!loading && filter === "held" && (
        held.length === 0 ? (
          <div style={{ background: "#fff", borderRadius: 12, padding: 30, textAlign: "center", color: "#94a3b8" }}>{term ? `No held deposits match "${depositSearch}".` : "No deposits currently held."}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {held.map(row => {
              const isBusy = busyKey === row.id;
              return (
                <div key={row.id} style={{ background: "#fff", border: "1.5px solid " + (row.tenantHasLeft ? "#fca5a5" : "#93c5fd"), borderLeft: "4px solid " + (row.tenantHasLeft ? "#dc2626" : "#1d4ed8"), borderRadius: 12, padding: "12px 14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>{row.tenant_name}</div>
                      <div style={{ fontSize: 12, color: "#64748b" }}>Floor {row.floor} · Room {row.room_number}</div>
                      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>Collected {fmtDateIST(new Date(row.collected_at), { day: "2-digit", month: "short", year: "numeric" })} · {row.payment_mode}</div>
                      {row.tenantHasLeft && (
                        <div style={{ fontSize: 11, color: "#dc2626", fontWeight: 700, marginTop: 4 }}>⚠️ Tenant has checked out — deposit still owed</div>
                      )}
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: "#1d4ed8" }}>₹{Number(row.amount).toLocaleString("en-IN")}</div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => reprintCollected(row)} style={{ flex: 1, padding: "8px 0", borderRadius: 10, border: "1.5px solid #93c5fd", background: "#eff6ff", color: "#1d4ed8", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>🧾 Receipt</button>
                    <button disabled={isBusy} onClick={() => { setReturnAmount(String(row.amount)); setReturnMode("Cash"); setReturnModeOther(""); setReturnNote(""); setReturnModal(row); }} style={{ flex: 1, padding: "8px 0", borderRadius: 10, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 700, fontSize: 12, cursor: isBusy ? "default" : "pointer", opacity: isBusy ? 0.6 : 1 }}>↩️ Mark Returned</button>
                  </div>
                  <button disabled={isBusy} onClick={() => setUndoConfirm({ type: "collect", row })} style={{ width: "100%", marginTop: 8, padding: "7px 0", borderRadius: 10, border: "1.5px solid #fca5a5", background: "#fff", color: "#ef4444", fontWeight: 600, fontSize: 11.5, cursor: isBusy ? "default" : "pointer", opacity: isBusy ? 0.6 : 1 }}>Undo Collect</button>
                </div>
              );
            })}
          </div>
        )
      )}

      {!loading && filter === "returned" && (
        <>
        <div style={{ fontSize: 11.5, color: "#94a3b8", marginBottom: 10 }}>Showing returns from the last 30 days — search above to find any past return, or use "Full History" at the top</div>
        {returned.length === 0 ? (
          <div style={{ background: "#fff", borderRadius: 12, padding: 30, textAlign: "center", color: "#94a3b8" }}>{term ? `No returned deposits match "${depositSearch}" in the last 30 days.` : "No deposits returned in the last 30 days. Older returns are still saved — check Full History."}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {returned.map(row => (
              <div key={row.id} style={{ background: "#fff", border: "1.5px solid #e2e8f0", borderLeft: "4px solid #94a3b8", borderRadius: 12, padding: "12px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{row.tenant_name}</div>
                    <div style={{ fontSize: 12, color: "#64748b" }}>Floor {row.floor} · Room {row.room_number}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>Collected ₹{Number(row.amount).toLocaleString("en-IN")} on {fmtDateIST(new Date(row.collected_at), { day: "2-digit", month: "short", year: "numeric" })}</div>
                    <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>Returned {fmtDateIST(new Date(row.returned_at), { day: "2-digit", month: "short", year: "numeric" })} · {row.return_mode}{row.return_note ? ` · ${row.return_note}` : ""}</div>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#475569" }}>₹{Number(row.return_amount).toLocaleString("en-IN")}</div>
                </div>
                <button onClick={() => reprintReturned(row)} style={{ width: "100%", padding: "8px 0", borderRadius: 10, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>🧾 Return Receipt</button>
                <button disabled={busyKey === row.id} onClick={() => setUndoConfirm({ type: "return", row })} style={{ width: "100%", marginTop: 8, padding: "7px 0", borderRadius: 10, border: "1.5px solid #fca5a5", background: "#fff", color: "#ef4444", fontWeight: 600, fontSize: 11.5, cursor: busyKey === row.id ? "default" : "pointer", opacity: busyKey === row.id ? 0.6 : 1 }}>Undo Return</button>
              </div>
            ))}
          </div>
        )}
        </>
      )}

      {/* Collect confirmation modal */}
      {collectModal && (
        <div onClick={() => setCollectModal(null)} style={{ position: "fixed", inset: 0, background: "#0009", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 200 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: "22px 22px 0 0", padding: "20px 24px 36px", width: "100%", maxWidth: 440, boxShadow: "0 -8px 40px #0004" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}><div style={{ width: 40, height: 4, borderRadius: 99, background: "#e2e8f0" }} /></div>
            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <div style={{ fontSize: 52, marginBottom: 10 }}>🔒</div>
              <div style={{ fontWeight: 800, fontSize: 20, color: "#1a2332" }}>Confirm Deposit Received</div>
              <div style={{ fontSize: 14, color: "#64748b", marginTop: 8 }}>Did you receive the security deposit from</div>
              <div style={{ fontWeight: 800, fontSize: 20, color: "#1a2332", marginTop: 4 }}>{collectModal.name}?</div>
              <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>Floor {collectModal.floor} · Room {collectModal.roomNumber} · Bed {collectModal.bed}</div>
              <div style={{ marginTop: 14, display: "inline-block", background: "#eff6ff", color: "#1d4ed8", fontWeight: 800, fontSize: 28, padding: "10px 28px", borderRadius: 14, border: "2.5px solid #93c5fd" }}>
                ₹{Number(collectModal.depositAmount).toLocaleString("en-IN")}
              </div>
            </div>
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 8, textAlign: "center" }}>Mode of Payment</div>
              <PaymentModeSelector mode={collectMode} setMode={setCollectMode} otherText={collectModeOther} setOtherText={setCollectModeOther} />
            </div>
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 6 }}>Notes (optional — printed on the receipt)</div>
              <input
                value={collectNote}
                onChange={e => setCollectNote(e.target.value)}
                placeholder="e.g. partial deposit, will collect balance later…"
                style={{ width: "100%", padding: "9px 12px", borderRadius: 9, border: "1.5px solid #e2e8f0", fontSize: 13, boxSizing: "border-box" }}
              />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setCollectModal(null)} style={{ flex: 1, padding: "14px 0", borderRadius: 12, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>Cancel</button>
              <button onClick={async () => {
                const t = collectModal;
                const mode = collectMode === "Other" ? collectModeOther.trim() : collectMode;
                const note = collectNote.trim();
                setCollectModal(null);
                await collectDeposit(t, mode, note);
              }} style={{ flex: 2, padding: "14px 0", borderRadius: 12, border: "none", background: "#22c55e", color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer" }}>✅ Yes, Received!</button>
            </div>
          </div>
        </div>
      )}

      {/* Return modal */}
      {returnModal && (
        <div onClick={() => setReturnModal(null)} style={{ position: "fixed", inset: 0, background: "#0009", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 200 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: "22px 22px 0 0", padding: "20px 24px 36px", width: "100%", maxWidth: 440, boxShadow: "0 -8px 40px #0004" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}><div style={{ width: 40, height: 4, borderRadius: 99, background: "#e2e8f0" }} /></div>
            <div style={{ textAlign: "center", marginBottom: 18 }}>
              <div style={{ fontSize: 52, marginBottom: 10 }}>↩️</div>
              <div style={{ fontWeight: 800, fontSize: 20, color: "#1a2332" }}>Return Deposit</div>
              <div style={{ fontSize: 14, color: "#64748b", marginTop: 8 }}>For</div>
              <div style={{ fontWeight: 800, fontSize: 20, color: "#1a2332", marginTop: 4 }}>{returnModal.tenant_name}</div>
              <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>Floor {returnModal.floor} · Room {returnModal.room_number} · Collected ₹{Number(returnModal.amount).toLocaleString("en-IN")}</div>
            </div>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#64748b", display: "block", marginBottom: 5 }}>AMOUNT TO RETURN</label>
            <div style={{ position: "relative", marginBottom: 14 }}>
              <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: "#64748b", fontWeight: 700 }}>₹</span>
              <input type="number" min="0" value={returnAmount} onChange={e => setReturnAmount(e.target.value)} style={{ ...inputStyle, paddingLeft: 26 }} />
            </div>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#64748b", display: "block", marginBottom: 5 }}>NOTE (optional — e.g. deduction reason)</label>
            <input value={returnNote} onChange={e => setReturnNote(e.target.value)} placeholder="e.g. ₹500 deducted for damage" style={{ ...inputStyle, marginBottom: 18 }} />
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 8, textAlign: "center" }}>Mode of Return</div>
              <PaymentModeSelector mode={returnMode} setMode={setReturnMode} otherText={returnModeOther} setOtherText={setReturnModeOther} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setReturnModal(null)} style={{ flex: 1, padding: "14px 0", borderRadius: 12, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>Cancel</button>
              <button onClick={async () => {
                const row = returnModal;
                const mode = returnMode === "Other" ? returnModeOther.trim() : returnMode;
                const amt = Number(returnAmount) || 0;
                setReturnModal(null);
                await confirmReturn(row, amt, mode, returnNote.trim());
              }} style={{ flex: 2, padding: "14px 0", borderRadius: 12, border: "none", background: "#1d4ed8", color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer" }}>↩️ Confirm Return</button>
            </div>
          </div>
        </div>
      )}

      {/* Undo confirmation — Undo Collect deletes the record permanently,
          Undo Return reverts it back to Held. Both need a deliberate
          confirm since a tap here can't be casually reversed. */}
      {undoConfirm && (
        <div onClick={() => setUndoConfirm(null)} style={{ position: "fixed", inset: 0, background: "#0009", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 200 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: "22px 22px 0 0", padding: "20px 24px 36px", width: "100%", maxWidth: 440, boxShadow: "0 -8px 40px #0004" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}><div style={{ width: 40, height: 4, borderRadius: 99, background: "#e2e8f0" }} /></div>
            <div style={{ textAlign: "center", marginBottom: 22 }}>
              <div style={{ fontSize: 44, marginBottom: 10 }}>⚠️</div>
              <div style={{ fontWeight: 800, fontSize: 19, color: "#1a2332" }}>
                {undoConfirm.type === "collect" ? "Undo Deposit Collection?" : "Undo Deposit Return?"}
              </div>
              <div style={{ fontSize: 14, color: "#64748b", marginTop: 10, lineHeight: 1.5 }}>
                {undoConfirm.type === "collect"
                  ? <>This will <b>permanently delete</b> the deposit record for <b>{undoConfirm.row.tenant_name}</b> (₹{Number(undoConfirm.row.amount).toLocaleString("en-IN")}) and move them back to Pending Collection. This can't be undone — you'd need to collect it again from scratch.</>
                  : <>This will move <b>{undoConfirm.row.tenant_name}</b>'s deposit (₹{Number(undoConfirm.row.return_amount).toLocaleString("en-IN")} returned) back to <b>Held</b>. Use this only if the return was recorded by mistake.</>
                }
              </div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setUndoConfirm(null)} style={{ flex: 1, padding: "14px 0", borderRadius: 12, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>Cancel</button>
              <button onClick={async () => {
                const { type, row } = undoConfirm;
                setUndoConfirm(null);
                if (type === "collect") await undoCollect(row);
                else await undoReturn(row);
              }} style={{ flex: 2, padding: "14px 0", borderRadius: 12, border: "none", background: "#ef4444", color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer" }}>
                {undoConfirm.type === "collect" ? "Yes, Delete & Undo" : "Yes, Move Back to Held"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full return history — unfiltered by the 30-day window, search + reprint any receipt ever */}
      {showReturnHistory && (() => {
        const q = historySearch.trim().toLowerCase();
        const rows = allReturned
          .filter(d => q.length === 0 || (d.tenant_name || "").toLowerCase().includes(q) || (d.phone || "").includes(historySearch.trim()))
          .sort((a, b) => new Date(b.returned_at) - new Date(a.returned_at));
        return (
          <div onClick={() => setShowReturnHistory(false)} style={{ position: "fixed", inset: 0, background: "#0009", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300, padding: 16 }}>
            <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, padding: 20, width: "100%", maxWidth: 480, maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontWeight: 800, fontSize: 18 }}>📜 Full Return History</div>
                <button onClick={() => setShowReturnHistory(false)} style={{ background: "#f1f5f9", border: "none", borderRadius: "50%", width: 28, height: 28, cursor: "pointer", fontSize: 14 }}>✕</button>
              </div>
              <input
                placeholder="Search by name or phone…"
                value={historySearch}
                onChange={e => setHistorySearch(e.target.value)}
                style={{ padding: "9px 12px", borderRadius: 9, border: "1.5px solid #e2e8f0", fontSize: 14, marginBottom: 12, boxSizing: "border-box" }}
              />
              <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
                {rows.length === 0 ? (
                  <div style={{ textAlign: "center", color: "#94a3b8", padding: 20 }}>No returned deposits {q ? `match "${historySearch}"` : "yet"}.</div>
                ) : rows.map(row => (
                  <div key={row.id} style={{ background: "#f8fafc", borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>{row.tenant_name}</div>
                        <div style={{ fontSize: 11, color: "#94a3b8" }}>Floor {row.floor} · Room {row.room_number} · Returned {fmtDateIST(new Date(row.returned_at), { day: "2-digit", month: "short", year: "numeric" })}</div>
                      </div>
                      <div style={{ fontWeight: 800, fontSize: 14, color: "#475569" }}>₹{Number(row.return_amount).toLocaleString("en-IN")}</div>
                    </div>
                    <button onClick={() => reprintReturned(row)} style={{ width: "100%", marginTop: 8, padding: "7px 0", borderRadius: 8, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>🧾 Download Receipt</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── ROOMS PAGE ────────────────────────────────────────────────
function RoomsPage({ rooms, setRooms, activeFloor, setActiveFloor, onSaveRoom, isManager = true, initialStatusFilter = "all" }) {
  const [editingRoom, setEditingRoom] = useState(null);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState(initialStatusFilter);
  const [editForm, setEditForm] = useState(null);
  const [addingRoom, setAddingRoom] = useState(false);
  const [newRoomBeds, setNewRoomBeds] = useState(2);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [confirmDeleteRoom, setConfirmDeleteRoom] = useState(null);
  const [deletingRoom, setDeletingRoom] = useState(false);

  const floorRooms = Object.values(rooms).filter(r => r.floor === activeFloor).sort((a, b) => a.number - b.number);
  const filtered = floorRooms.filter(r => {
    const matchSearch = !search || String(r.number).includes(search) || r.label.toLowerCase().includes(search.toLowerCase()) || r.tenants.some(t => t.name.toLowerCase().includes(search.toLowerCase()) || (t.phone || "").includes(search));
    return matchSearch && (filterStatus === "all" || getRoomStatus(r) === filterStatus);
  });
  const stats = {
    total: floorRooms.reduce((s, r) => s + r.beds, 0),
    occupied: floorRooms.reduce((s, r) => s + getOccupied(r), 0),
    full: floorRooms.filter(r => getRoomStatus(r) === "full").length,
    partial: floorRooms.filter(r => getRoomStatus(r) === "partial").length,
    empty: floorRooms.filter(r => getRoomStatus(r) === "empty").length,
  };

  function openEdit(room) {
    setEditingRoom(room);
    setEditForm({ label: room.label, beds: room.beds, tenants: room.tenants.map(t => ({ ...t })) });
  }
  function changeBedsInForm(n) {
    n = Math.max(1, Math.min(20, n));
    setEditForm(f => ({ ...f, beds: n, tenants: makeBeds(n, f.tenants) }));
  }
  function updateTenant(i, field, value) {
    setEditForm(f => ({ ...f, tenants: f.tenants.map((t, idx) => idx === i ? { ...t, [field]: value } : t) }));
  }
  function clearTenant(i) {
    setEditForm(f => ({ ...f, tenants: f.tenants.map((t, idx) => idx === i ? { name: "", admissionDate: "", phone: "", billingType: "monthly", checkoutDate: "", aadharId: "", fatherName: "", fatherPhone: "", guardianName: "", guardianPhone: "", address: "", city: "", occupation: "", occupationPlace: "", occupationId: "", reasonToStay: "", rentAmount: "" } : t) }));
  }
  // Builds a map of bed-index -> problem message for the phone field currently
  // in the edit form: invalid format (not a real 10-digit mobile number),
  // or a duplicate of another tenant's phone (either another bed in this same
  // room, or a tenant already living in a different room).
  function getPhoneIssues() {
    const byBed = {};
    if (!editForm) return byBed;
    const thisId = editingRoom ? `${editingRoom.floor}-${editingRoom.number}` : null;

    // Phones already in use by tenants in OTHER rooms
    const otherPhones = new Map();
    Object.values(rooms).forEach(r => {
      const rid = `${r.floor}-${r.number}`;
      if (rid === thisId) return;
      (r.tenants || []).forEach(t => {
        if (!t.name || !t.phone) return;
        const norm = normalizePhone10(t.phone);
        if (norm && !otherPhones.has(norm)) {
          otherPhones.set(norm, `${t.name} (${FLOOR_LABELS[r.floor] || "Floor " + r.floor}, Room ${r.number})`);
        }
      });
    });

    const seenInThisForm = new Map();
    editForm.tenants.forEach((t, i) => {
      if (!t.name || t.name.trim() === "") return;
      const raw = (t.phone || "").trim();
      if (!raw) return;
      const norm = normalizePhone10(raw);
      if (!norm) { byBed[i] = "Not a valid 10-digit phone number"; return; }
      if (otherPhones.has(norm)) { byBed[i] = `Already used by ${otherPhones.get(norm)}`; return; }
      if (seenInThisForm.has(norm)) { byBed[i] = `Same number as Bed ${seenInThisForm.get(norm) + 1} in this room`; return; }
      seenInThisForm.set(norm, i);
    });
    return byBed;
  }

  function saveEdit() {
    const phoneIssues = getPhoneIssues();
    if (Object.keys(phoneIssues).length > 0) return; // blocked — Save button is disabled in this state too
    const beds = Math.max(1, Math.min(20, editForm.beds));
    const updated = { ...editingRoom, beds, label: editForm.label, tenants: makeBeds(beds, editForm.tenants) };
    onSaveRoom(updated);
    setEditingRoom(null);
  }

  async function handleDeleteRoom(room) {
    const id = `${room.floor}-${room.number}`;
    setDeletingRoom(true);
    try {
      await sbFetch(`/rooms?id=eq.${id}`, "DELETE", null, { "Prefer": "return=minimal" });
      setRooms(prev => { const n = { ...prev }; delete n[id]; return n; });
      setConfirmDeleteRoom(null);
      setEditingRoom(null);
    } catch (e) {
      console.error(e);
      alert("Failed to delete room. Please check your connection and try again.");
    }
    setDeletingRoom(false);
  }

  async function handleAddRoom() {
    const beds = Math.max(1, Math.min(20, Number(newRoomBeds) || 2));
    const nextNumber = floorRooms.length > 0 ? Math.max(...floorRooms.map(r => r.number)) + 1 : 1;
    setCreatingRoom(true);
    try {
      await createRoom(activeFloor, nextNumber, beds, "");
      const id = `${activeFloor}-${nextNumber}`;
      setRooms(prev => ({ ...prev, [id]: { floor: activeFloor, number: nextNumber, beds, label: "", tenants: makeBeds(beds) } }));
      setAddingRoom(false);
      setNewRoomBeds(2);
    } catch (e) {
      console.error(e);
      alert("Failed to create room. Please check your connection and try again.");
    }
    setCreatingRoom(false);
  }

  const phoneIssues = getPhoneIssues();

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "16px 12px 90px" }}>
      <div style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 3px" }}>Rooms</h1>
        <p style={{ margin: 0, color: "#64748b", fontSize: 14 }}>Click any room to manage beds, tenants && details</p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 8, marginBottom: 14 }}>
        {FLOORS.map(f => (
          <button key={f} onClick={() => setActiveFloor(f)} style={{
            padding: "12px 8px", borderRadius: 12, border: "none",
            background: activeFloor === f ? "#1a2332" : "#fff",
            color: activeFloor === f ? "#fff" : "#64748b",
            fontWeight: 700, fontSize: 14, cursor: "pointer",
            boxShadow: activeFloor === f ? "0 2px 8px #1a233240" : "0 1px 3px #0001",
          }}>{FLOOR_LABELS[f]}</button>
        ))}
      </div>

      {isManager && (
        <div style={{ marginBottom: 14 }}>
          <button onClick={() => setAddingRoom(true)} style={{ padding: "10px 16px", borderRadius: 10, border: "1.5px dashed #94a3b8", background: "#fff", color: "#475569", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
            + Add Room to {FLOOR_LABELS[activeFloor]}
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginBottom: 14, overflowX: "auto", paddingBottom: 4, WebkitOverflowScrolling: "touch" }}>
        {[{ label: "Total Beds", value: stats.total, color: "#3b82f6" }, { label: "Occupied", value: stats.occupied, color: "#ef4444" }, { label: "Available", value: stats.total - stats.occupied, color: "#22c55e" }, { label: "Full", value: stats.full, color: "#f97316" }, { label: "Partial", value: stats.partial, color: "#eab308" }, { label: "Empty", value: stats.empty, color: "#64748b" }].map(s => (
          <div key={s.label} style={{ background: "#fff", borderRadius: 10, padding: "10px 14px", boxShadow: "0 1px 3px #0001", flexShrink: 0, minWidth: 90 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 500 }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 14 }}>
        <input placeholder="🔍  Search room, name, phone…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1.5px solid #e2e8f0", fontSize: 14, outline: "none", width: "100%", background: "#fff", boxSizing: "border-box", marginBottom: 10 }} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {["all", "empty", "partial", "full"].map(s => (
            <button key={s} onClick={() => setFilterStatus(s)} style={{
              padding: "7px 14px", borderRadius: 8, border: "1.5px solid " + (filterStatus === s ? "#1a2332" : "#e2e8f0"),
              background: filterStatus === s ? "#1a2332" : "#fff", color: filterStatus === s ? "#fff" : "#64748b",
              fontWeight: 600, fontSize: 12, cursor: "pointer",
            }}>{s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}</button>
          ))}
          <span style={{ fontSize: 12, color: "#94a3b8", marginLeft: "auto" }}>{filtered.length} rooms</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(155px, 1fr))", gap: 10 }}>
        {filtered.map(room => {
          const sc = STATUS_COLORS[getRoomStatus(room)];
          const occ = getOccupied(room);
          const active = room.tenants.filter(t => t.name.trim());
          return (
            <div key={`${room.floor}-${room.number}`} onClick={() => isManager && openEdit(room)}
              onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 6px 18px #0002"; }}
              onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = ""; }}
              style={{ background: sc.bg, border: `2px solid ${sc.border}`, borderRadius: 12, padding: "11px 11px", cursor: isManager ? "pointer" : "default", transition: "transform 0.12s, box-shadow 0.12s", userSelect: "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <span style={{ fontWeight: 700, fontSize: 15, color: "#1a2332" }}>R{room.number}</span>
                <span style={{ fontSize: 10, fontWeight: 600, color: sc.text, background: sc.border + "44", padding: "2px 7px", borderRadius: 99 }}>{sc.label}</span>
              </div>
              {room.label && <div style={{ fontSize: 10, color: "#64748b", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{room.label}</div>}
              <div style={{ marginTop: 6, fontSize: 12, fontWeight: 600, color: sc.text }}>🛏 {occ}/{room.beds}</div>
              {active.length > 0 && (
                <div style={{ marginTop: 5, display: "flex", flexDirection: "column", gap: 2 }}>
                  {active.slice(0, 2).map((t, i) => (
                    <div key={i} style={{ fontSize: 10, color: "#374151", background: "#fff9", borderRadius: 5, padding: "2px 5px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {(t.billingType||'monthly')==='daily'?'☀️':(t.billingType||'monthly')==='15day'?'🔁':'👤'} {t.name}{t.phone ? ` · ${t.phone}` : ""}
                    </div>
                  ))}
                  {active.length > 2 && <div style={{ fontSize: 10, color: "#94a3b8" }}>+{active.length - 2} more</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {filtered.length === 0 && <div style={{ textAlign: "center", padding: "40px 0", color: "#94a3b8" }}>No rooms match.</div>}

      {editingRoom && editForm && (
        <div onClick={() => setEditingRoom(null)} style={{ position: "fixed", inset: 0, background: "#0008", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 100, padding: 0 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: "20px 20px 0 0", padding: "0 0 20px", width: "100%", maxWidth: 600, boxShadow: "0 -8px 40px #0004", maxHeight: "93vh", overflowY: "auto", marginTop: "auto" }}>
            {/* Drag handle */}
            <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 4px" }}>
              <div style={{ width: 40, height: 4, borderRadius: 99, background: "#e2e8f0" }} />
            </div>
            <div style={{ padding: "0 20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 18 }}>{FLOOR_LABELS[editingRoom.floor]} — Room {editingRoom.number}</div>
                <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 2 }}>Manage beds && tenants</div>
              </div>
              <button onClick={() => setEditingRoom(null)} style={{ background: "#f1f5f9", border: "none", borderRadius: 8, width: 32, height: 32, fontSize: 16, cursor: "pointer", color: "#64748b" }}>✕</button>
            </div>

            <label style={{ fontSize: 11, fontWeight: 700, color: "#64748b", display: "block", marginBottom: 5 }}>ROOM LABEL</label>
            <input value={editForm.label} onChange={e => setEditForm(f => ({ ...f, label: e.target.value }))} placeholder="e.g. Deluxe, Dorm A…" style={{ ...inputStyle, marginBottom: 18 }} />

            <label style={{ fontSize: 11, fontWeight: 700, color: "#64748b", display: "block", marginBottom: 8 }}>NUMBER OF BEDS</label>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 22 }}>
              <button onClick={() => changeBedsInForm(editForm.beds - 1)} style={{ width: 36, height: 36, borderRadius: 8, border: "1.5px solid #e2e8f0", background: "#f8fafc", fontWeight: 700, fontSize: 20, cursor: "pointer" }}>−</button>
              <span style={{ fontSize: 22, fontWeight: 800, minWidth: 32, textAlign: "center" }}>{editForm.beds}</span>
              <button onClick={() => changeBedsInForm(editForm.beds + 1)} style={{ width: 36, height: 36, borderRadius: 8, border: "1.5px solid #e2e8f0", background: "#f8fafc", fontWeight: 700, fontSize: 20, cursor: "pointer" }}>+</button>
              <span style={{ fontSize: 12, color: "#94a3b8" }}>max 20</span>
            </div>

            <label style={{ fontSize: 11, fontWeight: 700, color: "#64748b", display: "block", marginBottom: 10 }}>TENANT DETAILS</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {editForm.tenants.map((t, i) => (
                <div key={i} style={{ background: "#f8fafc", borderRadius: 12, padding: "14px", border: "1.5px solid #e2e8f0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#374151" }}>🛏 Bed {i + 1}</span>
                    {t.name && <button onClick={() => clearTenant(i)} style={{ fontSize: 11, color: "#ef4444", background: "#fef2f2", border: "none", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontWeight: 600 }}>Clear</button>}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <input placeholder="Tenant name" value={t.name} onChange={e => updateTenant(i, "name", e.target.value)} style={inputStyle} />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <input type="tel" placeholder="Phone number" value={t.phone || ""} onChange={e => updateTenant(i, "phone", e.target.value)}
                        style={{ ...inputStyle, ...(phoneIssues[i] ? { border: "1.5px solid #ef4444", background: "#fef2f2" } : {}) }} />
                      <input type="date" value={t.admissionDate} onChange={e => updateTenant(i, "admissionDate", e.target.value)} style={{ ...inputStyle, color: t.admissionDate ? "#1a2332" : "#94a3b8" }} />
                    </div>
                    {phoneIssues[i] && (
                      <div style={{ fontSize: 11, color: "#dc2626", fontWeight: 600, marginTop: -4 }}>⚠️ {phoneIssues[i]}</div>
                    )}
                    {/* Billing type — moved above Rent Amount so the amount field
                        below is clearly labeled for whichever type is picked */}
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid #e2e8f0", paddingTop: 10, marginTop: 2 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: "#64748b", marginRight: 4 }}>BILLING:</span>
                      {["monthly", "15day", "daily"].map(bt => (
                        <button key={bt} onClick={() => updateTenant(i, "billingType", bt)} style={{
                          padding: "5px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700,
                          background: (t.billingType || "monthly") === bt ? (bt === "daily" ? "#f59e0b" : bt === "15day" ? "#8b5cf6" : "#3b82f6") : "#e2e8f0",
                          color: (t.billingType || "monthly") === bt ? "#fff" : "#64748b",
                          transition: "all 0.15s",
                        }}>
                          {bt === "monthly" ? "📅 Monthly" : bt === "15day" ? "🔁 15-Day" : "☀️ Per Day"}
                        </button>
                      ))}
                    </div>
                    {/* Rent Amount — label and unit now match whichever billing type is selected */}
                    <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 10, marginTop: 2 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", marginBottom: 6 }}>
                        💰 {(t.billingType || "monthly") === "daily" ? "PER DAY RENT AMOUNT" : (t.billingType || "monthly") === "15day" ? "RENT PER 15 DAYS" : "MONTHLY RENT AMOUNT"}
                      </div>
                      <div style={{ position: "relative" }}>
                        <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: "#64748b", fontWeight: 700 }}>₹</span>
                        <input
                          type="number"
                          placeholder={(t.billingType || "monthly") === "daily" ? "e.g. 300" : (t.billingType || "monthly") === "15day" ? "e.g. 3500" : "e.g. 5000"}
                          value={t.rentAmount || ""}
                          onChange={e => updateTenant(i, "rentAmount", e.target.value)}
                          style={{ ...inputStyle, paddingLeft: 26 }}
                          min="0"
                        />
                      </div>
                      {t.rentAmount && (
                        <div style={{ fontSize: 11, color: "#22c55e", marginTop: 4 }}>
                          ✅ Rent: ₹{Number(t.rentAmount).toLocaleString("en-IN")}{(t.billingType || "monthly") === "daily" ? "/day" : (t.billingType || "monthly") === "15day" ? " per 15 days" : "/month"}
                        </div>
                      )}
                    </div>
                    {/* Security Deposit Amount — separate from rent. Collecting/returning it
                        is done from the Deposits tab, this just records the agreed amount. */}
                    <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 10, marginTop: 2 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", marginBottom: 6 }}>🔒 SECURITY DEPOSIT AMOUNT</div>
                      <div style={{ position: "relative" }}>
                        <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: "#64748b", fontWeight: 700 }}>₹</span>
                        <input
                          type="number"
                          placeholder="e.g. 3000"
                          value={t.depositAmount || ""}
                          onChange={e => updateTenant(i, "depositAmount", e.target.value)}
                          style={{ ...inputStyle, paddingLeft: 26 }}
                          min="0"
                        />
                      </div>
                      {t.depositAmount && (
                        <div style={{ fontSize: 11, marginTop: 4, color: t.depositReturnedOn ? "#64748b" : t.depositPaidOn ? "#1d4ed8" : "#b45309" }}>
                          {t.depositReturnedOn ? `↩️ Returned ₹${Number(t.depositReturnAmount || t.depositAmount).toLocaleString("en-IN")}` : t.depositPaidOn ? "🔒 Deposit held — collect/return from Deposits tab" : "⏳ Not yet collected — collect from Deposits tab"}
                        </div>
                      )}
                    </div>
                    <input placeholder="Aadhar ID number" value={t.aadharId || ""} onChange={e => updateTenant(i, "aadharId", e.target.value)} style={{ ...inputStyle, letterSpacing: "1px" }} maxLength={12} />
                    {t.aadharId && t.aadharId.replace(/\D/g,"").length !== 12 && (
                      <div style={{ fontSize: 10, color: "#f59e0b" }}>⚠️ Aadhar should be 12 digits</div>
                    )}
                    {t.aadharId && t.aadharId.replace(/\D/g,"").length === 12 && (
                      <div style={{ fontSize: 10, color: "#22c55e" }}>✅ Valid Aadhar length</div>
                    )}
                    {/* Father details */}
                    <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 10, marginTop: 2 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", marginBottom: 6 }}>FATHER'S DETAILS</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        <input placeholder="Father's name" value={t.fatherName || ""} onChange={e => updateTenant(i, "fatherName", e.target.value)} style={inputStyle} />
                        <input type="tel" placeholder="Father's phone" value={t.fatherPhone || ""} onChange={e => updateTenant(i, "fatherPhone", e.target.value)} style={inputStyle} />
                      </div>
                      {t.fatherPhone && (
                        <div style={{ marginTop: 6 }}>
                          <ContactButtons phone={t.fatherPhone} size="small" />
                        </div>
                      )}
                    </div>
                    {/* Guardian details */}
                    <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 10, marginTop: 2 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", marginBottom: 6 }}>GUARDIAN'S DETAILS <span style={{ fontWeight: 400, color: "#94a3b8" }}>(if different from father)</span></div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        <input placeholder="Guardian's name" value={t.guardianName || ""} onChange={e => updateTenant(i, "guardianName", e.target.value)} style={inputStyle} />
                        <input type="tel" placeholder="Guardian's phone" value={t.guardianPhone || ""} onChange={e => updateTenant(i, "guardianPhone", e.target.value)} style={inputStyle} />
                      </div>
                      {t.guardianPhone && (
                        <div style={{ marginTop: 6 }}>
                          <ContactButtons phone={t.guardianPhone} size="small" />
                        </div>
                      )}
                    </div>
                    {/* Address details */}
                    <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 10, marginTop: 2 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", marginBottom: 6 }}>📍 ADDRESS</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <input placeholder="Full address" value={t.address || ""} onChange={e => updateTenant(i, "address", e.target.value)} style={inputStyle} />
                        <input placeholder="City" value={t.city || ""} onChange={e => updateTenant(i, "city", e.target.value)} style={inputStyle} />
                      </div>
                    </div>
                    {/* Occupation details */}
                    <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 10, marginTop: 2 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", marginBottom: 6 }}>💼 JOB / COLLEGE</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                          <div>
                            <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 3 }}>Type</div>
                            <select value={t.occupation || ""} onChange={e => updateTenant(i, "occupation", e.target.value)} style={{ ...inputStyle, color: t.occupation ? "#1a2332" : "#94a3b8" }}>
                              <option value="">Select type…</option>
                              <option value="job">Job</option>
                              <option value="college">College/University</option>
                              <option value="school">School</option>
                              <option value="business">Business</option>
                              <option value="other">Other</option>
                            </select>
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 3 }}>
                              {t.occupation === "job" ? "Employee ID" : t.occupation === "college" || t.occupation === "school" ? "Student ID" : "ID Number"}
                            </div>
                            <input placeholder="ID number" value={t.occupationId || ""} onChange={e => updateTenant(i, "occupationId", e.target.value)} style={inputStyle} />
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 3 }}>
                            {t.occupation === "job" ? "Company name" : t.occupation === "college" ? "College name" : t.occupation === "school" ? "School name" : "Place name"}
                          </div>
                          <input placeholder={t.occupation === "job" ? "Company name" : t.occupation === "college" ? "College name" : "Place name"} value={t.occupationPlace || ""} onChange={e => updateTenant(i, "occupationPlace", e.target.value)} style={inputStyle} />
                        </div>
                      </div>
                    </div>
                    {/* Reason to stay */}
                    <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 10, marginTop: 2 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", marginBottom: 6 }}>📝 REASON TO STAY</div>
                      <textarea placeholder="Why are they staying? e.g. studying in nearby college, working at XYZ company…" value={t.reasonToStay || ""} onChange={e => updateTenant(i, "reasonToStay", e.target.value)} style={{ ...inputStyle, minHeight: 70, resize: "vertical" }} />
                    </div>
                    {(t.billingType || "monthly") === "daily" && (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        <div>
                          <div style={{ fontSize: 10, color: "#64748b", marginBottom: 3, fontWeight: 600 }}>CHECK-IN</div>
                          <input type="date" value={t.admissionDate} onChange={e => updateTenant(i, "admissionDate", e.target.value)} style={{ ...inputStyle, color: t.admissionDate ? "#1a2332" : "#94a3b8" }} />
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: "#64748b", marginBottom: 3, fontWeight: 600 }}>CHECK-OUT</div>
                          <input type="date" value={t.checkoutDate || ""} onChange={e => updateTenant(i, "checkoutDate", e.target.value)} style={{ ...inputStyle, color: t.checkoutDate ? "#1a2332" : "#94a3b8" }} />
                        </div>
                      </div>
                    )}
                    {(t.billingType || "monthly") === "daily" && t.admissionDate && t.checkoutDate && (() => {
                      const inn = new Date(t.admissionDate + "T00:00:00");
                      const out = new Date(t.checkoutDate + "T00:00:00");
                      const days = Math.max(0, Math.round((out - inn) / 86400000));
                      return <div style={{ fontSize: 11, color: "#f59e0b", fontWeight: 600 }}>☀️ {days} day{days !== 1 ? "s" : ""} stay · {fmt(t.admissionDate)} → {fmt(t.checkoutDate)}</div>;
                    })()}
                    {(t.billingType || "monthly") === "monthly" && t.admissionDate && <div style={{ fontSize: 11, color: "#64748b" }}>📅 Admitted: {fmt(t.admissionDate)} · Rent due on {ordinal(new Date(t.admissionDate + "T00:00:00").getDate())} every month</div>}
                    {(t.billingType || "monthly") === "15day" && t.admissionDate && <div style={{ fontSize: 11, color: "#64748b" }}>🔁 Admitted: {fmt(t.admissionDate)} · Rent due every 15 days from admission</div>}
                  </div>
                </div>
              ))}
            </div>

            {Object.keys(phoneIssues).length > 0 && (
              <div style={{ background: "#fef2f2", border: "1.5px solid #fecaca", borderRadius: 10, padding: "10px 12px", marginTop: 16, fontSize: 12, color: "#991b1b", fontWeight: 600 }}>
                ⚠️ Fix the phone number issue{Object.keys(phoneIssues).length > 1 ? "s" : ""} highlighted above before saving.
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
              <button onClick={() => setEditingRoom(null)} style={{ flex: 1, padding: "14px 0", borderRadius: 12, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 600, fontSize: 15, cursor: "pointer" }}>Cancel</button>
              <button onClick={saveEdit} disabled={Object.keys(phoneIssues).length > 0} style={{ flex: 2, padding: "14px 0", borderRadius: 12, border: "none", background: Object.keys(phoneIssues).length > 0 ? "#94a3b8" : "#1a2332", color: "#fff", fontWeight: 700, fontSize: 15, cursor: Object.keys(phoneIssues).length > 0 ? "not-allowed" : "pointer" }}>💾 Save Changes</button>
            </div>
            {isManager && (
              <div style={{ textAlign: "center", marginTop: 14 }}>
                <button onClick={() => setConfirmDeleteRoom(editingRoom)} style={{ background: "none", border: "none", color: "#dc2626", fontWeight: 600, fontSize: 13, cursor: "pointer", textDecoration: "underline" }}>
                  🗑️ Delete this room
                </button>
              </div>
            )}
            </div>
          </div>
        </div>
      )}

      {/* Add Room modal */}
      {addingRoom && (
        <div onClick={() => !creatingRoom && setAddingRoom(false)} style={{ position: "fixed", inset: 0, background: "#00000066", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, padding: 22, width: "100%", maxWidth: 340 }}>
            <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 4 }}>Add Room</div>
            <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>
              New room will be added to <b>{FLOOR_LABELS[activeFloor]}</b> as Room #{floorRooms.length > 0 ? Math.max(...floorRooms.map(r => r.number)) + 1 : 1}
            </div>
            <label style={{ fontSize: 12, fontWeight: 700, color: "#475569" }}>Number of beds</label>
            <input type="number" min={1} max={20} value={newRoomBeds} onChange={e => setNewRoomBeds(e.target.value)}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1.5px solid #e2e8f0", fontSize: 15, marginTop: 6, marginBottom: 18, boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: 10 }}>
              <button disabled={creatingRoom} onClick={() => setAddingRoom(false)} style={{ flex: 1, padding: "12px 0", borderRadius: 10, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 600, fontSize: 14, cursor: creatingRoom ? "default" : "pointer" }}>Cancel</button>
              <button disabled={creatingRoom} onClick={handleAddRoom} style={{ flex: 2, padding: "12px 0", borderRadius: 10, border: "none", background: "#1a2332", color: "#fff", fontWeight: 700, fontSize: 14, cursor: creatingRoom ? "default" : "pointer", opacity: creatingRoom ? 0.7 : 1 }}>
                {creatingRoom ? "Creating…" : "+ Create Room"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Room confirmation modal */}
      {confirmDeleteRoom && (() => {
        const occupiedTenants = confirmDeleteRoom.tenants.filter(t => t.name && t.name.trim());
        const hasOccupants = occupiedTenants.length > 0;
        return (
          <div onClick={() => !deletingRoom && setConfirmDeleteRoom(null)} style={{ position: "fixed", inset: 0, background: "#00000066", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 110, padding: 20 }}>
            <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, padding: 22, width: "100%", maxWidth: 360 }}>
              <div style={{ fontSize: 40, textAlign: "center", marginBottom: 8 }}>{hasOccupants ? "⚠️" : "🗑️"}</div>
              <div style={{ fontWeight: 800, fontSize: 18, textAlign: "center", marginBottom: 8 }}>
                {hasOccupants ? "Can't delete this room" : "Delete this room?"}
              </div>
              <div style={{ fontSize: 13, color: "#64748b", textAlign: "center", marginBottom: 18 }}>
                {hasOccupants
                  ? <>{FLOOR_LABELS[confirmDeleteRoom.floor]} Room {confirmDeleteRoom.number} still has {occupiedTenants.length} tenant{occupiedTenants.length !== 1 ? "s" : ""} ({occupiedTenants.map(t => t.name).join(", ")}). Please move or remove them from this room before deleting it.</>
                  : <>This will permanently delete <b>{FLOOR_LABELS[confirmDeleteRoom.floor]} Room {confirmDeleteRoom.number}</b>. This cannot be undone.</>
                }
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button disabled={deletingRoom} onClick={() => setConfirmDeleteRoom(null)} style={{ flex: 1, padding: "12px 0", borderRadius: 10, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 600, fontSize: 14, cursor: "pointer" }}>
                  {hasOccupants ? "Okay" : "Cancel"}
                </button>
                {!hasOccupants && (
                  <button disabled={deletingRoom} onClick={() => handleDeleteRoom(confirmDeleteRoom)} style={{ flex: 2, padding: "12px 0", borderRadius: 10, border: "none", background: "#dc2626", color: "#fff", fontWeight: 700, fontSize: 14, cursor: deletingRoom ? "default" : "pointer", opacity: deletingRoom ? 0.7 : 1 }}>
                    {deletingRoom ? "Deleting…" : "🗑️ Yes, Delete"}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── HISTORY PAGE ─────────────────────────────────────────────
function HistoryPage() {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filterFloor, setFilterFloor] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showExportPanel, setShowExportPanel] = useState(false);
  const [visibleCount, setVisibleCount] = useState(30);

  useEffect(() => { setVisibleCount(30); }, [query, filterFloor]);

  useEffect(() => {
    loadHistory()
      .then(rows => { setHistory(rows); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const filtered = history.filter(t => {
    const matchQ = !query ||
      (t.name || "").toLowerCase().includes(query.toLowerCase()) ||
      (t.phone || "").includes(query) ||
      (t.aadhar_id || "").includes(query) ||
      (t.father_name || "").toLowerCase().includes(query.toLowerCase()) ||
      (t.guardian_name || "").toLowerCase().includes(query.toLowerCase()) ||
      (t.city || "").toLowerCase().includes(query.toLowerCase()) ||
      (t.occupation_place || "").toLowerCase().includes(query.toLowerCase()) ||
      String(t.room_number).includes(query);
    const matchF = filterFloor === "all" || String(t.floor) === filterFloor;
    return matchQ && matchF;
  });

  // Date range filtered (for export)
  const dateFiltered = filtered.filter(t => {
    const archivedDate = t.archived_at ? t.archived_at.slice(0,10) : "";
    if (dateFrom && archivedDate < dateFrom) return false;
    if (dateTo && archivedDate > dateTo) return false;
    return true;
  });

  function buildCSV(rows) {
    const headers = ["Name","Phone","Aadhar ID","Father Name","Father Phone","Guardian Name","Guardian Phone","Address","City","Occupation Type","Place/Company/College","ID Number","Reason to Stay","Rent Amount","Floor","Room","Bed","Admission Date","Left Date","Billing Type","Archived On"];
    const data = rows.map(t => [
      t.name||"", t.phone||"", t.aadhar_id||"",
      t.father_name||"", t.father_phone||"",
      t.guardian_name||"", t.guardian_phone||"",
      t.address||"", t.city||"",
      t.occupation||"", t.occupation_place||"", t.occupation_id||"",
      t.reason_to_stay||"", t.rent_amount ? `Rs.${t.rent_amount}` : "",
      t.floor, t.room_number, (t.bed_index||0)+1,
      t.admission_date||"", t.checkout_date||"", t.billing_type||"monthly",
      t.archived_at ? fmtDateIST(new Date(t.archived_at)) : ""
    ]);
    return [headers, ...data].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
  }

  function downloadCSV(csv, label) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hosteldesk-${label}-${istDateStr()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportAll() { downloadCSV(buildCSV(filtered), "all-history"); }
  function exportDateRange() {
    if (!dateFrom || !dateTo) { alert("Please select both From and To dates"); return; }
    if (dateFiltered.length === 0) { alert("No records found in this date range"); return; }
    downloadCSV(buildCSV(dateFiltered), `${dateFrom}-to-${dateTo}`);
  }

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "16px 12px 90px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 3px" }}>🗂️ Past Tenants</h1>
          <p style={{ margin: 0, color: "#64748b", fontSize: 14 }}>
            {loading ? "Loading…" : `${history.length} total records in history`}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setShowExportPanel(!showExportPanel)} style={{ padding: "10px 18px", background: showExportPanel ? "#1a2332" : "#f1f5f9", color: showExportPanel ? "#fff" : "#374151", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
            📤 Export
          </button>
          <button onClick={exportAll} style={{ padding: "10px 18px", background: "#22c55e", color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
            📥 Export All
          </button>
        </div>
      </div>

      {/* Export Panel */}
      {showExportPanel && (
        <div style={{ background: "#fff", borderRadius: 14, padding: "18px 20px", marginBottom: 18, border: "1.5px solid #e2e8f0", boxShadow: "0 2px 8px #0001" }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>📅 Export by Date Range</div>
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>Select the period you want to export — based on when the tenant was archived (removed/replaced)</div>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 140 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", marginBottom: 5 }}>FROM DATE</div>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={{ ...inputStyle, color: dateFrom ? "#1a2332" : "#94a3b8" }} />
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", marginBottom: 5 }}>TO DATE</div>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={{ ...inputStyle, color: dateTo ? "#1a2332" : "#94a3b8" }} />
            </div>
            <button onClick={exportDateRange} style={{ padding: "9px 20px", background: "#3b82f6", color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}>
              📥 Download {dateFrom && dateTo ? `(${dateFiltered.length} records)` : ""}
            </button>
          </div>
          {dateFrom && dateTo && (
            <div style={{ marginTop: 10, fontSize: 12, color: "#64748b" }}>
              📊 {dateFiltered.length} records from {fmt(dateFrom)} to {fmt(dateTo)}
            </div>
          )}
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #f1f5f9" }}>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, marginBottom: 8 }}>QUICK SELECT</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[
                { label: "This Month", fn: () => { const n = istNow(); setDateFrom(`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-01`); setDateTo(istDateStr(n)); }},
                { label: "Last Month", fn: () => { const n = istNow(); const lm = new Date(n.getFullYear(), n.getMonth()-1, 1); const le = new Date(n.getFullYear(), n.getMonth(), 0); setDateFrom(istDateStr(lm)); setDateTo(istDateStr(le)); }},
                { label: "Last 3 Months", fn: () => { const n = istNow(); const s = new Date(n); s.setMonth(s.getMonth()-3); setDateFrom(istDateStr(s)); setDateTo(istDateStr(n)); }},
                { label: "This Year", fn: () => { const n = istNow(); setDateFrom(`${n.getFullYear()}-01-01`); setDateTo(istDateStr(n)); }},
                { label: "Last Year", fn: () => { const y = istNow().getFullYear()-1; setDateFrom(`${y}-01-01`); setDateTo(`${y}-12-31`); }},
              ].map(q => (
                <button key={q.label} onClick={q.fn} style={{ padding: "5px 12px", borderRadius: 8, border: "1.5px solid #e2e8f0", background: "#f8fafc", fontSize: 12, cursor: "pointer", fontWeight: 500, color: "#374151" }}>
                  {q.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Search & Filters */}
      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 200 }}>
          <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14 }}>🔍</span>
          <input
            placeholder="Search name, phone, Aadhar, father, guardian, room…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            style={{ ...inputStyle, paddingLeft: 36, borderRadius: 10 }}
          />
          {query && <button onClick={() => setQuery("")} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "#e2e8f0", border: "none", borderRadius: "50%", width: 20, height: 20, cursor: "pointer", fontSize: 11 }}>✕</button>}
        </div>
        {["all", ...FLOORS].map(f => (
          <button key={f} onClick={() => setFilterFloor(String(f))} style={{
            padding: "8px 14px", borderRadius: 8,
            border: "1.5px solid " + (filterFloor === String(f) ? "#1a2332" : "#e2e8f0"),
            background: filterFloor === String(f) ? "#1a2332" : "#fff",
            color: filterFloor === String(f) ? "#fff" : "#64748b",
            fontWeight: 500, fontSize: 12, cursor: "pointer",
          }}>{f === "all" ? "All Floors" : FLOOR_LABELS[f]}</button>
        ))}
      </div>

      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 14 }}>
        Showing {Math.min(visibleCount, filtered.length)} of {filtered.length} records{query ? ` matching "${query}"` : ""}
      </div>

      {/* Records */}
      {loading ? (
        <div style={{ textAlign: "center", padding: "48px 0", color: "#94a3b8" }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>⏳</div>Loading history…
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 0", color: "#94a3b8" }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🗂️</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>No history yet</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>Past tenants appear here automatically when you replace or clear them from a room</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.slice(0, visibleCount).map((t, i) => (
            <div key={i} style={{ background: "#fff", borderRadius: 12, padding: "14px 16px", border: "1.5px solid #e2e8f0", display: "flex", alignItems: "flex-start", gap: 14 }}>
              <div style={{ width: 42, height: 42, borderRadius: "50%", background: "#64748b", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 16, flexShrink: 0, marginTop: 2 }}>
                {(t.name||"?").charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{t.name}</div>
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                  Floor {t.floor} · Room {t.room_number} · Bed {(t.bed_index||0)+1}
                  {t.aadhar_id ? <span style={{ background: "#eff6ff", color: "#3b82f6", borderRadius: 4, padding: "1px 6px", marginLeft: 6, fontSize: 10, fontWeight: 700 }}>🪪 {t.aadhar_id}</span> : ""}
                </div>
                {t.father_name && (
                  <div style={{ fontSize: 11, color: "#374151", marginTop: 4, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span>👨 <b>Father:</b> {t.father_name}</span>
                    {t.father_phone && <span style={{ color: "#64748b" }}>{t.father_phone}</span>}
                    {t.father_phone && <ContactButtons phone={t.father_phone} size="small" />}
                  </div>
                )}
                {(t.city || t.address) && <div style={{ fontSize: 11, color: "#64748b", marginTop: 3 }}>📍 {[t.city, t.address].filter(Boolean).join(", ")}</div>}
                {t.occupation_place && <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>💼 {t.occupation === "job" ? "Works at" : t.occupation === "college" ? "Studies at" : "At"}: {t.occupation_place}{t.occupation_id ? ` · ID: ${t.occupation_id}` : ""}</div>}
                {t.reason_to_stay && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2, fontStyle: "italic" }}>"{t.reason_to_stay}"</div>}
                {t.guardian_name && (
                  <div style={{ fontSize: 11, color: "#374151", marginTop: 4, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span>🛡️ <b>Guardian:</b> {t.guardian_name}</span>
                    {t.guardian_phone && <span style={{ color: "#64748b" }}>{t.guardian_phone}</span>}
                    {t.guardian_phone && <ContactButtons phone={t.guardian_phone} size="small" />}
                  </div>
                )}
                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 5, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {t.admission_date && <span>📅 Joined: {fmt(t.admission_date)}</span>}
                  {t.checkout_date && <span>🚪 Left: {fmt(t.checkout_date)}</span>}
                  {t.archived_at && <span>🗃️ Archived: {fmtDateIST(new Date(t.archived_at))}</span>}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                <ContactButtons phone={t.phone} size="small" />
                <div style={{ fontSize: 10, background: "#f1f5f9", color: "#64748b", padding: "2px 8px", borderRadius: 99, fontWeight: 600 }}>
                  {t.billing_type === "daily" ? "☀️ Per Day" : t.billing_type === "15day" ? "🔁 15-Day" : "📅 Monthly"}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {!loading && visibleCount < filtered.length && (
        <div style={{ textAlign: "center", marginTop: 16 }}>
          <button onClick={() => setVisibleCount(v => v + 30)} style={{ padding: "10px 22px", borderRadius: 10, border: "1.5px solid #e2e8f0", background: "#fff", color: "#374151", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
            Load 30 more ({filtered.length - visibleCount} remaining)
          </button>
        </div>
      )}
    </div>
  );
}

// ── LOGIN PAGE ───────────────────────────────────────────────
function LoginPage() {
  const [loading, setLoading] = useState(false);
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg, #1a2332 0%, #2d3f55 100%)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ background: "#fff", borderRadius: 24, padding: "40px 32px", width: "100%", maxWidth: 400, boxShadow: "0 32px 80px #0006", textAlign: "center" }}>
        <div style={{ fontSize: 52, marginBottom: 8 }}>🏨</div>
        <div style={{ fontWeight: 800, fontSize: 26, color: "#1a2332", marginBottom: 4 }}>Turiya Hostel</div>
        <div style={{ fontSize: 14, color: "#94a3b8", marginBottom: 32 }}>Management System</div>
        <button
          onClick={() => { setLoading(true); supabaseAuth.signInWithGoogle(); }}
          disabled={loading}
          style={{ width: "100%", padding: "14px 20px", border: "2px solid #e2e8f0", borderRadius: 14, background: loading ? "#f8fafc" : "#fff", cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 12, fontSize: 15, fontWeight: 700, color: "#1a2332", transition: "all 0.15s" }}
          onMouseEnter={e => { if (!loading) e.currentTarget.style.borderColor = "#3b82f6"; }}
          onMouseLeave={e => e.currentTarget.style.borderColor = "#e2e8f0"}
        >
          {loading ? "Redirecting…" : (
            <>
              <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4C12.955 4 4 12.955 4 24s8.955 20 20 20s20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/><path fill="#FF3D00" d="m6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4C16.318 4 9.656 8.337 6.306 14.691z"/><path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/><path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/></svg>
              Sign in with Google
            </>
          )}
        </button>
        <div style={{ marginTop: 20, fontSize: 12, color: "#94a3b8" }}>Only approved accounts can access this system</div>
      </div>
    </div>
  );
}

// ── PENDING PAGE ──────────────────────────────────────────────
function PendingPage({ user, userRole }) {
  return (
    <div style={{ minHeight: "100vh", background: "#f0f4f8", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ background: "#fff", borderRadius: 24, padding: "40px 32px", width: "100%", maxWidth: 400, boxShadow: "0 8px 32px #0002", textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>{userRole?.role === "rejected" ? "❌" : "⏳"}</div>
        <div style={{ fontWeight: 800, fontSize: 20, color: "#1a2332", marginBottom: 8 }}>
          {userRole?.role === "rejected" ? "Access Denied" : "Waiting for Approval"}
        </div>
        <div style={{ fontSize: 14, color: "#64748b", marginBottom: 8 }}>Logged in as</div>
        <div style={{ fontWeight: 600, color: "#1a2332", marginBottom: 16 }}>{user?.email}</div>
        <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 28, lineHeight: 1.6 }}>
          {userRole?.role === "rejected"
            ? "Your access request was rejected. Contact the admin if you think this is a mistake."
            : "Your request has been sent to the admin. You'll get access once they approve your account."}
        </div>
        <button onClick={supabaseAuth.signOut} style={{ padding: "11px 28px", background: "#1a2332", color: "#fff", border: "none", borderRadius: 10, fontWeight: 600, fontSize: 14, cursor: "pointer" }}>
          Sign Out
        </button>
      </div>
    </div>
  );
}

// ── ADMIN USERS PAGE ──────────────────────────────────────────
function UsersPage({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(null);

  useEffect(() => {
    getAllUsers().then(u => { setUsers(u); setLoading(false); });
  }, []);

  async function changeRole(email, role) {
    setUpdating(email);
    await updateUserRole(email, role);
    setUsers(prev => prev.map(u => u.email === email ? { ...u, role } : u));
    setUpdating(null);
  }

  async function removeUser(email) {
    if (!window.confirm(`Remove ${email}? They will lose all access.`)) return;
    setUpdating(email);
    await deleteUser(email);
    setUsers(prev => prev.filter(u => u.email !== email));
    setUpdating(null);
  }

  const roleColors = {
    admin: { bg: "#eff6ff", color: "#1d4ed8", label: "Admin" },
    manager: { bg: "#f0fdf4", color: "#15803d", label: "Manager" },
    worker: { bg: "#fefce8", color: "#a16207", label: "Worker" },
    pending: { bg: "#fff7ed", color: "#c2410c", label: "Pending" },
    rejected: { bg: "#fef2f2", color: "#b91c1c", label: "Rejected" },
  };

  const pending = users.filter(u => u.role === "pending");
  const active = users.filter(u => !["pending", "rejected"].includes(u.role));
  const rejected = users.filter(u => u.role === "rejected");

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "16px 12px 90px" }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 3px" }}>👥 Manage Users</h1>
        <p style={{ margin: 0, color: "#64748b", fontSize: 14 }}>{users.length} total users</p>
      </div>

      {/* Pending approvals */}
      {pending.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
            <span>⏳ Pending Approval</span>
            <span style={{ background: "#fef3c7", color: "#d97706", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99 }}>{pending.length}</span>
          </div>
          {pending.map(u => (
            <div key={u.email} style={{ background: "#fff", borderRadius: 12, padding: "14px 16px", border: "2px solid #fcd34d", marginBottom: 8, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{u.name || "Unknown"}</div>
                <div style={{ fontSize: 12, color: "#64748b" }}>{u.email}</div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {["worker", "manager", "admin"].map(role => (
                  <button key={role} onClick={() => changeRole(u.email, role)} disabled={updating === u.email} style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: role === "worker" ? "#1a2332" : role === "manager" ? "#22c55e" : "#3b82f6", color: "#fff", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>
                    {updating === u.email ? "…" : `Approve as ${role.charAt(0).toUpperCase() + role.slice(1)}`}
                  </button>
                ))}
                <button onClick={() => changeRole(u.email, "rejected")} disabled={updating === u.email} style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "#fef2f2", color: "#ef4444", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Active users */}
      {active.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>✅ Active Users</div>
          {active.map(u => {
            const rc = roleColors[u.role] || roleColors.worker;
            const isMe = u.email === currentUser?.email;
            return (
              <div key={u.email} style={{ background: "#fff", borderRadius: 12, padding: "14px 16px", border: "1.5px solid #e2e8f0", marginBottom: 8, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div style={{ width: 38, height: 38, borderRadius: "50%", background: "#1a2332", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 15, flexShrink: 0 }}>
                  {(u.name || u.email).charAt(0).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{u.name || "Unknown"} {isMe && <span style={{ fontSize: 11, color: "#94a3b8" }}>(you)</span>}</div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>{u.email}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ background: rc.bg, color: rc.color, fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 99 }}>{rc.label}</span>
                  {!isMe && (
                    <select value={u.role} onChange={e => changeRole(u.email, e.target.value)} disabled={updating === u.email}
                      style={{ padding: "6px 10px", borderRadius: 8, border: "1.5px solid #e2e8f0", fontSize: 12, fontWeight: 600, cursor: "pointer", background: "#f8fafc" }}>
                      <option value="worker">Worker</option>
                      <option value="manager">Manager</option>
                      <option value="admin">Admin</option>
                      <option value="rejected">Reject</option>
                    </select>
                  )}
                  {!isMe && (
                    <button onClick={() => removeUser(u.email)} disabled={updating === u.email} style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: "#fef2f2", color: "#ef4444", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Rejected */}
      {rejected.length > 0 && (
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10, color: "#94a3b8" }}>❌ Rejected</div>
          {rejected.map(u => (
            <div key={u.email} style={{ background: "#fff", borderRadius: 12, padding: "12px 16px", border: "1.5px solid #fecaca", marginBottom: 8, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", opacity: 0.7 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{u.name || "Unknown"}</div>
                <div style={{ fontSize: 12, color: "#64748b" }}>{u.email}</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => changeRole(u.email, "worker")} style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: "#f0fdf4", color: "#15803d", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>
                  Restore
                </button>
                <button onClick={() => removeUser(u.email)} style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: "#fef2f2", color: "#ef4444", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {loading && <div style={{ textAlign: "center", padding: "40px 0", color: "#94a3b8" }}>Loading users…</div>}
      {!loading && users.length === 0 && <div style={{ textAlign: "center", padding: "40px 0", color: "#94a3b8" }}>No users yet.</div>}
    </div>
  );
}

// ── ROOT ─────────────────────────────────────────────────────
function App() {
  const [rooms, setRooms] = useState(initRooms);
  const [page, setPage] = useState("home");
  const [activeFloor, setActiveFloor] = useState(1);
  const [roomsInitialStatusFilter, setRoomsInitialStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [user, setUser] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  const today = istNow();

  // Auth check on startup
  useEffect(() => {
    (async () => {
      // getSession() also picks up a fresh token from the URL right after Google login
      await supabaseAuth.getSession();
      const u = await supabaseAuth.getValidUser();
      if (!u) { setAuthLoading(false); return; }
      setUser(u);
      // Check role
      let role = await getUserRole(u.email);
      if (!role) {
        // First time login - create pending entry
        await upsertUserRole(u.email, u.user_metadata?.full_name || u.email, "pending");
        role = { email: u.email, role: "pending" };
      }
      setUserRole(role);
      setAuthLoading(false);
    })();
  }, []);

  // Keep the session alive in the background so a long work session never gets
  // interrupted by the ~1hr access token expiry — refresh well before it lapses.
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      supabaseAuth.refreshSession();
    }, 45 * 60 * 1000); // every 45 minutes
    return () => clearInterval(interval);
  }, [user]);

  // Load rooms only when authenticated and approved
  useEffect(() => {
    if (!userRole || ["pending", "rejected"].includes(userRole.role)) return;
    loadAllRooms()
      .then(r => { setRooms(r); setLoading(false); })
      .catch(e => { console.error(e); setError("Could not connect to database."); setLoading(false); });
  }, [userRole]);

  const handleSaveRoom = useCallback(async (updatedRoom) => {
    setSaving(true);
    try {
      await saveRoom(updatedRoom, updatedRoom.tenants);
      const id = `${updatedRoom.floor}-${updatedRoom.number}`;
      setRooms(prev => ({ ...prev, [id]: updatedRoom }));
    } catch(e) {
      console.error(e);
      alert("Failed to save. Please check your internet connection.");
    }
    setSaving(false);
  }, []);

  const all = Object.values(rooms);
  const allStats = {
    totalBeds: all.reduce((s, r) => s + r.beds, 0),
    totalOcc: all.reduce((s, r) => s + getOccupied(r), 0),
  };
  const tenants = getAllTenants(rooms);
  const rentAlerts = tenants.filter(t => {
    if ((t.billingType || "monthly") === "daily" || !t.admissionDate) return false;
    const is15 = t.billingType === "15day";
    const rs = is15 ? getRentStatus15(t.admissionDate, today, t.rentPaidOn) : getRentStatus(t.admissionDate, today, t.rentPaidOn);
    if (!rs || !(rs.type === "due_today" || rs.type === "due_soon" || rs.type === "overdue")) return false;
    const isPaid = is15 ? isActiveForCycle15(t.rentPaidOn, rs.cycleStart) : isActiveForCycle(t.rentPaidOn, rs.dueDay, today);
    const isSnoozed = !isPaid && isSnoozedNow(t.rentSnoozedUntil, t.rentSnoozedCycleStart, is15 ? rs.cycleStart : getCycleStart(rs.dueDay, today), today);
    return !isPaid && !isSnoozed;
  }).length;

  const role = userRole?.role;
  const isAdmin = role === "admin";
  const isManager = role === "manager" || isAdmin;

  // Auth loading
  if (authLoading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", fontFamily: "Inter, system-ui, sans-serif", flexDirection: "column", gap: 16, background: "#f0f4f8" }}>
      <div style={{ fontSize: 40 }}>🏨</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#1a2332" }}>Turiya Hostel</div>
      <div style={{ fontSize: 14, color: "#94a3b8" }}>Checking login…</div>
    </div>
  );

  // Not logged in
  if (!user) return <LoginPage />;

  // Pending or rejected
  if (["pending", "rejected"].includes(role)) return <PendingPage user={user} userRole={userRole} />;

  // Data loading
  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", fontFamily: "Inter, system-ui, sans-serif", flexDirection: "column", gap: 16, background: "#f0f4f8" }}>
      <div style={{ fontSize: 40 }}>🏨</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#1a2332" }}>Loading HostelDesk…</div>
      <div style={{ fontSize: 14, color: "#94a3b8" }}>Connecting to database</div>
    </div>
  );

  if (error) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", fontFamily: "Inter, system-ui, sans-serif", flexDirection: "column", gap: 16, background: "#f0f4f8", padding: 24 }}>
      <div style={{ fontSize: 40 }}>⚠️</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#ef4444" }}>Connection Error</div>
      <div style={{ fontSize: 14, color: "#64748b", textAlign: "center" }}>{error}</div>
      <button onClick={() => window.location.reload()} style={{ padding: "10px 24px", background: "#1a2332", color: "#fff", border: "none", borderRadius: 10, cursor: "pointer", fontWeight: 600 }}>Try Again</button>
    </div>
  );

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100vh", background: "#f0f4f8", color: "#1a2332", paddingBottom: "env(safe-area-inset-bottom)" }}>
      {saving && (
        <div style={{ position: "fixed", bottom: 80, right: 16, background: "#1a2332", color: "#fff", padding: "10px 18px", borderRadius: 10, fontSize: 13, fontWeight: 600, zIndex: 999, boxShadow: "0 4px 16px #0004" }}>
          💾 Saving…
        </div>
      )}
      <Nav page={page} setPage={setPage} allStats={allStats} rentAlerts={rentAlerts} user={user} userRole={userRole} isAdmin={isAdmin} isManager={isManager} />
      {page === "home" && <HomePage rooms={rooms} setPage={setPage} setActiveFloor={setActiveFloor} today={today} isManager={isManager} setRoomsInitialStatusFilter={setRoomsInitialStatusFilter} />}
      {page === "rooms" && <RoomsPage rooms={rooms} setRooms={setRooms} activeFloor={activeFloor} setActiveFloor={setActiveFloor} onSaveRoom={handleSaveRoom} isManager={isManager} initialStatusFilter={roomsInitialStatusFilter} />}
      {page === "search" && <TenantSearchPage rooms={rooms} setPage={setPage} setActiveFloor={setActiveFloor} isManager={isManager} isAdmin={isAdmin} />}
      {isManager && page === "rent" && <RentPage rooms={rooms} setRooms={setRooms} today={today} />}
      {isManager && page === "deposits" && <DepositsPage rooms={rooms} setRooms={setRooms} today={today} />}
      {isAdmin && page === "history" && <HistoryPage />}
      {isAdmin && page === "users" && <UsersPage currentUser={user} />}
    </div>
  );
}
