import type { users } from '$lib/server/db/schema';

declare global {
	namespace App {
		interface Locals {
			user: { id: number; username: string; totpEnabled: boolean; hideStoppedStacks: boolean } | null;
		}
	}
}

export {};
