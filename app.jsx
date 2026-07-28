const { useState, useEffect, useCallback } = React;

// Inject global mobile styles
if (typeof document !== "undefined") {
  // Fraunces (a warm, ink-trap serif) carries headlines and rupee figures —
  // it reads like a ledger/passbook entry rather than a dashboard metric.
  // Inter stays for all UI chrome, labels, and body text so density and
  // legibility on small screens are untouched.
  const fontLink = document.createElement("link");
  fontLink.rel = "stylesheet";
  fontLink.href = "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700;800&display=swap";
  document.head.appendChild(fontLink);

  const style = document.createElement("style");
  style.textContent = `
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    body { margin: 0; overscroll-behavior: none; }
    input, button { font-family: inherit; }
    button { touch-action: manipulation; }
    ::-webkit-scrollbar { width: 4px; height: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #D9D2C2; border-radius: 99px; }
  `;
  document.head.appendChild(style);
}

// Display face for headlines, brand wordmark, and rupee amounts.
const FONT_DISPLAY = "'Fraunces', Georgia, serif";

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
// This account can never be demoted or removed through the app — enforced
// both here (hides the controls) and at the database level (RLS blocks the
// change even via a direct API call, regardless of what the UI shows).
const SUPER_ADMIN_EMAIL = "turiya.shubhsahu@gmail.com";
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

// Maps a local (camelCase) tenant object to the DB (snake_case) row shape
// for a given room_id + bed_index. Shared by the insert and update paths in
// saveRoom so both stay in sync with the schema.
function tenantToDbFields(t, roomId, bedIndex) {
  return {
    room_id: roomId,
    bed_index: bedIndex,
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
  };
}

// Saves a room's tenants by DIFFING against what's already in the DB per
// bed, instead of deleting and reinserting everyone on every save.
//
// WHY THIS MATTERS: payments and security_deposits are linked to a tenant
// via their database row id (tenant_id). If we deleted and recreated every
// tenant row on every save — even ones nobody touched — an unrelated edit
// (fixing a room label, adding a bed) would silently give every existing
// tenant in that room a brand-new id, orphaning their entire payment and
// deposit history from that id. Under RLS, that makes a manager instantly
// lose visibility into a still-ACTIVE tenant's own payment history, and
// there's no way to tell it happened without digging into the database.
//
// So: same name in the same bed = same person = keep their existing id and
// just PATCH the fields that changed. Only a genuinely new/replaced tenant
// (empty bed filled, or a different name in that bed) gets a fresh row —
// and the old occupant, if any, still gets archived exactly as before.
async function saveRoom(room, tenants) {
  const id = `${room.floor}-${room.number}`;
  // Update room beds and label
  await sbFetch(
    `/rooms?id=eq.${id}`,
    "PATCH",
    { beds: room.beds, label: room.label },
    { "Prefer": "return=minimal" }
  );

  const existing = (await sbFetch(`/tenants?room_id=eq.${id}&select=*`)) || [];
  const existingByBed = {};
  existing.forEach(e => { existingByBed[e.bed_index] = e; });

  const toArchive = [];   // raw DB rows (snake_case) of people who left this bed
  const deleteIds = [];   // DB row ids to remove (superseded or cleared beds)
  const toUpdate = [];    // { id, bedIndex, tenant } — same person, fields changed
  const toInsert = [];    // { bedIndex, tenant } — new occupant for this bed

  // resultTenants mirrors the input array; we fill in dbId as we go so the
  // caller can update local state without needing a full reload to see IDs
  // for tenants that were just added.
  const resultTenants = tenants.map(t => ({ ...t }));

  tenants.forEach((t, bi) => {
    const ex = existingByBed[bi];
    const hasName = !!(t.name && t.name.trim() !== "");

    if (!ex && !hasName) return; // empty bed, nothing stored — no-op

    if (!ex && hasName) {
      toInsert.push({ bedIndex: bi, tenant: t });
      return;
    }

    if (ex && !hasName) {
      // Bed was cleared — archive the outgoing tenant (if they had a name)
      // and remove their row.
      if (ex.name && ex.name.trim() !== "") toArchive.push(ex);
      deleteIds.push(ex.id);
      return;
    }

    // ex exists and the form has a name for this bed
    if (ex.name !== t.name) {
      // Different name in the same bed = a new tenant replaced the old one.
      // Archive the outgoing tenant, delete their row, insert the new one
      // as a fresh row (so they get their own id and payment history).
      if (ex.name && ex.name.trim() !== "") toArchive.push(ex);
      deleteIds.push(ex.id);
      toInsert.push({ bedIndex: bi, tenant: t });
    } else {
      // Same person — update their existing row in place, KEEP their id.
      toUpdate.push({ id: ex.id, bedIndex: bi, tenant: t });
      resultTenants[bi].dbId = ex.id;
    }
  });

  if (toArchive.length > 0) {
    try {
      await archiveTenants(toArchive.map(t => ({
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
        // Their real database id, captured NOW while it still exists — this
        // is what lets the admin History tab link straight to their exact
        // payment/deposit history later, instead of guessing by name/room.
        tenantId: t.id,
      })), id, room.floor, room.number);
    } catch (e) { console.warn("Archive failed (table may not exist yet):", e); }
  }

  if (deleteIds.length > 0) {
    await sbFetch(
      `/tenants?id=in.(${deleteIds.join(",")})`,
      "DELETE",
      null,
      { "Prefer": "return=minimal" }
    );
  }

  // Update unchanged-identity tenants in place — id stays the same, so
  // their existing payments/deposits stay correctly linked.
  for (const u of toUpdate) {
    await sbFetch(
      `/tenants?id=eq.${u.id}`,
      "PATCH",
      tenantToDbFields(u.tenant, id, u.bedIndex),
      { "Prefer": "return=minimal" }
    );
  }

  // Insert genuinely new/replacement tenants and capture their new ids.
  if (toInsert.length > 0) {
    const payload = toInsert.map(ins => tenantToDbFields(ins.tenant, id, ins.bedIndex));
    const rows = await sbFetch("/tenants", "POST", payload, { "Prefer": "return=representation" });
    toInsert.forEach((ins, idx) => {
      const row = rows && rows[idx];
      if (row) resultTenants[ins.bedIndex].dbId = row.id;
    });
  }

  return resultTenants;
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
      tenant_id: t.tenantId || null,
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

// ── HOSTEL CONTACT DETAILS — printed on every receipt PDF's header ──
const HOSTEL_ADDRESS = "Gate No. 3, Medical Hub, Turiya Square, Plot No. 73, Scheme No. 166/3, Super Corridor, In Front of TCS, Tigaria Badshah, Indore, MP 453112";
const HOSTEL_PHONE = "9111157157";
const HOSTEL_LANDMARK = "5 min walk from TCS Gate No. 3";

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
  empty:   { bg: "#E7EEE3", border: "#8FB894", text: "#33623A", label: "Empty" },
  partial: { bg: "#F5F0DD", border: "#E3B95A", text: "#A8701A", label: "Partial" },
  full:    { bg: "#FBEAE5", border: "#C77C68", text: "#8F3120", label: "Full" },
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

// Used directly in phone input onChange handlers — strips anything that
// isn't a digit and hard-caps at 10 characters, so it's physically
// impossible to type an 11th digit or a stray letter/symbol into a phone
// field, instead of only catching it later at save time.
function sanitizePhoneInput(raw) {
  return (raw || "").replace(/\D/g, "").slice(0, 10);
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
    if (daysUntil <= 3) return { type: "due_soon", label: `Due in ${daysUntil} day${daysUntil>1?"s":""}`, color: "#C1861F", bg: "#FBF3E1", icon: "🟡", daysUntil, dueDay };
    return { type: "ok", label: `Due on ${ordinal(dueDay)}`, color: "#3C8F5C", bg: "#EBF3EC", icon: "🟢", daysUntil, dueDay };
  }
  if (daysDiff === 0) return { type: "due_today", label: "Due Today", color: "#C1543C", bg: "#FBEEEA", icon: "🔴", daysUntil: 0, dueDay };
  const daysOverdue = daysDiff;
  return { type: "overdue", label: `${daysOverdue} day${daysOverdue !== 1 ? "s" : ""} overdue`, color: "#8F3120", bg: "#FBEEEA", icon: "🔴", daysOverdue, dueDay };
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
    if (daysUntil <= 3) return { type: "due_soon", label: `Due in ${daysUntil} day${daysUntil>1?"s":""}`, color: "#C1861F", bg: "#FBF3E1", icon: "🟡", daysUntil, cycleStart, nextDue };
    return { type: "ok", label: `Due on ${dueLabel}`, color: "#3C8F5C", bg: "#EBF3EC", icon: "🟢", daysUntil, cycleStart, nextDue };
  }
  if (daysDiff === 0) return { type: "due_today", label: "Due Today", color: "#C1543C", bg: "#FBEEEA", icon: "🔴", daysUntil: 0, cycleStart, nextDue };
  const daysOverdue = daysDiff;
  return { type: "overdue", label: `${daysOverdue} day${daysOverdue !== 1 ? "s" : ""} overdue`, color: "#8F3120", bg: "#FBEEEA", icon: "🔴", daysOverdue, cycleStart, nextDue };
}

