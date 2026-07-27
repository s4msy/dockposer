import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'sqlite', // kein DB-Zugriff für generate nötig
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle'
});
