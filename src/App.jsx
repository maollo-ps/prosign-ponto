import { useState, useEffect, useMemo, useRef } from "react";
import { Users, Clock, FileBarChart, Plus, Trash2, Upload, X, Save, Briefcase, LogOut, Loader2 } from "lucide-react";

// =========================================================
// CONFIGURAÇÃO DO SUPABASE — preencha com os dados do seu projeto
// (Settings → API no painel do Supabase)
// =========================================================
const SUPABASE_URL = "https://zmkpfiqtwfcknwzzolcv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpta3BmaXF0d2Zja253enpvbGN2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwODM3NTUsImV4cCI6MjEwMjY1OTc1NX0.Ip2BA9g82dVPiruT71Ae47xsX9_qZ1sWr5_FtTuEtv4"; // cole a chave inteira que você copiou do painel
const FOTOS_BUCKET = "funcionarios-fotos";

// ---------- constants ----------
const DIVISOR_HORA = 220;
const TETO_HORA_EXTRA = 40; // limite mensal de horas extras (regra Prosign)
const MESES = ["01","02","03","04","05","06","07","08","09","10","11","12"];

// Ordem = prioridade de preenchimento do teto de 40h. adicNot é "soAdicional"
// (adicional noturno puro sobre hora normal) e NÃO consome o teto.
const CAMPOS_LANC = [
  { key: "he50", col: "he_50", label: "H. Extras 50%", mult: 1.5, noturno: false },
  { key: "he60", col: "he_60", label: "H. Extras 60% (sáb.)", mult: 1.6, noturno: false },
  { key: "he100", col: "he_100", label: "H. Extras 100% (dom./fer.)", mult: 2.0, noturno: false },
  { key: "heNot50", col: "he_not_50", label: "H. Extras Not. 50%", mult: 1.5, noturno: true },
  { key: "heNot60", col: "he_not_60", label: "H. Extras Not. 60%", mult: 1.6, noturno: true },
  { key: "heNot100", col: "he_not_100", label: "H. Extras Adic. Not. 100%", mult: 2.0, noturno: true },
  { key: "adicNot", col: "adic_noturno_20", label: "Adic. Noturno (20%)", mult: 0.20, noturno: true, soAdicional: true },
];

