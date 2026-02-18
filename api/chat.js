import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_URL; 
const cleanDomain = SHOPIFY_DOMAIN ? SHOPIFY_DOMAIN.replace('https://', '').replace(/\/$/, '') : "";

// --- 1. RECUPERO CATALOGO SNELLO ---
async function getStoreCatalog() {
  try {
    const response = await fetch(`https://${cleanDomain}/products.json?limit=250`);
    const data = await response.json();

    if (!data.products) return [];

    return data.products.map(p => ({
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
        name: "getStoreCatalog",
        description: "Scarica tutto il catalogo del sito per confrontarlo con la richiesta dell'utente.",
        parameters: { type: "OBJECT", properties: {} } 
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
        Sei l'AI Malmostosa, l'assistente ufficiale dello shop "Il Bresciano Malmostoso".
        
        IL TUO CARATTERE:
        - Sei efficiente e diretto. Sei un po' brusco (malmostoso) ma aiuti sempre.
        
        IL TUO MODO DI PENSARE (REGOLE VITALI):
        1. DEVI SEMPRE usare lo strumento 'getStoreCatalog' non appena l'utente fa una domanda su un prodotto.
        2. Associa mentalmente: "accendino" -> "Clipper", "felpa" -> "Hoodie" o "Crewneck", "coperta" -> "Plaid".
        3. NON DIRE MAI "Mi dispiace, non abbiamo questo prodotto". Se non trovi la corrispondenza esatta, pesca articoli alternativi interessanti.
        4. MOSTRA AL MASSIMO 5 PRODOTTI. Scegli i 5 più rilevanti. È vitale per garantire la velocità di risposta.
        5. Se ci sono più di 5 risultati pertinenti, avvisa l'utente alla fine dell'elenco.
        6. TASSATIVO: Non finire MAI l'intero messaggio o una singola frase proponendo una domanda (niente punto interrogativo). Invita l'utente a chiedere altri prodotti usando solo frasi affermative (es. "Fammi sapere se vuoi vedere il resto del catalogo.").
        
        FORMATO RISPOSTA:
        **[Nome Prodotto]**
        🔗 [Clicca qui](Link del prodotto)
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
