// Stroke icons on one grid: 24x24 viewBox, ~20px live area, 1.5px round strokes, 2px joins.
// Every row/field reserves the same 18px slot, so labels start on a single vertical line.
const NS = "http://www.w3.org/2000/svg";

type Shape =
  | string
  | { d: string; fill?: boolean }
  | { rect: readonly [number, number, number, number, number] }
  | { circle: readonly [number, number, number]; fill?: boolean };

interface IconDef {
  /** Stroke width for this glyph; geometry-heavy icons read better slightly lighter. */
  w?: number;
  shapes: Shape[];
}

const icons = {
  shield: { shapes: ["M12 3.25 19 6v5.2c0 4.4-2.9 8.05-7 9.8-4.1-1.75-7-5.4-7-9.8V6l7-2.75Z"] },
  server: { shapes: [{ rect: [4, 4, 16, 6, 2] }, { rect: [4, 14, 16, 6, 2] }, { circle: [8, 7, 0.8], fill: true }, { circle: [8, 17, 0.8], fill: true }] },
  mail: { shapes: [{ rect: [3, 5, 18, 14, 2.5] }, "m3.9 7.4 8.1 5.6 8.1-5.6"] },
  lock: { shapes: [{ rect: [4.5, 10.5, 15, 9.75, 2.25] }, "M8.5 10.5V7.75a3.5 3.5 0 0 1 7 0v2.75", { circle: [12, 15.4, 0.9], fill: true }] },
  unlock: { shapes: [{ rect: [4.5, 10.5, 15, 9.75, 2.25] }, "M8.5 10.5V7.75a3.5 3.5 0 0 1 6.8-1.2", { circle: [12, 15.4, 0.9], fill: true }] },
  key: { shapes: [{ circle: [15.5, 8.5, 3.5] }, "M13 11 4.5 19.5V21H6v-1.5h1.5V18H9l4-4"] },
  eye: { shapes: ["M2.75 12S6.25 5.75 12 5.75 21.25 12 21.25 12 17.75 18.25 12 18.25 2.75 12 2.75 12Z", { circle: [12, 12, 3] }] },
  eyeOff: {
    shapes: [
      "M3.5 3.5l17 17",
      "M10.2 5.15A9.9 9.9 0 0 1 12 5c5.75 0 9.25 7 9.25 7a17.6 17.6 0 0 1-3.4 4.3",
      "M6.5 6.6A17.4 17.4 0 0 0 2.75 12s3.5 7 9.25 7a9.9 9.9 0 0 0 5.2-1.5",
      "M9.9 9.9a3 3 0 0 0 4.2 4.2",
    ],
  },
  search: { shapes: [{ circle: [10.75, 10.75, 6.25] }, "m15.5 15.5 4.5 4.5"] },
  home: { shapes: ["M4 10.5 12 4l8 6.5v8.75a1.25 1.25 0 0 1-1.25 1.25H5.25A1.25 1.25 0 0 1 4 19.25V10.5Z"] },
  settings: {
    shapes: [
      { circle: [12, 12, 2.9] },
      "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
    ],
  },
  logout: { shapes: ["M9 4.75H5.75A1.75 1.75 0 0 0 4 6.5v11a1.75 1.75 0 0 0 1.75 1.75H9", "M15.5 8.5 19 12l-3.5 3.5", "M19 12H9.5"] },
  back: { shapes: ["M14.5 5.5 8 12l6.5 6.5"] },
  chevron: { shapes: ["M9.5 5.5 16 12l-6.5 6.5"] },
  chevronDown: { shapes: ["M5.5 9.5 12 16l6.5-6.5"] },
  error: { shapes: [{ circle: [12, 12, 8.25] }, "M12 7.5V13", { circle: [12, 16.6, 0.95], fill: true }] },
  timer: { shapes: [{ circle: [12, 12, 8.25] }, "M12 7.25V12l3.1 1.9"] },
  phone: { shapes: [{ rect: [6.5, 2.75, 11, 18.5, 2.5] }, "M10.25 18.25h3.5"] },
  vault: { shapes: [{ rect: [3.5, 4.5, 17, 15, 2] }, { circle: [12, 12, 3.25] }, "M12 8.75v-1M12 16.25v-1"] },
  user: { shapes: [{ circle: [12, 8.25, 3.75] }, "M4.75 20.25a7.25 7.25 0 0 1 14.5 0"] },
  copy: { shapes: [{ rect: [8.5, 8.5, 11.5, 11.5, 2] }, "M15.5 5.5H6.25A1.75 1.75 0 0 0 4.5 7.25v9.25"] },
  plus: { shapes: ["M12 5v14M5 12h14"] },
  refresh: { shapes: ["M20 12a8 8 0 1 1-2.35-5.65", "M20 4.5V10h-5.5"] },
  edit: { shapes: ["M4.5 19.5h4.25L19.6 8.4a2.05 2.05 0 0 0-2.9-2.9L5.5 16.5v3Z", "m14.75 6.5 2.75 2.75"] },
  trash: {
    shapes: ["M4.5 7h15", "M9.5 7V4.5h5V7", "M6.75 7l.85 11.9a1.35 1.35 0 0 0 1.35 1.25h6.1a1.35 1.35 0 0 0 1.35-1.25L17.25 7", "M10.5 11v5.5M13.5 11v5.5"],
  },
  star: { shapes: ["M12 3.75l2.55 5.2 5.7.85-4.1 4 1 5.7L12 16.8l-5.15 2.7 1-5.7-4.1-4 5.7-.85L12 3.75Z"] },
  globe: {
    shapes: [{ circle: [12, 12, 8.25] }, "M3.75 12h16.5", "M12 3.75c2.3 2.3 3.6 5.2 3.6 8.25S14.3 18 12 20.25C9.7 18 8.4 15.05 8.4 12S9.7 6.05 12 3.75Z"],
  },
  folder: { shapes: ["M3.75 6.5A1.25 1.25 0 0 1 5 5.25h3.9l2 2h9.1a1.25 1.25 0 0 1 1.25 1.25v10a1.25 1.25 0 0 1-1.25 1.25H5a1.25 1.25 0 0 1-1.25-1.25v-12Z"] },
  note: { shapes: [{ rect: [4.5, 3.5, 15, 17, 2.25] }, "M8.25 8.75h7.5M8.25 12.25h7.5M8.25 15.75h4.5"] },
  dice: {
    shapes: [
      { rect: [3.75, 3.75, 16.5, 16.5, 3.5] },
      { circle: [8.5, 8.5, 1.15], fill: true },
      { circle: [15.5, 8.5, 1.15], fill: true },
      { circle: [12, 12, 1.15], fill: true },
      { circle: [8.5, 15.5, 1.15], fill: true },
      { circle: [15.5, 15.5, 1.15], fill: true },
    ],
  },
  send: { shapes: ["M20.25 3.75 3.75 10.4l6.85 2.5 2.5 6.85 7.15-16Z", "m10.6 13 3.4-3.4"] },
  card: { shapes: [{ rect: [3, 5.5, 18, 13, 2.5] }, "M3 10h18", "M6.5 14.5h4"] },
  close: { shapes: ["M6 6l12 12M18 6 6 18"] },
  panel: { shapes: [{ rect: [3.5, 4, 17, 16, 2] }, "M15 4v16"] },
  attach: {
    shapes: ["M19.25 11.25l-8.1 8.1a4.5 4.5 0 0 1-6.36-6.36l8.1-8.1a3 3 0 0 1 4.24 4.24l-8.1 8.1a1.5 1.5 0 0 1-2.12-2.12l7.35-7.35"],
  },
  download: { shapes: ["M12 3.75V15M7.5 10.5 12 15l4.5-4.5M4.5 20.25h15"] },
  check: { w: 1.75, shapes: ["M4.75 12.5 9.5 17.25 19.25 6.75"] },
  info: { shapes: [{ circle: [12, 12, 8.25] }, "M12 11v5.25", { circle: [12, 7.9, 0.95], fill: true }] },
  sort: { shapes: ["M4 7h9M4 12h6M4 17h3.5", "M17 4.5V19M13.5 15.5 17 19l3.5-3.5"] },
  filter: { shapes: ["M3.75 5.5h16.5l-6.5 7.75v6l-3.5 1.5v-7.5L3.75 5.5Z"] },
  more: { shapes: [{ circle: [6, 12, 1.3], fill: true }, { circle: [12, 12, 1.3], fill: true }, { circle: [18, 12, 1.3], fill: true }] },
  external: { shapes: ["M13.5 4.5h6v6", "M19.5 4.5 11 13", "M18 13.75v4.5a1.75 1.75 0 0 1-1.75 1.75h-10A1.75 1.75 0 0 1 4.5 18.25v-10A1.75 1.75 0 0 1 6.25 6.5h4.5"] },
} satisfies Record<string, IconDef>;

