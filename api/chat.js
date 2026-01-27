import { GoogleGenerativeAI } from "@google/generative-ai";

// --- CONFIGURAZIONE ---
// Inizializza Gemini con la tua chiave API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Recupera le credenziali Shopify
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_URL; 
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// --- 1. FUNZIONE PER PARLARE CON SHOPIFY ---
async function shopifyFetch(query) {
  // Pulisce l'URL per evitare doppi https o slash
  const cleanDomain = SHOPIFY_DOMAIN.replace('https://', '').replace(/\/$/, '');
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
    
    if (!response.ok) {
      console.error("Shopify Error:", response.statusText);
      return null;
    }
    return await response.json();
  } catch (e) {
    console.error("Fetch Error:", e);
    return null;
  }
}

// --- 2. GLI STRUMENTI (TOOLS) DELL'AI ---

// Funzione reale che l'AI chiamerà
async function getBestSellers() {
  // Cerca i primi 5 prodotti.
  // Se non hai una collezione "frontpage", prenderà i primi 5 prodotti generali.
  const query = `{
    products(first: 5) {
      edges {
        node {
          title
          handle
          totalInventory
          priceRange { minVariantPrice { amount currencyCode } }
        }
      }
    }
  }`;
  
  const data = await shopifyFetch(query);
  const products = data?.data?.products?.edges || [];
  
  // Formatta i dati per renderli leggibili all'AI
  return products.map(p => ({
    name: p.node.title,
    price: p.node.priceRange.minVariantPrice.amount + " " + p.node.priceRange.minVariantPrice.currencyCode,
    stock: p.node.totalInventory,
    link: `https://${SHOPIFY_DOMAIN}/products/${p.node.handle}`
  }));
}

// Definizione dello strumento per Gemini
const tools = [
  {
    function_declarations: [
      {
        name: "getBestSellers",
        description: "Ottiene la lista dei prodotti disponibili o best seller con prezzi e stock. Usalo quando l'utente chiede consigli su cosa comprare.",
      }
    ],
  },
];

// Inizializza il modello con i tools
const model = genAI.getGenerativeModel({ 
  model: "gemini-1.5-flash", 
  tools: tools 
});

// --- 3. IL GESTORE DELLA CHAT (SERVER) ---
export default async function handler(req, res) {
  // A. Gestione CORS (Permessi di sicurezza)
  // Questo blocco permette al tuo sito Shopify di comunicare con Vercel
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // Risponde subito alle richieste di controllo (Preflight)
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { message, history } = req.body;

    // B. Avvia la Chat
    const chat = model.startChat({
      history: history || [],
      system_instruction: {
        parts: [{ text: "Sei un personal shopper esperto per un negozio online. Sei gentile, conciso e persuasivo. Se consigli un prodotto, includi sempre il prezzo. Se lo stock è basso (sotto 5), crea urgenza." }]
      }
    });

    // C. Invia il messaggio all'AI
    const result = await chat.sendMessage(message);
    const response = await result.response;
    
    // D. Controlla se l'AI vuole usare uno strumento (Function Calling)
    const functionCalls = response.functionCalls();

    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      
      if (call.name === "getBestSellers") {
        // L'AI ha chiesto i prodotti -> Eseguiamo la funzione
        const productData = await getBestSellers();
        
        // Restituiamo i dati all'AI
        const result2 = await chat.sendMessage(
          [{
            functionResponse: {
              name: "getBestSellers",
              response: { products: productData }
            }
          }]
        );
        
        // Risposta finale dell'AI dopo aver letto i dati
        return res.status(200).json({ text: result2.response.text() });
      }
    }

    // E. Risposta normale (senza strumenti)
    return res.status(200).json({ text: response.text() });

  } catch (error) {
    console.error("Server Error:", error);
    return res.status(500).json({ error: "Errore interno del server. Controlla i log di Vercel." });
  }
}      }
    }
  }`;
  const data = await shopifyFetch(query);
  const products = data.data?.collectionByHandle?.products?.edges || [];
  return products.map(p => ({
    title: p.node.title,
    price: p.node.priceRange.minVariantPrice.amount,
    stock: p.node.totalInventory
  }));
}

// --- CONFIGURAZIONE GEMINI ---

const tools = [
  {
    function_declarations: [
      {
        name: "getBestSellers",
        description: "Restituisce i prodotti più popolari o best seller del negozio con prezzi e stock.",
      }
    ],
  },
];

// Cambia la riga del modello con questa:
const model = genAI.getGenerativeModel({ model: "gemini-3-pro-preview", tools });
export default async function handler(req, res) {
  // CORS (Permette al tuo sito di chiamare questo server)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { message, history } = req.body;
    
    // Avvia la chat
    const chat = model.startChat({
      history: history || [], // Mantiene la memoria della conversazione
      system_instruction: "Sei un assistente di vendita esperto. Sei gentile, breve e persuasivo. Se l'utente chiede consigli, proponi i best seller. Se lo stock è basso (sotto 5), crea urgenza."
    });

    const result = await chat.sendMessage(message);
    const response = await result.response;
    const functionCalls = response.functionCalls();

    // Se Gemini vuole usare uno strumento (es. cercare prodotti)
    if (functionCalls) {
      const call = functionCalls[0];
      if (call.name === "getBestSellers") {
        const productData = await getBestSellers();
        // Restituisci i dati a Gemini
        const result2 = await chat.sendMessage(
          [{
            functionResponse: {
              name: "getBestSellers",
              response: { products: productData }
            }
          }]
        );
        return res.status(200).json({ text: result2.response.text() });
      }
    }

    // Risposta normale
    return res.status(200).json({ text: response.text() });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Errore interno del server" });
  }
}
