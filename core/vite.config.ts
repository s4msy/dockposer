import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'; // nicht aus kit/vite!
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			preprocess: vitePreprocess(),
			// Port kommt zur Laufzeit aus PORT (Standard 3000), die Origin aus ORIGIN —
			// adapter-node 6 liest beides weiterhin, solange paths.origin leer bleibt.
			adapter: adapter()
		})
	]
});
