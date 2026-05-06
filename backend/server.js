require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const Groq = require("groq-sdk");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ================= PDF EXTRACT =================
async function extractPdfPages(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
  }).promise;

  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    const items = content.items
      .map((item) => ({
        str: item.str,
        x: item.transform[4],
        y: Math.round(item.transform[5]),
      }))
      .filter((item) => item.str && item.str.trim());

    items.sort((a, b) => {
      if (Math.abs(b.y - a.y) > 3) return b.y - a.y;
      return a.x - b.x;
    });

    let lines = [];
    let currentY = null;
    let currentLine = [];

    for (const item of items) {
      if (currentY === null || Math.abs(item.y - currentY) <= 3) {
        currentLine.push(item.str);
        currentY = item.y;
      } else {
        lines.push(currentLine.join(" "));
        currentLine = [item.str];
        currentY = item.y;
      }
    }

    if (currentLine.length) lines.push(currentLine.join(" "));

    const text = lines.join("\n").trim();

    pages.push({
      pageNum: i,
      text,
    });
  }

  return pages;
}
// ================= PAPER TYPE =================
function detectPaperType(pages) {
  const text = pages.slice(0, 3).map((p) => p.text).join(" ").toLowerCase();
  if (text.includes("multiple choice") || text.includes("paper 2") || text.includes("mcqs")) {
    return "MCQ";
  }
  if (text.includes("theory") || text.includes("paper 4")) {
    return "THEORY";
  }
  if (text.includes("alternative to practical") || text.includes("paper 6")) {
    return "PRACTICAL";
  }
  return "UNKNOWN";
}

// ================= QUESTION PAGE DETECTION =================
function scorePage(text) {
  if (!text || text.trim().length < 40) return -10;
  const clean = text.replace(/\s+/g, " ").trim();
  const lower = clean.toLowerCase();
  let score = 0;
  const negativePatterns = [
    "blank page",
    "candidate name",
    "centre number",
    "candidate number",
    "copyright acknowledgements",
    "permission to reproduce",
    "multiple choice answer sheet",
  ];
  negativePatterns.forEach((p) => { if (lower.includes(p)) score -= 3; });
  const positivePatterns = [
    /\b\d{1,3}[\.)]?\s+(a|an|the|which|what|why|how|identify|calculate|state|explain|describe)/i,
    /\(a\)/i,
    /\(b\)/i,
    /\[\d+\]/,
    /calculate|state|explain|describe|which|what/i,
    /A\s+.*B\s+.*C\s+.*D/i,
  ];
  positivePatterns.forEach((p) => { if (p.test(clean)) score += 3; });
  if (clean.length > 250) score += 2;
  return score;
}

function getQuestionPages(pages) {
  const scored = pages.map((p) => ({ ...p, score: scorePage(p.text) }));
  let questionPages = scored.filter((p) => p.score >= 3);
  if (questionPages.length === 0) questionPages = scored.filter((p) => p.score > 0);
  if (questionPages.length === 0) questionPages = pages;
  return questionPages;
}

// ================= EXPECTED QUESTION COUNT =================
function wordToNumber(word) {
  const map = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  };
  return map[word.toLowerCase()] || null;
}

function detectExpectedQuestionCount(pages, paperType) {
  const fullText = pages.map((p) => p.text).join(" ");

  const explicit = fullText.match(/there\s+are\s+([a-z]+|\d+)\s+questions/i);
  if (explicit) {
    const val = explicit[1].toLowerCase();
    return /^\d+$/.test(val) ? parseInt(val, 10) : wordToNumber(val);
  }

  const totalMatch = fullText.match(/total\s+number\s+of\s+questions\s*[:\-]?\s*(\d+)/i);
  if (totalMatch) return parseInt(totalMatch[1], 10);

  const marks = fullText.match(/maximum\s+marks\s*[:\-]?\s*(\d+)/i);
  if (paperType === "MCQ" && marks) return parseInt(marks[1], 10);

  // Fallback: find highest question number in text
  const nums = [];
  const regex = /(?:^|\s)(\d{1,3})[\.)]?\s+(?=[A-Z])/g;
  let match;
  while ((match = regex.exec(fullText)) !== null) {
    const n = parseInt(match[1], 10);
    if (n > 0 && n < 200) nums.push(n);
  }
  return nums.length ? Math.max(...nums) : null;
}

