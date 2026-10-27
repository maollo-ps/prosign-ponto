// Edge Function "nfse": emite, consulta e cancela NFS-e (Emissor Nacional) pela API da Focus NFe.
// Segredos necessários (Supabase → Edge Functions → Secrets):
//   FOCUS_TOKEN_HOMOLOGACAO  e/ou  FOCUS_TOKEN_PRODUCAO
// SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY já existem por padrão.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BASES: Record<string, string> = {
  producao: "https://api.focusnfe.com.br",
  homologacao: "https://homologacao.focusnfe.com.br",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const soDigitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const limpa = (v: unknown, max = 255) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function agoraBrasilia() {
  const d = new Date(Date.now() - 3 * 3600_000);
  return d.toISOString().slice(0, 19) + "-03:00";
}

function mensagemDe(r: any): string {
  if (!r) return "";
  if (Array.isArray(r.erros) && r.erros.length) return r.erros.map((e: any) => [e.codigo, e.mensagem].filter(Boolean).join(" - ")).join(" | ");
  return r.mensagem_sefaz || r.mensagem || r.message || "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return json({ erro: "Sem login." }, 401);

    // quem está chamando precisa ter acesso ao financeiro
    const comoUsuario = createClient(url, anon, { global: { headers: { Authorization: auth } } });
    const { data: userData } = await comoUsuario.auth.getUser();
    if (!userData?.user) return json({ erro: "Sessão expirada. Entre de novo." }, 401);
    const { data: pode, error: ePode } = await comoUsuario.rpc("tem_acesso_financeiro");
    if (ePode || !pode) return json({ erro: "Só o financeiro pode emitir nota fiscal." }, 403);

    const db = createClient(url, service);
    const body = await req.json().catch(() => ({}));
    const acao = body.acao;

    // ---------------- EMITIR ----------------
    if (acao === "emitir") {
      const { data: fat, error: eFat } = await db.from("faturamento")
        .select("id, valor, data_faturamento, cliente_id, orcamento_id, orcamentos(empresa, evento, numero_or)")
        .eq("id", body.faturamento_id).single();
      if (eFat || !fat) return json({ erro: "Faturamento não encontrado." }, 404);
      const empresa = (fat as any).orcamentos?.empresa === "vs" ? "vs" : "prosign";

      const { data: abertas } = await db.from("notas_fiscais").select("id, status")
        .eq("faturamento_id", fat.id).in("status", ["processando_autorizacao", "autorizado"]);
      if (abertas && abertas.length) return json({ erro: "Este faturamento já tem nota emitida ou em processamento." }, 409);

      const { data: cfg } = await db.from("nfse_config").select("*").eq("empresa", empresa).single();
      if (!cfg?.cnpj || !cfg?.codigo_tributacao_nacional) {
        return json({ erro: "Configuração fiscal incompleta (CNPJ e código de tributação nacional). Ajuste em Financeiro → Faturamento → Configurar NFS-e." }, 422);
      }
      const token = Deno.env.get(cfg.ambiente === "producao" ? "FOCUS_TOKEN_PRODUCAO" : "FOCUS_TOKEN_HOMOLOGACAO");
      if (!token) return json({ erro: `Token da Focus NFe (${cfg.ambiente}) não cadastrado nos segredos do Supabase.` }, 500);

      const { data: cli } = await db.from("pessoas").select("*").eq("id", fat.cliente_id).single();
      if (!cli) return json({ erro: "Cliente do faturamento não está no cadastro." }, 422);
      const doc = soDigitos(cli.documento);
      if (doc.length !== 14 && doc.length !== 11) return json({ erro: `O cliente "${cli.nome}" está sem CNPJ/CPF válido no cadastro.` }, 422);

      const cep = soDigitos(cli.end_cep);
      let ibgeTomador: string | null = null;
      if (cep.length === 8) {
        try {
          const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
          const j = await r.json();
          if (j?.ibge) ibgeTomador = String(j.ibge);
        } catch { /* sem município do tomador */ }
      }

      const descricao = [body.descricao, cfg.descricao_padrao].filter((x) => String(x ?? "").trim()).join("\n")
        .replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 2000);
      if (!descricao) return json({ erro: "Informe a descrição do serviço." }, 422);
      const retido = body.iss_retido ?? cfg.iss_retido_padrao;

      const payload: Record<string, unknown> = {
        data_emissao: agoraBrasilia(),
        data_competencia: fat.data_faturamento,
        codigo_municipio_emissora: Number(cfg.codigo_municipio),
        cnpj_prestador: soDigitos(cfg.cnpj),
        codigo_opcao_simples_nacional: String(cfg.opcao_simples),
        regime_especial_tributacao: String(cfg.regime_especial ?? "0"),
        razao_social_tomador: limpa(cli.razao_social || cli.nome, 150),
        codigo_municipio_prestacao: String(soDigitos(body.municipio_prestacao) || cfg.codigo_municipio),
        codigo_tributacao_nacional_iss: soDigitos(cfg.codigo_tributacao_nacional),
        descricao_servico: descricao,
        valor_servico: Number(Number(fat.valor).toFixed(2)),
        tributacao_iss: 1,
        tipo_retencao_iss: retido ? 2 : 1,
      };
      if (cfg.inscricao_municipal) payload.inscricao_municipal_prestador = soDigitos(cfg.inscricao_municipal);
      if (cfg.opcao_simples === "3" && cfg.regime_trib_sn) payload.regime_tributario_simples_nacional = String(cfg.regime_trib_sn);
      if (cfg.codigo_tributacao_municipal) payload.codigo_tributacao_municipal_iss = String(cfg.codigo_tributacao_municipal);
      if (cfg.codigo_nbs) payload.codigo_nbs = soDigitos(cfg.codigo_nbs);
      if (doc.length === 14) payload.cnpj_tomador = doc; else payload.cpf_tomador = doc;
      if (ibgeTomador) payload.codigo_municipio_tomador = ibgeTomador;
      if (cep.length === 8) payload.cep_tomador = cep;
      if (cli.end_logradouro) payload.logradouro_tomador = limpa(cli.end_logradouro);
      if (cli.end_numero) payload.numero_tomador = limpa(cli.end_numero, 60);
      if (cli.end_complemento) payload.complemento_tomador = limpa(cli.end_complemento, 156);
      if (cli.end_bairro) payload.bairro_tomador = limpa(cli.end_bairro, 60);
      const tel = soDigitos(cli.telefone || cli.celular);
      if (tel.length >= 10) payload.telefone_tomador = tel;
      if (cli.email && /@/.test(cli.email)) payload.email_tomador = limpa(String(cli.email).split(/[;, ]/)[0], 80);

      const ref = `fat-${String(fat.id).slice(0, 8)}-${Date.now().toString(36)}`;
      const base = BASES[cfg.ambiente] || BASES.homologacao;
      const r = await fetch(`${base}/v2/nfsen?ref=${encodeURIComponent(ref)}`, {
        method: "POST",
        headers: { Authorization: "Basic " + btoa(token + ":"), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const resp = await r.json().catch(() => ({}));
      const aceita = r.status === 200 || r.status === 201 || r.status === 202;
      const linha = {
        faturamento_id: fat.id, orcamento_id: fat.orcamento_id, empresa, ambiente: cfg.ambiente, ref,
        status: aceita ? (resp.status || "processando_autorizacao") : "erro_envio",
        valor: payload.valor_servico, descricao, mensagem: aceita ? mensagemDe(resp) : (mensagemDe(resp) || `HTTP ${r.status}`),
        payload, resposta: resp, criado_por: userData.user.id,
      };
      const { data: nota, error: eIns } = await db.from("notas_fiscais").insert(linha).select().single();
      if (eIns) return json({ erro: "Nota enviada, mas não consegui gravar: " + eIns.message, resposta: resp }, 500);
      if (!aceita) return json({ erro: "A Focus recusou a nota: " + linha.mensagem, nota }, 422);
      return json({ nota });
    }

    // ---------------- CONSULTAR / CANCELAR ----------------
    if (acao === "consultar" || acao === "cancelar") {
      const { data: nota } = await db.from("notas_fiscais").select("*").eq("id", body.nota_id).single();
      if (!nota) return json({ erro: "Nota não encontrada." }, 404);
      const token = Deno.env.get(nota.ambiente === "producao" ? "FOCUS_TOKEN_PRODUCAO" : "FOCUS_TOKEN_HOMOLOGACAO");
      if (!token) return json({ erro: "Token da Focus NFe não cadastrado." }, 500);
      const base = BASES[nota.ambiente] || BASES.homologacao;
      const headers = { Authorization: "Basic " + btoa(token + ":"), "Content-Type": "application/json" };

      let r: Response;
      if (acao === "cancelar") {
        const just = limpa(body.justificativa, 255);
        if (just.length < 15) return json({ erro: "Escreva uma justificativa de cancelamento (mínimo 15 caracteres)." }, 422);
        r = await fetch(`${base}/v2/nfsen/${encodeURIComponent(nota.ref)}`, { method: "DELETE", headers, body: JSON.stringify({ justificativa: just }) });
      } else {
        r = await fetch(`${base}/v2/nfsen/${encodeURIComponent(nota.ref)}`, { headers });
      }
      const resp = await r.json().catch(() => ({}));
      if (!r.ok) return json({ erro: mensagemDe(resp) || `HTTP ${r.status}` }, 422);

      const abs = (p: unknown) => (p ? (String(p).startsWith("http") ? String(p) : base + String(p)) : null);
      const upd: Record<string, unknown> = {
        status: resp.status || nota.status,
        numero: resp.numero ?? resp.numero_nfse ?? nota.numero,
        codigo_verificacao: resp.codigo_verificacao ?? nota.codigo_verificacao,
        chave: resp.chave_nfse ?? resp.chave ?? nota.chave,
        url_danfse: abs(resp.url_danfse || resp.url) ?? nota.url_danfse,
        url_xml: abs(resp.caminho_xml_nota_fiscal || resp.caminho_xml) ?? nota.url_xml,
        mensagem: mensagemDe(resp) || null,
        resposta: resp,
        atualizado_em: new Date().toISOString(),
      };
      const { data: atual } = await db.from("notas_fiscais").update(upd).eq("id", nota.id).select().single();

      // número da nota vai para o faturamento (e sai se for cancelada)
      if (upd.status === "autorizado" && upd.numero) {
        await db.from("faturamento").update({ nota_fiscal: String(upd.numero) }).eq("id", nota.faturamento_id);
      } else if (upd.status === "cancelado") {
        await db.from("faturamento").update({ nota_fiscal: null }).eq("id", nota.faturamento_id).eq("nota_fiscal", String(nota.numero ?? ""));
      }
      return json({ nota: atual });
    }

    return json({ erro: "Ação inválida." }, 400);
  } catch (e) {
    return json({ erro: String((e as Error)?.message || e) }, 500);
  }
});
