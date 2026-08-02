import bcrypt from 'bcryptjs'; // statischer Import — bekannter ESM-Bug bei lazy import!
import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomBytes } from 'crypto';
import * as OTPAuth from 'otpauth';
import { db } from './db';
import { sessions, users } from './db/schema';
import { and, eq, gt } from 'drizzle-orm';
import { decrypt, encrypt } from './crypto';
import type { Cookies } from '@sveltejs/kit';

const SESSION_COOKIE = 'dockposer_session';
const SESSION_DAYS = 30;

function secret(): Uint8Array {
	const s = process.env.SESSION_SECRET;
	if (!s) throw new Error('SESSION_SECRET fehlt');
	return new TextEncoder().encode(s);
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

// ── Passwort ──
export const hashPassword = (pw: string) => bcrypt.hash(pw, 12);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

// ── Session ──
export async function createSession(cookies: Cookies, userId: number, meta: { userAgent?: string; ip?: string }) {
	const token = randomBytes(32).toString('hex');
	const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
	await db.insert(sessions).values({
		userId,
		tokenHash: sha256(token),
		expiresAt,
		userAgent: meta.userAgent?.slice(0, 255),
		ip: meta.ip
	});
	const jwt = await new SignJWT({ t: token })
		.setProtectedHeader({ alg: 'HS256' })
		.setExpirationTime(`${SESSION_DAYS}d`)
		.sign(secret());
	cookies.set(SESSION_COOKIE, jwt, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: SESSION_DAYS * 86400
	});
}

export async function validateSession(cookies: Cookies): Promise<App.Locals['user']> {
	const jwt = cookies.get(SESSION_COOKIE);
	if (!jwt) return null;
	try {
		const { payload } = await jwtVerify(jwt, secret());
		const token = payload.t as string;
		const [row] = await db
			.select({
				id: users.id,
				username: users.username,
				totpEnabled: users.totpEnabled,
				hideStoppedStacks: users.hideStoppedStacks,
				theme: users.theme
			})
			.from(sessions)
			.innerJoin(users, eq(sessions.userId, users.id))
			.where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())));
		return row ?? null;
	} catch {
		return null;
	}
}

export async function destroySession(cookies: Cookies) {
	const jwt = cookies.get(SESSION_COOKIE);
	if (jwt) {
		try {
			const { payload } = await jwtVerify(jwt, secret());
			await db.delete(sessions).where(eq(sessions.tokenHash, sha256(payload.t as string)));
		} catch {
			/* Token ungültig — Cookie trotzdem löschen */
		}
	}
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

// ── TOTP ──
export function generateTotpSecret(username: string) {
	const totp = new OTPAuth.TOTP({
		issuer: 'Dockposer',
		label: username,
		algorithm: 'SHA1',
		digits: 6,
		period: 30,
		secret: new OTPAuth.Secret({ size: 20 })
	});
	return { encrypted: encrypt(totp.secret.base32), otpauthUrl: totp.toString() };
}

export function verifyTotp(encryptedSecret: string, code: string): boolean {
	const totp = new OTPAuth.TOTP({
		algorithm: 'SHA1',
		digits: 6,
		period: 30,
		secret: OTPAuth.Secret.fromBase32(decrypt(encryptedSecret))
	});
	return totp.validate({ token: code.replace(/\s/g, ''), window: 1 }) !== null;
}

// ── Rate-Limiting (In-Memory-Bucket, reicht bei Single-Instance) ──
const buckets = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(key: string, max = 10, windowMs = 60_000): boolean {
	const now = Date.now();
	const b = buckets.get(key);
	if (!b || now > b.resetAt) {
		buckets.set(key, { count: 1, resetAt: now + windowMs });
		return true;
	}
	b.count++;
	return b.count <= max;
}