function isActiveForCycle15(isoDateStr, cycleStart) {
  if (!isoDateStr) return false;
  const d = new Date(isoDateStr);
  if (isNaN(d.getTime())) return false;
  return d >= cycleStart;
}

const inputStyle = {
  width: "100%", padding: "11px 12px", borderRadius: 8,
  border: "1.5px solid #E4DECF", fontSize: 15, outline: "none",
  boxSizing: "border-box", background: "#FAF7F0",
};

// ── CONTACT BUTTONS ───────────────────────────────────────────
function ContactButtons({ phone, size = "normal" }) {
  if (!phone) return null;
  const clean = phone.replace(/\D/g, "");
  // WhatsApp needs a country code to resolve the number correctly — a bare
  // 10-digit number with no prefix gets misread (defaults toward a wrong
  // country's numbering). Reuse the same normalizer used for validation so
  // "9876543210" and "+91 98765 43210" both resolve to the same wa.me link.
  const normalized = normalizePhone10(phone);
  const waNumber = normalized ? `91${normalized}` : clean;
  const isSmall = size === "small";
  return (
    <div style={{ display: "flex", gap: 6 }} onClick={e => e.stopPropagation()}>
      <a
        href={`tel:${clean}`}
        style={{
          display: "flex", alignItems: "center", gap: isSmall ? 3 : 5,
          padding: isSmall ? "4px 8px" : "6px 12px",
          background: "#1B1A17", color: "#fff", borderRadius: 8,
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
        href={`https://wa.me/${waNumber}`}
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
        <div style={{ background: "#1B1A17", color: "#fff", position: "sticky", top: 0, zIndex: 50, boxShadow: "0 2px 8px #0005", padding: "0 16px", height: 54, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 20 }}>🏨</span>
            <span style={{ fontWeight: 700, fontSize: 17, fontFamily: FONT_DISPLAY }}>Turiya Hostel</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", gap: 10, fontSize: 12, color: "#9C9585" }}>
              <span>🛏 <b style={{ color: "#E4DECF" }}>{allStats.totalBeds}</b></span>
              <span>👤 <b style={{ color: "#C7A050" }}>{allStats.totalOcc}</b></span>
            </div>
            <button onClick={supabaseAuth.signOut} style={{ background: "#ffffff18", border: "none", borderRadius: 8, padding: "6px 12px", color: "#E4DECF", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>Sign out</button>
          </div>
        </div>
        {/* Bottom tab bar */}
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#1B1A17", zIndex: 50, display: "flex", borderTop: "1px solid #ffffff15", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {NAV_ITEMS.map(n => (
            <button key={n.id} onClick={() => setPage(n.id)} style={{
              flex: 1, padding: "9px 4px 11px", border: "none", background: "none",
              color: page === n.id ? "#C7A050" : "#9C9585",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
              cursor: "pointer", position: "relative",
              borderTop: page === n.id ? "2.5px solid #C7A050" : "2.5px solid transparent",
            }}>
              <span style={{ fontSize: 19 }}>{n.icon}</span>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.2px" }}>{n.label}</span>
              {n.id === "rent" && rentAlerts > 0 && (
                <span style={{ position: "absolute", top: 4, right: "50%", transform: "translateX(10px)", background: "#C1543C", color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 99, minWidth: 15, height: 15, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 3px" }}>{rentAlerts}</span>
              )}
            </button>
          ))}
        </div>
      </>
    );
  }

  // Desktop nav
  return (
    <div style={{ background: "#1B1A17", color: "#fff", position: "sticky", top: 0, zIndex: 50, boxShadow: "0 2px 12px #0005" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", alignItems: "center", height: 64, padding: "0 20px", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: 28 }}>
          <span style={{ fontSize: 22 }}>🏨</span>
          <span style={{ fontWeight: 700, fontSize: 19, letterSpacing: "-0.3px", fontFamily: FONT_DISPLAY }}>HostelDesk</span>
        </div>
        <div style={{ display: "flex", gap: 2, flex: 1 }}>
          {NAV_ITEMS.map(n => (
            <button key={n.id} onClick={() => setPage(n.id)} style={{
              padding: "8px 16px", borderRadius: 8, border: "none",
              background: page === n.id ? "#ffffff18" : "transparent",
              color: page === n.id ? "#fff" : "#C9C2B4",
              fontWeight: 700, fontSize: 14, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 6,
              borderBottom: page === n.id ? "2.5px solid #C7A050" : "2.5px solid transparent",
              position: "relative",
            }}>
              <span>{n.icon}</span>
              <span>{n.label}</span>
              {n.id === "rent" && rentAlerts > 0 && (
                <span style={{ background: "#C1543C", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 99, minWidth: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px", marginLeft: 2 }}>{rentAlerts}</span>
              )}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 13, color: "#C9C2B4", flexShrink: 0, alignItems: "center" }}>
          <span>🛏 <b style={{ color: "#fff" }}>{allStats.totalBeds}</b></span>
          <span>👤 <b style={{ color: "#C7A050" }}>{allStats.totalOcc}</b></span>
          <span>✅ <b style={{ color: "#6FAE84" }}>{allStats.totalBeds - allStats.totalOcc}</b></span>
          {user && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: 8, paddingLeft: 14, borderLeft: "1px solid #ffffff22" }}>
              <span style={{ fontSize: 11.5, background: role === "admin" ? "#33417A" : role === "manager" ? "#2F6B44" : "#A9822F", color: "#fff", padding: "3px 10px", borderRadius: 99, fontWeight: 700, textTransform: "capitalize" }}>{role}</span>
              <button onClick={supabaseAuth.signOut} style={{ background: "#ffffff18", border: "none", borderRadius: 8, padding: "6px 14px", color: "#E4DECF", fontSize: 13, cursor: "pointer", fontWeight: 700 }}>Sign out</button>
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
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#E4DECF" strokeWidth="10" />
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
      <div style={{ width: 10, height: `${Math.max(4, (a / max) * 28)}px`, background: "#E4DECF", borderRadius: 2 }} title="Last month" />
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

  const barColors = ["#33417A", "#6B4E86", "#A9822F", "#3D7A6E", "#A8375F"];

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
        <h1 style={{ fontSize: 28, fontWeight: 600, margin: "0 0 3px", letterSpacing: "-0.3px", color: "#1B1A17", fontFamily: FONT_DISPLAY }}>Dashboard</h1>
        <p style={{ margin: 0, color: "#6B6459", fontSize: 14.5 }}>3 floors · {all.length} rooms · {totalBeds} beds total</p>
      </div>

      {/* Rent alerts banner (managers/admins only) */}
      {isManager && (overdue.length > 0 || dueToday.length > 0 || dueSoon.length > 0) && (
        <div style={{ marginBottom: 20, display: "flex", flexDirection: "column", gap: 8 }}>
          {overdue.length > 0 && (
            <div onClick={() => setPage("rent")} style={{ background: "#FBEEEA", border: "1.5px solid #8F3120", borderRadius: 12, padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 20 }}>🔴</span>
              <div style={{ flex: 1 }}>
                <b style={{ color: "#8F3120" }}>Rent OVERDUE</b> — {overdue.length} tenant{overdue.length > 1 ? "s" : ""}: {overdue.slice(0,3).map(t => `${t.name} (${t.rentStatus.daysOverdue}d)`).join(", ")}{overdue.length > 3 ? ` +${overdue.length-3} more` : ""}
              </div>
              <span style={{ fontSize: 12, color: "#8F3120", fontWeight: 600 }}>View →</span>
            </div>
          )}
          {dueToday.length > 0 && (
            <div onClick={() => setPage("rent")} style={{ background: "#FBEEEA", border: "1.5px solid #DDA79A", borderRadius: 12, padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 20 }}>🔴</span>
              <div style={{ flex: 1 }}>
                <b style={{ color: "#C1543C" }}>Rent due TODAY</b> — {dueToday.length} tenant{dueToday.length > 1 ? "s" : ""}: {dueToday.slice(0,3).map(t => t.name).join(", ")}{dueToday.length > 3 ? ` +${dueToday.length-3} more` : ""}
              </div>
              <span style={{ fontSize: 12, color: "#C1543C", fontWeight: 600 }}>View →</span>
            </div>
          )}
          {dueSoon.length > 0 && (
            <div onClick={() => setPage("rent")} style={{ background: "#FBF3E1", border: "1.5px solid #E3B45C", borderRadius: 12, padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 20 }}>🟡</span>
              <div style={{ flex: 1 }}>
                <b style={{ color: "#A8701A" }}>Rent due soon</b> — {dueSoon.length} tenant{dueSoon.length > 1 ? "s" : ""} in the next 3 days
              </div>
              <span style={{ fontSize: 12, color: "#A8701A", fontWeight: 600 }}>View →</span>
            </div>
          )}
        </div>
      )}

      {/* This Month vs Last Month trend */}
      {isManager && (
        <div style={{ background: "#fff", borderRadius: 14, padding: 16, marginBottom: 18, boxShadow: "0 1px 4px #0001" }}>
          <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 2 }}>📈 This Month vs Last Month</div>
          <div style={{ fontSize: 12, color: "#9C9585", marginBottom: 14 }}>{today.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}</div>
          {trendPayments === null || trendDeposits === null ? (
            <div style={{ textAlign: "center", color: "#9C9585", padding: 10, fontSize: 13 }}>Loading trend data…</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
              <div>
                <div style={{ fontSize: 11, color: "#9C9585", fontWeight: 700 }}>RENT COLLECTED</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#1B1A17" }}>₹{rentThisTotal.toLocaleString("en-IN")}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: rentChangePct >= 0 ? "#2F6B44" : "#A83D2A" }}>
                  {rentChangePct >= 0 ? "▲" : "▼"} {Math.abs(rentChangePct)}% <span style={{ color: "#9C9585", fontWeight: 500 }}>vs ₹{rentLastTotal.toLocaleString("en-IN")} last month</span>
                </div>
                <MiniCompareBars a={rentLastTotal} b={rentThisTotal} color="#33417A" />
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#9C9585", fontWeight: 700 }}>DEPOSITS COLLECTED</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#1B1A17" }}>₹{depositsThisTotal.toLocaleString("en-IN")}</div>
                <div style={{ fontSize: 12, color: "#9C9585" }}>vs ₹{depositsLastTotal.toLocaleString("en-IN")} last month</div>
                <MiniCompareBars a={depositsLastTotal} b={depositsThisTotal} color="#6B4E86" />
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#9C9585", fontWeight: 700 }}>DEPOSITS CURRENTLY HELD</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#1B1A17" }}>₹{depositsHeldNow.toLocaleString("en-IN")}</div>
                <div style={{ fontSize: 12, color: "#9C9585" }}>live snapshot, not a monthly trend</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#9C9585", fontWeight: 700 }}>NEW TENANTS</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#1B1A17" }}>{newTenantsThisMonth}</div>
                <div style={{ fontSize: 12, color: "#9C9585" }}>vs {newTenantsLastMonth} last month</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* KPI Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10, marginBottom: 18 }}>
        {[
          { icon: "🛏", label: "Total Beds", value: totalBeds, color: "#33417A", bg: "#EDEFF7" },
          { icon: "👤", label: "Occupied", value: totalOcc, color: "#C1543C", bg: "#FBEEEA", goTo: "search" },
          { icon: "✅", label: "Available", value: totalFree, color: "#2F6B44", bg: "#EBF3EC", statusFilter: "partial" },
          { icon: "🏠", label: "Total Rooms", value: all.length, color: "#6B4E86", bg: "#F1ECF5", statusFilter: "all" },
          { icon: "🔴", label: "Full Rooms", value: fullRooms, color: "#A8481F", bg: "#fff7ed", statusFilter: "full" },
          { icon: "🟡", label: "Partial", value: partialRooms, color: "#A9822F", bg: "#FBF6E3", statusFilter: "partial" },
          { icon: "🟢", label: "Empty", value: emptyRooms, color: "#3D7A6E", bg: "#EAF3EC", statusFilter: "empty" },
          { icon: "📊", label: "Occupancy", value: `${occPct}%`, color: "#3A4A8F", bg: "#ECEEF7" },
        ].map(c => (
          <div key={c.label}
            onClick={c.statusFilter ? () => { setRoomsInitialStatusFilter(c.statusFilter); setPage("rooms"); } : c.goTo ? () => setPage(c.goTo) : undefined}
            style={{ background: c.bg, borderRadius: 12, padding: "16px 18px", border: `1.5px solid ${c.color}33`, cursor: (c.statusFilter || c.goTo) ? "pointer" : "default" }}>
            <div style={{ fontSize: 20, marginBottom: 6 }}>{c.icon}</div>
            <div style={{ fontSize: 27, fontWeight: 600, color: c.color, lineHeight: 1, fontFamily: FONT_DISPLAY }}>{c.value}</div>
            <div style={{ fontSize: 12, color: "#57524A", marginTop: 4, fontWeight: 600 }}>{c.label}{(c.statusFilter || c.goTo) && " →"}</div>
          </div>
        ))}
      </div>

      {/* Minimal room-composition bar — visual complement to the numbers above */}
      {all.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", borderRadius: 10, overflow: "hidden", height: 14, boxShadow: "0 1px 3px #0001" }}>
            {fullRooms > 0 && <div style={{ width: `${(fullRooms/all.length)*100}%`, background: "#A8481F" }} title={`${fullRooms} full`} />}
            {partialRooms > 0 && <div style={{ width: `${(partialRooms/all.length)*100}%`, background: "#A9822F" }} title={`${partialRooms} partial`} />}
            {emptyRooms > 0 && <div style={{ width: `${(emptyRooms/all.length)*100}%`, background: "#3D7A6E" }} title={`${emptyRooms} empty`} />}
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 6, fontSize: 12, color: "#57524A", flexWrap: "wrap" }}>
            <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "#A8481F", marginRight: 4 }} />Full {fullRooms}</span>
            <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "#A9822F", marginRight: 4 }} />Partial {partialRooms}</span>
            <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "#3D7A6E", marginRight: 4 }} />Empty {emptyRooms}</span>
          </div>
        </div>
      )}

      {/* Two col */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 18, marginBottom: 18 }}>
        {/* Occupancy card */}
        <div style={{ background: "#fff", borderRadius: 14, padding: "20px", boxShadow: "0 1px 4px #0001" }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16 }}>Overall Occupancy</div>
          <div style={{ display: "flex", alignItems: "center", gap: 24, marginBottom: 16 }}>
            <DonutChart pct={occPct} color="#33417A" size={90} />
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[{ label: "Occupied", value: totalOcc, color: "#C1543C" }, { label: "Free", value: totalFree, color: "#2F6B44" }].map(item => (
                <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 9, height: 9, borderRadius: "50%", background: item.color }} />
                  <span style={{ fontSize: 13.5, color: "#3A362E" }}>{item.label}</span>
                  <span style={{ fontWeight: 700, marginLeft: "auto", paddingLeft: 12, fontSize: 15 }}>{item.value}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ borderTop: "1px solid #F2EEE4", paddingTop: 14 }}>
            <div style={{ fontSize: 11, color: "#9C9585", fontWeight: 600, marginBottom: 8 }}>ROOM STATUS</div>
            <div style={{ display: "flex", gap: 8 }}>
              {[{ label: "Full", value: fullRooms, color: "#C1543C", bg: "#FBEEEA", statusFilter: "full" }, { label: "Partial", value: partialRooms, color: "#C1861F", bg: "#FBF3E1", statusFilter: "partial" }, { label: "Empty", value: emptyRooms, color: "#3C8F5C", bg: "#EBF3EC", statusFilter: "empty" }].map(s => (
                <div key={s.label} onClick={() => { setRoomsInitialStatusFilter(s.statusFilter); setPage("rooms"); }} style={{ flex: 1, textAlign: "center", background: s.bg, borderRadius: 8, padding: "8px 4px", cursor: "pointer" }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: 10, color: "#6B6459" }}>{s.label}</div>
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
                style={{ marginBottom: 14, cursor: "pointer", padding: "10px 12px", borderRadius: 10, border: "1px solid #F2EEE4", transition: "border-color 0.15s" }}
                onMouseEnter={e => e.currentTarget.style.borderColor = barColors[idx]}
                onMouseLeave={e => e.currentTarget.style.borderColor = "#F2EEE4"}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{FLOOR_LABELS[fs.f]}</span>
                  <span style={{ fontSize: 12, color: "#6B6459" }}>{fs.occ}/{fs.beds} beds ({pct}%)</span>
                </div>
                <div style={{ height: 7, background: "#F2EEE4", borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, background: barColors[idx], borderRadius: 99 }} />
                </div>
                <div style={{ marginTop: 5, fontSize: 11, color: "#9C9585" }}>{fs.full} full · {fs.empty} empty · Click to manage →</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Floor detail + recent tenants */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 18 }}>
        {floorStats.map((fs, idx) => (
          <div key={fs.f} onClick={() => { setActiveFloor(fs.f); setPage("rooms"); }}
            style={{ background: "#fff", borderRadius: 12, padding: "16px", boxShadow: "0 1px 4px #0001", cursor: "pointer", border: "1.5px solid #F2EEE4", transition: "border-color 0.15s, box-shadow 0.15s" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = barColors[idx]; e.currentTarget.style.boxShadow = "0 4px 16px #0002"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#F2EEE4"; e.currentTarget.style.boxShadow = "0 1px 4px #0001"; }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{FLOOR_LABELS[fs.f]}</span>
              <span style={{ fontSize: 10, background: barColors[idx] + "22", color: barColors[idx], fontWeight: 700, padding: "2px 8px", borderRadius: 99 }}>{fs.beds > 0 ? Math.round((fs.occ/fs.beds)*100) : 0}%</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
              {[{ label: "Beds", value: fs.beds }, { label: "Occupied", value: fs.occ }, { label: "Full rooms", value: fs.full }, { label: "Empty", value: fs.empty }].map(item => (
                <div key={item.label} style={{ background: "#FAF7F0", borderRadius: 8, padding: "8px 10px" }}>
                  <div style={{ fontSize: 17, fontWeight: 700 }}>{item.value}</div>
                  <div style={{ fontSize: 10, color: "#9C9585" }}>{item.label}</div>
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
          <button onClick={() => setPage("search")} style={{ fontSize: 13, color: "#33417A", background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>Search all →</button>
        </div>
        {recentTenants.length === 0
          ? <div style={{ textAlign: "center", padding: "24px 0", color: "#9C9585", fontSize: 14 }}>No tenants yet. Add from the Rooms page.</div>
          : <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {recentTenants.map((t, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", background: "#FAF7F0", borderRadius: 10, border: "1px solid #E4DECF" }}>
                  <div style={{ width: 34, height: 34, borderRadius: "50%", background: "#1B1A17", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14, flexShrink: 0 }}>
                    {t.name.charAt(0).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</div>
                    <div style={{ fontSize: 12, color: "#9C9585" }}>Floor {t.floor} · Room {t.roomNumber} · Bed {t.bed}</div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    {t.phone && <div style={{ fontSize: 12, color: "#3A362E" }}>📞 {t.phone}</div>}
                    {t.admissionDate && <div style={{ fontSize: 11, color: "#9C9585" }}>{fmt(t.admissionDate)}</div>}
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
    const headers = ["Name", "Phone", "Aadhar ID", "Floor", "Room", "Bed", "Rent Amount", "Billing Type", "Admission Date", "Father Name", "Father Phone", "Guardian Name", "Guardian Phone"];
    const data = results
      .slice()
      .sort((a, b) => (a.floor - b.floor) || (a.roomNumber - b.roomNumber) || (a.bed - b.bed))
      .map(t => [
        t.name, t.phone || "", t.aadharId || "", FLOOR_LABELS[t.floor] || `Floor ${t.floor}`, t.roomNumber, t.bed,
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
          <h1 style={{ fontSize: 24, fontWeight: 600, margin: "0 0 3px", fontFamily: FONT_DISPLAY }}>Tenant Search</h1>
          <p style={{ margin: 0, color: "#6B6459", fontSize: 14 }}>{allTenants.length} tenants across all floors</p>
        </div>
        {isAdmin && (
          <button onClick={exportCurrentTenantsCSV} style={{ padding: "9px 14px", borderRadius: 10, border: "1.5px solid #A8CDB0", background: "#EBF3EC", color: "#2F6B44", fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}>
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
          style={{ ...inputStyle, paddingLeft: 40, fontSize: 15, padding: "12px 14px 12px 40px", borderRadius: 12, border: "2px solid #E4DECF" }}
        />
        {query && (
          <button onClick={() => setQuery("")} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "#E4DECF", border: "none", borderRadius: "50%", width: 22, height: 22, cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        )}
      </div>

      {isManager && companies.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: "#6B6459", display: "block", marginBottom: 6 }}>FILTER BY COMPANY / PLACE</label>
          <select value={companyFilter} onChange={e => setCompanyFilter(e.target.value)} style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1.5px solid #E4DECF", fontSize: 14, background: "#fff" }}>
            <option value="all">All companies/places</option>
            {companies.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      )}

      <div style={{ fontSize: 13, color: "#9C9585", marginBottom: 12 }}>
        {(query || companyFilter !== "all") ? `${results.length} result${results.length !== 1 ? "s" : ""}${query ? ` for "${query}"` : ""}${companyFilter !== "all" ? ` at ${companyFilter}` : ""}` : `Showing all ${results.length} tenants`}
      </div>

      {results.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 0", color: "#9C9585" }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🔍</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>No tenants found</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>Try a different name or phone number</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {results.map((t, i) => (
            <div key={i} onClick={() => { setActiveFloor(t.floor); setPage("rooms"); }}
              style={{ background: "#fff", borderRadius: 12, padding: "14px 16px", border: "1.5px solid #E4DECF", cursor: "pointer", display: "flex", alignItems: "center", gap: 14, transition: "border-color 0.15s, box-shadow 0.15s" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "#33417A"; e.currentTarget.style.boxShadow = "0 2px 12px #0002"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "#E4DECF"; e.currentTarget.style.boxShadow = "none"; }}>
              <div style={{ width: 42, height: 42, borderRadius: "50%", background: "#1B1A17", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 17, flexShrink: 0 }}>
                {t.name.charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{t.name}</div>
                <div style={{ fontSize: 12, color: "#6B6459", marginTop: 2 }}>
                  Floor {t.floor} · Room {t.roomNumber}{t.roomLabel ? ` (${t.roomLabel})` : ""} · Bed {t.bed}
                </div>
                {isManager && t.admissionDate && (
                  <div style={{ fontSize: 11, color: "#9C9585", marginTop: 2 }}>Admitted: {fmt(t.admissionDate)}</div>
                )}
                {isManager && t.fatherName && <div style={{ fontSize: 11, color: "#6B6459", marginTop: 1 }}>👨 Father: {t.fatherName}{t.fatherPhone ? ` · ${t.fatherPhone}` : ""}</div>}
                {isManager && t.guardianName && <div style={{ fontSize: 11, color: "#6B6459", marginTop: 1 }}>🛡️ Guardian: {t.guardianName}{t.guardianPhone ? ` · ${t.guardianPhone}` : ""}</div>}
                {isManager && (t.city || t.address) && <div style={{ fontSize: 11, color: "#6B6459", marginTop: 1 }}>📍 {[t.city, t.address].filter(Boolean).join(", ")}</div>}
                {isManager && t.occupationPlace && <div style={{ fontSize: 11, color: "#6B6459", marginTop: 1 }}>💼 {t.occupation === "job" ? "Works at" : t.occupation === "college" ? "Studies at" : "At"}: {t.occupationPlace}{t.occupationId ? ` (ID: ${t.occupationId})` : ""}</div>}
                {isManager && t.reasonToStay && <div style={{ fontSize: 11, color: "#9C9585", marginTop: 1, fontStyle: "italic" }}>"{t.reasonToStay}"</div>}
                {isManager && t.rentAmount && <div style={{ fontSize: 12, fontWeight: 700, color: "#2F6B44", marginTop: 2 }}>💰 ₹{Number(t.rentAmount).toLocaleString("en-IN")}/month</div>}
                {isManager && t.depositAmount && (
                  <div style={{ fontSize: 11, fontWeight: 700, marginTop: 2, color: t.depositReturnedOn ? "#6B6459" : t.depositPaidOn ? "#33417A" : "#8C6215" }}>
                    🔒 ₹{Number(t.depositAmount).toLocaleString("en-IN")} deposit — {t.depositReturnedOn ? "Returned" : t.depositPaidOn ? "Held" : "Pending"}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                {t.phone && <div style={{ fontSize: 12, color: "#6B6459" }}>{t.phone}</div>}
                <ContactButtons phone={t.phone} />
                <div style={{ fontSize: 11, color: "#33417A", fontWeight: 600 }}>View room →</div>
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
            border: mode === m ? "2px solid #3C8F5C" : "1.5px solid #E4DECF",
            background: mode === m ? "#EBF3EC" : "#fff",
            color: mode === m ? "#2F6B44" : "#6B6459",
          }}>{m}</button>
        ))}
      </div>
      {mode === "Other" && (
        <input value={otherText} onChange={e => setOtherText(e.target.value)} placeholder="Optional — describe payment mode"
          style={{ width: "100%", marginTop: 8, padding: "9px 12px", borderRadius: 9, border: "1.5px solid #E4DECF", fontSize: 13, boxSizing: "border-box" }} />
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
      <div style={{ fontSize: 12, fontWeight: 700, color: "#6B6459", marginBottom: 8 }}>SEARCH A TENANT'S PAYMENT HISTORY</div>
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Type tenant name…"
        style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: "1.5px solid #E4DECF", fontSize: 14, boxSizing: "border-box", marginBottom: 14 }}
      />
      {loading && <div style={{ textAlign: "center", color: "#9C9585", padding: 20 }}>Loading payment history…</div>}
      {!loading && term.length === 0 && (
        <div style={{ textAlign: "center", color: "#9C9585", padding: 10, fontSize: 13 }}>Start typing a name to see every rent payment they've ever made.</div>
      )}
      {!loading && term.length > 0 && sorted.length === 0 && (
        <div style={{ textAlign: "center", color: "#9C9585", padding: 10, fontSize: 13 }}>No payments found matching "{search}".</div>
      )}
      {!loading && sorted.length > 0 && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, padding: "8px 10px", background: "#FAF7F0", borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: "#6B6459", fontWeight: 700 }}>{sorted.length} payment{sorted.length !== 1 ? "s" : ""} found</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#2F6B44" }}>₹{total.toLocaleString("en-IN")} total</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {sorted.map(p => (
              <div key={p.id || p.receipt_no} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#FAF7F0", borderRadius: 8, padding: "8px 10px" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1B1A17" }}>{p.tenant_name}</div>
                  <div style={{ fontSize: 11, color: "#9C9585" }}>
                    {FLOOR_LABELS[p.floor] || "Floor " + p.floor} · Room {p.room_number} · {fmtDateIST(new Date(p.paid_at), { day: "numeric", month: "short", year: "numeric" })} · {p.payment_mode || "mode not set"}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: "#2F6B44" }}>₹{Number(p.amount || 0).toLocaleString("en-IN")}</div>
                  <button onClick={() => reprint(p)} style={{ padding: "5px 10px", borderRadius: 7, border: "1.5px solid #A9B3D9", background: "#EDEFF7", color: "#33417A", fontWeight: 700, fontSize: 11, cursor: "pointer" }}>🧾 Reprint</button>
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
    return <div style={{ background: "#fff", borderRadius: 12, padding: 30, textAlign: "center", color: "#9C9585", marginBottom: 14 }}>Loading payment history…</div>;
  }
  if (!paymentsLog || paymentsLog.length === 0) {
    return <div style={{ background: "#fff", borderRadius: 12, padding: 30, textAlign: "center", color: "#9C9585", marginBottom: 14 }}>No payments recorded yet. Once you start marking rent as paid, monthly and yearly totals will show up here — including for tenants who later check out.</div>;
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
          <div style={{ fontSize: 11, color: "#9C9585", fontWeight: 700 }}>TOTAL COLLECTED IN {reportYear}</div>
          <div style={{ fontSize: 28, fontWeight: 600, color: "#1B1A17", fontFamily: FONT_DISPLAY }}>₹{yearTotal.toLocaleString("en-IN")}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={exportYearCSV} style={{ padding: "8px 14px", borderRadius: 8, border: "1.5px solid #A8CDB0", background: "#EBF3EC", color: "#2F6B44", fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}>⬇️ Export CSV</button>
          <select value={reportYear} onChange={e => { setReportYear(Number(e.target.value)); setExpandedMonth(null); }} style={{ padding: "8px 12px", borderRadius: 8, border: "1.5px solid #E4DECF", fontWeight: 700, fontSize: 14 }}>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {monthly.map(m => (
          <div key={m.name}>
            <div onClick={() => m.count > 0 && setExpandedMonth(x => x === m.monthIndex ? null : m.monthIndex)}
              style={{ display: "flex", alignItems: "center", gap: 10, cursor: m.count > 0 ? "pointer" : "default", padding: "4px 6px", borderRadius: 8, background: expandedMonth === m.monthIndex ? "#FAF7F0" : "transparent" }}>
              <div style={{ width: 32, fontSize: 12, fontWeight: 700, color: "#6B6459" }}>{m.name}</div>
              <div style={{ flex: 1, background: "#F2EEE4", borderRadius: 6, height: 20, position: "relative", overflow: "hidden" }}>
                <div style={{ width: `${(m.total / maxMonth) * 100}%`, background: m.total > 0 ? "#33417A" : "transparent", height: "100%", borderRadius: 6, transition: "width 0.3s" }} />
              </div>
              <div style={{ width: 90, textAlign: "right", fontSize: 12.5, fontWeight: 700, color: "#1B1A17" }}>₹{m.total.toLocaleString("en-IN")}</div>
              <div style={{ width: 22, textAlign: "right", fontSize: 10.5, color: "#9C9585" }}>{m.count}</div>
              <div style={{ width: 14, textAlign: "center", fontSize: 10, color: "#9C9585" }}>{m.count > 0 ? (expandedMonth === m.monthIndex ? "▲" : "▼") : ""}</div>
            </div>
            {expandedMonth === m.monthIndex && (
              <div style={{ margin: "6px 4px 10px", background: "#FAF7F0", borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                {m.rows.map(p => (
                  <div key={p.id || p.receipt_no} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#fff", borderRadius: 8, padding: "8px 10px", boxShadow: "0 1px 2px #0001" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#1B1A17" }}>{p.tenant_name}</div>
                      <div style={{ fontSize: 11, color: "#9C9585" }}>
                        {FLOOR_LABELS[p.floor] || "Floor " + p.floor} · Room {p.room_number} · {fmtDateIST(new Date(p.paid_at), { day: "numeric", month: "short" })} · {p.payment_mode || "mode not set"}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: "#2F6B44" }}>₹{Number(p.amount || 0).toLocaleString("en-IN")}</div>
                      <button onClick={() => reprint(p)} style={{ padding: "5px 10px", borderRadius: 7, border: "1.5px solid #A9B3D9", background: "#EDEFF7", color: "#33417A", fontWeight: 700, fontSize: 11, cursor: "pointer" }}>🧾 Reprint</button>
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
// NOTE: visual redesign of this receipt is planned as the NEXT step (after
// the color-theme pass) — left functionally identical for now so nothing
// about payment records/printing changes mid-theme-update.
function generateReceiptPDF({ name, phone, floorLabel, roomNumber, paidDate, amount, mode, receiptNo, cycleNote, note = "", docTitle = "Rent Receipt", amountLabel = "AMOUNT PAID", fileTag = "" }) {
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) { alert("PDF library still loading — try again in a moment."); return; }

  const PAGE_W = 320, MARGIN = 24, CONTENT_W = PAGE_W - MARGIN * 2;
  // Deposit receipts get a blue accent, rent receipts get green — matches the
  // same color language used for "held/blue" vs "paid/green" in the app itself.
  const isDeposit = /deposit/i.test(docTitle);
  const accent = isDeposit ? [29, 78, 216] : [21, 128, 61];
  const accentTint = isDeposit ? [239, 246, 255] : [240, 253, 244];

  const doc = new jsPDF({ unit: "pt", format: [PAGE_W, 540] });

  // ── HEADER BAND — solid navy letterhead with hostel name, doc type/receipt
  // no. in gold, and the hostel's address/phone/landmark underneath, so the
  // receipt is self-identifying even if it's printed loose or forwarded. ──
  doc.setFillColor(26, 35, 50);
  doc.rect(0, 0, PAGE_W, 100, "F");

  doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.setTextColor(255, 255, 255);
  doc.text("Turiya Hostel", MARGIN, 28);

  doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(224, 168, 62);
  doc.text(`${docTitle.toUpperCase()} · NO. ${receiptNo}`, MARGIN, 41);

  doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(198, 208, 224);
  const addrLines = doc.splitTextToSize(HOSTEL_ADDRESS, CONTENT_W);
  doc.text(addrLines, MARGIN, 53);
  const afterAddrY = 53 + (addrLines.length - 1) * 8.5;

  doc.setFontSize(7); doc.setTextColor(224, 168, 62);
  doc.text(`Ph: ${HOSTEL_PHONE}   |   ${HOSTEL_LANDMARK}`, MARGIN, afterAddrY + 12);

  // ── BODY ROWS ──
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

  let y = 128;
  doc.setFontSize(10.5);
  rows.forEach(([label, value]) => {
    doc.setFont("helvetica", "normal"); doc.setTextColor(100, 116, 139); doc.text(label, MARGIN, y);
    doc.setFont("helvetica", "bold"); doc.setTextColor(15, 23, 42);
    const valueLines = doc.splitTextToSize(String(value), 170);
    doc.text(valueLines, PAGE_W - MARGIN, y, { align: "right" });
    doc.setDrawColor(226, 232, 240); doc.setLineWidth(0.75);
    doc.line(MARGIN, y + 8 + (valueLines.length - 1) * 12, PAGE_W - MARGIN, y + 8 + (valueLines.length - 1) * 12);
    y += 26 + (valueLines.length - 1) * 12;
  });

  // ── AMOUNT BLOCK — rounded, tinted box so the amount is the clear visual
  // focal point instead of just another line of text. ──
  const boxY = y + 14, boxH = 74;
  doc.setFillColor(...accentTint);
  doc.roundedRect(MARGIN, boxY, CONTENT_W, boxH, 10, 10, "F");
  doc.setDrawColor(...accent); doc.setLineWidth(1.2);
  doc.roundedRect(MARGIN, boxY, CONTENT_W, boxH, 10, 10, "S");

  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(100, 116, 139);
  doc.text(amountLabel, PAGE_W / 2, boxY + 20, { align: "center" });
  doc.setFont("helvetica", "bold"); doc.setFontSize(26); doc.setTextColor(...accent);
  doc.text(`Rs ${Number(amount || 0).toLocaleString("en-IN")}`, PAGE_W / 2, boxY + 52, { align: "center" });

  // ── FOOTER ──
  const footerY = boxY + boxH + 26;
  doc.setDrawColor(226, 232, 240); doc.setLineWidth(0.75);
  doc.line(MARGIN, footerY - 14, PAGE_W - MARGIN, footerY - 14);
  doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(150, 160, 175);
  doc.text("This is a system-generated receipt. Keep it for your records.", PAGE_W / 2, footerY, { align: "center" });

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
        tenant_id: t.dbId || null,
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
    const billingType = t.billingType || "monthly";
    const is15 = billingType === "15day";
    const isDaily = billingType === "daily";
    generateReceiptPDF({
      name: t.name,
      phone: t.phone,
      floorLabel: FLOOR_LABELS[t.floor] || "Floor " + t.floor,
      roomNumber: t.roomNumber,
      paidDate,
      amount: t.rentAmount,
      mode: t.rentPaymentMode,
      receiptNo,
      cycleNote: isDaily
        ? `Per Day · ${fmtDateIST(paidDate, { day: "numeric", month: "short", year: "numeric" })}`
        : is15
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
    shown = shown.fil