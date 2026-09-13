import { DynamicStructuredTool } from '@langchain/core/tools';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';
import type { MCPTool } from './types.js';
import type { MCPServerManager } from './manager.js';

/** Preserve original JSON Schema, including unions, enums and local references. */
export function convertMCPToolToLangChain(serverName: string, mcpTool: MCPTool, manager: MCPServerManager): DynamicStructuredTool {
  const schema = mcpTool.inputSchema;
  const Validator = String(schema.$schema ?? '').includes('2020-12') ? Ajv2020 : Ajv;
  const validator = new Validator({ allErrors: true, strict: false, validateFormats: false });
  const validate = validator.compile(schema);
  const rawName = `mcp_${serverName}_${mcpTool.name}`;
  const name = /^[a-zA-Z0-9_-]{1,64}$/.test(rawName) ? rawName
    : `${rawName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 47)}_${createHash('sha256').update(rawName).digest('hex').slice(0, 16)}`;
  return new DynamicStructuredTool({ name,
    description: mcpTool.description || `MCP tool: ${mcpTool.name} from ${serverName}`,
    schema,
    func: async (input, _run, config) => {
      config?.signal?.throwIfAborted();
      if (!validate(input)) throw new Error(`MCP argument validation failed: ${validator.errorsText(validate.errors)}`);
      const result = await manager.callTool(serverName, mcpTool.name, input, config?.signal);
      if (result.isError) throw new Error(`MCP server reported failure: ${JSON.stringify(result.content)}`);
      return result.content.every((c: { type: string }) => c.type === 'text')
        ? result.content.map((c: { text?: string }) => c.text ?? '').join('\n') : JSON.stringify(result.content);
    },
  });
}
export async function loadMCPTools(manager: MCPServerManager): Promise<DynamicStructuredTool[]> {
  return (await manager.getAllTools()).map(({ serverName, tool }) => convertMCPToolToLangChain(serverName, tool, manager));
}
