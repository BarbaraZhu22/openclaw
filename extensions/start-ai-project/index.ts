import type { OpenClawPluginApi } from "./runtime-api.js";
import { createStartAiProjectPluginConfigSchema } from "./src/config.js";
import { registerStartAiProjectCommands } from "./src/commands.js";

const plugin = {
  id: "start-ai-project",
  name: "Start AI Project",
  description: "Repository bootstrap and sandbox preparation helper.",
  configSchema: createStartAiProjectPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    registerStartAiProjectCommands(api);
  },
};

export default plugin;
