// Benachrichtigung über verfügbare Updates.
//
// Bis hierher war der Update-Feed rein visuell: Wer die Seite nicht aufmachte,
// erfuhr nie von einer neuen Version. Für Stacks auf Policy 'auto' gab es eine
// Meldung nach dem Lauf — Stacks auf 'manual' blieben still, obwohl gerade dort
// eine Entscheidung des Menschen nötig ist.
import { engine } from '$lib/server/alerts/engine';
import type { UpdateEntry } from './checker';

/** Identität der gefundenen Version(en) — ändert sie sich, ist es eine neue Meldung wert. */
function digestKey(applicable: UpdateEntry[]): string {
	return applicable
		.map((e) => `${e.service}@${e.latest.slice(7, 19)}`)
		.sort()
		.join(',');
}

/** Offene „Update verfügbar"-Meldung eines Stacks schließen, ohne zu prüfen. */
export async function clearUpdateAlert(serverId: number, stackName: string) {
	await engine.updateNoLongerPending(serverId, stackName);
}

/**
 * Gleicht den offenen 'update_available'-Alert eines Stacks mit dem Prüfergebnis ab.
 *
 * `notify: false` löst nie eine Meldung aus, schließt aber offene — für Stellen,
 * an denen der Mensch ohnehin hinsieht (manueller Check) oder gerade selbst
 * aktualisiert hat. Sonst käme die Push-Nachricht ausgerechnet dann, wenn sie
 * niemand braucht.
 */
export async function syncUpdateAlert(
	serverId: number,
	stackName: string,
	entries: UpdateEntry[],
	policy: string,
	notify: boolean
) {
	// 'pinned' zählt nicht: Ein Digest-Pin ist eine Entscheidung, kein Rückstand.
	const applicable = entries.filter((e) => e.status === 'update');
	if (!applicable.length) {
		await engine.updateNoLongerPending(serverId, stackName);
		return;
	}
	// Auto-Stacks melden sich nach dem Lauf selbst („Update erfolgreich").
	if (!notify || policy !== 'manual') return;
	await engine.updateAvailable(
		serverId,
		stackName,
		applicable.map((e) => e.service),
		digestKey(applicable)
	);
}
