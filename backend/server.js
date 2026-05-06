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
    const text = content.items.map((item) => item.str).join(" ").trim();

    pages.push({
      pageNum: i,
      text,
    });
  }

  return pages;
}

// ================= PAPER TYPE DETECTION =================
function detectPaperType(pages) {
  const text = pages
    .slice(0, 3)
    .map((p) => p.text)
    .join(" ")
    .toLowerCase();

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

// ================= PAGE SCORING =================
function scorePage(text) {
  if (!text || text.trim().length < 40) return -10;

  const clean = text.replace(/\s+/g, " ").trim();
  const lower = clean.toLowerCase();

  let score = 0;

  const negativePatterns = [
    "blank page",
    "instructions",
    "information",
    "candidate name",
    "centre number",
    "candidate number",
    "this document has",
    "copyright acknowledgements",
    "permission to reproduce",
    "multiple choice answer sheet",
  ];

  negativePatterns.forEach((p) => {
    if (lower.includes(p)) score -= 3;
  });

  const positivePatterns = [
    /^\s*\d+[\.)]\s+/m,
    /\b\d+[\.)]\s+the diagram shows/i,
    /\b\d+[\.)]\s+a student/i,
    /\b\d+[\.)]\s+which/i,
    /\(a\)/i,
    /\(b\)/i,
    /\(i\)/i,
    /\[\d+\]/,
    /\[total:\s*\d+\]/i,
    /calculate/i,
    /state/i,
    /explain/i,
    /describe/i,
    /figure\s+\d+\.\d+/i,
    /table\s+\d+\.\d+/i,
    /A\s+.*B\s+.*C\s+.*D/i,
  ];

  positivePatterns.forEach((p) => {
    if (p.test(clean)) score += 3;
  });

  if (clean.length > 250) score += 2;
  if (/\b\d+\b/.test(clean)) score += 1;

  return score;
}

// ================= GET QUESTION PAGES =================
function getQuestionPages(pages) {
  const scored = pages.map((p) => ({
    ...p,
    score: scorePage(p.text),
  }));

  let questionPages = scored.filter((p) => p.score >= 3);

  if (questionPages.length === 0) {
    questionPages = scored.filter((p) => p.score > 0);
  }

  if (questionPages.length === 0) {
    questionPages = pages;
  }

  return questionPages;
}

// ================= EXPECTED QUESTION COUNT =================
function wordToNumber(word) {
  const map = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
  };

  return map[word.toLowerCase()] || null;
}

function detectExpectedQuestionCount(pages, paperType) {
  const fullText = pages.map((p) => p.text).join("\n");

  const explicit = fullText.match(/there\s+are\s+([a-z]+|\d+)\s+questions/i);
  if (explicit) {
    const val = explicit[1].toLowerCase();
    return /^\d+$/.test(val) ? parseInt(val, 10) : wordToNumber(val);
  }

  const totalQuestions = fullText.match(/total\s+number\s+of\s+questions\s*[:\-]?\s*(\d+)/i);
  if (totalQuestions) {
    return parseInt(totalQuestions[1], 10);
  }

  const marks = fullText.match(/maximum\s+marks\s*[:\-]?\s*(\d+)/i);
  if (paperType === "MCQ" && marks) {
    return parseInt(marks[1], 10);
  }

  const nums = [];
  const regex = /(?:^|\n|\s)(\d{1,3})[\.)]\s+/g;
  let match;

  while ((match = regex.exec(fullText)) !== null) {
    const n = parseInt(match[1], 10);
    if (n > 0 && n < 200) nums.push(n);
  }

  return nums.length ? Math.max(...nums) : null;
}

function extractMissingMcqQuestion(fullText, qNum, expectedCount) {
  const nextPart =
    qNum < expectedCount
      ? `(?=\\s+${qNum + 1}[\\.)]\\s+)`
      : `(?=$)`;

  const regex = new RegExp(`${qNum}[\\.)]\\s+([\\s\\S]*?)${nextPart}`, "m");
  const match = fullText.match(regex);

  if (!match || !match[1]) return null;

  return match[1].replace(/\s+/g, " ").trim().slice(0, 220);
}

