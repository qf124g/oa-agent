import { Bar, Column, Line, Pie } from '@ant-design/plots';
import { memo } from 'react';

// 图表规格：助手回答中以 ```chart 代码块输出的 JSON 结构
export interface ChartSpec {
  type: 'column' | 'bar' | 'line' | 'pie';
  data: Record<string, unknown>[];
  xField: string;
  yField: string;
  title?: string;
  height?: number;
}

const CHART_TYPES = ['column', 'bar', 'line', 'pie'] as const;

// 解析 ```chart 代码块内容；非法 JSON 或缺少必要字段时返回 null，由调用方回退为普通代码块展示
export function parseChartSpec(code: string): ChartSpec | null {
  try {
    const trimmed = code.trim();
    if (!trimmed) return null;
    const obj = JSON.parse(trimmed) as Partial<ChartSpec>;
    if (!obj || typeof obj !== 'object') return null;
    if (!CHART_TYPES.includes(obj.type as (typeof CHART_TYPES)[number])) return null;
    if (!Array.isArray(obj.data)) return null;
    if (typeof obj.xField !== 'string' || typeof obj.yField !== 'string') return null;
    if (obj.title !== undefined && typeof obj.title !== 'string') return null;
    if (obj.height !== undefined && typeof obj.height !== 'number') return null;
    return obj as ChartSpec;
  } catch {
    return null;
  }
}

// 单个图表块：根据 type 渲染对应的 AntV 图表
export const ChartBlock = memo(function ChartBlock({ spec }: { spec: ChartSpec }) {
  const { type, data, xField, yField, title, height = 260 } = spec;
  return (
    <div className="agent-chat-chart">
      {title ? <div className="agent-chat-chart-title">{title}</div> : null}
      <div className="agent-chat-chart-body">
        {type === 'column' && <Column data={data} xField={xField} yField={yField} height={height} />}
        {type === 'bar' && <Bar data={data} xField={xField} yField={yField} height={height} />}
        {type === 'line' && <Line data={data} xField={xField} yField={yField} height={height} />}
        {type === 'pie' && <Pie data={data} angleField={yField} colorField={xField} height={height} />}
      </div>
    </div>
  );
});