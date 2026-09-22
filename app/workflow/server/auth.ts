import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getServerSession, type NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { redirect } from "next/navigation";
import { getRedis, getRedisConfigurationError } from "./redis";

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

const OWNER: Principal = { id: "owner", name: "Owner", avatar: "", color: "#7654cb" };

// One shared attempt budget across instances. Do not trust caller-supplied IPs.
const LOGIN_ATTEMPT_SCRIPT = `
local attempts = redis.call('INCR', KEYS[1])
if attempts == 1 then redis.call('EXPIRE', KEYS[1], 60) end
return attempts
`;

export function getAuthConfigurationError(): string | null {
  const required = ["OWNER_PASSWORD", "NEXTAUTH_SECRET", "NEXTAUTH_URL"] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return `Set ${missing.join(", ")} to enable owner sign-in.`;
  }
  if ((process.env.NEXTAUTH_SECRET?.length ?? 0) < 32) {
    return "NEXTAUTH_SECRET must contain at least 32 characters.";
  }
  const password = process.env.OWNER_PASSWORD!;
  if (password.length < 16 || password.length > 256) {
    return "OWNER_PASSWORD must contain between 16 and 256 characters.";
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
  return getRedisConfigurationError();
}

export function getAuthOptions(): NextAuthOptions {
  const configurationError = getAuthConfigurationError();
  if (configurationError) {
    throw new Error(configurationError);
  }
  const password = process.env.OWNER_PASSWORD!;
  // Password rotation invalidates application sessions without exposing a hash
  // of the password in session responses. Old OAuth sessions cannot authenticate.
  const ownerVersion = createHmac("sha256", process.env.NEXTAUTH_SECRET!)
    .update(password).digest("hex");

  return {
    secret: process.env.NEXTAUTH_SECRET,
    session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
    providers: [
      CredentialsProvider({
        name: "Owner password",
        credentials: {
          password: {
            label: "Owner password",
            type: "password",
            autocomplete: "current-password",
          },
        },
        async authorize(credentials) {
          let attempts: number;
          try {
            const origin = new URL(process.env.NEXTAUTH_URL!).origin;
            const scope = createHash("sha256").update(origin).digest("hex");
            attempts = await getRedis().eval<[], number>(
              LOGIN_ATTEMPT_SCRIPT, [`jev:owner-login:${scope}`], []
            );
          } catch {
            throw new Error("Sign-in is temporarily unavailable. Check Redis and try again.");
          }
          if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
            throw new Error("Too many sign-in attempts. Try again in one minute.");
          }
          const supplied = credentials?.password;
          if (typeof supplied !== "string" || supplied.length > 256) return null;
          const expectedHash = createHash("sha256").update(password).digest();
          const suppliedHash = createHash("sha256").update(supplied).digest();
          return timingSafeEqual(expectedHash, suppliedHash) ? { ...OWNER } : null;
        },
      }),
    ],
    callbacks: {
      jwt({ token, account, user }) {
        // Only successful credential verification establishes identity.
        // Client session updates cannot set identity or refresh its version.
        if (account?.provider === "credentials" && user?.id === OWNER.id) {
          token.sub = OWNER.id;
          token.ownerVersion = ownerVersion;
        }
        return token;
      },
      session({ session, token }) {
        session.principal = null;
        if (
          token.sub === OWNER.id &&
          typeof token.ownerVersion === "string" &&
          /^[a-f0-9]{64}$/.test(token.ownerVersion) &&
          timingSafeEqual(Buffer.from(token.ownerVersion, "hex"), Buffer.from(ownerVersion, "hex"))
        ) {
          session.principal = { ...OWNER };
        }
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
