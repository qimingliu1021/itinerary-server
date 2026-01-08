/**
 * Scout Module - Event Link Discovery
 * Conducts Google searches for each interest per day and returns discovered links
 */

import { GoogleGenAI } from "@google/genai";

const CONFIG = {
  googleApiKey: process.env.GOOGLE_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",
  linksPerSearch: 20,
};

// Initialize Gemini client
let genAI = null;

function getGenAI() {
  if (!genAI) {
    if (!CONFIG.googleApiKey) {
      throw new Error("GOOGLE_API_KEY is required for Scout");
    }
    genAI = new GoogleGenAI({ apiKey: CONFIG.googleApiKey });
  }
  return genAI;
}

/**
 * Generate search queries for a specific interest and date
 * @param {string} interest - The interest/topic to search
 * @param {string} city - The city to search in
 * @param {string} date - The specific date (YYYY-MM-DD)
 * @returns {string[]} Array of search queries
 */
function generateSearchQueries(interest, city, date) {
  const dateObj = new Date(date);
  const formattedDate = dateObj.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // Generate multiple query variations for better coverage
  return [
    `${interest} events in ${city} ${formattedDate}`,
    `${interest} meetup ${city} ${formattedDate}`,
    `site:eventbrite.com ${city} ${interest} ${formattedDate}`,
    `site:meetup.com ${city} ${interest}`,
    `site:lu.ma ${city} ${interest}`,
    `${interest} workshop class ${city} ${formattedDate}`,
  ];
}

/**
 * Build the prompt for Gemini to search and extract links
 * @param {string} interest - The interest being searched
 * @param {string} city - The city
 * @param {string} date - The date
 * @param {string[]} queries - The search queries to use
 * @returns {string} The prompt
 */
function buildSearchPrompt(interest, city, date, queries) {
  const dateObj = new Date(date);
  const formattedDate = dateObj.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return `You are an Event Link Scout. Your job is to search the web and find URLs/links to event pages.

## TASK:
Search for "${interest}" events happening in ${city} on ${formattedDate}.

## SEARCH STRATEGY:
Use these search queries to find events:
${queries.map((q, i) => `${i + 1}. "${q}"`).join("\n")}

Also search:
- Eventbrite, Meetup, Luma, Facebook Events for "${interest}" in ${city}
- Local venue calendars, museums, theaters if relevant
- Co-working spaces, community centers for meetups/workshops

## REQUIREMENTS:
1. Find up to ${CONFIG.linksPerSearch} unique event links
2. Only include links that appear to be actual event pages (not homepage or general search results)
3. Prioritize links from: Eventbrite, Meetup, Luma, official venue calendars
4. Include the snippet/description that shows why this link is relevant

## OUTPUT FORMAT (JSON only, no markdown):
{
  "interest": "${interest}",
  "city": "${city}",
  "date": "${date}",
  "links": [
    {
      "url": "https://actual-event-page-url.com",
      "title": "Event title from search result",
      "snippet": "Brief description/snippet from search result",
      "platform": "Eventbrite/Meetup/Luma/Venue/Other",
      "confidence": "high/medium/low"
    }
  ],
  "total_found": 15,
  "queries_used": ["query1", "query2"]
}

CRITICAL: 
- Output ONLY valid JSON, no markdown formatting
- Only include URLs that look like actual event pages, not search result pages
- If you cannot find real event links, return an empty links array
- Start with { and end with }`;
}

/**
 * Extract JSON from response that might contain extra text
 */
function extractJSON(text) {
  // Try direct parse
  try {
    return JSON.parse(text);
  } catch (e) {
    // Continue
  }

  // Try to extract from markdown code block
  const codeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (e) {
      // Continue
    }
  }

  // Try regex to find JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      // Continue
    }
  }

  throw new Error(`Could not extract JSON from Scout response`);
}

/**
 * Search for event links for a single interest on a single date
 * @param {string} interest - The interest to search
 * @param {string} city - The city
 * @param {string} date - The date (YYYY-MM-DD)
 * @param {Function} logger - Optional logging function
 * @returns {Promise<Object>} Search results with links
 */
export async function searchForInterest(
  interest,
  city,
  date,
  logger = console.log
) {
  const ai = getGenAI();
  const queries = generateSearchQueries(interest, city, date);
  const prompt = buildSearchPrompt(interest, city, date, queries);

  logger(`🔍 Scout: Searching "${interest}" events in ${city} for ${date}`);

  try {
    const response = await ai.models.generateContent({
      model: CONFIG.geminiModel,
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0.2,
        maxOutputTokens: 4096,
      },
    });

    const responseText = response.text;
    const result = extractJSON(responseText);

    logger(
      `✅ Scout: Found ${
        result.links?.length || 0
      } links for "${interest}" on ${date}`
    );

    return {
      success: true,
      interest,
      city,
      date,
      links: result.links || [],
      queries_used: result.queries_used || queries,
    };
  } catch (error) {
    logger(`❌ Scout: Error searching "${interest}": ${error.message}`);
    return {
      success: false,
      interest,
      city,
      date,
      links: [],
      error: error.message,
    };
  }
}

/**
 * Get all dates between start and end (inclusive)
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {string[]} Array of dates
 */
function getDateRange(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate);
  const end = new Date(endDate);

  while (current <= end) {
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

/**
 * Main Scout function - searches for all interests across all dates
 * @param {string} city - The city to search
 * @param {string[]} interests - Array of interests
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @param {Function} logger - Optional logging function
 * @returns {Promise<Object>} All discovered links organized by interest and date
 */
export async function scoutEvents(
  city,
  interests,
  startDate,
  endDate,
  logger = console.log
) {
  logger(`\n🔭 Scout: Starting event discovery`);
  logger(`📍 City: ${city}`);
  logger(`🎯 Interests: ${interests.join(", ")}`);
  logger(`📅 Dates: ${startDate} to ${endDate}`);

  const dates = getDateRange(startDate, endDate);
  const allResults = {
    city,
    interests,
    startDate,
    endDate,
    searchResults: [],
    allLinks: [],
    totalLinksFound: 0,
  };

  // Search for each interest on each date
  for (const interest of interests) {
    for (const date of dates) {
      const result = await searchForInterest(interest, city, date, logger);
      allResults.searchResults.push(result);

      // Collect all links with metadata
      if (result.links && result.links.length > 0) {
        result.links.forEach((link) => {
          allResults.allLinks.push({
            ...link,
            interest,
            date,
            searchedAt: new Date().toISOString(),
          });
        });
      }

      // Small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // Deduplicate links by URL
  const uniqueLinks = [];
  const seenUrls = new Set();

  for (const link of allResults.allLinks) {
    if (!seenUrls.has(link.url)) {
      seenUrls.add(link.url);
      uniqueLinks.push(link);
    }
  }

  allResults.allLinks = uniqueLinks;
  allResults.totalLinksFound = uniqueLinks.length;

  logger(
    `\n✅ Scout: Completed! Found ${allResults.totalLinksFound} unique links`
  );

  return allResults;
}

export default {
  scoutEvents,
  searchForInterest,
};
