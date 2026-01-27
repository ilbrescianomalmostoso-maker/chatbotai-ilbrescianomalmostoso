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

// --- 2. DEFINIZIONE STRUMENTI (RICERCA AVANZATA) ---
async function searchProducts(keyword) {
  // LOGICA AVANZATA:
  // Se c'è una parola chiave, costruiamo una query che cerca in:
  // - Titolo (title)
  // - Tipo di prodotto (product_type)
  // - Tag (tag)
  // L'asterisco * serve per trovare anche parti di parola (es. "shirt" trova "t-shirt")
  
  let searchFilter = "";
  if (keyword) {
      searchFilter = `, query: "title:*${keyword}* OR product_type:*${keyword}* OR tag:*${keyword}*"`;
  }

  const query = `{
    products(first: 5 ${searchFilter}, sortKey: RELEVANCE) {
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
    type: p.node.productType, // Utile per l'AI per capire se ha trovato la cosa giusta
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
        description: "Cerca prodotti nel catalogo. Usa questo strumento quando l'utente cerca qualcosa di specifico.",
        parameters: {
            type: "OBJECT",
            properties: {
                keyword: {
                    type: "STRING",
                    description: "La parola chiave da cercare. IMPORTANTE: Traduci sinonimi in termini standard (es. se utente dice 'maglietta' tu cerca 't-shirt' o 'shirt')."
                }
            }
        }
      }
    ],
  },
];

// --- 3. CONFIGURAZIONE MODELLO ---
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash", // O 1.5-flash a tua scelta
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
        // ISTRUZIONI INTELLIGENTI
        parts: [{ text: `Sei un personal shopper esperto. Il tuo obiettivo è capire l'intento del cliente.
        
        REGOLE FONDAMENTALI:
        1. SINONIMI: Se il cliente usa parole comuni (es. "maglietta", "calzoni"), tu DEVI tradurle mentalmente nei termini più probabili del catalogo (es. "T-Shirt", "Pants", "Jeans") PRIMA di chiamare la funzione di ricerca.
        2. FORMATO: Quando mostri un prodotto, usa SEMPRE questo formato:
           ![Titolo](URL_IMMAGINE)
           [Acquista qui](URL_LINK)
           Prezzo: XX €
        3. Se la ricerca non dà risultati, suggerisci termini alternativi o prodotti simili.` }]
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

        // Eseguiamo la ricerca
        const productData = await searchProducts(keyword);
        
        // Restituiamo i dati all'AI
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
