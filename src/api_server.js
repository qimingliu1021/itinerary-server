/**
 * Itinerary API Server
 * Takes a query and returns structured 3-day itinerary with activities and events
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { ChatOpenAI } from "@langchain/openai";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const CONFIG = {
  brightdataApiKey: process.env.BRIGHTDATA_API_KEY,
  openaiKey: process.env.OPENAI_API_KEY,
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  port: process.env.API_PORT || 5500,
};

// Validate configuration
if (!CONFIG.brightdataApiKey) {
  console.error("❌ BRIGHTDATA_API_KEY is required");
  process.exit(1);
}

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, "../logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Logger utility
class Logger {
  constructor(requestId) {
    this.requestId = requestId;
    this.timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.logFile = path.join(
      logsDir,
      `itinerary_${this.timestamp}_${requestId}.log`
    );
    this.jsonFile = path.join(
      logsDir,
      `itinerary_${this.timestamp}_${requestId}.json`
    );
    this.data = {
      requestId,
      timestamp: new Date().toISOString(),
      city: null,
      interests: null,
      searches: [],
      scrapedContent: [],
      aiPrompt: null,
      aiResponse: null,
      finalItinerary: null,
    };
  }

  log(message) {
    const logEntry = `[${new Date().toISOString()}] ${message}\n`;
    console.log(message);
    fs.appendFileSync(this.logFile, logEntry);
  }

  logSearch(type, query, results) {
    this.log(`\n${"=".repeat(80)}`);
    this.log(`🔍 ${type.toUpperCase()} SEARCH`);
    this.log(`Query: ${query}`);
    this.log(`Results count: ${results.organic?.length || 0}`);
    this.log(`${"=".repeat(80)}\n`);

    this.data.searches.push({
      type,
      query,
      resultsCount: results.organic?.length || 0,
      results: results,
      timestamp: new Date().toISOString(),
    });

    // Save detailed results to file
    const searchFile = path.join(
      logsDir,
      `search_${type}_${this.timestamp}_${this.requestId}.json`
    );
    fs.writeFileSync(searchFile, JSON.stringify(results, null, 2));
    this.log(`📁 Full search results saved to: ${path.basename(searchFile)}`);
  }
  logScrape(url, type, content, index, total) {
    this.log(`\n📄 Scraping [${index}/${total}]: ${url}`);
    this.log(`Type: ${type}`);
    this.log(`Content length: ${content.length} characters`);

    this.data.scrapedContent.push({
      url,
      type,
      contentLength: content.length,
      content: content,
      timestamp: new Date().toISOString(),
    });

    // Save individual scraped content
    const scrapeFile = path.join(
      logsDir,
      `scrape_${index}_${this.timestamp}_${this.requestId}.txt`
    );
    fs.writeFileSync(
      scrapeFile,
      `URL: ${url}\nType: ${type}\nTimestamp: ${new Date().toISOString()}\n\n${content}`
    );
  }

  logAIPrompt(prompt) {
    this.log(`\n${"=".repeat(80)}`);
    this.log(`🤖 AI PROMPT`);
    this.log(`Prompt length: ${prompt.length} characters`);
    this.log(`${"=".repeat(80)}\n`);

    this.data.aiPrompt = prompt;

    const promptFile = path.join(
      logsDir,
      `ai_prompt_${this.timestamp}_${this.requestId}.txt`
    );
    fs.writeFileSync(promptFile, prompt);
    this.log(`📁 Full AI prompt saved to: ${path.basename(promptFile)}`);
  }

  logAIResponse(response) {
    this.log(`\n${"=".repeat(80)}`);
    this.log(`🤖 AI RESPONSE`);
    this.log(`Response length: ${response.length} characters`);
    this.log(`${"=".repeat(80)}\n`);

    this.data.aiResponse = response;

    const responseFile = path.join(
      logsDir,
      `ai_response_${this.timestamp}_${this.requestId}.txt`
    );
    fs.writeFileSync(responseFile, response);
    this.log(`📁 Full AI response saved to: ${path.basename(responseFile)}`);
  }
  logFinalItinerary(itinerary) {
    this.data.finalItinerary = itinerary;
    this.log(`\n✅ Final itinerary generated with ${itinerary.length} items`);
  }

  saveAll() {
    // Save comprehensive JSON log
    fs.writeFileSync(this.jsonFile, JSON.stringify(this.data, null, 2));
    this.log(
      `\n📦 Complete log data saved to: ${path.basename(this.jsonFile)}`
    );
    this.log(`📂 All logs saved in: ${logsDir}`);
  }
}

// Initialize MCP client
let mcpClient = null;
let searchTool = null;
let scrapeTool = null;

async function initializeMCP() {
  console.log("🔄 Initializing (or re-initializing) Bright Data MCP client...");

  try {
    mcpClient = new MultiServerMCPClient({
      bright_data: {
        url: `https://mcp.brightdata.com/sse?token=${CONFIG.brightdataApiKey}&pro=1`,
        transport: "sse",
      },
    });

    const allTools = await mcpClient.getTools();
    searchTool = allTools.find((t) => t.name === "search_engine");
    scrapeTool = allTools.find((t) => t.name === "scrape_as_markdown");

    if (!searchTool || !scrapeTool) {
      throw new Error("Required tools not found");
    }

    console.log("✅ MCP client initialized");
  } catch (error) {
    console.error("❌ Failed to initialize MCP:", error.message);
    throw error; // Re-throw so the caller knows it failed
  }
}

/**
 * Safely invokes a tool with auto-reconnect logic
 */
