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

// ======================================================
// PDF TEXT EXTRACTION WITH LINE + QUESTION POSITION MAP
// Supports question formats:
// 1 The diagram shows...
// 1. The diagram shows...
// 1) The diagram shows...
// ======================================================

async function extractPdfPages(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
  }).promise;

  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.0 });
    const content = await page.getTextContent();
    const items = content.items || [];

    const pageW = viewport.width;
    const pageH = viewport.height;

    const sortedItems = items
      .map((item) => ({
        text: item.str || "",
        x: item.transform[4],
        y: item.transform[5],
      }))
      .filter((item) => item.text.trim())
      .sort((a, b) => {
        const yDiff = b.y - a.y;

        if (Math.abs(yDiff) > 4) return yDiff;

        return a.x - b.x;
      });

    const lines = [];

    sortedItems.forEach((item) => {
      const lastLine = lines[lines.length - 1];

      if (!lastLine || Math.abs(lastLine.y - item.y) > 4) {
        lines.push({
          y: item.y,
          yFrac: parseFloat(((pageH - item.y) / pageH).toFixed(4)),
          xMin: item.x,
          xMax: item.x,
          items: [item],
          text: item.text.trim(),
        });
      } else {
        lastLine.items.push(item);
        lastLine.items.sort((a, b) => a.x - b.x);
        lastLine.xMin = Math.min(lastLine.xMin, item.x);
        lastLine.xMax = Math.max(lastLine.xMax, item.x);
        lastLine.text = lastLine.items
          .map((it) => it.text.trim())
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      }
    });

    const text = lines.map((line) => line.text).join("\n").trim();

    const qYMap = {};
    const qLineMap = {};

    lines.forEach((line, idx) => {
      const trimmed = line.text.trim();

      /*
        Question numbers are usually on the left side.
        This prevents values like 2.0 N, 4.0 N, 30 cm, 70 cm
        from becoming question numbers.
      */
      if (line.xMin > pageW * 0.24) return;

      /*
        Supports:
        1 The diagram shows...
        1. The diagram shows...
        1) The diagram shows...
      */
      const match = trimmed.match(/^(\d{1,3})(?:\.|\))?\s+(?=[A-Z])/);

      if (!match) return;

      const qn = parseInt(match[1], 10);

      if (qn >= 1 && qn <= 200 && qYMap[qn] === undefined) {
        qYMap[qn] = line.yFrac;
        qLineMap[qn] = idx;
      }
    });

    pages.push({
      pageNum: i,
      text,
      pageWidth: pageW,
      pageHeight: pageH,
      lines,
      qYMap,
      qLineMap,
    });
  }

  return pages;
}

// ======================================================
// PAPER TYPE DETECTION
// ======================================================

function detectPaperType(pages) {
  const text = pages
    .slice(0, 3)
    .map((p) => p.text)
    .join(" ")
    .toLowerCase();

  if (
    text.includes("multiple choice") ||
    text.includes("paper 2") ||
    text.includes("mcqs") ||
    text.includes("for each question there are four possible answers")
  ) {
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

// ======================================================
// QUESTION PAGE DETECTION
// ======================================================

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
    "instructions to candidates",
  ];

  negativePatterns.forEach((p) => {
    if (lower.includes(p)) score -= 3;
  });

  const positivePatterns = [
    /\b\d{1,3}(?:\.|\))?\s+(a|an|the|which|what|why|how|identify|calculate|state|explain|describe)/i,
    /\bA\b[\s\S]*\bB\b[\s\S]*\bC\b[\s\S]*\bD\b/i,
    /calculate|state|explain|describe|which|what/i,
  ];

  positivePatterns.forEach((p) => {
    if (p.test(clean)) score += 3;
  });

  if (clean.length > 250) score += 2;

  return score;
}

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

// ======================================================
// EXPECTED QUESTION COUNT DETECTION
// ======================================================

