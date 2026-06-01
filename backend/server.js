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
// BASIC CLEANING HELPERS
// ======================================================

function cleanPdfLine(raw) {
  let line = String(raw || "")
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();

  if (!line) return "";

  line = line
    .replace(/© Cambridge University Press & Assessment \d{4}/gi, "")
    .replace(/\[Turn over\]/gi, "")
    .replace(/\bDFD\b/g, "")
    .replace(/\b0625\/\d+\/[A-Z]\/[A-Z]\/\d+\b/gi, "")
    .replace(/\b0625\/\d+\/F\/M\/\d+\b/gi, "")
    .replace(/\bDC\s*\([^)]+\)\s*\d+\/\d+\b/gi, "")
    .replace(/\bIB\d+\s+\d+_\d+_\d+\/\w+\b/gi, "")
    .replace(/\*+\s*\d{10,16}\s*\*+/g, "")
    .replace(/^\*+\s*\d+\s*\*+$/g, "")
    .replace(/,+/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();

  return line;
}

function isGarbageLine(raw) {
  const line = String(raw || "").trim();
  const lower = line.toLowerCase();

  if (!line) return true;

  if (/^page\s+\d+\s+of\s+\d+$/i.test(line)) return true;
  if (/^this document has \d+ pages/i.test(line)) return true;
  if (/^any blank pages are indicated/i.test(line)) return true;
  if (/^blank page$/i.test(line)) return true;
  if (/^\[turn over\]$/i.test(line)) return true;
  if (/^turn over$/i.test(line)) return true;
  if (/^dfd$/i.test(line)) return true;
  if (/^cambridge international/i.test(line)) return true;
  if (/^cambridge igcse/i.test(line)) return true;
  if (/^physics 0625/i.test(line)) return true;
  if (/^paper \d/i.test(line)) return true;
  if (/^instructions$/i.test(line)) return true;
  if (/^information$/i.test(line)) return true;

  if (lower.includes("do not write in this margin")) return true;
  if (lower.includes("permission to reproduce")) return true;
  if (lower.includes("copyright acknowledgements")) return true;
  if (lower.includes("cambridge university press")) return true;
  if (lower.includes("candidate name")) return true;
  if (lower.includes("candidate number")) return true;
  if (lower.includes("centre number")) return true;

  if (/^\*?\s*\d{10,16}\s*\*?$/.test(line)) return true;
  if (/^\d+$/.test(line) && Number(line) > 20) return true;

  /*
    Remove mojibake/barcode encoding lines.
    Keep normal physics symbols, Greek letters, Ω, ×, °, etc.
  */
  const allowed = line.match(/[A-Za-z0-9\s.,;:!?()[\]{}+\-*/=<>_%°ΩµμρλΔαβγ×–—'"/]/g) || [];
  const ratio = allowed.length / line.length;

  if (line.length > 10 && ratio < 0.55) return true;

  /*
    Lines made mostly of strange symbols are barcode data.
  */
  const lettersDigits = line.match(/[A-Za-z0-9]/g) || [];
  if (line.length > 12 && lettersDigits.length < 3) return true;

  return false;
}

function finalCleanQuestionText(raw, qNum) {
  let text = String(raw || "");

  text = text.replace(
    new RegExp("^\\s*" + qNum + "(?:\\.|\\))?\\s*"),
    ""
  );

  const lines = text
    .split(/\n+/)
    .map((line) => cleanPdfLine(line))
    .filter((line) => !isGarbageLine(line));

  text = lines.join("\n");

  text = text
    .replace(/Page\s+\d+\s+of\s+\d+/gi, " ")
    .replace(/© Cambridge University Press & Assessment \d{4}/gi, " ")
    .replace(/\[Turn over\]/gi, " ")
    .replace(/\bDFD\b/g, " ")
    .replace(/\b0625\/\d+\/[A-Z]\/[A-Z]\/\d+\b/gi, " ")
    .replace(/\b0625\/\d+\/F\/M\/\d+\b/gi, " ")
    .replace(/\*?\s*\d{10,16}\s*\*?/g, " ")
    .replace(/DO NOT WRITE IN THIS MARGIN/gi, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

function normalizeDisplayText(text) {
  let t = String(text || "");

  t = t
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return t;
}

// ======================================================
// PDF TEXT EXTRACTION
// ======================================================

async function extractPdfPages(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
  }).promise;

  const pages = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.0 });
    const content = await page.getTextContent();
    const items = content.items || [];

    const pageW = viewport.width;
    const pageH = viewport.height;

    const positionedItems = items
      .map((item) => ({
        text: cleanPdfLine(item.str || ""),
        x: item.transform[4],
        y: item.transform[5],
      }))
      .filter((item) => item.text)
      .sort((a, b) => {
        const yDiff = b.y - a.y;
        if (Math.abs(yDiff) > 4) return yDiff;
        return a.x - b.x;
      });

    const lines = [];

    positionedItems.forEach((item) => {
      const last = lines[lines.length - 1];

      if (!last || Math.abs(last.y - item.y) > 4) {
        lines.push({
          y: item.y,
          yFrac: parseFloat(((pageH - item.y) / pageH).toFixed(4)),
          xMin: item.x,
          xMax: item.x,
          items: [item],
          text: item.text,
        });
      } else {
        last.items.push(item);
        last.items.sort((a, b) => a.x - b.x);
        last.xMin = Math.min(last.xMin, item.x);
        last.xMax = Math.max(last.xMax, item.x);
        last.text = last.items
          .map((it) => it.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      }
    });

    const cleanLines = lines
      .map((line) => ({
        ...line,
        text: cleanPdfLine(line.text),
      }))
      .filter((line) => line.text && !isGarbageLine(line.text));

    const text = cleanLines.map((line) => line.text).join("\n").trim();

    const qYMap = {};
    const qLineMap = {};

    cleanLines.forEach((line, idx) => {
      const trimmed = line.text.trim();

      /*
        Main question numbers are usually on the left.
        Supports:
        1 A student...
        1. A student...
        1) A student...
      */
      if (line.xMin > pageW * 0.28) return;

      const match = trimmed.match(/^(\d{1,3})(?:\.|\))?\s+(?=[A-Z(])/);

      if (!match) return;

      const qNum = parseInt(match[1], 10);

      if (qNum >= 1 && qNum <= 200 && qYMap[qNum] === undefined) {
        qYMap[qNum] = line.yFrac;
        qLineMap[qNum] = idx;
      }
    });

    pages.push({
      pageNum,
      text,
      pageWidth: pageW,
      pageHeight: pageH,
      lines: cleanLines,
      qYMap,
      qLineMap,
    });
  }

  return pages;
}

