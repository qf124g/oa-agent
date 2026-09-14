import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

// Markdown 渲染组件：支持 GFM（表格/代码块/任务列表）、数学公式（KaTeX）
// 用 memo 包裹，content 未变化时不重复解析，配合流式帧节流降低长文本/公式的重复渲染开销
export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: 'ignore' }]]}
    >
      {content}
    </ReactMarkdown>
  );
});