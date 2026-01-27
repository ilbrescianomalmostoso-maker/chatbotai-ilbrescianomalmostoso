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

// --- 2. DEFINIZIONE STRUMENTI (RICERCA ROBUSTA) ---
async function searchProducts(keyword) {
  // FIX CRUCIALE: Rimuoviamo asterischi iniziali che rompono Shopify.
  // Usiamo "keyword*" che cerca "keyword" e tutto ciò che inizia con essa.
  // Esempio: "Accendin*" trova "Accendino", "Accendini", "Accendino Clipper".
  
  let searchFilter = "";
  if (keyword) {
      // Pulizia extra: togliamo spazi extra
      const cleanKeyword = keyword.trim();
      searchFilter = `, query: "${cleanKeyword}*"`;
  }

  // Chiediamo i primi 10 prodotti per avere più chance di trovare quello giusto
  const query = `{
    products(first: 10 ${searchFilter}, sortKey: RELEVANCE) {
      edges {
        node {
          title
          handle
          totalInventory
          productType
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
    type: p.node.productType,
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
        description: "Cerca prodotti nel catalogo.",
        parameters: {
            type: "OBJECT",
            properties: {
                keyword: {
                    type: "STRING",
                    description: "La parola chiave SINGOLARE da cercare (es. se utente dice 'accendini', cerca 'accendino')."
                }
            }
        }
      }
    ],
  },
];

// --- 3. CONFIGURAZIONE MODELLO ---
// Usa il modello che preferisci (2.5-flash o 1.5-flash)
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash", 
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
        // ISTRUZIONI PER "TRADURRE" LE RICHIESTE DEGLI UTENTI
        parts: [{ text: `Sei un assistente allo shopping intelligente sullo shop collegato alle pagine social de "Il Bresciano Malmostoso"
        
        REGOLE D'ORO PER LA RICERCA:
        1. TRADUZIONE MENTALE: L'utente non sa come si chiamano i prodotti. Tu devi capirlo.
           - Se cerca "Maglietta" -> Cerca "T-Shirt"
           - Se cerca "Felpa" -> Cerca "Hoodie" o "Crewneck"
           - Se cerca "Accendino" -> Cerca Clipper
        2. SINGOLARE: Converti SEMPRE le parole al singolare prima di cercare (es. "braccialetti" -> "braccialetto").
        
        FORMATO RISPOSTA:
        Quando trovi prodotti, mostrali così:
        ![Titolo](URL_IMMAGINE)
        [Vedi Dettagli](URL_LINK)
        Non mostrare i prezzi, solo il link.
        ` }]
      }
    });

    const result = await chat.sendMessage(message);
    const response = await result.response;
    const functionCalls = response.functionCalls();

    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      
      if (call.name === "searchProducts") {
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
