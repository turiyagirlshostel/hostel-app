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

function makeBeds(count, e