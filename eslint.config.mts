import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'.scguard',
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ['src/**/*.ts'],
		rules: {
			'obsidianmd/ui/sentence-case': [
				'warn',
				{
					brands: [
						'Spotify Control',
						'Spotify',
						'Obsidian',
						'LRCLIB',
						'Markdown',
						'GitHub',
					],
					acronyms: [
						'API',
						'CSRF',
						'DRM',
						'ID',
						'OS',
						'PKCE',
						'UI',
						'URI',
						'URL',
					],
					ignoreRegex: [
						'^[a-f0-9]+…$',
						'^[A-Za-z][A-Za-z0-9._-]*(?:/[A-Za-z0-9._-]+)+$',
					],
					enforceCamelCaseLower: true,
				},
			],
		},
	},
);
