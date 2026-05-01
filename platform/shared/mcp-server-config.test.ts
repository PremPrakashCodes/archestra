import { describe, expect, it } from "vitest";
import { LocalConfigSchema, OAuthConfigSchema } from "./mcp-server-config";

describe("OAuthConfigSchema", () => {
  const baseOAuthConfig = {
    name: "Direct OAuth MCP",
    server_url: "https://mcp.example.com",
    client_id: "client-id",
    redirect_uris: ["https://app.example.com/oauth-callback"],
    scopes: ["read"],
    default_scopes: ["read", "write"],
    supports_resource_metadata: false,
  };

  it("accepts explicit authorization and token endpoints when both are set", () => {
    expect(() =>
      OAuthConfigSchema.parse({
        ...baseOAuthConfig,
        authorization_endpoint:
          "https://legacy-idp.example.com/oauth/authorize",
        token_endpoint: "https://legacy-idp.example.com/oauth/token",
      }),
    ).not.toThrow();
  });

  it("rejects configs where only one explicit endpoint is set", () => {
    expect(() =>
      OAuthConfigSchema.parse({
        ...baseOAuthConfig,
        authorization_endpoint:
          "https://legacy-idp.example.com/oauth/authorize",
      }),
    ).toThrow("authorization_endpoint and token_endpoint must be set together");
  });

  it("accepts client credentials configs without redirect URIs", () => {
    expect(() =>
      OAuthConfigSchema.parse({
        ...baseOAuthConfig,
        grant_type: "client_credentials",
        redirect_uris: [],
        token_endpoint: "https://legacy-idp.example.com/oauth/token",
      }),
    ).not.toThrow();
  });
});

describe("LocalConfigSchema", () => {
  it("accepts a legacy mcp config with command and no runtimeProfile", () => {
    const parsed = LocalConfigSchema.parse({
      command: "node",
      arguments: ["server.js"],
    });
    // No default applied — `runtimeProfile === undefined` is treated as 'mcp' by callers.
    expect(parsed.runtimeProfile).toBeUndefined();
    expect(parsed.sandbox).toBeUndefined();
  });

  it("accepts a sandbox config with dockerImage and no command", () => {
    expect(() =>
      LocalConfigSchema.parse({
        runtimeProfile: "sandbox",
        dockerImage: "registry.example.com/mcp-server-sandbox:latest",
        sandbox: {
          idleTimeoutMinutes: 15,
          pvcSizeGiB: 10,
          ttyPort: 7681,
        },
      }),
    ).not.toThrow();
  });

  it("fills in sandbox defaults when omitted", () => {
    const parsed = LocalConfigSchema.parse({
      runtimeProfile: "sandbox",
      dockerImage: "registry.example.com/mcp-server-sandbox:latest",
      sandbox: {},
    });
    expect(parsed.sandbox?.idleTimeoutMinutes).toBe(15);
    expect(parsed.sandbox?.pvcSizeGiB).toBe(10);
    expect(parsed.sandbox?.ttyPort).toBe(7681);
  });

  it("rejects a sandbox block when runtimeProfile is the default mcp", () => {
    expect(() =>
      LocalConfigSchema.parse({
        command: "node",
        sandbox: { idleTimeoutMinutes: 15, pvcSizeGiB: 10, ttyPort: 7681 },
      }),
    ).toThrow(/sandbox config is only valid when runtimeProfile is 'sandbox'/);
  });

  it("rejects a sandbox block when runtimeProfile is explicitly mcp", () => {
    expect(() =>
      LocalConfigSchema.parse({
        runtimeProfile: "mcp",
        command: "node",
        sandbox: { idleTimeoutMinutes: 15, pvcSizeGiB: 10, ttyPort: 7681 },
      }),
    ).toThrow(/sandbox config is only valid when runtimeProfile is 'sandbox'/);
  });

  it("still requires command or dockerImage", () => {
    expect(() => LocalConfigSchema.parse({})).toThrow(
      /Either command or dockerImage must be provided/,
    );
  });

  it("rejects non-positive idleTimeoutMinutes", () => {
    expect(() =>
      LocalConfigSchema.parse({
        runtimeProfile: "sandbox",
        dockerImage: "img",
        sandbox: { idleTimeoutMinutes: 0, pvcSizeGiB: 10, ttyPort: 7681 },
      }),
    ).toThrow();
  });
});
