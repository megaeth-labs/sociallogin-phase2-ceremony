/** Select a complete naming family; never mix credentials from two OAuth apps. */
export function githubOAuthCredentials(source: Record<string, string | undefined> = process.env) {
  const useOAuthNames = source.GITHUB_OAUTH_CLIENT_ID !== undefined || source.GITHUB_OAUTH_CLIENT_SECRET !== undefined;
  return {
    clientId: (useOAuthNames ? source.GITHUB_OAUTH_CLIENT_ID : source.GITHUB_CLIENT_ID)?.trim() ?? "",
    clientSecret: (useOAuthNames ? source.GITHUB_OAUTH_CLIENT_SECRET : source.GITHUB_CLIENT_SECRET)?.trim() ?? "",
  };
}

const REQUIRED_SERVER_VARS = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "NEXTAUTH_SECRET",
  "NEXTAUTH_URL",
] as const;

type EnvKey = (typeof REQUIRED_SERVER_VARS)[number];

export function loadAuthEnv(): Record<EnvKey, string> {
  const github = githubOAuthCredentials();
  const values = {
    GITHUB_CLIENT_ID: github.clientId,
    GITHUB_CLIENT_SECRET: github.clientSecret,
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET?.trim(),
    NEXTAUTH_URL: process.env.NEXTAUTH_URL?.trim(),
  };
  const missing = REQUIRED_SERVER_VARS.filter((k) => !values[k]);
  if (missing.length > 0) {
    throw new Error(
      `
      
   Missing required environment variables:\n${missing.map((k) => `   - ${k}`).join("\n")}\n` +
        `   Copy .env.example to .env and fill in the values.\n`,
    );
  }
  return Object.fromEntries(
    REQUIRED_SERVER_VARS.map((k) => [k, values[k]!]),
  ) as Record<EnvKey, string>;
}
