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
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => item.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push({ pageNum: i, text });
  }
  return pages;
}

// ================= PAPER TYPE =================
function detectPaperType(pages) {
  const text = pages.slice(0, 3).map((p) => p.text).join(" ").toLowerCase();
  if (text.includes("multiple choice") || text.includes("paper 2") || text.includes("mcqs")) return "MCQ";
  if (text.includes("theory") || text.includes("paper 4")) return "THEORY";
  if (text.includes("alternative to practical") || text.includes("paper 6")) return "PRACTICAL";
  return "UNKNOWN";
}

// ================= QUESTION PAGE DETECTION =================
function scorePage(text) {
  if (!text || text.trim().length < 40) return -10;
  const clean = text.replace(/\s+/g, " ").trim();
  const lower = clean.toLowerCase();
  let score = 0;
  const negativePatterns = [
    "blank page", "candidate name", "centre number", "candidate number",
    "copyright acknowledgements", "permission to reproduce", "multiple choice answer sheet",
  ];
  negativePatterns.forEach((p) => { if (lower.includes(p)) score -= 3; });
  const positivePatterns = [
    /\b\d{1,3}[\.)]?\s+(a|an|the|which|what|why|how|identify|calculate|state|explain|describe)/i,
    /\(a\)/i, /\(b\)/i, /\[\d+\]/, /calculate|state|explain|describe|which|what/i,
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

  // "there are forty questions" / "there are 40 questions"
  const explicit = fullText.match(/there\s+are\s+([a-z]+|\d+)\s+questions/i);
  if (explicit) {
    const val = explicit[1].toLowerCase();
    return /^\d+$/.test(val) ? parseInt(val, 10) : wordToNumber(val);
  }

  // "Total number of questions: 40"
  const totalMatch = fullText.match(/total\s+number\s+of\s+questions\s*[:\-]?\s*(\d+)/i);
  if (totalMatch) return parseInt(totalMatch[1], 10);

  // "Maximum Marks: 40" — ONLY for MCQ where each question = 1 mark
  // Use a precise regex that captures the full number including tens
  if (paperType === "MCQ") {
    const marks = fullText.match(/maximum\s+marks\s*[:\-]?\s*(\d+)/i);
    if (marks) return parseInt(marks[1], 10);
  }

  return null;
}

