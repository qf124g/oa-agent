// 文档分块：按段落切分，超长段落继续按句子切分，控制单块长度避免超出 embedding 输入上限

const MAX_CHUNK_LEN = 500;

export function chunkText(text: string): string[] {
  const paragraphs = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buf = '';

  const flush = () => {
    if (buf) {
      chunks.push(buf);
      buf = '';
    }
  };

  for (const para of paragraphs) {
    // 短段落直接累积，长段落单独拆
    if (para.length <= MAX_CHUNK_LEN) {
      if (buf && buf.length + para.length + 1 > MAX_CHUNK_LEN) flush();
      buf = buf ? `${buf}\n${para}` : para;
    } else {
      flush();
      chunks.push(...splitLong(para));
    }
  }
  flush();

  return chunks.length ? chunks : [text];
}

// 长段落按句号/分号进一步切分为合法长度的小块
function splitLong(text: string): string[] {
  const sentences = text.split(/(?<=[。；;！？!?])/);
  const result: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (buf && buf.length + s.length > MAX_CHUNK_LEN) {
      result.push(buf);
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf) result.push(buf);
  return result;
}