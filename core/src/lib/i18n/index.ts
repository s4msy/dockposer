// Leichtgewichtige i18n ohne Laufzeit-Abhängigkeit: flache Nachrichtenobjekte,
// Auflösung über den Benutzer (DB) oder ersatzweise den Accept-Language-Header.
import { de } from './de';
import { en } from './en';
import type { MessageKey } from './de';

export type { MessageKey };

export const LOCALES = ['de', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

const MESSAGES: Record<Locale, Record<MessageKey, string>> = { de, en };

export const LOCALE_LABELS: Record<Locale, string> = {
	de: 'Deutsch',
	en: 'English'
};

export function isLocale(v: string): v is Locale {
	return (LOCALES as readonly string[]).includes(v);
}

/** Sprache aus dem Accept-Language-Header, Fallback Englisch. */
export function localeFromHeader(header: string | null): Locale {
	if (!header) return 'en';
	for (const part of header.split(',')) {
		const tag = part.split(';')[0].trim().toLowerCase().split('-')[0];
		if (isLocale(tag)) return tag;
	}
	return 'en';
}

/**
 * Übersetzer für eine Sprache. Platzhalter im Text werden als {name} geschrieben:
 *   t('overview.hiddenStacks', { count: 3 })
 * Fehlt ein Schlüssel in der Zielsprache, greift Deutsch als Quellsprache.
 */
export function translator(locale: Locale) {
	const table = MESSAGES[locale] ?? de;
	return (key: MessageKey, params?: Record<string, string | number>): string => {
		let text: string = table[key] ?? de[key] ?? key;
		if (params) {
			for (const [name, value] of Object.entries(params)) {
				text = text.replaceAll(`{${name}}`, String(value));
			}
		}
		return text;
	};
}

export type Translator = ReturnType<typeof translator>;
