// Stummschaltung und Wartungsfenster.
//
// Zwei Wege, denselben Effekt zu erreichen: `mutedUntil` für spontane Wartung
// ("ich bastle jetzt eine halbe Stunde"), `quietFrom`/`quietMinutes` für den
// planbaren täglichen Fall — Router-Neustart um 6, Server-Reboot nach dem
// Backup. Was in diesen Zeiten passiert, ist erwartet und muss niemanden wecken.

/** Zeitzone, in der das tägliche Fenster ausgelegt wird — die des Cores. */
export const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';

/** Minuten seit Mitternacht, in der lokalen Zeitzone des Core-Prozesses. */
function minutesOfDay(at: Date): number {
	return at.getHours() * 60 + at.getMinutes();
}

/** "HH:MM" → Minuten seit Mitternacht, oder null bei ungültiger Eingabe. */
export function parseHhMm(value: string | null | undefined): number | null {
	if (!value) return null;
	const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!m) return null;
	const h = Number(m[1]);
	const min = Number(m[2]);
	if (h > 23 || min > 59) return null;
	return h * 60 + min;
}

export interface QuietConfig {
	mutedUntil?: Date | null;
	quietFrom?: string | null;
	quietMinutes?: number | null;
}

/**
 * Liegt der Zeitpunkt in einer Ruhephase? Das tägliche Fenster darf über
 * Mitternacht laufen (23:55 + 20 min), deshalb die Fallunterscheidung.
 */
export function isQuiet(cfg: QuietConfig, at: Date = new Date()): boolean {
	if (cfg.mutedUntil && cfg.mutedUntil.getTime() > at.getTime()) return true;
	const from = parseHhMm(cfg.quietFrom);
	if (from === null) return false;
	const span = Math.max(1, Math.min(cfg.quietMinutes ?? 15, 24 * 60));
	const now = minutesOfDay(at);
	const end = from + span;
	// Innerhalb des Tages: [from, end). Über Mitternacht hinaus: zwei Abschnitte.
	return end <= 24 * 60 ? now >= from && now < end : now >= from || now < end - 24 * 60;
}
