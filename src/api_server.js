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

// Import modules
import { scoutEvents } from "./scout.js";
import { exploreLinks } from "./explorer.js";
import { processEditRequest } from "./edit_itinerary.js";
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

// Streaming itinerary generation endpoint (SSE)
app.post("/api/generate-itinerary-stream", async (req, res) => {
  const requestId = Date.now().toString();
  const logger = new Logger(requestId);

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Helper to send SSE events
  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  // Send initial connection confirmation
  sendEvent("connected", { message: "Stream connected", requestId });

  try {
    const { city, interests, start_date, end_date } = req.body;

    // Validate required fields
    if (!city || !interests) {
      sendEvent("error", { message: "city and interests are required" });
      res.end();
      return;
    }

    const interestArray = parseInterests(interests);
    if (interestArray.length === 0) {
      sendEvent("error", { message: "At least one interest is required" });
      res.end();
      return;
    }

    sendEvent("progress", {
      phase: "start",
      message: `Planning your ${city} adventure...`,
      detail: `Looking for ${interestArray.join(", ")} experiences`,
    });

    // Store request info
    logger.data.city = city;
    logger.data.interests = interestArray;
    logger.data.startDate = start_date;
    logger.data.endDate = end_date;

    // Phase 1: Scout
    sendEvent("progress", {
      phase: "scout",
      message: "Discovering events and activities...",
      detail: "Searching multiple sources",
    });

    let scoutProgress = 0;
    const scoutResults = await scoutEvents(
      city,
      interestArray,
      start_date,
      end_date,
      (msg) => {
        logger.log(msg);
        // Parse scout progress and send updates
        if (msg.includes("Searching")) {
          scoutProgress++;
          const match = msg.match(/"([^"]+)"/);
          const interest = match ? match[1] : "events";
          sendEvent("progress", {
            phase: "scout",
            message: `Searching for ${interest}...`,
            detail: msg.replace(/^[^\s]+\s/, ""),
          });
        } else if (msg.includes("Found")) {
          const match = msg.match(/Found (\d+) links/);
          if (match) {
            sendEvent("progress", {
              phase: "scout",
              message: `Found ${match[1]} potential matches`,
              detail: msg.replace(/^[^\s]+\s/, ""),
            });
          }
        }
      }
    );

    logger.logScoutResults(scoutResults);

    if (scoutResults.allLinks.length === 0) {
      sendEvent("error", { message: "No events found for your interests" });
      res.end();
      return;
    }

    sendEvent("progress", {
      phase: "scout_complete",
      message: `Found ${scoutResults.totalLinksFound} potential events!`,
      detail: "Now analyzing each one...",
    });

    // Phase 2: Explorer
    sendEvent("progress", {
      phase: "explorer",
      message: "Analyzing events...",
      detail: `Processing ${scoutResults.allLinks.length} sources`,
    });

    let batchCount = 0;
    const explorerResults = await exploreLinks(
      scoutResults.allLinks,
      city,
      (msg) => {
        logger.log(msg);
        // Parse explorer progress
        if (msg.includes("batch")) {
          const match = msg.match(/batch (\d+)\/(\d+)/);
          if (match) {
            batchCount++;
            const percent = Math.round(
              (parseInt(match[1]) / parseInt(match[2])) * 100
            );
            sendEvent("progress", {
              phase: "explorer",
              message: `Analyzing events... ${percent}%`,
              detail: `Processing batch ${match[1]} of ${match[2]}`,
              percent,
            });
          }
        } else if (msg.includes("Found") && msg.includes("valid")) {
          const match = msg.match(/Found (\d+) valid/);
          if (match) {
            sendEvent("progress", {
              phase: "explorer",
              message: `Verified ${match[1]} events`,
              detail: "Extracting details...",
            });
          }
        }
      }
    );

    logger.logExplorerResults(explorerResults);

    // Phase 3: Organize
    sendEvent("progress", {
      phase: "organize",
      message: "Organizing your itinerary...",
      detail: "Creating your personalized schedule",
    });

    const events = explorerResults.events || [];
    events.sort(
      (a, b) =>
        new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
    );

    const coverage = analyzeEventCoverage(events, start_date, end_date);
    logger.logFinalItinerary(events);

    // Send final result
    const response = {
      success: true,
      city,
      interests: interestArray,
      date_range: { start: start_date, end: end_date },
      itinerary: events,
      itinerary_by_day: coverage,
      total_items: events.length,
      events: events.filter((e) => e.type === "event").length,
      activities: events.filter((e) => e.type === "activity").length,
      pipeline_stats: {
        scout: {
          totalLinksFound: scoutResults.totalLinksFound,
          searchesPerformed: scoutResults.searchResults?.length || 0,
        },
        explorer: {
          linksAnalyzed: explorerResults.totalAnalyzed,
          eventsExtracted: explorerResults.totalEvents,
          linksRejected: explorerResults.rejected?.length || 0,
        },
      },
      generated_at: new Date().toISOString(),
      request_id: requestId,
    };

    sendEvent("complete", { message: "Itinerary ready!", data: response });
    logger.saveAll();
    res.end();
  } catch (error) {
    logger.log(`❌ Error: ${error.message}`);
    logger.saveAll();
    sendEvent("error", { message: error.message });
    res.end();
  }
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
