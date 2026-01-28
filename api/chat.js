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
  let searchFilter = "";
  if (keyword) {
      const cleanKeyword = keyword.trim();
      // Cerca la parola e le sue varianti
      searchFilter = `, query: "${cleanKeyword}*"`;
  }

  // Chiediamo i primi 10 prodotti
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
  
  // Se non trova nulla, restituisce array vuoto, ma l'AI gestirà la cosa proponendo altro
  if (products.length === 0) return [];

  return products.map(p => ({
    name: p.node.title,
    type: p.node.productType,
    // Passiamo il prezzo per calcoli interni, ma diremo all'AI di non mostrarlo
    price_internal: p.node.priceRange.minVariantPrice.amount, 
    stock: p.node.totalInventory, // QUANTO NE RIMANE
    image: p.node.featuredImage ? p.node.featuredImage.url : "",
    link: `https://${cleanDomain}/products/${p.node.handle}`
  }));
}

const tools = [
  {
    function_declarations: [
      {
        name: "searchProducts",
        description: "Cerca prodotti nel catalogo per parola chiave.",
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
// Ho messo gemini-1.5-flash perché la versione 2.5-lite non è ancora standard e potrebbe dare errori
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash", 
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
        parts: [{ text: `
        Sei l'AI Malmostosa, l'assistente ufficiale dello shop "Il Bresciano Malmostoso".
        
        IL TUO CARATTERE:
        - Sei efficiente, diretto e un po' "brusco" (malmostoso), ma alla fine aiuti sempre.
        - Non usare troppi giri di parole. Vai al sodo.
        
        REGOLE FERREE DI RICERCA (MISSIONE: TROVARE SOLUZIONI):
        1. Non dire MAI "non ho trovato nulla". Se l'utente cerca una cosa che non c'è, usa la ricerca per trovare qualcosa di SIMILE o proponi l'articolo più venduto. Devi vendere.
        2. Traduci mentalmente le richieste (es. "Felpa" -> cerca "Hoodie").
        
        REGOLE DI VISUALIZZAZIONE (OBBLIGATORIE):
        - MOSTRA L'IMMAGINE: Usa la sintassi Markdown ![Nome](URL)
        - MOSTRA LA DISPONIBILITÀ: Scrivi "Pezzi rimasti: X" (dove X è stock).
        - MOSTRA IL LINK: Metti un link diretto tipo [Vedi il prodotto](URL).
        - 🚫 NON MOSTRARE MAI IL PREZZO. Se l'utente lo chiede, rispondi: "Il prezzo lo vedi cliccando sul link, cambia spesso e non voglio sbagliare".
        
        FORMATO RISPOSTA IDEALE:
        "Ecco cosa ho trovato per te:
        
        ![Nome Prodotto](URL_IMMAGINE)
        **Nome Prodotto**
        📦 Pezzi rimasti: [Stock]
        🔗 [Vai al prodotto](URL_LINK)
        "
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
