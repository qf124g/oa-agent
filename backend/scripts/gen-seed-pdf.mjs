// 生成知识库基础文档 PDF（开发期一次性脚本）：输出到 backend/seed/knowledge/*.pdf
import PDFDocument from 'pdfkit';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'seed', 'knowledge');
// 中文字体：使用 macOS 自带的 Arial Unicode（含 GB/中文全量字形）
const FONT = '/Library/Fonts/Arial Unicode.ttf';

// 基础文档：文件名 NN-标题.pdf，NN 决定知识库 id = K0NN
const SEEDS = [
  {
    file: '01-考勤管理制度.pdf',
    content:
      '公司实行标准工时制，工作时间 09:00 至 18:00，午休 12:00 至 13:30。员工迟到 30 分钟以内记一次迟到，每月迟到三次及以上将影响当月绩效。请假需提前一天在系统提交申请，审批通过后方可休假。加班需提前报备并记录，加班工时可用于调休。',
  },
  {
    file: '02-报销流程说明.pdf',
    content:
      '报销申请需在费用发生后 30 天内提交。发票抬头为公司全称，金额需与申请一致。差旅报销需附行程单和住宿发票，餐饮招待费需注明事由和参与人员。报销审批由部门负责人和财务主管两级审批，金额超过 5000 元需总经理审批。审批通过后财务在 5 个工作日内打款。',
  },
  {
    file: '03-办公环境FAQ.pdf',
    content:
      '办公区 Wi-Fi 账号为 OA-Guest，密码前台领取。打印机位于每层茶水间旁。会议室通过系统在线预约，单次会议不超过 2 小时。访客需前台登记并领取临时门禁卡。',
  },
];

mkdirSync(OUT_DIR, { recursive: true });

for (const seed of SEEDS) {
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 50, right: 50 } });
    const out = join(OUT_DIR, seed.file);
    const stream = createWriteStream(out);
    doc.pipe(stream);
    doc.font(FONT).fontSize(12).text(seed.content, { lineGap: 6 });
    doc.end();
    stream.on('finish', () => {
      console.log('已生成:', out);
      resolve(undefined);
    });
    stream.on('error', reject);
  });
}