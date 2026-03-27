import type {
  AcpRuntime,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "../runtime-api.js";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../runtime-api.js";
import { resolveCursorxPluginConfig, type ResolvedCursorxPluginConfig } from "./config.js";
import { CURSORX_BACKEND_ID, CursorxRuntime } from "./runtime.js";

type CursorxRuntimeLike = AcpRuntime & {
  isHealthy(): boolean;
};

type CursorxRuntimeFactoryParams = {
  pluginConfig: ResolvedCursorxPluginConfig;
  logger?: PluginLogger;
};

type CreateCursorxRuntimeServiceParams = {
  pluginConfig?: unknown;
  runtimeFactory?: (params: CursorxRuntimeFactoryParams) => CursorxRuntimeLike;
};

function createDefaultRuntime(params: CursorxRuntimeFactoryParams): CursorxRuntimeLike {
  return new CursorxRuntime(params.pluginConfig, { logger: params.logger });
}

export function createCursorxRuntimeService(
  params: CreateCursorxRuntimeServiceParams = {},
): OpenClawPluginService {
  let runtime: CursorxRuntimeLike | null = null;

  return {
    id: "cursorx-runtime",
    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      const pluginConfig = resolveCursorxPluginConfig({
        rawConfig: params.pluginConfig,
        workspaceDir: ctx.workspaceDir,
      });
      const runtimeFactory = params.runtimeFactory ?? createDefaultRuntime;
      runtime = runtimeFactory({
        pluginConfig,
        logger: ctx.logger,
      });
      registerAcpRuntimeBackend({
        id: CURSORX_BACKEND_ID,
        runtime,
        healthy: () => runtime?.isHealthy() ?? false,
      });
      ctx.logger.info(
        `cursorx runtime backend registered (command: ${pluginConfig.command}, mode: ${pluginConfig.defaultRuntimeMode})`,
      );
    },
    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      unregisterAcpRuntimeBackend(CURSORX_BACKEND_ID);
      runtime = null;
    },
  };
}