// ================= MCQ EXTRACTION =================
function cleanQuestionText(text, qNum) {
  return text
    .replace(new RegExp(`^\\s*${qNum}[\\.)]?\\s+`), "")
    .replace(/<<<PAGE:\d+>>>/g, " ")
    .replace(/Page\s+\d+\s+of\s+\d+/gi, " ")
    .replace(/© Cambridge University Press & Assessment \d{4}/gi, " ")
    .replace(/\b0625\/\d+\/[A-Z]\/[A-Z]\/\d+\b/gi, " ")
    .replace(/\[Turn over\]/gi, " ")
    .replace(/Permission to reproduce[\s\S]*?Cambridge International Education/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    // FIX: trim to 120 chars so options A B C D don't appear in summary
    .slice(0, 120);
}

function extractMcqQuestionsFromText(pages, expectedCount) {
  const fullText = pages
    .map((p) => `\n<<<PAGE:${p.pageNum}>>>\n${p.text}`)
    .join("\n");

  const questions = [];
  if (!expectedCount) return questions;

  const starts = [];

  for (let n = 1; n <= expectedCount; n++) {
    const regex = new RegExp(
      `(?:^|\\n)\\s*${n}[\\.)]?\\s+`,
      "m"
    );

    const match = fullText.match(regex);

    if (match) {
      starts.push({
        q: n,
        start: match.index,
      });
    }
  }

  for (let i = 0; i < starts.length; i++) {
    const current = starts[i];
    const next = starts[i + 1];

    const raw = fullText.slice(
      current.start,
      next ? next.start : fullText.length
    );

    const pageMatch = raw.match(/<<<PAGE:(\d+)>>>/);
    const pageNum = pageMatch ? parseInt(pageMatch[1], 10) : null;

    let text = raw
      .replace(/<<<PAGE:\d+>>>/g, " ")
      .replace(new RegExp(`^\\s*${current.q}[\\.)]?\\s+`), "")
      .replace(/Page\s+\d+\s+of\s+\d+/gi, " ")
      .replace(/© Cambridge University Press & Assessment \d{4}/gi, " ")
      .replace(/\b0625\/\d+\/[A-Z]\/[A-Z]\/\d+\b/gi, " ")
      .replace(/\[Turn over\]/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (text) {
      questions.push({
        q: current.q,
        text: text.slice(0, 220),
        topic: "Unmapped",
        subtopic: "Unmapped",
        answer: "",
        marks: 1,
        pageNum,
      });
    }
  }

  return questions;
}

// ================= CHUNKING =================
function getChunkSize(totalPages, paperType) {
  if (paperType === "MCQ") return 1400;
  if (paperType === "THEORY") return 1200;
  if (paperType === "PRACTICAL") return 1200;
  return 1200;
}

function buildChunks(questionPages, totalPages, paperType) {
  const maxChars = getChunkSize(totalPages, paperType);
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const page of questionPages) {
    const pageLen = page.text.length;
    if (current.length > 0 && currentLen + pageLen > maxChars) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(page);
    currentLen += pageLen;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ================= MULTER =================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed."));
  },
});

// ================= HELPERS =================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ================= GROQ CALL =================
async function callGroq(groq, prompt, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content: "You are a JSON API. Return ONLY valid JSON. No explanation. No markdown.",
          },
          { role: "user", content: prompt },
        ],
        model: "llama-3.1-8b-instant",
        temperature: 0,
        max_tokens: 900,
        response_format: { type: "json_object" },
      });
      const raw = completion.choices[0]?.message?.content?.trim() || "";
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.questions)) return parsed.questions;
      if (Array.isArray(parsed.mappings)) return parsed.mappings;
      if (Array.isArray(parsed)) return parsed;
      return [];
    } catch (err) {
      console.error("Groq JSON error:", err.message);
      if (attempt < retries - 1) { await sleep(3000); continue; }
      throw err;
    }
  }
  return [];
}

