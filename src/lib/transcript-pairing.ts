export type PTranscriptTurn = { speaker?: string; text?: string };

export type TranscriptPair = {
  question: PTranscriptTurn;
  answer: PTranscriptTurn | null;
};

// Normalize Arabic for fuzzy matching: drop diacritics/tatweel and punctuation.
function normText(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0640]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, " ");
}
// Word-overlap similarity (0..1). STT garbles the transcript, so we match on
// shared words rather than exact equality.
function textSim(a: string, b: string): number {
  const wa = new Set(normText(a).split(/\s+/).filter(Boolean));
  const wb = new Set(normText(b).split(/\s+/).filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  let hit = 0;
  for (const w of wa) if (wb.has(w)) hit++;
  return hit / Math.min(wa.size, wb.size);
}

// When both the current and the next clip's similarity are below this floor the
// utterance is noise; only short noise (e.g. a stray "طيب") is absorbed as a
// fragment — anything longer is treated as a new question so per-question counts
// stay aligned.
const FRAG_FLOOR = 0.1;

export type ClipMeta = { question?: string; expected_answer?: string };

export type AlignedAnswer = { qid: string; question: string; answer: string | null };

// Align the transcript's answers to the questions that were ACTUALLY played,
// decided by CONTENT rather than position.
//
// STT splits one spoken question into several consecutive customer utterances
// (e.g. "حصولي على قرض شخصي" then "كيف يتم قيد مبلغ القرض الفوري" — the same
// clip), and Ziila can even answer the fragments twice ("…مبلغ القرض الشخصي…"
// then "…الحد الأقصى لمبلغ القرض الشخصي…"). Blind positional pairing shifts
// every following answer by one slot — the swap the judge saw in the last few
// questions.
//
// Each customer utterance is matched, by word overlap, against BOTH the clip we
// are currently in and the clip that comes next (question text + expected
// answer). A customer utterance overwhelmingly matches its OWN clip's question
// text — even when STT garbles it — so:
//   - it matches the NEXT clip clearly  → it starts that clip (advance);
//   - it matches the CURRENT clip       → it's a continuation fragment, absorb
//     it without advancing (its stray double-answer is left unattached);
//   - it matches neither and is long    → advance anyway (keep counts aligned);
//   - it matches neither and is SHORT   → absorb as filler noise.
// A genuinely unanswered question stays null — the next question moves on
// instead of stealing its reply.
export function alignAnswersToQuestions(
  tr: PTranscriptTurn[],
  order: string[],
  meta: (qid: string) => ClipMeta,
): AlignedAnswer[] {
  const turns = (tr || [])
    .map((x) => ({ speaker: String(x?.speaker || "").toLowerCase(), text: String(x?.text || "").trim() }))
    .filter((x) => x.text);
  const n = order.length;
  const groups = order.map((qid) => ({
    qid,
    opened: false,
    text: "",
    answer: null as string | null,
  }));
  let idx = 0;

  const score = (text: string, qid: string): number => {
    const m = meta(qid) || {};
    let best = 0;
    if (m.question) best = Math.max(best, textSim(text, m.question));
    if (m.expected_answer) best = Math.max(best, textSim(text, m.expected_answer));
    return best;
  };

  for (const t of turns) {
    if (t.speaker !== "customer") {
      const g = groups[idx];
      if (g?.opened && g.answer === null) g.answer = t.text;
      continue;
    }
    if (idx >= n) continue; // stray utterance past the last question — drop

    const g = groups[idx];
    if (!g.opened) {
      g.opened = true;
      g.text = t.text;
      continue;
    }

    const sCur = score(t.text, g.qid);
    const sNext = idx + 1 < n ? score(t.text, order[idx + 1]) : -1;
    const noiseLen = normText(t.text).length;
    const bothLow = sCur < FRAG_FLOOR && sNext < FRAG_FLOOR;
    const canAdvance = idx + 1 < n;

    // After a clip's answer already arrived, the next customer almost always
    // starts a new question — absorb only SHORT leftover fragments (the STT
    // tail of the just-finished clip, which can even get its own stray reply),
    // or short filler noise. A full-length utterance is a new question.
    let fragment: boolean;
    if (!canAdvance) {
      fragment = true;
    } else if (g.answer !== null) {
      fragment = noiseLen <= 12 && sCur >= sNext - 0.15;
    } else {
      fragment = bothLow ? noiseLen <= 8 : sNext <= sCur;
    }

    if (fragment) {
      // continuation filler / split fragment of the current clip.
      g.text = t.text.length > g.text.length ? t.text : g.text;
    } else {
      idx++;
      const ng = groups[idx];
      if (!ng.opened) {
        ng.opened = true;
        ng.text = t.text;
      } else {
        ng.text = t.text.length > ng.text.length ? t.text : ng.text;
      }
    }
  }

  return groups.map((_g) => ({ qid: _g.qid, question: _g.text, answer: _g.answer }));
}

// Align the live WS transcript's customer turns with the agent replies that
// followed them. Handles two STT realities that break naive sequential zipping:
//  1. A single spoken question can be split into several utterances (e.g.
//     "متى تتم الموافقة..." then a stray "طيب"), so consecutive customer
//     turns are merged into one question — keeping the longest fragment.
//  2. A reply may not be the *immediately* next entry when a stray customer
//     fragment lands in between; we pair each question with the FIRST later
//     agent message instead.
export function pairTranscript(tr: PTranscriptTurn[]): TranscriptPair[] {
  const t = (tr || [])
    .map((x) => ({
      speaker: String(x?.speaker || "").toLowerCase(),
      text: String(x?.text || "").trim(),
    }))
    // Keep empty AGENT turns: an empty reply marks a question that received no
    // answer (NO REPLY). Dropping it would merge the next customer's question
    // into the current one and shift every later pairing. Only filter out empty
    // CUSTOMER turns (stray/blank noise).
    .filter((x) => x.text || x.speaker === "agent");

  const merged: Array<{ speaker: string; text: string }> = [];
  for (const x of t) {
    const last = merged[merged.length - 1];
    if (x.speaker === "customer" && last?.speaker === "customer") {
      last.text = x.text.length > last.text.length ? x.text : last.text;
    } else {
      merged.push(x);
    }
  }

  const agentIdxs: number[] = [];
  merged.forEach((x, i) => {
    if (x.speaker === "agent") agentIdxs.push(i);
  });

  const pairs: TranscriptPair[] = [];
  let cursor = 0;
  for (let i = 0; i < merged.length; i++) {
    if (merged[i].speaker !== "customer") continue;
    while (cursor < agentIdxs.length && agentIdxs[cursor] < i) cursor++;
    const hasAnswer = cursor < agentIdxs.length;
    // An answer is only a real reply if the agent had non-empty text. An empty
    // agent turn (kept above) means NO REPLY for this question, so treat it as
    // null instead of stealing the next question's real answer.
    const agentText = hasAnswer ? String(merged[agentIdxs[cursor]].text || "").trim() : "";
    const answer = hasAnswer && agentText ? merged[agentIdxs[cursor]] : null;
    pairs.push({
      question: { speaker: "customer", text: merged[i].text },
      answer,
    });
    if (hasAnswer) cursor++;
  }
  return pairs;
}