// Minimale Syntaxhervorhebung für Compose-YAML und .env-Dateien.
//
// Bewusst kein Editor-Framework: Die native <textarea> bleibt erhalten (Tastatur,
// Auswahl, Undo, Autokorrektur-Verhalten auf dem Handy), darunter liegt nur eine
// eingefärbte Kopie des Textes. Kostet ein paar Zeilen statt ~200 KB.

const ESCAPE: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;'
};

export function escapeHtml(text: string): string {
	return text.replace(/[&<>]/g, (c) => ESCAPE[c]);
}

const span = (cls: string, text: string) => `<span class="tok-${cls}">${text}</span>`;

/** Eine YAML-Zeile einfärben. Zeilenweise, damit ein Fehler nie die ganze Datei zerlegt. */
function highlightYamlLine(raw: string): string {
	const line = escapeHtml(raw);

	// Ganzzeiliger Kommentar
	const commentOnly = line.match(/^(\s*)(#.*)$/);
	if (commentOnly) return commentOnly[1] + span('comment', commentOnly[2]);

	// Kommentar am Zeilenende abtrennen (nicht innerhalb von Anführungszeichen)
	let code = line;
	let trailing = '';
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
			code = line.slice(0, i);
			trailing = span('comment', line.slice(i));
			break;
		}
	}

	// Einrückung und optionaler Listenstrich
	const structure = code.match(/^(\s*)(-\s+)?(.*)$/);
	if (!structure) return code + trailing;
	const [, indent, dash, rest] = structure;
	let out = indent + (dash ? span('punct', dash) : '');

	// Schlüssel: value
	const pair = rest.match(/^([\w.-]+)(\s*:)(\s*)(.*)$/);
	if (pair) {
		const [, key, colon, gap, value] = pair;
		out += span('key', key) + span('punct', colon) + gap + highlightValue(value);
	} else {
		out += highlightValue(rest);
	}
	return out + trailing;
}

function highlightValue(value: string): string {
	if (!value) return '';
	// Zeichenketten in Anführungszeichen
	if (/^(".*"|'.*')$/.test(value)) return highlightVars(span('string', value));
	// Zahlen und Wahrheitswerte
	if (/^(true|false|null|~|\d+(\.\d+)?)$/i.test(value)) return span('literal', value);
	return highlightVars(value);
}

/** ${VAR} und $VAR hervorheben — in Compose der häufigste Fehlerquell. */
function highlightVars(text: string): string {
	return text.replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, (m) => span('var', m));
}

export function highlightYaml(text: string): string {
	return text.split('\n').map(highlightYamlLine).join('\n');
}

/** .env-Dateien: KEY=value, Kommentare, Variablenverweise. */
export function highlightEnv(text: string): string {
	return text
		.split('\n')
		.map((raw) => {
			const line = escapeHtml(raw);
			const comment = line.match(/^(\s*)(#.*)$/);
			if (comment) return comment[1] + span('comment', comment[2]);
			const pair = line.match(/^(\s*)([\w.-]+)(=)(.*)$/);
			if (!pair) return line;
			const [, indent, key, eq, value] = pair;
			return indent + span('key', key) + span('punct', eq) + highlightVars(span('string', value));
		})
		.join('\n');
}

export function highlightFor(fileName: string, text: string): string {
	if (/\.ya?ml$/i.test(fileName)) return highlightYaml(text);
	if (fileName === '.env' || /\.env$/i.test(fileName)) return highlightEnv(text);
	return escapeHtml(text);
}