// ======================================================
// PAPER TYPE
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
    text.includes("four possible answers")
  ) {
    return "MCQ";
  }

  if (text.includes("alternative to practical") || text.includes("paper 6")) {
    return "PRACTICAL";
  }

  if (text.includes("theory") || text.includes("paper 4")) {
    return "THEORY";
  }

  return "UNKNOWN";
}

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
    const n = /^\d+$/.test(value)
      ? parseInt(value, 10)
      : wordNums[value];

    if (n && n >= 1) return n;
  }

  const totalMark = fullText.match(
    /total\s+mark\s+for\s+this\s+paper\s+is\s+(\d+)/i
  );

  if (paperType === "MCQ" && totalMark) {
    const n = parseInt(totalMark[1], 10);
    if (n >= 10) return n;
  }

  const maxMarks = fullText.match(/maximum\s+marks\s*[:\-]?\s*(\d+)/i);

  if (paperType === "MCQ" && maxMarks) {
    const n = parseInt(maxMarks[1], 10);
    if (n >= 10) return n;
  }

  return null;
}

// ======================================================
// QUESTION EXTRACTION
// ======================================================

function findQuestionStarts(pages) {
  const rawStarts = [];

  pages.forEach((page) => {
    Object.keys(page.qLineMap || {}).forEach((qNumStr) => {
      const qNum = parseInt(qNumStr, 10);

      if (!Number.isNaN(qNum)) {
        rawStarts.push({
          q: qNum,
          pageNum: page.pageNum,
          lineIndex: page.qLineMap[qNum],
          yFrac: page.qYMap[qNum],
        });
      }
    });
  });

  rawStarts.sort((a, b) => {
    if (a.pageNum !== b.pageNum) return a.pageNum - b.pageNum;
    return a.lineIndex - b.lineIndex;
  });

  /*
    Keep only increasing main question numbers.
    This prevents option text or random page numbers from becoming fake questions.
  */
  const starts = [];
  let lastQ = 0;

  rawStarts.forEach((start) => {
    if (start.q > lastQ) {
      starts.push(start);
      lastQ = start.q;
    }
  });

  return starts;
}

