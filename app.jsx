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
      checkout_date: t.checkoutDate || new Date().toISOString().slice(0,10),
      billing_type: t.billingType || "monthly",
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
  return Array.from({ length: count }, (_, i) => existing[i] || { name: "", admissionDate: "", phone: "", billingType: "monthly", checkoutDate: "", aadharId: "", fatherName: "", fatherPhone: "", guardianName: "", guardianPhone: "", address: "", city: "", occupation: "", occupationPlace: "", occupationId: "", reasonToStay: "", rentAmount: "", rentPaidOn: "", rentSnoozedAt: "", rentPaymentMode: "", rentReceiptNo: "" });
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
function generateReceiptNo(isoString) {
  const d = new Date(isoString);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `RC-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(),3)}`;
}

function fmt(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
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
      if (t.name.trim()) list.push({ ...t, floor: room.floor, roomNumber: room.number, bed: bi + 1, roomLabel: room.label, fatherName: t.fatherName||'', fatherPhone: t.fatherPhone||'', guardianName: t.guardianName||'', guardianPhone: t.guardianPhone||'', address: t.address||'', city: t.city||'', occupation: t.occupation||'', occupationPlace: t.occupationPlace||'', occupationId: t.occupationId||'', reasonToStay: t.reasonToStay||'', rentAmount: t.rentAmount||'' });
    });
  });
  return list;
}

// Rent due logic
function getRentStatus(admissionDate, today) {
  if (!admissionDate) return null;
  const ad = new Date(admissionDate + "T00:00:00");
  const dueDay = ad.getDate();
  const todayDay = today.getDate();
  const diff = dueDay - todayDay;
  if (diff === 0) return { type: "due_today", label: "Due Today", color: "#ef4444", bg: "#fef2f2", icon: "🔴", daysUntil: 0, dueDay };
  if (diff > 0 && diff <= 3) return { type: "due_soon", label: `Due in ${diff} day${diff>1?"s":""}`, color: "#f59e0b", bg: "#fffbeb", icon: "🟡", daysUntil: diff, dueDay };
  if (diff < 0) {
    // next month
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const daysLeft = daysInMonth - todayDay + dueDay;
    if (daysLeft <= 3) return { type: "due_soon", label: `Due in ${daysLeft} day${daysLeft>1?"s":""}`, color: "#f59e0b", bg: "#fffbeb", icon: "🟡", daysUntil: daysLeft, dueDay };
  }
  return { type: "ok", label: `Due on ${ordinal(dueDay)}`, color: "#22c55e", bg: "#f0fdf4", icon: "🟢", daysUntil: diff < 0 ? (new Date(today.getFullYear(), today.getMonth()+1,0).getDate()-todayDay+dueDay) : diff, dueDay };
}

// Start of the current billing cycle (the most recent occurrence of dueDay on/before today)
function getCycleStart(dueDay, today) {
  const todayDay = today.getDate();
  let year = today.getFullYear();
  let month = today.getMonth();
  if (todayDay < dueDay) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
  }
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const day = Math.min(dueDay, daysInMonth);
  return new Date(year, month, day);
}

