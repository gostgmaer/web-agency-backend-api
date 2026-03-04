import fs from "fs";
import path from "path";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { exec } from "child_process";
import html_to_pdf from "html-pdf-node";
import puppeteer from "puppeteer";
// __dirname workaround for ES modules
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =====================================
   FORMAT DATE + TIME
===================================== */
function getFormattedDateTime() {
  const now = new Date();

  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = now.getFullYear();

  let hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, "0");

  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  hours = hours ? hours : 12;
  hours = String(hours).padStart(2, "0");

  return `${day}/${month}/${year} ${hours}:${minutes} ${ampm}`;
}

/* =====================================
   PROPOSAL NUMBER
===================================== */
function generateProposalNumber(count) {
  const year = new Date().getFullYear();
  const padded = String(count).padStart(3, "0");
  return `QTN-${year}-${padded}`;
}

/* =====================================
   CONVERT DOCX TO PDF
===================================== */
function convertToPDF(inputPath) {
  return new Promise((resolve, reject) => {
    const outputDir = path.dirname(inputPath);

    const command = `soffice --headless --convert-to pdf "${inputPath}" --outdir "${outputDir}"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        const pdfPath = inputPath.replace(".docx", ".pdf");
        resolve(pdfPath);
      }
    });
  });
}

/* =====================================
   MAIN GENERATOR FUNCTION
===================================== */
export async function generateProposal({
  templateType,
  count,
  variables = {}
}) {
  try {
    if (!templateType) throw new Error("Template type is required");
    if (!count) throw new Error("Proposal count is required");

    /* Determine template path and extension */
    const proposalsDir = path.resolve(__dirname, "../proposal");
    let ext = path.extname(templateType);
    let baseName = templateType;

    // allow callers to pass either 'foo' or 'foo.docx'/'foo.html'
    if (ext) {
      baseName = path.basename(templateType, ext);
    } else {
      // default to docx unless html flag is present in variables
      ext = variables.html ? '.html' : '.docx';
    }

    const templatePath = path.join(proposalsDir, `${baseName}${ext}`);
    if (!fs.existsSync(templatePath)) {
      throw new Error("Template file not found");
    }

    /* Auto Fields */
    const autoFields = {
      date: getFormattedDateTime(),
      number: generateProposalNumber(count),
    };

    const finalData = {
      ...autoFields,
      ...variables,
    };

    // ensure output directory exists once
    const outputDir = path.resolve(__dirname, "output");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }

    /* when template is HTML we do simple text substitution */
    if (ext === '.html') {
      let html = fs.readFileSync(templatePath, 'utf-8');

      // basic mustache-style replacement {{key}}
      html = html.replace(/{{\s*([^}]+)\s*}}/g, (match, p1) => {
        const val = finalData[p1];
        return val !== undefined && val !== null ? String(val) : '';
      });

      const fileName = `Proposal-${finalData.company || "Client"}-${autoFields.number}.html`;
      const outPath = path.join(outputDir, fileName);
      fs.writeFileSync(outPath, html, 'utf-8');

      return {
        success: true,
        number: autoFields.number,
        date: autoFields.date,
        htmlPath: outPath
      };
    }

    // otherwise assume docx (existing behaviour)
    const content = fs.readFileSync(templatePath, "binary");
    const zip = new PizZip(content);

    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
    });

    doc.setData(finalData);
    doc.render();

    /* File Name */
    const fileName = `Proposal-${finalData.company || "Client"}-${autoFields.number}`;

    const docxPath = path.join(outputDir, `${fileName}.docx`);

    const buffer = doc.getZip().generate({
      type: "nodebuffer",
      compression: "DEFLATE",
    });

    fs.writeFileSync(docxPath, buffer);

    /* Convert to PDF */
    const pdfPath = await convertToPDF(docxPath);

    return {
      success: true,
      number: autoFields.number,
      date: autoFields.date,
      docxPath,
      pdfPath,
    };

  } catch (error) {
    console.error("Proposal Generation Error:", error);
    throw error;
  }
}



export async function generateProposalPDF({
  templatePath,
  outputDir,
  data
}) {

  let html = fs.readFileSync(templatePath, "utf8");

  Object.keys(data).forEach(key => {
    const regex = new RegExp(`{${key}}`, "g");
    html = html.replace(regex, data[key]);
  });

  const safeCompany = data.company.replace(/[^a-zA-Z0-9]/g, "-");

  const fileName = `Proposal-${safeCompany}-${data.number}.pdf`;

  const filePath = path.join(outputDir, fileName);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  await page.setContent(html, {
    waitUntil: "networkidle0"
  });

  await page.pdf({
    path: filePath,
    format: "A4",
    printBackground: true
  });

  await browser.close();

  return {
    success: true,
    path: filePath
  };

}