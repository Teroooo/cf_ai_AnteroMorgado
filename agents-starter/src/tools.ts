/**
 * Tool definitions for the AI chat agent
 * Tools can either require human confirmation or execute automatically
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod/v3";

import type { Chat } from "./server";
import { getCurrentAgent } from "agents";
import { scheduleSchema } from "agents/schedule";

/**
 * Weather information tool that requires human confirmation
 * When invoked, this will present a confirmation dialog to the user
 */
const getWeatherInformation = tool({
  description: "Get current weather information for a specific city. Shows temperature, conditions, humidity, and wind speed.",
  inputSchema: z.object({ 
    city: z.string().describe("The city name to get weather for, e.g. 'London', 'New York', 'Tokyo'")
  })
  // Omitting execute function makes this tool require human confirmation
});

/**
 * Local time tool that executes automatically
 * Since it includes an execute function, it will run without user confirmation
 * This is suitable for low-risk operations that don't need oversight
 */
const getLocalTime = tool({
  description: "Get the current local time for a specified location or timezone",
  inputSchema: z.object({ 
    location: z.string().describe("Location or timezone, e.g. 'London', 'America/New_York', 'UTC'")
  }),
  execute: async ({ location }) => {
    console.log(`Getting local time for ${location}`);
    
    try {
      // Use a simple timezone lookup for common cities
      const timezoneMap: Record<string, string> = {
        'london': 'Europe/London',
        'new york': 'America/New_York',
        'tokyo': 'Asia/Tokyo',
        'paris': 'Europe/Paris',
        'sydney': 'Australia/Sydney',
        'los angeles': 'America/Los_Angeles',
        'chicago': 'America/Chicago',
        'mumbai': 'Asia/Kolkata',
        'dubai': 'Asia/Dubai',
        'singapore': 'Asia/Singapore',
      };
      
      const normalizedLocation = location.toLowerCase();
      const timezone = timezoneMap[normalizedLocation] || location;
      
      const now = new Date();
      const timeString = now.toLocaleString('en-US', { 
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      
      return `The current time in ${location} is: ${timeString}`;
    } catch (error) {
      return `Could not determine time for ${location}. Error: ${error}`;
    }
  }
});

const scheduleTask = tool({
  description: "A tool to schedule a task to be executed at a later time",
  inputSchema: scheduleSchema,
  execute: async ({ when, description }) => {
    // we can now read the agent context from the ALS store
    const { agent } = getCurrentAgent<Chat>();

    function throwError(msg: string): string {
      throw new Error(msg);
    }
    if (when.type === "no-schedule") {
      return "Not a valid schedule input";
    }
    const input =
      when.type === "scheduled"
        ? when.date // scheduled
        : when.type === "delayed"
          ? when.delayInSeconds // delayed
          : when.type === "cron"
            ? when.cron // cron
            : throwError("not a valid schedule input");
    try {
      agent!.schedule(input!, "executeTask", description);
    } catch (error) {
      console.error("error scheduling task", error);
      return `Error scheduling task: ${error}`;
    }
    return `Task scheduled for type "${when.type}" : ${input}`;
  }
});

/**
 * Tool to list all scheduled tasks
 * This executes automatically without requiring human confirmation
 */
const getScheduledTasks = tool({
  description: "List all tasks that have been scheduled",
  inputSchema: z.object({}),
  execute: async () => {
    const { agent } = getCurrentAgent<Chat>();

    try {
      const tasks = agent!.getSchedules();
      if (!tasks || tasks.length === 0) {
        return "No scheduled tasks found.";
      }
      return tasks;
    } catch (error) {
      console.error("Error listing scheduled tasks", error);
      return `Error listing scheduled tasks: ${error}`;
    }
  }
});

/**
 * Tool to cancel a scheduled task by its ID
 * This executes automatically without requiring human confirmation
 */
const cancelScheduledTask = tool({
  description: "Cancel a scheduled task using its ID",
  inputSchema: z.object({
    taskId: z.string().describe("The ID of the task to cancel")
  }),
  execute: async ({ taskId }) => {
    const { agent } = getCurrentAgent<Chat>();
    try {
      await agent!.cancelSchedule(taskId);
      return `Task ${taskId} has been successfully canceled.`;
    } catch (error) {
      console.error("Error canceling scheduled task", error);
      return `Error canceling task ${taskId}: ${error}`;
    }
  }
});

/**
 * Export all available tools
 * These will be provided to the AI model to describe available capabilities
 */
export const tools = {
  getWeatherInformation,
  getLocalTime,
  scheduleTask,
  getScheduledTasks,
  cancelScheduledTask
} satisfies ToolSet;

/**
 * Implementation of confirmation-required tools
 * This object contains the actual logic for tools that need human approval
 * Each function here corresponds to a tool above that doesn't have an execute function
 */
export const executions = {
  getWeatherInformation: async ({ city }: { city: string }) => {
    console.log(`Getting weather information for ${city}`);
    
    try {
      // Using Open-Meteo API (free, no API key required)
      // First, geocode the city to get coordinates
      const geoResponse = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
      );
      
      if (!geoResponse.ok) {
        return `Unable to find location data for ${city}`;
      }
      
      const geoData = await geoResponse.json() as {
        results?: Array<{
          latitude: number;
          longitude: number;
          name: string;
          country: string;
        }>;
      };
      
      if (!geoData.results || geoData.results.length === 0) {
        return `Could not find weather data for "${city}". Please check the city name and try again.`;
      }
      
      const { latitude, longitude, name, country } = geoData.results[0];
      
      // Get weather data
      const weatherResponse = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=auto`
      );
      
      if (!weatherResponse.ok) {
        return `Unable to fetch weather data for ${city}`;
      }
      
      const weatherData = await weatherResponse.json() as {
        current: {
          temperature_2m: number;
          relative_humidity_2m: number;
          apparent_temperature: number;
          precipitation: number;
          weather_code: number;
          wind_speed_10m: number;
        };
      };
      
      const current = weatherData.current;
      
      // Weather code descriptions
      const weatherDescriptions: Record<number, string> = {
        0: 'Clear sky',
        1: 'Mainly clear',
        2: 'Partly cloudy',
        3: 'Overcast',
        45: 'Foggy',
        48: 'Depositing rime fog',
        51: 'Light drizzle',
        53: 'Moderate drizzle',
        55: 'Dense drizzle',
        61: 'Slight rain',
        63: 'Moderate rain',
        65: 'Heavy rain',
        71: 'Slight snow',
        73: 'Moderate snow',
        75: 'Heavy snow',
        77: 'Snow grains',
        80: 'Slight rain showers',
        81: 'Moderate rain showers',
        82: 'Violent rain showers',
        85: 'Slight snow showers',
        86: 'Heavy snow showers',
        95: 'Thunderstorm',
        96: 'Thunderstorm with slight hail',
        99: 'Thunderstorm with heavy hail'
      };
      
      const condition = weatherDescriptions[current.weather_code] || 'Unknown';
      
      return `
**Weather in ${name}, ${country}:**

🌡️ **Temperature:** ${current.temperature_2m}°C (feels like ${current.apparent_temperature}°C)
☁️ **Conditions:** ${condition}
💧 **Humidity:** ${current.relative_humidity_2m}%
💨 **Wind Speed:** ${current.wind_speed_10m} km/h
${current.precipitation > 0 ? `🌧️ **Precipitation:** ${current.precipitation} mm` : ''}

*Data from Open-Meteo API*
      `.trim();
      
    } catch (error) {
      console.error('Weather API error:', error);
      return `Sorry, I encountered an error fetching weather data for ${city}. Please try again later.`;
    }
  }
};