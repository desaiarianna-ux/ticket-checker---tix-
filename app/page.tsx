"use client";

import { useMemo, useState } from "react";

type Severity = "low" | "med" | "high";
type Validity = "Likely Valid" | "Possibly Invalid" | "Likely Invalid";
type Action =
  | "Pay now"
  | "Fight it"
  | "Request reduction"
  | "Request hearing"
  | "Respond to summons ASAP";

type Issue = {
  severity: Severity;
  category: string;
  message: string;
};

type LookupResult = {
  found: boolean;
  data?: Record<string, unknown>;
  error?: string;
};

type TicketInput = {
  jurisdiction: "NYC" | "Other";
  summonsNumber: string;
  plate: string;
  state: string;
  date: string;
  time: string;
  location: string;
  violationCode: string;
  issuer: string;
  amount: string;
  isCourtSummons: boolean;
  notes: string;
  rawText: string;
};

type Analysis = {
  issues: Issue[];
  validity: Validity;
  payScore: number;
  fightScore: number;
  recommendedAction: Action;
  guidance: string[];
  nyc: {
    codeLookup?: LookupResult;
    summonsLookup?: LookupResult;
    openDataStatus: "ok" | "degraded";
  };
  explanation: string;
};

type Mode = "text" | "fields";

const violationCache = new Map<string, LookupResult>();
const summonsCache = new Map<string, LookupResult>();

const SUMMONS_KEYWORDS = [
  "summons",
  "appearance required",
  "court date",
  "criminal court",
  "hearing date",
  "must appear"
];

const FIELD_EXAMPLE_VALID: Omit<TicketInput, "rawText"> = {
  jurisdiction: "NYC",
  summonsNumber: "",
  plate: "ABC1234",
  state: "NY",
  date: "2025-01-15",
  time: "09:30",
  location: "W 34 St Parking Zone A",
  violationCode: "46",
  issuer: "Precinct 14",
  amount: "65",
  isCourtSummons: false,
  notes: "Parked near loading zone sign"
};

const FIELD_EXAMPLE_ISSUES: Omit<TicketInput, "rawText"> = {
  jurisdiction: "NYC",
  summonsNumber: "1234567890",
  plate: "A-",
  state: "",
  date: "",
  time: "",
  location: "Unknown",
  violationCode: "P999",
  issuer: "",
  amount: "0",
  isCourtSummons: true,
  notes: "Appearance required in criminal court. Meter issue"
};

