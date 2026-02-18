import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_URL; 
const cleanDomain = SHOPIFY_DOMAIN ? SHOPIFY_DOMAIN.replace('https://', '').replace(/\/$/, '') : "";

// --- 1. RECUPERO CATALOGO ---
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
        
        REGOLE VITALI E INFRANGIBILI:
        1. STRUMENTO OBBLIGATORIO: Usa 'getStoreCatalog' per leggere il catalogo.
        2. ASSOCIAZIONI MENTALI: "accendino" -> cerca "Clipper", "felpa" -> "Hoodie", "coperta" -> "Plaid".
        3. LIMITE ASSOLUTO (5 PRODOTTI): Estrai un MASSIMO di 5 prodotti pertinenti. Se ce ne sono di più, ignorali. Devi fermarti a 5. È un ordine rigoroso.
        4. LINK IN CHIARO: Il widget non legge i link nascosti. Stampa l'URL per esteso visibile all'utente.
        5. NESSUNA DOMANDA: È severamente vietato chiudere i messaggi o usare frasi con il punto di domanda ("?"). Usa solo istruzioni affermative (es. "Scrivimi per vedere il resto del catalogo."). Non chiedere mai niente all'utente.
        
        FORMATO RISPOSTA OBBLIGATORIO PER I PRODOTTI:
        🔸 **[Nome Prodotto]**
        👉 Clicca qui: https://www.robertomaiolino.it/blografik/2017/12/01/prodotto-e-packaging/
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