// ---------- helpers ----------
function hhmmToDecimal(v) {
  if (!v || v === "-" || v.trim() === "") return 0;
  const m = v.trim().match(/^(\d{1,3}):(\d{2})$/);
  if (!m) {
    const n = parseFloat(v.replace(",", "."));
    return isNaN(n) ? 0 : n;
  }
  return parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
}
function decimalToHHMM(dec) {
  if (!dec) return "-";
  const h = Math.floor(dec);
  const m = Math.round((dec - h) * 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}
function brl(v) {
  return (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// =========================================================
// CAMADA SUPABASE (REST direto via fetch, sem o SDK supabase-js)
// =========================================================
async function sbRequest(path, session, { method = "GET", body, extraHeaders = {} } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: method === "GET" ? undefined : "return=representation",
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase (${path}) ${res.status}: ${errText}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function sbLogin(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || "Login inválido");
  return data; // { access_token, refresh_token, user, ... }
}

async function sbUploadFoto(file, path, session) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${FOTOS_BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token}`,
      "Content-Type": file.type || "application/octet-stream",
      "x-upsert": "true",
    },
    body: file,
  });
  if (!res.ok) throw new Error("Falha ao enviar a foto para o Storage.");
  return `${SUPABASE_URL}/storage/v1/object/public/${FOTOS_BUCKET}/${path}`;
}

// ---------- mapeamento JS <-> colunas do banco ----------
function cargoFromRow(r) { return { id: r.id, funcao: r.funcao, cbo: r.cbo, salario: Number(r.salario_base) }; }
function cargoToRow(c) { return { funcao: c.funcao, cbo: c.cbo, salario_base: c.salario }; }

function funcionarioFromRow(r) {
  return { id: r.id, codigo: r.codigo, nome: r.nome, cargoId: r.cargo_id, gratificacao: Number(r.gratificacao || 0), admissao: r.admissao, fotoUrl: r.foto_url || "" };
}
function funcionarioToRow(f) {
  return { codigo: f.codigo, nome: f.nome, cargo_id: f.cargoId, gratificacao: f.gratificacao || 0, admissao: f.admissao || null, foto_url: f.fotoUrl || null };
}

function lancamentoFromRow(r) {
  const obj = { id: r.id, funcionarioId: r.funcionario_id, mes: r.mes_referencia };
  CAMPOS_LANC.forEach((c) => { obj[c.key] = Number(r[c.col] || 0); });
  obj.faltasDias = Number(r.faltas_dias || 0);
  obj.faltasHoras = Number(r.faltas_horas || 0);
  obj.dsrDias = Number(r.dsr_faltas_dias || 0);
  obj.atestadoDias = Number(r.atestado_dias || 0);
  return obj;
}
function lancamentoToRow(l) {
  const row = { funcionario_id: l.funcionarioId, mes_referencia: l.mes };
  CAMPOS_LANC.forEach((c) => { row[c.col] = l[c.key] || 0; });
  row.faltas_dias = l.faltasDias || 0;
  row.faltas_horas = l.faltasHoras || 0;
  row.dsr_faltas_dias = l.dsrDias || 0;
  row.atestado_dias = l.atestadoDias || 0;
  return row;
}

// ---------- calc engine ----------
function valorLinha(horas, valorHora, c) {
  if (c.soAdicional) return horas * valorHora * c.mult;
  if (c.noturno) return horas * valorHora * c.mult * 1.20;
  return horas * valorHora * c.mult;
}

function salarioBase(funcionario, cargos) {
  const cargo = cargos.find((c) => c.id === funcionario?.cargoId);
  return (cargo?.salario || 0) + (funcionario?.gratificacao || 0);
}

function calcularLancamento(funcionario, cargos, lanc) {
  const salario = salarioBase(funcionario, cargos);
  const valorHora = salario / DIVISOR_HORA;

  let restanteTeto = TETO_HORA_EXTRA;
  const linhas = CAMPOS_LANC.map((c) => {
    const horas = lanc[c.key] || 0;
    if (c.soAdicional) {
      return { ...c, horas, dentro: horas, excedente: 0, valorDentro: valorLinha(horas, valorHora, c), valorExcedente: 0 };
    }
    const dentro = Math.min(horas, Math.max(restanteTeto, 0));
    const excedente = horas - dentro;
    restanteTeto -= dentro;
    return {
      ...c, horas, dentro, excedente,
      valorDentro: valorLinha(dentro, valorHora, c),
      valorExcedente: valorLinha(excedente, valorHora, c),
    };
  });

  const totalHorasExtras = linhas.reduce((s, l) => s + (l.soAdicional ? 0 : l.dentro), 0);
  const totalValorExtras = linhas.reduce((s, l) => s + l.valorDentro, 0);
  const totalHorasExcedentes = linhas.reduce((s, l) => s + l.excedente, 0);
  const totalValorExcedentes = linhas.reduce((s, l) => s + l.valorExcedente, 0);

  const faltasHoras = lanc.faltasHoras || 0;
  const faltasDias = lanc.faltasDias || 0;
  const dsrDias = lanc.dsrDias || 0;
  const valorDia = salario / 30;

  const descFaltasHoras = faltasHoras * valorHora;
  const descFaltasDias = faltasDias * valorDia;
  const descDsr = dsrDias * valorDia;
  const totalDescontos = descFaltasHoras + descFaltasDias + descDsr;

  return {
    salario, valorHora, linhas,
    totalHorasExtras, totalValorExtras,
    totalHorasExcedentes, totalValorExcedentes,
    descFaltasHoras, descFaltasDias, descDsr, totalDescontos,
    liquido: totalValorExtras - totalDescontos,
  };
}

// ---------- design tokens ----------
const BG = "#F5F6F8";
const CARD = "#FFFFFF";
const NAVY = "#152A4A";
const NAVY_DARK = "#0D1B30";
const GOLD = "#B8902E";
const TEXT = "#1B2230";
const MUTED = "#6B7280";
const BORDER = "#E4E7EC";
const DANGER = "#A6394A";
const OK = "#2F6F4F";
const FONT_BODY = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const FONT_MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const selStyle = { padding: "8px 10px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "#fff", fontFamily: FONT_BODY, fontSize: 14, color: TEXT };
const inputStyle = { padding: "9px 10px", borderRadius: 8, border: `1px solid ${BORDER}`, fontFamily: FONT_BODY, fontSize: 14, color: TEXT };
const btnPrimary = { display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 8, border: "none", background: NAVY, color: "#fff", fontWeight: 600, fontSize: 13, cursor: "pointer" };
const btnGhostSmall = { padding: "7px 12px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "#fff", color: TEXT, fontSize: 12, cursor: "pointer" };
const btnDangerSmall = { padding: "7px 10px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "#fff", color: DANGER, cursor: "pointer" };

// =========================================================
// APP
// =========================================================
export default function App() {
  const [session, setSession] = useState(null);
  const [tab, setTab] = useState("cargos");
  const [cargos, setCargos] = useState([]);
  const [funcionarios, setFuncionarios] = useState([]);
  const [lancamentos, setLancamentos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState("");
  const [mesRef, setMesRef] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${MESES[d.getMonth()]}`;
  });

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    setErro("");
    Promise.all([
      sbRequest("cargos?select=*&order=funcao.asc", session),
      sbRequest("funcionarios?select=*&order=nome.asc", session),
      sbRequest("lancamentos?select=*", session),
    ])
      .then(([c, f, l]) => {
        setCargos((c || []).map(cargoFromRow));
        setFuncionarios((f || []).map(funcionarioFromRow));
        setLancamentos((l || []).map(lancamentoFromRow));
      })
      .catch((e) => setErro(e.message))
      .finally(() => setLoading(false));
  }, [session]);

  if (!session) {
    return <LoginScreen onLogin={setSession} />;
  }

  return (
    <div style={{ minHeight: "100vh", background: BG, color: TEXT, fontFamily: FONT_BODY }}>
      <Header tab={tab} setTab={setTab} onLogout={() => setSession(null)} />
      <main style={{ maxWidth: 1180, margin: "0 auto", padding: "28px 20px 80px" }}>
        {erro && (
          <div style={{ background: "#FDECEC", color: DANGER, padding: 12, borderRadius: 8, marginBottom: 16, fontSize: 13 }}>
            Erro ao falar com o Supabase: {erro}
          </div>
        )}
        {loading ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: MUTED }}>
            <Loader2 size={16} className="animate-spin" /> Carregando dados...
          </div>
        ) : (
          <>
            {tab === "cargos" && (
              <CargosView cargos={cargos} setCargos={setCargos} session={session} setErro={setErro} />
            )}
            {tab === "funcionarios" && (
              <FuncionariosView funcionarios={funcionarios} setFuncionarios={setFuncionarios} cargos={cargos} session={session} setErro={setErro} />
            )}
            {tab === "lancamentos" && (
              <LancamentosView
                funcionarios={funcionarios} cargos={cargos}
                lancamentos={lancamentos} setLancamentos={setLancamentos}
                mesRef={mesRef} setMesRef={setMesRef}
                session={session} setErro={setErro}
              />
            )}
            {tab === "relatorios" && (
              <RelatoriosView funcionarios={funcionarios} cargos={cargos} lancamentos={lancamentos} mesRef={mesRef} setMesRef={setMesRef} />
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ---------- Login ----------
function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setErro("");
    setCarregando(true);
    try {
      const data = await sbLogin(email, senha);
      onLogin(data);
    } catch (err) {
      setErro(err.message);
    } finally {
      setCarregando(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: NAVY, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT_BODY }}>
      <form onSubmit={handleSubmit} style={{ background: CARD, borderRadius: 14, padding: 32, width: 340, borderTop: `3px solid ${GOLD}` }}>
        <div style={{ fontFamily: FONT_MONO, fontSize: 11, letterSpacing: 2, color: GOLD, marginBottom: 4 }}>1385</div>
        <h1 style={{ margin: "0 0 22px", fontSize: 20, fontWeight: 700, color: NAVY }}>PROSIGN · Ponto</h1>
        {erro && <div style={{ background: "#FDECEC", color: DANGER, padding: 10, borderRadius: 8, fontSize: 13, marginBottom: 14 }}>{erro}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ fontSize: 12, color: MUTED }}>
            E-mail
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} style={{ ...inputStyle, width: "100%", marginTop: 5, boxSizing: "border-box" }} />
          </label>
          <label style={{ fontSize: 12, color: MUTED }}>
            Senha
            <input type="password" required value={senha} onChange={(e) => setSenha(e.target.value)} style={{ ...inputStyle, width: "100%", marginTop: 5, boxSizing: "border-box" }} />
          </label>
        </div>
        <button type="submit" disabled={carregando} style={{ ...btnPrimary, width: "100%", justifyContent: "center", marginTop: 20 }}>
          {carregando ? "Entrando..." : "Entrar"}
        </button>
        <div style={{ fontSize: 11, color: MUTED, marginTop: 14, textAlign: "center" }}>
          Usuários são criados no painel do Supabase (Authentication → Users).
        </div>
      </form>
    </div>
  );
}

