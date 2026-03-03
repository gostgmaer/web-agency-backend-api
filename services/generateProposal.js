import fs from "fs";
import path from "path";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { exec } from "child_process";

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

    // const allowedTemplates = ["static", "dynamic", "ecommerce", "enterprise"];
    // if (!allowedTemplates.includes(templateType)) {
    //   throw new Error("Invalid template type");
    // }

    /* Load Template */
    const templatePath = path.resolve(
      __dirname,
      "../proposal",
      `${templateType}.docx`
    );

    if (!fs.existsSync(templatePath)) {
      throw new Error("Template file not found");
    }

    const content = fs.readFileSync(templatePath, "binary");
    const zip = new PizZip(content);

    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
    });

    /* Auto Fields */
    const autoFields = {
      date: getFormattedDateTime(),
      number: generateProposalNumber(count),
    };

    const finalData = {
      ...autoFields,
      ...variables,
    };

    doc.setData(finalData);
    doc.render();

    /* Ensure Output Folder Exists */
    const outputDir = path.resolve(__dirname, "output");

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }

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