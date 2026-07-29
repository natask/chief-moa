import pg from "pg";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { bearer, deviceAuthorization } from "better-auth/plugins";

const { Pool } = pg;

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required when MOA_AUTH=better-auth`);
  return value;
}

const baseURL = required("BETTER_AUTH_URL").replace(/\/$/, "");
const trustedOrigins = String(process.env.BETTER_AUTH_TRUSTED_ORIGINS || baseURL)
  .split(",").map((value) => value.trim()).filter(Boolean);
const allowedDeviceClients = new Set(["ag-macos", "ag-browser", "ag-android"]);
const ownerEmail = required("BETTER_AUTH_OWNER_EMAIL").toLowerCase();

export const auth = betterAuth({
  appName: "Ag",
  baseURL,
  basePath: "/api/auth",
  secret: required("BETTER_AUTH_SECRET"),
  database: new Pool({ connectionString: required("DATABASE_URL"), max: 10 }),
  trustedOrigins,
  emailAndPassword: { enabled: true },
  user: { modelName: "auth_user" },
  session: {
    modelName: "auth_session",
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  account: { modelName: "auth_account" },
  verification: { modelName: "auth_verification" },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (String(user.email || "").trim().toLowerCase() !== ownerEmail) {
            throw new APIError("FORBIDDEN", { message: "This Ag gateway is not accepting additional accounts." });
          }
          return { data: user };
        },
      },
    },
  },
  advanced: { cookiePrefix: "ag" },
  plugins: [
    bearer(),
    deviceAuthorization({
      verificationUri: `${baseURL}/device`,
      expiresIn: "15m",
      interval: "5s",
      validateClient: async (clientId) => allowedDeviceClients.has(String(clientId || "")),
      schema: { deviceCode: { modelName: "auth_device_code" } },
    }),
  ],
});
