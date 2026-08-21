import { Dwg_File_Type, LibreDwg } from "@mlightcad/libredwg-web";

export type ExtractedBomItem = {
  itemName: string;
  partNo: string;
  dimensions: string;
  material: string;
  spec: string;
  qty: number;
  confidence: number;
  previewSvg?: string;
  drawingSvg?: string;
  drawingTexts?: Array<{ text: string; x: number; y: number }>;
};

type TextPoint = { x: number; y: number };
type TextEntry = { text: string; layer: string; point: TextPoint };
type DwgEntityLike = {
  type?: string;
  text?: string;
  textValue?: string;
  value?: string;
  plainText?: string;
  layer?: string;
  insertionPoint?: TextPoint;
  startPoint?: TextPoint;
  position?: TextPoint;
  location?: TextPoint;
  endPoint?: TextPoint;
  vertices?: TextPoint[];
  leaderSections?: Array<{ leaderLines?: Array<{ vertices?: TextPoint[] }> }>;
};

let parserPromise: Promise<LibreDwg> | null = null;

function normalizeCadText(value: string) {
  return value
    .replaceAll("%%C", "Ø")
    .replaceAll("%%D", "°")
    .replaceAll("\\P", " ")
    .replace(/\\[A-Za-z][^;]*;/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function textEntries(entities: DwgEntityLike[]): TextEntry[] {
  return entities.flatMap((entity) => {
    const raw = entity.text ?? entity.textValue ?? entity.value ?? entity.plainText;
    const point = entity.insertionPoint ?? entity.startPoint ?? entity.position ?? entity.location;
    if (typeof raw !== "string" || !raw.trim() || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return [];
    return [{ text: normalizeCadText(raw), layer: entity.layer ?? "", point }];
  });
}

function distance(a: TextPoint, b: TextPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function categoryKey(itemName: string) {
  const value = itemName.toUpperCase();
  if (value.includes("DAVIT")) return "DAVIT";
  if (value.includes("HANGER")) return "HANGER";
  if (value.includes("HANDLE")) return "HANDLE";
  if (value.includes("RUNG")) return "RUNG";
  return "OTHER";
}

function findPartCallout(entries: TextEntry[], itemName: string, partNo: string) {
  const key = categoryKey(itemName);
  const drawingEntries = entries.filter((entry) => !/LIST|BOM|PART/i.test(entry.layer));
  const callouts = drawingEntries.filter((entry) => entry.text === partNo);
  if (!callouts.length) return null;

  const labels = drawingEntries.filter((entry) => {
    const value = entry.text.toUpperCase();
    if (key === "OTHER") {
      const name = itemName.toUpperCase();
      return value.length >= 4 && (value.includes(name) || name.includes(value));
    }
    return key === "RUNG" ? value.includes("RUNG") : value.includes(key);
  });
  if (key === "OTHER" && !labels.length) return null;
  return callouts
    .map((entry) => ({ entry, labelDistance: Math.min(...labels.map((label) => distance(entry.point, label.point)), Number.POSITIVE_INFINITY) }))
    .sort((a, b) => a.labelDistance - b.labelDistance)[0].entry;
}

export function millimeterDimensions(value: string) {
  const seen = new Set<string>();
  return value
    .split(" · ")
    .flatMap((segment) => {
      const prefix = /(?:O\.D|I\.D|Ø)/i.test(segment) ? "Ø" : /(?:^|\s)R\s*\d/i.test(segment) ? "R" : "";
      return Array.from(segment.matchAll(/\[\s*(\d+(?:\.\d+)?)\s*\]/g), (match) => `${prefix}${match[1]} mm`);
    })
    .filter((dimension) => {
      if (seen.has(dimension)) return false;
      seen.add(dimension);
      return true;
    })
    .join(" · ");
}

function bomSpecDimensions(value: string) {
  const referenced = millimeterDimensions(value);
  if (referenced) return referenced;
  const dimensions = Array.from(value.matchAll(/(Ø|O\.D\s*)?(\d+)?\s*(?:(\d+)\s*\/\s*(\d+))?\s*"/gi), (match) => {
    const whole = Number.parseFloat(match[2] || "0");
    const numerator = Number.parseFloat(match[3] || "0");
    const denominator = Number.parseFloat(match[4] || "1");
    const millimeters = (whole + numerator / denominator) * 25.4;
    if (!Number.isFinite(millimeters) || millimeters <= 0) return "";
    const rounded = Number(millimeters.toFixed(2));
    return `${match[1] ? "Ø" : ""}${rounded} mm`;
  }).filter(Boolean);
  return Array.from(new Set(dimensions)).join(" · ");
}

function sanitizeSvg(svg: string) {
  return svg
    .replace(/<\?xml[^>]*>/gi, "")
    .replace(/<(script|foreignObject|iframe)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .replace(/\s(?:href|xlink:href)\s*=\s*(["'])(?!#)[\s\S]*?\1/gi, "")
    .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/gi, "&amp;");
}

type Segment = { start: TextPoint; end: TextPoint };

function pointDistanceToSegment(point: TextPoint, segment: Segment) {
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  if (dx === 0 && dy === 0) return distance(point, segment.start);
  const ratio = Math.max(0, Math.min(1, ((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy) / (dx * dx + dy * dy)));
  return distance(point, { x: segment.start.x + ratio * dx, y: segment.start.y + ratio * dy });
}

function entitySegments(entities: DwgEntityLike[]) {
  return entities.flatMap((entity): Segment[] => {
    if (entity.type === "LINE" && entity.startPoint && entity.endPoint) return [{ start: entity.startPoint, end: entity.endPoint }];
    const vertexGroups = entity.type === "MULTILEADER"
      ? (entity.leaderSections ?? []).flatMap((section) => (section.leaderLines ?? []).map((line) => line.vertices ?? []))
      : entity.vertices ? [entity.vertices] : [];
    return vertexGroups.flatMap((vertices) => vertices.slice(1).map((point, index) => ({ start: vertices[index], end: point })));
  });
}

function followLeaderTarget(callout: TextPoint, entities: DwgEntityLike[]) {
  const segments = entitySegments(entities).filter((segment) => distance(segment.start, segment.end) >= 4);
  const first = segments
    .filter((segment) => pointDistanceToSegment(callout, segment) <= 14)
    .sort((a, b) => pointDistanceToSegment(callout, a) - pointDistanceToSegment(callout, b) || distance(b.start, b.end) - distance(a.start, a.end))[0];
  if (!first) return callout;

  const visited = new Set<Segment>();
  const points = [first.start, first.end];
  const queue = [first];
  while (queue.length && visited.size < 24) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const endpoint of [current.start, current.end]) {
      const next = segments
        .filter((segment) => !visited.has(segment) && (distance(segment.start, endpoint) <= 0.8 || distance(segment.end, endpoint) <= 0.8))
        .sort((a, b) => distance(b.start, b.end) - distance(a.start, a.end))[0];
      if (next) {
        points.push(next.start, next.end);
        queue.push(next);
      }
    }
  }
  const target = points.sort((a, b) => distance(b, callout) - distance(a, callout))[0];
  return distance(target, callout) >= 18 ? target : callout;
}

export function partPreviewSvg(svg: string, entries: TextEntry[], entities: DwgEntityLike[], itemName: string, partNo: string) {
  const callout = findPartCallout(entries, itemName, partNo);
  if (!callout) return undefined;
  const key = categoryKey(itemName);
  const target = followLeaderTarget(callout.point, entities);
  const frame = key === "DAVIT" ? { width: 285, height: 245, offsetX: 0, offsetY: 0 }
    : key === "RUNG" ? { width: 285, height: 215, offsetX: 0, offsetY: -15 }
      : key === "HANDLE" ? { width: 270, height: 215, offsetX: 0, offsetY: -18 }
        : key === "HANGER" ? { width: 380, height: 335, offsetX: 0, offsetY: -55 }
          : { width: 300, height: 245, offsetX: 0, offsetY: 0 };
  const center = { x: target.x + frame.offsetX, y: target.y + frame.offsetY };
  const x = center.x - frame.width / 2;
  const y = -(center.y + frame.height / 2);
  return sanitizeSvg(svg).replace(/viewBox="[^"]+"/i, `viewBox="${x} ${y} ${frame.width} ${frame.height}"`);
}

function dimensionText(value: string) {
  if (!/\d/.test(value) || /DETAIL|SCALE|NOTE|TYP|FULL|HOLE|UNC|NPT|REF\.?|WITH|C\.L/i.test(value)) return false;
  if (/^t\s*/i.test(value) || /^\d+\/\d+"/.test(value) || /°/.test(value) || /^\d+$/.test(value)) return false;
  return /Ø|O\.D|I\.D|^R\s*\d|\d+\s*'-|\d+(?:\s+\d+\/\d+)?"|^\[[\d.]+\]$/.test(value);
}

function nearbyDimensions(entries: TextEntry[], itemName: string, partNo: string) {
  const key = categoryKey(itemName);
  const drawingEntries = entries.filter((entry) => !/LIST|BOM|PART/i.test(entry.layer));
  const callout = findPartCallout(entries, itemName, partNo);
  if (!callout) return "";
  const radius = key === "DAVIT" ? 210 : key === "RUNG" ? 82 : key === "HANDLE" ? 68 : key === "HANGER" ? 52 : 90;
  const minX = key === "DAVIT" ? Number.NEGATIVE_INFINITY : callout.point.x - (key === "RUNG" ? 10 : 20);
  const candidates = drawingEntries
    .filter((entry) => entry !== callout && entry.point.x >= minX && distance(entry.point, callout.point) <= radius && dimensionText(entry.text))
    .map((entry) => ({ ...entry, distance: distance(entry.point, callout.point) }));
  const bracketOnly = candidates.filter((entry) => /^\[[\d.]+\]$/.test(entry.text));
  const usedBrackets = new Set<TextEntry>();
  const merged = candidates.flatMap((entry) => {
    if (/^\[[\d.]+\]$/.test(entry.text)) return [];
    const partner = bracketOnly
      .filter((candidate) => !usedBrackets.has(candidate) && Math.abs(candidate.point.y - entry.point.y) <= 5 && distance(candidate.point, entry.point) <= 10)
      .sort((a, b) => distance(a.point, entry.point) - distance(b.point, entry.point))[0];
    const millimeters = Number.parseFloat(entry.text.match(/\[([\d.]+)\]/)?.[1] ?? partner?.text.match(/[\d.]+/)?.[0] ?? "");
    const isPrimaryDavitDimension = /O\.D|^R\s*\d|\d+\s*'-/.test(entry.text);
    if (key === "DAVIT" && !isPrimaryDavitDimension && (!Number.isFinite(millimeters) || millimeters < 100)) return [];
    if (partner) usedBrackets.add(partner);
    return [{ text: `${entry.text}${partner ? ` ${partner.text}` : ""}`, distance: entry.distance }];
  });
  const uniqueDimensions = Array.from(new Map(merged.sort((a, b) => a.distance - b.distance).map((entry) => [entry.text, entry])).values());
  if (key === "DAVIT") {
    const diameter = uniqueDimensions.find((entry) => /O\.D|Ø/i.test(entry.text));
    const bendRadius = uniqueDimensions.find((entry) => /^R\s*\d/i.test(entry.text));
    const overallDimensions = uniqueDimensions
      .filter((entry) => entry !== diameter && entry !== bendRadius)
      .flatMap((entry) => Array.from(entry.text.matchAll(/\[\s*(\d+(?:\.\d+)?)\s*\]/g), (match) => Number.parseFloat(match[1])))
      .filter((value) => value >= 300 && value <= 950)
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort((a, b) => b - a)
      .slice(0, 2)
      .sort((a, b) => a - b)
      .map((value) => `${value} mm`);
    return [
      diameter ? millimeterDimensions(diameter.text) : "",
      bendRadius ? millimeterDimensions(bendRadius.text) : "",
      ...overallDimensions,
    ].filter(Boolean).join(" · ");
  }
  const dimensions = uniqueDimensions.slice(0, 7).map((entry) => entry.text).join(" · ");
  return millimeterDimensions(dimensions);
}

export function extractItemsFromTexts(entries: TextEntry[]): ExtractedBomItem[] {
  const normalizedEntries = entries.map((entry) => ({ ...entry, text: normalizeCadText(entry.text) }));
  const listLayer = normalizedEntries.filter((entry) => /LIST|BOM|PART/i.test(entry.layer));
  const scope = listLayer.length >= 8 ? listLayer : normalizedEntries;
  const units = scope.filter((entry) => /^(EA|SET|SETS|PCS?|PC)$/i.test(entry.text));

  return units.flatMap((unit) => {
    const row = scope
      .filter((entry) => Math.abs(entry.point.y - unit.point.y) <= 1.4)
      .sort((a, b) => a.point.x - b.point.x);
    const item = row
      .filter((entry) => /^\d{1,3}$/.test(entry.text) && entry.point.x < unit.point.x)
      .sort((a, b) => a.point.x - b.point.x)[0];
    if (!item) return [];
    const name = row.find((entry) => entry.point.x > item.point.x && entry.point.x < unit.point.x && !/^\d+(?:\s*[xX×]\s*\d+)?$/.test(entry.text));
    if (!name || /^(Q'?TY|SP\d*|MATERIAL)$/i.test(name.text)) return [];

    const between = row.filter((entry) => entry.point.x > name.point.x && entry.point.x < unit.point.x);
    const qtyIndex = between.findIndex((entry) => /^\d+(?:\s*[xX×]\s*\d+)?$/.test(entry.text));
    const qtyEntry = qtyIndex >= 0 ? between[qtyIndex] : undefined;
    const materialEntries = between.slice(0, qtyIndex >= 0 ? qtyIndex : between.length).filter((entry) => !/^\d+$/.test(entry.text));
    const specEntries = row.filter((entry) => entry.point.x > unit.point.x);
    const material = materialEntries.map((entry) => entry.text).join(" ").trim();
    const spec = specEntries.map((entry) => entry.text).join(" ").trim();
    const qty = Number.parseInt(qtyEntry?.text ?? "1", 10) || 1;
    const confidence = material && spec && qtyEntry ? 97 : material || spec ? 91 : 82;
    const drawingDimensions = nearbyDimensions(normalizedEntries, name.text, item.text);

    return [{ itemName: name.text, partNo: item.text, dimensions: drawingDimensions || bomSpecDimensions(`${name.text} ${spec}`), material, spec, qty, confidence }];
  });
}

export async function extractDwgBom(file: File): Promise<ExtractedBomItem[]> {
  parserPromise ??= LibreDwg.create("/libredwg");
  const parser = await parserPromise;
  const buffer = await file.arrayBuffer();
  const raw = parser.dwg_read_data(buffer, Dwg_File_Type.DWG);
  if (raw === undefined) {
    throw new Error("DWG 파일을 읽지 못했습니다.");
  }
  try {
    const database = parser.convert(raw) as { entities?: DwgEntityLike[] };
    const entries = textEntries(database.entities ?? []);
    const items = extractItemsFromTexts(entries);
    const svg = parser.dwg_to_svg(database as never);
    const drawingSvg = sanitizeSvg(svg);
    const drawingTexts = entries
      .filter((entry) => /\d/.test(entry.text))
      .map((entry) => ({ text: entry.text, x: entry.point.x, y: -entry.point.y }));
    return items.map((item) => ({
      ...item,
      previewSvg: partPreviewSvg(svg, entries, database.entities ?? [], item.itemName, item.partNo),
      drawingSvg,
      drawingTexts,
    }));
  } finally {
    parser.dwg_free(raw);
  }
}
