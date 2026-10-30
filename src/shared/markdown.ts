// A tiny, safe Markdown subset for notes: **bold**, *italic*, `code` and [text](https://link).
// Only http(s) links are recognised; everything else stays plain text.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

const INLINE = /\*\*(.+?)\*\*|\*(?!\s)(.+?)\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const m of line.matchAll(INLINE)) {
    if (m.index > at) out.push({ kind: "text", text: line.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ kind: "bold", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "italic", text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: "code", text: m[3] });
    else out.push({ kind: "link", text: m[4]!, href: m[5]! });
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push({ kind: "text", text: line.slice(at) });
  return out;
}

/** True when `text` has anything the renderer would change (so the view can offer the toggle). */
export const hasMarkup = (text: string): boolean => text.split(/\r?\n/).some((l) => /^\s*[-*]\s|^#{1,3}\s/.test(l) || parseInline(l).some((i) => i.kind !== "text"));
