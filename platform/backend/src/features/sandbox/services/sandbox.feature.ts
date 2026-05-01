import {
  type SandboxRuntimeManager,
  sandboxRuntimeManager,
} from "./sandbox-runtime.manager";

/**
 * Feature gate for the MCP code-execution sandbox. Single point of control for
 * the `ARCHESTRA_ORCHESTRATOR_SANDBOX_ENABLED` flag combined with K8s runtime
 * availability. Mirrors `browserStreamFeature` shape for consistency.
 */
class SandboxFeature {
  constructor(private readonly manager: SandboxRuntimeManager) {}

  isEnabled(): boolean {
    return this.manager.isEnabled();
  }

  provisionForConversation(
    ...args: Parameters<SandboxRuntimeManager["provisionForConversation"]>
  ) {
    return this.manager.provisionForConversation(...args);
  }

  markActivity(...args: Parameters<SandboxRuntimeManager["markActivity"]>) {
    return this.manager.markActivity(...args);
  }

  resumeIfSuspended(
    ...args: Parameters<SandboxRuntimeManager["resumeIfSuspended"]>
  ) {
    return this.manager.resumeIfSuspended(...args);
  }

  destroyForConversation(
    ...args: Parameters<SandboxRuntimeManager["destroyForConversation"]>
  ) {
    return this.manager.destroyForConversation(...args);
  }

  getState(...args: Parameters<SandboxRuntimeManager["getState"]>) {
    return this.manager.getState(...args);
  }

  resolveTerminalConnection(
    ...args: Parameters<SandboxRuntimeManager["resolveTerminalConnection"]>
  ) {
    return this.manager.resolveTerminalConnection(...args);
  }

  resolveMcpConnection(
    ...args: Parameters<SandboxRuntimeManager["resolveMcpConnection"]>
  ) {
    return this.manager.resolveMcpConnection(...args);
  }

  getRuntime(...args: Parameters<SandboxRuntimeManager["getRuntime"]>) {
    return this.manager.getRuntime(...args);
  }
}

export const sandboxFeature = new SandboxFeature(sandboxRuntimeManager);
