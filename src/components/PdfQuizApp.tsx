"use client";

import React, { useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import type { QuizPayload, QuizQuestion } from "@/lib/quiz/types";

type UploadPhase = "idle" | "uploading" | "processing" | "ready" | "finished" | "error";

function classNames(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(" ");
}

export default function PdfQuizApp() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const MAX_FORMDATA_UPLOAD_BYTES = 4 * 1024 * 1024; // 4MB (când folosim multipart/form-data)

  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [showRequirementsEditor, setShowRequirementsEditor] = useState(false);
  const [requirementsText, setRequirementsText] = useState("");

  const [quiz, setQuiz] = useState<QuizQuestion[] | null>(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<"corect" | "gresit" | null>(null);
  const [showCorrect, setShowCorrect] = useState(false);
  const [score, setScore] = useState(0);
  const [busy, setBusy] = useState(false);

  const fileRef = useRef<File | null>(null);

  const totalQuestions = quiz?.length ?? 0;
  const currentQuestion = quiz?.[questionIndex] ?? null;

  // Nu folosim useMemo aici: `fileRef.current` nu declanșează rerender,
  // dar componentele se rerandează când se schimbă `fileName` / `phase`,
  // iar valoarea va fi citită corect din ref în timpul renderului.
  const canGenerate =
    Boolean(fileRef.current) &&
    !busy &&
    phase !== "uploading" &&
    phase !== "processing";

  async function uploadPdfAndGenerateQuiz(regenerate = false) {
    const file = fileRef.current;
    if (!file) {
      setError("Selectează mai întâi un fișier PDF.");
      setPhase("error");
      return;
    }

    setError(null);
    setPhase("uploading");
    setBusy(true);
    setQuiz(null);
    setQuestionIndex(0);
    setSelectedOption(null);
    setFeedback(null);
    setShowCorrect(false);
    setScore(0);

    try {
      const questionCount = 5;
      const instructionsTrimmed = requirementsText.trim();

      // Pentru fișiere mai mari, folosim Vercel Blob (evită limitele de multipart/form-data).
      if (file.size > MAX_FORMDATA_UPLOAD_BYTES) {
        setUploadProgress(15);
        const blob = await upload(file.name, file, {
          access: "private",
          handleUploadUrl: "/api/pdf-upload",
        });

        setUploadProgress(80);

        const res = await fetch("/api/quiz", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: blob.url,
            fileName: file.name,
            regenerate,
            questionCount,
            instructions: instructionsTrimmed.length > 0 ? instructionsTrimmed : undefined,
          }),
        });

        const rawText = await res.text();
        let parsed: Record<string, unknown> = {};
        if (rawText.trim().length > 0) {
          try {
            parsed = JSON.parse(rawText) as Record<string, unknown>;
          } catch {
            parsed = { error: rawText.slice(0, 500) };
          }
        }

        if (!res.ok) {
          const errMsg =
            typeof parsed.error === "string"
              ? parsed.error
              : "Eroare la generare quiz.";
          throw new Error(errMsg);
        }

        const maybeQuiz = parsed["quiz"];
        if (!Array.isArray(maybeQuiz)) {
          throw new Error("Răspuns invalid de la server.");
        }

        setPhase("processing");
        setUploadProgress(100);
        await new Promise((r) => setTimeout(r, 250));

        const result = parsed as QuizPayload;
        setQuiz(result.quiz);
        setQuestionIndex(0);
        setSelectedOption(null);
        setFeedback(null);
        setShowCorrect(false);
        setScore(0);
        setPhase("ready");
        return;
      }

      // Fallback: multipart/form-data cu progress (pentru fișiere mici).
      setUploadProgress(0);
      const formData = new FormData();
      formData.append("file", file);
      formData.append("regenerate", regenerate ? "1" : "0");
      formData.append("questionCount", String(questionCount));
      if (instructionsTrimmed.length > 0) {
        formData.append("instructions", instructionsTrimmed);
      }

      const result = await new Promise<QuizPayload & { cached?: boolean }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/quiz", true);

        xhr.upload.onprogress = (ev) => {
          if (!ev.lengthComputable) return;
          const percent = Math.round((ev.loaded / ev.total) * 100);
          setUploadProgress(Math.max(0, Math.min(100, percent)));
        };

        xhr.onload = () => {
          try {
            const statusOk = xhr.status >= 200 && xhr.status < 300;
            const rawText = xhr.responseText ?? "";
            let parsed: Record<string, unknown> = {};

            if (rawText.trim().length > 0) {
              try {
                parsed = JSON.parse(rawText) as Record<string, unknown>;
              } catch {
                parsed = { error: rawText.slice(0, 500) };
              }
            }

            if (!statusOk) {
              const errMsg =
                typeof parsed.error === "string"
                  ? parsed.error
                  : "Eroare la generare quiz.";
              reject(new Error(errMsg));
              return;
            }

            const maybeQuiz = parsed["quiz"];
            if (!Array.isArray(maybeQuiz)) {
              reject(new Error("Răspuns invalid de la server."));
              return;
            }

            resolve(parsed as QuizPayload & { cached?: boolean });
          } catch {
            reject(new Error("Răspuns invalid de la server.")); // should be rare
          }
        };

        xhr.onerror = () => reject(new Error("Conexiune eșuată la upload.")); // should be rare

        xhr.send(formData);
      });

      setPhase("processing");
      setUploadProgress(100);
      await new Promise((r) => setTimeout(r, 250));

      if (!Array.isArray(result.quiz) || result.quiz.length < 1) {
        throw new Error("Răspunsul serverului este gol. Reîncearcă.");
      }

      setQuiz(result.quiz);
      setQuestionIndex(0);
      setSelectedOption(null);
      setFeedback(null);
      setShowCorrect(false);
      setScore(0);
      setPhase("ready");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Eroare necunoscută.";
      setError(message);
      setPhase("error");
    } finally {
      setBusy(false);
    }
  }

  function handleFileSelected(file: File | null) {
    setError(null);
    if (!file) return;
    fileRef.current = file;
    setFileName(file.name);

    setPhase("idle");

    // Reset state when user picks a new file.
    setQuiz(null);
    // setPhase("idle") de mai sus (în funcție de validare)
    setUploadProgress(0);
    setQuestionIndex(0);
    setSelectedOption(null);
    setFeedback(null);
    setShowCorrect(false);
    setScore(0);
  }

  function handleSelectOption(option: string) {
    if (!currentQuestion) return;
    if (busy) return;
    if (selectedOption) return; // only one selection per question attempt

    const isCorrect = option === currentQuestion.correctAnswer;
    setSelectedOption(option);
    setFeedback(isCorrect ? "corect" : "gresit");
    setShowCorrect(false);
  }

  function handleTryAgain() {
    setSelectedOption(null);
    setFeedback(null);
    setShowCorrect(false);
  }

  function nextStep() {
    if (!quiz) return;
    const nextIndex = questionIndex + 1;
    setSelectedOption(null);
    setFeedback(null);
    setShowCorrect(false);
    setQuestionIndex(nextIndex);
    if (nextIndex >= quiz.length) {
      setPhase("finished");
    }
  }

  function handleRevealCorrect() {
    if (!currentQuestion) return;
    if (!selectedOption) return;
    if (busy) return;

    setShowCorrect(true);
    setBusy(true);

    const isCorrect = selectedOption === currentQuestion.correctAnswer;
    if (isCorrect) setScore((s) => s + 1);

    // Brief pause so user sees green highlight.
    window.setTimeout(() => {
      setBusy(false);
      nextStep();
    }, 650);
  }

  function downloadQuizJson() {
    if (!quiz) return;
    const payload: QuizPayload = { quiz };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "quiz.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function optionColor(option: string) {
    if (!currentQuestion) return "";
    const isSelected = selectedOption === option;
    const isCorrectOption = currentQuestion.correctAnswer === option;
    if (!selectedOption) return "";

    // Before "Vezi răspunsul corect": color only the selected answer.
    if (!showCorrect) {
      if (isSelected && feedback === "corect") return "bg-emerald-600 text-white border-emerald-700";
      if (isSelected && feedback === "gresit") return "bg-rose-600 text-white border-rose-700";
      return "bg-white/5 text-white/90 border-white/10 hover:bg-white/10";
    }

    // After reveal: green correct; red selected if wrong.
    if (isCorrectOption) return "bg-emerald-600 text-white border-emerald-700";
    if (isSelected && feedback === "gresit") return "bg-rose-600 text-white border-rose-700";
    return "bg-white/5 text-white/90 border-white/10";
  }

  const headerSubtitle =
    phase === "uploading"
      ? "Încarc PDF-ul..."
      : phase === "processing"
        ? "Generez quiz-ul..."
        : "Transformă un PDF în întrebări grilă.";

  const canInteract = phase === "ready" && quiz && currentQuestion && !busy;

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-950 via-zinc-950 to-zinc-900 text-zinc-50">
      <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:py-14">
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-zinc-200">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Quiz din PDF (Română)
          </div>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
            PDF -&gt; Quiz grilă
          </h1>
          <p className="mt-2 text-zinc-300">{headerSubtitle}</p>
        </div>

        <div className="grid gap-5 lg:grid-cols-5">
          <section className="lg:col-span-2">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-[0_20px_80px_-40px_rgba(0,0,0,0.6)]">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-zinc-200">1) Încarcă un PDF</p>
                  <p className="mt-1 text-xs text-zinc-400">
                    Suport: până la 10MB (fișiere mari: Blob)
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={phase === "uploading" || phase === "processing" || busy}
                  className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/10 disabled:opacity-50"
                >
                  Alege fișier
                </button>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={(e) => handleFileSelected(e.target.files?.[0] ?? null)}
              />

              <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4">
                {fileName ? (
                  <div className="flex flex-col gap-2">
                    <div className="text-sm font-medium text-zinc-100">{fileName}</div>
                    <div className="text-xs text-zinc-400">Grad încărcare: {uploadProgress}%</div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-zinc-400">Nu ai selectat încă un fișier.</p>
                )}
              </div>

              <div className="mt-4 flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => uploadPdfAndGenerateQuiz(false)}
                  disabled={!canGenerate || !fileName}
                  className="rounded-xl bg-emerald-600 px-4 py-3 text-center text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                >
                  Generează quiz
                </button>

                <button
                  type="button"
                  onClick={() => uploadPdfAndGenerateQuiz(true)}
                  disabled={!canGenerate}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center text-sm font-semibold text-zinc-100 transition hover:bg-white/10 disabled:opacity-50"
                >
                  Generează din nou (bonus)
                </button>

                <button
                  type="button"
                  onClick={downloadQuizJson}
                  disabled={!quiz}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center text-sm font-semibold text-zinc-100 transition hover:bg-white/10 disabled:opacity-50"
                >
                  Descarcă quizul (JSON)
                </button>
              </div>

              {error ? (
                <div className="mt-4 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-100">
                  {error}
                </div>
              ) : null}
            </div>
          </section>

          <section className="lg:col-span-3">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              {phase === "idle" ? (
                <div className="space-y-3">
                  <div className="text-sm font-medium text-zinc-200">Pregătit pentru quiz</div>
                  <p className="text-sm text-zinc-300">
                    Încarcă un PDF, apoi apasă pe <span className="font-semibold">Generează quiz</span>.
                  </p>
                  <div className="grid grid-cols-2 gap-3 pt-3">
                    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                      <button
                        type="button"
                        onClick={() => setShowRequirementsEditor((v) => !v)}
                        className="w-full text-left"
                      >
                        <div className="text-xs text-zinc-400">Cerințe</div>
                        <div className="mt-1 text-sm font-semibold">
                          minim 5 întrebări
                          <span className="ml-1 text-xs font-medium text-zinc-400">
                            {showRequirementsEditor ? "— ascunde" : "— editează"}
                          </span>
                        </div>
                      </button>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                      <div className="text-xs text-zinc-400">Limbă</div>
                      <div className="mt-1 text-sm font-semibold">română (UI + quiz)</div>
                    </div>
                  </div>

                  {showRequirementsEditor ? (
                    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                      <div className="text-xs text-zinc-400">Instrucțiuni suplimentare (opțional)</div>
                      <textarea
                        value={requirementsText}
                        onChange={(e) => setRequirementsText(e.target.value)}
                        rows={4}
                        placeholder="Ex: Creează întrebări de nivel mediu. Fă 2 întrebări despre definții și 3 despre aplicații. Evită întrebări foarte lungi."
                        className="mt-2 w-full resize-none rounded-lg border border-white/10 bg-black/40 p-3 text-sm text-zinc-100 outline-none focus:border-emerald-400"
                      />
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <p className="text-xs text-zinc-400">
                          Aceste instrucțiuni vor fi trimise la AI.
                        </p>
                        <button
                          type="button"
                          onClick={() => setRequirementsText("")}
                          disabled={requirementsText.trim().length === 0}
                          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-zinc-100 transition hover:bg-white/10 disabled:opacity-50"
                        >
                          Curăță
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {phase === "uploading" || phase === "processing" ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 animate-spin rounded-full border-2 border-white/15 border-t-emerald-400" />
                    <div>
                      <div className="text-sm font-medium text-zinc-200">
                        {phase === "uploading" ? "Încărcare PDF..." : "Procesare PDF & AI..."}
                      </div>
                      <div className="mt-1 text-xs text-zinc-400">
                        Poate dura câteva secunde, în funcție de dimensiunea PDF-ului.
                      </div>
                    </div>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                </div>
              ) : null}

              {phase === "ready" && quiz && currentQuestion ? (
                <div className="animate-reveal">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-zinc-200">
                      Întrebarea {questionIndex + 1} / {totalQuestions}
                    </div>
                    <div className="text-xs text-zinc-400">Scor provizoriu: {score}</div>
                  </div>

                  <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-5">
                    <div className="text-base font-semibold leading-snug text-white">
                      {currentQuestion.question}
                    </div>
                    <div className="mt-4 grid gap-3">
                      {currentQuestion.options.map((opt, idx) => {
                        const label = String.fromCharCode("A".charCodeAt(0) + idx);
                        const selected = selectedOption === opt;
                        const colorClass = optionColor(opt);
                        return (
                          <button
                            key={opt}
                            type="button"
                            disabled={!canInteract && !selected}
                            onClick={() => handleSelectOption(opt)}
                            className={classNames(
                              "group rounded-xl border px-4 py-3 text-left transition",
                              selected && !showCorrect ? "ring-2 ring-white/20" : "",
                              "bg-white/5 hover:bg-white/10 border-white/10 text-zinc-100",
                              colorClass,
                            )}
                          >
                            <span className="mr-2 font-semibold text-emerald-200/90">
                              {label}.
                            </span>
                            <span className="leading-tight">{opt}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {selectedOption && feedback ? (
                    <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center">
                      <div className="text-sm text-zinc-300">
                        {feedback === "corect" ? (
                          <span className="font-semibold text-emerald-200">Răspuns corect.</span>
                        ) : (
                          <span className="font-semibold text-rose-200">Răspuns greșit.</span>
                        )}
                      </div>
                      <div className="flex flex-col gap-3 sm:flex-row">
                        <button
                          type="button"
                          onClick={handleRevealCorrect}
                          disabled={busy}
                          className="rounded-xl bg-emerald-600 px-4 py-3 text-center text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                        >
                          Vezi răspunsul corect
                        </button>
                        <button
                          type="button"
                          onClick={handleTryAgain}
                          disabled={busy}
                          className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center text-sm font-semibold text-zinc-100 transition hover:bg-white/10 disabled:opacity-50"
                        >
                          Mai încearcă o dată
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {phase === "finished" && quiz ? (
                <div className="animate-reveal">
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-6">
                    <div className="text-sm font-medium text-zinc-200">Quiz complet</div>
                    <div className="mt-3 text-4xl font-semibold tracking-tight">
                      Scor final: <span className="text-emerald-200">{score}</span> /{" "}
                      <span className="text-zinc-100">{totalQuestions}</span>
                    </div>
                    <p className="mt-2 text-sm text-zinc-300">
                      Poți încărca alt PDF sau poți genera din nou (bonus).
                    </p>
                    <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                      <button
                        type="button"
                        onClick={() => {
                          setQuiz(null);
                          setPhase("idle");
                          setSelectedOption(null);
                          setFeedback(null);
                          setShowCorrect(false);
                          setQuestionIndex(0);
                          setScore(0);
                          setUploadProgress(0);
                        }}
                        className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center text-sm font-semibold text-zinc-100 transition hover:bg-white/10"
                      >
                        Începe din nou
                      </button>
                      <button
                        type="button"
                        onClick={() => uploadPdfAndGenerateQuiz(true)}
                        disabled={!canGenerate}
                        className="rounded-xl bg-emerald-600 px-4 py-3 text-center text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                      >
                        Generează din nou (bonus)
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {phase === "error" && !quiz ? (
                <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 p-6">
                  <div className="text-sm font-semibold text-rose-100">A apărut o eroare</div>
                  <p className="mt-2 text-sm text-rose-100/90">
                    Verifică fișierul PDF și reîncearcă.
                  </p>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

