/**
 * Planner Module - Event Organization Utilities
 * Provides helper functions for sorting, grouping, and optimizing itineraries
 *
 * Note: Core functionality is handled in api_server.js
 * This module provides additional utilities for future enhancements
 */

/**
 * Sort events chronologically by start_time
 * @param {Object[]} events - Array of events
 * @returns {Object[]} Sorted events
 */
export function sortByTime(events) {
  return [...events].sort((a, b) => {
    const timeA = new Date(a.start_time).getTime();
    const timeB = new Date(b.start_time).getTime();
    return timeA - timeB;
  });
}

/**
 * Group events by date
 * @param {Object[]} events - Array of events
 * @returns {Object} Events grouped by date (YYYY-MM-DD keys)
 */
export function groupByDate(events) {
  return events.reduce((acc, event) => {
    if (event.start_time) {
      const date = event.start_time.split("T")[0];
      if (!acc[date]) acc[date] = [];
      acc[date].push(event);
    }
    return acc;
  }, {});
}

/**
 * Group events by interest/category
 * @param {Object[]} events - Array of events
 * @returns {Object} Events grouped by category
 */
export function groupByCategory(events) {
  return events.reduce((acc, event) => {
    const category = event.category || "other";
    if (!acc[category]) acc[category] = [];
    acc[category].push(event);
    return acc;
  }, {});
}

/**
 * Remove duplicate events based on name and start_time
 * @param {Object[]} events - Array of events
 * @returns {Object[]} Deduplicated events
 */
export function removeDuplicates(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = `${event.name}-${event.start_time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Filter events by date range
 * @param {Object[]} events - Array of events
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {Object[]} Filtered events
 */
export function filterByDateRange(events, startDate, endDate) {
  const start = new Date(startDate).getTime();
  const end = new Date(endDate + "T23:59:59").getTime();

  return events.filter((event) => {
    if (!event.start_time) return false;
    const eventTime = new Date(event.start_time).getTime();
    return eventTime >= start && eventTime <= end;
  });
}

/**
 * Analyze schedule gaps for a single day
 * @param {Object[]} dayEvents - Events for a single day (sorted by time)
 * @returns {Object[]} Array of gap objects {start, end, duration_minutes}
 */
export function findScheduleGaps(dayEvents) {
  if (dayEvents.length < 2) return [];

  const gaps = [];
  const sorted = sortByTime(dayEvents);

  for (let i = 0; i < sorted.length - 1; i++) {
    const currentEnd = new Date(sorted[i].end_time);
    const nextStart = new Date(sorted[i + 1].start_time);
    const gapMinutes = (nextStart - currentEnd) / (1000 * 60);

    if (gapMinutes > 60) {
      // Gap > 1 hour
      gaps.push({
        after_event: sorted[i].name,
        before_event: sorted[i + 1].name,
        start: sorted[i].end_time,
        end: sorted[i + 1].start_time,
        duration_minutes: gapMinutes,
      });
    }
  }

  return gaps;
}

/**
 * Get time-of-day distribution for events
 * @param {Object[]} events - Array of events
 * @returns {Object} Distribution {morning, afternoon, evening, night}
 */
export function getTimeDistribution(events) {
  const distribution = {
    morning: [], // 6am - 12pm
    afternoon: [], // 12pm - 5pm
    evening: [], // 5pm - 9pm
    night: [], // 9pm - 6am
  };

  events.forEach((event) => {
    if (!event.start_time) return;
    const hour = parseInt(event.start_time.split("T")[1].split(":")[0]);

    if (hour >= 6 && hour < 12) {
      distribution.morning.push(event);
    } else if (hour >= 12 && hour < 17) {
      distribution.afternoon.push(event);
    } else if (hour >= 17 && hour < 21) {
      distribution.evening.push(event);
    } else {
      distribution.night.push(event);
    }
  });

  return distribution;
}

/**
 * Calculate total duration of events
 * @param {Object[]} events - Array of events
 * @returns {number} Total duration in minutes
 */
export function calculateTotalDuration(events) {
  return events.reduce((total, event) => {
    return total + (event.duration_minutes || 0);
  }, 0);
}

/**
 * Format itinerary for display
 * @param {Object[]} events - Array of events
 * @returns {string} Formatted string
 */
export function formatItinerary(events) {
  const grouped = groupByDate(events);
  let output = "";

  Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([date, dayEvents]) => {
      const dateObj = new Date(date);
      const formatted = dateObj.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      });

      output += `\n📅 ${formatted}\n`;
      output += "─".repeat(40) + "\n";

      sortByTime(dayEvents).forEach((event) => {
        const time = event.start_time.split("T")[1].substring(0, 5);
        output += `  ${time} - ${event.name}\n`;
        output += `         📍 ${event.location?.venue || "TBD"}\n`;
      });
    });

  return output;
}

export default {
  sortByTime,
  groupByDate,
  groupByCategory,
  removeDuplicates,
  filterByDateRange,
  findScheduleGaps,
  getTimeDistribution,
  calculateTotalDuration,
  formatItinerary,
};
