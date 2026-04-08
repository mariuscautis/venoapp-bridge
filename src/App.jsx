import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, useCallback } from "react";

// ── Design tokens ─────────────────────────────────────────────────────────────
const colors = {
  bg:       "#0f1117",
  surface:  "#1a1d27",
  border:   "#2a2d3e",
  brand:    "#6262bd",
  brandHov: "#7474d4",
  green:    "#22c55e",
  orange:   "#f59e0b",
  red:      "#ef4444",
  text:     "#e2e8f0",
  muted:    "#94a3b8",
};

const s = {
  container: {
    display:       "flex",
    flexDirection: "column",
    minHeight:     "100vh",
    background:    colors.bg,
    color:         colors.text,
  },
  header: {
    display:         "flex",
    alignItems:      "center",
    gap:             12,
    padding:         "20px 24px 16px",
    borderBottom:    `1px solid ${colors.border}`,
    background:      colors.surface,
  },
  logo: {
    width:        36,
    height:       36,
    borderRadius: 8,
    background:   colors.brand,
    display:      "flex",
    alignItems:   "center",
    justifyContent: "center",
    fontSize:     18,
    fontWeight:   700,
    color:        "#fff",
    flexShrink:   0,
  },
  headerTitle: {
    fontSize:   16,
    fontWeight: 700,
    color:      colors.text,
  },
  headerSub: {
    fontSize: 12,
    color:    colors.muted,
    marginTop: 1,
  },
  body: {
    flex:    1,
    padding: "20px 24px",
    overflowY: "auto",
  },
  card: {
    background:   colors.surface,
    border:       `1px solid ${colors.border}`,
    borderRadius: 10,
    padding:      20,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize:     13,
    fontWeight:   600,
    color:        colors.muted,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    marginBottom: 14,
  },
  label: {
    display:      "block",
    fontSize:     13,
    color:        colors.muted,
    marginBottom: 6,
    marginTop:    12,
  },
  input: {
    width:        "100%",
    padding:      "9px 12px",
    background:   colors.bg,
    border:       `1px solid ${colors.border}`,
    borderRadius: 6,
    color:        colors.text,
    fontSize:     14,
    outline:      "none",
    transition:   "border-color 0.15s",
  },
  btnPrimary: {
    width:        "100%",
    padding:      "11px 0",
    background:   colors.brand,
    color:        "#fff",
    border:       "none",
    borderRadius: 7,
    fontSize:     14,
    fontWeight:   600,
    cursor:       "pointer",
    marginTop:    18,
    transition:   "background 0.15s",
  },
  btnSecondary: {
    padding:      "8px 14px",
    background:   "transparent",
    color:        colors.muted,
    border:       `1px solid ${colors.border}`,
    borderRadius: 6,
    fontSize:     13,
    cursor:       "pointer",
    transition:   "background 0.15s",
  },
  statusRow: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "10px 0",
    borderBottom:   `1px solid ${colors.border}`,
  },
  statusLabel: {
    display:    "flex",
    alignItems: "center",
    gap:        8,
    fontSize:   14,
    color:      colors.text,
  },
  dot: (color) => ({
    width:        9,
    height:       9,
    borderRadius: "50%",
    background:   color,
    flexShrink:   0,
    boxShadow:    `0 0 6px ${color}aa`,
  }),
  statusValue: {
    fontSize: 14,
    fontWeight: 600,
  },
  bigStatus: {
    display:        "flex",
    flexDirection:  "column",
    alignItems:     "center",
    padding:        "24px 0 20px",
    gap:            6,
  },
  bigDot: (color) => ({
    width:        16,
    height:       16,
    borderRadius: "50%",
    background:   color,
    boxShadow:    `0 0 12px ${color}bb`,
    marginBottom: 6,
  }),
  bigStatusText: {
    fontSize:   18,
    fontWeight: 700,
    color:      colors.text,
  },
  bigStatusSub: {
    fontSize: 13,
    color:    colors.muted,
  },
  error: {
    background:   "#3b1a1a",
    border:       `1px solid ${colors.red}44`,
    borderRadius: 6,
    padding:      "10px 14px",
    fontSize:     13,
    color:        "#f87171",
    marginTop:    12,
  },
  success: {
    background:   "#0f291e",
    border:       `1px solid ${colors.green}44`,
    borderRadius: 6,
    padding:      "10px 14px",
    fontSize:     13,
    color:        "#4ade80",
    marginTop:    12,
  },
};

