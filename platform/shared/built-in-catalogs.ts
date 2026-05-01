import { ARCHESTRA_MCP_CATALOG_ID } from "./archestra-mcp-server";
import { SANDBOX_MCP_CATALOG_ID } from "./mcp-sandbox";
import { PLAYWRIGHT_MCP_CATALOG_ID } from "./playwright-browser";

/**
 * Set of all built-in MCP catalog item IDs that are system-managed
 * and should not be modified or deleted by users.
 */
export const BUILT_IN_CATALOG_IDS = new Set([
  ARCHESTRA_MCP_CATALOG_ID,
  PLAYWRIGHT_MCP_CATALOG_ID,
  SANDBOX_MCP_CATALOG_ID,
]);

export function isBuiltInCatalogId(id: string): boolean {
  return BUILT_IN_CATALOG_IDS.has(id);
}