function normalizeKey(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sanitizeValue(value: string): string {
  return value.trim();
}

function withTimeoutSignal(timeoutMs = 8000): AbortController {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller;
}

function buildFallbackFieldQuery(candidates: string[], value: string): string {
  const safe = value.replace(/'/g, "''");
  return candidates.map((field) => `${field}='${safe}'`).join(" OR ");
}

async function fetchJson(url: string): Promise<Record<string, unknown>[]> {
  const controller = withTimeoutSignal(8000);
  const response = await fetch(url, {
    signal: controller.signal,
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`NYC Open Data error (${response.status})`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload.filter((item) => typeof item === "object" && item !== null) as Record<
    string,
    unknown
  >[];
}

async function fetchViolationCodeInfo(code: string): Promise<LookupResult> {
  const clean = sanitizeValue(code);
  if (!clean) {
    return { found: false };
  }

  const cached = violationCache.get(clean.toUpperCase());
  if (cached) {
    return cached;
  }

  const base = "https://data.cityofnewyork.us/resource/ncbg-6agr.json";
  const encoded = encodeURIComponent(clean);
  const likelyFields = ["violation_code", "code", "violationcode", "manhattan_96th_st_below"]; 

  try {
    const where = buildFallbackFieldQuery(likelyFields, clean);
    const urls = [
      `${base}?$limit=1&$where=${encodeURIComponent(where)}`,
      `${base}?$limit=5&$q=${encoded}`
    ];

    for (const url of urls) {
      const rows = await fetchJson(url);
      if (!rows.length) {
        continue;
      }

      let match = rows[0];
      for (const row of rows) {
        const matchingKey = Object.keys(row).find((k) => normalizeKey(k).includes("violationcode"));
        if (matchingKey && String(row[matchingKey] ?? "").trim() === clean) {
          match = row;
          break;
        }
      }

      const result: LookupResult = { found: true, data: match };
      violationCache.set(clean.toUpperCase(), result);
      return result;
    }

    const miss = { found: false };
    violationCache.set(clean.toUpperCase(), miss);
    return miss;
  } catch (error) {
    const failure = {
      found: false,
      error: error instanceof Error ? error.message : "Lookup failed"
    };
    violationCache.set(clean.toUpperCase(), failure);
    return failure;
  }
}

async function fetchSummonsInfo(summons: string): Promise<LookupResult> {
  const clean = sanitizeValue(summons);
  if (!clean) {
    return { found: false };
  }

  const cached = summonsCache.get(clean);
  if (cached) {
    return cached;
  }

  const base = "https://data.cityofnewyork.us/resource/nc67-uf89.json";
  const encoded = encodeURIComponent(clean);
  const likelyFields = ["summons_number", "summonsnumber", "notice_number", "notice_number_text"];

  try {
    const where = buildFallbackFieldQuery(likelyFields, clean);
    const urls = [
      `${base}?$limit=1&$where=${encodeURIComponent(where)}`,
      `${base}?$limit=5&$q=${encoded}`
    ];

    for (const url of urls) {
      const rows = await fetchJson(url);
      if (!rows.length) {
        continue;
      }

      const row = rows[0];
      const result: LookupResult = { found: true, data: row };
      summonsCache.set(clean, result);
      return result;
    }

    const miss = { found: false };
    summonsCache.set(clean, miss);
    return miss;
  } catch (error) {
    const failure = {
      found: false,
      error: error instanceof Error ? error.message : "Lookup failed"
    };
    summonsCache.set(clean, failure);
    return failure;
  }
}

function summarizeLookup(data?: Record<string, unknown>): string {
  if (!data) {
    return "";
  }
  const entries = Object.entries(data).slice(0, 6);
  return entries.map(([k, v]) => `${k}: ${String(v)}`).join(" • ");
}

function analyzeTicket(input: TicketInput, nycData: Analysis["nyc"]): Analysis {
  const issues: Issue[] = [];
  const guidance: string[] = [];

  const combinedText = [input.rawText, input.notes].join(" ").toLowerCase();

  const requiredFields = [
    ["plate", input.plate],
    ["date", input.date],
    ["location", input.location],
    ["violation code", input.violationCode],
    ["amount", input.amount]
  ];

  requiredFields.forEach(([name, value]) => {
    if (!sanitizeValue(value)) {
      issues.push({
        severity: "high",
        category: "Missing required fields",
        message: `Missing ${name}.`
      });
    }
  });

  const normalizedPlate = input.plate.replace(/[^a-z0-9]/gi, "");
  if (normalizedPlate && !/^[a-z0-9]{2,8}$/i.test(normalizedPlate)) {
    issues.push({
      severity: "med",
      category: "Formatting issues",
      message: "Plate should be 2–8 alphanumeric characters after removing spaces/dashes."
    });
  }

  let stateValue = sanitizeValue(input.state).toUpperCase();
  if (!stateValue && input.jurisdiction === "NYC") {
    stateValue = "NY";
    issues.push({
      severity: "low",
      category: "Formatting issues",
      message: "State was blank; defaulted to NY for NYC ticket review."
    });
  } else if (stateValue && !/^[A-Z]{2}$/.test(stateValue)) {
    issues.push({
      severity: "med",
      category: "Formatting issues",
      message: "State should be a two-letter US-style code."
    });
  }

  if (input.date) {
    const dateObj = new Date(`${input.date}T00:00:00`);
    if (Number.isNaN(dateObj.getTime())) {
      issues.push({
        severity: "high",
        category: "Formatting issues",
        message: "Date is invalid; use YYYY-MM-DD."
      });
    } else {
      const maxFuture = new Date();
      maxFuture.setFullYear(maxFuture.getFullYear() + 1);
      if (dateObj > maxFuture) {
        issues.push({
          severity: "med",
          category: "Contradictions / suspicious combos",
          message: "Date is more than one year in the future."
        });
      }
    }
  }

  if (input.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) {
    issues.push({
      severity: "high",
      category: "Formatting issues",
      message: "Time is invalid; use HH:MM (24-hour)."
    });
  }

  if (!input.time && input.date) {
    issues.push({
      severity: "med",
      category: "Contradictions / suspicious combos",
      message: "Date exists but time is missing."
    });
  }

  const amount = Number(input.amount);
  if (sanitizeValue(input.amount) && (!Number.isFinite(amount) || amount <= 0)) {
    issues.push({
      severity: "high",
      category: "Formatting issues",
      message: "Amount must be numeric and greater than 0."
    });
  }

  const summonsDetected = input.isCourtSummons || SUMMONS_KEYWORDS.some((k) => combinedText.includes(k));
  if (summonsDetected) {
    issues.push({
      severity: "high",
      category: "Court / summons guidance",
      message: "Summons language detected. Missing deadlines can cause serious penalties."
    });
    guidance.push("Respond to summons ASAP. Check date/location and court instructions immediately.");
  }

  if (combinedText.includes("meter") && !/(meter|space|zone)/i.test(input.location)) {
    issues.push({
      severity: "med",
      category: "Contradictions / suspicious combos",
      message: "Meter-related note without meter/space/zone location details."
    });
  }

  if (!input.violationCode && /(\bcode\b|\bp\d{2,4}\b)/i.test(combinedText)) {
    issues.push({
      severity: "med",
      category: "Contradictions / suspicious combos",
      message: "Ticket text suggests a violation code, but no code field was provided."
    });
  }

  if (input.violationCode) {
    if (nycData.codeLookup?.error) {
      issues.push({
        severity: "low",
        category: "NYC Open Data checks",
        message: "NYC Open Data unavailable—using offline checks only."
      });
    } else if (!nycData.codeLookup?.found) {
      issues.push({
        severity: "med",
        category: "NYC Open Data checks",
        message: "Violation code not found in DOF code list (possible typo)."
      });
    } else {
      issues.push({
        severity: "low",
        category: "NYC Open Data checks",
        message: "Code found in DOF list."
      });
    }
  }

  if (input.summonsNumber) {
    if (nycData.summonsLookup?.error) {
      issues.push({
        severity: "low",
        category: "NYC Open Data checks",
        message: "NYC Open Data unavailable—using offline checks only."
      });
    } else if (nycData.summonsLookup?.found) {
      issues.push({
        severity: "low",
        category: "NYC Open Data checks",
        message: "Public record found for summons/notice number."
      });
    } else {
      issues.push({
        severity: "low",
        category: "NYC Open Data checks",
        message: "No public record found (may be delayed / not posted)."
      });
    }
  }

  let payScore = 60;
  let fightScore = 40;

  issues.forEach((issue) => {
    if (issue.severity === "high") {
      payScore -= 10;
      fightScore += 10;
    } else if (issue.severity === "med") {
      payScore -= 5;
      fightScore += 5;
    } else {
      payScore -= 2;
      fightScore += 2;
    }
  });

  if (summonsDetected) {
    payScore = 30;
    fightScore = 70;
  }

  payScore = Math.max(0, Math.min(100, payScore));
  fightScore = Math.max(0, Math.min(100, fightScore));

  const highCount = issues.filter((i) => i.severity === "high").length;
  let validity: Validity = "Possibly Invalid";
  if (issues.length <= 1 && highCount === 0) {
    validity = "Likely Valid";
  } else if (highCount >= 1 || issues.length >= 4) {
    validity = "Likely Invalid";
  }

  let recommendedAction: Action = "Request hearing";
  if (summonsDetected) {
    recommendedAction = "Respond to summons ASAP";
  } else if (fightScore >= 70) {
    recommendedAction = "Fight it";
  } else if (payScore >= 70) {
    recommendedAction = "Pay now";
  } else if (fightScore >= 55) {
    recommendedAction = "Request hearing";
  } else {
    recommendedAction = "Request reduction";
  }

  if (!guidance.length) {
    guidance.push("Double-check all ticket fields before paying or contesting.");
    if (recommendedAction === "Fight it") {
      guidance.push("Gather photos, meter receipts, and any witness notes before filing dispute.");
    }
    if (recommendedAction === "Pay now") {
      guidance.push("Pay promptly to avoid late penalties.");
    }
  }

  const explanation =
    `We found ${issues.length} issue(s): ${highCount} high severity. ` +
    `Scores are weighted toward fighting when severe/contradictory details are present.`;

  return {
    issues,
    validity,
    payScore,
    fightScore,
    recommendedAction,
    guidance,
    nyc: nycData,
    explanation
  };
}

function parseTextToFields(rawText: string): Partial<TicketInput> {
  const text = rawText;
  const getMatch = (pattern: RegExp): string => text.match(pattern)?.[1]?.trim() ?? "";

  return {
    summonsNumber: getMatch(/(?:summons|notice)\s*(?:number|#)?\s*[:#]?\s*([a-z0-9-]{6,})/i),
    plate: getMatch(/(?:plate|license)\s*[:#]?\s*([a-z0-9 -]{2,10})/i),
    state: getMatch(/\bstate\s*[:#]?\s*([a-z]{2})\b/i).toUpperCase(),
    date: getMatch(/\b(20\d{2}-\d{2}-\d{2})\b/i),
    time: getMatch(/\b([0-2]\d:[0-5]\d)\b/i),
    violationCode: getMatch(/(?:violation\s*code|code)\s*[:#]?\s*([a-z0-9]{1,6})/i),
    amount: getMatch(/\$\s*(\d+(?:\.\d{1,2})?)/i),
    location: getMatch(/(?:location|street)\s*[:#]?\s*([^\n,]{4,80})/i),
    notes: text
  };
}

const initialFields: Omit<TicketInput, "rawText"> = {
  jurisdiction: "NYC",
  summonsNumber: "",
  plate: "",
  state: "",
  date: "",
  time: "",
  location: "",
  violationCode: "",
  issuer: "",
  amount: "",
  isCourtSummons: false,
  notes: ""
};

export default function Page() {
  const [mode, setMode] = useState<Mode>("text");
  const [rawText, setRawText] = useState("");
  const [fields, setFields] = useState(initialFields);
  const [result, setResult] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [friendlyError, setFriendlyError] = useState("");

  const groupedIssues = useMemo(() => {
    if (!result) return [] as [string, Issue[]][];
    const map = new Map<string, Issue[]>();
    result.issues.forEach((issue) => {
      const list = map.get(issue.category) ?? [];
      list.push(issue);
      map.set(issue.category, list);
    });
    return [...map.entries()];
  }, [result]);

  async function runCheck() {
    setFriendlyError("");
    setLoading(true);

    try {
      const parsed = mode === "text" ? parseTextToFields(rawText) : {};
      const assembled: TicketInput = {
        ...fields,
        ...parsed,
        state: mode === "text" ? parsed.state || fields.state : fields.state,
        rawText: mode === "text" ? rawText : ""
      };

      if (!assembled.plate && !assembled.summonsNumber && !assembled.violationCode && !assembled.rawText) {
        setFriendlyError("Please enter ticket text or at least one key field before running the check.");
      }

      const [codeLookup, summonsLookup] = await Promise.all([
        assembled.violationCode ? fetchViolationCodeInfo(assembled.violationCode) : Promise.resolve({ found: false }),
        assembled.summonsNumber ? fetchSummonsInfo(assembled.summonsNumber) : Promise.resolve({ found: false })
      ]);

      const openDataStatus = codeLookup.error || summonsLookup.error ? "degraded" : "ok";

      const analysis = analyzeTicket(assembled, {
        codeLookup,
        summonsLookup,
        openDataStatus
      });

      setResult(analysis);

      if (openDataStatus === "degraded") {
        setFriendlyError("NYC Open Data unavailable—using offline checks only.");
      }
    } catch (_err) {
      setFriendlyError("Something went wrong, but your ticket was still reviewed with offline checks.");
      const analysis = analyzeTicket(
        {
          ...fields,
          ...(mode === "text" ? parseTextToFields(rawText) : {}),
          rawText: mode === "text" ? rawText : ""
        },
        { openDataStatus: "degraded" }
      );
      setResult(analysis);
    } finally {
      setLoading(false);
    }
  }

  async function copyResults() {
    if (!result) return;
    const content = [
      `Validity: ${result.validity}`,
      `Pay likelihood: ${result.payScore}`,
      `Fight likelihood: ${result.fightScore}`,
      `Recommended action: ${result.recommendedAction}`,
      `Issues:\n${result.issues.map((i) => `- [${i.severity}] ${i.category}: ${i.message}`).join("\n")}`
    ].join("\n");

    try {
      await navigator.clipboard.writeText(content);
      setFriendlyError("Results copied to clipboard.");
    } catch {
      setFriendlyError("Could not copy automatically. You can still copy manually.");
    }
  }

  function loadExample(kind: "valid" | "issues") {
    if (kind === "valid") {
      setMode("fields");
      setFields(FIELD_EXAMPLE_VALID);
      setRawText("");
    } else {
      setMode("text");
      setFields(FIELD_EXAMPLE_ISSUES);
      setRawText(
        "NYC Parking Summons Number: 1234567890\nPlate: A-\nLocation: Unknown\nAppearance required in criminal court. Hearing date listed. Meter problem. Code P999"
      );
    }
    setResult(null);
    setFriendlyError("");
  }

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: 20 }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 36 }}>Tix</h1>
        <p style={{ marginTop: 6, color: "#4b5563" }}>Understand your NYC ticket in minutes</p>
      </header>

      <section style={{ background: "white", borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button onClick={() => setMode("text")} style={{ padding: "8px 12px", fontWeight: mode === "text" ? 700 : 500 }}>
            Paste Ticket Text
          </button>
          <button onClick={() => setMode("fields")} style={{ padding: "8px 12px", fontWeight: mode === "fields" ? 700 : 500 }}>
            Enter Fields
          </button>
        </div>

        {mode === "text" ? (
          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={10}
            placeholder="Paste your ticket text here..."
            style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #cbd5e1" }}
          />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
            <label>
              Jurisdiction
              <select value={fields.jurisdiction} onChange={(e) => setFields((f) => ({ ...f, jurisdiction: e.target.value as "NYC" | "Other" }))}>
                <option value="NYC">NYC</option>
                <option value="Other">Other</option>
              </select>
            </label>
            <label>Summons/Notice number<input value={fields.summonsNumber} onChange={(e) => setFields((f) => ({ ...f, summonsNumber: e.target.value }))} /></label>
            <label>Plate<input value={fields.plate} onChange={(e) => setFields((f) => ({ ...f, plate: e.target.value }))} /></label>
            <label>State<input value={fields.state} onChange={(e) => setFields((f) => ({ ...f, state: e.target.value.toUpperCase() }))} /></label>
            <label>Date (YYYY-MM-DD)<input value={fields.date} onChange={(e) => setFields((f) => ({ ...f, date: e.target.value }))} /></label>
            <label>Time (HH:MM)<input value={fields.time} onChange={(e) => setFields((f) => ({ ...f, time: e.target.value }))} /></label>
            <label>Location / Street<input value={fields.location} onChange={(e) => setFields((f) => ({ ...f, location: e.target.value }))} /></label>
            <label>Violation code<input value={fields.violationCode} onChange={(e) => setFields((f) => ({ ...f, violationCode: e.target.value }))} /></label>
            <label>Issuer/Officer/Precinct<input value={fields.issuer} onChange={(e) => setFields((f) => ({ ...f, issuer: e.target.value }))} /></label>
            <label>Amount<input value={fields.amount} onChange={(e) => setFields((f) => ({ ...f, amount: e.target.value }))} /></label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={fields.isCourtSummons} onChange={(e) => setFields((f) => ({ ...f, isCourtSummons: e.target.checked }))} />
              Was it a court summons?
            </label>
            <label style={{ gridColumn: "1 / -1" }}>Notes (optional)<textarea value={fields.notes} onChange={(e) => setFields((f) => ({ ...f, notes: e.target.value }))} rows={4} /></label>
          </div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          <button onClick={runCheck} disabled={loading} style={{ padding: "10px 14px", fontWeight: 700 }}>
            {loading ? "Checking..." : "Run Check"}
          </button>
          <button onClick={() => loadExample("valid")}>Load Example (Valid)</button>
          <button onClick={() => loadExample("issues")}>Load Example (Issues + Summons)</button>
          <button onClick={copyResults} disabled={!result}>Copy Results</button>
        </div>

        {friendlyError ? <p style={{ marginTop: 10, color: "#9a3412" }}>{friendlyError}</p> : null}
      </section>

      <section style={{ background: "white", borderRadius: 12, padding: 16 }}>
        <h2 style={{ marginTop: 0 }}>Results</h2>
        {!result ? (
          <p>Run a check to see ticket validity, scores, and NYC Open Data lookup results.</p>
        ) : (
          <>
            <p><strong>Validity status:</strong> {result.validity}</p>
            <p><strong>Pay likelihood:</strong> {result.payScore}/100 &nbsp; <strong>Fight likelihood:</strong> {result.fightScore}/100</p>
            <p><strong>Recommended next action:</strong> {result.recommendedAction}</p>
            <p><strong>Why we think this:</strong> {result.explanation}</p>

            {groupedIssues.map(([category, issues]) => (
              <div key={category} style={{ marginBottom: 10 }}>
                <h3 style={{ marginBottom: 4 }}>{category}</h3>
                <ul>
                  {issues.map((issue, idx) => (
                    <li key={`${category}-${idx}`}>
                      [{issue.severity}] {issue.message}
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            <h3>Guidance</h3>
            <ul>
              {result.guidance.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>

            <h3>NYC Open Data Lookup</h3>
            <p>
              <strong>Status:</strong>{" "}
              {result.nyc.openDataStatus === "ok"
                ? "Connected"
                : "NYC Open Data unavailable—using offline checks only"}
            </p>
            <div style={{ marginBottom: 8 }}>
              <strong>Violation code description:</strong>{" "}
              {result.nyc.codeLookup?.found
                ? summarizeLookup(result.nyc.codeLookup.data)
                : "No matching public record found (may be missing or not yet posted)."}
            </div>
            <div>
              <strong>Summons lookup result summary:</strong>{" "}
              {result.nyc.summonsLookup?.found
                ? summarizeLookup(result.nyc.summonsLookup.data)
                : "No matching public record found (may be missing or not yet posted)."}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
