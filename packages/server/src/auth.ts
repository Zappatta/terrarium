import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Db, UserRecord } from "./db.js";
import { UserError } from "./errors.js";

export interface Identity {
  provider: "google" | "dev";
  subject: string;
  email: string;
  name: string;
  picture: string | null;
}

export type GoogleVerifier = (idToken: string) => Promise<Identity>;

export interface User {
  id: string;
  email: string;
  name: string;
  picture: string | null;
  isAdmin: boolean;
}

const SESSION_DAYS = 30;
const SESSION_PREFIX = "trs_";
const KEY_PREFIX = "trk_";
export const SESSION_COOKIE = "terrarium_session";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = (prefix: string) => prefix + randomBytes(32).toString("base64url");

/**
 * Verifies a Google ID token ("Sign in with Google") against Google's published keys. Only the
 * OAuth client ID is needed: no client secret, because we never exchange codes for tokens.
 */
export function googleVerifier(clientId: string, keys: JWTVerifyGetKey = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"))): GoogleVerifier {
  return async (idToken) => {
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: clientId,
    });
    if (!payload.sub || typeof payload.email !== "string") throw new UserError("Google token has no account id or email", 401);
    if (payload.email_verified !== true) throw new UserError("Your Google email address is not verified", 401);
    return {
      provider: "google",
      subject: payload.sub,
      email: payload.email,
      name: typeof payload.name === "string" ? payload.name : payload.email.split("@")[0]!,
      picture: typeof payload.picture === "string" ? payload.picture : null,
    };
  };
}

export interface AuthOptions {
  /** Emails with admin rights: create and control live worlds, run rated tournaments. */
  admins: string[];
  verifyGoogle?: GoogleVerifier;
  googleClientId?: string;
  /** Local development only: sign in as any name without Google. Never enable on a public server. */
  devLogin?: boolean;
}

export class Auth {
  private readonly admins: Set<string>;

  constructor(private readonly db: Db, readonly opts: AuthOptions) {
    this.admins = new Set(opts.admins.map((e) => e.trim().toLowerCase()).filter(Boolean));
  }

  toUser(u: UserRecord): User {
    return { id: u.id, email: u.email, name: u.name, picture: u.picture, isAdmin: this.admins.has(u.email.toLowerCase()) };
  }

  async signInWithGoogle(idToken: string): Promise<{ user: User; session: string }> {
    if (!this.opts.verifyGoogle) throw new UserError("Google sign-in is not configured on this server", 404);
    let identity: Identity;
    try {
      identity = await this.opts.verifyGoogle(idToken);
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError("Google sign-in failed: the token is invalid or expired", 401);
    }
    return this.startSession(identity);
  }

  signInDev(name: string): { user: User; session: string } {
    if (!this.opts.devLogin) throw new UserError("Development sign-in is disabled", 404);
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) throw new UserError("Pick a name with letters or digits");
    return this.startSession({ provider: "dev", subject: slug, email: `${slug}@dev.local`, name: name.trim().slice(0, 40), picture: null });
  }

  private startSession(identity: Identity): { user: User; session: string } {
    const user = this.db.upsertUser({ id: randomUUID(), ...identity });
    const session = secret(SESSION_PREFIX);
    this.db.createSession(sha256(session), user.id, new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString());
    return { user: this.toUser(user), session };
  }

  signOut(session: string): void {
    this.db.deleteSession(sha256(session));
  }

  /** Who is calling: an API key (Authorization: Bearer trk_...) or a browser session cookie. */
  resolve(authorization: string | undefined, cookieHeader: string | undefined): User | null {
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : undefined;
    if (bearer?.startsWith(KEY_PREFIX)) {
      const u = this.db.apiKeyUser(sha256(bearer));
      return u ? this.toUser(u) : null;
    }
    const session = readCookie(cookieHeader, SESSION_COOKIE);
    if (session?.startsWith(SESSION_PREFIX)) {
      const u = this.db.sessionUser(sha256(session));
      return u ? this.toUser(u) : null;
    }
    return null;
  }

  createApiKey(user: User, name: string): { key: string; id: string; prefix: string } {
    const key = secret(KEY_PREFIX);
    const id = randomUUID();
    const prefix = key.slice(0, 12);
    this.db.createApiKey({ id, userId: user.id, name: name.slice(0, 60) || "API key", keyHash: sha256(key), prefix });
    return { key, id, prefix };
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function sessionCookie(value: string, secure: boolean, maxAgeSeconds = SESSION_DAYS * 86_400): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
