import webpush from 'web-push';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

const keyPath = join(dirname(process.env.DATABASE_PATH ?? './data/dockposer.db'), 'vapid.json');

interface VapidKeys {
	publicKey: string;
	privateKey: string;
}

let keys: VapidKeys;
if (existsSync(keyPath)) {
	keys = JSON.parse(readFileSync(keyPath, 'utf8'));
} else {
	keys = webpush.generateVAPIDKeys();
	mkdirSync(dirname(keyPath), { recursive: true });
	writeFileSync(keyPath, JSON.stringify(keys), { mode: 0o600 });
	console.log('[push] Neue VAPID-Keys generiert →', keyPath);
}

webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:admin@localhost', keys.publicKey, keys.privateKey);

export const vapidPublicKey = keys.publicKey;
export { webpush };
