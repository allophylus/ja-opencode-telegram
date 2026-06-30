import { showModelSelectionMenu } from "../menus/model-selection-menu.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";

export async function modelCommand(ctx) {
    logger.debug("[Bot] /model command triggered");
    try {
        await showModelSelectionMenu(ctx);
    } catch (err) {
        logger.error("[Bot] Error showing model menu:", err);
        await ctx.reply(t("error.load_models"));
    }
}
