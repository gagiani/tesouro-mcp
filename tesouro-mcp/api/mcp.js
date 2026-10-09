// Conector MCP "Tesouro Direto" — preços de resgate dos títulos
// Fonte principal: JSON da página "Rendimento dos Títulos" (aba Resgatar) do Tesouro Direto.
// Reserva: CSV oficial do Tesouro Transparente (PU de venda da manhã do último dia disponível).

const FONTE_SITE = "https://www.tesourodireto.com.br/o/rentabilidade/resgatar";
const FONTE_CSV = "https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/precotaxatesourodireto.csv";

const TOOL = {
  name: "precos_tesouro",
  description:
    "Retorna taxa e preço unitário (PU) de resgate dos títulos do Tesouro Direto, com a data/hora da precificação. " +
    "Opcional: 'titulos' filtra pelos nomes exatos (ex.: 'Tesouro IPCA+ 2035', 'Tesouro Renda+ Aposentadoria Extra 2065').",
  inputSchema: {
    type: "object",
    properties: { titulos: { type: "array", items: { type: "string" }, description: "Nomes dos títulos; vazio = todos" } },
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

const taxaNum = (s) => { const m = String(s).match(/-?\d+(,\d+)?/); return m ? Number(m[0].replace(",", ".")) : null; };
const norm = (s) => String(s).toLowerCase().replace(/renda\+/g, "renda+").replace(/\s+/g, " ").trim();

async function doSite() {
  const r = await fetch(FONTE_SITE, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
  if (!r.ok) throw new Error("site HTTP " + r.status);
  const j = await r.json();
  return (j.TesouroLegado || []).map((b) => ({
    titulo: b.treasuryBondName,
    taxa_resgate: taxaNum(b.redemptionProfitabilityFeeIndexerName),
    taxa_texto: b.redemptionProfitabilityFeeIndexerName,
    pu_resgate: b.unitaryRedemptionValue,
    vencimento: String(b.maturityDate).slice(0, 10),
    atualizado_em: b.lastMarketPricingDate,
    fonte: "tesourodireto.com.br (Resgatar)",
  }));
}

async function doCsv() {
  const r = await fetch(FONTE_CSV);
  if (!r.ok) throw new Error("csv HTTP " + r.status);
  const linhas = (await r.text()).split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(";"));
  const iso = (d) => d.split("/").reverse().join("-");
  const ultima = linhas.reduce((m, c) => (iso(c[2]) > m ? iso(c[2]) : m), "");
  return linhas.filter((c) => iso(c[2]) === ultima).map((c) => {
    const venc = iso(c[1]), ano = venc.slice(0, 4);
    const tipo = c[0];
    // RendA+: o nome usa o ano de conversão (vencimento - 19 anos)
    const nomeAno = tipo.startsWith("Tesouro Renda+") ? String(Number(ano) - 19) : ano;
    return {
      titulo: tipo + " " + nomeAno,
      taxa_resgate: Number(c[4].replace(",", ".")),
      taxa_texto: c[4] + "%",
      pu_resgate: Number(c[6].replace(".", "").replace(",", ".")),
      vencimento: venc,
      atualizado_em: ultima + "T00:00:00",
      fonte: "Tesouro Transparente (PU venda manhã)",
    };
  });
}

async function precos(titulos) {
  let lista, aviso = null;
  try { lista = await doSite(); } catch (e) { aviso = "Site indisponível (" + e.message + "); usando CSV do Tesouro Transparente."; lista = await doCsv(); }
  if (Array.isArray(titulos) && titulos.length) {
    const alvo = new Set(titulos.map(norm));
    lista = lista.filter((b) => alvo.has(norm(b.titulo)));
  }
  return { titulos: lista, aviso };
}

function rpc(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcErr(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize")
    return rpc(id, {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "tesouro-direto-precos", version: "1.0.0" },
    });
  if (method === "ping") return rpc(id, {});
  if (method === "tools/list") return rpc(id, { tools: [TOOL] });
  if (method === "tools/call") {
    if (params?.name !== TOOL.name) return rpcErr(id, -32602, "Ferramenta desconhecida");
    try {
      const out = await precos(params?.arguments?.titulos);
      return rpc(id, { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out });
    } catch (e) {
      return rpc(id, { content: [{ type: "text", text: "Erro ao buscar preços: " + e.message }], isError: true });
    }
  }
  if (id === undefined || id === null) return null; // notificações
  return rpcErr(id, -32601, "Método não suportado: " + method);
}

module.exports = async function (req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json(rpcErr(null, -32000, "Use POST"));
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json(rpcErr(null, -32700, "JSON inválido")); } }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handle))).filter(Boolean);
    return out.length ? res.status(200).json(out) : res.status(202).end();
  }
  const out = await handle(body || {});
  return out ? res.status(200).json(out) : res.status(202).end();
};
module.exports._test = { precos, doCsv, handle };