// ---------- Header ----------
function Header({ tab, setTab, onLogout }) {
  const items = [
    { id: "cargos", label: "Cargos e Salários", icon: Briefcase },
    { id: "funcionarios", label: "Funcionários", icon: Users },
    { id: "lancamentos", label: "Lançamentos", icon: Clock },
    { id: "relatorios", label: "Relatórios", icon: FileBarChart },
  ];
  return (
    <header style={{ background: NAVY, borderBottom: `3px solid ${GOLD}` }}>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "18px 20px 0" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 12, letterSpacing: 2, color: GOLD }}>1385</span>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#fff", letterSpacing: 0.3 }}>
              PROSIGN <span style={{ fontWeight: 400, color: "#C7CEDB" }}>· Controle de Ponto</span>
            </h1>
          </div>
          <button onClick={onLogout} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: "#C7CEDB", cursor: "pointer", fontSize: 13 }}>
            <LogOut size={15} /> Sair
          </button>
        </div>
        <nav style={{ display: "flex", gap: 4 }}>
          {items.map((it) => {
            const Icon = it.icon;
            const active = tab === it.id;
            return (
              <button
                key={it.id}
                onClick={() => setTab(it.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "10px 18px", border: "none", cursor: "pointer",
                  background: active ? BG : "transparent",
                  color: active ? NAVY : "#C7CEDB",
                  borderRadius: "8px 8px 0 0",
                  fontFamily: FONT_BODY, fontSize: 14, fontWeight: active ? 600 : 500,
                }}
              >
                <Icon size={16} /> {it.label}
              </button>
            );
          })}
        </nav>
      </div>
    </header>
  );
}