export type IconName = keyof typeof icons;

function shapeEl(shape: Shape): SVGElement {
  const el = typeof shape === "string" ? document.createElementNS(NS, "path") : null;
  if (el) {
    el.setAttribute("d", shape as string);
    return el;
  }
  const s = shape as Exclude<Shape, string>;
  if ("rect" in s) {
    const rect = document.createElementNS(NS, "rect");
    const [x, y, w, h, r] = s.rect;
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(w));
    rect.setAttribute("height", String(h));
    rect.setAttribute("rx", String(r));
    return rect;
  }
  if ("circle" in s) {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", String(s.circle[0]));
    c.setAttribute("cy", String(s.circle[1]));
    c.setAttribute("r", String(s.circle[2]));
    if (s.fill) {
      c.setAttribute("fill", "currentColor");
      c.setAttribute("stroke", "none");
    }
    return c;
  }
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", s.d);
  if (s.fill) {
    path.setAttribute("fill", "currentColor");
    path.setAttribute("stroke", "none");
  }
  return path;
}

export function icon(name: IconName, label?: string): SVGSVGElement {
  const def: IconDef = icons[name];
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "i");
  if (def.w) svg.style.strokeWidth = String(def.w);
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else svg.setAttribute("aria-hidden", "true");
  svg.append(...def.shapes.map(shapeEl));
  return svg;
}