function detectExpectedQuestionCount(pages, paperType) {
  const fullText = pages.map((p) => p.text).join(" ");

  const wordNums = {
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

  const explicit = fullText.match(
    /there\s+are\s+([a-z]+|\d+)\s+questions/i
  );

  if (explicit) {
    const value = explicit[1].toLowerCase();
    const n = /^\d+$/.test(value) ? parseInt(value, 10) : wordNums[value];

    if (n && n >= 10) return n;
  }

  const maxMarks = fullText.match(/maximum\s+marks\s*[:\-]?\s*(\d+)/i);

  if (paperType === "MCQ" && maxMarks) {
    const n = parseInt(maxMarks[1], 10);

    if (n >= 10) return n;
  }

  const totalMark = fullText.match(
    /total\s+mark\s+for\s+this\s+paper\s+is\s+(\d+)/i
  );

  if (paperType === "MCQ" && totalMark) {
    const n = parseInt(totalMark[1], 10);

    if (n >= 10) return n;
  }

  return null;
}

// ======================================================
// TEXT CLEANING
// ======================================================

function cleanExtractedQuestionText(raw, qNum) {
  let text = String(raw || "");

  /*
    Remove starting question number:
    1 The...
    1. The...
    1) The...
  */
  text = text.replace(
    new RegExp("^\\s*" + qNum + "(?:\\.|\\))?\\s*"),
    ""
  );

  text = text
    .replace(/Page\s+\d+\s+of\s+\d+/gi, " ")
    .replace(/© Cambridge University Press & Assessment \d{4}/gi, " ")
    .replace(/\[Turn over\]/gi, " ")
    .replace(/\b0625\/22\/F\/M\/26\b/gi, " ")
    .replace(/\b0625\/\d+\/[A-Z]\/[A-Z]\/\d+\b/gi, " ")
    .replace(/\bIB26\s+03_0625_22\/3RP\b/gi, " ")
    .replace(/\*?\d{10}\*?/g, " ")
    .replace(/Cambridge IGCSE™/gi, " ")
    .replace(/PHYSICS 0625\/22/gi, " ")
    .replace(/Paper 2 Multiple Choice.*?45 minutes/gi, " ")
    .replace(/First Term Summative Examination/gi, " ")
    .replace(/Name of Student:.*/gi, " ")
    .replace(/Grade:\s*\d+.*/gi, " ")
    .replace(/Subject:.*/gi, " ")
    .replace(/Duration:.*/gi, " ")
    .replace(/Maximum Marks:.*/gi, " ")
    .replace(/Day:\s*.*Date:\s*.*/gi, " ")
    .replace(/Teacher Name:.*/gi, " ")
    .replace(/Instructions to Candidates:.*/gi, " ")
    .replace(/INSTRUCTIONS[\s\S]*?INFORMATION/gi, " ")
    .replace(/The total mark for this paper is 40\./gi, " ")
    .replace(/Each correct answer will score one mark\./gi, " ")
    .replace(/Any rough working should be done on this question paper\./gi, " ")
    .replace(/Permission to reproduce[\s\S]*/gi, " ")
    .replace(/Cambridge International Education[\s\S]*/gi, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  return text;
}

function normalizeMcqText(text) {
  let t = String(text || "");

  t = t
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  /*
    Improve display of MCQ options when PDF extraction places them on one line.
    This will not be perfect for every Cambridge paper, but it helps readability.
  */
  t = t.replace(/\s+(A)\s+(?=[A-Z0-9])/g, "\nA ");
  t = t.replace(/\s+(B)\s+(?=[A-Z0-9])/g, "\nB ");
  t = t.replace(/\s+(C)\s+(?=[A-Z0-9])/g, "\nC ");
  t = t.replace(/\s+(D)\s+(?=[A-Z0-9])/g, "\nD ");

  return t.trim();
}

// ======================================================
// VISUAL DETECTION
// ======================================================

function questionHasVisual(q) {
  const text = (q.fullText || q.text || "").toLowerCase();

  const visualKeywords = [
    "diagram",
    "graph",
    "shown",
    "below",
    "alongside",
    "figure",
    "tile",
    "beam",
    "pivot",
    "spring",
    "tank",
    "cube",
    "balance",
    "balloon",
    "measuring cylinder",
    "stone",
    "kettle",
    "wave",
    "oscilloscope",
    "circuit",
    "voltmeter",
    "resistor",
    "battery",
    "conductor",
    "magnetic poles",
    "gold foil",
    "field",
    "door handle",
    "metre rule",
    "wardrobe",
    "velocity-time",
    "speed-time",
    "velocity vs time",
    "position-time",
    "position as a function of time",
    "the table shows",
    "the diagram shows",
    "the graph shows",
    "the diagrams show",
  ];

  return visualKeywords.some((word) => text.includes(word));
}

// ======================================================
// FULL MCQ EXTRACTION FROM PDF LINES
// ======================================================

function extractMcqQuestionsFromText(pages, expectedCount) {
  const questions = [];
  const allStarts = [];

  pages.forEach((page) => {
    Object.keys(page.qLineMap || {}).forEach((qNumStr) => {
      const qNum = parseInt(qNumStr, 10);

      if (!Number.isNaN(qNum)) {
        allStarts.push({
          q: qNum,
          pageNum: page.pageNum,
          lineIndex: page.qLineMap[qNum],
          yFrac: page.qYMap[qNum],
        });
      }
    });
  });

  allStarts.sort((a, b) => {
    if (a.pageNum !== b.pageNum) return a.pageNum - b.pageNum;

    return a.lineIndex - b.lineIndex;
  });

  if (allStarts.length === 0) return questions;

  const maxDetected = Math.max(...allStarts.map((s) => s.q));
  const maxQ = expectedCount || maxDetected;

  for (let i = 0; i < allStarts.length; i++) {
    const start = allStarts[i];

    if (start.q < 1 || start.q > maxQ) continue;

    const page = pages.find((p) => p.pageNum === start.pageNum);

    if (!page || !page.lines) continue;

    const next = allStarts[i + 1];

    let endLineIndex = page.lines.length;

    if (next && next.pageNum === start.pageNum) {
      endLineIndex = next.lineIndex;
    }

    const rawLines = page.lines
      .slice(start.lineIndex, endLineIndex)
      .map((line) => line.text)
      .filter(Boolean);

    let fullText = rawLines.join("\n");
    fullText = cleanExtractedQuestionText(fullText, start.q);
    fullText = normalizeMcqText(fullText);

    if (!fullText) continue;

    const question = {
      q: start.q,
      text: fullText,
      fullText,
      topic: "Unmapped",
      subtopic: "Unmapped",
      answer: "",
      marks: 1,
      pageNum: start.pageNum,
      yFrac: start.yFrac,
    };

    question.hasVisual = questionHasVisual(question);

    questions.push(question);
  }

  return questions;
}

// ======================================================
// PAGE ASSIGNMENT FALLBACK
// ======================================================

function assignPageNumsToQuestions(finalQuestions, qpPages) {
  return finalQuestions.map((q) => {
    if (q.pageNum) return q;

    const qNum = parseInt(q.q, 10);

    const matchedPage = qpPages.find((p) => {
      if (p.qYMap && p.qYMap[qNum] !== undefined) return true;

      const regex = new RegExp(
        "(^|\\n|\\s)" + qNum + "(?:\\.|\\))?\\s+[A-Za-z]"
      );

      return regex.test(p.text);
    });

    return {
      ...q,
      pageNum: matchedPage ? matchedPage.pageNum : null,
      yFrac:
        matchedPage && matchedPage.qYMap && matchedPage.qYMap[qNum] !== undefined
          ? matchedPage.qYMap[qNum]
          : q.yFrac,
    };
  });
}

// ======================================================
// CHUNKING FOR AI FALLBACK
// ======================================================

function buildChunks(questionPages, paperType) {
  const maxChars = paperType === "MCQ" ? 1800 : 1400;
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

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

// ======================================================
// MULTER
// ======================================================

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ======================================================
// GROQ CALL
// ======================================================

async function callGroq(groq, prompt, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content:
              "You are a JSON API. Return ONLY valid JSON. No explanation. No markdown.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],

        model: "llama-3.1-8b-instant",
        temperature: 0,
        max_tokens: 1600,
        response_format: {
          type: "json_object",
        },
      });

      const raw = completion.choices[0]?.message?.content?.trim() || "";
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed.questions)) return parsed.questions;
      if (Array.isArray(parsed.mappings)) return parsed.mappings;
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

