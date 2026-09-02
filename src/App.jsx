import { useState, useEffect, useMemo, useRef } from "react";
import { Users, Clock, FileBarChart, Plus, Trash2, Upload, X, Save, Briefcase, LogOut, Loader2 } from "lucide-react";

// =========================================================
// CONFIGURAÇÃO DO SUPABASE — preencha com os dados do seu projeto
// (Settings → API no painel do Supabase)
// =========================================================
const SUPABASE_URL = "https://zmkpfiqtwfcknwzzolcv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpta3BmaXF0d2Zja253enpvbGN2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwODM3NTUsImV4cCI6MjEwMjY1OTc1NX0.Ip2BA9g82dVPiruT71Ae47xsX9_qZ1sWr5_FtTuEtv4";
const FOTOS_BUCKET = "funcionarios-fotos";

// ---------- constants ----------
const DIVISOR_HORA = 220;
const TETO_HORA_EXTRA = 40;
const MESES = ["01","02","03","04","05","06","07","08","09","10","11","12"];

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
// CLASSIFICAÇÃO AUTOMÁTICA DE PONTO DIÁRIO
// =========================================================
const HORARIOS_SEMANA = {
  1: { inicio: "08:30", fim: "17:30" },
  2: { inicio: "08:00", fim: "18:00" },
  3: { inicio: "08:00", fim: "18:00" },
  4: { inicio: "08:00", fim: "18:00" },
  5: { inicio: "08:00", fim: "18:00" },
};
const ALMOCO = { inicio: "12:00", fim: "13:00" };
const NOITE_INICIO = "22:00";
const NOITE_FIM = "05:00";

function toMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function diaVazio() {
  return { he50: 0, he60: 0, he100: 0, heNot50: 0, heNot60: 0, heNot100: 0, adicNot: 0, normal: 0 };
}

function classificarPeriodo(entradaStr, saidaStr, dataISO, feriado) {
  if (!entradaStr || !saidaStr || !dataISO) return diaVazio();
  const weekday = new Date(dataISO + "T00:00:00").getDay();

  let entrada = toMin(entradaStr);
  let saida = toMin(saidaStr);
  if (saida <= entrada) saida += 24 * 60;

  let horario = null;
  let percentual;
  if (feriado || weekday === 0) {
    percentual = "he100";
  } else if (weekday === 6) {
    percentual = "he60";
  } else {
    const h = HORARIOS_SEMANA[weekday];
    horario = { inicio: toMin(h.inicio), fim: toMin(h.fim) };
    percentual = "he50";
  }

  const almocoIni = toMin(ALMOCO.inicio);
  const almocoFim = toMin(ALMOCO.fim);
  const noiteIni = toMin(NOITE_INICIO);
  const noiteFim = toMin(NOITE_FIM);

  const NOT_MAP = { he50: "heNot50", he60: "heNot60", he100: "heNot100" };
  const buckets = diaVazio();

  for (let m = entrada; m < saida; m++) {
    const mod = m % 1440;
    if (horario && mod >= almocoIni && mod < almocoFim) continue;
    const noite = mod >= noiteIni || mod < noiteFim;
    const dentroHorario = horario && mod >= horario.inicio && mod < horario.fim;
    if (dentroHorario) {
      buckets.normal += 1;
      if (noite) buckets.adicNot += 1;
    } else {
      buckets[noite ? NOT_MAP[percentual] : percentual] += 1;
    }
  }
  Object.keys(buckets).forEach((k) => (buckets[k] = buckets[k] / 60));
  return buckets;
}

function somarBuckets(a, b) {
  const out = diaVazio();
  Object.keys(out).forEach((k) => (out[k] = (a[k] || 0) + (b[k] || 0)));
  return out;
}

function classificarDia(registro) {
  const { entrada, saida, entrada2, saida2, entrada3, saida3, data, feriado, almocoHoras } = registro;
  const temHorarioFixo = diaTemHorarioFixo(data, feriado);

  let saida1Ajustada = saida;
  if (!temHorarioFixo && almocoHoras > 0 && entrada && saida) {
    let e = toMin(entrada);
    let s = toMin(saida);
    if (s <= e) s += 24 * 60;
    s -= Math.round(almocoHoras * 60);
    if (s <= e) s = e;
    const hh = Math.floor((s % 1440) / 60);
    const mm = (s % 1440) % 60;
    saida1Ajustada = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }

  let buckets = classificarPeriodo(entrada, saida1Ajustada, data, feriado);
  if (entrada2 && saida2) buckets = somarBuckets(buckets, classificarPeriodo(entrada2, saida2, data, feriado));
  if (entrada3 && saida3) buckets = somarBuckets(buckets, classificarPeriodo(entrada3, saida3, data, feriado));
  return buckets;
}

