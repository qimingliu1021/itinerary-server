/**
 * Itinerary API Server - Orchestrates Scout and Explorer
 * Uses modular architecture: Scout finds links, Explorer extracts events
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

// Import modules
import { scoutEvents } from "./scout.js";
import { exploreLinks } from "./explorer.js";
import {
  INTEREST_CATEGORIES,
  getAllTags,
  findCategoriesForInterests,
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

// Initialize Gemini AI client for edit operations
const genAI = new GoogleGenAI({ apiKey: CONFIG.googleApiKey });

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

// Logger utility
class Logger {
  constructor(requestId) {
    this.requestId = requestId;
    this.timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    // Create a subfolder for this request
    this.folderName = `request_${this.timestamp}_${requestId}`;
    this.requestDir = path.join(logsDir, this.folderName);
    if (!fs.existsSync(this.requestDir)) {
      fs.mkdirSync(this.requestDir, { recursive: true });
    }

    // File paths within the subfolder
    this.logFile = path.join(this.requestDir, "console.log");
    this.scoutFile = path.join(this.requestDir, "scout.json");
    this.explorerFile = path.join(this.requestDir, "explorer.json");
    this.itineraryFile = path.join(this.requestDir, "itinerary.json");

    // Track platforms used for search_summary
    this.platformsUsed = new Set();

    this.data = {
      city: null,
      interests: null,
      startDate: null,
      endDate: null,
    };
  }

  log(message) {
    const logEntry = `[${new Date().toISOString()}] ${message}\n`;
    console.log(message);
    fs.appendFileSync(this.logFile, logEntry);
  }

  logScoutResults(results) {
    this.log(
      `\n📊 Scout Results: ${results.totalLinksFound} unique links found`
    );

    // Save full scout results
    fs.writeFileSync(this.scoutFile, JSON.stringify(results, null, 2));
    this.log(`📁 Scout results saved to: ${this.folderName}/scout.json`);
  }

  logExplorerResults(results) {
    this.log(
      `\n📊 Explorer Results: ${results.totalEvents} valid events extracted`
    );

    // Track platforms from events
    if (results.events) {
      results.events.forEach((event) => {
        if (event.source?.platform) {
          this.platformsUsed.add(event.source.platform);
        }
      });
    }

    // Save full explorer results
    fs.writeFileSync(this.explorerFile, JSON.stringify(results, null, 2));
    this.log(`📁 Explorer results saved to: ${this.folderName}/explorer.json`);
  }

  logFinalItinerary(events) {
    this.log(`\n✅ Final itinerary generated with ${events.length} events`);

    // Clean events to match the previous format (remove interest_matched and target_date)
    const cleanedEvents = events.map((event) => {
      const { interest_matched, target_date, ...cleanEvent } = event;
      return cleanEvent;
    });

    // Build the itinerary output in the previous format
    const itineraryOutput = {
      itinerary: cleanedEvents,
      search_summary: {
        platforms_used: Array.from(this.platformsUsed),
        search_date: new Date().toISOString(),
      },
    };

    // Save itinerary JSON
    fs.writeFileSync(
      this.itineraryFile,
      JSON.stringify(itineraryOutput, null, 2)
    );
    this.log(`📁 Itinerary saved to: ${this.folderName}/itinerary.json`);
  }

  saveAll() {
    this.log(`\n📦 All logs saved to folder: ${this.folderName}`);
  }
}

/**
 * Parse interests string into array
 * @param {string} interests - Comma-separated interests
 * @returns {string[]} Array of interests
 */
function parseInterests(interests) {
  return interests
    .split(",")
    .map((i) => i.trim())
    .filter((i) => i.length > 0);
}

/**
 * Ensure minimum events per day coverage
 * @param {Object[]} events - Array of events
 * @param {string} startDate - Start date
 * @param {string} endDate - End date
 * @returns {Object} Events grouped by day with coverage info
 */
function analyzeEventCoverage(events, startDate, endDate) {
  const grouped = {};
  const current = new Date(startDate);
  const end = new Date(endDate);

  // Initialize all dates
  while (current <= end) {
    const dateStr = current.toISOString().split("T")[0];
    grouped[dateStr] = [];
    current.setDate(current.getDate() + 1);
  }

  // Group events by date
  events.forEach((event) => {
    if (event.start_time) {
      const eventDate = event.start_time.split("T")[0];
      if (grouped[eventDate]) {
        grouped[eventDate].push(event);
      }
    }
  });

  // Calculate coverage
  const coverage = {};
  Object.entries(grouped).forEach(([date, dayEvents]) => {
    coverage[date] = {
      count: dayEvents.length,
      events: dayEvents,
      hasMorning: dayEvents.some((e) => {
        const hour = parseInt(e.start_time.split("T")[1].split(":")[0]);
        return hour >= 8 && hour < 12;
      }),
      hasAfternoon: dayEvents.some((e) => {
        const hour = parseInt(e.start_time.split("T")[1].split(":")[0]);
        return hour >= 12 && hour < 17;
      }),
      hasEvening: dayEvents.some((e) => {
        const hour = parseInt(e.start_time.split("T")[1].split(":")[0]);
        return hour >= 17;
      }),
    };
  });

  return coverage;
}