// ================= AI TOPIC MAPPING FOR MCQ =================
async function mapMcqTopicsWithAI(groq, questions, syllabusText) {
  const mapped = [];
  const batchSize = 6;

  for (let i = 0; i < questions.length; i += batchSize) {
    const batch = questions.slice(i, i + batchSize);
    const prompt = `
You are an IGCSE Physics syllabus mapper.
Return ONLY this JSON object:
{
  "questions": [
    {
      "q": 1,
      "topic": "IGCSE syllabus chapter",
      "subtopic": "IGCSE syllabus subtopic"
    }
  ]
}

SYLLABUS REFERENCE:
${syllabusText}

QUESTIONS TO MAP:
${batch.map((q) => `Q${q.q}: ${q.text}`).join("\n")}

STRICT RULES:
- Do not create new question numbers.
- Return the same q values given.
- Only map topic and subtopic.
- Return valid JSON only.
`;
    try {
      const result = await callGroq(groq, prompt);
      const resultMap = new Map();
      result.forEach((r) => {
        const qNum = parseInt(r.q, 10);
        if (!Number.isNaN(qNum)) resultMap.set(qNum, r);
      });
      batch.forEach((q) => {
        const ai = resultMap.get(q.q);
        mapped.push({
          ...q,
          topic: ai?.topic || q.topic || "Unmapped",
          subtopic: ai?.subtopic || q.subtopic || "Unmapped",
          answer: q.answer || "",
          marks: q.marks || 1,
        });
      });
    } catch (err) {
      console.error("Topic mapping batch failed:", err.message);
      batch.forEach((q) => mapped.push(q));
    }

    if (i + batchSize < questions.length) await sleep(1500);
  }

  return mapped;
}

