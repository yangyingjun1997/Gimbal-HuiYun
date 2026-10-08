"use strict";

const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");

const ROOT = path.join(__dirname, "..");
const FILES = [
  path.join(ROOT, "..", "汇云机器人MavLink+自定义消息接口文档V1.0.7.pdf"),
  path.join(ROOT, "..", "HY-DZ230F三轴稳像吊舱使用说明书.pdf"),
];

async function extractPdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return {
    file: path.basename(filePath),
    pages: data.numpages,
    text: data.text,
  };
}

async function main() {
  const outDir = path.join(__dirname, "..", "pdf-extracts");
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of FILES) {
    if (!fs.existsSync(file)) {
      console.log("跳过不存在文件:", file);
      continue;
    }
    console.log(`正在解析: ${path.basename(file)} ...`);
    try {
      const result = await extractPdf(file);
      const baseName = path.basename(file, ".pdf");
      const txtPath = path.join(outDir, `${baseName}.txt`);
      const header = `${"=".repeat(60)}\n文件：${result.file}\n页数：${result.pages}\n${"=".repeat(60)}\n\n`;
      fs.writeFileSync(txtPath, header + result.text, "utf8");
      console.log(`  完成！共 ${result.pages} 页，已输出到: ${txtPath}`);
      console.log(`  前 800 字符预览：\n${result.text.slice(0, 800)}\n${"-".repeat(60)}\n`);
    } catch (err) {
      console.error(`  解析失败: ${err.message}`);
      console.error(err.stack);
    }
  }
}

main().catch((err) => {
  console.error("执行失败:", err);
  process.exit(1);
});