// Generates "Changelog LlamaTalk Desktop YYYY-MM-DD.pdf" from the dated .md source.
// Run with: node scripts/make-changelog-pdf.js
// Requires: pdfkit (npm install pdfkit --save-dev)

import PDFDocument from "pdfkit";
import { createWriteStream, readFileSync } from "fs";

const _d = new Date();
const today = `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,"0")}-${String(_d.getDate()).padStart(2,"0")}`; // YYYY-MM-DD local
const SRC  = `E:\\LlamaTalk Files\\External Documents\\Changelog LlamaTalk Desktop ${today}.md`;
const DEST = `E:\\LlamaTalk Files\\External Documents\\Changelog LlamaTalk Desktop ${today}.pdf`;

const content = readFileSync(SRC, "utf-8");
const lines   = content.split("\n");

const doc = new PDFDocument({ margin: 60, size: "A4" });
doc.pipe(createWriteStream(DEST));

// Fixed page geometry — never use doc.x as a base
const L = 60;                             // left margin
const R = 60;                             // right margin
const PW = doc.page.width - L - R;       // usable width (475 on A4)

// Colours
const C_TITLE  = "#1a1a2e";
const C_H2     = "#2d4a8a";
const C_H3     = "#444444";
const C_TEXT   = "#222222";
const C_RULE   = "#cccccc";
const C_ITALIC = "#333333";

// Fonts
const FONT_BOLD    = "Helvetica-Bold";
const FONT_NORM    = "Helvetica";
const FONT_OBLIQUE = "Helvetica-Oblique";

function stripInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1");
}

function renderBullet(rawLine) {
  const indentSpaces = rawLine.match(/^(\s*)/)[1].length;
  const text = rawLine.replace(/^\s*-\s*/, "");

  // Positions derived from the FIXED left margin, never from doc.x
  const dotX  = L + indentSpaces * 6;        // bullet dot
  const textX = dotX + 12;                   // text body
  const textW = doc.page.width - textX - R;  // remaining width to right margin

  // Capture y BEFORE drawing anything
  const startY = doc.y;

  // Draw bullet dot with lineBreak: false so doc.y does NOT advance
  doc.font(FONT_NORM)
     .fontSize(9)
     .fillColor(C_TEXT)
     .text("•", dotX, startY, { lineBreak: false });

  // Now draw the body text at the same startY
  const boldMatch = text.match(/^\*\*(.+?)\*\*(.*)$/);
  if (boldMatch) {
    const label = boldMatch[1];
    const rest  = stripInline(boldMatch[2]);
    doc.font(FONT_BOLD)
       .fillColor(C_TEXT)
       .text(label, textX, startY, { continued: true, width: textW });
    doc.font(FONT_NORM)
       .fillColor(C_TEXT)
       .text(rest, { continued: false, width: textW });
  } else {
    const italicMatch = text.match(/^\*([^*]+)\*(.*)$/);
    if (italicMatch) {
      const label = italicMatch[1];
      const rest  = stripInline(italicMatch[2]);
      doc.font(FONT_OBLIQUE)
         .fillColor(C_ITALIC)
         .text(label, textX, startY, { continued: true, width: textW });
      doc.font(FONT_NORM)
         .fillColor(C_TEXT)
         .text(rest, { continued: false, width: textW });
    } else {
      doc.font(FONT_NORM)
         .fillColor(C_TEXT)
         .text(stripInline(text), textX, startY, { width: textW });
    }
  }

  doc.moveDown(0.2);
}

let prevWasBlank = false;

for (const raw of lines) {
  const line = raw.trimEnd();

  // H1
  if (line.startsWith("# ")) {
    doc.font(FONT_BOLD)
       .fontSize(22)
       .fillColor(C_TITLE)
       .text(line.slice(2), L, doc.y, { width: PW, align: "center" });
    doc.moveDown(0.3);
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y)
       .strokeColor(C_H2).lineWidth(1.5).stroke();
    doc.moveDown(0.6);
    prevWasBlank = false;
    continue;
  }

  // H2 — "## Upcoming" triggers a new page before rendering
  if (line.startsWith("## ")) {
    if (line.slice(3).startsWith("Upcoming")) {
      doc.addPage();
    } else {
      doc.moveDown(0.4);
    }
    doc.font(FONT_BOLD)
       .fontSize(14)
       .fillColor(C_H2)
       .text(line.slice(3), L, doc.y, { width: PW });
    doc.moveTo(L, doc.y).lineTo(L + PW, doc.y)
       .strokeColor(C_H2).lineWidth(0.8).stroke();
    doc.moveDown(0.4);
    prevWasBlank = false;
    continue;
  }

  // H3
  if (line.startsWith("### ")) {
    doc.moveDown(0.25);
    doc.font(FONT_BOLD)
       .fontSize(11)
       .fillColor(C_H3)
       .text(line.slice(4), L, doc.y, { width: PW });
    doc.moveDown(0.2);
    prevWasBlank = false;
    continue;
  }

  // Horizontal rule
  if (line === "---") {
    doc.moveTo(L, doc.y + 4).lineTo(L + PW, doc.y + 4)
       .strokeColor(C_RULE).lineWidth(0.5).stroke();
    doc.moveDown(0.5);
    prevWasBlank = false;
    continue;
  }

  // Bullet
  if (/^\s*- /.test(line)) {
    renderBullet(line);
    prevWasBlank = false;
    continue;
  }

  // Italic footer (*text*)
  if (/^\*[^*]/.test(line.trim()) && line.trim().endsWith("*")) {
    doc.font(FONT_OBLIQUE)
       .fontSize(8)
       .fillColor(C_ITALIC)
       .text(line.trim().slice(1, -1), L, doc.y, { width: PW, align: "center" });
    doc.moveDown(0.3);
    prevWasBlank = false;
    continue;
  }

  // Blank line
  if (line.trim() === "") {
    if (!prevWasBlank) doc.moveDown(0.35);
    prevWasBlank = true;
    continue;
  }

  // Plain paragraph
  doc.font(FONT_NORM)
     .fontSize(9)
     .fillColor(C_TEXT)
     .text(stripInline(line), L, doc.y, { width: PW });
  doc.moveDown(0.2);
  prevWasBlank = false;
}

doc.end();
console.log(`PDF written to: ${DEST}`);
