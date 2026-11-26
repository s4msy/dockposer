import type { users } from '#lib/server/db/schema.ts';

declare global {
	namespace App {
		interface Locals {
			user: {
				id: number;
				username: string;
				totpEnabled: boolean;
				hideStoppedStacks: boolean;
				theme: string;
				locale: string;
			} | null;
			locale: import('#lib/i18n/index.ts').Locale;
		}
	}
}

export {};