// Is a stored timestamp (paid-on / snoozed-at) still valid for the current billing cycle?
function isActiveForCycle(isoDateStr, dueDay, today) {
  if (!isoDateStr) return false;
  const cycleStart = getCycleStart(dueDay, today);
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
function HomePage({ rooms, setPage, setActiveFloor, today, isManager = true }) {
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

  // Rent alerts for home
  const tenants = getAllTenants(rooms);
  const dueToday = tenants.filter(t => { const s = getRentStatus(t.admissionDate, today); return s && s.type === "due_today"; });
  const dueSoon = tenants.filter(t => { const s = getRentStatus(t.admissionDate, today); return s && s.type === "due_soon"; });

  // Recent tenants
  const recentTenants = [...tenants].sort((a,b) => (b.admissionDate||"").localeCompare(a.admissionDate||"")).slice(0, 6);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "16px 12px 90px" }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 3px", letterSpacing: "-0.5px" }}>Dashboard</h1>
        <p style={{ margin: 0, color: "#64748b", fontSize: 14 }}>3 floors · {all.length} rooms · {totalBeds} beds total</p>
      </div>

      {/* Rent alerts banner (managers/admins only) */}
      {isManager && (dueToday.length > 0 || dueSoon.length > 0) && (
        <div style={{ marginBottom: 20, display: "flex", flexDirection: "column", gap: 8 }}>
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

      {/* KPI Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10, marginBottom: 18 }}>
        {[
          { icon: "🛏", label: "Total Beds", value: totalBeds, color: "#3b82f6", bg: "#eff6ff" },
          { icon: "👤", label: "Occupied", value: totalOcc, color: "#ef4444", bg: "#fef2f2" },
          { icon: "✅", label: "Available", value: totalFree, color: "#22c55e", bg: "#f0fdf4" },
          { icon: "🏠", label: "Total Rooms", value: all.length, color: "#8b5cf6", bg: "#f5f3ff" },
          { icon: "🔴", label: "Full Rooms", value: fullRooms, color: "#f97316", bg: "#fff7ed" },
          { icon: "🟡", label: "Partial", value: partialRooms, color: "#eab308", bg: "#fefce8" },
          { icon: "🟢", label: "Empty", value: emptyRooms, color: "#10b981", bg: "#ecfdf5" },
          { icon: "📊", label: "Occupancy", value: `${occPct}%`, color: "#6366f1", bg: "#eef2ff" },
        ].map(c => (
          <div key={c.label} style={{ background: c.bg, borderRadius: 12, padding: "16px 18px", border: `1.5px solid ${c.color}22` }}>
            <div style={{ fontSize: 20, marginBottom: 6 }}>{c.icon}</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: c.color, lineHeight: 1 }}>{c.value}</div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 3, fontWeight: 500 }}>{c.label}</div>
          </div>
        ))}
      </div>

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
              {[{ label: "Full", value: fullRooms, color: "#ef4444", bg: "#fef2f2" }, { label: "Partial", value: partialRooms, color: "#f59e0b", bg: "#fffbeb" }, { label: "Empty", value: emptyRooms, color: "#22c55e", bg: "#f0fdf4" }].map(s => (
                <div key={s.label} style={{ flex: 1, textAlign: "center", background: s.bg, borderRadius: 8, padding: "8px 4px" }}>
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
function TenantSearchPage({ rooms, setPage, setActiveFloor, isManager = true }) {
  const [query, setQuery] = useState("");
  const allTenants = getAllTenants(rooms);

  const results = query.trim().length === 0 ? allTenants : allTenants.filter(t =>
    t.name.toLowerCase().includes(query.toLowerCase()) ||
    (t.phone || "").includes(query) ||
    String(t.roomNumber).includes(query) ||
    String(t.floor).includes(query) ||
    (t.roomLabel || "").toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "16px 12px 90px" }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 3px" }}>Tenant Search</h1>
        <p style={{ margin: 0, color: "#64748b", fontSize: 14 }}>{allTenants.length} tenants across all floors</p>
      </div>

      <div style={{ position: "relative", marginBottom: 20 }}>
        <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontSize: 16 }}>🔍</span>
        <input
          autoFocus
          placeholder="Search by name, phone, room number, floor…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          style={{ ...inputStyle, paddingLeft: 40, fontSize: 15, padding: "12px 14px 12px 40px", borderRadius: 12, border: "2px solid #e2e8f0" }}
        />
        {query && (
          <button onClick={() => setQuery("")} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "#e2e8f0", border: "none", borderRadius: "50%", width: 22, height: 22, cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        )}
      </div>

      <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 12 }}>
        {query ? `${results.length} result${results.length !== 1 ? "s" : ""} for "${query}"` : `Showing all ${results.length} tenants`}
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
    });
  }

  return (
    <div style={{ background: "#fff", borderRadius: 14, padding: 16, marginBottom: 14, boxShadow: "0 1px 4px #0001" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>TOTAL COLLECTED IN {reportYear}</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: "#1a2332" }}>₹{yearTotal.toLocaleString("en-IN")}</div>
        </div>
        <select value={reportYear} onChange={e => { setReportYear(Number(e.target.value)); setExpandedMonth(null); }} style={{ padding: "8px 12px", borderRadius: 8, border: "1.5px solid #e2e8f0", fontWeight: 700, fontSize: 14 }}>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
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
                        {FLOOR_LABELS[p.floor] || "Floor " + p.floor} · Room {p.room_number} · {new Date(p.paid_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} · {p.payment_mode || "mode not set"}
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
function generateReceiptPDF({ name, phone, floorLabel, roomNumber, paidDate, amount, mode, receiptNo, cycleNote }) {
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) { alert("PDF library still loading — try again in a moment."); return; }

  const doc = new jsPDF({ unit: "pt", format: [320, 480] });
  doc.setFont("helvetica", "bold"); doc.setFontSize(16);
  doc.text("Turiya Hostel", 24, 40);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(120);
  doc.text(`Rent Receipt · No. ${receiptNo}`, 24, 56);

  const rows = [
    ["Tenant", name],
    ["Room", `${floorLabel} - Room ${roomNumber}`],
    ["Phone", phone || "-"],
    ["Payment Date", paidDate.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })],
    ["Payment Mode", mode || "-"],
    ["Payment Cycle", cycleNote || "Monthly"],
  ];
  let y = 84;
  doc.setFontSize(11);
  rows.forEach(([label, value]) => {
    doc.setTextColor(100); doc.text(label, 24, y);
    doc.setTextColor(20); doc.text(String(value), 296, y, { align: "right" });
    doc.setDrawColor(230); doc.line(24, y + 8, 296, y + 8);
    y += 26;
  });

  doc.setFontSize(9); doc.setTextColor(150); doc.text("AMOUNT PAID", 160, y + 24, { align: "center" });
  doc.setFont("helvetica", "bold"); doc.setFontSize(26); doc.setTextColor(21, 128, 61);
  doc.text(`Rs ${Number(amount || 0).toLocaleString("en-IN")}`, 160, y + 52, { align: "center" });

  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(160);
  doc.text("This is a system-generated receipt. Keep it for your records.", 160, y + 90, { align: "center" });

  const fileDate = paidDate.toISOString().slice(0, 10);
  const safeName = (name || "tenant").trim().replace(/[^a-zA-Z0-9]+/g, "_");
  doc.save(`${safeName}_${fileDate}.pdf`);
}

function RentPage({ rooms, setRooms, today }) {
  const [filter, setFilter] = useState("all");
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

  useEffect(() => {
    if (showReports && paymentsLog === null) {
      setLoadingReports(true);
      loadPayments().then(rows => { setPaymentsLog(rows); setLoadingReports(false); });
    }
  }, [showReports]);

  const tenants = getAllTenants(rooms);
  const monthlyTenants = tenants.filter(t => (t.billingType || "monthly") === "monthly");
  const dailyTenants = tenants.filter(t => (t.billingType || "monthly") === "daily");
  const withDates = monthlyTenants.filter(t => t.admissionDate);
  const withoutDates = monthlyTenants.filter(t => !t.admissionDate);

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

  async function markPaid(t, paymentMode) {
    const nowIso = new Date().toISOString();
    const receiptNo = generateReceiptNo(nowIso);
    const finalMode = paymentMode;
    await patchTenant(
      t,
      { rent_paid_on: nowIso, rent_snoozed_at: null, rent_payment_mode: finalMode, rent_receipt_no: receiptNo },
      { rentPaidOn: nowIso, rentSnoozedAt: "", rentPaymentMode: finalMode, rentReceiptNo: receiptNo }
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
      });
    } catch (e) { console.warn("Payment log failed (table may not exist yet):", e); }
  }
  async function undoPaid(t) {
    await patchTenant(t, { rent_paid_on: null }, { rentPaidOn: "" });
  }
  async function snoozeTenant(t) {
    const nowIso = new Date().toISOString();
    await patchTenant(t, { rent_snoozed_at: nowIso }, { rentSnoozedAt: nowIso });
  }
  async function unsnoozeTenant(t) {
    await patchTenant(t, { rent_snoozed_at: null }, { rentSnoozedAt: "" });
  }

  function printReceipt(t) {
    const paidDate = t.rentPaidOn ? new Date(t.rentPaidOn) : new Date();
    const receiptNo = t.rentReceiptNo || generateReceiptNo(paidDate.toISOString());
    generateReceiptPDF({
      name: t.name,
      phone: t.phone,
      floorLabel: FLOOR_LABELS[t.floor] || "Floor " + t.floor,
      roomNumber: t.roomNumber,
      paidDate,
      amount: t.rentAmount,
      mode: t.rentPaymentMode,
      receiptNo,
      cycleNote: t.rentStatus ? `Due on ${t.rentStatus.dueDay} · Monthly` : "Monthly",
    });
  }

  async function confirmReceiptAndPrint(t, mode) {
    const finalMode = mode === "Other" ? receiptModeOther.trim() : mode;
    setReceiptModal(null);
    if (finalMode !== t.rentPaymentMode) {
      // Keep the tenant row and the permanent ledger entry in sync
      try {
        await sbFetch(`/tenants?id=eq.${t.dbId}`, "PATCH", { rent_payment_mode: finalMode }, { "Prefer": "return=minimal" });
        if (t.rentReceiptNo) {
          await sbFetch(`/payments?receipt_no=eq.${t.rentReceiptNo}`, "PATCH", { payment_mode: finalMode }, { "Prefer": "return=minimal" });
        }
        setRooms(prev => {
          const roomId = `${t.floor}-${t.roomNumber}`;
          const room = prev[roomId];
          if (!room) return prev;
          const bedIndex = t.bed - 1;
          const newTenants = room.tenants.map((tn, bi) => bi === bedIndex ? { ...tn, rentPaymentMode: finalMode } : tn);
          return { ...prev, [roomId]: { ...room, tenants: newTenants } };
        });
      } catch (e) { console.warn("Could not update payment mode:", e); }
    }
    printReceipt({ ...t, rentPaymentMode: finalMode });
  }

  const categorized = withDates.map(t => {
    const rentStatus = getRentStatus(t.admissionDate, today);
    const isPaid = !!rentStatus && isActiveForCycle(t.rentPaidOn, rentStatus.dueDay, today);
    const isSnoozed = !isPaid && !!rentStatus && isActiveForCycle(t.rentSnoozedAt, rentStatus.dueDay, today);
    return { ...t, rentStatus, isPaid, isSnoozed };
  });
  const allDue = categorized.filter(t => !t.isPaid && !t.isSnoozed);
  const dueToday = allDue.filter(t => t.rentStatus.type === "due_today");
  const dueSoon = allDue.filter(t => t.rentStatus.type === "due_soon");
  const ok = allDue.filter(t => t.rentStatus.type === "ok");
  const paidList = categorized.filter(t => t.isPaid);
  const snoozedList = categorized.filter(t => t.isSnoozed);

  let shown = [];
  if (filter === "all") shown = [...dueToday, ...dueSoon, ...ok];
  else if (filter === "due_today") shown = dueToday;
  else if (filter === "due_soon") shown = dueSoon;
  else if (filter === "ok") shown = ok;
  else if (filter === "paid") shown = paidList;
  else if (filter === "snoozed") shown = snoozedList;

  const grouped = {};
  shown.forEach(t => {
    const day = t.rentStatus?.dueDay || 0;
    if (!grouped[day]) grouped[day] = [];
    grouped[day].push(t);
  });
  const sortedDays = Object.keys(grouped).map(Number).sort((a, b) => {
    const td = today.getDate();
    const da = a >= td ? a - td : 31 - td + a;
    const db = b >= td ? b - td : 31 - td + b;
    return da - db;
  });

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
            {today.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </p>
        </div>
        <button onClick={() => setShowReports(s => !s)} style={{ padding: "9px 14px", borderRadius: 10, border: "1.5px solid " + (showReports ? "#1a2332" : "#e2e8f0"), background: showReports ? "#1a2332" : "#fff", color: showReports ? "#fff" : "#475569", fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}>
          📊 Reports
        </button>
      </div>

      {showReports && (
        <RentReportsPanel paymentsLog={paymentsLog} loading={loadingReports} reportYear={reportYear} setReportYear={setReportYear} />
      )}

      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 8, marginBottom: 14 }}>
        {[
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
          <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700 }}>COLLECTED IN {today.toLocaleDateString("en-IN", { month: "long" }).toUpperCase()}</div>
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
        sortedDays.map(day => (
          <div key={day} style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: "#1a2332" }}>
                {filter === "paid" ? "✅ Paid this cycle" : filter === "snoozed" ? "⏭️ Snoozed" : day === today.getDate() ? "🔴 Due Today" : `📅 ${ordinal(day)} of every month`}
              </div>
              <div style={{ height: 1, flex: 1, background: "#e2e8f0" }} />
              <span style={{ fontSize: 12, color: "#94a3b8" }}>{grouped[day].length}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {grouped[day].map((t, idx) => {
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
                              ₹{Number(t.rentAmount).toLocaleString("en-IN")}/mo
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: "#64748b" }}>
                          Floor {t.floor} · Room {t.roomNumber}{t.roomLabel ? ` (${t.roomLabel})` : ""} · Bed {t.bed}
                        </div>
                        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                          Joined: {fmt(t.admissionDate)}
                          {isPaid && t.rentPaidOn && ` · Paid: ${new Date(t.rentPaidOn).toLocaleDateString("en-IN")}`}
                          {isSnoozed && " · Snoozed to next cycle"}
                        </div>
                      </div>
                      <span style={{ flexShrink: 0, background: isPaid ? "#dcfce7" : isSnoozed ? "#ede9fe" : rs.bg, color: isPaid ? "#15803d" : isSnoozed ? "#7c3aed" : rs.color, fontWeight: 700, fontSize: 11, padding: "3px 10px", borderRadius: 99, border: `1px solid ${borderColor}44`, whiteSpace: "nowrap" }}>
                        {isPaid ? "✅ Paid" : isSnoozed ? "⏭️ Snoozed" : `${rs.icon} ${rs.label}`}
                      </span>
                    </div>
                    {/* Action buttons row */}
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <ContactButtons phone={t.phone} size="small" />
                      <div style={{ flex: 1 }} />
                      {!isPaid && !isSnoozed && (
                        <>
                          <button disabled={isBusy} onClick={() => { setPaymentMode("Cash"); setPaymentModeOther(""); setPaidModal(t); }} style={{ padding: "8px 16px", borderRadius: 10, border: "none", background: "#22c55e", color: "#fff", fontWeight: 800, fontSize: 13, cursor: isBusy ? "default" : "pointer", opacity: isBusy ? 0.6 : 1, display: "flex", alignItems: "center", gap: 5 }}>
                            ✅ Mark Paid
                          </button>
                          <button disabled={isBusy} onClick={() => snoozeTenant(t)} style={{ padding: "8px 14px", borderRadius: 10, border: "1.5px solid #c4b5fd", background: "#f5f3ff", color: "#7c3aed", fontWeight: 700, fontSize: 13, cursor: isBusy ? "default" : "pointer", opacity: isBusy ? 0.6 : 1 }}>
                            ⏭️ Next Cycle
                          </button>
                        </>
                      )}
                      {isPaid && (
                        <>
                          <button onClick={() => { setReceiptMode(t.rentPaymentMode || "Cash"); setReceiptModeOther(""); setReceiptModal(t); }} style={{ padding: "7px 14px", borderRadius: 10, border: "1.5px solid #93c5fd", background: "#eff6ff", color: "#1d4ed8", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                            🧾 Receipt
                          </button>
                          <button disabled={isBusy} onClick={() => undoPaid(t)} style={{ padding: "7px 14px", borderRadius: 10, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 600, fontSize: 12, cursor: isBusy ? "default" : "pointer", opacity: isBusy ? 0.6 : 1 }}>
                            Undo Paid
                          </button>
                        </>
                      )}
                      {isSnoozed && (
                        <button disabled={isBusy} onClick={() => unsnoozeTenant(t)} style={{ padding: "7px 14px", borderRadius: 10, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 600, fontSize: 12, cursor: isBusy ? "default" : "pointer", opacity: isBusy ? 0.6 : 1 }}>
                          Unsnooze
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))
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
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setPaidModal(null)} style={{ flex: 1, padding: "14px 0", borderRadius: 12, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>
                Cancel
              </button>
              <button onClick={async () => {
                const t = paidModal;
                const mode = paymentMode === "Other" ? paymentModeOther.trim() : paymentMode;
                setPaidModal(null);
                await markPaid(t, mode);
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
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setReceiptModal(null)} style={{ flex: 1, padding: "14px 0", borderRadius: 12, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>
                Cancel
              </button>
              <button onClick={() => confirmReceiptAndPrint(receiptModal, receiptMode)} style={{ flex: 2, padding: "14px 0", borderRadius: 12, border: "none", background: "#1d4ed8", color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer" }}>
                🧾 Print / Save PDF
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ROOMS PAGE ────────────────────────────────────────────────
function RoomsPage({ rooms, setRooms, activeFloor, setActiveFloor, onSaveRoom, isManager = true }) {
  const [editingRoom, setEditingRoom] = useState(null);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [editForm, setEditForm] = useState(null);
  const [addingRoom, setAddingRoom] = useState(false);
  const [newRoomBeds, setNewRoomBeds] = useState(2);
  const [creatingRoom, setCreatingRoom] = useState(false);

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
  function saveEdit() {
    const beds = Math.max(1, Math.min(20, editForm.beds));
    const updated = { ...editingRoom, beds, label: editForm.label, tenants: makeBeds(beds, editForm.tenants) };
    onSaveRoom(updated);
    setEditingRoom(null);
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
                      {(t.billingType||'monthly')==='daily'?'☀️':'👤'} {t.name}{t.phone ? ` · ${t.phone}` : ""}
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
                      <input type="tel" placeholder="Phone number" value={t.phone || ""} onChange={e => updateTenant(i, "phone", e.target.value)} style={inputStyle} />
                      <input type="date" value={t.admissionDate} onChange={e => updateTenant(i, "admissionDate", e.target.value)} style={{ ...inputStyle, color: t.admissionDate ? "#1a2332" : "#94a3b8" }} />
                    </div>
                    {/* Rent Amount */}
                    <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 10, marginTop: 2 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", marginBottom: 6 }}>💰 MONTHLY RENT AMOUNT</div>
                      <div style={{ position: "relative" }}>
                        <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: "#64748b", fontWeight: 700 }}>₹</span>
                        <input
                          type="number"
                          placeholder="e.g. 5000"
                          value={t.rentAmount || ""}
                          onChange={e => updateTenant(i, "rentAmount", e.target.value)}
                          style={{ ...inputStyle, paddingLeft: 26 }}
                          min="0"
                        />
                      </div>
                      {t.rentAmount && <div style={{ fontSize: 11, color: "#22c55e", marginTop: 4 }}>✅ Rent: ₹{Number(t.rentAmount).toLocaleString("en-IN")}/month</div>}
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
                    {/* Billing type toggle */}
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: "#64748b", marginRight: 4 }}>BILLING:</span>
                      {["monthly", "daily"].map(bt => (
                        <button key={bt} onClick={() => updateTenant(i, "billingType", bt)} style={{
                          padding: "5px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700,
                          background: (t.billingType || "monthly") === bt ? (bt === "daily" ? "#f59e0b" : "#3b82f6") : "#e2e8f0",
                          color: (t.billingType || "monthly") === bt ? "#fff" : "#64748b",
                          transition: "all 0.15s",
                        }}>
                          {bt === "monthly" ? "📅 Monthly" : "☀️ Per Day"}
                        </button>
                      ))}
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
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
              <button onClick={() => setEditingRoom(null)} style={{ flex: 1, padding: "14px 0", borderRadius: 12, border: "1.5px solid #e2e8f0", background: "#fff", color: "#64748b", fontWeight: 600, fontSize: 15, cursor: "pointer" }}>Cancel</button>
              <button onClick={saveEdit} style={{ flex: 2, padding: "14px 0", borderRadius: 12, border: "none", background: "#1a2332", color: "#fff", fontWeight: 700, fontSize: 15, cursor: "pointer" }}>💾 Save Changes</button>
            </div>
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
      t.archived_at ? new Date(t.archived_at).toLocaleDateString("en-IN") : ""
    ]);
    return [headers, ...data].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
  }

  function downloadCSV(csv, label) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hosteldesk-${label}-${new Date().toISOString().slice(0,10)}.csv`;
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
                { label: "This Month", fn: () => { const n = new Date(); setDateFrom(`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-01`); setDateTo(n.toISOString().slice(0,10)); }},
                { label: "Last Month", fn: () => { const n = new Date(); const lm = new Date(n.getFullYear(), n.getMonth()-1, 1); const le = new Date(n.getFullYear(), n.getMonth(), 0); setDateFrom(lm.toISOString().slice(0,10)); setDateTo(le.toISOString().slice(0,10)); }},
                { label: "Last 3 Months", fn: () => { const n = new Date(); const s = new Date(n); s.setMonth(s.getMonth()-3); setDateFrom(s.toISOString().slice(0,10)); setDateTo(n.toISOString().slice(0,10)); }},
                { label: "This Year", fn: () => { const n = new Date(); setDateFrom(`${n.getFullYear()}-01-01`); setDateTo(n.toISOString().slice(0,10)); }},
                { label: "Last Year", fn: () => { const y = new Date().getFullYear()-1; setDateFrom(`${y}-01-01`); setDateTo(`${y}-12-31`); }},
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
        {["all","1","2","3"].map(f => (
          <button key={f} onClick={() => setFilterFloor(f)} style={{
            padding: "8px 14px", borderRadius: 8,
            border: "1.5px solid " + (filterFloor === f ? "#1a2332" : "#e2e8f0"),
            background: filterFloor === f ? "#1a2332" : "#fff",
            color: filterFloor === f ? "#fff" : "#64748b",
            fontWeight: 500, fontSize: 12, cursor: "pointer",
          }}>{f === "all" ? "All Floors" : FLOOR_LABELS[f]}</button>
        ))}
      </div>

      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 14 }}>
        Showing {filtered.length} records{query ? ` matching "${query}"` : ""}
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
          {filtered.map((t, i) => (
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
                  {t.archived_at && <span>🗃️ Archived: {new Date(t.archived_at).toLocaleDateString("en-IN")}</span>}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                <ContactButtons phone={t.phone} size="small" />
                <div style={{ fontSize: 10, background: "#f1f5f9", color: "#64748b", padding: "2px 8px", borderRadius: 99, fontWeight: 600 }}>
                  {t.billing_type === "daily" ? "☀️ Per Day" : "📅 Monthly"}
                </div>
              </div>
            </div>
          ))}
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [user, setUser] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  const today = new Date();

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
    const rs = getRentStatus(t.admissionDate, today);
    return rs && (rs.type === "due_today" || rs.type === "due_soon");
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
      {page === "home" && <HomePage rooms={rooms} setPage={setPage} setActiveFloor={setActiveFloor} today={today} isManager={isManager} />}
      {page === "rooms" && <RoomsPage rooms={rooms} setRooms={setRooms} activeFloor={activeFloor} setActiveFloor={setActiveFloor} onSaveRoom={handleSaveRoom} isManager={isManager} />}
      {page === "search" && <TenantSearchPage rooms={rooms} setPage={setPage} setActiveFloor={setActiveFloor} isManager={isManager} />}
      {isManager && page === "rent" && <RentPage rooms={rooms} setRooms={setRooms} today={today} />}
      {isAdmin && page === "history" && <HistoryPage />}
      {isAdmin && page === "users" && <UsersPage currentUser={user} />}
    </div>
  );
}
