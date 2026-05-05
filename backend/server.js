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

// ── PDF text extractor ────────────────────────────────────────────────────────
async function extractPdfText(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((item) => item.str).join(" ") + "\n";
  }
  return text;
}

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files allowed"));
  },
});

// ── Sleep helper (for rate limit retries) ─────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Call Groq with retry on rate limit ────────────────────────────────────────
async function callGroq(groq, prompt, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "llama-3.1-8b-instant",
        temperature: 0.1,
        max_tokens: 3000,
      });
      let raw = completion.choices[0]?.message?.content?.trim() || "";
      raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
      return JSON.parse(raw);
    } catch (err) {
      const isRateLimit = err?.status === 429 || err?.message?.includes("rate_limit") || err?.message?.includes("too large");
      if (isRateLimit && attempt < retries - 1) {
        console.log(`Rate limit hit, waiting 15s before retry ${attempt + 1}...`);
        await sleep(15000);
        continue;
      }
      throw err;
    }
  }
}

// ── Split text into N roughly equal chunks ────────────────────────────────────
function splitText(text, parts) {
  const chunkSize = Math.ceil(text.length / parts);
  const chunks = [];
  for (let i = 0; i < parts; i++) {
    chunks.push(text.slice(i * chunkSize, (i + 1) * chunkSize));
  }
  return chunks;
}

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

      const [qpText, sylText] = await Promise.all([
        extractPdfText(req.files.questionPaper[0].buffer),
        extractPdfText(req.files.syllabus[0].buffer),
      ]);

      // Keep syllabus short — just topic/subtopic names, no need for full text
      const sylShort = sylText.slice(0, 2000);

      // Split QP into 4 small chunks — each well within token limits
      const chunks = splitText(qpText, 4);
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

      const makePrompt = (chunk, partNum) => `You are an IGCSE Physics teacher. Parse the questions in this text and map each to the syllabus.
Return ONLY a valid JSON array, no explanation, no markdown.

SYLLABUS TOPICS (for reference):
${sylShort}

QUESTION PAPER TEXT (Part ${partNum} of 4):
${chunk}

Return a JSON array like this:
[{"q":1,"text":"brief summary under 100 chars","topic":"1.2 Motion","subtopic":"1.2.2 Acceleration","answer":""}]

Rules:
- Only include questions actually visible in the text above
- q = the question number shown in the paper (integer)
- topic = matching syllabus chapter e.g. "1.4 Effects of Forces"
- subtopic = specific subtopic e.g. "1.4.3 Newton's Second Law"
- Do NOT duplicate questions
- Return ONLY the JSON array`;

      // Process chunks sequentially to avoid parallel rate limiting
      const allQuestions = [];
      for (let i = 0; i < chunks.length; i++) {
        console.log(`Processing chunk ${i + 1} of ${chunks.length}...`);
        try {
          const result = await callGroq(groq, makePrompt(chunks[i], i + 1));
          if (Array.isArray(result)) allQuestions.push(...result);
        } catch (err) {
          console.error(`Chunk ${i + 1} failed:`, err.message);
          // Continue with other chunks even if one fails
        }
        // Small delay between chunks to respect rate limits
        if (i < chunks.length - 1) await sleep(3000);
      }

      // Deduplicate by question number, keep highest confidence (first seen)
      const seen = new Set();
      const questions = allQuestions
        .filter((q) => q && q.q && !seen.has(q.q) && seen.add(q.q))
        .sort((a, b) => a.q - b.q);

      const totalQuestions = questions.length;

      // Build chapter summary
      const chapterMap = {};
      questions.forEach(({ topic, subtopic }) => {
        if (!topic) return;
        if (!chapterMap[topic]) chapterMap[topic] = { count: 0, subtopics: {} };
        chapterMap[topic].count++;
        (subtopic || "").split("/").forEach((s) => {
          const key = s.trim();
          if (key) chapterMap[topic].subtopics[key] = (chapterMap[topic].subtopics[key] || 0) + 1;
        });
      });

      const chapterSummary = Object.entries(chapterMap)
        .map(([chapter, data]) => ({
          chapter,
          count: data.count,
          pct: parseFloat(((data.count / totalQuestions) * 100).toFixed(1)),
          subtopics: Object.entries(data.subtopics).map(([name, count]) => ({ name, count })),
        }))
        .sort((a, b) => b.count - a.count);

      const top = chapterSummary[0] || { chapter: "N/A", count: 0, pct: 0 };
      const insights = [
        `Heaviest chapter: "${top.chapter}" with ${top.count} questions (${top.pct}% of paper)`,
        `Total of ${totalQuestions} questions mapped across ${chapterSummary.length} IGCSE topic chapters`,
        `Top 2 chapters: ${chapterSummary.slice(0, 2).map((c) => c.chapter).join(" and ")}`,
        `${chapterSummary.filter((c) => c.count === 1).length} chapters appear only once — lower priority for revision`,
        `Chapters not covered are not yet assessed — check syllabus for upcoming topics`,
      ];

      return res.json({
        success: true,
        data: { totalQuestions, questions, chapterSummary, insights, paperTitle: "Physics Question Paper", paperInfo: "IGCSE" },
      });
    } catch (err) {
      console.error("Analysis error:", err);
      return res.status(500).json({ error: err.message || "Analysis failed" });
    }
  }
);

// ── Serve frontend ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`PhysicsAnalyser running on http://localhost:${PORT}`));
