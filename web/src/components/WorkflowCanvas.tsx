import { Button } from 'antd';
import { useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { WorkflowEdge, WorkflowNode } from '../types';

// 节点与端口的几何常量（世界坐标单位，与画布 scale 解耦）
const NODE_W = 168;
const NODE_H = 56;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.6;

// 选中态（节点或连线），由页面持有并驱动删除/重命名
export type WorkflowSelection = { kind: 'node' | 'edge'; id: string } | null;

interface WorkflowCanvasProps {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selected: WorkflowSelection;
  onSelect: (sel: WorkflowSelection) => void;
  onChange: (nodes: WorkflowNode[], edges: WorkflowEdge[]) => void;
}

// 拖拽过程中的临时状态（避免高频 setState，保持指针事件连续）
interface DragState {
  mode: 'idle' | 'pan' | 'node' | 'connect';
  nodeId?: string;
  connectFrom?: string;
  startX: number; // 指针按下时的屏幕坐标
  startY: number;
  origX: number; // 节点拖拽时的世界起点
  origY: number;
  viewportX: number; // 平移/连线时的视口起点
  viewportY: number;
  zoom: number;
}

const NO_DRAG: DragState = { mode: 'idle', startX: 0, startY: 0, origX: 0, origY: 0, viewportX: 0, viewportY: 0, zoom: 1 };

// 节点锚点（连线起点取右端中点，终点取左端中点）
function anchor(node: WorkflowNode, side: 'out' | 'in'): { x: number; y: number } {
  if (side === 'out') return { x: node.x + NODE_W, y: node.y + NODE_H / 2 };
  return { x: node.x, y: node.y + NODE_H / 2 };
}

// 三次贝塞尔连线路径
function bezierPath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = Math.max(48, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

// 自研 SVG 工作流画布：节点拖拽、端口连线、画布平移/缩放、点选
export default function WorkflowCanvas({ nodes, edges, selected, onSelect, onChange }: WorkflowCanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState>(NO_DRAG);
  const [viewport, setViewport] = useState({ x: 40, y: 40, zoom: 1 });
  const [pending, setPending] = useState<{ from: string; x: number; y: number } | null>(null);

  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // 屏幕坐标 → 相对 svg 左上角坐标
  const toScreen = (ev: ReactPointerEvent | { clientX: number; clientY: number }) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  const handleBackgroundDown = (ev: ReactPointerEvent<SVGSVGElement>) => {
    svgRef.current?.setPointerCapture(ev.pointerId);
    const pt = toScreen(ev);
    dragRef.current = { mode: 'pan', startX: pt.x, startY: pt.y, origX: 0, origY: 0, viewportX: viewport.x, viewportY: viewport.y, zoom: viewport.zoom };
  };

  const handleNodeDown = (ev: ReactPointerEvent<SVGGElement>, node: WorkflowNode) => {
    ev.stopPropagation();
    svgRef.current?.setPointerCapture(ev.pointerId);
    onSelect({ kind: 'node', id: node.id });
    const pt = toScreen(ev);
    dragRef.current = { mode: 'node', nodeId: node.id, startX: pt.x, startY: pt.y, origX: node.x, origY: node.y, viewportX: viewport.x, viewportY: viewport.y, zoom: viewport.zoom };
  };

  const handlePortDown = (ev: ReactPointerEvent<SVGCircleElement>, node: WorkflowNode, kind: 'in' | 'out') => {
    ev.stopPropagation();
    svgRef.current?.setPointerCapture(ev.pointerId);
    onSelect({ kind: 'node', id: node.id });
    if (kind !== 'out') return;
    const pt = toScreen(ev);
    dragRef.current = { mode: 'connect', connectFrom: node.id, startX: pt.x, startY: pt.y, origX: 0, origY: 0, viewportX: viewport.x, viewportY: viewport.y, zoom: viewport.zoom };
    const a = anchor(node, 'out');
    setPending({ from: node.id, x: a.x, y: a.y });
  };

  const handleEdgeDown = (ev: ReactPointerEvent<SVGGElement>, edge: WorkflowEdge) => {
    ev.stopPropagation();
    onSelect({ kind: 'edge', id: edge.id });
  };

  const handleMove = (ev: ReactPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (d.mode === 'idle') return;
    const pt = toScreen(ev);
    if (d.mode === 'pan') {
      setViewport((v) => ({ ...v, x: d.viewportX + (pt.x - d.startX), y: d.viewportY + (pt.y - d.startY) }));
    } else if (d.mode === 'node' && d.nodeId) {
      const nx = d.origX + (pt.x - d.startX) / d.zoom;
      const ny = d.origY + (pt.y - d.startY) / d.zoom;
      onChange(
        nodes.map((n) => (n.id === d.nodeId ? { ...n, x: nx, y: ny } : n)),
        edges,
      );
    } else if (d.mode === 'connect') {
      setPending((p) => (p ? { ...p, x: (pt.x - d.viewportX) / d.zoom, y: (pt.y - d.viewportY) / d.zoom } : p));
    }
  };

  const handleUp = (ev: ReactPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (d.mode === 'connect' && d.connectFrom) {
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const port = hit?.closest('[data-port="in"]') as HTMLElement | null;
      if (port && port.dataset.nodeId && port.dataset.nodeId !== d.connectFrom) {
        const edge: WorkflowEdge = { id: crypto.randomUUID(), from: d.connectFrom, to: port.dataset.nodeId };
        onChange(nodes, [...edges, edge]);
      }
      setPending(null);
    }
    dragRef.current = NO_DRAG;
  };

  const zoomBy = (factor: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    setViewport((v) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      const wx = (cx - v.x) / v.zoom;
      const wy = (cy - v.y) / v.zoom;
      return { zoom, x: cx - wx * zoom, y: cy - wy * zoom };
    });
  };

  const resetView = () => setViewport({ x: 40, y: 40, zoom: 1 });

  return (
    <div className="wf-canvas-wrap">
      <svg
        ref={svgRef}
        className="wf-canvas"
        onPointerDown={handleBackgroundDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
      >
        <defs>
          <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="wf-edge-arrow" />
          </marker>
        </defs>

        <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`}>
          {pending && nodeMap.get(pending.from) && (
            <path d={bezierPath(anchor(nodeMap.get(pending.from)!, 'out'), { x: pending.x, y: pending.y })} className="wf-edge wf-edge-pending" />
          )}

          {edges.map((e) => {
            const from = nodeMap.get(e.from);
            const to = nodeMap.get(e.to);
            if (!from || !to) return null;
            const a = anchor(from, 'out');
            const b = anchor(to, 'in');
            const isSel = selected?.kind === 'edge' && selected.id === e.id;
            const midX = (a.x + b.x) / 2;
            const midY = (a.y + b.y) / 2 - 8;
            return (
              <g key={e.id} onPointerDown={(ev) => handleEdgeDown(ev, e)}>
                <path d={bezierPath(a, b)} className="wf-edge-hit" />
                <path d={bezierPath(a, b)} className={isSel ? 'wf-edge wf-edge-selected' : 'wf-edge'} markerEnd="url(#wf-arrow)" />
                {e.label && (
                  <text x={midX} y={midY} textAnchor="middle" className="wf-edge-label">
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}

          {nodes.map((n) => {
            const isSel = selected?.kind === 'node' && selected.id === n.id;
            const typeClass = `wf-node-${n.type.toLowerCase()}`;
            return (
              <g key={n.id} transform={`translate(${n.x}, ${n.y})`} onPointerDown={(ev) => handleNodeDown(ev, n)} className={isSel ? 'wf-node-selected' : undefined}>
                {n.type === 'CONDITION' ? (
                  <polygon
                    points={`${NODE_W / 2},0 ${NODE_W},${NODE_H / 2} ${NODE_W / 2},${NODE_H} 0,${NODE_H / 2}`}
                    className={`wf-node ${typeClass}`}
                  />
                ) : (
                  <rect width={NODE_W} height={NODE_H} rx={8} className={`wf-node ${typeClass}`} />
                )}
                <text x={NODE_W / 2} y={NODE_H / 2 + 5} textAnchor="middle" className="wf-node-title">
                  {n.title}
                </text>
                {/* 端口：内部小圆仅作视觉，外层大圈为连线的命中区域 */}
                <circle cx={0} cy={NODE_H / 2} r={7} className="wf-port" />
                <circle cx={0} cy={NODE_H / 2} r={14} className="wf-port-hit" data-node-id={n.id} data-port="in" onPointerDown={(ev) => handlePortDown(ev, n, 'in')} />
                <circle cx={NODE_W} cy={NODE_H / 2} r={7} className="wf-port" />
                <circle cx={NODE_W} cy={NODE_H / 2} r={14} className="wf-port-hit" data-node-id={n.id} data-port="out" onPointerDown={(ev) => handlePortDown(ev, n, 'out')} />
              </g>
            );
          })}
        </g>
      </svg>

      <div className="wf-canvas-toolbar">
        <Button size="small" onClick={() => zoomBy(1.15)}>
          放大
        </Button>
        <Button size="small" onClick={() => zoomBy(0.87)}>
          缩小
        </Button>
        <Button size="small" onClick={resetView}>
          重置
        </Button>
      </div>
    </div>
  );
}