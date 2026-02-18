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
    const json = await response.json();
    if (json.errors) console.error("Shopify GraphQL Error:", json.errors);
    return json;
  } catch (e) {
    console.error("Fetch Error:", e);
    return null;
  }
}

// --- 2. IL NUOVO STRUMENTO: RECUPERO INTERO CATALOGO ---
async function getStoreCatalog() {
  // Peschiamo fino a 150 prodotti attivi. Gemini li elabora in una frazione di secondo.
  // Ho rimosso totalmente i prezzi per evitare che l'AI li legga.
  const query = `{
    products(first: 150, query: "status:active") {
      edges {
        node {
          title
          handle
          totalInventory
          productType
          featuredImage { url }
        }
      }
    }
  }`;
  
  const data = await shopifyFetch(query);
  const products = data?.data?.products?.edges || [];

  return products.map(p => ({
    name: p.node.title,
    type: p.node.productType,
    stock: p.node.totalInventory,
    image: p.node.featuredImage ? p.node.featuredImage.url : "",
    link: `https://${cleanDomain}/products/${p.node.handle}`
  }));
}

const tools = [
  {
    function_declarations: [
      {
        name: "getStoreCatalog",
        description: "Scarica il catalogo dei prodotti disponibili nello store per poterlo analizzare.",
        parameters: {
            type: "OBJECT",
            properties: {} // Nessun parametro necessario, scarica tutto
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
        
        REGOLE FERREE DI RICERCA E VENDITA:
        1. DEVI SEMPRE usare lo strumento 'getStoreCatalog' per leggere cosa c'è in negozio.
        2. Usa la tua intelligenza semantica: confronta la richiesta del cliente con TUTTO il catalogo scaricato. Se chiede "accendino", capisci da solo che devi proporre "Clipper". Se chiede "costume", cerca "swimwear" o simili.
        3. NON DIRE MAI "non ho trovato nulla". Trova sempre il prodotto più attinente o proponi un'alternativa forte.
        
        REGOLE DI VISUALIZZAZIONE (OBBLIGATORIE):
        - MOSTRA L'IMMAGINE: Usa la sintassi Markdown ![Nome](URL)
        - MOSTRA LA DISPONIBILITÀ: Scrivi "Pezzi rimasti: X" (dove X è stock).
        - MOSTRA IL LINK: Metti un link diretto tipo [Vedi il prodotto](URL).
        - 🚫 NON PARLARE MAI DI PREZZI, non li conosci. Se l'utente lo chiede, rispondi: "Il prezzo lo vedi cliccando sul link, non fare il tirchio".
        ` }]
      }
    });

    const result = await chat.sendMessage(message);
    const response = await result.response;
    const functionCalls = response.functionCalls();

    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      
      if (call.name === "getStoreCatalog") {
        const productData = await getStoreCatalog();
        
        const result2 = await chat.sendMessage(
          [{
            functionResponse: {
              name: "getStoreCatalog",
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
