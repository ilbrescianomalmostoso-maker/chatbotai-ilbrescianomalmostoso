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

// --- 2. DEFINIZIONE STRUMENTI ---
async function getBestSellers() {
  // AGGIORNAMENTO: Ora chiediamo anche 'featuredImage'
  const query = `{
    products(first: 5) {
      edges {
        node {
          title
          handle
          totalInventory
          featuredImage { url } 
          priceRange { minVariantPrice { amount currencyCode } }
        }
      }
    }
  }`;
  
  const data = await shopifyFetch(query);
  const products = data?.data?.products?.edges || [];
  
  return products.map(p => ({
    name: p.node.title,
    price: p.node.priceRange.minVariantPrice.amount + " " + p.node.priceRange.minVariantPrice.currencyCode,
    stock: p.node.totalInventory,
    // Gestiamo il caso in cui il prodotto non abbia immagini
    image: p.node.featuredImage ? p.node.featuredImage.url : "", 
    link: `https://${cleanDomain}/products/${p.node.handle}`
  }));
}

const tools = [
  {
    function_declarations: [
      {
        name: "getBestSellers",
        description: "Ottiene i prodotti best seller con prezzi, stock, link e URL immagine.",
      }
    ],
  },
];

// --- 3. CONFIGURAZIONE MODELLO ---
// Nota: Usa pure il modello che preferisci (es. gemini-2.5-flash)
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
        // ISTRUZIONI AGGIORNATE: Diciamo all'AI come formattare immagini e link
        parts: [{ text: `Sei un personal shopper. 
        Quando consigli un prodotto:
        1. Mostra l'immagine usando questo formato Markdown: ![Titolo Prodotto](URL_IMMAGINE)
        2. Metti il link all'acquisto usando questo formato: [Acquista Ora](URL_LINK)
        3. Indica il prezzo.` }]
      }
    });

    const result = await chat.sendMessage(message);
    const response = await result.response;
    const functionCalls = response.functionCalls();

    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      if (call.name === "getBestSellers") {
        const productData = await getBestSellers();
        
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

    return res.status(200).json({ text: response.text() });

  } catch (error) {
    console.error("Server Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
