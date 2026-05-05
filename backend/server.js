// ================== FULLY DYNAMIC VERSION ==================
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const Groq = require("groq-sdk");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ---------------- PDF EXTRACTOR ----------------
async function extractPdfPages(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str).join(" ").trim();
    pages.push({ pageNum: i, text });
  }
  return pages;
}

// ---------------- SMART PAGE DETECTION ----------------
function classifyPage(text) {
  const lower = text.toLowerCase();

  if (!text || text.length < 40) return "blank";

  if (
    lower.includes("instructions") ||
    lower.includes("do not write") ||
    lower.includes("candidate") ||
    lower.includes("information") ||
    lower.includes("multiple choice answer sheet")
  ) return "admin";

  if (/^\s*\d+\s/.test(text) || text.match(/\d+\s+[A-Z]/)) {
    return "question";
  }

  return "unknown";
}

// ---------------- FILTER QUESTION PAGES ----------------
function getQuestionPages(pages) {
  const classified = pages.map(p => ({
    ...p,
    type: classifyPage(p.text)
  }));

  const qPages = classified.filter(p => p.type === "question");

  // fallback if detection fails
  return qPages.length > 0 ? qPages : pages;
}

// ---------------- DYNAMIC CHUNKING ----------------
function buildDynamicChunks(pages) {
  const total = pages.length;

  let maxChars;

  if (total <= 5) maxChars = 4000;
  else if (total <= 10) maxChars = 3000;
  else if (total <= 20) maxChars = 2000;
  else maxChars = 1500;

  const chunks = [];
  let current = [];
  let len = 0;

  for (const p of pages) {
    if (len + p.text.length > maxChars && current.length > 0) {
      chunks.push(current);
      current = [];
      len = 0;
    }
    current.push(p);
    len += p.text.length;
  }

  if (current.length) chunks.push(current);

  return chunks;
}

// ---------------- MULTER ----------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
});

// ---------------- GROQ CALL ----------------
async function callGroq(groq, prompt) {
  const res = await groq.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    model: "llama-3.1-8b-instant",
    temperature: 0.1,
  });

  let raw = res.choices[0]?.message?.content || "";
  raw = raw.replace(/```json|```/g, "").trim();

  return JSON.parse(raw);
}

// ---------------- MAIN API ----------------
app.post(
  "/api/analyse",
  upload.fields([
    { name: "questionPaper", maxCount: 1 },
    { name: "syllabus", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const qpBuffer = req.files.questionPaper[0].buffer;
      const sylBuffer = req.files.syllabus[0].buffer;

      const qpPages = await extractPdfPages(qpBuffer);
      const sylPages = await extractPdfPages(sylBuffer);

      console.log("Total pages:", qpPages.length);

      const questionPages = getQuestionPages(qpPages);
      console.log("Detected question pages:", questionPages.length);

      const chunks = buildDynamicChunks(questionPages);
      console.log("Chunks:", chunks.length);

      const syllabusText = sylPages.slice(0, 2).map(p => p.text).join("\n");

      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

      let allQuestions = [];

      for (let i = 0; i < chunks.length; i++) {
        const text = chunks[i].map(p => p.text).join("\n");

        const prompt = `
Extract all questions.

Return JSON:
[
 { "q":1, "text":"...", "topic":"...", "subtopic":"..." }
]

Syllabus:
${syllabusText}

Text:
${text}
`;

        const result = await callGroq(groq, prompt);
        allQuestions.push(...result);
      }

      // remove duplicates
      const seen = new Set();
      const questions = allQuestions.filter(q => {
        if (seen.has(q.q)) return false;
        seen.add(q.q);
        return true;
      });

      // ---------------- SUMMARY ----------------
      const chapterMap = {};

      questions.forEach(q => {
        if (!chapterMap[q.topic]) {
          chapterMap[q.topic] = { count: 0 };
        }
        chapterMap[q.topic].count++;
      });

      const summary = Object.entries(chapterMap).map(([k, v]) => ({
        chapter: k,
        count: v.count,
        pct: ((v.count / questions.length) * 100).toFixed(1)
      }));

      // ---------------- CSV ----------------
      const csv = [
        "Q No,Question,Topic,Subtopic",
        ...questions.map(q =>
          `${q.q},"${q.text}","${q.topic}","${q.subtopic}"`
        )
      ].join("\n");

      res.json({
        questions,
        summary,
        csv
      });

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ---------------- SERVER ----------------
app.listen(PORT, () =>
  console.log(`Running on http://localhost:${PORT}`)
);