// ── Default Supabase config ───────────────────────────────────────────────────
const DEFAULT_SUPABASE_URL = "https://rfquwezkkdyvjftveilf.supabase.co";
const DEFAULT_SUPABASE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmcXV3ZXpra2R5dmpmdHZlaWxmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQyNTAxMzEsImV4cCI6MjA3OTgyNjEzMX0.sIOvuPu8AoL2QRtTPEMFcHVWv3lY_pyMIWgsZ7uyyxc";

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [config, setConfig]         = useState(null);
  const [status, setStatus]         = useState(null);
  const [editMode, setEditMode]     = useState(false);
  const [saving, setSaving]         = useState(false);
  const [testing, setTesting]       = useState(false);
  const [saveError, setSaveError]   = useState("");
  const [saveOk, setSaveOk]         = useState("");
  const [form, setForm]             = useState({
    bridge_code:       "",
    restaurant_id:    "",
    restaurant_name:  "",
    printer_ip:       "",
    supabase_url:     DEFAULT_SUPABASE_URL,
    supabase_anon_key: DEFAULT_SUPABASE_KEY,
  });
  const [resolving, setResolving]   = useState(false);

  // Load config on mount
  useEffect(() => {
    invoke("get_config").then((cfg) => {
      setConfig(cfg);
      setForm({
        bridge_code:      cfg.bridge_code || "",
        restaurant_id:    cfg.restaurant_id || "",
        restaurant_name:  cfg.restaurant_name || "",
        printer_ip:       cfg.printer_ip || "",
        supabase_url:     cfg.supabase_url || DEFAULT_SUPABASE_URL,
        supabase_anon_key: cfg.supabase_anon_key || DEFAULT_SUPABASE_KEY,
      });
    });
  }, []);

  // Poll status every 4 seconds when setup complete
  const fetchStatus = useCallback(() => {
    invoke("get_status").then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    if (!config?.setup_complete) return;
    fetchStatus();
    const id = setInterval(fetchStatus, 4000);
    return () => clearInterval(id);
  }, [config?.setup_complete, fetchStatus]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError("");
    setSaveOk("");
    try {
      // Resolve bridge code → restaurant_id if code changed or restaurant_id not set
      let restaurantId   = form.restaurant_id;
      let restaurantName = form.restaurant_name;
      const code = form.bridge_code.trim();

      if (code && (!restaurantId || editMode)) {
        setResolving(true);
        try {
          const result = await invoke("resolve_bridge_code", { code });
          restaurantId   = result.restaurant_id;
          restaurantName = result.name;
        } catch (e) {
          setSaveError(String(e));
          setSaving(false);
          setResolving(false);
          return;
        }
        setResolving(false);
      }

      if (!restaurantId) {
        setSaveError("Please enter a valid restaurant code.");
        setSaving(false);
        return;
      }

      await invoke("save_config", {
        config: {
          ...form,
          bridge_code:     code,
          restaurant_id:   restaurantId,
          restaurant_name: restaurantName,
          setup_complete:  true,
        },
      });
      const updated = await invoke("get_config");
      setConfig(updated);
      setEditMode(false);
      setSaveOk(`Connected to ${restaurantName}. Bridge is now active.`);
      setTimeout(() => setSaveOk(""), 5000);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
      setResolving(false);
    }
  };

  const handleTestPrint = async () => {
    setTesting(true);
    setSaveError("");
    setSaveOk("");
    try {
      await invoke("test_print");
      setSaveOk("Test receipt sent to printer.");
      setTimeout(() => setSaveOk(""), 4000);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setTesting(false);
    }
  };

  if (!config) {
    return (
      <div style={{ ...s.container, alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: colors.muted, fontSize: 14 }}>Loading…</div>
      </div>
    );
  }

  const isSetup = config.setup_complete && !editMode;

  return (
    <div style={s.container}>
      {/* Header */}
      <div style={s.header}>
        <div style={s.logo}>V</div>
        <div>
          <div style={s.headerTitle}>VenoApp Bridge</div>
          <div style={s.headerSub}>
            {isSetup ? "Running · ws://venobridge.local:3355" : "Setup required"}
          </div>
        </div>
      </div>

      <div style={s.body}>
        {/* ── SETUP / EDIT FORM ── */}
        {!isSetup && (
          <div style={s.card}>
            <div style={s.cardTitle}>
              {editMode ? "Edit Settings" : "Initial Setup"}
            </div>

            <label style={{ ...s.label, marginTop: 0 }}>Restaurant Code</label>
            <input
              style={{ ...s.input, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, fontSize: 16 }}
              placeholder="XXXX-XXXX"
              value={form.bridge_code}
              maxLength={9}
              onChange={(e) => {
                // Auto-insert dash after 4 chars
                let v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
                if (v.length > 4) v = v.slice(0, 4) + "-" + v.slice(4, 8);
                setForm((f) => ({ ...f, bridge_code: v, restaurant_id: "", restaurant_name: "" }));
              }}
            />
            <div style={{ fontSize: 11, color: colors.muted, marginTop: 5 }}>
              Found in VenoApp → Settings → Offline Hub
            </div>

            <label style={s.label}>Printer IP Address</label>
            <input
              style={s.input}
              placeholder="192.168.1.100"
              value={form.printer_ip}
              onChange={(e) => setForm((f) => ({ ...f, printer_ip: e.target.value }))}
            />

            <label style={s.label}>Supabase URL</label>
            <input
              style={s.input}
              value={form.supabase_url}
              onChange={(e) => setForm((f) => ({ ...f, supabase_url: e.target.value }))}
            />

            <label style={s.label}>Supabase Anon Key</label>
            <input
              style={{ ...s.input, fontFamily: "monospace", fontSize: 11 }}
              value={form.supabase_anon_key}
              onChange={(e) =>
                setForm((f) => ({ ...f, supabase_anon_key: e.target.value }))
              }
            />

            {saveError && <div style={s.error}>{saveError}</div>}
            {saveOk    && <div style={s.success}>{saveOk}</div>}

            <button
              style={{
                ...s.btnPrimary,
                opacity: saving ? 0.7 : 1,
                cursor:  saving ? "default" : "pointer",
              }}
              disabled={saving}
              onClick={handleSave}
            >
              {resolving ? "Verifying code…" : saving ? "Saving…" : "Save & Start"}
            </button>

            {editMode && (
              <button
                style={{ ...s.btnSecondary, marginTop: 10, width: "100%" }}
                onClick={() => {
                  setEditMode(false);
                  setSaveError("");
                }}
              >
                Cancel
              </button>
            )}
          </div>
        )}

        {/* ── RUNNING DASHBOARD ── */}
        {isSetup && (
          <>
            {/* Big status badge */}
            <div style={s.card}>
              <div style={s.bigStatus}>
                <div
                  style={s.bigDot(
                    status?.pending_orders > 0 ? colors.orange : colors.green
                  )}
                />
                <div style={s.bigStatusText}>
                  {status?.pending_orders > 0
                    ? `${status.pending_orders} Order${status.pending_orders !== 1 ? "s" : ""} Queued`
                    : "Bridge Active"}
                </div>
                <div style={s.bigStatusSub}>
                  {status?.pending_orders > 0
                    ? "Offline — will sync when internet returns"
                    : "Listening on ws://venobridge.local:3355"}
                </div>
              </div>
            </div>

            {/* Status grid */}
            <div style={s.card}>
              <div style={s.cardTitle}>Live Status</div>

              <div style={s.statusRow}>
                <span style={s.statusLabel}>
                  <span style={s.dot(colors.green)} />
                  Connected Devices
                </span>
                <span style={{ ...s.statusValue, color: colors.green }}>
                  {status?.connected_devices ?? "—"}
                </span>
              </div>

              <div style={s.statusRow}>
                <span style={s.statusLabel}>
                  <span
                    style={s.dot(
                      status?.printer_online ? colors.green : colors.red
                    )}
                  />
                  Printer
                </span>
                <span
                  style={{
                    ...s.statusValue,
                    color: status?.printer_online ? colors.green : colors.red,
                  }}
                >
                  {status?.printer_online ? "Online" : "Offline"}
                </span>
              </div>

              <div style={{ ...s.statusRow, borderBottom: "none" }}>
                <span style={s.statusLabel}>
                  <span
                    style={s.dot(
                      status?.internet_ok ? colors.green : colors.orange
                    )}
                  />
                  Internet
                </span>
                <span
                  style={{
                    ...s.statusValue,
                    color: status?.internet_ok ? colors.green : colors.orange,
                  }}
                >
                  {status?.internet_ok ? "Connected" : "Offline"}
                </span>
              </div>
            </div>

            {/* Config summary */}
            <div style={s.card}>
              <div style={s.cardTitle}>Configuration</div>
              <div style={{ fontSize: 13, lineHeight: 1.8, color: colors.muted }}>
                <div>
                  <strong style={{ color: colors.text }}>Restaurant:</strong>{" "}
                  {config.restaurant_name || config.restaurant_id || <em>not set</em>}
                </div>
                <div>
                  <strong style={{ color: colors.text }}>Bridge Code:</strong>{" "}
                  {config.bridge_code || <em>not set</em>}
                </div>
                <div>
                  <strong style={{ color: colors.text }}>Printer IP:</strong>{" "}
                  {config.printer_ip || <em>not set</em>}
                </div>
                <div>
                  <strong style={{ color: colors.text }}>Supabase:</strong>{" "}
                  {config.supabase_url
                    ? config.supabase_url.replace("https://", "")
                    : <em>not set</em>}
                </div>
              </div>

              {saveError && <div style={s.error}>{saveError}</div>}
              {saveOk    && <div style={s.success}>{saveOk}</div>}

              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button
                  style={{ ...s.btnSecondary, flex: 1 }}
                  onClick={() => setEditMode(true)}
                >
                  Edit Settings
                </button>
                <button
                  style={{
                    ...s.btnSecondary,
                    flex: 1,
                    opacity: testing ? 0.7 : 1,
                    cursor:  testing ? "default" : "pointer",
                  }}
                  disabled={testing}
                  onClick={handleTestPrint}
                >
                  {testing ? "Printing…" : "Test Print"}
                </button>
              </div>
            </div>
          </>
        )}

        {/* Footer */}
        <div
          style={{
            textAlign: "center",
            fontSize:  12,
            color:     colors.muted,
            paddingTop: 4,
            paddingBottom: 8,
          }}
        >
          VenoApp Bridge v1.0.0
        </div>
      </div>
    </div>
  );
}
