"use client";

import { ChangeEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent, useEffect, useMemo, useRef, useState } from "react";
import { extractDwgBom } from "./lib/dwgBom";

type Part = {
  id: number;
  selected: boolean;
  category: "DAVIT" | "HANDLE" | "RUNG" | "HANGER" | "OTHER";
  itemName: string;
  drawingNo: string;
  partNo: string;
  dimensions: string;
  spec: string;
  material: string;
  qty: number;
  confidence: number;
  sourceName: string;
  previewSvg?: string;
  drawingSvg?: string;
  drawingTexts?: Array<{ text: string; x: number; y: number }>;
};

type DetailSelection = { pointerId: number; startX: number; startY: number; endX: number; endY: number };
type SelectionBox = { x: number; y: number; width: number; height: number };
type SvgViewBox = { x: number; y: number; width: number; height: number };

function readSvgViewBox(svg: string): SvgViewBox | null {
  const match = svg.match(/viewBox=["']\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)["']/i);
  if (!match) return null;
  const values = match.slice(1).map(Number);
  return values.every(Number.isFinite) && values[2] > 0 && values[3] > 0
    ? { x: values[0], y: values[1], width: values[2], height: values[3] }
    : null;
}

function replaceSvgViewBox(svg: string, viewBox: SvgViewBox) {
  return svg.replace(/viewBox=["'][^"']+["']/i, `viewBox="${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}"`);
}

function formatMillimeter(value: number, prefix = "") {
  const rounded = Number(value.toFixed(2));
  return `${prefix}${rounded} mm`;
}

function millimetersFromCadText(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  if (!/\d/.test(text) || /DETAIL|SCALE|NOTE|ITEM|Q'?TY|MATERIAL|PART CODE/i.test(text)) return [];
  const prefix = /O\.D|I\.D|Ø|��/i.test(text) ? "Ø" : /^\s*R\s*\d/i.test(text) ? "R" : "";
  const bracketed = Array.from(text.matchAll(/\[\s*(\d+(?:\.\d+)?)\s*\]/g), (match) => formatMillimeter(Number(match[1]), prefix));
  if (bracketed.length) return bracketed;
  const explicit = Array.from(text.matchAll(/(\d+(?:\.\d+)?)\s*mm/gi), (match) => formatMillimeter(Number(match[1]), prefix));
  if (explicit.length) return explicit;
  const feetAndInches = text.match(/(\d+)\s*'\s*-\s*(\d+)(?:\s+(\d+)\s*\/\s*(\d+))?\s*"/);
  if (feetAndInches) {
    const inches = Number(feetAndInches[1]) * 12 + Number(feetAndInches[2]) + Number(feetAndInches[3] ?? 0) / Number(feetAndInches[4] ?? 1);
    return [formatMillimeter(inches * 25.4, prefix)];
  }
  const inches = text.match(/(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)\s*"/) ?? text.match(/(\d+(?:\.\d+)?)\s*"/);
  if (!inches) return [];
  const inchValue = inches.length === 4
    ? Number(inches[1] ?? 0) + Number(inches[2]) / Number(inches[3])
    : Number(inches[1]);
  return Number.isFinite(inchValue) ? [formatMillimeter(inchValue * 25.4, prefix)] : [];
}

function Shape({ part, compact = false }: { part: Part; compact?: boolean }) {
  return <span className={`shape-2d shape-${part.category.toLowerCase()} ${compact ? "compact" : ""}`} role="img" aria-label={`${part.itemName} ${part.category === "OTHER" ? "CAD BOM 품목" : "견적 LIST 기준 형상"}`}><i /><i /><i /></span>;
}

function getDrawingNo(fileName: string, index: number) {
  const markerMatch = fileName.match(/-DWG-([A-Z0-9]+-\d{4})/i);
  if (markerMatch) return markerMatch[1].toUpperCase();
  const numberMatch = fileName.match(/([A-Z0-9]{5,}-\d{4})/i);
  return numberMatch ? numberMatch[1].toUpperCase() : `DWG-${String(index + 1).padStart(3, "0")}`;
}

function getCategory(itemName: string): Part["category"] {
  const value = itemName.toUpperCase();
  if (value.includes("DAVIT")) return "DAVIT";
  if (value.includes("HANGER")) return "HANGER";
  if (value.includes("HANDLE")) return "HANDLE";
  if (value.includes("RUNG")) return "RUNG";
  return "OTHER";
}

export default function Home() {
  const [parts, setParts] = useState<Part[]>([]);
  const [cadFiles, setCadFiles] = useState<File[]>([]);
  const [analysisErrors, setAnalysisErrors] = useState<string[]>([]);
  const [status, setStatus] = useState<"empty" | "ready" | "analyzing" | "done">("empty");
  const [activeTab, setActiveTab] = useState<"parts" | "request">("parts");
  const [project, setProject] = useState("");
  const [supplier, setSupplier] = useState("");
  const [detailPart, setDetailPart] = useState<Part | null>(null);
  const [detailMode, setDetailMode] = useState<"part" | "drawing">("part");
  const [detailView, setDetailView] = useState({ scale: 1, x: 0, y: 0 });
  const [detailDragging, setDetailDragging] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectionTool, setSelectionTool] = useState<"pan" | "select">("pan");
  const [detailSelection, setDetailSelection] = useState<SelectionBox | null>(null);
  const [selectionMessage, setSelectionMessage] = useState("");
  const detailDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const detailSelectionRef = useRef<DetailSelection | null>(null);
  const drawingStageRef = useRef<HTMLDivElement>(null);
  const cadRef = useRef<HTMLInputElement>(null);

  const detailSvg = useMemo(() => {
    if (!detailPart) return "";
    return detailMode === "drawing" ? detailPart.drawingSvg ?? "" : detailPart.previewSvg ?? "";
  }, [detailPart, detailMode]);
  const detailBaseViewBox = useMemo(() => readSvgViewBox(detailSvg), [detailSvg]);
  const renderedDetailSvg = useMemo(() => {
    if (!detailSvg || !detailBaseViewBox) return detailSvg;
    const width = detailBaseViewBox.width / detailView.scale;
    const height = detailBaseViewBox.height / detailView.scale;
    return replaceSvgViewBox(detailSvg, {
      x: detailBaseViewBox.x + (detailBaseViewBox.width - width) / 2 + detailView.x,
      y: detailBaseViewBox.y + (detailBaseViewBox.height - height) / 2 + detailView.y,
      width,
      height,
    });
  }, [detailSvg, detailBaseViewBox, detailView]);

  useEffect(() => {
    if (!detailPart) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailPart(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [detailPart]);

  const resetDetailInteraction = () => {
    setDetailView({ scale: 1, x: 0, y: 0 });
    setDetailDragging(false);
    setDetailSelection(null);
    setSelectionMessage("");
    detailDragRef.current = null;
    detailSelectionRef.current = null;
  };

  const openDetailPart = (part: Part) => {
    setDetailPart(part);
    setDetailMode("part");
    setSelectionMode(false);
    setSelectionTool("pan");
    resetDetailInteraction();
  };

  const changeDetailMode = (mode: "part" | "drawing") => {
    setDetailMode(mode);
    setSelectionMode(false);
    setSelectionTool("pan");
    resetDetailInteraction();
  };

  const setDetailScale = (scale: number) => {
    setDetailView((current) => ({ ...current, scale: Math.min(8, Math.max(0.5, scale)) }));
    if (selectionMode) {
      setDetailSelection(null);
      setSelectionMessage(selectionTool === "pan" ? "확대·이동 후 영역 선택을 누르세요." : "확대 위치를 맞춘 뒤 제품과 주변 치수선을 드래그하세요.");
    }
  };

  const handleDetailWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!detailSvg) return;
    event.preventDefault();
    setDetailView((current) => ({ ...current, scale: Math.min(8, Math.max(0.5, current.scale * (event.deltaY < 0 ? 1.12 : 0.89))) }));
    if (selectionMode) {
      setDetailSelection(null);
      setSelectionMessage(selectionTool === "pan" ? "확대·이동 후 영역 선택을 누르세요." : "확대 위치를 맞춘 뒤 제품과 주변 치수선을 드래그하세요.");
    }
  };

  const startDetailDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!detailSvg || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (selectionMode && selectionTool === "select" && detailMode === "drawing") {
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      detailSelectionRef.current = { pointerId: event.pointerId, startX: x, startY: y, endX: x, endY: y };
      setDetailSelection({ x, y, width: 0, height: 0 });
      setSelectionMessage("제품과 주변 치수선을 포함해 영역을 지정하세요.");
      return;
    }
    detailDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: detailView.x, originY: detailView.y };
    setDetailDragging(true);
  };

  const moveDetailDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const selection = detailSelectionRef.current;
    if (selection?.pointerId === event.pointerId) {
      const bounds = event.currentTarget.getBoundingClientRect();
      selection.endX = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
      selection.endY = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
      setDetailSelection({
        x: Math.min(selection.startX, selection.endX),
        y: Math.min(selection.startY, selection.endY),
        width: Math.abs(selection.endX - selection.startX),
        height: Math.abs(selection.endY - selection.startY),
      });
      return;
    }
    const drag = detailDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    setDetailView((current) => {
      if (!detailBaseViewBox) return { ...current, x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY };
      const visibleWidth = detailBaseViewBox.width / current.scale;
      const visibleHeight = detailBaseViewBox.height / current.scale;
      return {
        ...current,
        x: drag.originX - (event.clientX - drag.startX) * visibleWidth / bounds.width,
        y: drag.originY - (event.clientY - drag.startY) * visibleHeight / bounds.height,
      };
    });
  };

  const readSelectedDimensions = (canvas: HTMLDivElement, box: SelectionBox) => {
    if (box.width < 8 || box.height < 8 || !drawingStageRef.current) {
      setSelectionMessage("조금 더 넓게 드래그해 주세요.");
      return;
    }
    const canvasBounds = canvas.getBoundingClientRect();
    const margin = 48;
    const selectedBounds = {
      left: canvasBounds.left + box.x - margin,
      top: canvasBounds.top + box.y - margin,
      right: canvasBounds.left + box.x + box.width + margin,
      bottom: canvasBounds.top + box.y + box.height + margin,
    };
    const selectionCenter = { x: (selectedBounds.left + selectedBounds.right) / 2, y: (selectedBounds.top + selectedBounds.bottom) / 2 };
    const rootSvg = drawingStageRef.current.querySelector("svg");
    const screenMatrix = rootSvg?.getScreenCTM();
    const sourceMatches = rootSvg && screenMatrix && detailPart?.drawingTexts
      ? detailPart.drawingTexts.flatMap((entry) => {
        const screenPoint = Array.from(new Set([entry.y, -entry.y])).map((y) => {
          const point = rootSvg.createSVGPoint();
          point.x = entry.x;
          point.y = y;
          return point.matrixTransform(screenMatrix);
        }).find((point) => point.x >= selectedBounds.left && point.x <= selectedBounds.right && point.y >= selectedBounds.top && point.y <= selectedBounds.bottom);
        if (!screenPoint) return [];
        const centerDistance = Math.hypot(screenPoint.x - selectionCenter.x, screenPoint.y - selectionCenter.y);
        return millimetersFromCadText(entry.text).map((value) => ({ value, centerDistance }));
      })
      : [];
    const domMatches = Array.from(drawingStageRef.current.querySelectorAll("text"))
      .flatMap((element) => {
        const bounds = element.getBoundingClientRect();
        const overlaps = bounds.right >= selectedBounds.left && bounds.left <= selectedBounds.right && bounds.bottom >= selectedBounds.top && bounds.top <= selectedBounds.bottom;
        if (!overlaps) return [];
        const values = millimetersFromCadText(element.textContent ?? "");
        const centerDistance = Math.hypot(bounds.left + bounds.width / 2 - selectionCenter.x, bounds.top + bounds.height / 2 - selectionCenter.y);
        return values.map((value) => ({ value, centerDistance }));
      });
    const matches = [...sourceMatches, ...domMatches]
      .sort((a, b) => a.centerDistance - b.centerDistance);
    const dimensions = Array.from(new Set(matches.map((match) => match.value))).slice(0, 12);
    if (!dimensions.length) {
      setSelectionMessage("선택 영역에서 치수를 찾지 못했습니다. 제품과 치수 문자를 함께 선택해 주세요.");
      return;
    }
    updateDetailDimension(dimensions.join(" · "));
    setSelectionMessage(`${dimensions.length}개 치수를 가져왔습니다. 필요하면 아래 치수 칸에서 수정하세요.`);
  };

  const endDetailDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const selection = detailSelectionRef.current;
    if (selection?.pointerId === event.pointerId) {
      const box = {
        x: Math.min(selection.startX, selection.endX),
        y: Math.min(selection.startY, selection.endY),
        width: Math.abs(selection.endX - selection.startX),
        height: Math.abs(selection.endY - selection.startY),
      };
      setDetailSelection(box);
      readSelectedDimensions(event.currentTarget, box);
      detailSelectionRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (detailDragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    detailDragRef.current = null;
    setDetailDragging(false);
  };

  const resetDetailView = () => {
    setDetailView({ scale: 1, x: 0, y: 0 });
    if (selectionMode) {
      setDetailSelection(null);
      setSelectionMessage(selectionTool === "pan" ? "화면을 맞췄습니다. 확대·이동 후 영역 선택을 누르세요." : "화면을 맞췄습니다. 제품과 주변 치수선을 드래그하세요.");
    }
  };
  const toggleDirectSelection = () => {
    if (!detailPart?.drawingSvg) return;
    if (detailMode !== "drawing") resetDetailInteraction();
    const nextSelectionMode = !selectionMode;
    setDetailMode("drawing");
    setSelectionMode(nextSelectionMode);
    setSelectionTool("pan");
    setDetailSelection(null);
    setSelectionMessage(nextSelectionMode ? "휠로 확대하고 드래그로 이동한 뒤, 영역 선택을 누르세요." : "");
  };
  const changeSelectionTool = (tool: "pan" | "select") => {
    setSelectionTool(tool);
    setDetailSelection(null);
    setSelectionMessage(tool === "pan" ? "휠로 확대하고 도면을 드래그해 제품 위치로 이동하세요." : "제품과 주변 치수 문자를 포함해 드래그하세요.");
  };

  const selected = useMemo(() => parts.filter((part) => part.selected), [parts]);
  const totalQty = selected.reduce((sum, part) => sum + part.qty, 0);
  const averageConfidence = parts.length ? (parts.reduce((sum, part) => sum + part.confidence, 0) / parts.length).toFixed(1) : "0.0";

  const chooseFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    setCadFiles((current) => {
      const merged = [...current, ...files];
      return merged.filter((file, index) => merged.findIndex((candidate) => candidate.name === file.name && candidate.size === file.size && candidate.lastModified === file.lastModified) === index);
    });
    setParts([]);
    setAnalysisErrors([]);
    setActiveTab("parts");
    setStatus("ready");
    event.target.value = "";
  };

  const analyze = async () => {
    if (!cadFiles.length) return;
    setStatus("analyzing");
    setAnalysisErrors([]);
    const extracted: Part[] = [];
    const errors: string[] = [];
    let nextId = 1;
    for (const [fileIndex, file] of cadFiles.entries()) {
      try {
        const items = await extractDwgBom(file);
        if (!items.length) {
          errors.push(`${file.name}: BOM 성형품 행을 찾지 못했습니다.`);
          continue;
        }
        for (const item of items) {
          const category = getCategory(item.itemName);
          extracted.push({
            id: nextId++,
            selected: category !== "OTHER",
            category,
            itemName: item.itemName,
            drawingNo: getDrawingNo(file.name, fileIndex),
            partNo: item.partNo,
            dimensions: item.dimensions,
            spec: item.spec,
            material: item.material,
            qty: item.qty,
            confidence: item.dimensions ? item.confidence : Math.min(item.confidence, 89),
            sourceName: file.name,
            previewSvg: item.previewSvg,
            drawingSvg: item.drawingSvg,
            drawingTexts: item.drawingTexts,
          });
        }
      } catch {
        errors.push(`${file.name}: DWG를 읽지 못했습니다.`);
      }
    }
    setParts(extracted);
    setAnalysisErrors(errors);
    setStatus("done");
  };

  const clearCadFiles = () => {
    setCadFiles([]);
    setParts([]);
    setAnalysisErrors([]);
    setStatus("empty");
    setActiveTab("parts");
    setDetailPart(null);
  };

  const updatePart = (id: number, field: keyof Part, value: string | number | boolean) => {
    setParts((current) => current.map((part) => part.id === id ? { ...part, [field]: value } : part));
  };

  const updateDetailDimension = (value: string) => {
    if (!detailPart) return;
    updatePart(detailPart.id, "dimensions", value);
    setDetailPart((current) => current ? { ...current, dimensions: value } : current);
  };

  const exportCsv = () => {
    const header = ["NO", "ITEM", "DRAWING", "PART NO", "DIMENSIONS", "SPEC", "MATERIAL", "QTY"];
    const rows = selected.map((part, index) => [index + 1, part.itemName, part.drawingNo, part.partNo, part.dimensions, part.spec, part.material, part.qty]);
    const csv = [header, ...rows].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${project || "PROJECT"}_견적요청_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-actions">
          <span className="autosave"><i /> 자동 저장됨</span>
          <button className="ghost-button" onClick={() => window.print()}>미리보기</button>
          <button className="primary-button" onClick={() => { setActiveTab("request"); window.setTimeout(() => window.print(), 150); }}>견적서 출력</button>
        </div>
      </header>

      <section className="upload-grid no-print">
        <article className="file-card">
          <div className="file-icon cad">DWG</div>
          <div className="file-copy"><span>분석할 CAD 도면</span><strong className={!cadFiles.length ? "file-empty" : ""}>{cadFiles.length ? `${cadFiles.length}개 도면 선택됨` : "첨부된 도면이 없습니다"}</strong><small>{cadFiles.length ? `${cadFiles.slice(0, 2).map((file) => file.name).join(" · ")}${cadFiles.length > 2 ? ` 외 ${cadFiles.length - 2}개` : ""}` : "DWG 여러 파일 선택 가능"}</small></div>
          {cadFiles.length > 0 && <button className="clear-files" onClick={clearCadFiles} aria-label="첨부 도면 모두 제거">초기화</button>}
          <button className="icon-button" onClick={() => cadRef.current?.click()} aria-label="CAD 도면 추가">＋</button>
          <input ref={cadRef} hidden multiple type="file" accept=".dwg" onChange={chooseFiles} />
        </article>
        <article className="file-card fixed-template">
          <div className="file-icon rfq">RFQ</div>
          <div className="file-copy"><span>견적요청서 양식</span><strong>표준 견적요청서</strong><small>현재 양식으로 고정 · 별도 업로드 없음</small></div>
          <span className="lock-badge" aria-label="고정 양식">고정</span>
        </article>
        <label className="project-card"><span>PROJECT NO.</span><input value={project} onChange={(event) => setProject(event.target.value)} placeholder="직접 입력" aria-label="프로젝트 번호" /><small>견적요청서에 자동 반영</small></label>
        <button className={`analyze-button ${status}`} onClick={analyze} disabled={!cadFiles.length || status === "analyzing"}>
          <span>{status === "analyzing" ? "분석 중" : status === "empty" ? "CAD 첨부 필요" : "도면 분석"}</span>
          <small>{status === "done" ? `${cadFiles.length}개 도면 · ${parts.length}개 실제 BOM 품목` : cadFiles.length ? `${cadFiles.length}개 DWG의 BOM을 읽습니다` : "도면을 먼저 첨부해 주세요"}</small>
        </button>
      </section>

      <section className="work-panel">
        <div className="panel-toolbar no-print">
          <div className="tabs">
            <button className={activeTab === "parts" ? "active" : ""} onClick={() => setActiveTab("parts")}>추출 항목 <b>{parts.length}</b></button>
            <button className={activeTab === "request" ? "active" : ""} onClick={() => setActiveTab("request")}>견적요청서 <b>{selected.length}</b></button>
          </div>
          <div className="toolbar-meta"><span className="sample-badge">{cadFiles.length ? `실제 DWG BOM · ${cadFiles.length}개` : "CAD 대기 중"}</span><span>평균 인식률 <b>{averageConfidence}%</b></span></div>
        </div>

        {status === "analyzing" ? (
          <div className="analyzing-state"><span className="scan-line" /><b>도면의 문자와 형상을 연결하고 있습니다</b><small>PART No. · 재질 · SPEC · 치수</small></div>
        ) : activeTab === "parts" && status === "done" && parts.length === 0 ? (
          <div className="empty-state error-state"><span className="empty-drawing" aria-hidden="true"><i /><i /><i /></span><b>자동 추출 결과가 없습니다</b><small>{analysisErrors[0] || "이 도면의 BOM 구조를 자동으로 읽지 못했습니다."}<br />임의의 품목 값은 표시하지 않았습니다.</small><button className="primary-button" onClick={() => cadRef.current?.click()}>다른 DWG 추가</button></div>
        ) : activeTab === "parts" && parts.length === 0 ? (
          <div className="empty-state"><span className="empty-drawing" aria-hidden="true"><i /><i /><i /></span><b>CAD 도면을 첨부해 주세요</b><small>도면을 분석하면 PART No.별 2D 형상, 재질, SPEC이 이곳에 표시됩니다.</small><button className="primary-button" onClick={() => cadRef.current?.click()}>CAD 도면 첨부</button></div>
        ) : activeTab === "parts" ? (
          <div className="parts-view">
            <div className="table-note verified no-print"><span>✓</span><p><b>{cadFiles.length}개 DWG의 BOM 전체 품목을 불러왔습니다.</b> 원하는 품목을 체크하면 견적요청서에 반영되며, 치수는 mm로 표시됩니다.</p></div>
            {analysisErrors.length > 0 && <div className="table-note error-note no-print"><span>!</span><p><b>{analysisErrors.length}개 도면은 확인이 필요합니다.</b> {analysisErrors.join(" · ")}</p></div>}
            <div className="table-wrap">
              <table className="parts-table">
                <thead><tr><th className="check-col"><input type="checkbox" checked={parts.length > 0 && selected.length === parts.length} onChange={(event) => setParts(parts.map((part) => ({ ...part, selected: event.target.checked })))} aria-label="전체 선택" /></th><th>2D 형상 / 품명</th><th>도면 번호</th><th>PART No.</th><th>치수</th><th>SPEC</th><th>재질</th><th>수량</th><th>인식률</th></tr></thead>
                <tbody>{parts.map((part) => (
                  <tr key={part.id} className={!part.selected ? "muted-row" : part.confidence < 93 ? "needs-review" : ""}>
                    <td><input type="checkbox" checked={part.selected} onChange={(event) => updatePart(part.id, "selected", event.target.checked)} aria-label={`${part.category} PART ${part.partNo} 선택`} /></td>
                    <td><button className="shape-cell shape-detail-button" onClick={() => openDetailPart(part)} aria-label={`${part.itemName} PART ${part.partNo} 원본 도면 보기`}><Shape part={part} /><span><b>{part.itemName}</b><small>{part.category === "OTHER" ? "CAD BOM 품목" : "견적 LIST 기준"} · 원본 보기 ↗</small></span></button></td>
                    <td><b>{part.drawingNo}</b><small>DWG</small></td>
                    <td><span className="part-pill">P-{part.partNo.padStart(2, "0")}</span></td>
                    <td>{part.dimensions ? <input className="cell-input wide" value={part.dimensions} onChange={(event) => updatePart(part.id, "dimensions", event.target.value)} aria-label={`PART ${part.partNo} 치수(mm)`} /> : <button className="detail-link" onClick={() => openDetailPart(part)}>도면에서 확인 <span>↗</span></button>}</td>
                    <td><input className="cell-input" value={part.spec} onChange={(event) => updatePart(part.id, "spec", event.target.value)} aria-label={`PART ${part.partNo} SPEC`} /></td>
                    <td><input className="cell-input" value={part.material} onChange={(event) => updatePart(part.id, "material", event.target.value)} aria-label={`PART ${part.partNo} 재질`} /></td>
                    <td><input className="qty-input" type="number" min="1" value={part.qty} onChange={(event) => updatePart(part.id, "qty", Number(event.target.value))} aria-label={`PART ${part.partNo} 수량`} /></td>
                    <td><span className={`confidence ${part.confidence < 93 ? "warn" : ""}`}>{part.confidence}%</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="panel-footer no-print"><p><b>{selected.length}개 품목</b> · 총 수량 {totalQty}개 선택됨</p><div><button className="ghost-button" onClick={exportCsv}>CSV 내보내기</button><button className="primary-button" onClick={() => setActiveTab("request")}>견적요청서 만들기 →</button></div></div>
          </div>
        ) : (
          <div className="request-view">
            <aside className="request-settings no-print">
              <p className="eyebrow">REQUEST INFO</p><h2>요청 정보를<br />완성하세요.</h2>
              <label>프로젝트 번호<input placeholder="프로젝트 번호를 입력하세요" value={project} onChange={(event) => setProject(event.target.value)} /></label>
              <label>수신 업체<input placeholder="업체명을 입력하세요" value={supplier} onChange={(event) => setSupplier(event.target.value)} /></label>
              <label>견적 회신 기한<input type="date" defaultValue="2026-08-26" /></label>
              <label>요청 사항<textarea defaultValue="첨부 도면 및 아래 사양을 기준으로 제작 견적을 요청드립니다. 납기 가능일을 함께 회신해 주세요." /></label>
              <button className="primary-button full" onClick={() => window.print()}>PDF로 출력</button>
              <button className="ghost-button full" onClick={exportCsv}>품목 CSV 다운로드</button>
            </aside>
            <article className="request-sheet">
              <div className="sheet-title"><p>견 적 요 청 서</p><h2>REQUEST FOR QUOTATION</h2></div>
              <div className="sheet-meta"><div><span>PROJECT</span><b>{project || "프로젝트 미입력"}</b></div><div><span>RFQ NO.</span><b>{project || "PROJECT"}-RFQ-001</b></div><div><span>DATE</span><b>2026. 08. 19</b></div><div><span>DUE DATE</span><b>2026. 08. 26</b></div></div>
              <div className="sheet-to"><span>수신</span><b>{supplier || "견적 담당자 귀중"}</b><p>아래 품목에 대한 제작 견적 및 납기 회신을 요청드립니다.</p></div>
              <table className="rfq-table"><thead><tr><th>NO.</th><th>형상 / 품명</th><th>도면 번호</th><th>PART No.</th><th>치수 및 SPEC</th><th>재질</th><th>Q&apos;TY</th></tr></thead><tbody>{selected.map((part, index) => <tr key={part.id}><td>{index + 1}</td><td><div className="shape-cell compact"><Shape part={part} compact /><b>{part.itemName}</b></div></td><td>{part.drawingNo}</td><td>P-{part.partNo.padStart(2, "0")}</td><td><b>{part.dimensions}</b><small>{part.spec}</small></td><td>{part.material}</td><td>{part.qty}</td></tr>)}</tbody><tfoot><tr><td colSpan={6}>TOTAL</td><td>{totalQty}</td></tr></tfoot></table>
              <div className="sheet-note"><b>견적 조건</b><p>1. 단가 및 총액, 제작 납기, 운송 조건을 기재해 주세요.</p><p>2. 재질 성적서 제출 조건을 포함해 주세요.</p></div>
              <footer className="sheet-footer"><span>첨부: {cadFiles.length ? `CAD 도면 ${cadFiles.length}개` : "CAD 도면 미첨부"}</span></footer>
            </article>
          </div>
        )}
      </section>
      {detailPart && (
        <div className="drawing-modal no-print" role="dialog" aria-modal="true" aria-labelledby="drawing-detail-title">
          <section className="drawing-dialog">
            <header>
              <div><span>도면 상세</span><h2 id="drawing-detail-title">{detailPart.itemName} · P-{detailPart.partNo.padStart(2, "0")}</h2><p>{detailPart.drawingNo} · {detailPart.sourceName}</p></div>
              <button onClick={() => setDetailPart(null)} aria-label="도면 상세 닫기">×</button>
            </header>
            <div className={`drawing-canvas ${detailDragging ? "dragging" : ""} ${selectionMode ? "precision" : ""} ${selectionMode && selectionTool === "select" ? "selecting" : ""}`} role="application" aria-label="CAD 도면 확대 이동 및 제품 영역 선택" onWheel={handleDetailWheel} onPointerDown={startDetailDrag} onPointerMove={moveDetailDrag} onPointerUp={endDetailDrag} onPointerCancel={endDetailDrag} onDoubleClick={selectionMode ? undefined : resetDetailView}>
              {detailSvg ? <div ref={drawingStageRef} className="drawing-stage" role="img" aria-label={`${detailPart.itemName} PART ${detailPart.partNo} 원본 도면 확대`} style={detailBaseViewBox ? undefined : { transform: `translate(${detailView.x}px, ${detailView.y}px) scale(${detailView.scale})` }} dangerouslySetInnerHTML={{ __html: renderedDetailSvg }} /> : <div className="drawing-unavailable"><b>{detailMode === "part" ? "해당 PART 형상을 자동으로 분리하지 못했습니다." : "원본 도면을 표시할 수 없습니다."}</b><small>{detailMode === "part" ? "도면 전체를 눌러 원본 위치를 직접 확인해 주세요." : `원본 DWG에서 P-${detailPart.partNo.padStart(2, "0")} 호출부를 확인해 주세요.`}</small></div>}
              {detailSelection && <span className="drawing-selection" style={{ left: detailSelection.x, top: detailSelection.y, width: detailSelection.width, height: detailSelection.height }} />}
              <span className="drawing-chip">원본 DWG · {detailMode === "part" ? "제품 영역" : "도면 전체"}</span>
              {(detailPart.previewSvg || detailPart.drawingSvg) && <div className="drawing-controls" aria-label="도면 보기 및 확대 이동 도구" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}><button className={`mode ${detailMode === "part" && !selectionMode ? "active" : ""}`} onClick={() => changeDetailMode("part")}>제품 영역</button><button className={`mode ${detailMode === "drawing" && !selectionMode ? "active" : ""}`} onClick={() => changeDetailMode("drawing")} disabled={!detailPart.drawingSvg}>도면 전체</button><button className={`mode direct-select ${selectionMode ? "active" : ""}`} onClick={toggleDirectSelection} disabled={!detailPart.drawingSvg}>제품 직접 선택</button>{selectionMode && <><button className={`mode selection-tool ${selectionTool === "pan" ? "active" : ""}`} onClick={() => changeSelectionTool("pan")}>이동</button><button className={`mode selection-tool ${selectionTool === "select" ? "active" : ""}`} onClick={() => changeSelectionTool("select")}>영역 선택</button></>}<button onClick={() => setDetailScale(detailView.scale / 1.2)} aria-label="도면 축소" disabled={!detailSvg}>−</button><output aria-live="polite">{Math.round(detailView.scale * 100)}%</output><button onClick={() => setDetailScale(detailView.scale * 1.2)} aria-label="도면 확대" disabled={!detailSvg}>＋</button><button className="fit" onClick={resetDetailView} disabled={!detailSvg}>화면 맞춤</button></div>}
              {detailSvg && <span className="drawing-help">{selectionMode ? selectionTool === "pan" ? "휠 확대·축소 · 드래그 이동 · 위치를 맞춘 뒤 영역 선택" : "제품과 주변 치수 문자를 드래그해 선택" : "벡터 도면 · 휠 확대·축소 · 드래그 이동 · 더블클릭 화면 맞춤"}</span>}
              {selectionMessage && <span className={`drawing-selection-status ${selectionMessage.includes("가져왔습니다") ? "success" : ""}`}>{selectionMessage}</span>}
            </div>
            <footer><div><label htmlFor="detail-dimensions">치수 · 직접 수정 가능</label><input id="detail-dimensions" className="drawing-detail-input" value={detailPart.dimensions} onChange={(event) => updateDetailDimension(event.target.value)} placeholder="치수를 mm로 입력하세요" /></div><div><span>SPEC</span><b>{detailPart.spec}</b></div><div><span>재질</span><b>{detailPart.material}</b></div></footer>
          </section>
        </div>
      )}
    </main>
  );
}
