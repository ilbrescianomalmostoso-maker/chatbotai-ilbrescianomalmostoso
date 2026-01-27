import { GoogleGenerativeAI } from "@google/generative-ai";

// Configurazione
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_URL; // es: tuonozio.myshopify.com
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// --- FUNZIONI SHOPIFY ---

async function shopifyFetch(query) {
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/graphql.json`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query }),
  });
  return await response.json();
}

// Strumento 1: Trova i Best Sellers
async function getBestSellers() {
  // Nota: Assicurati di avere una collezione con handle 'frontpage' o cambialo qui
  const query = `{
    collectionByHandle(handle: "frontpage") {
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
const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview", tools });
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
