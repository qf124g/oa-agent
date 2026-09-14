// 从文件 buffer 中提取纯文本：txt/md 直接 UTF-8 解码，PDF 用 pdf-parse，docx 用 mammoth
export async function extractTextFromBuffer(buffer: Buffer, filename: string): Promise<string> {
  const name = filename.toLowerCase();
  if (name.endsWith('.pdf')) {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy();
    return result.text ?? '';
  }
  if (name.endsWith('.docx')) {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value ?? '';
  }
  return buffer.toString('utf8');
}