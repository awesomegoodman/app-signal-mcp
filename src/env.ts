export function assertEnv(
  value: string | undefined,
  name: string,
  options?: { default?: string; message?: string },
): string {
  if (value !== undefined) return value;
  if (options?.default !== undefined) return options.default;
  throw new Error(options?.message ?? `Missing required environment variable: ${name}`);
}

const volumePath =
  process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "./data";

const DB_PATH = `${volumePath}/data.sqlite`;


export const ENV = {
  DB_PATH,

  PORT: (() => {
    const raw = assertEnv(process.env.PORT, "PORT", {
      default: "3000",
    });

    const parsed = Number(raw);

    if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error(`Invalid PORT value: ${raw}`);
    }

    return parsed;
  })(),

  NODE_ENV: (() => {
    const env = process.env.NODE_ENV ?? "development";

    if (!["development", "production", "test"].includes(env)) {
      throw new Error(`Invalid NODE_ENV: ${env}`);
    }

    return env as "development" | "production" | "test";
  })(),
};