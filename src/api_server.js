/**
 * Itinerary API Server - Gemini with Google Search Grounding
 * Uses Gemini's native search capabilities to find real events and activities
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  INTEREST_CATEGORIES,
  getAllTags,
  findCategoriesForInterests,
  getSearchTermsForInterests,
} from "./user_interests.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const CONFIG = {
  googleApiKey: process.env.GOOGLE_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",
  port: process.env.API_PORT || 5500,
};

// Validate configuration
if (!CONFIG.googleApiKey) {
  console.error("❌ GOOGLE_API_KEY is required");
  process.exit(1);
}

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, "../logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Initialize Gemini client
const genAI = new GoogleGenAI({ apiKey: CONFIG.googleApiKey });

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
      prompts: [],
      responses: [],
      finalItinerary: null,
    };
  }

  log(message) {
    const logEntry = `[${new Date().toISOString()}] ${message}\n`;
    console.log(message);
    fs.appendFileSync(this.logFile, logEntry);
  }

  logPrompt(step, prompt) {
    this.log(`\n${"=".repeat(80)}`);
    this.log(`🤖 GEMINI PROMPT - Step: ${step}`);
    this.log(`Prompt length: ${prompt.length} characters`);
    this.log(`${"=".repeat(80)}\n`);

    this.data.prompts.push({
      step,
      prompt,
      timestamp: new Date().toISOString(),
    });

    const promptFile = path.join(
      logsDir,
      `prompt_${step}_${this.timestamp}_${this.requestId}.txt`
    );
    fs.writeFileSync(promptFile, prompt);
  }

  logResponse(step, response) {
    this.log(`\n${"=".repeat(80)}`);
    this.log(`🤖 GEMINI RESPONSE - Step: ${step}`);
    this.log(`Response length: ${response.length} characters`);
    this.log(`${"=".repeat(80)}\n`);

    this.data.responses.push({
      step,
      response,
      timestamp: new Date().toISOString(),
    });

    const responseFile = path.join(
      logsDir,
      `response_${step}_${this.timestamp}_${this.requestId}.txt`
    );
    fs.writeFileSync(responseFile, response);
  }

  logFinalItinerary(itinerary) {
    this.data.finalItinerary = itinerary;
    const count = Array.isArray(itinerary)
      ? itinerary.length
      : itinerary?.itinerary?.length || 0;
    this.log(`\n✅ Final itinerary generated with ${count} items`);
  }

  saveAll() {
    fs.writeFileSync(this.jsonFile, JSON.stringify(this.data, null, 2));
    this.log(
      `\n📦 Complete log data saved to: ${path.basename(this.jsonFile)}`
    );
  }
}

/**
 * Extract JSON from a response that might contain extra text
 */
function extractJSON(text) {
  console.log("🔧 extractJSON called, text length:", text.length);

  // First, try parsing the text directly
  try {
    return JSON.parse(text);
  } catch (e) {
    console.log("🔧 Direct parse failed, trying other methods...");
  }

  // Try to extract JSON from markdown code block: ```json{...}```
  const codeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    console.log("🔧 Found JSON in code block, extracting...");
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (e) {
      console.log("🔧 Code block JSON parse failed:", e.message);
    }
  }

  // Try to extract JSON from any code block: ```{...}```
  const anyCodeBlockMatch = text.match(/```\s*([\s\S]*?)\s*```/);
  if (anyCodeBlockMatch && anyCodeBlockMatch[1]) {
    const content = anyCodeBlockMatch[1].trim();
    if (content.startsWith("{") || content.startsWith("[")) {
      console.log("🔧 Found JSON in generic code block, extracting...");
      try {
        return JSON.parse(content);
      } catch (e) {
        console.log("🔧 Generic code block JSON parse failed:", e.message);
      }
    }
  }

  // Try to find JSON object in the text using greedy regex
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    console.log("🔧 Found JSON object via regex, length:", jsonMatch[0].length);
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.log("🔧 Regex JSON parse failed:", e.message);
    }
  }

  // Try to find JSON array in the text
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    console.log("🔧 Found JSON array via regex");
    try {
      const arr = JSON.parse(arrayMatch[0]);
      return { itinerary: arr };
    } catch (e) {
      console.log("🔧 Array JSON parse failed:", e.message);
    }
  }

  // Log what we received for debugging
  console.log("🔧 Raw text first 500 chars:", text.substring(0, 500));

  throw new Error(
    `Could not extract valid JSON from response. First 200 chars: ${text.substring(
      0,
      200
    )}`
  );
}

