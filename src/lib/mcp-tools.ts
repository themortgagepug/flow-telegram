import { z, ZodTypeAny } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { TOOLS } from "./tools";
import { handleToolCall } from "./tool-handlers";

type ZodRawShape = Record<string, ZodTypeAny>;

type JsonSchemaProp = {
  type?: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
  items?: JsonSchemaProp;
};

// Convert JSON Schema properties into a zod raw shape
function jsonSchemaToZodShape(
  props: Record<string, JsonSchemaProp>,
  required: string[]
): ZodRawShape {
  const shape: ZodRawShape = {};
  for (const [key, prop] of Object.entries(props)) {
    let schema: ZodTypeAny;
    switch (prop.type) {
      case "string":
        schema = prop.enum && prop.enum.length > 0
          ? z.enum(prop.enum as [string, ...string[]])
          : z.string();
        break;
      case "number":
      case "integer":
        schema = z.number();
        break;
      case "boolean":
        schema = z.boolean();
        break;
      case "array":
        schema = z.array(z.any());
        break;
      case "object":
        schema = z.object(
          jsonSchemaToZodShape(prop.properties || {}, prop.required || [])
        );
        break;
      default:
        schema = z.any();
    }
    if (prop.description) schema = schema.describe(prop.description);
    if (!required.includes(key)) schema = schema.optional();
    shape[key] = schema;
  }
  return shape;
}

// Build MCP tool definitions from existing TOOLS array
const mcpTools = TOOLS.map((t) => {
  const schemaShape = jsonSchemaToZodShape(
    t.input_schema.properties as Record<string, JsonSchemaProp>,
    (t.input_schema.required as string[]) || []
  );
  return tool(
    t.name,
    t.description,
    schemaShape,
    async (args) => {
      try {
        const result = await handleToolCall(t.name, args as Record<string, unknown>);
        return {
          content: [{ type: "text" as const, text: result }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }
  );
});

export const flowMcpServer = createSdkMcpServer({
  name: "flow-tools",
  version: "1.0.0",
  tools: mcpTools,
});

// Export tool names for allowedTools config
export const flowToolNames = TOOLS.map((t) => `mcp__flow-tools__${t.name}`);
