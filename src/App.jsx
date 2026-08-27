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

function classificarDia(entradaStr, saidaStr, dataISO, feriado, almocoManualHoras = 0) {
  if (!entradaStr || !saidaStr || !dataISO) return diaVazio();
  const weekday = new Date(dataISO + "T00:00:00").getDay();

  let entrada = toMin(entradaStr);
  let saida = toMin(saidaStr);
  if (saida <= entrada) saida += 24 * 60;

  let horario = null;
  let percentual;
  const temHorarioFixo = !feriado && weekday !== 0 && weekday !== 6;
  if (feriado || weekday === 0) {
    percentual = "he100";
  } else if (weekday === 6) {
    percentual = "he60";
  } else {
    const h = HORARIOS_SEMANA[weekday];
    horario = { inicio: toMin(h.inicio), fim: toMin(h.fim) };
    percentual = "he50";
  }

  if (!temHorarioFixo && almocoManualHoras > 0) {
    saida -= Math.round(almocoManualHoras * 60);
    if (saida <= entrada) saida = entrada;
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

function agregarMes(registros) {
  const soma = diaVazio();
  registros.forEach((r) => {
    const c = classificarDia(r.entrada, r.saida, r.data, r.feriado, r.almocoHoras);
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
  return { id: r.id, funcionarioId: r.funcionario_id, data: r.data, entrada: (r.hora_entrada || "").slice(0,5), saida: (r.hora_saida || "").slice(0,5), feriado: !!r.feriado, almocoHoras: Number(r.almoco_horas || 0) };
}
function registroToRow(r) {
  return { funcionario_id: r.funcionarioId, data: r.data, hora_entrada: r.entrada, hora_saida: r.saida, feriado: !!r.feriado, almoco_horas: r.almocoHoras || 0 };
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
    