function Card({ children, style }) {
  return <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 22, ...style }}>{children}</div>;
}

function MesPicker({ mesRef, setMesRef }) {
  const [ano, mes] = mesRef.split("-");
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <select value={mes} onChange={(e) => setMesRef(`${ano}-${e.target.value}`)} style={selStyle}>
        {MESES.map((m, i) => <option key={m} value={m}>{["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"][i]}</option>)}
      </select>
      <select value={ano} onChange={(e) => setMesRef(`${e.target.value}-${mes}`)} style={selStyle}>
        {[2024,2025,2026,2027].map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: MUTED }}>
      {label}
      {children}
    </label>
  );
}

// =========================================================
// Cargos e Salários
// =========================================================
function CargosView({ cargos, setCargos, session, setErro }) {
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [salvando, setSalvando] = useState(false);

  async function handleSave(c) {
    setSalvando(true);
    setErro("");
    try {
      if (c.id) {
        const [row] = await sbRequest(`cargos?id=eq.${c.id}`, session, { method: "PATCH", body: cargoToRow(c) });
        setCargos(cargos.map((x) => (x.id === c.id ? cargoFromRow(row) : x)));
      } else {
        const [row] = await sbRequest("cargos", session, { method: "POST", body: cargoToRow(c) });
        setCargos([...cargos, cargoFromRow(row)]);
      }
      setShowForm(false);
      setEditing(null);
    } catch (e) { setErro(e.message); }
    finally { setSalvando(false); }
  }
  async function handleDelete(id) {
    try {
      await sbRequest(`cargos?id=eq.${id}`, session, { method: "DELETE" });
      setCargos(cargos.filter((x) => x.id !== id));
    } catch (e) { setErro(e.message); }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Cargos e Salários ({cargos.length})</h2>
        <button onClick={() => { setEditing(null); setShowForm(true); }} style={btnPrimary}><Plus size={16} /> Novo cargo</button>
      </div>

      {showForm && <CargoForm initial={editing} onCancel={() => { setShowForm(false); setEditing(null); }} onSave={handleSave} salvando={salvando} />}

      <Card style={{ padding: 0, overflow: "hidden", marginTop: 18 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#F0F2F6", textAlign: "left" }}>
              {["Função", "CBO", "Salário-base", ""].map((h) => (
                <th key={h} style={{ padding: "10px 14px", fontWeight: 600, color: MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cargos.map((c) => (
              <tr key={c.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                <td style={{ padding: "10px 14px", fontWeight: 600 }}>{c.funcao}</td>
                <td style={{ padding: "10px 14px", fontFamily: FONT_MONO, color: MUTED }}>{c.cbo}</td>
                <td style={{ padding: "10px 14px", fontFamily: FONT_MONO }}>{brl(c.salario)}</td>
                <td style={{ padding: "10px 14px", textAlign: "right" }}>
                  <button onClick={() => { setEditing(c); setShowForm(true); }} style={btnGhostSmall}>Editar</button>{" "}
                  <button onClick={() => handleDelete(c.id)} style={btnDangerSmall}><Trash2 size={13} /></button>
                </td>
              </tr>
            ))}
            {cargos.length === 0 && <tr><td colSpan={4} style={{ padding: 20, color: MUTED, textAlign: "center" }}>Nenhum cargo cadastrado ainda.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function CargoForm({ initial, onCancel, onSave, salvando }) {
  const [c, setC] = useState(initial || { funcao: "", cbo: "", salario: "" });
  return (
    <Card style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{initial ? "Editar cargo" : "Novo cargo"}</h3>
        <button onClick={onCancel} style={{ background: "none", border: "none", cursor: "pointer", color: MUTED }}><X size={18} /></button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
        <Field label="Função"><input style={inputStyle} value={c.funcao} onChange={(e) => setC({ ...c, funcao: e.target.value })} /></Field>
        <Field label="Código CBO"><input style={inputStyle} placeholder="0000-00" value={c.cbo} onChange={(e) => setC({ ...c, cbo: e.target.value })} /></Field>
        <Field label="Salário-base (R$)"><input type="number" step="0.01" style={inputStyle} value={c.salario} onChange={(e) => setC({ ...c, salario: parseFloat(e.target.value) || 0 })} /></Field>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button onClick={onCancel} style={btnGhostSmall}>Cancelar</button>
        <button onClick={() => onSave(c)} disabled={salvando} style={btnPrimary}><Save size={15} /> {salvando ? "Salvando..." : "Salvar"}</button>
      </div>
    </Card>
  );
}

// =========================================================
// Funcionários
// =========================================================
function FuncionariosView({ funcionarios, setFuncionarios, cargos, session, setErro }) {
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [salvando, setSalvando] = useState(false);

  async function handleSave(f) {
    setSalvando(true);
    setErro("");
    try {
      let fotoUrl = f.fotoUrl;
      if (f.fotoFile) {
        const ext = f.fotoFile.name.split(".").pop();
        const path = `${f.codigo || Date.now()}-${Date.now()}.${ext}`;
        fotoUrl = await sbUploadFoto(f.fotoFile, path, session);
      }
      const payload = funcionarioToRow({ ...f, fotoUrl });
      if (f.id) {
        const [row] = await sbRequest(`funcionarios?id=eq.${f.id}`, session, { method: "PATCH", body: payload });
        setFuncionarios(funcionarios.map((x) => (x.id === f.id ? funcionarioFromRow(row) : x)));
      } else {
        const [row] = await sbRequest("funcionarios", session, { method: "POST", body: payload });
        setFuncionarios([...funcionarios, funcionarioFromRow(row)]);
      }
      setShowForm(false);
      setEditing(null);
    } catch (e) { setErro(e.message); }
    finally { setSalvando(false); }
  }
  async function handleDelete(id) {
    try {
      await sbRequest(`funcionarios?id=eq.${id}`, session, { method: "DELETE" });
      setFuncionarios(funcionarios.filter((x) => x.id !== id));
    } catch (e) { setErro(e.message); }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Funcionários ({funcionarios.length})</h2>
        <button onClick={() => { setEditing(null); setShowForm(true); }} style={btnPrimary}><Plus size={16} /> Novo funcionário</button>
      </div>

      {showForm && (
        <FuncionarioForm initial={editing} cargos={cargos} onCancel={() => { setShowForm(false); setEditing(null); }} onSave={handleSave} salvando={salvando} />
      )}

      {!showForm && cargos.length === 0 && (
        <div style={{ color: MUTED, fontSize: 13, marginBottom: 14 }}>Cadastre ao menos um cargo em "Cargos e Salários" antes de adicionar funcionários.</div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14, marginTop: 18 }}>
        {funcionarios.map((f) => {
          const cargo = cargos.find((c) => c.id === f.cargoId);
          const salarioTotal = (cargo?.salario || 0) + (f.gratificacao || 0);
          return (
            <Card key={f.id} style={{ padding: 16 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <div style={{ width: 52, height: 52, borderRadius: "50%", overflow: "hidden", background: "#EEF1F5", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", border: `2px solid ${BORDER}` }}>
                  {f.fotoUrl ? <img src={f.fotoUrl} alt={f.nome} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Users size={22} color={MUTED} />}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.nome}</div>
                  <div style={{ fontSize: 12, color: MUTED }}>{f.codigo} · {cargo?.funcao || "sem cargo"}</div>
                </div>
              </div>
              <div style={{ marginTop: 10, fontSize: 12, color: MUTED, fontFamily: FONT_MONO }}>
                Admissão {f.admissao} · {brl(salarioTotal)}
                {f.gratificacao > 0 && <span style={{ color: GOLD }}> (+{brl(f.gratificacao)} grat.)</span>}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button onClick={() => { setEditing(f); setShowForm(true); }} style={btnGhostSmall}>Editar</button>
                <button onClick={() => handleDelete(f.id)} style={btnDangerSmall}><Trash2 size={13} /></button>
              </div>
            </Card>
          );
        })}
        {funcionarios.length === 0 && <div style={{ color: MUTED, fontSize: 14 }}>Nenhum funcionário cadastrado ainda.</div>}
      </div>
    </div>
  );
}

function FuncionarioForm({ initial, onCancel, onSave, cargos, salvando }) {
  const [f, setF] = useState(initial || { codigo: "", nome: "", cargoId: cargos[0]?.id || "", gratificacao: 0, admissao: "", fotoUrl: "" });
  const [preview, setPreview] = useState(initial?.fotoUrl || "");
  const fileRef = useRef();

  function handleFoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setF((s) => ({ ...s, fotoFile: file }));
    setPreview(URL.createObjectURL(file));
  }

  return (
    <Card style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{initial ? "Editar funcionário" : "Novo funcionário"}</h3>
        <button onClick={onCancel} style={{ background: "none", border: "none", cursor: "pointer", color: MUTED }}><X size={18} /></button>
      </div>
      <div style={{ display: "flex", gap: 20 }}>
        <div style={{ flexShrink: 0 }}>
          <div onClick={() => fileRef.current.click()} style={{ width: 96, height: 96, borderRadius: "50%", background: "#EEF1F5", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", border: `2px dashed ${BORDER}` }}>
            {preview ? <img src={preview} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Upload size={22} color={MUTED} />}
          </div>
          <input type="file" accept="image/*" ref={fileRef} onChange={handleFoto} style={{ display: "none" }} />
          <div style={{ fontSize: 11, color: MUTED, textAlign: "center", marginTop: 6 }}>Foto</div>
        </div>
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Código"><input style={inputStyle} value={f.codigo} onChange={(e) => setF({ ...f, codigo: e.target.value })} /></Field>
          <Field label="Nome completo"><input style={inputStyle} value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} /></Field>
          <Field label="Cargo">
            <select style={inputStyle} value={f.cargoId} onChange={(e) => setF({ ...f, cargoId: e.target.value })}>
              <option value="">Selecione...</option>
              {cargos.map((c) => <option key={c.id} value={c.id}>{c.funcao} ({brl(c.salario)})</option>)}
            </select>
          </Field>
          <Field label="Admissão"><input type="date" style={inputStyle} value={f.admissao} onChange={(e) => setF({ ...f, admissao: e.target.value })} /></Field>
          <Field label="Gratificação (R$)"><input type="number" step="0.01" style={inputStyle} value={f.gratificacao} onChange={(e) => setF({ ...f, gratificacao: parseFloat(e.target.value) || 0 })} /></Field>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button onClick={onCancel} style={btnGhostSmall}>Cancelar</button>
        <button onClick={() => onSave(f)} disabled={salvando} style={btnPrimary}><Save size={15} /> {salvando ? "Salvando..." : "Salvar"}</button>
      </div>
    </Card>
  );
}

// =========================================================
// Lançamentos
// =========================================================
function LancamentosView({ funcionarios, cargos, lancamentos, setLancamentos, mesRef, setMesRef, session, setErro }) {
  const [selId, setSelId] = useState(funcionarios[0]?.id || "");
  const [salvando, setSalvando] = useState(false);
  const funcionario = funcionarios.find((f) => f.id === selId);

  const blank = { funcionarioId: selId, mes: mesRef, he50: 0, he60: 0, he100: 0, adicNot: 0, heNot50: 0, heNot60: 0, heNot100: 0, faltasDias: 0, faltasHoras: 0, dsrDias: 0, atestadoDias: 0 };
  const [form, setForm] = useState(blank);

  useEffect(() => {
    const ex = lancamentos.find((l) => l.funcionarioId === selId && l.mes === mesRef);
    setForm(ex || { ...blank, funcionarioId: selId, mes: mesRef });
  }, [selId, mesRef]); // eslint-disable-line

  async function handleSalvar() {
    setSalvando(true);
    setErro("");
    try {
      const row = lancamentoToRow(form);
      const [saved] = await sbRequest("lancamentos?on_conflict=funcionario_id,mes_referencia", session, {
        method: "POST", body: row, extraHeaders: { Prefer: "resolution=merge-duplicates,return=representation" },
      });
      const novo = lancamentoFromRow(saved);
      const next = lancamentos.some((l) => l.id === novo.id)
        ? lancamentos.map((l) => (l.id === novo.id ? novo : l))
        : [...lancamentos.filter((l) => !(l.funcionarioId === selId && l.mes === mesRef)), novo];
      setLancamentos(next);
      setForm(novo);
    } catch (e) { setErro(e.message); }
    finally { setSalvando(false); }
  }

  if (!funcionarios.length) return <div style={{ color: MUTED }}>Cadastre um funcionário primeiro na aba "Funcionários".</div>;

  const preview = funcionario ? calcularLancamento(funcionario, cargos, form) : null;

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 18, flexWrap: "wrap", alignItems: "center" }}>
        <select value={selId} onChange={(e) => setSelId(e.target.value)} style={{ ...selStyle, minWidth: 240 }}>
          {funcionarios.map((f) => <option key={f.id} value={f.id}>{f.codigo} — {f.nome}</option>)}
        </select>
        <MesPicker mesRef={mesRef} setMesRef={setMesRef} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 18 }}>
        <Card>
          <h3 style={{ marginTop: 0, fontSize: 14, color: MUTED, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Horas extras (hh:mm)</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 }}>
            {CAMPOS_LANC.map((c) => (
              <Field key={c.key} label={c.label}>
                <input style={inputStyle} placeholder="0:00" defaultValue={decimalToHHMM(form[c.key])} onBlur={(e) => setForm((s) => ({ ...s, [c.key]: hhmmToDecimal(e.target.value) }))} />
              </Field>
            ))}
          </div>
          <h3 style={{ fontSize: 14, color: MUTED, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Faltas / DSR / Atestado</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Faltas não just. (dias)"><input type="number" style={inputStyle} value={form.faltasDias} onChange={(e) => setForm({ ...form, faltasDias: parseFloat(e.target.value) || 0 })} /></Field>
            <Field label="Faltas não just. (hh:mm)"><input style={inputStyle} placeholder="0:00" defaultValue={decimalToHHMM(form.faltasHoras)} onBlur={(e) => setForm((s) => ({ ...s, faltasHoras: hhmmToDecimal(e.target.value) }))} /></Field>
            <Field label="D.S.R. perdido (dias)"><input type="number" style={inputStyle} value={form.dsrDias} onChange={(e) => setForm({ ...form, dsrDias: parseFloat(e.target.value) || 0 })} /></Field>
            <Field label="Atestado (dias)"><input type="number" style={inputStyle} value={form.atestadoDias} onChange={(e) => setForm({ ...form, atestadoDias: parseFloat(e.target.value) || 0 })} /></Field>
          </div>
          <button onClick={handleSalvar} disabled={salvando} style={{ ...btnPrimary, marginTop: 18 }}><Save size={15} /> {salvando ? "Salvando..." : "Salvar lançamento"}</button>
        </Card>

        {preview && (
          <Card style={{ background: NAVY, color: "#fff", height: "fit-content" }}>
            <div style={{ fontSize: 12, color: "#9FB0CC", textTransform: "uppercase", letterSpacing: 0.5 }}>Prévia do cálculo</div>
            <div style={{ fontSize: 13, color: "#C7CEDB", marginTop: 4, fontFamily: FONT_MONO }}>Base: {brl(preview.salario)} · Hora: {brl(preview.valorHora)}</div>
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
              {preview.linhas.filter((l) => l.horas > 0).map((l) => (
                <div key={l.key} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                  <span style={{ color: "#C7CEDB" }}>{l.label} {l.excedente > 0 && <span style={{ color: "#FFB86C" }}>({decimalToHHMM(l.dentro)} + {decimalToHHMM(l.excedente)} exced.)</span>}</span>
                  <span style={{ fontFamily: FONT_MONO, color: GOLD }}>{brl(l.valorDentro)}</span>
                </div>
              ))}
            </div>
            <div style={{ borderTop: "1px solid rgba(255,255,255,.15)", marginTop: 12, paddingTop: 12, display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
              <span>Total extras (até 40h)</span><span style={{ fontFamily: FONT_MONO }}>{brl(preview.totalValorExtras)}</span>
            </div>
            {preview.totalHorasExcedentes > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#FFB86C", marginTop: 6 }}>
                <span>Pagamento de Extras (&gt;40h, {decimalToHHMM(preview.totalHorasExcedentes)})</span>
                <span style={{ fontFamily: FONT_MONO }}>{brl(preview.totalValorExcedentes)}</span>
              </div>
            )}
            {preview.totalDescontos > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#FF9DA8", marginTop: 6 }}>
                <span>Descontos (faltas/DSR)</span><span style={{ fontFamily: FONT_MONO }}>- {brl(preview.totalDescontos)}</span>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 15, fontWeight: 700, color: GOLD }}>
              <span>Líquido (folha normal)</span><span style={{ fontFamily: FONT_MONO }}>{brl(preview.liquido)}</span>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

// =========================================================
// Relatórios
// =========================================================
function RelatoriosView({ funcionarios, cargos, lancamentos, mesRef, setMesRef }) {
  const rows = useMemo(() => funcionarios.map((f) => {
    const lanc = lancamentos.find((l) => l.funcionarioId === f.id && l.mes === mesRef) || {};
    const calc = calcularLancamento(f, cargos, lanc);
    const cargo = cargos.find((c) => c.id === f.cargoId);
    return { f, cargo, lanc, calc };
  }), [funcionarios, cargos, lancamentos, mesRef]);

  const totalGeral = rows.reduce((s, r) => s + r.calc.liquido, 0);
  const totalExtras = rows.reduce((s, r) => s + r.calc.totalValorExtras, 0);
  const totalDesc = rows.reduce((s, r) => s + r.calc.totalDescontos, 0);
  const totalExcedentes = rows.reduce((s, r) => s + r.calc.totalValorExcedentes, 0);
  const rowsComExcedente = rows.filter((r) => r.calc.totalHorasExcedentes > 0);

  function exportCSV() {
    const header = ["Código","Nome","Função","H.Extras (até 40h)","Valor Extras","H.Excedentes","Valor Excedentes","Descontos","Líquido"];
    const lines = rows.map((r) => [r.f.codigo, r.f.nome, r.cargo?.funcao || "", r.calc.totalHorasExtras.toFixed(2), r.calc.totalValorExtras.toFixed(2), r.calc.totalHorasExcedentes.toFixed(2), r.calc.totalValorExcedentes.toFixed(2), r.calc.totalDescontos.toFixed(2), r.calc.liquido.toFixed(2)]);
    const csv = [header, ...lines].map((l) => l.join(";")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `prosign_ponto_${mesRef}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Relatório mensal</h2>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <MesPicker mesRef={mesRef} setMesRef={setMesRef} />
          <button onClick={exportCSV} style={btnPrimary}>Exportar CSV</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 18 }}>
        <SummaryCard label="Extras (até 40h)" value={brl(totalExtras)} color={OK} />
        <SummaryCard label="Pagamento de Extras (>40h)" value={brl(totalExcedentes)} color={GOLD} />
        <SummaryCard label="Total de descontos" value={brl(totalDesc)} color={DANGER} />
        <SummaryCard label="Líquido geral" value={brl(totalGeral)} color={GOLD} dark />
      </div>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#F0F2F6", textAlign: "left" }}>
                {["Funcionário","Distribuição","H.Extras (40h)","Extras (R$)","Descontos","Líquido"].map((h) => (
                  <th key={h} style={{ padding: "10px 14px", fontWeight: 600, color: MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ f, cargo, calc }) => (
                <tr key={f.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                  <td style={{ padding: "12px 14px" }}>
                    <div style={{ fontWeight: 600 }}>{f.nome}</div>
                    <div style={{ fontSize: 11, color: MUTED }}>{f.codigo} · {cargo?.funcao || "sem cargo"}</div>
                  </td>
                  <td style={{ padding: "12px 14px", width: 160 }}><StackedBar linhas={calc.linhas} /></td>
                  <td style={{ padding: "12px 14px", fontFamily: FONT_MONO }}>{decimalToHHMM(calc.totalHorasExtras)}</td>
                  <td style={{ padding: "12px 14px", fontFamily: FONT_MONO, color: OK }}>{brl(calc.totalValorExtras)}</td>
                  <td style={{ padding: "12px 14px", fontFamily: FONT_MONO, color: calc.totalDescontos > 0 ? DANGER : MUTED }}>{calc.totalDescontos > 0 ? `- ${brl(calc.totalDescontos)}` : "-"}</td>
                  <td style={{ padding: "12px 14px", fontFamily: FONT_MONO, fontWeight: 700 }}>{brl(calc.liquido)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} style={{ padding: 20, color: MUTED, textAlign: "center" }}>Nenhum funcionário cadastrado.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      {rowsComExcedente.length > 0 && (
        <>
          <h3 style={{ fontSize: 15, fontWeight: 700, marginTop: 26, marginBottom: 12 }}>
            Pagamento de Extras <span style={{ color: MUTED, fontWeight: 400 }}>(horas acima do teto de 40h/mês)</span>
          </h3>
          <Card style={{ padding: 0, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#FBF3E3", textAlign: "left" }}>
                  {["Funcionário","H.Excedentes","Valor Excedente"].map((h) => (
                    <th key={h} style={{ padding: "10px 14px", fontWeight: 600, color: "#8A6A20", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rowsComExcedente.map(({ f, cargo, calc }) => (
                  <tr key={f.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                    <td style={{ padding: "12px 14px" }}>
                      <div style={{ fontWeight: 600 }}>{f.nome}</div>
                      <div style={{ fontSize: 11, color: MUTED }}>{f.codigo} · {cargo?.funcao || "sem cargo"}</div>
                    </td>
                    <td style={{ padding: "12px 14px", fontFamily: FONT_MONO }}>{decimalToHHMM(calc.totalHorasExcedentes)}</td>
                    <td style={{ padding: "12px 14px", fontFamily: FONT_MONO, color: GOLD, fontWeight: 700 }}>{brl(calc.totalValorExcedentes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, color, dark }) {
  return (
    <Card style={dark ? { background: NAVY_DARK, color: "#fff" } : {}}>
      <div style={{ fontSize: 11, color: dark ? "#9FB0CC" : MUTED, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, fontFamily: FONT_MONO, color, marginTop: 4 }}>{value}</div>
    </Card>
  );
}

const BAR_COLORS = { he50: "#8FA6C9", he60: "#5D7FAE", he100: "#2F4E7D", adicNot: "#B8902E", heNot50: "#C79A4B", heNot60: "#A6394A", heNot100: "#6B2530" };
function StackedBar({ linhas }) {
  const total = linhas.reduce((s, l) => s + (l.soAdicional ? 0 : l.dentro), 0);
  if (total === 0) return <div style={{ fontSize: 11, color: MUTED }}>—</div>;
  return (
    <div style={{ display: "flex", height: 10, borderRadius: 4, overflow: "hidden", width: "100%" }} title="Distribuição de horas extras (até 40h)">
      {linhas.filter((l) => !l.soAdicional && l.dentro > 0).map((l) => (
        <div key={l.key} style={{ width: `${(l.dentro / total) * 100}%`, background: BAR_COLORS[l.key] }} />
      ))}
    </div>
  );
}