/**
 * Safely invokes a tool with auto-reconnect logic
 * FIX: Added 'attempt' parameter to prevent infinite recursion
 */
async function safeToolInvoke(tool, params, options, logger, attempt = 1) {
  try {
    // Try the call normally
    return await tool.invoke(params, options);
  } catch (error) {
    // STOP CONDITION: If we have already retried once, stop and throw the error.
    if (attempt > 1) {
      logger.log(`❌ Retry attempt failed. Giving up. Error: ${error.message}`);
      throw error;
    }

    // Check for connection errors
    const isTransportError =
      error.message &&
      (error.message.includes("No active transport") ||
        error.message.includes("Connection closed") ||
        error.message.includes("HTTP 400"));

    if (isTransportError) {
      logger.log(
        `⚠️ Connection lost (${error.message}). Re-initializing MCP...`
      );

      try {
        // 1. Re-initialize the connection
        await initializeMCP();

        // 2. Get the FRESH tool reference
        // Note: We use the global variables searchTool/scrapeTool which were just updated by initializeMCP
        const newTool = tool.name === "search_engine" ? searchTool : scrapeTool;

        // 3. Retry exactly ONE time (pass attempt = 2)
        logger.log(`🔄 Retrying ${tool.name} with new connection...`);
        return await safeToolInvoke(
          newTool,
          params,
          options,
          logger,
          attempt + 1
        );
      } catch (reconnectError) {
        logger.log(`❌ Reconnection failed: ${reconnectError.message}`);
        throw reconnectError;
      }
    }

    // If it's not a transport error, just throw it
    throw error;
  }
}

/**
 * Generate 3-day itinerary with activities and events
 */