// ================= ADAPTIVE CHUNKING =================
function getChunkSize(totalPages, paperType) {
  if (paperType === "MCQ") return 1200;
  if (paperType === "THEORY") return 1000;
  if (paperType === "PRACTICAL") return 1000;

  return 1000;
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
  limits: {
    fileSize: 30 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed."));
    }
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
            content:
              "You are a JSON API. Return ONLY valid JSON. No explanation. No markdown. No text before or after JSON.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        model: "llama-3.1-8b-instant",
        temperature: 0,
        max_tokens: 1200,
        response_format: { type: "json_object" },
      });

      let raw = completion.choices[0]?.message?.content?.trim() || "";

      raw = raw
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();

      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed.questions)) return parsed.questions;
      if (Array.isArray(parsed)) return parsed;

      return [];
    } catch (err) {
      console.error("Groq JSON error:", err.message);

      if (attempt < retries - 1) {
        await sleep(3000);
        continue;
      }

      throw err;
    }
  }

  return [];
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

      console.log("QP total pages:", qpPages.length);
      console.log("Detected paper type:", paperType);
      console.log("Expected question count:", expectedQuestionCount || "Unknown");

      const questionPages = getQuestionPages(qpPages);

      console.log(
        "Question pages:",
        questionPages.map((p) => p.pageNum).join(", ")
      );

      const chunks = buildChunks(questionPages, qpPages.length, paperType);

      console.log("Total chunks:", chunks.length);

      const syllabusText = sylPages
        .slice(0, 3)
        .map((p) => `[Page ${p.pageNum}]\n${p.text}`)
        .join("\n\n")
        .slice(0, 1000);

      const groq = new Groq({
        apiKey: process.env.GROQ_API_KEY,
      });

      const allQuestions = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunkText = chunks[i]
          .map((p) => `[Page ${p.pageNum}]\n${p.text}`)
          .join("\n\n");

        const prompt = `
You are an IGCSE Physics question paper parser.

Paper type detected: ${paperType}
Expected question count, if detected: ${expectedQuestionCount || "Unknown"}

Return ONLY this JSON object format:
{
  "questions": [
    {
      "q": 1,
      "text": "brief question summary under 100 characters",
      "topic": "IGCSE syllabus chapter",
      "subtopic": "IGCSE syllabus subtopic",
      "answer": ""
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
- Extract every visible main question number in this chunk.
- For MCQ Paper 2, extract every MCQ question separately.
- For Theory Paper 4, group subparts under the main question number.
- For Practical Paper 6, group experiment tasks under the main question number.
- q must be the exact main question number.
- Ignore cover pages, instruction pages, blank pages, candidate details, copyright text, and barcodes.
- Include only real questions.
- topic must match the syllabus chapter as closely as possible.
- subtopic must match the syllabus subtopic as closely as possible.
- If unsure, make the best educated syllabus match.
`;

        console.log(`Processing chunk ${i + 1}/${chunks.length}`);

        const result = await callGroq(groq, prompt);

        if (Array.isArray(result)) {
          allQuestions.push(...result);
        }

        if (i < chunks.length - 1) {
          await sleep(2000);
        }
      }

      // ================= DYNAMIC MCQ FALLBACK =================
      if (paperType === "MCQ" && expectedQuestionCount) {
        const fullQpText = questionPages.map((p) => p.text).join("\n");

        for (let n = 1; n <= expectedQuestionCount; n++) {
          const exists = allQuestions.some((q) => parseInt(q.q, 10) === n);

          if (!exists) {
            const fallbackText = extractMissingMcqQuestion(
              fullQpText,
              n,
              expectedQuestionCount
            );

            if (fallbackText) {
              allQuestions.push({
                q: n,
                text: fallbackText,
                topic: "Unmapped",
                subtopic: "Unmapped",
                answer: "",
              });
            }
          }
        }
      }

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

          return true;
        })
        .sort((a, b) => a.q - b.q);

      const totalQuestions = questions.length;

      if (totalQuestions === 0) {
        return res.status(500).json({
          success: false,
          error:
            "No questions could be extracted. Please check that the PDF is readable.",
        });
      }

      const missingNums = [];

      if (paperType === "MCQ" && expectedQuestionCount) {
        const extractedNums = questions.map((q) => q.q);

        for (let n = 1; n <= expectedQuestionCount; n++) {
          if (!extractedNums.includes(n)) missingNums.push(n);
        }
      }

      const chapterMap = {};

      questions.forEach((q) => {
        const topic = q.topic || "Unmapped";
        const subtopic = q.subtopic || "Unmapped";

        if (!chapterMap[topic]) {
          chapterMap[topic] = {
            count: 0,
            subtopics: {},
          };
        }

        chapterMap[topic].count++;

        subtopic.split("/").forEach((s) => {
          const key = s.trim();

          if (key) {
            chapterMap[topic].subtopics[key] =
              (chapterMap[topic].subtopics[key] || 0) + 1;
          }
        });
      });

      const chapterSummary = Object.entries(chapterMap)
        .map(([chapter, data]) => ({
          chapter,
          count: data.count,
          pct: parseFloat(((data.count / totalQuestions) * 100).toFixed(1)),
          subtopics: Object.entries(data.subtopics).map(([name, count]) => ({
            name,
            count,
          })),
        }))
        .sort((a, b) => b.count - a.count);

      const top = chapterSummary[0] || {
        chapter: "N/A",
        count: 0,
        pct: 0,
      };

      const insights = [
        `Paper type detected: ${paperType}`,
        `Expected questions detected dynamically: ${
          expectedQuestionCount || "Unknown"
        }`,
        `Missing question numbers after fallback: ${
          missingNums.length ? missingNums.join(", ") : "None"
        }`,
        `Paper processed from ${qpPages.length} pages total.`,
        `${questionPages.length} question-bearing pages identified dynamically.`,
        `Heaviest chapter: "${top.chapter}" with ${top.count} questions (${top.pct}% of paper).`,
        `Total of ${totalQuestions} questions mapped across ${chapterSummary.length} topic chapters.`,
      ];

      return res.json({
        success: true,
        data: {
          totalQuestions,
          questions,
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
