// Renders the Markdown subset of shared/markdown.ts (plus headings and lists) from DOM nodes only, never innerHTML.
import { type Inline, parseInline } from "../shared/markdown.ts";
import { h } from "./dom.ts";

const link = ({ text, href }: { text: string; href: string }) =>
  h("a", { href, target: "_blank", rel: "noopener noreferrer", onclick: (e: Event) => (e.preventDefault(), void chrome.tabs.create({ url: href })) }, text);

const inlineNode = (i: Inline): Node | string =>
  i.kind === "text" ? i.text
  : i.kind === "bold" ? h("strong", {}, i.text)
  : i.kind === "italic" ? h("em", {}, i.text)
  : i.kind === "code" ? h("code", {}, i.text)
  : link(i);

/** Renders `text` block by block: `# heading`, `- item` runs and plain paragraphs. */
export function renderMarkdown(text: string): HTMLElement {
  const root = h("div", { class: "notes md" });
  let list: HTMLElement | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      list ??= root.appendChild(h("ul"));
      list.append(h("li", {}, ...parseInline(bullet[1]!).map(inlineNode)));
      continue;
    }
    list = undefined;
    const heading = /^#{1,3}\s+(.*)$/.exec(raw);
    if (heading) root.append(h("h3", {}, ...parseInline(heading[1]!).map(inlineNode)));
    else root.append(h("p", {}, ...parseInline(raw).map(inlineNode)));
  }
  return root;
}
