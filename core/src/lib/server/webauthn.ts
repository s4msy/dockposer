// WebAuthn/Passkeys: Fingerabdruck-Login für die installierte PWA.
// Ein Passkey ersetzt Passwort+TOTP komplett — Besitz (Gerät) + Biometrie
// sind bereits zwei Faktoren. rpID/Origin kommen aus ORIGIN (Pflicht-ENV).
import {
	generateRegistrationOptions,
	verifyRegistrationResponse,
	generateAuthenticationOptions,
	verifyAuthenticationResponse,
	type RegistrationResponseJSON,
	type AuthenticationResponseJSON
} from '@simplewebauthn/server';
import { randomBytes } from 'crypto';
import { db } from './db';
import { users, webauthnCredentials } from './db/schema';
import { eq } from 'drizzle-orm';

function rp() {
	const origin = process.env.ORIGIN;
	if (!origin) throw new Error('ORIGIN fehlt — für WebAuthn zwingend');
	return { origin, rpID: new URL(origin).hostname, rpName: 'Dockposer' };
}

// Challenges: In-Memory mit TTL — bei Core-Neustart bricht ein laufender
// Handshake ab, das ist verschmerzbar (User tippt einfach nochmal).
const challenges = new Map<string, { challenge: string; userId?: number; expiresAt: number }>();
const CHALLENGE_TTL_MS = 5 * 60_000;

function storeChallenge(challenge: string, userId?: number): string {
	const id = randomBytes(16).toString('hex');
	challenges.set(id, { challenge, userId, expiresAt: Date.now() + CHALLENGE_TTL_MS });
	// Gelegentlich aufräumen
	if (challenges.size > 100) {
		for (const [k, v] of challenges) if (Date.now() > v.expiresAt) challenges.delete(k);
	}
	return id;
}

function takeChallenge(id: string): { challenge: string; userId?: number } | null {
	const entry = challenges.get(id);
	challenges.delete(id);
	if (!entry || Date.now() > entry.expiresAt) return null;
	return entry;
}

const b64 = (buf: Uint8Array) => Buffer.from(buf).toString('base64url');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

// ── Registrierung (eingeloggt, aus den Settings) ──
export async function beginRegistration(userId: number, username: string) {
	const existing = await db.select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, userId));
	const options = await generateRegistrationOptions({
		rpName: rp().rpName,
		rpID: rp().rpID,
		userName: username,
		userID: new TextEncoder().encode(String(userId)),
		attestationType: 'none',
		excludeCredentials: existing.map((c) => ({ id: c.credentialId })),
		authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }
	});
	return { challengeId: storeChallenge(options.challenge, userId), options };
}

export async function finishRegistration(
	userId: number,
	challengeId: string,
	response: RegistrationResponseJSON,
	deviceName: string
): Promise<{ ok: boolean; error?: string }> {
	const stored = takeChallenge(challengeId);
	if (!stored || stored.userId !== userId) return { ok: false, error: 'Challenge abgelaufen — bitte erneut versuchen.' };
	try {
		const verification = await verifyRegistrationResponse({
			response,
			expectedChallenge: stored.challenge,
			expectedOrigin: rp().origin,
			expectedRPID: rp().rpID
		});
		if (!verification.verified || !verification.registrationInfo) return { ok: false, error: 'Verifikation fehlgeschlagen.' };
		const { credential } = verification.registrationInfo;
		await db.insert(webauthnCredentials).values({
			userId,
			credentialId: credential.id,
			publicKey: b64(credential.publicKey),
			counter: credential.counter,
			transports: JSON.stringify(credential.transports ?? []),
			deviceName: deviceName.slice(0, 64) || 'Unbenanntes Gerät'
		});
		return { ok: true };
	} catch (e) {
		return { ok: false, error: `Registrierung fehlgeschlagen: ${e}` };
	}
}

// ── Anmeldung (Login-Seite, usernameless über Discoverable Credentials) ──
export async function beginAuthentication() {
	const options = await generateAuthenticationOptions({ rpID: rp().rpID, userVerification: 'preferred' });
	return { challengeId: storeChallenge(options.challenge), options };
}

export async function finishAuthentication(
	challengeId: string,
	response: AuthenticationResponseJSON
): Promise<{ userId: number } | { error: string }> {
	const stored = takeChallenge(challengeId);
	if (!stored) return { error: 'Challenge abgelaufen — bitte erneut versuchen.' };
	const [cred] = await db.select().from(webauthnCredentials).where(eq(webauthnCredentials.credentialId, response.id));
	if (!cred) return { error: 'Unbekannter Passkey.' };
	try {
		const verification = await verifyAuthenticationResponse({
			response,
			expectedChallenge: stored.challenge,
			expectedOrigin: rp().origin,
			expectedRPID: rp().rpID,
			credential: {
				id: cred.credentialId,
				publicKey: unb64(cred.publicKey),
				counter: cred.counter,
				transports: cred.transports ? JSON.parse(cred.transports) : undefined
			}
		});
		if (!verification.verified) return { error: 'Verifikation fehlgeschlagen.' };
		await db
			.update(webauthnCredentials)
			.set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
			.where(eq(webauthnCredentials.id, cred.id));
		// Existiert der User noch?
		const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, cred.userId));
		if (!user) return { error: 'User existiert nicht mehr.' };
		return { userId: user.id };
	} catch (e) {
		return { error: `Anmeldung fehlgeschlagen: ${e}` };
	}
}