// ================= MCQ EXTRACTION =================
function cleanQuestionText(text, qNum) {
  return text
    .replace(new RegExp(`^\\s*${qNum}[\\.):]?\\s+`), "")
    .replace(/<<<PAGE:\d+>>>/g, " ")
    .replace(/Page\s+\d+\s+of\s+\d+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function extractMcqQuestionsFromText(pages, expectedCount) {
  if (!expectedCount) return [];

  // Build full text with page markers — DO NOT aggressively clean
  // as that can break question detection
  const fullText = pages
    .map((p) => ` <<<PAGE:${p.pageNum}>>> ${p.text}`)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const starts = [];
  let searchFrom = 0;

  for (let n = 1; n <= expectedCount; n++) {
    let found = false;

    // We try patterns from most specific to least specific.
    // Key insight: a real question number is:
    //   - preceded by whitespace or start of string
    //   - followed by . or ) or just space
    //   - then followed by a word (capital or lowercase start — school papers vary)
    //   - NOT preceded by another digit (so "10" won't match when looking for "1")
    //   - NOT part of a decimal like "1.0" or "2.5"

    // Build patterns
    const escapedN = String(n);

    // Pattern A: "n. Word" — number dot space word (Cambridge style)
    // Pattern B: "n) Word" — number paren space word
    // Pattern C: "n Word"  — number space word (school paper style like "4 Which")
    // For all: ensure char before n is NOT a digit (avoids "10" matching "1")
    //          ensure char after n+punct is NOT a digit (avoids decimals)

    const patternA = new RegExp(`(?<![\\d])${escapedN}\\.\\s+(?=[A-Za-z])`, "g");
    const patternB = new RegExp(`(?<![\\d])${escapedN}\\)\\s+(?=[A-Za-z])`, "g");
    const patternC = new RegExp(`(?<![\\d])${escapedN}\\s{1,3}(?=[A-Z][a-zA-Z])`, "g");

    for (const pattern of [patternA, patternB, patternC]) {
      if (found) break;
      pattern.lastIndex = searchFrom;

      let match;
      while ((match = pattern.exec(fullText)) !== null) {
        if (match.index < searchFrom) continue;

        // Guard: skip if this is a decimal number like "1.0" "2.5"
        // Check what comes right after the number
        const posAfterNum = match.index + escapedN.length;
        const charAfterNum = fullText[posAfterNum];
        if (charAfterNum === ".") {
          const charAfterDot = fullText[posAfterNum + 1];
          if (charAfterDot && /\d/.test(charAfterDot)) continue; // e.g. "1.0" — skip
        }

        // Guard: skip if too close to previous question start (< 30 chars gap)
        if (starts.length > 0 && match.index - starts[starts.length - 1].start < 30) continue;

        // Guard: skip page marker matches
        if (fullText.slice(Math.max(0, match.index - 10), match.index).includes("PAGE:")) continue;

        const beforeText = fullText.slice(0, match.index);
        const pageMatches = [...beforeText.matchAll(/<<<PAGE:(\d+)>>>/g)];
        const lastPage = pageMatches.length
          ? parseInt(pageMatches[pageMatches.length - 1][1], 10)
          : null;

        starts.push({ q: n, start: match.index, pageNum: lastPage });
        searchFrom = match.index + escapedN.length + 1;
        found = true;
        break;
      }
    }

    if (!found) {
      console.log(`Warning: Could not find question ${n} in text`);
    }
  }

  console.log(`Found starts for ${starts.length} questions out of ${expectedCount} expected`);

  const questions = [];
  for (let i = 0; i < starts.length; i++) {
    const current = starts[i];
    const next = starts[i + 1];
    const raw = fullText.slice(current.start, next ? next.start : fullText.length);
    const text = cleanQuestionText(raw, current.q);
    if (text && text.length > 3) {
      questions.push({
        q: current.q,
        text,
        topic: "Unmapped",
        subtopic: "Unmapped",
        answer: "",
        marks: 1,
        pageNum: current.pageNum,
      });
    }
  }

  return questions;
}

// ================= CHUNKING =================
function buildChunks(questionPages, paperType) {
  const maxChars = paperType === "MCQ" ? 1400 : 1200;
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ================= GROQ CALL =================
async function callGroq(groq, prompt, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        messages: [
          { role: "system", content: "You are a JSON API. Return ONLY valid JSON. No explanation. No markdown." },
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

// ================= AI TOPIC MAPPING =================
async function mapMcqTopicsWithAI(groq, questions, syllabusText) {
  const mapped = [];
  const batchSize = 6;

  for (let i = 0; i < questions.length; i += batchSize) {
    const batch = questions.slice(i, i + batchSize);
    const prompt = `You are an IGCSE Physics syllabus mapper.
Return ONLY this JSON object:
{
  "questions": [
    { "q": 1, "topic": "IGCSE syllabus chapter", "subtopic": "IGCSE syllabus subtopic" }
  ]
}

SYLLABUS REFERENCE:
${syllabusText}

QUESTIONS TO MAP:
${batch.map((q) => `Q${q.q}: ${q.text}`).join("\n")}

STRICT RULES:
- Return the same q values given. Do not invent new ones.
- Only return topic and subtopic. Return valid JSON only.`;

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
          topic: ai?.topic?.trim() || "Unmapped",
          subtopic: ai?.subtopic?.trim() || "Unmapped",
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
        return res.status(400).json({ success: false, error: "Both question paper and syllabus PDFs are required." });
      }

      const [qpPages, sylPages] = await Promise.all([
        extractPdfPages(req.files.questionPaper[0].buffer),
        extractPdfPages(req.files.syllabus[0].buffer),
      ]);

      const paperType = detectPaperType(qpPages);
      const expectedQuestionCount = detectExpectedQuestionCount(qpPages, paperType);
      const questionPages = getQuestionPages(qpPages);

      console.log(`Paper type: ${paperType}, Expected: ${expectedQuestionCount}, Question pages: ${questionPages.length}`);

      const syllabusText = sylPages
        .slice(0, 3)
        .map((p) => `[Page ${p.pageNum}]\n${p.text}`)
        .join("\n\n")
        .slice(0, 1000);

      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      let allQuestions = [];

      if (paperType === "MCQ" && expectedQuestionCount) {
        const serverExtracted = extractMcqQuestionsFromText(qpPages, expectedQuestionCount);
        console.log("Server extracted MCQs:", serverExtracted.length);
        if (serverExtracted.length > 0) {
          allQuestions = await mapMcqTopicsWithAI(groq, serverExtracted, syllabusText);
        }
      }

      // Fallback to AI chunking for non-MCQ or if MCQ extraction got too few questions
      const threshold = expectedQuestionCount ? expectedQuestionCount * 0.5 : 5;
      if (allQuestions.length < threshold) {
        console.log(`MCQ extraction got ${allQuestions.length}, falling back to AI chunking`);
        allQuestions = [];
        const chunks = buildChunks(questionPages, paperType);
        for (let i = 0; i < chunks.length; i++) {
          const chunkText = chunks[i].map((p) => `[Page ${p.pageNum}]\n${p.text}`).join("\n\n");
          const prompt = `You are an IGCSE Physics question paper parser.
Paper type: ${paperType}
Return ONLY this JSON object:
{
  "questions": [
    { "q": 1, "text": "brief question summary under 100 chars", "topic": "IGCSE syllabus chapter", "subtopic": "IGCSE syllabus subtopic", "answer": "", "marks": 1 }
  ]
}

SYLLABUS REFERENCE:
${syllabusText}

QUESTION PAPER TEXT:
${chunkText}

RULES:
- Extract every visible numbered question.
- For Theory/Practical: use main question number only.
- Match topic and subtopic to syllabus.
- Return valid JSON only.`;

          const result = await callGroq(groq, prompt);
          if (Array.isArray(result)) allQuestions.push(...result);
          if (i < chunks.length - 1) await sleep(2000);
        }
      }

      // Deduplicate, clean, sort
      const seen = new Set();
      const finalQuestions = allQuestions
        .filter((q) => {
          if (!q || q.q === undefined || q.q === null) return false;
          const qNum = parseInt(q.q, 10);
          if (Number.isNaN(qNum) || seen.has(qNum)) return false;
          seen.add(qNum);
          return true;
        })
        .map((q) => ({
          q: parseInt(q.q, 10),
          text: (q.text || "").replace(/\s+/g, " ").trim().slice(0, 120),
          topic: q.topic?.trim() || "Unmapped",
          subtopic: q.subtopic?.trim() || "Unmapped",
          answer: q.answer || "",
          marks: Number(q.marks) || 1,
          pageNum: q.pageNum || null,
        }))
        .sort((a, b) => a.q - b.q);

      if (finalQuestions.length === 0) {
        return res.status(500).json({ success: false, error: "No questions could be extracted. Please check that the PDF is readable." });
      }

      console.log(`Final question count: ${finalQuestions.length}`);

      // Missing question check
      const missingNums = [];
      if (paperType === "MCQ" && expectedQuestionCount) {
        const extractedNums = new Set(finalQuestions.map((q) => q.q));
        for (let n = 1; n <= expectedQuestionCount; n++) {
          if (!extractedNums.has(n)) missingNums.push(n);
        }
        if (missingNums.length > 0) console.log("Missing questions:", missingNums.join(", "));
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
          pct: parseFloat(((data.count / finalQuestions.length) * 100).toFixed(1)),
          subtopics: Object.entries(data.subtopics).map(([name, count]) => ({ name, count })),
        }))
        .sort((a, b) => b.count - a.count);

      const top = chapterSummary[0] || { chapter: "N/A", count: 0, pct: 0 };

      const insights = [
        `Paper type detected: ${paperType}`,
        `Expected questions: ${expectedQuestionCount || "Unknown"}`,
        `Extracted questions: ${finalQuestions.length}`,
        `Missing question numbers: ${missingNums.length ? missingNums.join(", ") : "None"}`,
        `Processed ${qpPages.length} pages, ${questionPages.length} question-bearing pages identified.`,
        `Heaviest chapter: "${top.chapter}" with ${top.count} questions (${top.pct}%).`,
        `${finalQuestions.length} questions mapped across ${chapterSummary.length} topic chapters.`,
      ];

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
      return res.status(500).json({ success: false, error: err.message || "Analysis failed." });
    }
  }
);

// ================= SERVE FRONTEND =================
app.use(express.static(path.join(__dirname, "public")));
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`PhysicsAnalyser running on http://localhost:${PORT}`);
});