// ================= API ROUTE =================
app.post(
  "/api/analyse",
  upload.fields([
    { name: "questionPaper", maxCount: 1 },
    { name: "syllabus", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      if (!req.files?.questionPaper || !req.files?.syllabus) {
        return res.status(400).json({
          success: false,
          error: "Both question paper and syllabus PDFs are required.",
        });
      }

      const [qpPages, sylPages] = await Promise.all([
        extractPdfPages(req.files.questionPaper[0].buffer),
        extractPdfPages(req.files.syllabus[0].buffer),
      ]);

      const paperType = detectPaperType(qpPages);
      const expectedQuestionCount = detectExpectedQuestionCount(qpPages, paperType);
      const questionPages = getQuestionPages(qpPages);

      console.log(`Paper type: ${paperType}, Expected questions: ${expectedQuestionCount}, Question pages: ${questionPages.length}`);

      const syllabusText = sylPages
        .slice(0, 3)
        .map((p) => `[Page ${p.pageNum}]\n${p.text}`)
        .join("\n\n")
        .slice(0, 1000);

      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

      let allQuestions = [];

      if (paperType === "MCQ") {
        const serverExtracted = extractMcqQuestionsFromText(qpPages, expectedQuestionCount);
        console.log("Server extracted MCQs:", serverExtracted.length);
        if (serverExtracted.length > 0) {
          allQuestions = await mapMcqTopicsWithAI(groq, serverExtracted, syllabusText);
        }
      }

      if (paperType !== "MCQ" || allQuestions.length === 0) {
        const chunks = buildChunks(questionPages, qpPages.length, paperType);
        for (let i = 0; i < chunks.length; i++) {
          const chunkText = chunks[i]
            .map((p) => `[Page ${p.pageNum}]\n${p.text}`)
            .join("\n\n");
          const prompt = `
You are an IGCSE Physics question paper parser.
Paper type detected: ${paperType}
Return ONLY this JSON object format:
{
  "questions": [
    {
      "q": 1,
      "text": "brief question summary under 100 characters",
      "topic": "IGCSE syllabus chapter",
      "subtopic": "IGCSE syllabus subtopic",
      "answer": "",
      "marks": 1
    }
  ]
}

SYLLABUS REFERENCE:
${syllabusText}

QUESTION PAPER TEXT:
${chunkText}

STRICT RULES:
- Return only valid JSON object.
- Use the key "questions".
- Extract every visible main question number.
- For Theory Paper 4, group subparts under main question number.
- For Practical Paper 6, group experiment tasks under main question number.
- q must be exact main question number.
- topic and subtopic must match syllabus as closely as possible.
`;
          const result = await callGroq(groq, prompt);
          if (Array.isArray(result)) allQuestions.push(...result);
          if (i < chunks.length - 1) await sleep(2000);
        }
      }

      // Deduplicate and clean
      const seen = new Set();
      const questions = allQuestions
        .filter((q) => {
          if (!q || q.q === undefined || q.q === null) return false;
          const qNum = parseInt(q.q, 10);
          if (Number.isNaN(qNum)) return false;
          if (seen.has(qNum)) return false;
          seen.add(qNum);
          q.q = qNum;
          q.text = q.text || "";
          q.topic = q.topic || "Unmapped";
          q.subtopic = q.subtopic || "Unmapped";
          q.answer = q.answer || "";
          q.marks = Number(q.marks) || 1;
          return true;
        })
        .sort((a, b) => a.q - b.q);

      const finalQuestions = questions.map((q) => ({
        q: parseInt(q.q, 10),
        text: q.text || "",
        topic: q.topic && q.topic.trim() ? q.topic.trim() : "Unmapped",
        subtopic: q.subtopic && q.subtopic.trim() ? q.subtopic.trim() : "Unmapped",
        answer: q.answer || "",
        marks: Number(q.marks) || 1,
        pageNum: q.pageNum || null,
      }));

      // FIX: always compute from finalQuestions directly — no variable shadowing
      const totalQuestions = finalQuestions.length;
      const totalMarks = finalQuestions.reduce((sum, q) => sum + (Number(q.marks) || 1), 0);

      console.log(`Final questions: ${totalQuestions}, Total marks: ${totalMarks}`);

      if (totalQuestions === 0) {
        return res.status(500).json({
          success: false,
          error: "No questions could be extracted. Please check that the PDF is readable.",
        });
      }

      // Missing question check
      const missingNums = [];
      if (paperType === "MCQ" && expectedQuestionCount) {
        const extractedNums = finalQuestions.map((q) => q.q);
        for (let n = 1; n <= expectedQuestionCount; n++) {
          if (!extractedNums.includes(n)) missingNums.push(n);
        }
        if (missingNums.length > 0) {
          console.log("Missing question numbers:", missingNums.join(", "));
        }
      }

      // Build chapter summary
      const chapterMap = {};
      finalQuestions.forEach((q) => {
        const topic = q.topic || "Unmapped";
        const subtopic = q.subtopic || "Unmapped";
        if (!chapterMap[topic]) chapterMap[topic] = { count: 0, marks: 0, subtopics: {} };
        chapterMap[topic].count += 1;
        chapterMap[topic].marks += Number(q.marks) || 1;
        chapterMap[topic].subtopics[subtopic] = (chapterMap[topic].subtopics[subtopic] || 0) + 1;
      });

      const chapterSummary = Object.entries(chapterMap)
        .map(([chapter, data]) => ({
          chapter,
          count: data.count,
          marks: data.marks,
          // FIX: use finalQuestions.length directly — prevents any rounding drift
          pct: parseFloat(((data.count / finalQuestions.length) * 100).toFixed(1)),
          subtopics: Object.entries(data.subtopics).map(([name, count]) => ({ name, count })),
        }))
        .sort((a, b) => b.count - a.count);

      const top = chapterSummary[0] || { chapter: "N/A", count: 0, pct: 0 };

      const insights = [
        `Paper type detected: ${paperType}`,
        `Expected questions detected dynamically: ${expectedQuestionCount || "Unknown"}`,
        `Actual extracted questions used for report: ${totalQuestions}`,
        `Missing question numbers after extraction: ${missingNums.length ? missingNums.join(", ") : "None"}`,
        `Paper processed from ${qpPages.length} pages total.`,
        `${questionPages.length} question-bearing pages identified dynamically.`,
        `Heaviest chapter: "${top.chapter}" with ${top.count} questions (${top.pct}% of paper).`,
        `Total of ${totalQuestions} questions mapped across ${chapterSummary.length} topic chapters.`,
      ];

      // FIX: send finalQuestions.length explicitly — not a variable that could be stale
      return res.json({
        success: true,
        data: {
          totalQuestions: finalQuestions.length,
          totalMarks: finalQuestions.reduce((sum, q) => sum + (Number(q.marks) || 1), 0),
          questions: finalQuestions,
          chapterSummary,
          insights,
          paperTitle: "Physics Question Paper",
          paperInfo: `IGCSE ${paperType}`,
        },
      });

    } catch (err) {
      console.error("Analysis error:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Analysis failed.",
      });
    }
  }
);

// ================= SERVE FRONTEND =================
app.use(express.static(path.join(__dirname, "public")));
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ================= START SERVER =================
app.listen(PORT, () => {
  console.log(`PhysicsAnalyser running on http://localhost:${PORT}`);
});