function buildEventSearchPrompt(city, interests, startDate, endDate) {
  const startDateObj = new Date(startDate);
  const endDateObj = new Date(endDate);

  // Format dates clearly
  const formattedStart = startDateObj.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const formattedEnd = endDateObj.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const interestList = interests.split(",").map((i) => i.trim());
  const searchTerms = getSearchTermsForInterests(interestList);
  const categories = findCategoriesForInterests(interestList);

  const interestContext =
    searchTerms.length > 0
      ? `Primary interests: ${interests}\nRelated search terms: ${searchTerms.join(
          ", "
        )}\nCategories: ${categories.join(", ")}`
      : `Interests: ${interests}`;

  return `You are an Expert Event Curator. Search for **LIVE, ORGANIZED, & PARTICIPATORY EVENTS** in ${city} related to: ${interests}.
  Target Dates: ${formattedStart} to ${formattedEnd}.
  
  ${interestContext}

  ## DYNAMIC SEARCH STRATEGY (Construct queries based on the Interest Type):
  
  Do not just search for the interest name (e.g., "Finance"). Search for the **ACTIVITY** associated with it. Use these patterns as examples:

  1. **For PROFESSIONAL & TECH (Finance, Startups, Career):**
     - **Keywords:** "Mixer", "Networking", "Fireside Chat", "Panel", "Masterclass", "Breakfast".
     - **Platforms:** Search "site:lu.ma ${city} ${interests}", "site:eventbrite.com ${city} ${interests} networking".
     - **Venues:** Search for "Events Calendar" of co-working spaces, chambers of commerce, or industry associations.

  2. **For ARTS, CULTURE & HISTORY (Museums, Theater, Design):**
     - **Keywords:** "Gallery Talk", "Curator Tour", "Workshop", "Screening", "Opening Reception", "Performance".
     - **Strategy:** Search for **"Public Programming"** or **"Calendar"** pages of specific museums/theaters (e.g., "Museum of American Finance events", "The Drawing Center programs").

  3. **For SOCIAL & HOBBIES (Outdoor, Games, Wellness):**
     - **Keywords:** "Group Run", "Club", "Meetup", "Class", "Session", "Tournament".
     - **Platforms:** Search "site:meetup.com ${city} ${interests}", "site:partiful.com ${city}", "site:runsignup.com".

  ## STRICT "EVENT" DEFINITION (Must meet ALL criteria):
  1. **HOSTED/PROGRAMMED:** Must have a human host, instructor, guide, or organizer. (NO "Self-Guided" audio tours).
  2. **SCHEDULED:** Must have a specific start time (e.g., "Starts at 7:00 PM").
  3. **NOT "GENERAL ADMISSION":** Do NOT list a museum/park just because it is open. Only list it if there is a specific *Tour*, *Talk*, or *Class* happening.
  4. **EXCEPTION:** If a venue offers a **Daily Guided Tour** included with admission, that counts as an event.

  ## REQUIREMENTS:
  1. Provide enough events to cover the day from roughly 9:00 AM to 11:59 PM (can be earlier or later), do not leave more than 1 hour gap during the day. Such as the last event of the day ends at 3pm, which is not allowed. This situation, find more events that covers until midnight.
  2. Provide at least 3-5 distinct events per day as much as possible.
  3. The time must match the time zone of ${city}.
  4. **NO "TIMED ENTRY" SLOTS:** Do not list "Timed Entry", "General Admission", or "Gallery Viewing" as events. These are just open hours.
  5. **NO "OPEN HOURS":** If the description says "Open 12-6 PM", do NOT create an event called "Afternoon Visit" from 12:00-2:00.
  6. **STRICT "SPEAKER" RULE:** A valid event MUST have a specific title (like "Book Talk", "Guided Tour", "Workshop") and implies a start time where everyone begins together.

  ## URL HANDLING:
  1. **EXTRACT, DO NOT INVENT:** You must only use URLs that are explicitly present in the search results (e.g., from Eventbrite, Meetup, Luma, Ticketmaster).
  2. **NO DEAD LINKS:** If you find a great event but cannot find a direct registration URL in the snippet, return "null" for the url field. Do NOT guess a url like "eventbrite.com/event-name-guess".
  3. **FALLBACK:** If a specific event URL is missing, provide the URL of the venue or the main organizer's page if available
  4. **VERBATIM COPY ONLY:** You are FORBIDDEN from constructing, guessing, or predicting URLs. You must only copy-paste URLs exactly as they appear in the search result text.
  5. **NO PLACEHOLDERS:** If you find yourself typing a URL ID that looks like "123456", "000000", or "1000000000", STOP. This is a fake link. Return null instead.
  6. **platforms like Eventbrite/Luma rule:** specific IDs for these platforms are usually complex (e.g., "1976223819643"). If you don't see the full complex ID in the snippet, set "url": null.

  OUTPUT JSON FORMAT (Strictly follow this schema):
  {
    "itinerary": [
      {
        "name": "Event Name (e.g., 'Tech Founders Mixer' or 'Storytelling Workshop')",
        "type": "event",
        "category": "meetup", 
        "location": {
          "venue": "Venue Name",
          "address": "Full address",
          "city": "${city}"
        },
        "coordinates": {"lat": 0.0, "lng": 0.0},
        "start_time": "2026-01-03T18:00:00",
        "end_time": "2026-01-03T20:00:00",
        "duration_minutes": 120,
        "description": "Brief description emphasizing the hosted/group aspect.",
        "source": {
          "platform": "Luma/Eventbrite/Venue",
          "url": "https://actual-event-link.com" 
        },
        "pricing": {
          "is_free": true,
          "price": "Free",
          "currency": "USD"
        },
        "tags": ["networking", "finance", "workshop"]
      }
    ],
    "search_summary": {
      "platforms_used": ["Luma", "Eventbrite", "Museum Calendars"],
      "search_date": "${new Date().toISOString()}"
    }
  }

  CRITICAL: Output ONLY the JSON object. Start with { and end with }`;
}

