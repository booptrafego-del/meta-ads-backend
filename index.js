const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3001;
const APIFY_KEY = process.env.APIFY_API_KEY;

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { reject(new Error("Resposta inválida: " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Resposta inválida")); }
      });
    }).on("error", reject);
  });
}

// Rota de teste
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Meta Ads Backend funcionando!" });
});

// Busca anúncios reais via Apify
app.get("/buscar-anuncios", async (req, res) => {
  const { nicho, limite = 20 } = req.query;
  if (!nicho) return res.status(400).json({ error: "Nicho não informado." });
  if (!APIFY_KEY) return res.status(500).json({ error: "APIFY_API_KEY não configurada." });

  try {
    const maxAds = Math.max(parseInt(limite) || 20, 1);
    const adLibraryUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=${encodeURIComponent(nicho)}&search_type=keyword_unordered&media_type=all`;

    const runBody = JSON.stringify({
      urls: [{ url: adLibraryUrl }],
      count: maxAds,
      "scrapePageAds.activeStatus": "active",
      "scrapePageAds.countryCode": "BR"
    });

    const runOptions = {
      hostname: "api.apify.com",
      path: "/v2/acts/curious_coder~facebook-ads-library-scraper/runs?token=" + APIFY_KEY,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(runBody)
      }
    };

    // Inicia o run
    const runResult = await httpsRequest(runOptions, runBody);
    console.log("Apify run result:", JSON.stringify(runResult.data));

    if (!runResult.data.data) {
      return res.status(400).json({ error: "Erro ao iniciar scraper: " + JSON.stringify(runResult.data) });
    }

    const runId = runResult.data.data.id;
    const datasetId = runResult.data.data.defaultDatasetId;

    // Aguarda o run terminar (polling a cada 3s, máx 2min)
    let status = "RUNNING";
    let attempts = 0;
    while (status === "RUNNING" || status === "READY") {
      await new Promise(r => setTimeout(r, 3000));
      const statusResult = await fetchJSON(`https://api.apify.com/v2/acts/curious_coder~facebook-ads-library-scraper/runs/${runId}?token=${APIFY_KEY}`);
      status = statusResult.data?.status || "FAILED";
      console.log(`Run status (${attempts}): ${status}`);
      attempts++;
      if (attempts > 40) { status = "TIMEOUT"; break; }
    }

    if (status !== "SUCCEEDED") {
      return res.status(500).json({ error: `Scraper terminou com status: ${status}` });
    }

    // Busca os resultados do dataset
    const items = await fetchJSON(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_KEY}&limit=${maxAds}`);
    console.log("Items count:", Array.isArray(items) ? items.length : "não é array");

    const ads = Array.isArray(items) ? items : [];

    if (ads.length === 0) {
      return res.json({ total: 0, players: [], ads_brutos: [] });
    }

    // Agrupa por anunciante
    const porAnunciante = {};
    ads.forEach(ad => {
      const nome = ad.pageName || ad.page_name || ad.advertiserName || "Desconhecido";
      if (!porAnunciante[nome]) porAnunciante[nome] = [];
      porAnunciante[nome].push(ad);
    });

    const players = Object.entries(porAnunciante)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 6)
      .map(([nome, anuncios]) => {
        const copies = anuncios
          .map(a => a.adText || a.body || a.ad_creative_body || a.text || "")
          .filter(Boolean);
        const datas = anuncios
          .map(a => a.startDate || a.ad_delivery_start_time || a.createdAt)
          .filter(Boolean)
          .sort();
        return {
          nome,
          total_anuncios_ativos: anuncios.length,
          anuncio_mais_antigo: datas[0] ? new Date(datas[0]).toLocaleDateString("pt-BR") : "Desconhecido",
          url_biblioteca: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=${encodeURIComponent(nome)}&search_type=keyword_unordered`,
          exemplo_copy: copies[0] ? copies[0].slice(0, 300) : "Não disponível",
          copies_disponiveis: copies.slice(0, 5),
          plataformas: [...new Set(anuncios.flatMap(a => a.publisherPlatforms || a.publisher_platforms || []))].join(", ")
        };
      });

    res.json({ total: ads.length, players, ads_brutos: ads.slice(0, 3) });

  } catch (err) {
    console.error("Erro:", err.message);
    res.status(500).json({ error: "Erro interno: " + err.message });
  }
});

