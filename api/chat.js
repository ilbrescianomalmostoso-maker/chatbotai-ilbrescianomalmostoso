import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const cleanDomain = SHOPIFY_DOMAIN ? SHOPIFY_DOMAIN.replace('https://', '').replace(/\/$/, '') : "";

// --- 1. FUNZIONE SHOPIFY ---
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

// --- 2. DEFINIZIONE STRUMENTI (AGGIORNATA: Cerca Prodotti) ---
async function searchProducts(keyword) {
  // Se c'è una parola chiave, costruiamo il filtro per Shopify
  // Se non c'è (l'utente vuole solo consigli), lasciamo vuoto per vedere tutto
  const searchFilter = keyword ? `, query: "title:*${keyword}*"` : "";

  const query = `{
    products(first: 5 ${searchFilter}) {
      edges {
        node {
          title
          handle
          totalInventory
          featuredImage { url }
          priceRange { minVariantPrice { amount currencyCode } }
        }
      }
    }
  }`;
  
  const data = await shopifyFetch(query);
  const products = data?.data?.products?.edges || [];
  
  if (products.length === 0) return [];

  return products.map(p => ({
    name: p.node.title,
    price: p.node.priceRange.minVariantPrice.amount + " " + p.node.priceRange.minVariantPrice.currencyCode,
    stock: p.node.totalInventory,
    image: p.node.featuredImage ? p.node.featuredImage.url : "",
    link: `https://${cleanDomain}/products/${p.node.handle}`
  }));
}

const tools = [
  {
    function_declarations: [
      {
        name: "searchProducts",
        description: "Cerca prodotti specifici nel catalogo o mostra i best seller.",
        parameters: {
            type: "OBJECT",
            properties: {
                keyword: {
                    type: "STRING",
                    description: "La parola chiave da cercare (es. 'braccialetto', 'maglia'). Lascia vuoto se la richiesta è generica."
                }
            }
        }
      }
    ],
  },
];

// --- 3. CONFIGURAZIONE MODELLO ---
// Usa pure gemini-2.5-flash o gemini-1.5-flash a tua scelta
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash-lite", 
  tools: tools
});

// --- 4. HANDLER SERVER ---
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
        parts: [{ text: `Sei un personal shopper.
        Quando mostri un prodotto, usa questo formato esatto:
        1. Immagine: ![Titolo](URL_IMMAGINE)
        2. Link: [Acquista qui](URL_LINK)
        3. Prezzo e Descrizione breve.` }]
      }
    });

    const result = await chat.sendMessage(message);
    const response = await result.response;
    const functionCalls = response.functionCalls();

    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      
      // Qui intercettiamo la chiamata "searchProducts"
      if (call.name === "searchProducts") {
        // Leggiamo cosa vuole cercare l'utente (es. "braccialetto")
        const args = call.args; 
        const keyword = args.keyword || "";

        const productData = await searchProducts(keyword);
        
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