async function generateItinerary(
  city,
  interests,
  maxResults = 20,
  logger,
  startDate,
  endDate
) {
  logger.log(`\n📍 Generating itinerary for ${interests} in ${city}`);
  logger.data.city = city;
  logger.data.interests = interests;

  const startDateObj = new Date(startDate);
  const endDateObj = new Date(endDate);

  const llm = CONFIG.openaiKey
    ? new ChatOpenAI({
        apiKey: CONFIG.openaiKey,
        model: CONFIG.openaiModel,
        temperature: 0.7,
      })
    : null;

  // Format dates for search queries
  const dateRange =
    startDate && endDate
      ? `${startDateObj.toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        })} to ${endDateObj.toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        })}`
      : "upcoming";

  // Search for activities (office tours, company visits)
  const activityQuery = `${city} ${interests} attractions activities places to visit things to do ${dateRange}`;
  logger.log(`🔍 Searching activities: ${activityQuery}`);
  const activityResults = await safeToolInvoke(
    searchTool,
    {
      query: activityQuery,
      engine: "google",
    },
    { timeout: 3600000 },
    logger
  );
  const activityData =
    typeof activityResults === "string"
      ? JSON.parse(activityResults)
      : activityResults;

  logger.logSearch("activity", activityQuery, activityData);

  // Search for events (networking, conferences, meetups)
  const eventQuery = `${city} ${interests} networking events conferences meetups competitions ${dateRange}`;
  logger.log(`🔍 Searching events: ${eventQuery}`);
  const eventResults = await safeToolInvoke(
    searchTool,
    {
      query: eventQuery,
      engine: "google",
    },
    { timeout: 180000 },
    logger
  );

  const eventData =
    typeof eventResults === "string" ? JSON.parse(eventResults) : eventResults;

  logger.logSearch("event", eventQuery, eventData);

  // Scrape top results
  const allUrls = [];

  // Get 10 activity URLs
  if (activityData.organic) {
    for (let i = 0; i < Math.min(3, activityData.organic.length); i++) {
      if (activityData.organic[i].link) {
        allUrls.push({ url: activityData.organic[i].link, type: "activity" });
      }
    }
  }

  // Get 10 event URLs
  if (eventData.organic) {
    for (let i = 0; i < Math.min(3, eventData.organic.length); i++) {
      if (eventData.organic[i].link) {
        allUrls.push({ url: eventData.organic[i].link, type: "event" });
      }
    }
  }

  console.log(`📄 Scraping ${allUrls.length} pages...`);
  console.log("🔄 All URLs:", allUrls);

  const scrapedContent = [];

  for (let idx = 0; idx < allUrls.length; idx++) {
    const { url, type } = allUrls[idx];
    try {
      const content = await safeToolInvoke(
        scrapeTool,
        { url },
        { timeout: 180000 },
        logger
      );

      scrapedContent.push({
        url,
        type,
        content:
          typeof content === "string" ? content : JSON.stringify(content),
      });
      logger.logScrape(url, type, content, idx + 1, allUrls.length);
    } catch (error) {
      logger.log(`❌ Failed to scrape ${url}: ${error.message}`, "error");
    }
  }

  logger.log(`\n✅ Successfully scraped ${scrapedContent.length} pages`);

  // Use AI to structure the itinerary
  if (llm && scrapedContent.length > 0) {
    const prompt = `You are an itinerary planning AI. Based on the scraped web data below, create a structured itinerary for a ${interests} in ${city}.

Requirements:
- Create activities and events for these SPECIFIC dates:
  * Start: ${startDateObj.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  })}
  * End: ${endDateObj.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  })}
- 6-10 professional activities (attractions, activities, places to visit, things to do)
- 5-10 networking/professional events (conferences, meetups, competitions, skill presentations)
- Each item must have:
  * name: Activity/event name
  * type: "activity" or "event"
  * location: Full address
  * coordinates: {lat, lng} (estimate if not available)
  * start_time: ISO 8601 format (MUST be between ${new Date(
    startDateObj
  ).toISOString()} and ${endDateObj.toISOString()})
  * end_time: ISO 8601 format (same date as start_time)
  * duration_minutes: Number
  * contact: {name, email, phone} (extract or generate realistic ones)
  * description: Brief description
  * url: Source URL

CRITICAL: All start_time and end_time values MUST be within the date range provided above.
Distribute items across the date range with realistic timing (9 AM - 9 PM).
If scraped content doesn't have exact dates, adjust them to fit within the provided date range.

Scraped Data:
${scrapedContent
  .map(
    (s, i) =>
      `\n[${i + 1}] ${s.type.toUpperCase()} - ${s.url}\n${s.content.substring(
        0,
        2000
      )}`
  )
  .join("\n\n")}

Return ONLY valid JSON array with exactly 10-20 items.`;

    logger.logAIPrompt(prompt);

    try {
      const response = await llm.invoke(
        {
          role: "system",
          content: `You are a JSON-only itinerary planner. 

CRITICAL: You MUST return a JSON object in EXACTLY this structure:
{
  "itinerary": [
    {
      "name": "Activity Name",
      "type": "activity",
      "location": "Full Address",
      "coordinates": {"lat": 40.7128, "lng": -74.0060},
      "start_time": "2025-11-22T09:00:00.000Z",
      "end_time": "2025-11-22T11:00:00.000Z",
      "duration_minutes": 120,
      "contact": {
        "name": "Contact Name",
        "email": "email@example.com",
        "phone": "123-456-7890"
      },
      "description": "Brief description",
      "url": "https://example.com"
    }
  ]
}

DO NOT return just an array like [{}]. You MUST wrap the array in an object with the "itinerary" key.
Return ONLY valid JSON. No markdown, no code blocks, no explanation.`,
        },
        { role: "user", content: prompt }
      );

      logger.logAIResponse(response.content);

      // Clean markdown formatting if present
      let jsonText = response.content.trim();
      jsonText = jsonText.replace(/\n?/g, "").replace(/```\n?/g, "");

      const itinerary = JSON.parse(jsonText);

      logger.logFinalItinerary(itinerary);
      console.log("🔄 Itinerary:", itinerary);

      return itinerary;
    } catch (error) {
      logger.log(`❌ AI parsing failed: ${error.message}`, "error");
      return null;
    }
  }
}

// API Routes
app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.post("/api/generate-itinerary", async (req, res) => {
  const requestId = Date.now().toString();
  const logger = new Logger(requestId);

  try {
    const { city, interests, max_results = 5, start_date, end_date } = req.body;

    if (!city || !interests) {
      return res.status(400).json({ error: "city and interests are required" });
    }

    logger.log(`\n📥 Request ID: ${requestId}`);
    logger.log(`📥 Request: ${city} / ${interests}`);
    const itinerary = await generateItinerary(
      city,
      interests,
      max_results,
      logger,
      start_date,
      end_date
    );

    // Ensure itinerary is an array
    const itineraryArray = Array.isArray(itinerary.itinerary)
      ? itinerary.itinerary
      : [];

    const response = {
      success: true,
      city,
      interests,
      itinerary: itineraryArray,
      total_items: itineraryArray.length,
      activities: itineraryArray.filter((i) => i.type === "activity").length,
      events: itineraryArray.filter((i) => i.type === "event").length,
      generated_at: new Date().toISOString(),
      request_id: requestId,
    };
    logger.saveAll();
    res.json(response);
  } catch (error) {
    logger.log(`❌ Error: ${error.message}`);
    logger.log(`Stack: ${error.stack}`);
    logger.saveAll();
    res.status(500).json({ error: error.message });
  }
});

// Start server
async function start() {
  try {
    await initializeMCP();

    app.listen(CONFIG.port, "0.0.0.0", () => {
      console.log("\n" + "=".repeat(60));
      console.log("🚀 Itinerary API Server Running");
      console.log("=".repeat(60));
      console.log(`📡 Server: http://localhost:${CONFIG.port}`);
      console.log(`🔧 Endpoints:`);
      console.log(`   GET  /health`);
      console.log(`   POST /api/generate-itinerary`);
      console.log("=".repeat(60));
      console.log("\n✅ Ready to generate itineraries!\n");
    });
  } catch (error) {
    console.error("❌ Failed to start:", error.message);
    process.exit(1);
  }
}

start();
