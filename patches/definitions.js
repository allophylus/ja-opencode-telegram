import { t } from "../../i18n/index.js";
/**
 * List of all bot commands
 * Update this array when adding new commands
 */
const COMMAND_DEFINITIONS = [
    { command: "status", descriptionKey: "cmd.description.status" },
    { command: "new", descriptionKey: "cmd.description.new" },
    { command: "abort", descriptionKey: "cmd.description.stop" },
    { command: "detach", descriptionKey: "cmd.description.detach" },
    { command: "sessions", descriptionKey: "cmd.description.sessions" },
    { command: "messages", descriptionKey: "cmd.description.messages" },
    { command: "settings", descriptionKey: "cmd.description.settings" },
    { command: "projects", descriptionKey: "cmd.description.projects" },
    { command: "worktree", descriptionKey: "cmd.description.worktree" },
    { command: "task", descriptionKey: "cmd.description.task" },
    { command: "tasklist", descriptionKey: "cmd.description.tasklist" },
    { command: "rename", descriptionKey: "cmd.description.rename" },
    { command: "commands", descriptionKey: "cmd.description.commands" },
    { command: "skills", descriptionKey: "cmd.description.skills" },
    { command: "mcps", descriptionKey: "cmd.description.mcps" },
    { command: "model", descriptionKey: "cmd.description.model" },
    { command: "opencode_start", descriptionKey: "cmd.description.opencode_start" },
    { command: "opencode_stop", descriptionKey: "cmd.description.opencode_stop" },
    { command: "open", descriptionKey: "cmd.description.open" },
    { command: "ls", descriptionKey: "cmd.description.ls" },
    { command: "help", descriptionKey: "cmd.description.help" },
];
export function getLocalizedBotCommands() {
    return COMMAND_DEFINITIONS.map(({ command, descriptionKey }) => ({
        command,
        description: t(descriptionKey),
    }));
}
export const BOT_COMMANDS = getLocalizedBotCommands();
