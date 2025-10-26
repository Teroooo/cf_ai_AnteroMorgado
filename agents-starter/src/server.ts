import { routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt } from "agents/schedule";
import { AIChatAgent } from "agents/ai-chat-agent";
import {
  generateId,
  streamText,
  type StreamTextOnFinishCallback,
  stepCountIs,
  createUIMessageStream,
  convertToModelMessages,
  createUIMessageStreamResponse,
  type ToolSet
} from "ai";
import { createWorkersAI } from 'workers-ai-provider';
import { processToolCalls, cleanupMessages } from "./utils";
import { tools, executions } from "./tools";

/**
 * Chat Agent implementation that handles real-time AI chat interactions
 */
export class Chat extends AIChatAgent<Env> {
  /**
   * Handles incoming chat messages and manages the response stream
   */
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    _options?: { abortSignal?: AbortSignal }
  ) {
    // Create Workers AI provider with the AI binding from env
    const workersai = createWorkersAI({ binding: this.env.AI });
    
    // Using Llama 3.1 70B - Most powerful available model
    // Alternative models:
    // '@cf/meta/llama-3.1-70b-instruct' - Most powerful (recommended)
    // '@cf/meta/llama-3.1-8b-instruct' - Faster, smaller
    // '@cf/meta/llama-3-8b-instruct' - Original Llama 3
    const model = workersai('@cf/meta/llama-3-8b-instruct');

    // Collect all tools, including MCP tools
    const allTools = {
      ...tools,
      ...this.mcp.getAITools()
    };

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        // Clean up incomplete tool calls to prevent API errors
        const cleanedMessages = cleanupMessages(this.messages);

        // Process any pending tool calls from previous messages
        // This handles human-in-the-loop confirmations for tools
        const processedMessages = await processToolCalls({
          messages: cleanedMessages,
          dataStream: writer,
          tools: allTools,
          executions
        });

        const result = streamText({
          system: `You are a helpful AI assistant with access to real-time tools and data.

IMPORTANT: You have direct access to weather data and time information through your tools. You are NOT just a scheduling assistant - you can get weather and time information.

${getSchedulePrompt({ date: new Date() })}

AVAILABLE TOOLS - USE THESE WHEN APPROPRIATE:

1. getWeatherInformation(city: string)
   - Use this when users ask about weather, temperature, or conditions
   - Example: "What's the weather in London?" → Call getWeatherInformation with city="London"
   - You HAVE access to real weather data - use this tool!

2. getLocalTime(location: string)
   - Use this when users ask about time in a location
   - Example: "What time is it in Tokyo?" → Call getLocalTime with location="Tokyo"

3. scheduleTask(when, description)
   - Use this to schedule future tasks
   - Supports cron expressions, delays, and specific dates

4. getScheduledTasks()
   - Lists all scheduled tasks

5. cancelScheduledTask(taskId: string)
   - Cancels a scheduled task

CRITICAL: When a user asks about weather, you MUST use the getWeatherInformation tool. Do not say you don't have access to weather data or suggest external websites. You have this capability built-in. NEVER make up weather data - always use the tool.

Be helpful and proactive in using your tools.`,
          messages: convertToModelMessages(processedMessages),
          model,
          tools: allTools,
          // Type boundary: streamText expects specific tool types, but base class uses ToolSet
          // This is safe because our tools satisfy ToolSet interface (verified by 'satisfies' in tools.ts)
          onFinish: onFinish as unknown as StreamTextOnFinishCallback<
            typeof allTools
          >,
          stopWhen: stepCountIs(10)
        });

        writer.merge(result.toUIMessageStream());
      }
    });

    return createUIMessageStreamResponse({ stream });
  }

  async executeTask(description: string, _task: Schedule<string>) {
    await this.saveMessages([
      ...this.messages,
      {
        id: generateId(),
        role: "user",
        parts: [
          {
            type: "text",
            text: `Running scheduled task: ${description}`
          }
        ],
        metadata: {
          createdAt: new Date()
        }
      }
    ]);
  }
}

/**
 * Worker entry point that routes incoming requests to the appropriate handler
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Health check endpoint for AI binding
    if (url.pathname === "/check-ai-binding") {
      const hasAIBinding = !!env.AI;
      return Response.json({
        success: hasAIBinding,
        message: hasAIBinding 
          ? "Workers AI is configured and ready" 
          : "AI binding is missing - add [ai] binding in wrangler.toml"
      });
    }

    if (!env.AI) {
      console.error(
        "AI binding is not configured. Add the following to your wrangler.toml:\n\n[ai]\nbinding = \"AI\""
      );
    }

    return (
      // Route the request to our agent or return 404 if not found
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;