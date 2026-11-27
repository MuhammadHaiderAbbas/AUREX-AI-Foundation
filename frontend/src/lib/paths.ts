/** Route roots: the public website lives at "/", the trading app at /app and the admin console at /admin. */
export const APP = "/app";
export const ADMIN = "/admin";
export const app = (path = "") => `${APP}${path}`;
export const admin = (path = "") => `${ADMIN}${path}`;
/** Where a signed-in person belongs: administrators manage the platform, traders use the app. */
export const homeFor = (role: string | undefined) => (role === "admin" ? ADMIN : APP);