/**
 * Generate itinerary using Gemini with Google Search grounding
 */
async function generateItinerary(city, interests, logger, startDate, endDate) {
  logger.log(`\n📍 Generating itinerary for "${interests}" in ${city}`);
  logger.log(`📅 Date range: ${startDate} to ${endDate}`);
  logger.data.city = city;
  logger.data.interests = interests;

  const prompt = buildEventSearchPrompt(city, interests, startDate, endDate);
  logger.logPrompt("search_and_extract", prompt);

  try {
    logger.log("🔍 Initiating Gemini search with Google grounding...");

    // Use the @google/genai SDK with Google Search tool
    // Note: responseMimeType doesn't work with googleSearch tool, so we extract JSON manually
    const response = await genAI.models.generateContent({
      model: CONFIG.geminiModel,
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0.2,
        topP: 0.8,
        maxOutputTokens: 8192,
      },
    });

    const responseText = response.text;
    console.log("📝 Raw response length:", responseText.length);
    logger.logResponse("search_and_extract", responseText);

    // Log grounding metadata if available
    if (response.candidates?.[0]?.groundingMetadata) {
      const groundingMeta = response.candidates[0].groundingMetadata;
      logger.log(
        `📊 Grounding metadata: ${JSON.stringify(groundingMeta, null, 2)}`
      );
    }

    // Extract and parse JSON from response
    const itinerary = extractJSON(responseText);
    logger.logFinalItinerary(itinerary);

    return itinerary;
  } catch (error) {
    logger.log(`❌ Error generating itinerary: ${error.message}`);
    logger.log(`Stack: ${error.stack}`);
    throw error;
  }
}

