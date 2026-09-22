import "server-only";

import { getServerSession, type NextAuthOptions } from "next-auth";
import GitHubProvider, { type GithubProfile } from "next-auth/providers/github";
import { redirect } from "next/navigation";

export type Principal = {
  id: string;
  name: string;
  avatar: string;
  color: string;
};

declare module "next-auth" {
  interface Session {
    principal: Principal | null;
  }
}

const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const USER_COLORS = ["#7654cb", "#b13e53", "#257b68", "#286bb0"];

function allowedLogins(): string[] {
  return (process.env.GITHUB_ALLOWED_USERS ?? "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedLogin(login: unknown): login is string {
  return (
    typeof login === "string" &&
    GITHUB_LOGIN.test(login) &&
    allowedLogins().includes(login.toLowerCase())
  );
}

function isAllowedGitHubProfile(
  profile: unknown
): profile is Pick<GithubProfile, "id" | "login"> {
  return (
    typeof profile === "object" &&
    profile !== null &&
    "id" in profile &&
    typeof profile.id === "number" &&
    Number.isSafeInteger(profile.id) &&
    profile.id > 0 &&
    "login" in profile &&
    isAllowedLogin(profile.login)
  );
}

export function getAuthConfigurationError(): string | null {
  const required = [
    "GITHUB_ID",
    "GITHUB_SECRET",
    "NEXTAUTH_SECRET",
    "NEXTAUTH_URL",
    "GITHUB_ALLOWED_USERS",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return `Set ${missing.join(", ")} to enable GitHub sign-in.`;
  }
  if ((process.env.NEXTAUTH_SECRET?.length ?? 0) < 32) {
    return "NEXTAUTH_SECRET must contain at least 32 characters.";
  }
  const logins = allowedLogins();
  if (logins.length === 0 || logins.some((login) => !GITHUB_LOGIN.test(login))) {
    return "GITHUB_ALLOWED_USERS must be a comma-separated list of GitHub logins.";
  }
  try {
    const url = new URL(process.env.NEXTAUTH_URL!);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      return "NEXTAUTH_URL must be the absolute origin of this deployment.";
    }
    if (
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ) {
      return "NEXTAUTH_URL must use HTTPS outside localhost.";
    }
  } catch {
    return "NEXTAUTH_URL must be the absolute origin of this deployment.";
  }
  return null;
}

export function getAuthOptions(): NextAuthOptions {
  const configurationError = getAuthConfigurationError();
  if (configurationError) {
    throw new Error(configurationError);
  }

  return {
    secret: process.env.NEXTAUTH_SECRET,
    session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
    providers: [
      GitHubProvider({
        clientId: process.env.GITHUB_ID!,
        clientSecret: process.env.GITHUB_SECRET!,
        authorization: { params: { scope: "read:user" } },
      }),
    ],
    callbacks: {
      signIn({ account, profile }) {
        return account?.provider === "github" && isAllowedGitHubProfile(profile);
      },
      jwt({ token, account, profile }) {
        // Only the verified OAuth profile may establish identity. Client session
        // updates are deliberately ignored.
        if (account?.provider === "github") {
          if (!isAllowedGitHubProfile(profile)) {
            throw new Error("GitHub account is not authorized.");
          }
          token.githubId = String(profile.id);
          token.githubLogin = profile.login.toLowerCase();
        }
        return token;
      },
      session({ session, token }) {
        session.principal = null;
        if (
          typeof token.githubId === "string" &&
          /^[1-9]\d*$/.test(token.githubId) &&
          isAllowedLogin(token.githubLogin)
        ) {
          const id = token.githubId;
          session.principal = {
            id: `github:${id}`,
            name: token.githubLogin,
            avatar: `https://avatars.githubusercontent.com/u/${id}?s=96`,
            color: USER_COLORS[Number(id) % USER_COLORS.length],
          };
        }
        // The app exposes only the verified public GitHub identity, not email.
        delete session.user;
        return session;
      },
    },
  };
}

export async function getPrincipal(): Promise<Principal | null> {
  if (getAuthConfigurationError()) {
    return null;
  }
  const session = await getServerSession(getAuthOptions());
  return session?.principal ?? null;
}

export async function requirePrincipal(): Promise<Principal> {
  if (getAuthConfigurationError()) {
    redirect("/");
  }
  const principal = await getPrincipal();
  if (!principal) {
    redirect("/api/auth/signin?callbackUrl=%2F");
  }
  return principal;
}