function extractQuestionsFromPdfLines(pages, paperType, expectedCount) {
  const starts = findQuestionStarts(pages);
  const questions = [];

  if (starts.length === 0) return questions;

  const maxDetected = Math.max(...starts.map((s) => s.q));
  const maxQ =
    paperType === "MCQ" && expectedCount
      ? expectedCount
      : maxDetected;

  for (let i = 0; i < starts.length; i++) {
    const current = starts[i];

    if (current.q < 1 || current.q > maxQ) continue;

    const next = starts[i + 1];

    const questionLines = [];

    for (const page of pages) {
      if (page.pageNum < current.pageNum) continue;
      if (next && page.pageNum > next.pageNum) continue;

      let startIndex = 0;
      let endIndex = page.lines.length;

      if (page.pageNum === current.pageNum) {
        startIndex = current.lineIndex;
      }

      if (next && page.pageNum === next.pageNum) {
        endIndex = next.lineIndex;
      }

      const lines = page.lines
        .slice(startIndex, endIndex)
        .map((line) => line.text)
        .filter((line) => line && !isGarbageLine(line));

      questionLines.push(...lines);
    }

    let fullText = questionLines.join("\n");
    fullText = finalCleanQuestionText(fullText, current.q);
    fullText = normalizeDisplayText(fullText);

    if (!fullText) continue;

    const marks = extractMarks(fullText);

    questions.push({
      q: current.q,
      text: fullText,
      fullText,
      topic: "Unmapped",
      subtopic: "Unmapped",
      answer: "",
      marks,
      pageNum: current.pageNum,
      yFrac: current.yFrac,
      hasVisual: questionHasVisual(fullText),
    });
  }

  return questions;
}

function extractMarks(text) {
  const matches = [...String(text).matchAll(/\[(\d+)\]/g)];
  const nums = matches
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));

  if (nums.length === 0) return 1;

  /*
    If the text contains [Total: 7], use that.
  */
  const totalMatch = String(text).match(/\[Total:\s*(\d+)\]/i);
  if (totalMatch) return Number(totalMatch[1]);

  return nums.reduce((a, b) => a + b, 0);
}

function questionHasVisual(text) {
  const lower = String(text || "").toLowerCase();

  const words = [
    "figure",
    "diagram",
    "graph",
    "table",
    "draw",
    "plot",
    "circuit",
    "measuring cylinder",
    "balance",
    "spring",
    "metre ruler",
    "voltmeter",
    "ammeter",
    "lens",
    "electric field",
    "wave",
    "oscilloscope",
  ];

  return words.some((w) => lower.includes(w));
}

// ======================================================
// QUESTION PAGE ASSIGNMENT FALLBACK
// ======================================================

function assignPageNumsToQuestions(finalQuestions, qpPages) {
  return finalQuestions.map((q) => {
    if (q.pageNum) return q;

    const qNum = parseInt(q.q, 10);

    const matchedPage = qpPages.find((p) => {
      if (p.qYMap && p.qYMap[qNum] !== undefined) return true;

      const regex = new RegExp(
        "(^|\\n|\\s)" + qNum + "(?:\\.|\\))?\\s+[A-Za-z(]"
      );

      return regex.test(p.text);
    });

    return {
      ...q,
      pageNum: matchedPage ? matchedPage.pageNum : null,
      yFrac:
        matchedPage &&
        matchedPage.qYMap &&
        matchedPage.qYMap[qNum] !== undefined
          ? matchedPage.qYMap[qNum]
          : q.yFrac,
    };
  });
}

// ======================================================
// GROQ TOPIC MAPPING ONLY
// ======================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGroq(groq, prompt, retries = 2) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content:
              "Return only valid JSON. No markdown. No explanation.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        model: "llama-3.1-8b-instant",
        temperature: 0,
        max_tokens: 1000,
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
        await sleep(1200);
        continue;
      }

      throw err;
    }
  }

  return [];
}

