/**
 * Edit Itinerary Module - AI-powered itinerary editing
 * Handles individual activity modifications using Gemini AI
 */

import { GoogleGenAI } from "@google/genai";

const CONFIG = {
  googleApiKey: process.env.GOOGLE_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",
};

// Initialize Gemini AI client
let genAI = null;

function getGenAI() {
  if (!genAI) {
    if (!CONFIG.googleApiKey) {
      throw new Error("GOOGLE_API_KEY is required for edit operations");
    }
    genAI = new GoogleGenAI({ apiKey: CONFIG.googleApiKey });
  }
  return genAI;
}

/**
 * Edit a single activity using AI
 * @param {Object} params - Edit parameters
 * @param {string} params.edit_request - User's edit request
 * @param {Object} params.current_activity - Current activity to edit
 * @param {string} params.city - City name
 * @param {string} params.day_date - Date of the activity
 * @param {string[]} params.interests - User interests
 * @returns {Promise<Object>} Edit result
 */
export async function processEditRequest(params) {
  const { edit_request, current_activity, city, day_date, interests } = params;

  const systemPrompt = `You are an itinerary editing assistant. Your job is to help users modify their travel plans.

You MUST respond with ONLY valid JSON (no markdown, no backticks, no explanation).

Based on the user's request, determine the appropriate operation and provide the result.

Operations:
1. "replace" - Replace the current activity with a new one (user wants something different)
2. "delete" - Remove the activity (user doesn't want it)
3. "update_time" - Only change the timing
4. "update_description" - Only change the description
5. "add" - Add a new activity (user wants to add something nearby/after)

For "replace" or "add" operations, you must provide realistic details:
- Real place names that exist in ${city}
- Realistic coordinates (latitude/longitude for ${city})
- Appropriate timing based on the activity type
- Detailed description

Response format:
{
  "operation": "replace|delete|update_time|update_description|add",
  "updated_activity": {
    "name": "Place Name",
    "location": "Full address",
    "coordinates": { "lat": number, "lng": number },
    "start_time": "ISO datetime",
    "end_time": "ISO datetime",
    "description": "Description of the place",
    "type": "activity|restaurant|attraction",
    "tags": ["tag1", "tag2"]
  },
  "new_activity": { ... },  // Only for "add" operation
  "change_summary": "Brief description of what changed"
}

For "delete" operation, only include:
{
  "operation": "delete",
  "change_summary": "Removed X from itinerary"
}

For "update_time" operation:
{
  "operation": "update_time",
  "updated_activity": {
    "start_time": "new ISO datetime",
    "end_time": "new ISO datetime"
  },
  "change_summary": "Changed time to X"
}`;

  const userPrompt = `City: ${city}
Date: ${day_date}
User interests: ${interests?.join(", ") || "general"}

Current activity:
${JSON.stringify(current_activity, null, 2)}

User's edit request: "${edit_request}"

Provide the appropriate edit response as JSON.`;

  try {
    const ai = getGenAI();
    const response = await ai.models.generateContent({
      model: CONFIG.geminiModel,
      contents: systemPrompt + "\n\n" + userPrompt,
      config: {
        temperature: 0.3,
        maxOutputTokens: 2048,
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
            throw new Error(
              "Model did not return valid JSON: " + text.substring(0, 200)
            );
          }
        } else {
          throw new Error(
            "No JSON found in response: " + text.substring(0, 200)
          );
        }
      }
    }

    return parsed;
  } catch (error) {
    console.error("AI processing error:", error);
    throw error;
  }
}

export default {
  processEditRequest,
};