// API Routes
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    model: CONFIG.geminiModel,
    features: ["google_search_grounding"],
  });
});

app.post("/api/generate-itinerary", async (req, res) => {
  const requestId = Date.now().toString();
  const logger = new Logger(requestId);

  try {
    const { city, interests, start_date, end_date } = req.body;

    // Validate required fields
    if (!city || !interests) {
      return res.status(400).json({
        error: "city and interests are required",
        example: {
          city: "San Francisco",
          interests: "technology startups",
          start_date: "2025-02-01",
          end_date: "2025-02-03",
        },
      });
    }

    // Default to next 3 days if dates not provided
    const today = new Date();
    const defaultStart = start_date || today.toISOString().split("T")[0];
    const defaultEnd =
      end_date ||
      new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];

    logger.log(`\n📥 Request ID: ${requestId}`);
    logger.log(`📥 City: ${city}`);
    logger.log(`📥 Interests: ${interests}`);
    logger.log(`📥 Dates: ${defaultStart} to ${defaultEnd}`);

    const itinerary = await generateItinerary(
      city,
      interests,
      logger,
      defaultStart,
      defaultEnd
    );

    if (!itinerary) {
      throw new Error("Failed to generate itinerary");
    }

    // Extract itinerary array
    const itineraryArray = Array.isArray(itinerary.itinerary)
      ? itinerary.itinerary
      : Array.isArray(itinerary)
      ? itinerary
      : [];

    const response = {
      success: true,
      city,
      interests,
      date_range: {
        start: defaultStart,
        end: defaultEnd,
      },
      itinerary: itineraryArray,
      total_items: itineraryArray.length,
      events: itineraryArray.filter((i) => i.type === "event").length,
      activities: itineraryArray.filter((i) => i.type === "activity").length,
      search_summary: itinerary.search_summary || null,
      generated_at: new Date().toISOString(),
      request_id: requestId,
    };

    logger.saveAll();
    res.json(response);
  } catch (error) {
    logger.log(`❌ Error: ${error.message}`);
    logger.log(`Stack: ${error.stack}`);
    logger.saveAll();
    res.status(500).json({
      error: error.message,
      request_id: requestId,
    });
  }
});

// Start server
async function start() {
  try {
    // Test Gemini connection
    console.log("🔄 Testing Gemini API connection...");
    const testResponse = await genAI.models.generateContent({
      model: CONFIG.geminiModel,
      contents: "Hello, respond with OK",
    });
    console.log("✅ Gemini API connected successfully");

    app.listen(CONFIG.port, "0.0.0.0", () => {
      console.log("\n" + "=".repeat(60));
      console.log("🚀 Itinerary API Server Running");
      console.log("   Powered by Gemini with Google Search Grounding");
      console.log("=".repeat(60));
      console.log(`📡 Server: http://localhost:${CONFIG.port}`);
      console.log(`🤖 Model: ${CONFIG.geminiModel}`);
      console.log(`🔧 Endpoints:`);
      console.log(`   GET  /health`);
      console.log(`   POST /api/generate-itinerary`);
      console.log("=".repeat(60));
      console.log(
        "\n✅ Ready to generate itineraries with real-time search!\n"
      );
    });
  } catch (error) {
    console.error("❌ Failed to start:", error.message);
    process.exit(1);
  }
}

start();