/**
 * Main orchestration function - coordinates Scout and Explorer
 * @param {string} city - The city
 * @param {string[]} interests - Array of interests
 * @param {string} startDate - Start date
 * @param {string} endDate - End date
 * @param {Logger} logger - Logger instance
 * @returns {Promise<Object>} Final itinerary
 */
async function generateItinerary(city, interests, startDate, endDate, logger) {
  logger.log(`\n${"=".repeat(60)}`);
  logger.log(`🚀 Starting Itinerary Generation Pipeline`);
  logger.log(`${"=".repeat(60)}`);
  logger.log(`📍 City: ${city}`);
  logger.log(`🎯 Interests: ${interests.join(", ")}`);
  logger.log(`📅 Dates: ${startDate} to ${endDate}`);

  logger.data.city = city;
  logger.data.interests = interests;
  logger.data.startDate = startDate;
  logger.data.endDate = endDate;

  // Phase 1: Scout - Find event links
  logger.log(`\n${"─".repeat(40)}`);
  logger.log(`📡 PHASE 1: SCOUT - Finding Event Links`);
  logger.log(`${"─".repeat(40)}`);

  const scoutResults = await scoutEvents(
    city,
    interests,
    startDate,
    endDate,
    (msg) => logger.log(msg)
  );

  logger.logScoutResults(scoutResults);

  if (scoutResults.allLinks.length === 0) {
    logger.log(`⚠️ Scout found no links. Cannot proceed.`);
    return {
      success: false,
      events: [],
      message: "No event links found during search",
    };
  }

  // Phase 2: Explorer - Analyze links and extract events
  logger.log(`\n${"─".repeat(40)}`);
  logger.log(`🔬 PHASE 2: EXPLORER - Analyzing Links`);
  logger.log(`${"─".repeat(40)}`);

  const explorerResults = await exploreLinks(
    scoutResults.allLinks,
    city,
    (msg) => logger.log(msg)
  );

  logger.logExplorerResults(explorerResults);

  // Phase 3: Organize and validate events
  logger.log(`\n${"─".repeat(40)}`);
  logger.log(`📋 PHASE 3: ORGANIZING EVENTS`);
  logger.log(`${"─".repeat(40)}`);

  const events = explorerResults.events || [];

  // Sort by start_time
  events.sort((a, b) => {
    const timeA = new Date(a.start_time).getTime();
    const timeB = new Date(b.start_time).getTime();
    return timeA - timeB;
  });

  // Analyze coverage
  const coverage = analyzeEventCoverage(events, startDate, endDate);

  // Log coverage summary
  Object.entries(coverage).forEach(([date, info]) => {
    logger.log(
      `📅 ${date}: ${info.count} events (M:${info.hasMorning ? "✓" : "✗"} A:${
        info.hasAfternoon ? "✓" : "✗"
      } E:${info.hasEvening ? "✓" : "✗"})`
    );
  });

  logger.logFinalItinerary(events);

  return {
    success: true,
    events,
    coverage,
    scoutStats: {
      totalLinksFound: scoutResults.totalLinksFound,
      searchesPerformed: scoutResults.searchResults?.length || 0,
    },
    explorerStats: {
      linksAnalyzed: explorerResults.totalAnalyzed,
      eventsExtracted: explorerResults.totalEvents,
      linksRejected: explorerResults.rejected?.length || 0,
    },
  };
}

// API Routes
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    model: CONFIG.geminiModel,
    architecture: "Scout + Explorer Pipeline",
  });
});

// Get available interest categories
app.get("/api/interests", (req, res) => {
  res.json({
    success: true,
    categories: INTEREST_CATEGORIES,
    all_tags: getAllTags(),
  });
});

