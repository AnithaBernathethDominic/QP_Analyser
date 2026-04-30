require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── PDF text extractor using pdfjs-dist ───────────────────────────────────────
async function extractPdfText(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((item) => item.str).join(" ") + "\n";
  }
  return text;
}

// ── Multer — memory storage (no disk writes needed) ───────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files allowed"));
  },
});

// ── POST /api/analyse ─────────────────────────────────────────────────────────
app.post(
  "/api/analyse",
  upload.fields([
    { name: "questionPaper", maxCount: 1 },
    { name: "syllabus", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      if (!req.files?.questionPaper || !req.files?.syllabus) {
        return res.status(400).json({ error: "Both PDF files are required." });
      }

      // Extract text from both PDFs in parallel
      const [qpText, sylText] = await Promise.all([
        extractPdfText(req.files.questionPaper[0].buffer),
        extractPdfText(req.files.syllabus[0].buffer),
      ]);

      const qpTextTrimmed  = qpText.slice(0, 12000);  // trim for token budget
      const sylTextTrimmed = sylText.slice(0, 6000);

      const client = new Anthropic();

      const systemPrompt = `You are an expert IGCSE Physics teacher and examiner. 
Your job is to parse a question paper and map every question to the correct syllabus topic and subtopic.
You MUST return ONLY a valid JSON object — no preamble, no markdown fences, no explanation.`;

      const userPrompt = `
SYLLABUS:
${sylTextTrimmed}

QUESTION PAPER:
${qpTextTrimmed}

TASK:
1. Parse every question from the question paper (all MCQ questions numbered 1-N).
2. For each question, identify:
   - q: question number (integer)
   - text: brief one-sentence summary of what the question asks (max 120 chars)
   - topic: the matching chapter/topic from the syllabus (e.g. "1.2 Motion")
   - subtopic: the specific subtopic(s) from the syllabus (e.g. "1.2.2 Acceleration")
   - answer: leave as "" since answer key is not provided

3. Also produce a chapterSummary array:
   - chapter: chapter name
   - count: number of questions
   - pct: percentage of total marks (1 mark each)
   - subtopics: array of { name, count }

4. Also produce an insights array of 5 short strings, each a bullet insight about the paper.

Return this exact JSON structure:
{
  "totalQuestions": <number>,
  "questions": [ { "q": 1, "text": "...", "topic": "...", "subtopic": "...", "answer": "" }, ... ],
  "chapterSummary": [ { "chapter": "...", "count": 0, "pct": 0, "subtopics": [ { "name": "...", "count": 0 } ] }, ... ],
  "insights": ["...", "...", "...", "...", "..."],
  "paperTitle": "<detected paper title or 'Physics Question Paper'>",
  "paperInfo": "<grade/exam info if found>"
}`;

      const message = await client.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 8000,
        messages: [{ role: "user", content: userPrompt }],
        system: systemPrompt,
      });

      let raw = message.content[0].text.trim();
      // Strip any accidental markdown fences
      raw = raw
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();

      const result = JSON.parse(raw);
      return res.json({ success: true, data: result });

    } catch (err) {
      console.error("Analysis error:", err);
      return res.status(500).json({ error: err.message || "Analysis failed" });
    }
  }
);

// ── Serve frontend ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get(/.*/, (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

app.listen(PORT, () =>
  console.log(`PhysicsAnalyser server running on http://localhost:${PORT}`)
);
