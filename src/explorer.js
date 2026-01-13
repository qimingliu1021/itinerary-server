/**
 * Explorer Module - Event Link Analysis
 * Analyzes links from Scout using Gemini to extract detailed event information
 */

import { GoogleGenAI } from "@google/genai";

const CONFIG = {
  googleApiKey: process.env.GOOGLE_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",
  maxConcurrent: 3, // Process links in batches to avoid rate limits
  batchSize: 5, // Number of links to process per Gemini call
};

// Initialize Gemini client
let genAI = null;

function getGenAI() {
  if (!genAI) {
    if (!CONFIG.googleApiKey) {
      throw new Error("GOOGLE_API_KEY is required for Explorer");
    }
    genAI = new GoogleGenAI({ apiKey: CONFIG.googleApiKey });
  }
  return genAI;
}

/**
 * Build prompt for analyzing a batch of links
 * @param {Object[]} links - Array of link objects from Scout
 * @param {string} city - The city for timezone context
 * @returns {string} The analysis prompt
 */
function buildAnalysisPrompt(links, city) {
  const linksInfo = links
    .map(
      (link, i) => `
[Link ${i + 1}]
URL: ${link.url}
Title: ${link.title || "Unknown"}
Snippet: ${link.snippet || "No snippet"}
Interest: ${link.interest}
Target Date: ${link.date}
Platform: ${link.platform || "Unknown"}`
    )
    .join("\n---");

  return `You are an Expert Event Analyzer. Your task is to visit/analyze the following event links and extract detailed event information.

## LINKS TO ANALYZE:
${linksInfo}

## YOUR TASK:
For each link above, determine if it contains a VALID, SCHEDULED EVENT. Extract the event details if valid.

## STRICT EVENT CRITERIA (Must meet ALL):
1. **HOSTED/PROGRAMMED:** Must have a human host, instructor, guide, or organizer
2. **SCHEDULED:** Must have a specific start time (not just "Open 10am-6pm")
3. **NOT GENERAL ADMISSION:** Don't list venues just because they're open
4. **REAL EVENT:** Must be a meetup, workshop, class, talk, performance, networking event, etc.

## WHAT TO REJECT:
- "Timed Entry" or "General Admission" slots
- "Self-guided tours" or "Audio tours"
- Generic "Visit the museum" without a specific program
- Venue pages without specific scheduled events

## FOR EACH VALID EVENT, EXTRACT:
- name: Exact event name from the page
- type: "event" 
- category: meetup/workshop/networking/performance/tour/class/talk/other
- location: venue name, full address, city
- coordinates: lat/lng (estimate if needed)
- start_time: ISO 8601 format (e.g., "2026-01-03T18:00:00") - must match ${city} timezone
- end_time: ISO 8601 format
- duration_minutes: calculated duration
- description: Brief description of the event
- source.platform: The platform name (Eventbrite/Meetup/Luma/etc)
- source.url: The EXACT URL provided (copy verbatim, do not modify)
- pricing: is_free (boolean), price (string), currency
- tags: relevant tags for the event

## OUTPUT FORMAT (JSON only):
{
  "analyzed_links": ${links.length},
  "valid_events": [
    {
      "name": "Event Name",
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
      "description": "Brief description",
      "source": {
        "platform": "Eventbrite",
        "url": "https://exact-url-from-input.com"
      },
      "pricing": {
        "is_free": true,
        "price": "Free",
        "currency": "USD"
      },
      "tags": ["networking", "tech"],
      "interest_matched": "Technology",
      "target_date": "2026-01-03"
    }
  ],
  "rejected_links": [
    {
      "url": "https://rejected-url.com",
      "reason": "General admission only, no specific event"
    }
  ]
}

## CRITICAL RULES:
1. Output ONLY valid JSON, no markdown
2. Use the EXACT URL from the input - do not modify or construct URLs
3. If unsure about event validity, reject it
4. Times must be in ${city} local timezone
5. Start with { and end with }`;
}

/**
 * Extract JSON from response
 */
function extractJSON(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    // Continue
  }

  const codeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (e) {
      // Continue
    }
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      // Continue
    }
  }

  throw new Error("Could not extract JSON from Explorer response");
}