// Main itinerary generation endpoint
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
          city: "New York, NY",
          interests: "Technology, Networking, Art",
          start_date: "2026-01-15",
          end_date: "2026-01-17",
        },
      });
    }

    // Parse interests
    const interestArray = parseInterests(interests);
    if (interestArray.length === 0) {
      return res.status(400).json({
        error: "At least one interest is required",
      });
    }

    logger.log(`\n📥 Request ID: ${requestId}`);
    logger.log(`📥 City: ${city}`);
    logger.log(`📥 Interests: ${interestArray.join(", ")}`);
    logger.log(`📥 Dates: ${start_date} to ${end_date}`);

    // Generate itinerary
    const result = await generateItinerary(
      city,
      interestArray,
      start_date,
      end_date,
      logger
    );

    if (!result.success) {
      throw new Error(result.message || "Failed to generate itinerary");
    }

    // Build response
    const response = {
      success: true,
      city,
      interests: interestArray,
      date_range: {
        start: start_date,
        end: end_date,
      },
      itinerary: result.events,
      itinerary_by_day: result.coverage,
      total_items: result.events.length,
      events: result.events.filter((e) => e.type === "event").length,
      activities: result.events.filter((e) => e.type === "activity").length,
      pipeline_stats: {
        scout: result.scoutStats,
        explorer: result.explorerStats,
      },
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

// ============= EDIT ITINERARY ENDPOINT =============

/**
 * Edit a single activity using AI
 * @param {Object} params - Edit parameters
 * @returns {Promise<Object>} Edit result
 */
async function processEditRequest(params) {
  const { edit_request, current_activity, city, day_date, interests } = params;

  const systemPrompt = `You are an intelligent itinerary editing assistant. Your job is to help users modify their travel plans.

You MUST respond with ONLY valid JSON (no markdown, no backticks, no explanation).

## STEP 1: Classify the user's intent
First, determine what the user is trying to do:
- "edit" - User wants to modify, replace, delete, or add activities
- "issue" - User is reporting a problem (broken link, cancelled event, wrong info, sold out)
- "question" - User is asking about the activity but not requesting changes
- "unclear" - Cannot determine what the user wants

## STEP 2: Select the appropriate operation

### For "edit" intent:
1. "replace" - Replace the current activity with a new one (user wants something different)
2. "delete" - Remove the activity (user doesn't want it)
3. "update_time" - Only change the timing
4. "update_description" - Only change the description
5. "add" - Add a new activity (user wants to add something nearby/after)

### For "issue" intent:
6. "report_issue" - User reports broken link, event cancelled, wrong info, sold out, etc.
   - You MUST search for an alternative activity in ${city} when reporting issues
   - Provide a replacement suggestion unless user explicitly wants deletion

### For "question" intent:
7. "answer" - Provide helpful information about the activity

### For "unclear" intent:
8. "clarify" - Ask user for clarification with suggested actions

## RESPONSE FORMATS:

### For "replace", "add", or "report_issue" with alternative:
{
  "intent": "edit|issue",
  "operation": "replace|add|report_issue",
  "issue_type": "broken_link|event_cancelled|wrong_info|sold_out|unavailable",  // Only for report_issue
  "updated_activity": {
    "name": "Place Name",
    "location": "Full address in ${city}",
    "coordinates": { "lat": number, "lng": number },
    "start_time": "ISO datetime",
    "end_time": "ISO datetime",
    "description": "Description of the place",
    "type": "activity|restaurant|attraction|event",
    "tags": ["tag1", "tag2"],
    "source": { "url": "link if available", "platform": "source" }
  },
  "new_activity": { ... },  // Only for "add" operation
  "change_summary": "Brief description of what changed"
}

### For "delete":
{
  "intent": "edit",
  "operation": "delete",
  "change_summary": "Removed X from itinerary"
}

### For "update_time":
{
  "intent": "edit",
  "operation": "update_time",
  "updated_activity": {
    "start_time": "new ISO datetime",
    "end_time": "new ISO datetime"
  },
  "change_summary": "Changed time to X"
}

### For "clarify" (when request is unclear):
{
  "intent": "unclear",
  "operation": "clarify",
  "message": "I'm not sure what you'd like to change. Could you clarify?",
  "suggested_actions": ["replace with similar activity", "change the time", "remove it", "find alternative"]
}

### For "answer" (user asking a question):
{
  "intent": "question",
  "operation": "answer",
  "message": "Answer to the user's question about the activity",
  "follow_up": "Would you like me to make any changes to this activity?"
}

## IMPORTANT RULES:
- For "replace", "add", or "report_issue": Use REAL places that exist in ${city}
- For "report_issue": ALWAYS search and suggest an alternative unless user wants deletion
- Provide realistic coordinates (latitude/longitude for ${city})
- Use appropriate timing based on the activity type
- Include detailed descriptions
- If the event source URL is broken, find a working alternative`;

  const userPrompt = `City: ${city}
Date: ${day_date}
User interests: ${interests?.join(", ") || "general"}

Current activity:
${JSON.stringify(current_activity, null, 2)}

User's edit request: "${edit_request}"

Provide the appropriate edit response as JSON.`;

  try {
    const response = await genAI.models.generateContent({
      model: CONFIG.geminiModel,
      contents: systemPrompt + "\n\n" + userPrompt,
      config: {
        tools: [{ googleSearch: {} }],  // Enable search to verify links and find alternatives
        temperature: 0.3,
        maxOutputTokens: 4096,
      },
    });

    // Get text from response
    let text = response.text;
    if (!text && response.candidates?.[0]?.content?.parts?.[0]?.text) {
      text = response.candidates[0].content.parts[0].text;
    }
    
    if (!text) {
      console.error("Empty response from model:", response.candidates?.[0]);
      throw new Error("AI model returned empty response. Please try again.");
    }

    // Parse JSON from response
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Try to extract from markdown code block
      const codeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
      if (codeBlockMatch && codeBlockMatch[1]) {
        try {
          parsed = JSON.parse(codeBlockMatch[1].trim());
        } catch (e) {
          // Continue to next method
        }
      }
      
      // Try to extract JSON if model added extra text
      if (!parsed) {
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start >= 0 && end > start) {
          try {
            parsed = JSON.parse(text.slice(start, end + 1));
          } catch (e) {
            console.error("JSON parse error:", e.message);
            throw new Error("Model did not return valid JSON: " + text.substring(0, 200));
          }
        } else {
          throw new Error("No JSON found in response: " + text.substring(0, 200));
        }
      }
    }

    return parsed;
  } catch (error) {
    console.error("AI processing error:", error);
    throw error;
  }
}

