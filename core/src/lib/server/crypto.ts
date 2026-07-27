import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// AES-256-GCM für TOTP-Secrets. Key: 64 Hex-Zeichen aus ENV (openssl rand -hex 32)
function key(): Buffer {
	const k = process.env.ENCRYPTION_KEY;
	if (!k || k.length !== 64) throw new Error('ENCRYPTION_KEY fehlt oder ist keine 64 Hex-Zeichen');
	return Buffer.from(k, 'hex');
}

export function encrypt(plain: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key(), iv);
	const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join('.');
}

export function decrypt(stored: string): string {
	const [ivHex, tagHex, dataHex] = stored.split('.');
	const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivHex, 'hex'));
	decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
	return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}
