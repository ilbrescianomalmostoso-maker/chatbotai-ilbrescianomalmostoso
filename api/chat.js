import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// Funzione Helper per parlare con Shopify
async function shopifyFetch(query) {
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
    return await response.json();
  } catch (e) {
    console.error("Fetch Error:", e);
    return null;
  }
}

// Strumento: Get Best Sellers
async function getBestSellers() {
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
  return products.map(p => ({
    title: p.node.title,
    price: p.node.priceRange.minVariantPrice.amount + " " + p.node.priceRange.minVariantPrice.currencyCode,
    stock: p.node.totalInventory
  }));
}

// Configurazione AI
const tools = [
  {
    function_declarations: [
      {
        name: "getBestSellers",
        description: "Restituisce i prodotti best seller con prezzi e stock.",
      }
    ],
  },
];

const model = genAI.getGenerativeModel({
  model: "gemini-3-pro-preview",
  tools: tools
});

// Handler Principale
export default async function handler(req, res) {
  // CORS
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
        parts: [{ text: "Sei un personal shopper. Consiglia i prodotti best seller se richiesto. Usa sempre prezzi e link." }]
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
