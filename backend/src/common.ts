import type { PageResult } from './types';

// 业务异常：携带业务码，统一由错误处理中间件转成响应（401 -> HTTP 401，其余 -> HTTP 200）
export class BusinessError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// 统一响应结构（与前端/agent 约定的接口契约）
export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

export function ok<T>(data: T): ApiResponse<T> {
  return { code: 0, message: 'ok', data };
}

export function fail(code: number, message: string): ApiResponse<null> {
  return { code, message, data: null };
}

// 分页：页码从 1 开始，默认每页 10，最大 100
export function paginate<T>(source: T[], page: number, pageSize: number): PageResult<T> {
  if (page < 1) page = 1;
  if (pageSize < 1) pageSize = 10;
  if (pageSize > 100) pageSize = 100;
  const from = (page - 1) * pageSize;
  const to = Math.min(from + pageSize, source.length);
  const list = from >= source.length ? [] : source.slice(from, to);
  return { list, total: source.length, page, pageSize };
}

// 字符串转换（null/undefined -> 空串）
export function str(o: unknown): string {
  return o == null ? '' : String(o);
}

// 整数参数解析，缺失或非法时用默认值
export function asInt(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isInteger(n) ? n : def;
}

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 今天起偏移 days 天的本地日期（格式 YYYY-MM-DD）
export function plusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDateString(d);
}