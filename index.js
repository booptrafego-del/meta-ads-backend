const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3001;

// Fetch nativo usando https (sem dependência externa)
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

// Rota principal — busca anúncios reais na Ad Library do Meta
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
        "id",
        "ad_creative_body",
        "ad_creative_link_caption",
        "ad_creative_link_description",
        "ad_creative_link_title",
        "page_name",
        "page_id",
        "ad_delivery_start_time",
        "ad_delivery_stop_time",
        "ad_snapshot_url",
        "publisher_platforms",
        "impressions",
        "spend"
      ].join(","),
      limit: limite,
      ad_type: "ALL"
    });

    const url = `https://graph.facebook.com/v19.0/ads_archive?${params}`;
    const data = await fetchJSON(url);

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    // Ordena por data de início (mais antigos primeiro = rodando há mais tempo)
    const ads = (data.data || []).sort((a, b) => {
      const dA = new Date(a.ad_delivery_start_time || 0);
      const dB = new Date(b.ad_delivery_start_time || 0);
      return dA - dB;
    });

    res.json({
      total: ads.length,
      ads,
      paging: data.paging || null
    });

  } catch (err) {
    res.status(500).json({ error: "Erro interno: " + err.message });
  }
});

// Rota para validar o token
app.get("/validar-token", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: "Token não informado." });

  try {
    const data = await fetchJSON(`https://graph.facebook.com/v19.0/me?access_token=${token}`);
    if (data.error) return res.status(401).json({ error: data.error.message });
    res.json({ valid: true, name: data.name, id: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
