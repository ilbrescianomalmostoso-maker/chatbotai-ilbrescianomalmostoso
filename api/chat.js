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

// --- 2. DEFINIZIONE STRUMENTI E RICERCA CON FALLBACK ---
async function searchProducts(keyword) {
  let searchFilter = "";
  if (keyword) {
      const cleanKeyword = keyword.trim();
      searchFilter = `, query: "${cleanKeyword}*"`;
  }

  const buildQuery = (filter) => `{
    products(first: 20 ${filter}, sortKey: BEST_SELLING) {
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
  
  // Tentativo 1: ricerca specifica
  let data = await shopifyFetch(buildQuery(searchFilter));
  let products = data?.data?.products?.edges || [];
  
  // Tentativo 2: Fallback sui best seller se la ricerca esatta fallisce
  if (products.length === 0) {
    data = await shopifyFetch(buildQuery("")); 
    products = data?.data?.products?.edges || [];
  }

  return products.map(p => ({
    name: p.node.title,
    type: p.node.productType,
    price_internal: p.node.priceRange.minVariantPrice.amount, // Mantenuto internamente, l'AI sa che non deve mostrarlo
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
        description: "Cerca prodotti nel catalogo. Se la ricerca esatta fallisce, restituisce i best seller.",
        parameters: {
            type: "OBJECT",
            properties: {
                keyword: {
                    type: "STRING",
                    description: "La parola chiave principale (es. 'tazza', 'maglia')."
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

// --- 4. HANDLER SERVERLESS ---
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
        Sei l'AI Malmostosa, l'assistente ufficiale dello shop "Il Bresciano Malmostoso".
        
        IL TUO CARATTERE:
        - Sei efficiente, diretto e un po' "brusco" (malmostoso), ma alla fine aiuti sempre.
        - Non usare troppi giri di parole. Vai al sodo.
        
        MAPPA DEL CATALOGO (Usa queste associazioni mentali per la ricerca):
        - Se cercano "Maglietta" o "Maglia" -> cerca "T-Shirt"
        - Se cercano "Felpa" -> cerca "Hoodie" o "Crewneck"
        - Se cercano "Accendino" -> cerca "Clipper"
        - Se cercano "Costume" -> cerca "Costume" o "Swimwear"

        REGOLE FERREE DI RICERCA E VENDITA:
        1. Hai a disposizione la lista dei prodotti restituiti dal sistema. Se la richiesta esatta dell'utente non è presente, NON DIRE MAI "non ho trovato nulla". 
        2. Cerca nella lista ricevuta il prodotto più simile per categoria o proponi i best seller che vedi disponibili. Il tuo scopo è trovare una soluzione alternativa e vendere.
        3. Fai capire all'utente che stai proponendo un'alternativa valida.
        
        REGOLE DI VISUALIZZAZIONE (OBBLIGATORIE):
        - MOSTRA L'IMMAGINE: Usa la sintassi Markdown ![Nome](URL)
        - MOSTRA LA DISPONIBILITÀ: Scrivi "Pezzi rimasti: X" (dove X è stock).
        - MOSTRA IL LINK: Metti un link diretto tipo [Vedi il prodotto](URL).
        - 🚫 NON MOSTRARE MAI IL PREZZO. Se l'utente lo chiede, rispondi: "Il prezzo lo vedi cliccando sul link, cambia spesso e non voglio sbagliare".
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
