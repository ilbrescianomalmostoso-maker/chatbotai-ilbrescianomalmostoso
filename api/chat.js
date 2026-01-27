import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

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
    name: p.node.title,
    price: p.node.priceRange.minVariantPrice.amount + " " + p.node.priceRange.minVariantPrice.currencyCode,
    stock: p.node.totalInventory,
    link: `https://${cleanDomain}/products/${p.node.handle}`
  }));
}

const tools = [
  {
    function_declarations: [
      {
        name: "getBestSellers",
        description: "Ottiene la lista dei prodotti best seller con prezzi e stock.",
      }
    ],
  },
];

// MODELLO STABILE E GRATUITO
const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  tools: tools
});

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
        parts: [{ text: "Sei un personal shopper esperto. Rispondi in modo rapido e amichevole. Se consigli prodotti, usa sempre i dati reali forniti dallo strumento." }]
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