// ======================================================
// AI TOPIC MAPPING
// IMPORTANT: THIS MUST NOT OVERWRITE QUESTION TEXT.
// ======================================================

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
${batch.map((q) => `Q${q.q}: ${q.fullText || q.text}`).join("\n\n")}

STRICT RULES:
- Return the same q values given.
- Do not invent new questions.
- Only return q, topic and subtopic.
- Do not return summaries.
- Return valid JSON only.`;

    try {
      const result = await callGroq(groq, prompt);

      const resultMap = new Map();

      result.forEach((r) => {
        const qNum = parseInt(r.q, 10);

        if (!Number.isNaN(qNum)) {
          resultMap.set(qNum, r);
        }
      });

      batch.forEach((q) => {
        const ai = resultMap.get(q.q);

        mapped.push({
          ...q,
          text: q.text,
          fullText: q.fullText || q.text,
          topic: ai?.topic?.trim() || "Unmapped",
          subtopic: ai?.subtopic?.trim() || "Unmapped",
          hasVisual: q.hasVisual,
          pageNum: q.pageNum,
          yFrac: q.yFrac,
        });
      });
    } catch (err) {
      console.error("Topic mapping batch failed:", err.message);

      /*
        Keep extracted questions even if topic mapping fails.
        This prevents the entire analysis from failing.
      */
      batch.forEach((q) => mapped.push(q));
    }

    if (i + batchSize < questions.length) {
      await sleep(1200);
    }
  }

  return mapped;
}

// ======================================================
// API ROUTE
// ======================================================

app.post(
  "/api/analyse",
  upload.fields([
    {
      name: "questionPaper",
      maxCount: 1,
    },
    {
      name: "syllabus",
      maxCount: 1,
    },
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
      const expectedQuestionCount = detectExpectedQuestionCount(
        qpPages,
        paperType
      );

      const questionPages = getQuestionPages(qpPages);

      console.log(
        `Paper type: ${paperType}, Expected: ${expectedQuestionCount}, Question pages: ${questionPages.length}`
      );

      const syllabusText = sylPages
        .slice(0, 8)
        .map((p) => `[Page ${p.pageNum}]\n${p.text}`)
        .join("\n\n")
        .slice(0, 4000);

      const groq = new Groq({
        apiKey: process.env.GROQ_API_KEY,
      });

      let allQuestions = [];

      /*
        MAIN FIX:
        For MCQ, extract full question text and options using PDF lines first.
        Do NOT ask AI to summarize the questions.
      */
      if (paperType === "MCQ") {
        const serverExtracted = extractMcqQuestionsFromText(
          qpPages,
          expectedQuestionCount
        );

        console.log("Server extracted MCQs:", serverExtracted.length);

        if (serverExtracted.length > 0) {
          allQuestions = await mapMcqTopicsWithAI(
            groq,
            serverExtracted,
            syllabusText
          );
        }
      }

      /*
        Fallback only when server extraction is completely poor.
        For MCQ papers, if we extracted at least some questions,
        keep server extraction instead of using Groq fallback.
        This prevents JSON errors on Cambridge symbols like α, β, arrows, fractions.
      */
      const threshold = expectedQuestionCount
        ? expectedQuestionCount * 0.8
        : 5;

      if (allQuestions.length < threshold) {
        console.log(
          `Extraction got ${allQuestions.length}, below threshold ${threshold}.`
        );

        if (paperType === "MCQ" && allQuestions.length > 0) {
          console.log("Skipping AI fallback for MCQ paper; keeping server extraction.");
        } else {
          console.log("Using AI fallback.");

          allQuestions = [];

          const chunks = buildChunks(questionPages, paperType);

          for (let i = 0; i < chunks.length; i++) {
            const chunkText = chunks[i]
              .map((p) => `[Page ${p.pageNum}]\n${p.text}`)
              .join("\n\n");

            const prompt = `You are an IGCSE Physics question paper parser.

