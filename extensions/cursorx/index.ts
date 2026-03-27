import type { OpenClawPluginApi } from "./runtime-api.js";
import { createCursorxPluginConfigSchema } from "./src/config.js";
import { createCursorxRuntimeService } from "./src/service.js";

const plugin = {
  id: "cursorx",
  name: "Cursor ACP Runtime",
  description: "ACP runtime backend powered by Cursor CLI.",
  configSchema: createCursorxPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerService(
      createCursorxRuntimeService({
        pluginConfig: api.pluginConfig,
      }),
    );
  },
};

export default plugin;
