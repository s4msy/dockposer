// Typen des Update-Feeds und der Historie — von Server und Browser genutzt.

export interface ImageMeta {
	/** ISO-Zeitpunkt des Builds (`created` im Config-Blob). */
	created?: string;
	/** org.opencontainers.image.version — oft der Git-Tag. */
	version?: string;
	/** org.opencontainers.image.revision — der Commit. */
	revision?: string;
	/** org.opencontainers.image.source — Repository-URL. */
	source?: string;
	/** Daraus abgeleitete Release-Seite, wenn die Quelle bekannt ist. */
	releases?: string;
}

export interface UpdateEntry {
	service: string;
	image: string;
	current: string; // sha256:… (lokal bzw. der gepinnte Digest)
	latest: string; // sha256:… (Registry)
	/**
	 * 'noauto' nur bei Pods: Es gibt ein neues Image, aber der Container hat kein
	 * AutoUpdate= — `podman auto-update` würde ihn nicht anfassen.
	 */
	status: 'update' | 'current' | 'unknown' | 'pinned' | 'noauto';
	/**
	 * Nur bei 'pinned': Der Tag zeigt inzwischen auf ein anderes Image.
	 * Rein informativ — anwendbar ist das nur durch Ändern der compose.yaml.
	 */
	newer?: boolean;
	/** Bei 'unknown': Host, für den Zugangsdaten fehlen könnten. */
	host?: string;
	authRequired?: boolean;
	/** Nur bei 'update': Herkunft und Bauzeit — beantwortet „ist das wirklich neu?". */
	newMeta?: ImageMeta;
	/** Dasselbe für das laufende Image, als Vergleichspunkt. */
	oldMeta?: ImageMeta;
}

/** Was sich bei einem Dienst geändert hat — für die Update-Historie. */
export interface ServiceChange {
	service: string;
	from?: string; // Version/Commit vorher
	to?: string; // Version/Commit nachher
	created?: string; // Bauzeit des neuen Images
	releases?: string; // Release-Übersicht des Projekts
}

export interface HistoryRun {
	id: number;
	trigger: string;
	result: string | null;
	changed: string[];
	changes: ServiceChange[];
	logExcerpt: string | null;
	startedAt: Date;
	finishedAt: Date | null;
}

export type StackKind = 'stack' | 'pod';
