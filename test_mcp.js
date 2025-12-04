// test_mcp.js
import "dotenv/config";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";

const apiKey = process.env.BRIGHTDATA_API_KEY;

async function test() {
  console.log("🔄 Connecting to Bright Data MCP...");

  const client = new MultiServerMCPClient({
    bright_data: {
      url: `https://mcp.brightdata.com/sse?token=${apiKey}&pro=1`,
      transport: "sse",
    },
  });

  const tools = await client.getTools();
  console.log(`✅ Found ${tools.length} tools:`);
  tools.forEach((t) => console.log(`   - ${t.name}`));

  const searchTool = tools.find((t) => t.name === "search_engine");

  if (!searchTool) {
    console.error("❌ search_engine tool not found!");
    process.exit(1);
  }

  console.log("\n🧪 Testing search_engine...");
  try {
    const result = await searchTool.invoke(
      { query: "hello world", engine: "google" },
      { timeout: 3600000 } // 1 hour
    );
    console.log("✅ SUCCESS!");
    console.log("Result:", JSON.stringify(result).substring(0, 500));
  } catch (error) {
    console.error("❌ FAILED:", error.message);
  }

  await client.close();
  process.exit(0);
}

test();
