/**
 * A deliberately small YAML subset.
 *
 * The engine has zero third-party dependencies, which is its main portability
 * advantage, and a config file is not a good reason to give that up. This
 * handles exactly what `zeus init` writes: nested maps, lists of scalars,
 * lists of maps, strings, numbers, booleans, null and `#` comments. Anything
 * outside that subset is rejected loudly rather than half-understood.
 */

export type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };

function scalar(raw: string): Yaml {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  return v;
}

interface Line { indent: number; text: string; no: number }

function lines(src: string): Line[] {
  const out: Line[] = [];
  src.split('\n').forEach((raw, i) => {
    if (raw.includes('\t')) throw new Error(`config line ${i + 1}: tabs are not valid YAML indentation`);
    const text = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trimEnd();
    if (!text.trim()) return;
    out.push({ indent: text.length - text.trimStart().length, text: text.trim(), no: i + 1 });
  });
  return out;
}

function parseBlock(ls: Line[], start: number, indent: number): { value: Yaml; next: number } {
  if (start >= ls.length) return { value: null, next: start };
  const isList = ls[start].text.startsWith('- ') || ls[start].text === '-';

  if (isList) {
    const arr: Yaml[] = [];
    let i = start;
    while (i < ls.length && ls[i].indent === indent && (ls[i].text.startsWith('- ') || ls[i].text === '-')) {
      const rest = ls[i].text === '-' ? '' : ls[i].text.slice(2).trim();
      if (rest.includes(': ') || rest.endsWith(':')) {
        // A list of maps: re-read the item as a map whose first key is inline.
        const sub: Line[] = [{ indent: indent + 2, text: rest, no: ls[i].no }];
        let j = i + 1;
        while (j < ls.length && ls[j].indent > indent) { sub.push(ls[j]); j += 1; }
        arr.push(parseBlock(sub, 0, indent + 2).value);
        i = j;
      } else if (rest) {
        arr.push(scalar(rest)); i += 1;
      } else {
        const r = parseBlock(ls, i + 1, ls[i + 1]?.indent ?? indent + 2);
        arr.push(r.value); i = r.next;
      }
    }
    return { value: arr, next: i };
  }

  const map: { [k: string]: Yaml } = {};
  let i = start;
  while (i < ls.length && ls[i].indent === indent) {
    const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(ls[i].text);
    if (!m) throw new Error(`config line ${ls[i].no}: expected "key: value", got "${ls[i].text}"`);
    const key = m[1];
    const inline = m[2].trim();
    if (inline) { map[key] = scalar(inline); i += 1; continue; }
    const childIndent = ls[i + 1]?.indent ?? -1;
    if (childIndent > indent) {
      const r = parseBlock(ls, i + 1, childIndent);
      map[key] = r.value; i = r.next;
    } else { map[key] = null; i += 1; }
  }
  return { value: map, next: i };
}

export function parse(src: string): Yaml {
  const ls = lines(src);
  if (!ls.length) return {};
  return parseBlock(ls, 0, ls[0].indent).value;
}

function needsQuote(s: string): boolean {
  return s === '' || /^[\s]|[\s]$|[:#\[\]{}&*!|>'"%@`,]|^-|^(true|false|null|~)$|^-?\d+(\.\d+)?$/.test(s);
}

/**
 * `inlineFirst` omits the indent on the very first key, which is what a
 * list-of-maps item needs (`- key: value`). It must NOT apply to ordinary
 * nested maps, or the first key of every block loses its indentation and the
 * document no longer parses back.
 */
export function stringify(value: Yaml, indent = 0, inlineFirst = false): string {
  const pad = ' '.repeat(indent);
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return needsQuote(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value.map((v) => {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        return `${pad}- ${stringify(v, indent + 2, true)}`;
      }
      return `${pad}- ${stringify(v)}`;
    }).join('\n');
  }
  const keys = Object.keys(value);
  if (!keys.length) return '{}';
  return keys.map((k, n) => {
    const v = (value as any)[k];
    const prefix = n === 0 && inlineFirst ? '' : pad;
    if (v !== null && typeof v === 'object' && (!Array.isArray(v) || v.length)) {
      return `${prefix}${k}:\n${stringify(v, indent + 2)}`;
    }
    return `${prefix}${k}: ${stringify(v)}`;
  }).join('\n');
}
