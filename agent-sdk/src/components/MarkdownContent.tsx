import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { ChartBlock, parseChartSpec } from './ChartBlock';

// 自定义渲染器：拦截 ```chart 代码块渲染为图表，其余代码块保持默认样式
// pre 去掉原 <pre> 包裹（图表与代码块各自负责自身外壳），避免图表被套进代码框
const markdownComponents: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, node: _node, ...rest }) => {
    const match = /language-(\w+)/.exec(className || '');
    if (match) {
      if (match[1] === 'chart') {
        const spec = parseChartSpec(String(children));
        if (spec) return <ChartBlock spec={spec} />;
      }
      return (
        <pre>
          <code className={className} {...rest}>
            {children}
          </code>
        </pre>
      );
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
};

// Markdown 渲染组件：支持 GFM（表格/代码块/任务列表）、数学公式（KaTeX）、```chart 图表
// 用 memo 包裹，content 未变化时不重复解析，配合流式帧节流降低长文本/公式的重复渲染开销
export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: 'ignore' }]]}
      components={markdownComponents}
    >
      {content}
    </ReactMarkdown>
  );
});