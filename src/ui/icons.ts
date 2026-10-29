// Stroke icons (24x24), drawn for Plugwarden.
const paths = {
  shield: "M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z M9 12l2 2 4-4",
  server: "M4 5h16v6H4z M4 13h16v6H4z M8 8h.01 M8 16h.01",
  mail: "M3 6h18v12H3z M3 7l9 6 9-6",
  lock: "M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  unlock: "M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 6.8-1.2",
  key: "M14.5 9.5a4 4 0 1 1-1 4.2L4 21v-3h2v-2h2l3-3",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M3 3l18 18 M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4 M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6 M9.9 9.9a3 3 0 0 0 4.2 4.2",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M21 21l-5-5",
  home: "M3 11l9-7 9 7v9h-6v-6H9v6H3z",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4z",
  logout: "M15 4h4v16h-4 M10 8l-4 4 4 4 M6 12h10",
  back: "M15 5l-7 7 7 7",
  error: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v6 M12 16.5h.01",
  timer: "M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M12 9v4l2.5 2.5 M9.5 2.5h5",
  phone: "M7 3h10v18H7z M11 18h2",
  vault: "M4 5h16v14H4z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M12 9v-1 M12 16v-1 M8 19v2 M16 19v2",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0",
  copy: "M9 9h11v11H9z M5 15H4V4h11v1",
  plus: "M12 5v14 M5 12h14",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7",
  edit: "M4 20h4L19 9l-4-4L4 16z M14 6l4 4",
  trash: "M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3a14 14 0 0 1 0 18 M12 3a14 14 0 0 0 0 18",
  folder: "M3 6h6l2 2h10v11H3z",
  note: "M5 4h14v16H5z M8 9h8 M8 13h8 M8 17h5",
  dice: "M4 4h16v16H4z M8.5 8.5h.01 M15.5 8.5h.01 M12 12h.01 M8.5 15.5h.01 M15.5 15.5h.01",
  send: "M3 11l18-8-8 18-2-8z M11 13l10-10",
  card: "M3 6h18v12H3z M3 10h18 M7 15h4",
  chevron: "M9 6l6 6-6 6",
  close: "M6 6l12 12 M18 6L6 18",
  panel: "M4 4h16v16H4z M15 4v16",
  attach: "M20 11l-8 8a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7",
} as const;

export type IconName = keyof typeof paths;

const NS = "http://www.w3.org/2000/svg";

export function icon(name: IconName, label?: string): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "i");
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", paths[name]);
  svg.append(p);
  return svg;
}
