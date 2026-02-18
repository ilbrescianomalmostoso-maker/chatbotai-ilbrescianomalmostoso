import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Assicurati che in Vercel la variabile sia impostata senza https:// finale (es. shop.ilbrescianomalmostoso.it)
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_URL; 
const cleanDomain = SHOPIFY_DOMAIN ? SHOPIFY_DOMAIN.replace('https://', '').replace(/\/$/, '') : "";

// --- 1. IL METODO "SNELLO E VELOCE" ---
// Scarichiamo il feed pubblico del tuo sito. Niente token di sicurezza, niente GraphQL.
async function getStoreCatalog() {
  try {
    const response = await fetch(`https://${cleanDomain}/products.json?limit=250`);
    const data = await response.json();

    if (!data.products) return [];

    // Mappiamo solo nome e link per essere leggerissimi e non mandare in palla l'AI
    return data.products.map(p => ({
      nome: p.title,
      link: `https://${cleanDomain}/products/${p.handle}`
    }));
  } catch (e) {
    console.error("Errore catalogo pubblico:", e);
    return [];
  }
}

const tools = [
  {
    function_declarations: [
      {
        name: "getStoreCatalog",
        description: "Scarica tutto il catalogo del sito per confrontarlo con la richiesta dell'utente.",
        parameters: { type: "OBJECT", properties: {} } // Nessun parametro, scarica tutto a prescindere
      }
    ],
  },
];

// --- 2. CONFIGURAZIONE MODELLO ---
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash", 
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
        Sei l'AI Malmostosa, l'assistente ufficiale dello shop "Il Bresciano Malmostoso".
        
        IL TUO CARATTERE:
        - Sei efficiente e diretto. Sei un po' brusco (malmostoso) ma aiuti sempre.
        
        IL TUO MODO DI PENSARE (REGOLE VITALI):
        1. DEVI SEMPRE usare lo strumento 'getStoreCatalog' non appena l'utente fa una domanda su un prodotto. Ti fornirà una lista di tutto ciò che c'è in negozio.
        2. Quando ricevi la lista, usa la tua intelligenza semantica per cercare nel testo. 
           - Se chiedono "accendino", scorri la lista e cerca "Clipper".
           - Se chiedono "felpa", scorri la lista e cerca "Hoodie" o "Crewneck".
           - Se chiedono "coperta", cerca "Plaid".
        3. NON DIRE MAI E POI MAI "Mi dispiace, non abbiamo questo prodotto". Se non trovi la corrispondenza esatta, pesca 2 o 3 articoli casuali ma interessanti dalla lista e proponili dicendo: "Non ho quello che cerchi, ma guarda che bella roba abbiamo:".
        
        FORMATO RISPOSTA:
        **[Nome Prodotto Esatto]**
        🔗 [Link del prodotto]
        ` }]
      }
    });

    const result = await chat.sendMessage(message);
    const response = await result.response;
    const functionCalls = response.functionCalls();

    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      
      if (call.name === "getStoreCatalog") {
        const catalogData = await getStoreCatalog();
        
        const result2 = await chat.sendMessage(
          [{
            functionResponse: {
              name: "getStoreCatalog",
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