// Gera sugestões baseadas nos players encontrados
app.post("/gerar-sugestoes", (req, res) => {
  const { nicho, produto, objetivo, tom, diferencial, publico, players } = req.body;

  const tons = {
    "Profissional": ["Solução completa para", "Referência em", "Especialistas em"],
    "Descontraído": ["Chega de sofrer com", "A vida fica mais fácil com", "Sem complicação:"],
    "Urgente": ["Última chance:", "Só hoje:", "Não perca:"],
    "Emocional": ["Transforme sua vida com", "Realize seu sonho de", "Você merece"],
    "Humorístico": ["Sério mesmo:", "Spoiler:", "Confissão:"],
    "Educativo": ["Você sabia que", "Descubra como", "Aprenda a"]
  };

  const ctas = {
    "Vendas": "Comprar Agora",
    "Geração de leads": "Quero Saber Mais",
    "Tráfego para site": "Saiba Mais",
    "Reconhecimento de marca": "Conheça",
    "Engajamento": "Curtir",
    "Instalações de app": "Baixar Grátis"
  };

  const prefixos = tons[tom] || ["Descubra", "Conheça", "Experimente"];
  const cta = ctas[objetivo] || "Saiba Mais";
  const topPlayer = players && players[0] ? players[0].nome : "líderes do mercado";
  const copies = players ? players.flatMap(p => p.copies_disponiveis || []).filter(Boolean) : [];

  const sugestoes = [
    {
      titulo: `${prefixos[0]} ${produto || nicho}`.slice(0, 40),
      headline: `A melhor opção em ${nicho}`.slice(0, 30),
      copy: `${prefixos[0]} ${produto || nicho} e veja a diferença.\n${diferencial ? `✅ ${diferencial}` : ""}\n${publico?.length ? `Ideal para quem tem ${publico.join(" ou ")}.` : ""}\nGaranta agora e transforme seus resultados!`.trim(),
      cta,
      formato_recomendado: "Imagem",
      inspirado_em: `Padrão dos maiores players de ${nicho} como ${topPlayer}`,
      dica_segmentacao: `Segmente para ${publico?.join(", ") || "público geral"} interessados em ${nicho}`,
      dica_criativo: `Mostre o produto/resultado em destaque com fundo limpo`
    },
    {
      titulo: `${prefixos[1] || "Experimente"} ${nicho}`.slice(0, 40),
      headline: `${diferencial || "Resultado garantido"}`.slice(0, 30),
      copy: `${copies[0] ? `Inspirado nos anúncios que estão funcionando agora:\n` : ""}Você está procurando ${produto || nicho}?\n${diferencial ? `Aqui você encontra: ${diferencial}.` : ""}\nJunte-se a quem já escolheu o melhor!`,
      cta,
      formato_recomendado: "Vídeo",
      inspirado_em: copies[0] ? `Copy real: "${copies[0].slice(0, 60)}..."` : `Padrão de vídeo dos players de ${nicho}`,
      dica_segmentacao: `Use público lookalike de clientes atuais + interesse em ${nicho}`,
      dica_criativo: `Vídeo curto (15s) mostrando antes e depois ou depoimento real`
    },
    {
      titulo: `${prefixos[2] || "Não perca"} ${produto || nicho}`.slice(0, 40),
      headline: `${objetivo === "Vendas" ? "Oferta por tempo limitado" : `Tudo sobre ${nicho}`}`.slice(0, 30),
      copy: `${prefixos[2] || "Descubra"} o que os melhores de ${nicho} já sabem.\n${diferencial ? `🎯 ${diferencial}` : ""}\n${objetivo === "Vendas" ? "⏰ Oferta por tempo limitado — aproveite!" : "Clique e saiba mais!"}`,
      cta,
      formato_recomendado: "Carrossel",
      inspirado_em: `Estratégia de carrossel usada por ${topPlayer}`,
      dica_segmentacao: `Remarketing para quem visitou seu site + público frio por interesse`,
      dica_criativo: `Carrossel com 3-5 cards: problema → solução → prova social → oferta`
    }
  ];

  res.json(sugestoes);
});

app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