function agregarMes(registros) {
  const soma = diaVazio();
  registros.forEach((r) => {
    const c = classificarDia(r);
    Object.keys(soma).forEach((k) => (soma[k] += c[k]));
  });
  return soma;
}

function mesRange(mesRef) {
  const [ano, mes] = mesRef.split("-").map(Number);
  const inicio = `${mesRef}-01`;
  const fimExclusivo = mes === 12 ? `${ano + 1}-01-01` : `${ano}-${String(mes + 1).padStart(2, "0")}-01`;
  return { inicio, fimExclusivo };
}

const DIAS_SEMANA = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
function diaSemanaLabel(dataISO) {
  return DIAS_SEMANA[new Date(dataISO + "T00:00:00").getDay()];
}
function diaTemHorarioFixo(dataISO, feriado) {
  if (!dataISO) return true;
  const weekday = new Date(dataISO + "T00:00:00").getDay();
  return !feriado && weekday !== 0 && weekday !== 6;
}
const NOMES_MESES_EXTENSO = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
function mesRefExtenso(mesRef) {
  const [ano, mes] = mesRef.split("-").map(Number);
  return `${NOMES_MESES_EXTENSO[mes - 1]} de ${ano}`;
}

// =========================================================
// CAMADA SUPABASE
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
  return data;
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

