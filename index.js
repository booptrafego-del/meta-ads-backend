const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3001;

// Fetch nativo
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Resposta inválida: " + data.slice(0, 100))); }
      });
    }).on("error", reject);
  });
}

// Rota de teste
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Meta Ads Backend funcionando!" });
});

// Busca anúncios reais na Ad Library do Meta
app.get("/buscar-anuncios", async (req, res) => {
  const { token, nicho, limite = 20 } = req.query;
  if (!token) return res.status(400).json({ error: "Token não informado." });
  if (!nicho) return res.status(400).json({ error: "Nicho não informado." });

  try {
    const params = new URLSearchParams({
      access_token: token,
      ad_reached_countries: '["BR"]',
      ad_active_status: "ACTIVE",
      search_terms: nicho,
      fields: [
        "id", "ad_creative_body", "ad_creative_link_title",
        "ad_creative_link_description", "page_name", "page_id",
        "ad_delivery_start_time", "ad_snapshot_url", "publisher_platforms"
      ].join(","),
      limit: limite,
      ad_type: "ALL"
    });

    const data = await fetchJSON(`https://graph.facebook.com/v19.0/ads_archive?${params}`);
    if (data.error) return res.status(400).json({ error: data.error.message });

    // Ordena por mais antigos primeiro (rodando há mais tempo)
    const ads = (data.data || []).sort((a, b) =>
      new Date(a.ad_delivery_start_time || 0) - new Date(b.ad_delivery_start_time || 0)
    );

    // Agrupa por anunciante
    const porAnunciante = {};
    ads.forEach(ad => {
      const nome = ad.page_name || "Desconhecido";
      if (!porAnunciante[nome]) porAnunciante[nome] = [];
      porAnunciante[nome].push(ad);
    });

    // Monta players ordenados por volume
    const players = Object.entries(porAnunciante)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 6)
      .map(([nome, anuncios]) => {
        const maisAntigo = anuncios[0];
        const copies = anuncios
          .map(a => a.ad_creative_body || a.ad_creative_link_title || "")
          .filter(Boolean);
        return {
          nome,
          total_anuncios_ativos: anuncios.length,
          anuncio_mais_antigo: maisAntigo.ad_delivery_start_time
            ? new Date(maisAntigo.ad_delivery_start_time).toLocaleDateString("pt-BR")
            : "Desconhecido",
          url_biblioteca: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=${encodeURIComponent(nome)}&search_type=keyword_unordered`,
          exemplo_copy: copies[0] ? copies[0].slice(0, 200) : "Não disponível",
          copies_disponiveis: copies.slice(0, 5),
          plataformas: [...new Set(anuncios.flatMap(a => a.publisher_platforms || []))].join(", ")
        };
      });

    res.json({ total: ads.length, players, ads_brutos: ads.slice(0, 5) });
  } catch (err) {
    res.status(500).json({ error: "Erro interno: " + err.message });
  }
});

// Gera sugestões de copy baseadas nos anúncios reais encontrados
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
      copy: `${copies[0] ? `Inspirado em anúncios reais que estão funcionando agora:\n` : ""}Você está procurando ${produto || nicho}?\n${diferencial ? `Aqui você encontra: ${diferencial}.` : ""}\nJunte-se a quem já escolheu o melhor!`,
      cta,
      formato_recomendado: "Vídeo",
      inspirado_em: copies[0] ? `Copy real encontrada: "${copies[0].slice(0, 60)}..."` : `Padrão de vídeo dos players de ${nicho}`,
      dica_segmentacao: `Use público lookalike de clientes atuais + interesse em ${nicho}`,
      dica_criativo: `Vídeo curto (15s) mostrando antes e depois ou depoimento real`
    },
    {
      titulo: `${prefixos[2] || "Não perca"} ${produto || nicho}`.slice(0, 40),
      headline: `${objetivo === "Vendas" ? "Oferta por tempo limitado" : `Tudo sobre ${nicho}`}`.slice(0, 30),
      copy: `${prefixos[2] || "Descubra"} o que os melhores de ${nicho} já sabem.\n${diferencial ? `🎯 ${diferencial}` : ""}\n${objetivo === "Vendas" ? "⏰ Oferta por tempo limitado — aproveite!" : "Clique e saiba mais!"}`,
      cta,
      formato_recomendado: "Carrossel",
      inspirado_em: `Estratégia de carrossel usada por ${topPlayer} e outros grandes players`,
      dica_segmentacao: `Remarketing para quem visitou seu site + público frio por interesse`,
      dica_criativo: `Carrossel com 3-5 cards: problema → solução → prova social → oferta`
    }
  ];

  res.json(sugestoes);
});

app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