/**
 * Analyze a batch of links
 * @param {Object[]} links - Array of link objects
 * @param {string} city - The city
 * @param {Function} logger - Logging function
 * @returns {Promise<Object>} Analysis results
 */
async function analyzeBatch(links, city, logger) {
  const ai = getGenAI();
  const prompt = buildAnalysisPrompt(links, city);

  try {
    const response = await ai.models.generateContent({
      model: CONFIG.geminiModel,
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }], // Enable search to verify/access links
        temperature: 0.1,
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingLevel: "low" },
      },
    });

    const responseText = response.text;
    const result = extractJSON(responseText);

    return {
      success: true,
      events: result.valid_events || [],
      rejected: result.rejected_links || [],
      analyzed: result.analyzed_links || links.length,
    };
  } catch (error) {
    logger(`❌ Explorer: Batch analysis failed: ${error.message}`);
    return {
      success: false,
      events: [],
      rejected: links.map((l) => ({ url: l.url, reason: error.message })),
      error: error.message,
    };
  }
}

/**
 * Main Explorer function - analyzes all links from Scout
 * @param {Object[]} links - Array of link objects from Scout
 * @param {string} city - The city
 * @param {Function} logger - Logging function
 * @returns {Promise<Object>} All extracted events
 */
export async function exploreLinks(links, city, logger = console.log) {
  logger(`\n🔬 Explorer: Starting link analysis`);
  logger(`📊 Links to analyze: ${links.length}`);

  if (!links || links.length === 0) {
    logger(`⚠️ Explorer: No links to analyze`);
    return {
      success: true,
      events: [],
      totalAnalyzed: 0,
      totalEvents: 0,
      rejected: [],
    };
  }

  const allEvents = [];
  const allRejected = [];
  let totalAnalyzed = 0;

  // Process links in batches
  const batches = [];
  for (let i = 0; i < links.length; i += CONFIG.batchSize) {
    batches.push(links.slice(i, i + CONFIG.batchSize));
  }

  logger(
    `📦 Explorer: Processing ${batches.length} batches of ${CONFIG.batchSize} links each`
  );

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    logger(
      `\n🔍 Explorer: Analyzing batch ${i + 1}/${batches.length} (${
        batch.length
      } links)`
    );

    const result = await analyzeBatch(batch, city, logger);

    if (result.success) {
      allEvents.push(...result.events);
      allRejected.push(...result.rejected);
      totalAnalyzed += result.analyzed;
      logger(`✅ Batch ${i + 1}: Found ${result.events.length} valid events`);
    } else {
      allRejected.push(...result.rejected);
      logger(`⚠️ Batch ${i + 1}: Failed - ${result.error}`);
    }

    // Delay between batches to avoid rate limiting
    if (i < batches.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Deduplicate events by name and start_time
  const uniqueEvents = [];
  const seen = new Set();

  for (const event of allEvents) {
    const key = `${event.name}-${event.start_time}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueEvents.push(event);
    }
  }

  // Sort events by start_time
  uniqueEvents.sort((a, b) => {
    const timeA = new Date(a.start_time).getTime();
    const timeB = new Date(b.start_time).getTime();
    return timeA - timeB;
  });

  logger(`\n✅ Explorer: Completed!`);
  logger(`📊 Total links analyzed: ${totalAnalyzed}`);
  logger(`🎯 Valid events found: ${uniqueEvents.length}`);
  logger(`❌ Rejected links: ${allRejected.length}`);

  return {
    success: true,
    events: uniqueEvents,
    totalAnalyzed,
    totalEvents: uniqueEvents.length,
    rejected: allRejected,
  };
}

/**
 * Analyze a single link (for testing or individual processing)
 * @param {Object} link - Single link object
 * @param {string} city - The city
 * @param {Function} logger - Logging function
 * @returns {Promise<Object>} Analysis result
 */
export async function analyzeLink(link, city, logger = console.log) {
  return analyzeBatch([link], city, logger);
}

export default {
  exploreLinks,
  analyzeLink,
};
