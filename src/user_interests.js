/**
 * User Interests Configuration
 * Backend module for interest categories and tags used in itinerary generation
 */

// Interest categories with their associated tags
export const INTEREST_CATEGORIES = [
  {
    name: "Outdoor",
    tags: [
      "Hiking",
      "Camping",
      "Road Trips",
      "Beach",
      "Mountains",
      "National Parks",
      "Adventure Travel",
      "Backpacking",
    ],
  },
  {
    name: "Social Activities",
    tags: [
      "Networking",
      "Meetups",
      "Social Events",
      "Parties",
      "Happy Hour",
      "Clubbing",
      "Bars",
      "Dancing",
    ],
  },
  {
    name: "Hobbies and Passion",
    tags: [
      "Photography",
      "Reading",
      "Writing",
      "Crafts",
      "DIY",
      "Vintage Fashion",
      "Sneakers",
      "Collecting",
    ],
  },
  {
    name: "Sports and Fitness",
    tags: [
      "Gym",
      "Running",
      "Yoga",
      "Swimming",
      "Cycling",
      "Basketball",
      "Soccer",
      "Tennis",
      "Martial Arts",
    ],
  },
  {
    name: "Health and Wellbeing",
    tags: [
      "Meditation",
      "Wellness",
      "Spa",
      "Mental Health",
      "Nutrition",
      "Mindfulness",
      "Self-care",
    ],
  },
  {
    name: "Technology",
    tags: [
      "Coding",
      "AI",
      "Startups",
      "Tech Meetups",
      "Hackathons",
      "Gaming Tech",
      "VR",
      "Crypto",
    ],
  },
  {
    name: "Art and Culture",
    tags: [
      "Museums",
      "Art Galleries",
      "Theater",
      "Opera",
      "Ballet",
      "Film",
      "Concerts",
      "Live Music",
    ],
  },
  {
    name: "Games",
    tags: [
      "Video Games",
      "Board Games",
      "E-Sports",
      "Gaming",
      "Tabletop RPG",
      "Card Games",
      "Arcade",
    ],
  },
  {
    name: "Career and Business",
    tags: [
      "Networking",
      "Conferences",
      "Workshops",
      "Professional Development",
      "Entrepreneurship",
      "Leadership",
    ],
  },
  {
    name: "Science and Education",
    tags: [
      "Lectures",
      "Workshops",
      "Book Clubs",
      "Learning",
      "Research",
      "STEM",
      "History",
      "Language Exchange",
    ],
  },
];

/**
 * Get all available tags as a flat array
 * @returns {string[]} Array of all tags
 */
export function getAllTags() {
  const allTags = new Set();
  INTEREST_CATEGORIES.forEach((category) => {
    category.tags.forEach((tag) => allTags.add(tag));
  });
  return Array.from(allTags).sort();
}

/**
 * Get category names
 * @returns {string[]} Array of category names
 */
export function getCategoryNames() {
  return INTEREST_CATEGORIES.map((cat) => cat.name);
}

/**
 * Find which categories contain given interests
 * @param {string[]} interests - Array of interest tags
 * @returns {string[]} Array of matching category names
 */
export function findCategoriesForInterests(interests) {
  const categories = new Set();
  const interestsLower = interests.map((i) => i.toLowerCase());

  INTEREST_CATEGORIES.forEach((category) => {
    const hasMatch = category.tags.some((tag) =>
      interestsLower.includes(tag.toLowerCase())
    );
    if (hasMatch) {
      categories.add(category.name);
    }
  });

  return Array.from(categories);
}

/**
 * Validate if given interests are valid tags
 * @param {string[]} interests - Array of interest tags to validate
 * @returns {{ valid: string[], invalid: string[] }} Object with valid and invalid interests
 */
export function validateInterests(interests) {
  const allTags = getAllTags().map((t) => t.toLowerCase());
  const valid = [];
  const invalid = [];

  interests.forEach((interest) => {
    if (allTags.includes(interest.toLowerCase())) {
      valid.push(interest);
    } else {
      invalid.push(interest);
    }
  });

  return { valid, invalid };
}

/**
 * Get suggested search terms for given interests
 * Useful for enhancing Gemini search queries
 * @param {string[]} interests - Array of interest tags
 * @returns {string[]} Array of search term suggestions
 */
export function getSearchTermsForInterests(interests) {
  const searchTerms = new Set();
  const categories = findCategoriesForInterests(interests);

  // Add the interests themselves
  interests.forEach((i) => searchTerms.add(i));

  // Add related category names as context
  categories.forEach((cat) => searchTerms.add(cat));

  // Add specific event type keywords based on category
  const eventKeywords = {
    Outdoor: ["outdoor events", "nature activities", "adventure tours"],
    "Social Activities": [
      "social events",
      "networking events",
      "happy hours",
      "meetups",
    ],
    "Hobbies and Passion": [
      "hobby workshops",
      "craft classes",
      "creative events",
    ],
    "Sports and Fitness": [
      "fitness classes",
      "sports events",
      "workout sessions",
    ],
    "Health and Wellbeing": [
      "wellness events",
      "meditation sessions",
      "health workshops",
    ],
    Technology: ["tech meetups", "hackathons", "startup events", "tech talks"],
    "Art and Culture": [
      "art exhibitions",
      "cultural events",
      "museum exhibits",
      "performances",
    ],
    Games: [
      "gaming events",
      "esports",
      "board game nights",
      "gaming tournaments",
    ],
    "Career and Business": [
      "business networking",
      "professional events",
      "industry conferences",
    ],
    "Science and Education": [
      "lectures",
      "educational workshops",
      "learning events",
    ],
  };

  categories.forEach((cat) => {
    if (eventKeywords[cat]) {
      eventKeywords[cat].forEach((term) => searchTerms.add(term));
    }
  });

  return Array.from(searchTerms);
}
