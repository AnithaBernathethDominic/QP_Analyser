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

/* ───────────────────────────────────────────────────────────────
   PDF TEXT EXTRACTOR
─────────────────────────────────────────────────────────────── */
async function extractPdfText(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;

  let text = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(" ") + "\n";
  }

  return text;
}

/* ───────────────────────────────────────────────────────────────
   MULTER
─────────────────────────────────────────────────────────────── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files allowed"));
  },
});

/* ───────────────────────────────────────────────────────────────
   HELPERS
─────────────────────────────────────────────────────────────── */
function splitText(text, maxLen = 7000) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    chunks.push(text.slice(start, start + maxLen));
    start += maxLen;
  }

  return chunks;
}

function safeParse(raw) {
  try {
    return JSON.parse(
      raw.replace(/^```json/i, "")
         .replace(/^```/, "")
         .replace(/```$/, "")
         .trim()
    );
  } catch {
    return { questions: [] };
  }
}

/* ───────────────────────────────────────────────────────────────
   MAIN API
─────────────────────────────────────────────────────────────── */
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

      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

      // 🔥 Split QP text to avoid token overflow
      const qpChunks = splitText(qpText, 7000);

      let allQuestions = [];

      /* ─────────────────────────────────────────────
         MULTIPLE API CALLS
      ───────────────────────────────────────────── */
      for (let i = 0; i < qpChunks.length; i++) {

        const prompt = `
You are an expert IGCSE Physics examiner.

Return ONLY valid JSON.

SYLLABUS:
${sylText.slice(0, 6000)}

QUESTION PAPER PART ${i + 1}:
${qpChunks[i]}

TASK:
Extract ALL questions in this part.

Return format:
{
  "questions": [
    {
      "q": number,
      "text": "short summary",
      "topic": "topic",
      "subtopic": "subtopic",
      "answer": ""
    }
  ]
}
`;

        const completion = await groq.chat.completions.create({
          messages: [{ role: "user", content: prompt }],
          model: "llama-3.3-70b-versatile",
          temperature: 0.2,
          max_tokens: 4000,
        });

        const raw = completion.choices[0]?.message?.content || "{}";
        const parsed = safeParse(raw);

        allQuestions.push(...(parsed.questions || []));
      }

      /* ─────────────────────────────────────────────
         REMOVE DUPLICATES + SORT
      ───────────────────────────────────────────── */
      const unique = {};
      allQuestions.forEach(q => {
        if (q.q) unique[q.q] = q;
      });

      const finalQuestions = Object.values(unique)
        .sort((a, b) => a.q - b.q);

 
    /* ─────────────────────────────────────────────
   BUILD CHAPTER-WISE WEIGHTAGE SUMMARY
───────────────────────────────────────────── */
const chapterMap = {};

finalQuestions.forEach(q => {
  const topic = q.topic || "Unmapped Topic";
  const subtopic = q.subtopic || "Unmapped Subtopic";

  if (!chapterMap[topic]) {
    chapterMap[topic] = {
      chapter: topic,
      topic: topic,
      count: 0,
      questions: 0,
      marks: 0,
      subtopics: {}
    };
  }

  chapterMap[topic].count += 1;
  chapterMap[topic].questions += 1;
  chapterMap[topic].marks += 1;

  if (!chapterMap[topic].subtopics[subtopic]) {
    chapterMap[topic].subtopics[subtopic] = {
      name: subtopic,
      count: 0,
      questions: 0,
      marks: 0
    };
  }

  chapterMap[topic].subtopics[subtopic].count += 1;
  chapterMap[topic].subtopics[subtopic].questions += 1;
  chapterMap[topic].subtopics[subtopic].marks += 1;
});

const totalMarks = finalQuestions.length;

const chapterSummary = Object.values(chapterMap).map(ch => {
  const percentage = totalMarks > 0
    ? Number(((ch.marks / totalMarks) * 100).toFixed(1))
    : 0;

  return {
    chapter: ch.chapter,
    topic: ch.topic,

    // frontend-safe fields
    count: ch.count,
    questions: ch.questions,
    marks: ch.marks,
    pct: percentage,
    percentage: percentage,

    subtopics: Object.values(ch.subtopics).map(st => ({
      name: st.name,
      count: st.count,
      questions: st.questions,
      marks: st.marks,
      pct: Number(((st.marks / totalMarks) * 100).toFixed(1)),
      percentage: Number(((st.marks / totalMarks) * 100).toFixed(1))
    }))
  };
});
      /* ─────────────────────────────────────────────
         FINAL RESPONSE
      ───────────────────────────────────────────── */
      return res.json({
  success: true,
  data: {
    totalQuestions: finalQuestions.length,
    totalMarks: finalQuestions.length,
    questions: finalQuestions,
    chapterSummary,
    insights: [
      "Balanced distribution across topics",
      "Includes numerical and conceptual questions",
      "Covers core syllabus areas",
      "Good variety of difficulty levels",
      "Strong focus on mechanics and energy"
    ],
    paperTitle: "Physics Question Paper",
    paperInfo: "IGCSE Grade 9"
  }
});

    } catch (err) {
      console.error("Analysis error:", err);
      return res.status(500).json({ error: err.message });
    }
  }
);

/* ───────────────────────────────────────────────────────────────
   FRONTEND SERVE
─────────────────────────────────────────────────────────────── */
app.use(express.static(path.join(__dirname, "public")));

app.get(/.*/, (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

/* ───────────────────────────────────────────────────────────────
   START SERVER
─────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
