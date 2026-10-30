// Draws a QR code as an SVG (dark modules on a white ground in every theme, so scanners can read it).
import { qrMatrix } from "../shared/qr.ts";

const NS = "http://www.w3.org/2000/svg";
const QUIET = 4;

export function qrSvg(text: string, label: string): SVGSVGElement {
  const m = qrMatrix(text);
  const size = m.length + QUIET * 2;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("class", "qr");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  const ground = document.createElementNS(NS, "rect");
  ground.setAttribute("width", String(size));
  ground.setAttribute("height", String(size));
  ground.setAttribute("fill", "#fff");
  const dark = document.createElementNS(NS, "path");
  dark.setAttribute("fill", "#000");
  dark.setAttribute("d", m.flatMap((row, y) => row.flatMap((on, x) => (on ? [`M${x + QUIET} ${y + QUIET}h1v1h-1z`] : []))).join(""));
  svg.append(ground, dark);
  return svg;
}