Paper type: ${paperType}

Return ONLY this JSON object:

{
  "questions": [
    {
      "q": 1,
      "text": "full question text including all options A, B, C and D",
      "topic": "IGCSE syllabus chapter",
      "subtopic": "IGCSE syllabus subtopic",
      "answer": "",
      "marks": 1,
      "pageNum": 2
    }
  ]
}

SYLLABUS REFERENCE:
${syllabusText}

QUESTION PAPER TEXT:
${chunkText}

RULES:
- Extract every visible numbered question.
- For MCQ questions, include the complete stem and all four options A, B, C and D.
- Do NOT summarize.
- Do NOT shorten.
- Do NOT return only the final question sentence.
- Match topic and subtopic to the syllabus.
- Include pageNum.
- Return valid JSON only.`;

            const result = await callGroq(groq, prompt);

            if (Array.isArray(result)) {
              allQuestions.push(...result);
            }

            if (i < chunks.length - 1) {
              await sleep(1800);
            }
          }
        }
      }

      const seen = new Set();

      const finalQuestions = allQuestions
        .filter((q) => {
          if (!q || q.q === undefined || q.q === null) return false;

          const qNum = parseInt(q.q, 10);

          if (Number.isNaN(qNum) || seen.has(qNum)) return false;

          seen.add(qNum);

          return true;
        })
        .map((q) => {
          const full = normalizeMcqText(
            q.fullText || q.text || q.question || q.questionText || ""
          );

          const cleaned = {
            q: parseInt(q.q, 10),
            text: full,
            fullText: full,
            topic: q.topic?.trim() || "Unmapped",
            subtopic: q.subtopic?.trim() || "Unmapped",
            answer: q.answer || "",
            marks: Number(q.marks) || 1,
            pageNum: q.pageNum ? Number(q.pageNum) : null,
            yFrac: q.yFrac !== undefined ? q.yFrac : null,
          };

          return {
            ...cleaned,
            hasVisual:
              q.hasVisual !== undefined
                ? Boolean(q.hasVisual)
                : questionHasVisual(cleaned),
          };
        })
        .sort((a, b) => a.q - b.q);

      if (finalQuestions.length === 0) {
        return res.status(500).json({
          success: false,
          error:
            "No questions could be extracted. Please check that the PDF is readable.",
        });
      }

      const finalQuestionsWithPages = assignPageNumsToQuestions(
        finalQuestions,
        qpPages
      ).map((q) => ({
        ...q,
        hasVisual:
          q.hasVisual !== undefined ? Boolean(q.hasVisual) : questionHasVisual(q),
      }));

      const missingNums = [];

      if (paperType === "MCQ" && expectedQuestionCount) {
        const extractedNums = new Set(finalQuestionsWithPages.map((q) => q.q));

        for (let n = 1; n <= expectedQuestionCount; n++) {
          if (!extractedNums.has(n)) {
            missingNums.push(n);
          }
        }

        if (missingNums.length > 0) {
          console.log("Missing questions:", missingNums.join(", "));
        }
      }

      const chapterMap = {};

      finalQuestionsWithPages.forEach((q) => {
        const topic = q.topic || "Unmapped";
        const subtopic = q.subtopic || "Unmapped";

        if (!chapterMap[topic]) {
          chapterMap[topic] = {
            count: 0,
            marks: 0,
            subtopics: {},
          };
        }

        chapterMap[topic].count += 1;
        chapterMap[topic].marks += Number(q.marks) || 1;
        chapterMap[topic].subtopics[subtopic] =
          (chapterMap[topic].subtopics[subtopic] || 0) + 1;
      });

      const chapterSummary = Object.entries(chapterMap)
        .map(([chapter, data]) => ({
          chapter,
          count: data.count,
          marks: data.marks,
          pct: parseFloat(
            ((data.count / finalQuestionsWithPages.length) * 100).toFixed(1)
          ),
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
        `Expected questions: ${expectedQuestionCount || "Unknown"}`,
        `Extracted questions: ${finalQuestionsWithPages.length}`,
        `Missing question numbers: ${
          missingNums.length ? missingNums.join(", ") : "None"
        }`,
        `Processed ${qpPages.length} pages, ${questionPages.length} question-bearing pages identified.`,
        `Heaviest chapter: "${top.chapter}" with ${top.count} questions (${top.pct}%).`,
        `${finalQuestionsWithPages.length} questions mapped across ${chapterSummary.length} topic chapters.`,
      ];

      const questionPaperBase64 =
        req.files.questionPaper[0].buffer.toString("base64");

      return res.json({
        success: true,
        data: {
          totalQuestions: finalQuestionsWithPages.length,
          totalMarks: finalQuestionsWithPages.reduce(
            (sum, q) => sum + (Number(q.marks) || 1),
            0
          ),
          questions: finalQuestionsWithPages,
          chapterSummary,
          insights,
          questionPaperBase64,
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

// ======================================================
// SERVE FRONTEND
// ======================================================

app.use(express.static(path.join(__dirname, "public")));

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`PhysicsAnalyser running on http://localhost:${PORT}`);
});