function registroFromRow(r) {
  return {
    id: r.id, funcionarioId: r.funcionario_id, data: r.data,
    entrada: (r.hora_entrada || "").slice(0,5), saida: (r.hora_saida || "").slice(0,5),
    entrada2: (r.hora_entrada_2 || "").slice(0,5), saida2: (r.hora_saida_2 || "").slice(0,5),
    entrada3: (r.hora_entrada_3 || "").slice(0,5), saida3: (r.hora_saida_3 || "").slice(0,5),
    feriado: !!r.feriado, almocoHoras: Number(r.almoco_horas || 0),
    observacao: r.observacao || "",
  };
}
function registroToRow(r) {
  return {
    funcionario_id: r.funcionarioId, data: r.data,
    hora_entrada: r.entrada || null, hora_saida: r.saida || null,
    hora_entrada_2: r.entrada2 || null, hora_saida_2: r.saida2 || null,
    hora_entrada_3: r.entrada3 || null, hora_saida_3: r.saida3 || null,
    feriado: !!r.feriado, almoco_horas: r.almocoHoras || 0,
    observacao: r.observacao || null,
  };
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
              <RelatoriosView funcionarios={funcionarios} cargos={cargos} lancamentos={lancamentos} mesRef={mesRef} setMesRef={setMesRef} session={session} setErro={setErro} />
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
// Lançamentos — bate ponto diário + faltas/DSR/atestado mensal
// =========================================================
function LancamentosView({ funcionarios, cargos, lancamentos, setLancamentos, mesRef, setMesRef, session, setErro }) {
  const [selId, setSelId] = useState(funcionarios[0]?.id || "");
  const [registros, setRegistros] = useState([]);
  const [carregandoRegistros, setCarregandoRegistros] = useState(false);
  const [salvandoPonto, setSalvandoPonto] = useState(false);
  const [salvandoFaltas, setSalvandoFaltas] = useState(false);
  const funcionario = funcionarios.find((f) => String(f.id) === String(selId));

  const blankPonto = {
    data: `${mesRef}-01`, entrada: "", saida: "", feriado: false,
    temAlmoco: false, almocoHoras: 0,
    mostrarTurno2: false, entrada2: "", saida2: "",
    mostrarTurno3: false, entrada3: "", saida3: "",
    observacao: "",
  };
  const [pontoForm, setPontoForm] = useState(blankPonto);

  const blankFaltas = { funcionarioId: selId, mes: mesRef, faltasDias: 0, faltasHoras: 0, dsrDias: 0, atestadoDias: 0 };
  const [faltasForm, setFaltasForm] = useState(blankFaltas);

  useEffect(() => {
    const ex = lancamentos.find((l) => String(l.funcionarioId) === String(selId) && l.mes === mesRef);
    setFaltasForm(ex || { ...blankFaltas, funcionarioId: selId, mes: mesRef });
    setPontoForm({ ...blankPonto, data: `${mesRef}-01` });
  }, [selId, mesRef]); // eslint-disable-line

  useEffect(() => {
    if (!selId) return;
    const { inicio, fimExclusivo } = mesRange(mesRef);
    setCarregandoRegistros(true);
    sbRequest(`registros_ponto?select=*&funcionario_id=eq.${selId}&data=gte.${inicio}&data=lt.${fimExclusivo}&order=data.asc`, session)
      .then((rows) => setRegistros((rows || []).map(registroFromRow)))
      .catch((e) => setErro(e.message))
      .finally(() => setCarregandoRegistros(false));
  }, [selId, mesRef, session]); // eslint-disable-line

  async function handleSalvarPonto() {
    if (!pontoForm.data || !pontoForm.entrada || !pontoForm.saida) return;
    setSalvandoPonto(true);
    setErro("");
    try {
      const almocoHoras = pontoForm.temAlmoco ? pontoForm.almocoHoras : 0;
      const entrada2 = pontoForm.mostrarTurno2 ? pontoForm.entrada2 : "";
      const saida2 = pontoForm.mostrarTurno2 ? pontoForm.saida2 : "";
      const entrada3 = pontoForm.mostrarTurno2 && pontoForm.mostrarTurno3 ? pontoForm.entrada3 : "";
      const saida3 = pontoForm.mostrarTurno2 && pontoForm.mostrarTurno3 ? pontoForm.saida3 : "";
      const row = registroToRow({ ...pontoForm, almocoHoras, entrada2, saida2, entrada3, saida3, funcionarioId: selId });
      const [saved] = await sbRequest("registros_ponto?on_conflict=funcionario_id,data", session, {
        method: "POST", body: row, extraHeaders: { Prefer: "resolution=merge-duplicates,return=representation" },
      });
      const novo = registroFromRow(saved);
      setRegistros((rs) => {
        const next = rs.some((r) => r.id === novo.id) ? rs.map((r) => (r.id === novo.id ? novo : r)) : [...rs, novo];
        return next.sort((a, b) => a.data.localeCompare(b.data));
      });
      setPontoForm({ ...blankPonto, data: pontoForm.data });
    } catch (e) { setErro(e.message); }
    finally { setSalvandoPonto(false); }
  }

  async function handleExcluirPonto(id) {
    try {
      await sbRequest(`registros_ponto?id=eq.${id}`, session, { method: "DELETE" });
      setRegistros((rs) => rs.filter((r) => r.id !== id));
    } catch (e) { setErro(e.message); }
  }

  async function handleSalvarFaltas() {
    setSalvandoFaltas(true);
    setErro("");
    try {
      const row = lancamentoToRow(faltasForm);
      const [saved] = await sbRequest("lancamentos?on_conflict=funcionario_id,mes_referencia", session, {
        method: "POST", body: row, extraHeaders: { Prefer: "resolution=merge-duplicates,return=representation" },
      });
      const novo = lancamentoFromRow(saved);
      const next = lancamentos.some((l) => l.id === novo.id)
        ? lancamentos.map((l) => (l.id === novo.id ? novo : l))
        : [...lancamentos.filter((l) => !(String(l.funcionarioId) === String(selId) && l.mes === mesRef)), novo];
      setLancamentos(next);
      setFaltasForm(novo);
    } catch (e) { setErro(e.message); }
    finally { setSalvandoFaltas(false); }
  }

  async function handleExcluirFaltas() {
    const existente = lancamentos.find((l) => String(l.funcionarioId) === String(selId) && l.mes === mesRef);
    if (!existente) {
      setFaltasForm({ ...blankFaltas, funcionarioId: selId, mes: mesRef });
      return;
    }
    if (!window.confirm("Excluir faltas/DSR/atestado deste funcionário neste mês?")) return;
    setSalvandoFaltas(true);
    setErro("");
    try {
      await sbRequest(`lancamentos?id=eq.${existente.id}`, session, { method: "DELETE" });
      setLancamentos(lancamentos.filter((l) => l.id !== existente.id));
      setFaltasForm({ ...blankFaltas, funcionarioId: selId, mes: mesRef });
    } catch (e) { setErro(e.message); }
    finally { setSalvandoFaltas(false); }
  }

  if (!funcionarios.length) return <div style={{ color: MUTED }}>Cadastre um funcionário primeiro na aba "Funcionários".</div>;

  const agregado = agregarMes(registros);
  const lancParaCalculo = { ...agregado, faltasDias: faltasForm.faltasDias, faltasHoras: faltasForm.faltasHoras, dsrDias: faltasForm.dsrDias };
  const preview = funcionario ? calcularLancamento(funcionario, cargos, lancParaCalculo) : null;
  const pontoFormSemHorarioFixo = !diaTemHorarioFixo(pontoForm.data, pontoForm.feriado);

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 18, flexWrap: "wrap", alignItems: "center" }}>
        <select value={selId} onChange={(e) => setSelId(e.target.value)} style={{ ...selStyle, minWidth: 240 }}>
          {funcionarios.map((f) => <option key={f.id} value={f.id}>{f.codigo} — {f.nome}</option>)}
        </select>
        <MesPicker mesRef={mesRef} setMesRef={setMesRef} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 18 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <Card>
            <h3 style={{ marginTop: 0, fontSize: 14, color: MUTED, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Bater ponto do dia</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 10, alignItems: "end" }}>
              <Field label="Data">
                <input type="date" style={inputStyle} value={pontoForm.data} onChange={(e) => setPontoForm({ ...pontoForm, data: e.target.value })} />
              </Field>
              <Field label="Entrada">
                <input type="time" style={inputStyle} value={pontoForm.entrada} onChange={(e) => setPontoForm({ ...pontoForm, entrada: e.target.value })} />
              </Field>
              <Field label="Saída">
                <input type="time" style={inputStyle} value={pontoForm.saida} onChange={(e) => setPontoForm({ ...pontoForm, saida: e.target.value })} />
              </Field>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: MUTED, paddingBottom: 9 }}>
                <input type="checkbox" checked={pontoForm.feriado} onChange={(e) => setPontoForm({ ...pontoForm, feriado: e.target.checked })} />
                Feriado
              </label>
            </div>

            {pontoFormSemHorarioFixo && (
              <div style={{ display: "flex", gap: 14, alignItems: "end", marginTop: 12, padding: 12, background: "#FBF3E3", borderRadius: 8 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#8A6A20" }}>
                  <input
                    type="checkbox"
                    checked={pontoForm.temAlmoco}
                    onChange={(e) => setPontoForm({ ...pontoForm, temAlmoco: e.target.checked, almocoHoras: e.target.checked ? (pontoForm.almocoHoras || 1) : 0 })}
                  />
                  Teve horário de almoço?
                </label>
                {pontoForm.temAlmoco && (
                  <Field label="Duração do almoço (hh:mm)">
                    <input
                      style={inputStyle}
                      placeholder="1:00"
                      defaultValue={decimalToHHMM(pontoForm.almocoHoras || 1)}
                      onBlur={(e) => setPontoForm((s) => ({ ...s, almocoHoras: hhmmToDecimal(e.target.value) }))}
                    />
                  </Field>
                )}
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              {!pontoForm.mostrarTurno2 ? (
                <button type="button" onClick={() => setPontoForm({ ...pontoForm, mostrarTurno2: true })} style={btnGhostSmall}>
                  + Adicionar 2º turno (voltou depois de ir embora)
                </button>
              ) : (
                <div style={{ padding: 12, background: "#F0F2F6", borderRadius: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: MUTED }}>2º turno</span>
                    <button
                      type="button"
                      onClick={() => setPontoForm({ ...pontoForm, mostrarTurno2: false, mostrarTurno3: false, entrada2: "", saida2: "", entrada3: "", saida3: "" })}
                      style={{ background: "none", border: "none", color: DANGER, cursor: "pointer", fontSize: 12 }}
                    >
                      Remover
                    </button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <Field label="Entrada">
                      <input type="time" style={inputStyle} value={pontoForm.entrada2} onChange={(e) => setPontoForm({ ...pontoForm, entrada2: e.target.value })} />
                    </Field>
                    <Field label="Saída">
                      <input type="time" style={inputStyle} value={pontoForm.saida2} onChange={(e) => setPontoForm({ ...pontoForm, saida2: e.target.value })} />
                    </Field>
                  </div>

                  {!pontoForm.mostrarTurno3 ? (
                    <button type="button" onClick={() => setPontoForm({ ...pontoForm, mostrarTurno3: true })} style={{ ...btnGhostSmall, marginTop: 10 }}>
                      + Adicionar 3º turno
                    </button>
                  ) : (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: MUTED }}>3º turno</span>
                        <button
                          type="button"
                          onClick={() => setPontoForm({ ...pontoForm, mostrarTurno3: false, entrada3: "", saida3: "" })}
                          style={{ background: "none", border: "none", color: DANGER, cursor: "pointer", fontSize: 12 }}
                        >
                          Remover
                        </button>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        <Field label="Entrada">
                          <input type="time" style={inputStyle} value={pontoForm.entrada3} onChange={(e) => setPontoForm({ ...pontoForm, entrada3: e.target.value })} />
                        </Field>
                        <Field label="Saída">
                          <input type="time" style={inputStyle} value={pontoForm.saida3} onChange={(e) => setPontoForm({ ...pontoForm, saida3: e.target.value })} />
                        </Field>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div style={{ marginTop: 12 }}>
              <Field label="Observação (motivo da hora extra, etc.)">
                <textarea
                  style={{ ...inputStyle, resize: "vertical", minHeight: 50, fontFamily: FONT_BODY, width: "100%", boxSizing: "border-box" }}
                  value={pontoForm.observacao}
                  onChange={(e) => setPontoForm({ ...pontoForm, observacao: e.target.value })}
                />
              </Field>
            </div>

            <button onClick={handleSalvarPonto} disabled={salvandoPonto} style={{ ...btnPrimary, marginTop: 14 }}>
              <Plus size={15} /> {salvandoPonto ? "Salvando..." : "Adicionar / atualizar dia"}
            </button>

            <div style={{ marginTop: 18, borderTop: `1px solid ${BORDER}`, paddingTop: 14 }}>
              {carregandoRegistros ? (
                <div style={{ fontSize: 13, color: MUTED }}>Carregando dias batidos...</div>
              ) : registros.length === 0 ? (
                <div style={{ fontSize: 13, color: MUTED }}>Nenhum dia registrado neste mês ainda.</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: MUTED }}>
                      <th style={{ padding: "4px 6px" }}>Dia</th>
                      <th style={{ padding: "4px 6px" }}>Entrada</th>
                      <th style={{ padding: "4px 6px" }}>Saída</th>
                      <th style={{ padding: "4px 6px" }}>Classificação</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {registros.map((r) => {
                      const c = classificarDia(r);
                      const tags = Object.entries(c).filter(([k, v]) => k !== "normal" && v > 0);
                      return (
                        <tr key={r.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                          <td style={{ padding: "6px" }}>
                            {r.data.slice(8,10)}/{r.data.slice(5,7)} · {diaSemanaLabel(r.data)}{r.feriado ? " 🎉" : ""}{r.almocoHoras > 0 ? ` 🍽️ ${decimalToHHMM(r.almocoHoras)}` : ""}
                            {r.observacao && <div style={{ fontSize: 10, color: MUTED, fontStyle: "italic", marginTop: 2, maxWidth: 140 }}>{r.observacao}</div>}
                          </td>
                          <td style={{ padding: "6px", fontFamily: FONT_MONO }}>
                            {r.entrada}
                            {r.entrada2 && <><br />{r.entrada2}</>}
                            {r.entrada3 && <><br />{r.entrada3}</>}
                          </td>
                          <td style={{ padding: "6px", fontFamily: FONT_MONO }}>
                            {r.saida}
                            {r.saida2 && <><br />{r.saida2}</>}
                            {r.saida3 && <><br />{r.saida3}</>}
                          </td>
                          <td style={{ padding: "6px" }}>
                            {tags.length === 0 ? <span style={{ color: MUTED }}>só horas normais</span> : tags.map(([k, v]) => (
                              <span key={k} style={{ marginRight: 8, color: BAR_COLORS[k] || MUTED }}>{CAMPOS_LANC.find((c2) => c2.key === k)?.label.replace("H. Extras ", "").replace("Adic. ", "") || k}: {decimalToHHMM(v)}</span>
                            ))}
                          </td>
                          <td style={{ padding: "6px", textAlign: "right" }}>
                            <button onClick={() => handleExcluirPonto(r.id)} style={{ background: "none", border: "none", color: DANGER, cursor: "pointer" }}><Trash2 size={13} /></button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </Card>

          <Card>
            <h3 style={{ marginTop: 0, fontSize: 14, color: MUTED, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Faltas / DSR / Atestado (mês)</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Faltas não just. (dias)"><input type="number" style={inputStyle} value={faltasForm.faltasDias} onChange={(e) => setFaltasForm({ ...faltasForm, faltasDias: parseFloat(e.target.value) || 0 })} /></Field>
              <Field label="Faltas não just. (hh:mm)"><input style={inputStyle} placeholder="0:00" defaultValue={decimalToHHMM(faltasForm.faltasHoras)} onBlur={(e) => setFaltasForm((s) => ({ ...s, faltasHoras: hhmmToDecimal(e.target.value) }))} /></Field>
              <Field label="D.S.R. perdido (dias)"><input type="number" style={inputStyle} value={faltasForm.dsrDias} onChange={(e) => setFaltasForm({ ...faltasForm, dsrDias: parseFloat(e.target.value) || 0 })} /></Field>
              <Field label="Atestado (dias)"><input type="number" style={inputStyle} value={faltasForm.atestadoDias} onChange={(e) => setFaltasForm({ ...faltasForm, atestadoDias: parseFloat(e.target.value) || 0 })} /></Field>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={handleSalvarFaltas} disabled={salvandoFaltas} style={btnPrimary}><Save size={15} /> {salvandoFaltas ? "Salvando..." : "Salvar faltas/DSR"}</button>
              <button onClick={handleExcluirFaltas} disabled={salvandoFaltas} style={btnDangerSmall}><Trash2 size={13} /> Excluir lançamento do mês</button>
            </div>
          </Card>
        </div>

        {preview && (
          <Card style={{ background: NAVY, color: "#fff", height: "fit-content" }}>
            <div style={{ fontSize: 12, color: "#9FB0CC", textTransform: "uppercase", letterSpacing: 0.5 }}>Prévia do cálculo (mês)</div>
            <div style={{ fontSize: 13, color: "#C7CEDB", marginTop: 4, fontFamily: FONT_MONO }}>Base: {brl(preview.salario)} · Hora: {brl(preview.valorHora)}</div>
            <div style={{ fontSize: 12, color: "#9FB0CC", marginTop: 8 }}>Horas normais batidas: {decimalToHHMM(agregado.normal)}</div>
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
function RelatoriosView({ funcionarios, cargos, lancamentos, mesRef, setMesRef, session, setErro }) {
  const [registrosMes, setRegistrosMes] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [filtro, setFiltro] = useState("tudo"); // 'tudo' | 'normais' | 'extras'
  const [funcSelId, setFuncSelId] = useState("todos");

  useEffect(() => {
    const { inicio, fimExclusivo } = mesRange(mesRef);
    setCarregando(true);
    sbRequest(`registros_ponto?select=*&data=gte.${inicio}&data=lt.${fimExclusivo}`, session)
      .then((rows) => setRegistrosMes((rows || []).map(registroFromRow)))
      .catch((e) => setErro(e.message))
      .finally(() => setCarregando(false));
  }, [mesRef, session]); // eslint-disable-line

  const rowsTodas = useMemo(() => funcionarios.map((f) => {
    const lancFaltas = lancamentos.find((l) => String(l.funcionarioId) === String(f.id) && l.mes === mesRef) || {};
    const registrosFunc = registrosMes.filter((r) => r.funcionarioId === f.id);
    const agregado = agregarMes(registrosFunc);
    const lanc = { ...agregado, faltasDias: lancFaltas.faltasDias || 0, faltasHoras: lancFaltas.faltasHoras || 0, dsrDias: lancFaltas.dsrDias || 0 };
    const calc = calcularLancamento(f, cargos, lanc);
    const cargo = cargos.find((c) => c.id === f.cargoId);
    return { f, cargo, lanc, calc, horasNormais: agregado.normal };
  }), [funcionarios, cargos, lancamentos, registrosMes, mesRef]);

  const rows = useMemo(
    () => (funcSelId === "todos" ? rowsTodas : rowsTodas.filter((r) => String(r.f.id) === String(funcSelId))),
    [rowsTodas, funcSelId]
  );

  const totalGeral = rows.reduce((s, r) => s + r.calc.liquido, 0);
  const totalExtras = rows.reduce((s, r) => s + r.calc.totalValorExtras, 0);
  const totalDesc = rows.reduce((s, r) => s + r.calc.totalDescontos, 0);
  const totalExcedentes = rows.reduce((s, r) => s + r.calc.totalValorExcedentes, 0);
  const totalHorasNormais = rows.reduce((s, r) => s + r.horasNormais, 0);
  const rowsComExcedente = rows.filter((r) => r.calc.totalHorasExcedentes > 0);

  const FILTROS = [
    { id: "tudo", label: "Tudo" },
    { id: "normais", label: "Só normais" },
    { id: "extras", label: "Só extras" },
  ];

  function imprimir() {
    window.print();
  }

  function exportCSV() {
    const meta = [
      ["Empresa", "PROSIGN"],
      ["Período de abrangência", mesRefExtenso(mesRef)],
      ["Funcionário(s)", funcSelId === "todos" ? "Todos" : rows[0]?.f.nome || ""],
      ["Funcionários no relatório", String(rows.length)],
      ["Visão", FILTROS.find((fl) => fl.id === filtro)?.label || ""],
      ["Gerado em", new Date().toLocaleString("pt-BR")],
      [],
    ];
    const header = ["Código","Nome","Função","H.Normais","H.Extras (até 40h)","Valor Extras","H.Excedentes","Valor Excedentes","Descontos","Líquido"];
    const lines = rows.map((r) => [r.f.codigo, r.f.nome, r.cargo?.funcao || "", r.horasNormais.toFixed(2), r.calc.totalHorasExtras.toFixed(2), r.calc.totalValorExtras.toFixed(2), r.calc.totalHorasExcedentes.toFixed(2), r.calc.totalValorExcedentes.toFixed(2), r.calc.totalDescontos.toFixed(2), r.calc.liquido.toFixed(2)]);
    const csv = [...meta, header, ...lines].map((l) => l.join(";")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = funcSelId === "todos" ? `prosign_ponto_${mesRef}.csv` : `prosign_ponto_${mesRef}_${(rows[0]?.f.codigo || rows[0]?.f.nome || "func").replace(/\s+/g, "_")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <style>{`
        @media print {
          .print-safe, .print-safe > * { display: block !important; }
          .print-safe-row > * { display: inline-block !important; margin-right: 18px !important; }
          .no-print { display: none !important; }
          body { background: #fff !important; }
        }
      `}</style>

      <div className="print-safe" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Relatório mensal</h2>
        <div className="no-print" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <select value={funcSelId} onChange={(e) => setFuncSelId(e.target.value)} style={selStyle}>
            <option value="todos">Todos os funcionários</option>
            {funcionarios.map((f) => <option key={f.id} value={f.id}>{f.codigo} — {f.nome}</option>)}
          </select>
          <MesPicker mesRef={mesRef} setMesRef={setMesRef} />
          <button onClick={imprimir} style={btnGhostSmall}>Imprimir</button>
          <button onClick={exportCSV} style={btnPrimary}>Exportar CSV</button>
        </div>
      </div>

      <Card style={{ padding: "16px 22px", marginBottom: 18, background: "#F8F6F0", border: `1px solid ${BORDER}` }}>
        <div className="print-safe-row" style={{ display: "flex", flexWrap: "wrap", gap: "6px 28px", fontSize: 13 }}>
          <span><strong>Empresa:</strong> PROSIGN</span>
          <span><strong>Período de abrangência:</strong> {mesRefExtenso(mesRef)}</span>
          <span><strong>Funcionário(s):</strong> {funcSelId === "todos" ? "Todos" : rows[0]?.f.nome || "-"}</span>
          <span><strong>Visão:</strong> {FILTROS.find((fl) => fl.id === filtro)?.label}</span>
          <span style={{ color: MUTED }}><strong>Gerado em:</strong> {new Date().toLocaleString("pt-BR")}</span>
        </div>
      </Card>

      <div className="no-print" style={{ display: "flex", gap: 6, marginBottom: 18 }}>
        {FILTROS.map((fl) => (
          <button
            key={fl.id}
            onClick={() => setFiltro(fl.id)}
            style={{
              padding: "8px 16px", borderRadius: 8, border: `1px solid ${filtro === fl.id ? NAVY : BORDER}`,
              background: filtro === fl.id ? NAVY : "#fff", color: filtro === fl.id ? "#fff" : TEXT,
              fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}
          >
            {fl.label}
          </button>
        ))}
      </div>

      <div className="print-safe" style={{ display: "grid", gridTemplateColumns: filtro === "tudo" ? "repeat(4, 1fr)" : "repeat(2, 1fr)", gap: 14, marginBottom: 18 }}>
        {filtro !== "extras" && <SummaryCard label="Horas normais" value={decimalToHHMM(totalHorasNormais)} color={NAVY} />}
        {filtro !== "normais" && <SummaryCard label="Extras (até 40h)" value={brl(totalExtras)} color={OK} />}
        {filtro === "tudo" && <SummaryCard label="Pagamento de Extras (>40h)" value={brl(totalExcedentes)} color={GOLD} />}
        {filtro === "tudo" && <SummaryCard label="Total de descontos" value={brl(totalDesc)} color={DANGER} />}
        {filtro === "tudo" && <SummaryCard label="Líquido geral" value={brl(totalGeral)} color={GOLD} dark />}
        {filtro === "normais" && <SummaryCard label="Média por funcionário" value={rows.length ? decimalToHHMM(totalHorasNormais / rows.length) : "-"} color={NAVY_DARK} dark />}
        {filtro === "extras" && <SummaryCard label="Valor total de extras" value={brl(totalExtras + totalExcedentes)} color={GOLD} dark />}
      </div>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#F0F2F6", textAlign: "left" }}>
                {[
                  "Funcionário",
                  ...(filtro !== "extras" ? ["H.Normais"] : []),
                  ...(filtro !== "normais" ? ["Distribuição", "H.Extras (40H)", "Extras (R$)"] : []),
                  ...(filtro === "tudo" ? ["Descontos", "Líquido"] : []),
                ].map((h) => (
                  <th key={h} style={{ padding: "10px 14px", fontWeight: 600, color: MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ f, cargo, calc, horasNormais }) => (
                <tr key={f.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                  <td style={{ padding: "12px 14px" }}>
                    <div style={{ fontWeight: 600 }}>{f.nome}</div>
                    <div style={{ fontSize: 11, color: MUTED }}>{f.codigo} · {cargo?.funcao || "sem cargo"}</div>
                  </td>
                  {filtro !== "extras" && (
                    <td style={{ padding: "12px 14px", fontFamily: FONT_MONO, color: NAVY, fontWeight: 600 }}>{decimalToHHMM(horasNormais)}</td>
                  )}
                  {filtro !== "normais" && (
                    <>
                      <td style={{ padding: "12px 14px", width: 160 }}><StackedBar linhas={calc.linhas} /></td>
                      <td style={{ padding: "12px 14px", fontFamily: FONT_MONO }}>{decimalToHHMM(calc.totalHorasExtras)}</td>
                      <td style={{ padding: "12px 14px", fontFamily: FONT_MONO, color: OK }}>{brl(calc.totalValorExtras)}</td>
                    </>
                  )}
                  {filtro === "tudo" && (
                    <>
                      <td style={{ padding: "12px 14px", fontFamily: FONT_MONO, color: calc.totalDescontos > 0 ? DANGER : MUTED }}>{calc.totalDescontos > 0 ? `- ${brl(calc.totalDescontos)}` : "-"}</td>
                      <td style={{ padding: "12px 14px", fontFamily: FONT_MONO, fontWeight: 700 }}>{brl(calc.liquido)}</td>
                    </>
                  )}
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} style={{ padding: 20, color: MUTED, textAlign: "center" }}>Nenhum funcionário cadastrado.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      {filtro === "tudo" && rowsComExcedente.length > 0 && (
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
