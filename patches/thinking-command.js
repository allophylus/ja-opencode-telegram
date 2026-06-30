import { showVariantSelectionMenu } from "../menus/variant-selection-menu.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";

export async function thinkingCommand(ctx) {
    logger.debug("[Bot] /thinking command triggered");
    try {
        await showVariantSelectionMenu(ctx);
    } catch (err) {
        logger.error("[Bot] Error showing variant menu:", err);
        await ctx.reply(t("error.load_variants"));
    }
}