// Edit itinerary endpoint
app.post("/api/edit-itinerary", async (req, res) => {
  const requestId = Date.now().toString();

  try {
    const { edit_request, current_activity, city, day_date, interests } =
      req.body;

    // Validate required fields
    if (!edit_request || !current_activity) {
      return res.status(400).json({
        error: "edit_request and current_activity are required",
        example: {
          edit_request: "Change this to a coffee shop nearby",
          current_activity: {
            name: "Museum of Modern Art",
            location: "123 Main St",
            coordinates: { lat: 37.78, lng: -122.41 },
            start_time: "2026-01-15T10:00:00",
            end_time: "2026-01-15T12:00:00",
            description: "Art museum",
          },
          city: "San Francisco",
          day_date: "2026-01-15",
          interests: ["art", "food"],
        },
      });
    }

    console.log(`\n📝 Edit Request [${requestId}]`);
    console.log(`   City: ${city}`);
    console.log(`   Edit: "${edit_request}"`);
    console.log(`   Activity: ${current_activity.name}`);

    // Process edit with AI
    const editResult = await processEditRequest({
      edit_request,
      current_activity,
      city: city || "Unknown City",
      day_date: day_date || new Date().toISOString().split("T")[0],
      interests: interests || [],
    });

    console.log(`✅ Edit processed: ${editResult.operation}`);
    console.log(`   Summary: ${editResult.change_summary}`);

    res.json({
      success: true,
      ...editResult,
      request_id: requestId,
      processed_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`❌ Edit Error [${requestId}]:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      request_id: requestId,
    });
  }
});

// Start server
async function start() {
  try {
    console.log("🔄 Validating configuration...");

    if (!CONFIG.googleApiKey) {
      throw new Error("GOOGLE_API_KEY is not set");
    }

    console.log("✅ Configuration valid");

    app.listen(CONFIG.port, "0.0.0.0", () => {
      console.log("\n" + "=".repeat(60));
      console.log("🚀 Itinerary API Server Running");
      console.log("   Architecture: Scout + Explorer Pipeline");
      console.log("=".repeat(60));
      console.log(`📡 Server: http://localhost:${CONFIG.port}`);
      console.log(`🤖 Model: ${CONFIG.geminiModel}`);
      console.log(`🔧 Endpoints:`);
      console.log(`   GET  /health`);
      console.log(`   GET  /api/interests`);
      console.log(`   POST /api/generate-itinerary`);
      console.log(`   POST /api/edit-itinerary`);
      console.log("=".repeat(60));
      console.log(`\n📋 Pipeline Flow:`);
      console.log(`   1. Scout  → Search for event links per interest/day`);
      console.log(`   2. Explorer → Analyze links, extract event details`);
      console.log(`   3. Organize → Sort and group events by day`);
      console.log("=".repeat(60));
      console.log("\n✅ Ready to generate itineraries!\n");
    });
  } catch (error) {
    console.error("❌ Failed to start:", error.message);
    process.exit(1);
  }
}

start();
