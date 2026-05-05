require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const Groq = require("groq-sdk");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ================= PDF EXTRACT =================
async function extractPdfPages(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map(i => i.str).join(" ").trim();
    pages.push({ pageNum: i, text });
  }
  return pages;
}

// ================= PAPER TYPE =================
function detectPaperType(pages) {
  const text = pages.slice(0, 3).map(p => p.text).join(" ").toLowerCase();

  if (text.includes("multiple choice") || text.includes("paper 2")) return "MCQ";
  if (text.includes("theory") || text.includes("paper 4")) return "THEORY";
  if (text.includes("alternative to practical") || text.includes("paper 6")) return "PRACTICAL";

  return "UNKNOWN";
}

// ================= PAGE SCORING =================
function scorePage(text) {
  if (!text || text.length < 40) return -10;

  const lower = text.toLowerCase();
  let score = 0;

  const negative = [
    "instructions",
    "information",
    "candidate",
    "centre number",
    "blank page",
    "do not write",
    "copyright",
    "multiple choice answer sheet"
  ];

  negative.forEach(p => {
    if (lower.includes(p)) score -= 3;
  });

  const positive = [
    /^\s*\d+\s+/m,
    /\(a\)/,
    /\(b\)/,
    /\[\d+\]/,
    /calculate|state|explain|describe/i,
    /A\s+.*B\s+.*C\s+.*D/i
  ];

  positive.forEach(p => {
    if (p.test(text)) score += 3;
  });

  if (text.length > 200) score += 1;

  return score;
}

// ================= GET QUESTION PAGES =================
function getQuestionPages(pages) {
  const scored = pages.map(p => ({
    ...p,
    score: scorePage(p.text)
  }));

  let filtered = scored.filter(p => p.score >= 3);

  if (filtered.length === 0) filtered = scored.filter(p => p.score > 0);
  if (filtered.length === 0) filtered = pages;

  return filtered;
}

// ================= CHUNKING =================
function getChunkSize(totalPages, type) {
  if (type === "MCQ") return 4500;
  if (type === "THEORY") return 3500;
  if (type === "PRACTICAL") return 3500;

  if (totalPages <= 5) return 4500;
  if (totalPages <= 10) return 3800;
  if (totalPages <= 20) return 3200;
  return 2500;
}

function buildChunks(pages, totalPages, type) {
  const maxChars = getChunkSize(totalPages, type);

  const chunks = [];
  let current = [];
  let len = 0;

  for (const p of pages) {
    if (len + p.text.length > maxChars && current.length) {
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

// ================= MULTER =================
const upload = multer({
  storage: multer.memoryStorage(),
});

// ================= GROQ =================
async function callGroq(groq, prompt) {
  const res = await groq.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    model: "llama-3.1-8b-instant",
    temperature: 0.1,
  });

  let raw = res.choices[0].message.content;
  raw = raw.replace(/```json|```/g, "").trim();

  return JSON.parse(raw);
}

// ================= API =================
app.post(
  "/api/analyse",
  upload.fields([
    { name: "questionPaper", maxCount: 1 },
    { name: "syllabus", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const qp = await extractPdfPages(req.files.questionPaper[0].buffer);
      const syl = await extractPdfPages(req.files.syllabus[0].buffer);

      const type = detectPaperType(qp);
      console.log("Paper type:", type);

      const questionPages = getQuestionPages(qp);
      console.log("Using pages:", questionPages.map(p => p.pageNum));

      const chunks = buildChunks(questionPages, qp.length, type);
      console.log("Chunks:", chunks.length);

      const sylText = syl.slice(0, 2).map(p => p.text).join("\n");

      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

      let all = [];

      for (let i = 0; i < chunks.length; i++) {
        const text = chunks[i].map(p => p.text).join("\n");

        const prompt = `
Paper type: ${type}

Extract questions.

Return JSON:
[
 { "q":1, "text":"...", "topic":"...", "subtopic":"..." }
]

Syllabus:
${sylText}

Text:
${text}
`;

        const result = await callGroq(groq, prompt);
        all.push(...result);
      }

      // remove duplicates
      const seen = new Set();
      const questions = all.filter(q => {
        if (seen.has(q.q)) return false;
        seen.add(q.q);
        return true;
      });

      // summary
      const map = {};
      questions.forEach(q => {
        if (!map[q.topic]) map[q.topic] = { count: 0 };
        map[q.topic].count++;
      });

      const chapterSummary = Object.entries(map).map(([k, v]) => ({
        chapter: k,
        count: v.count,
        pct: (v.count / questions.length) * 100
      }));

      res.json({
        success: true,
        data: {
          totalQuestions: questions.length,
          questions,
          chapterSummary,
          insights: ["Dynamic parsing applied successfully"]
        }
      });

    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);



// ── Serve frontend ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

app.get(/.*/, (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

app.listen(PORT, () =>
  console.log(`PhysicsAnalyser running on http://localhost:${PORT}`)
);

