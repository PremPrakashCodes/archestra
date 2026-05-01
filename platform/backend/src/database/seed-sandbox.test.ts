import {
  SANDBOX_MCP_CATALOG_ID,
  SANDBOX_MCP_SERVER_NAME,
  SANDBOX_MCP_TOOL_DEFINITIONS,
} from "@shared";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import db, { schema } from "@/database";
import { AgentModel, AgentToolModel, ToolModel } from "@/models";
import { describe, expect, test } from "@/test";
import {
  backfillSandboxInstallToolAssignments,
  seedSandboxCatalog,
  seedSandboxTools,
} from "./seed";

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    ...actual,
    default: {
      ...actual.default,
      orchestrator: {
        ...actual.default.orchestrator,
        sandbox: {
          ...actual.default.orchestrator.sandbox,
          enabled: true,
          baseImage: "archestra/mcp-sandbox:dev",
          idleDefaultMinutes: 15,
        },
      },
    },
  };
});

describe("seedSandboxCatalog", () => {
  test("inserts the sandbox catalog row when the feature flag is enabled", async () => {
    await seedSandboxCatalog();

    const [row] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, SANDBOX_MCP_CATALOG_ID));

    expect(row).toBeDefined();
    expect(row.name).toBe(SANDBOX_MCP_SERVER_NAME);
    expect(row.serverType).toBe("local");

    const localConfig = row.localConfig as {
      runtimeProfile?: string;
      dockerImage?: string;
      transportType?: string;
      httpPort?: number;
      sandbox?: { idleTimeoutMinutes?: number };
    } | null;
    expect(localConfig?.runtimeProfile).toBe("sandbox");
    expect(localConfig?.dockerImage).toBe("archestra/mcp-sandbox:dev");
    expect(localConfig?.transportType).toBe("streamable-http");
    expect(localConfig?.httpPort).toBe(8080);
    expect(localConfig?.sandbox?.idleTimeoutMinutes).toBe(15);
  });

  test("re-running is a no-op (onConflictDoNothing)", async () => {
    await seedSandboxCatalog();
    await seedSandboxCatalog();

    const rows = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, SANDBOX_MCP_CATALOG_ID));
    expect(rows).toHaveLength(1);
  });
});

describe("seedSandboxTools", () => {
  test("seeds every static sandbox tool under the catalog id", async () => {
    await seedSandboxCatalog();
    await seedSandboxTools();

    const tools = await ToolModel.findByCatalogId(SANDBOX_MCP_CATALOG_ID);
    expect(tools).toHaveLength(SANDBOX_MCP_TOOL_DEFINITIONS.length);

    const expectedNames = new Set(
      SANDBOX_MCP_TOOL_DEFINITIONS.map((tool) =>
        ToolModel.slugifyName(SANDBOX_MCP_SERVER_NAME, tool.name),
      ),
    );
    expect(new Set(tools.map((t) => t.name))).toEqual(expectedNames);
  });

  test("re-running is idempotent and does not duplicate tools", async () => {
    await seedSandboxCatalog();
    await seedSandboxTools();
    await seedSandboxTools();

    const tools = await ToolModel.findByCatalogId(SANDBOX_MCP_CATALOG_ID);
    expect(tools).toHaveLength(SANDBOX_MCP_TOOL_DEFINITIONS.length);
  });
});

describe("backfillSandboxInstallToolAssignments", () => {
  test("wires sandbox tools onto pre-existing personal sandbox installs", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeMcpServer,
  }) => {
    await seedSandboxCatalog();
    await seedSandboxTools();

    const user = await makeUser();
    const org = await makeOrganization();
    await makeMember(user.id, org.id);

    const install = await makeMcpServer({
      ownerId: user.id,
      catalogId: SANDBOX_MCP_CATALOG_ID,
      scope: "personal",
    });

    await backfillSandboxInstallToolAssignments();

    const personalGateway = await AgentModel.getPersonalMcpGateway(
      user.id,
      org.id,
    );
    if (!personalGateway) throw new Error("expected personal gateway");

    const seededTools = await ToolModel.findByCatalogId(SANDBOX_MCP_CATALOG_ID);
    const assignedToolIds = await AgentToolModel.findToolIdsByAgent(
      personalGateway.id,
    );
    expect(new Set(assignedToolIds)).toEqual(
      new Set(seededTools.map((t) => t.id)),
    );

    // Re-running is a no-op (idempotent).
    await backfillSandboxInstallToolAssignments();
    const assignedAfter = await AgentToolModel.findToolIdsByAgent(
      personalGateway.id,
    );
    expect(assignedAfter.length).toBe(seededTools.length);

    // Sanity: install row still resolves to the same id.
    expect(install.catalogId).toBe(SANDBOX_MCP_CATALOG_ID);
  });
});
