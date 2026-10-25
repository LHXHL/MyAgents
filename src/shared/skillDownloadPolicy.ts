/** Per ZIP transfer, including redirects and response body. */
export const SKILL_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** GitHub may try main then master on 404; allow time for unpacking afterwards. */
export const SKILL_INSTALL_TIMEOUT_MS = 2 * SKILL_DOWNLOAD_TIMEOUT_MS + 30_000;
