import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_URL; 
const cleanDomain = SHOPIFY_DOMAIN ? SHOPIFY_DOMAIN.replace('https://', '').replace(/\/$/, '') : "";

// --- 1. MOTORE DI RICERCA INTERNO (TAGLIO ALLA FONTE) ---
function getSearchTerm(keyword) {
  const k = keyword.toLowerCase().trim();
  if (k.includes("accendin")) return "clipper";
  if (k.includes("magli") || k.includes("tshirt") || k.includes("t-shirt")) return "t-shirt";
  if (k.includes("felp")) return "hoodie";
  if (k.includes("costum")) return "swimwear";
  if (k.includes("plaid") || k.includes("copert")) return "plaid";
  return k;
}

async function searchStoreCatalog(keyword) {
  try {
    const response = await fetch(`https://${cleanDomain}/products.json?limit=250`);
    const data = await response.json();

    if (!data.products) return [];

    const searchTerm = getSearchTerm(keyword);

    // Filtriamo in Javascript
    const filtered = data.products.filter(p => 
      p.title.toLowerCase().includes(searchTerm) || 
      p.product_type.toLowerCase().includes(searchTerm)
    );

    // Fallback: se non c'è corrispondenza, proponiamo i primi del catalogo generale
    const results = filtered.length > 0 ? filtered : data.products;

    // IL SEGRETO: Tagliamo l'array a un MASSIMO DI 5 PRODOTTI. 
    // Gemini non saprà nemmeno che ne esistono altri.
    const top5 = results.slice(0, 5);

    return top5.map(p => ({
      nome: p.title,
      link: `https://${cleanDomain}/products/${p.handle}`
    }));
  } catch (e) {
    console.error("Errore catalogo:", e);
    return [];
  }
}

const tools = [
  {
    function_declarations: [
      {
        name: "searchStoreCatalog",
        description: "Cerca i prodotti nel catalogo usando una parola chiave. Restituisce un massimo di 5 prodotti.",
        parameters: { 
          type: "OBJECT", 
          properties: {
            keyword: {
              type: "STRING",
              description: "La parola chiave da cercare (es. 'accendini', 'felpa')."
            }
          },
          required: ["keyword"]
        } 
      }
    ],
  },
];

// --- 2. CONFIGURAZIONE MODELLO ---
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash-lite", 
  tools: tools
});

// --- 3. HANDLER SERVERLESS ---
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { message, history } = req.body;

    const chat = model.startChat({
      history: history || [],
        system_instruction: {
          parts: [{ text: `
            Sei l'AI Malmostosa, l'assistente dello shop "Il Bresciano Malmostoso" che parla solo italiano.
        
            REGOLE VITALI:
            1. ZERO CHIACCHIERE: Appena l'utente chiede un prodotto, usa 'searchStoreCatalog' e mostra DIRETTAMENTE la lista. È severamente vietato fare premesse (es. "Cerco subito", "Un attimo che guardo") o fare domande esplorative. Vai dritto al sodo.
            2. FORMATO LINK HTML OBBIGATORIO:
             <b>[Nome Prodotto]</b><br>
             <a href="https://www.treccani.it/enciclopedia/prodotto-di-o-prodotto-da_%28La-grammatica-italiana%29/" target="_blank">Clicca qui</a><br><br>
            3. DIVIETO ASSOLUTO DI DOMANDE: Non usare MAI il punto interrogativo ("?"). Chiudi i messaggi esclusivamente con frasi affermative e sbrigative (es. "Ecco la roba.", "Fammi sapere se cerchi altro.").
          ` }]
      }
    });

    const result = await chat.sendMessage(message);
    const response = await result.response;
    const functionCalls = response.functionCalls();

    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      
      if (call.name === "searchStoreCatalog") {
        const catalogData = await searchStoreCatalog(call.args.keyword || "");
        
        const result2 = await chat.sendMessage(
          [{
            functionResponse: {
              name: "searchStoreCatalog",
              response: { products: catalogData }
            }
          }]
        );
        return res.status(200).json({ text: result2.response.text() });
      }
    }

    return res.status(200).json({ text: response.text() });

  } catch (error) {
    console.error("Server Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
