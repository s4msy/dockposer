import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'; // nicht aus kit/vite!

const config = {
	preprocess: vitePreprocess(),
	kit: { adapter: adapter({ port: 3000 }) }
};
export default config;