async function mapTopicsWithAI(groq, questions, syllabusText) {
  if (!process.env.GROQ_API_KEY) {
    return questions;
  }

  const mapped = [];
  const batchSize = 8;

  for (let i = 0; i < questions.length; i += batchSize) {
    const batch = questions.slice(i, i + batchSize);

    const questionSnippets = batch
      .map((q) => {
        const snippet = String(q.fullText || q.text || "")
          .replace(/\s+/g, " ")
          .slice(0, 280);

        return `Q${q.q}: ${snippet}`;
      })
      .join("\n");

    const prompt = `Map these IGCSE Physics questions to syllabus topics.

Return ONLY valid JSON in this format:
{
  "questions": [
    { "q": 1, "topic": "topic name", "subtopic": "subtopic name" }
  ]
}

Syllabus reference:
${syllabusText.slice(0, 3500)}

Questions:
${questionSnippets}

Rules:
- Return the same q values only.
- Do not rewrite question text.
- Do not include answers.
- Return valid JSON only.`;

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
          topic: ai?.topic?.trim() || q.topic || "Unmapped",
          subtopic: ai?.subtopic?.trim() || q.subtopic || "Unmapped",
        });
      });
    } catch (err) {
      console.error("Topic mapping failed:", err.message);
      batch.forEach((q) => mapped.push(q));
    }

    if (i + batchSize < questions.length) {
      await sleep(800);
    }
  }

  return mapped;
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

      console.log(
        `Paper type: ${paperType}, Expected: ${
          expectedQuestionCount || "Unknown"
        }`
      );

      const syllabusText = sylPages
        .map((p) => p.text)
        .join("\n\n")
        .replace(/\s+/g, " ")
        .slice(0, 5000);

      let allQuestions = extractQuestionsFromPdfLines(
        qpPages,
        paperType,
        expectedQuestionCount
      );

      console.log("Server extracted questions:", allQuestions.length);

      if (allQuestions.length === 0) {
        return res.status(500).json({
          success: false,
          error:
            "No questions could be extracted. Please check that the PDF text is readable.",
        });
      }

      /*
        AI is used only for topic mapping.
        It is NOT used to extract questions.
        This avoids garbage JSON errors.
      */
      const groq = new Groq({
        apiKey: process.env.GROQ_API_KEY,
      });

      allQuestions = await mapTopicsWithAI(
        groq,
        allQuestions,
        syllabusText
      );

      const seen = new Set();

      const finalQuestions = allQuestions
        .filter((q) => {
          const qNum = parseInt(q.q, 10);

          if (Number.isNaN(qNum)) return false;
          if (seen.has(qNum)) return false;

          seen.add(qNum);
          return true;
        })
        .map((q) => {
          const full = normalizeDisplayText(q.fullText || q.text || "");

          return {
            q: parseInt(q.q, 10),
            text: full,
            fullText: full,
            topic: q.topic?.trim() || "Unmapped",
            subtopic: q.subtopic?.trim() || "Unmapped",
            answer: q.answer || "",
            marks: Number(q.marks) || 1,
            pageNum: q.pageNum ? Number(q.pageNum) : null,
            yFrac: q.yFrac !== undefined ? q.yFrac : null,
            hasVisual:
              q.hasVisual !== undefined
                ? Boolean(q.hasVisual)
                : questionHasVisual(full),
          };
        })
        .sort((a, b) => a.q - b.q);

      const finalQuestionsWithPages = assignPageNumsToQuestions(
        finalQuestions,
        qpPages
      );

      const missingNums = [];

      if (paperType === "MCQ" && expectedQuestionCount) {
        const extractedNums = new Set(
          finalQuestionsWithPages.map((q) => q.q)
        );

        for (let n = 1; n <= expectedQuestionCount; n++) {
          if (!extractedNums.has(n)) missingNums.push(n);
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
          subtopics: Object.entries(data.subtopics).map(
            ([name, count]) => ({
              name,
              count,
            })
          ),
        }))
        .sort((a, b) => b.count - a.count);

      const top = chapterSummary[0] || {
        chapter: "N/A",
        count: 0,
        pct: 0,
      };

      const pagesText = qpPages.map((p) => ({
        pageNum: p.pageNum,
        text: p.text,
      }));

      const insights = [
        `Paper type detected: ${paperType}`,
        `Expected questions: ${expectedQuestionCount || "Unknown"}`,
        `Extracted questions: ${finalQuestionsWithPages.length}`,
        `Missing question numbers: ${
          missingNums.length ? missingNums.join(", ") : "None"
        }`,
        `Processed ${qpPages.length} pages.`,
        `Heaviest chapter: "${top.chapter}" with ${top.count} questions (${top.pct}%).`,
        `${finalQuestionsWithPages.length} questions mapped across ${chapterSummary.length} topic chapters.`,
      ];

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
          pagesText,
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
