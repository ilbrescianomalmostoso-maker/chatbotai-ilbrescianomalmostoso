import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const cleanDomain = SHOPIFY_DOMAIN ? SHOPIFY_DOMAIN.replace('https://', '').replace(/\/$/, '') : "";

// --- 1. FUNZIONE SHOPIFY SNELLA ---
async function shopifyFetch(query) {
  const url = `https://${cleanDomain}/admin/api/2024-01/graphql.json`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      },
      body: JSON.stringify({ query }),
    });
    return await response.json();
  } catch (e) {
    console.error("Fetch Error:", e);
    return null;
  }
}

// --- 2. RICERCA PROTETTA CON FALLBACK SICURO ---
async function searchProducts(keyword) {
  let cleanKeyword = keyword ? keyword.trim().toLowerCase() : "";
  
  // Il vocabolario salvavita: traduce istantaneamente prima di interrogare Shopify
  if (cleanKeyword.includes("accendin")) cleanKeyword = "clipper";
  if (cleanKeyword.includes("magli") || cleanKeyword.includes("tshirt") || cleanKeyword.includes("t-shirt")) cleanKeyword = "t-shirt";
  if (cleanKeyword.includes("felp")) cleanKeyword = "hoodie";
  if (cleanKeyword.includes("costum")) cleanKeyword = "swimwear";
  if (cleanKeyword.includes("plaid") || cleanKeyword.includes("copert")) cleanKeyword = "plaid";

  const searchFilter = cleanKeyword ? `, query: "${cleanKeyword}*"` : "";
  
  const buildQuery = (filter) => `{
    products(first: 20 ${filter}) {
      edges {
        node {
          title
          handle
          totalInventory
        }
      }
    }
  }`;
  
  let data = await shopifyFetch(buildQuery(searchFilter));
  let products = data?.data?.products?.edges || [];
  
  // Se Shopify non trova la parola, peschiamo 20 articoli generali per far proporre alternative
  if (products.length === 0) {
    data = await shopifyFetch(buildQuery(""));
    products = data?.data?.products?.edges || [];
  }

  // Pulizia estrema dei dati inviati all'AI: Niente prezzi, niente immagini rotte.
  return products.map(p => ({
    name: p.node.title,
    stock: p.node.totalInventory,
    link: `https://${cleanDomain}/products/${p.node.handle}`
  }));
}

const tools = [
  {
    function_declarations: [
      {
        name: "searchProducts",
        description: "Cerca i prodotti nel database. Usalo sempre per rispondere alle richieste sui prodotti.",
        parameters: {
            type: "OBJECT",
            properties: {
                keyword: {
                    type: "STRING",
                    description: "La parola chiave da cercare"
                }
            }
        }
      }
    ],
  },
];

// --- 3. CONFIGURAZIONE MODELLO ---
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash", 
  tools: tools
});

// --- 4. HANDLER ---
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
        Sei l'AI Malmostosa de "Il Bresciano Malmostoso". Rispondi in modo sbrigativo e diretto.
        
        REGOLE VITALI E INFRANGIBILI:
        1. USA SEMPRE lo strumento 'searchProducts'. 
        2. NON DIRE MAI "Non abbiamo questo prodotto nel catalogo". Se la ricerca fallisce, il sistema ti restituisce altri prodotti: proponi quelli come alternative per vendere comunque.
        3. NON PARLARE DI PREZZI, non li sai.
        4. NON FORNIRE MAI DATI GREZZI O JSON.
        
        FORMATO DI RISPOSTA OBBLIGATORIO:
        Mostra i prodotti trovati usando ESATTAMENTE questo schema pulito:
        
        **Nome Prodotto**
        📦 Disponibilità: [Numero] pezzi
        🔗 [Guarda qui](Link del prodotto)
        ` }]
      }
    });

    const result = await chat.sendMessage(message);
    const response = await result.response;
    const functionCalls = response.functionCalls();

    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      
      if (call.name === "searchProducts") {
        const productData = await searchProducts(call.args.keyword || "");
        
        const result2 = await chat.sendMessage(
          [{
            functionResponse: {
              name: "searchProducts",
              response: { products: productData }
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
