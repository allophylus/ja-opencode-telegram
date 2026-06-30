import { logger } from "../../utils/logger.js";

const ABOUT_TEXT = `🤖 *JA OpenCode Telegram*

Chat with OpenCode from Telegram — run tasks, switch models, manage sessions.

Built by *Fen Pang* 🦀
Architect · Dreamer · Designer

☕ Support development: https://ko-fi.com/mrdom78

Commands:
/model — Change AI model
/status — Bot status
/settings — Configure bot
/help — All commands`;

export async function aboutCommand(ctx) {
    logger.debug("[Bot] /about command triggered");
    try {
        await ctx.reply(ABOUT_TEXT, { parse_mode: "Markdown" });
    } catch (err) {
        logger.error("[Bot] Error in /about:", err);
        await ctx.reply("JA OpenCode Telegram by Fen Pang\n☕ https://ko-fi.com/mrdom78");
    }
}
