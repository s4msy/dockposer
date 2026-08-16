<script lang="ts">
	import { highlightFor } from '$lib/highlight';

	let {
		value = $bindable(''),
		name,
		fileName = '',
		rows = 16,
		disabled = false,
		id = undefined
	}: {
		value?: string;
		name: string;
		fileName?: string;
		rows?: number;
		disabled?: boolean;
		id?: string;
	} = $props();

	let textarea = $state<HTMLTextAreaElement | null>(null);
	let overlay = $state<HTMLElement | null>(null);

	// Abschließender Zeilenumbruch: sonst rendert <pre> die letzte (leere) Zeile
	// nicht und die Einfärbung verrutscht gegenüber der Textarea.
	const html = $derived(highlightFor(fileName, value.endsWith('\n') ? value + ' ' : value));

	function syncScroll() {
		if (!textarea || !overlay) return;
		overlay.scrollTop = textarea.scrollTop;
		overlay.scrollLeft = textarea.scrollLeft;
	}

	// Tab soll einrücken statt das Feld zu verlassen — zwei Leerzeichen, wie in YAML üblich
	function handleKeydown(e: KeyboardEvent) {
		if (e.key !== 'Tab' || e.shiftKey) return;
		e.preventDefault();
		const el = e.currentTarget as HTMLTextAreaElement;
		const { selectionStart: start, selectionEnd: end } = el;
		value = value.slice(0, start) + '  ' + value.slice(end);
		queueMicrotask(() => el.setSelectionRange(start + 2, start + 2));
	}
</script>

<div class="editor">
	<pre class="overlay" bind:this={overlay} aria-hidden="true">{@html html}</pre>
	<textarea
		{id}
		{name}
		{rows}
		{disabled}
		bind:this={textarea}
		bind:value
		onscroll={syncScroll}
		onkeydown={handleKeydown}
		spellcheck="false"
		autocapitalize="off"
		autocomplete="off"
		{...{ autocorrect: 'off' }}
	></textarea>
</div>

<style>
	/*
	 * Zwei deckungsgleiche Ebenen: unten die eingefärbte Kopie, oben die echte
	 * Textarea mit transparentem Text. Schrift, Abstände und Umbruchverhalten
	 * MÜSSEN identisch sein, sonst laufen Cursor und Einfärbung auseinander.
	 */
	.editor {
		position: relative;
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		background: var(--color-bg);
		overflow: hidden;
	}

	.overlay,
	.editor :global(textarea) {
		margin: 0;
		padding: var(--space-3);
		border: 0;
		font-family: ui-monospace, 'Cascadia Mono', 'JetBrains Mono', monospace;
		font-size: 0.85rem;
		line-height: 1.5;
		tab-size: 2;
		white-space: pre-wrap;
		overflow-wrap: break-word;
		word-break: normal;
	}

	.overlay {
		position: absolute;
		inset: 0;
		overflow: auto;
		pointer-events: none;
		color: var(--color-text);
	}

	.editor :global(textarea) {
		position: relative;
		display: block;
		width: 100%;
		max-width: none;
		background: transparent;
		color: transparent;
		caret-color: var(--color-text);
		resize: vertical;
		outline: none;
	}
	.editor:focus-within {
		outline: 3px solid var(--color-primary);
		outline-offset: 2px;
	}
	/* Auswahl muss sichtbar bleiben, obwohl der Text transparent ist */
	.editor :global(textarea::selection) {
		background: color-mix(in srgb, var(--color-primary) 35%, transparent);
	}

	/* Farben aus der Palette — funktioniert dadurch in allen Themes */
	.overlay :global(.tok-comment) {
		color: var(--color-text-dim);
		font-style: italic;
	}
	.overlay :global(.tok-key) {
		color: var(--color-primary);
	}
	.overlay :global(.tok-string) {
		color: var(--color-ok);
	}
	.overlay :global(.tok-literal) {
		color: var(--color-warn);
	}
	.overlay :global(.tok-var) {
		color: var(--color-crit);
	}
	.overlay :global(.tok-punct) {
		color: var(--color-text-dim);
	}
</style>
